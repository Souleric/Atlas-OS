const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { saveGroupMessage, getGroupMessagesById } = require('./memory')
const OWNER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10)

let waClient = null
let waReady = false

// Group message store: groupId → { name, messages[] }
// Resets at 5 PM after summary is sent
const groupStore = new Map()

// Groups where Atlas is muted until re-tagged
const mutedGroups = new Set()

const MUTE_PHRASES = ['talk later', 'lets talk later', "let's talk later", 'talk to you later', 'ttyl']

function recordGroupMessage(groupId, groupName, sender, body) {
  if (!groupStore.has(groupId)) {
    groupStore.set(groupId, { name: groupName, messages: [] })
  }
  groupStore.get(groupId).messages.push({
    sender,
    body,
    time: new Date().toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })
  })
  saveGroupMessage({ groupId, groupName, sender, body })
    .catch(err => console.error('[whatsapp] saveGroupMessage failed:', err.message))
}

function getGroupContext(groupId) {
  const group = groupStore.get(groupId)
  if (!group || group.messages.length === 0) return null
  return group.messages.slice(-100).map(m => `[${m.time}] ${m.sender}: ${m.body}`).join('\n')
}

// Full context for @mention replies: pulls from DB (persisted across restarts) then
// appends any in-memory messages newer than the last DB row (in case the current
// message hasn't persisted yet).
async function getFullGroupContext(groupId) {
  try {
    const dbRows = await getGroupMessagesById(groupId, { limit: 300, sinceHours: 30 * 24 })
    const lastDbTime = dbRows.length > 0 ? new Date(dbRows[dbRows.length - 1].receivedAt).getTime() : 0
    const inMem = (groupStore.get(groupId)?.messages || [])
    const formatted = dbRows.map(r => `[${r.time}] ${r.sender}: ${r.body}`)
    // In-memory entries don't have receivedAt; include any whose body isn't already in the DB tail
    const dbBodies = new Set(dbRows.slice(-20).map(r => r.body))
    for (const m of inMem.slice(-20)) {
      if (!dbBodies.has(m.body)) formatted.push(`[${m.time}] ${m.sender}: ${m.body}`)
    }
    return formatted.length > 0 ? formatted.join('\n') : null
  } catch (err) {
    console.error('[whatsapp] getFullGroupContext error:', err.message)
    return getGroupContext(groupId)
  }
}

function getAllGroupSummaryData() {
  const result = []
  for (const [id, data] of groupStore.entries()) {
    if (data.messages.length > 0) {
      result.push({ id, name: data.name, messages: [...data.messages] })
    }
  }
  return result
}

function clearGroupStore() {
  for (const data of groupStore.values()) data.messages = []
}

