require('dotenv').config()

const cron = require('node-cron')
const { bot, sendToOwner } = require('./bot')
const { checkMemoryHealth } = require('./memory')
const { startPolling } = require('./email')
const { handleMessage } = require('./handlers/chat')
const { getActiveProjects } = require('./notion')
const { generateBriefing } = require('./ai')
const { checkNow } = require('./email')
const { createClient: createWhatsApp, sendToWhatsApp, getAllGroupSummaryData, clearGroupStore } = require('./whatsapp')
const { summariseGroupChat } = require('./ai')
const { getActiveGroupsSince, getDueFollowups, markFollowup, hasNewMessagesInGroupSince } = require('./memory')
const { getRemindersForBriefing } = require('./reminders')

// Validate required env vars on startup
const required = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'ANTHROPIC_API_KEY',
  'NOTION_TOKEN',
  'EMAIL_ACCOUNTS'
]

const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`[atlas] Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// Register bot message handler
bot.on('text', handleMessage)

// Bot error handler
bot.catch((err, ctx) => {
  console.error('[bot] Error:', err.message)
})

const fs = require('fs')
const path = require('path')
const MYT = 'Asia/Kuala_Lumpur'
const SENT_DATES_FILE = path.join(__dirname, '../.sent_dates.json')

function loadSentDates() {
  try { return JSON.parse(fs.readFileSync(SENT_DATES_FILE, 'utf8')) } catch { return {} }
}

function saveSentDate(key, date) {
  const data = loadSentDates()
  data[key] = date
  fs.writeFileSync(SENT_DATES_FILE, JSON.stringify(data))
}

function todayMYT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: MYT })
}

function hourMYT() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: MYT, hour: 'numeric', hour12: false }))
}

async function sendMorningBriefing() {
  const today = todayMYT()
  if (loadSentDates().morning === today) return
  saveSentDate('morning', today)
  try {
    const [projects, emails, remindersText] = await Promise.all([
      getActiveProjects(),
      checkNow(),
      getRemindersForBriefing().catch(() => null)
    ])
    const briefing = await generateBriefing(projects, emails, 'morning', remindersText)
    await sendToOwner(`☀️ *Good morning, Eric.*\n\n${briefing}`)
    if (process.env.WHATSAPP_OWNER_ID) await sendToWhatsApp(process.env.WHATSAPP_OWNER_ID, `☀️ Good morning, Eric.\n\n${briefing}`)
  } catch (err) {
    console.error('[cron] Morning briefing failed:', err.message)
  }
}

async function sendWeeklySummary() {
  const today = todayMYT()
  if (loadSentDates().weekly === today) return
  saveSentDate('weekly', today)
  try {
    const [projects, emails] = await Promise.all([getActiveProjects(), checkNow()])
    const summary = await generateBriefing(projects, emails, 'weekly')
    await sendToOwner(`📊 *Weekly Summary*\n\n${summary}`)
  } catch (err) {
    console.error('[cron] Weekly summary failed:', err.message)
  }
}

// Morning briefing — 9:00 AM MYT daily
cron.schedule('0 9 * * *', sendMorningBriefing, { timezone: MYT })

// Weekly summary — Monday 8:30 AM MYT
cron.schedule('30 8 * * 1', sendWeeklySummary, { timezone: MYT })

// WhatsApp group daily summary — 5:00 PM MYT
cron.schedule('0 17 * * *', async () => {
  const groups = await getActiveGroupsSince(24).catch(() => [])
  if (groups.length === 0) return
  console.log(`[cron] Sending WhatsApp group summaries for ${groups.length} group(s)`)
  for (const group of groups) {
    try {
      const summary = await summariseGroupChat(group.name, group.messages)
      await sendToOwner(`💬 *${group.name}*\n\n${summary}`)
    } catch (err) {
      console.error(`[cron] Group summary failed for ${group.name}:`, err.message)
    }
  }
  clearGroupStore()
}, { timezone: MYT })

let followupPollerRunning = false
async function tickFollowups() {
  if (followupPollerRunning) return
  followupPollerRunning = true
  try {
    const due = await getDueFollowups()
    if (due.length > 0) console.log(`[followup] tick: ${due.length} due`)
    for (const row of due) {
      try {
        const replied = await hasNewMessagesInGroupSince(row.group_id, row.created_at)
        if (replied) {
          console.log(`[followup] id=${row.id} cancelled — replied in ${row.group_name}`)
          await markFollowup(row.id, { status: 'cancelled', cancelReason: 'replied' })
          await sendToOwner(`✔ Follow-up in *${row.group_name}* skipped — someone already replied.`).catch(() => {})
          continue
        }
        console.log(`[followup] id=${row.id} sending to ${row.group_name} (${row.group_id})`)
        await sendToWhatsApp(row.group_id, row.follow_up_text)
        await markFollowup(row.id, { status: 'sent', sentAt: new Date().toISOString() })
        await sendToOwner(`📤 Follow-up sent in *${row.group_name}*:\n"${row.follow_up_text}"`).catch(() => {})
      } catch (err) {
        console.error(`[followup] tick error id=${row.id}:`, err.message)
        await markFollowup(row.id, { status: 'failed', cancelReason: err.message }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[followup] poller error:', err.message)
  } finally {
    followupPollerRunning = false
  }
}

function startFollowupPoller() {
  console.log('[followup] Poller started (5s interval)')
  setInterval(tickFollowups, 5000)
}

async function verifyBotConnected(retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      await bot.telegram.getMe()
      return true
    } catch (err) {
      console.log(`[atlas] Telegram connect attempt ${i}/${retries} failed: ${err.message}`)
      if (i < retries) await new Promise(r => setTimeout(r, 3000))
    }
  }
  return false
}

async function start() {
  console.log('[atlas] Starting...')

  const connected = await verifyBotConnected()
  if (!connected) {
    console.error('[atlas] Could not connect to Telegram after retries. Exiting.')
    process.exit(1)
  }

  // Drop any existing webhook/polling session before starting
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {})
  await new Promise(r => setTimeout(r, 2000))

  // bot.launch() runs the polling loop indefinitely — do not await it
  bot.launch().catch(err => {
    console.error('[atlas] Bot crashed:', err.message)
    // Only exit on fatal errors, not transient network issues
    const fatal = ['409', 'EFATAL', 'terminated by other getUpdates']
    if (fatal.some(f => err.message.includes(f))) process.exit(1)
    // For network timeouts, Telegraf will retry automatically
  })

  // Wait long enough for a 409 conflict crash to surface before declaring stable.
  // If the process exits in this window, the startup message is never sent.
  await new Promise(resolve => setTimeout(resolve, 8000))

  // Send missed briefing if it's past 9 AM MYT and hasn't been sent today
  const h = hourMYT()
  if (h >= 9 && h < 24) {
    console.log(`[atlas] Startup at ${h}:xx MYT — checking for missed briefing`)
    sendMorningBriefing()
  }

  console.log('[atlas] Bot running. Atlas is online.')
  const memHealth = await checkMemoryHealth()
  if (memHealth.ok) {
    await sendToOwner('Atlas is online. Memory connected.').catch(() => {})
  } else {
    await sendToOwner(`Atlas is online. ⚠️ Memory offline: ${memHealth.reason}`).catch(() => {})
  }

  // Poll silently — emails available when Eric asks
  startPolling(() => {}, 5 * 60 * 1000)

  // WhatsApp follow-up poller — fires queued follow-ups unless someone already replied
  startFollowupPoller()

  // WhatsApp — fire immediately (setTimeout was being starved)
  console.log(`[whatsapp] env WHATSAPP_ENABLED="${process.env.WHATSAPP_ENABLED}" cwd=${process.cwd()}`)
  if (process.env.WHATSAPP_ENABLED === 'true') {
    console.log('[whatsapp] Initialising — QR will be sent to Telegram if needed')
    try {
      createWhatsApp(handleMessage, sendToOwner)
    } catch (err) {
      console.error('[whatsapp] createClient threw:', err.message)
    }
  } else {
    console.warn('[whatsapp] Skipped: WHATSAPP_ENABLED not "true"')
  }
}

start().catch(err => {
  console.error('[atlas] Fatal startup error:', err)
  process.exit(1)
})

// Catch errors that escape all try/catch (puppeteer, IMAP, etc.)
const FATAL_PATTERNS = ['409', 'EFATAL', 'terminated by other getUpdates']
process.on('uncaughtException', (err) => {
  try {
    const msg = err?.message || String(err)
    console.error('[atlas] Uncaught exception:', msg)
    if (FATAL_PATTERNS.some(p => msg.includes(p))) process.exit(1)
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.message : String(reason)
    console.error('[atlas] Unhandled rejection:', msg)
    if (FATAL_PATTERNS.some(p => msg.includes(p))) process.exit(1)
  } catch {}
})
process.on('exit', code => {
  console.error(`[atlas] Process exiting with code ${code}`)
})

// Graceful shutdown
process.once('SIGINT', () => { console.error('[atlas] SIGINT received'); bot.stop('SIGINT') })
process.once('SIGTERM', () => { console.error('[atlas] SIGTERM received'); bot.stop('SIGTERM') })
process.on('SIGHUP', () => console.error('[atlas] SIGHUP received'))
process.on('SIGPIPE', () => console.error('[atlas] SIGPIPE received'))
process.on('SIGABRT', () => { console.error('[atlas] SIGABRT received'); process.exit(1) })
