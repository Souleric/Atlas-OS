require('dotenv').config()

const cron = require('node-cron')
const { bot, sendToOwner } = require('./bot')
const { startPolling } = require('./email')
const { handleNewEmail } = require('./handlers/email')
const { handleMessage } = require('./handlers/chat')
const { getActiveProjects } = require('./notion')
const { generateBriefing } = require('./ai')
const { checkNow } = require('./email')

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

// Morning briefing — 9:00 AM Malaysia time (UTC+8 = 01:00 UTC)
cron.schedule('0 1 * * *', async () => {
  try {
    const [projects, emails] = await Promise.all([
      getActiveProjects(),
      checkNow()
    ])
    const briefing = await generateBriefing(projects, emails, 'morning')
    await sendToOwner(`☀️ *Good morning, Eric.*\n\n${briefing}`)
  } catch (err) {
    console.error('[cron] Morning briefing failed:', err.message)
  }
})

// Weekly summary — Monday 8:30 AM MYT (00:30 UTC Monday)
cron.schedule('30 0 * * 1', async () => {
  try {
    const [projects, emails] = await Promise.all([
      getActiveProjects(),
      checkNow()
    ])
    const summary = await generateBriefing(projects, emails, 'weekly')
    await sendToOwner(`📊 *Weekly Summary*\n\n${summary}`)
  } catch (err) {
    console.error('[cron] Weekly summary failed:', err.message)
  }
})

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
    process.exit(1)
  })

  // Give polling loop a moment to initialise
  await new Promise(resolve => setTimeout(resolve, 1500))

  console.log('[atlas] Bot running. Atlas is online.')

  // Non-fatal startup message — retry once on transient error
  try {
    await sendToOwner('Atlas is online. How can I help you today?')
  } catch {
    await new Promise(r => setTimeout(r, 3000))
    await sendToOwner('Atlas is online. How can I help you today?').catch(() => {})
  }

  // Poll emails silently in background — store for when Eric asks
  startPolling(() => {}, 5 * 60 * 1000)
}

start().catch(err => {
  console.error('[atlas] Fatal startup error:', err)
  process.exit(1)
})

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