function createClient(onMessage, sendToOwnerFn) {
  // Remove stale lock file left by a crashed Chromium instance
  const lockFile = path.join('.wwebjs_auth', 'session', 'SingletonLock')
  try { fs.unlinkSync(lockFile) } catch {}

  // Use system Chrome (properly signed) — fallback to puppeteer's bundled Chrome
  const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  let executablePath
  if (require('fs').existsSync(CHROME_PATH)) {
    executablePath = CHROME_PATH
  } else {
    try { executablePath = require('puppeteer').executablePath() } catch {}
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-sync'
      ],
      protocolTimeout: 120000
    }
  })

  client.on('qr', async qr => {
    console.log('[whatsapp] QR event fired — generating image')
    qrcode.generate(qr, { small: true })
    try {
      const qrPath = path.join(__dirname, '../whatsapp-qr.png')
      await QRCode.toFile(qrPath, qr, { width: 400 })
      console.log(`[whatsapp] QR image written: ${fs.statSync(qrPath).size} bytes`)
      if (sendToOwnerFn) {
        const { bot } = require('./bot')
        await bot.telegram.sendPhoto(OWNER_ID, { source: fs.createReadStream(qrPath) }, { caption: 'Scan this to connect Atlas on WhatsApp.' })
        console.log('[whatsapp] QR sent to Telegram')
        fs.unlinkSync(qrPath)
      }
    } catch (err) {
      console.error('[whatsapp] QR send failed:', err.message)
    }
  })

  client.on('ready', () => {
    waReady = true
    console.log('[whatsapp] Client ready.')
  })

  client.on('authenticated', () => {
    console.log('[whatsapp] Authenticated.')
  })

  client.on('auth_failure', msg => {
    console.error('[whatsapp] Auth failed:', msg)
  })

  client.on('error', err => {
    console.error('[whatsapp] Client error:', err.message)
  })

  client.on('disconnected', reason => {
    waReady = false
    console.warn('[whatsapp] Disconnected:', reason)
  })

  // Record Eric's own outgoing group messages so manual replies cancel queued follow-ups.
  // (The 'message' event does not fire for fromMe; message_create does.)
  client.on('message_create', async msg => {
    try {
      if (!msg.fromMe || !msg.body || msg.isStatus) return
      const chat = await msg.getChat()
      if (!chat.isGroup) return
      recordGroupMessage(chat.id._serialized, chat.name, 'Eric', msg.body)
    } catch (err) {
      console.error('[whatsapp] message_create handler error:', err.message)
    }
  })

  client.on('message', async msg => {
    try {
      console.log(`[whatsapp] message received: from=${msg.from} isStatus=${msg.isStatus} body=${msg.body?.slice(0, 50)}`)
      if (msg.isStatus || !msg.body) return

      const chat = await msg.getChat()
      const isGroup = chat.isGroup
      const senderName = msg._data?.notifyName || msg.author || 'Unknown'

      // Always record group messages for context
      if (isGroup) {
        recordGroupMessage(chat.id._serialized, chat.name, senderName, msg.body)

        const mentioned = await msg.getMentions()
        const selfId = client.info?.wid?._serialized
        const isMentioned = mentioned.some(c => c.id._serialized === selfId)
        const startsWithAtlas = msg.body.toLowerCase().startsWith('atlas')
        if (!isMentioned && !startsWithAtlas) return

        const groupId = chat.id._serialized
        const bodyClean = msg.body.replace(/^atlas[,:\s]*/i, '').trim().toLowerCase()

        // Mute commands work for anyone, even when already muted
        const isMuteCmd = MUTE_PHRASES.some(p => bodyClean.includes(p))
        if (mutedGroups.has(groupId) && !isMuteCmd) return

        if (isMuteCmd) {
          mutedGroups.add(groupId)
          await client.sendMessage(groupId, 'Sure, talk later.')
          return
        }
        mutedGroups.delete(groupId)

        const isJustNote = !bodyClean || /^(note|noted|take note|got it|ok|okay)$/i.test(bodyClean)

        // "Noted, Eric" is only for Eric himself asking Atlas to log something.
        // For anyone else, a tag with no content is ignored.
        if (isJustNote) {
          if (msg.fromMe) await client.sendMessage(groupId, 'Noted, Eric.')
          return
        }

        // Real question or request — let Claude respond to whoever asked.
        // Pull full context from DB so we don't lose history across restarts.
        const context = await getFullGroupContext(groupId)
        const speakerLabel = msg.fromMe ? 'Eric' : senderName
        const ctx = makeCtx(msg, client, chat, context, speakerLabel)
        await onMessage(ctx)
        return
      }

      const ctx = makeCtx(msg, client, chat, null, 'Eric')
      await onMessage(ctx)
    } catch (err) {
      console.error('[whatsapp] Message handler error:', err.message)
    }
  })

  client.initialize().catch(err => {
    console.error('[whatsapp] initialize() failed:', err.message)
  })
  waClient = client
  return client
}

function makeCtx(msg, client, chat, groupContext, speakerLabel = 'Eric') {
  const baseText = msg.body
  const fullText = groupContext
    ? `[Group: ${chat.name}]\n[Sender: ${speakerLabel}]\n[Recent conversation:\n${groupContext}\n]\n\n${speakerLabel} says: ${baseText}`
    : baseText

  return {
    from: {
      id: chat.isGroup ? chat.id._serialized : OWNER_ID,
      first_name: speakerLabel
    },
    message: {
      text: fullText,
      reply_to_message: null
    },
    reply: async (text) => {
      const plain = text
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/__(.*?)__/g, '_$1_')
      const target = chat.isGroup ? chat.id._serialized : msg.from
      await client.sendMessage(target, plain)
    },
    platform: 'whatsapp',
    isGroup: chat.isGroup,
    groupName: chat.isGroup ? chat.name : null
  }
}

async function sendToWhatsApp(to, text) {
  if (!waClient || !waReady) {
    console.warn('[whatsapp] Client not ready, cannot send to', to)
    return
  }
  await waClient.sendMessage(to, text)
}

function isReady() { return waReady }

module.exports = { createClient, sendToWhatsApp, isReady, getAllGroupSummaryData, clearGroupStore }
