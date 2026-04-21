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

const MYT = 'Asia/Kuala_Lumpur'
const sentDates = { morning: null, weekly: null }

function todayMYT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: MYT }) // YYYY-MM-DD
}

function hourMYT() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: MYT, hour: 'numeric', hour12: false }))
}

async function sendMorningBriefing() {
  const today = todayMYT()
  if (sentDates.morning === today) return
  sentDates.morning = today
  try {
    const [projects, emails] = await Promise.all([getActiveProjects(), checkNow()])
    const briefing = await generateBriefing(projects, emails, 'morning')
    await sendToOwner(`☀️ *Good morning, Eric.*\n\n${briefing}`)
    if (process.env.WHATSAPP_OWNER_ID) await sendToWhatsApp(process.env.WHATSAPP_OWNER_ID, `☀️ Good morning, Eric.\n\n${briefing}`)
  } catch (err) {
    console.error('[cron] Morning briefing failed:', err.message)
  }
}

async function sendWeeklySummary() {
  const today = todayMYT()
  if (sentDates.weekly === today) return
  sentDates.weekly = today
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
  const groups = getAllGroupSummaryData()
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

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED === 'true') {
    createWhatsApp(handleMessage)
    console.log('[whatsapp] Initialising — check terminal for QR code')
  }
}

start().catch(err => {
  console.error('[atlas] Fatal startup error:', err)
  process.exit(1)
})

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
