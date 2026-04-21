const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
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
}

function getGroupContext(groupId) {
  const group = groupStore.get(groupId)
  if (!group || group.messages.length === 0) return null
  return group.messages.slice(-100).map(m => `[${m.time}] ${m.sender}: ${m.body}`).join('\n')
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

function createClient(onMessage) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  })

  client.on('qr', qr => {
    console.log('\n[whatsapp] Scan this QR code with your WhatsApp Business app:\n')
    qrcode.generate(qr, { small: true })
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

  client.on('disconnected', reason => {
    waReady = false
    console.warn('[whatsapp] Disconnected:', reason)
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

        // Still process mute commands even when muted
        const bodyCheck = msg.body.replace(/^atlas[,:\s]*/i, '').trim().toLowerCase()
        const isMuteCmd = MUTE_PHRASES.some(p => bodyCheck.includes(p))
        if (mutedGroups.has(chat.id._serialized) && !isMuteCmd) return

        const groupId = chat.id._serialized
        const bodyClean = msg.body.replace(/^atlas[,:\s]*/i, '').trim().toLowerCase()

        // Check for mute phrase
        if (MUTE_PHRASES.some(p => bodyClean.includes(p))) {
          mutedGroups.add(groupId)
          await client.sendMessage(groupId, 'Sure, talk later.')
          return
        }

        // If muted, unmute and continue
        mutedGroups.delete(groupId)

        // Always acknowledge the tag
        await client.sendMessage(groupId, 'Noted, Eric.')

        // If it's more than just a tag/note command, let Claude respond too
        const isJustNote = !bodyClean || /^(note|noted|take note|got it|ok|okay)$/i.test(bodyClean)
        if (!isJustNote) {
          const context = getGroupContext(groupId)
          const ctx = makeCtx(msg, client, chat, context)
          await onMessage(ctx)
        }
        return
      }

      const ctx = makeCtx(msg, client, chat, null)
      await onMessage(ctx)
    } catch (err) {
      console.error('[whatsapp] Message handler error:', err.message)
    }
  })

  client.initialize()
  waClient = client
  return client
}

function makeCtx(msg, client, chat, groupContext) {
  const baseText = msg.body
  const fullText = groupContext
    ? `[Group: ${chat.name}]\n[Recent conversation:\n${groupContext}\n]\n\nUser tagged you: ${baseText}`
    : baseText

  return {
    from: {
      id: chat.isGroup ? chat.id._serialized : OWNER_ID,
      first_name: msg._data?.notifyName || 'Eric'
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
    platform: 'whatsapp'
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
