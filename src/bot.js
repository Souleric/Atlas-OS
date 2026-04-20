const { Telegraf } = require('telegraf')

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

const OWNER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10)

// Pending approvals: Map<userId, pendingAction>
// pendingAction: { type, data, expiresAt }
const pendingApprovals = new Map()

// Conversation history per user for chat context
const chatHistory = new Map()

// Guard middleware — only respond to Eric
bot.use((ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return
  return next()
})

function getChatHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, [])
  return chatHistory.get(userId)
}

function addToHistory(userId, role, content) {
  const history = getChatHistory(userId)
  history.push({ role, content })
  // Keep last 20 messages (10 exchanges)
  if (history.length > 20) history.splice(0, history.length - 20)
}

function setPending(userId, action) {
  pendingApprovals.set(userId, {
    ...action,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 min timeout
  })
}

function getPending(userId) {
  const pending = pendingApprovals.get(userId)
  if (!pending) return null
  if (Date.now() > pending.expiresAt) {
    pendingApprovals.delete(userId)
    return null
  }
  return pending
}

function clearPending(userId) {
  pendingApprovals.delete(userId)
}

// Send a message to Eric (used by other modules)
async function sendToOwner(text, options = {}) {
  await bot.telegram.sendMessage(OWNER_ID, text, { parse_mode: 'Markdown', ...options })
}

// Send an approval request to Eric
async function sendApproval(userId, action) {
  setPending(userId, action)

  let message = ''

  if (action.type === 'email_reply') {
    const { emailData, draft, cc, bcc } = action
    const ccLine = cc ? `\nCC: ${escapeMarkdown(cc)}` : ''
    const bccLine = bcc ? `\nBCC: ${escapeMarkdown(bcc)}` : ''
    message = `📬 *Reply draft ready*\n` +
      `To: ${escapeMarkdown(emailData.from)}\n` +
      `Account: ${emailData.accountLabel}\n` +
      `Subject: Re: ${escapeMarkdown(emailData.subject)}${ccLine}${bccLine}\n\n` +
      `\`\`\`\n${draft}\n\`\`\`\n\n` +
      `*YES* to send · *EDIT [text]* to revise · *CC [email]* to add CC · *BCC [email]* to add BCC · *SKIP* to discard`
  } else if (action.type === 'notion_update') {
    const { projectName, field, value } = action
    message = `📋 *Notion update*\n` +
      `Project: ${escapeMarkdown(projectName)}\n` +
      `Change: ${escapeMarkdown(field)} → *${escapeMarkdown(value)}*\n\n` +
      `Reply *YES* to confirm · *NO* to cancel`
  } else if (action.type === 'email_compose') {
    return // caller handles its own prompt
  }

  await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' })
}

function escapeMarkdown(text) {
  if (!text) return ''
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

module.exports = {
  bot,
  sendToOwner,
  sendApproval,
  getPending,
  escapeMarkdown,
  clearPending,
  getChatHistory,
  addToHistory,
  OWNER_ID
}
