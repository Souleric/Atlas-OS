const { getHistory, appendHistory } = require('../memory')
const { chat, generateBriefing, parseIntent } = require('../ai')
const { getActiveProjects } = require('../notion')
const { checkNow } = require('../email')
const { handleGetProjects, handleUpdateProject, handleAddNote, handleProgressUpdate } = require('./notion')
const { fetchAndSummarise, showEmailDetails, draftReplyForEmail, composeNewEmail, handleApprovalReply } = require('./email')

async function handleMessage(ctx) {
  const userId = ctx.from.id
  const text = ctx.message.text?.trim()
  if (!text) return

  // First: check if this is a reply to a pending approval
  const wasApproval = await handleApprovalReply(ctx, text)
  if (wasApproval) return

  // If replying to a specific Atlas message, prepend that context
  const replyContext = ctx.message.reply_to_message?.text
  const fullText = replyContext
    ? `[Replying to: "${replyContext.slice(0, 200)}"]\n${text}`
    : text

  const lower = text.toLowerCase()

  // --- Email commands ---
  if (lower.includes('check email') || lower.includes('new email') || lower.includes('any email')) {
    return fetchAndSummarise(ctx)
  }

  // "details 2" or "more on 3" or "tell me about email 1"
  const detailsMatch = lower.match(/(?:details?|more\s+(?:on|about)|about\s+email)\s+(\d+)/)
  if (detailsMatch) {
    return showEmailDetails(ctx, parseInt(detailsMatch[1]))
  }

  // "reply to 2" or "draft reply 3"
  const replyMatch = lower.match(/(?:reply\s+to|draft\s+reply(?:\s+for)?|draft\s+(?:a\s+)?reply\s+(?:to|for))\s+(\d+)/)
  if (replyMatch) {
    return draftReplyForEmail(ctx, parseInt(replyMatch[1]))
  }

  // "email to john@example.com about X" or "send email to Kai about X"
  const composeMatch = text.match(/(?:send\s+)?email\s+to\s+(.+?)\s+(?:about|re:|re\s+|regarding|:\s*)(.+)/i)
  if (composeMatch) {
    return composeNewEmail(ctx, composeMatch[1].trim(), composeMatch[2].trim())
  }

  // --- Project commands ---
  if ((lower.includes('show') || lower.includes('list') || lower.includes('overview')) && lower.includes('project')) {
    return handleGetProjects(ctx)
  }

  if (lower.includes('my project') || lower.includes('project status') || lower === 'projects') {
    return handleGetProjects(ctx)
  }

  // "update progress on [project]" or "update [project]: ..."
  if (lower.includes('update') && (lower.includes('progress') || lower.includes(':'))) {
    return handleProgressUpdate(ctx, text)
  }

  // "add note to [project]: [text]"
  const noteMatch = text.match(/add\s+note\s+(?:to\s+)?(.+?):\s*(.+)/i)
  if (noteMatch) {
    return handleAddNote(ctx, noteMatch[1].trim(), noteMatch[2].trim())
  }

  // "summarise" or "briefing"
  if (lower.includes('summar') || lower.includes('briefing') || lower.includes('brief me')) {
    await ctx.reply('Generating briefing...')
    const [projects, emails] = await Promise.all([getActiveProjects(), checkNow()])
    const summary = await generateBriefing(projects, emails, 'morning')
    return ctx.reply(summary)
  }

  // --- Intent routing fallback ---
  const intent = await parseIntent(fullText)
  console.log(`[chat] parsed intent: ${intent.intent}`)

  if (intent.intent === 'get_projects') return handleGetProjects(ctx)
  if (intent.intent === 'summarize') {
    await ctx.reply('Generating briefing...')
    const [projects, emails] = await Promise.all([getActiveProjects(), checkNow()])
    const summary = await generateBriefing(projects, emails, 'morning')
    return ctx.reply(summary)
  }
  if (intent.intent === 'update_project' && intent.projectName) return handleProgressUpdate(ctx, text)

  // --- General chat ---
  const history = await getHistory(userId)
  console.log(`[chat] sending ${history.length} history messages to Claude for user ${userId}`)
  const reply = await chat(fullText, history)
  await appendHistory(userId, 'user', text)
  await appendHistory(userId, 'assistant', reply)
  await ctx.reply(reply)
}

module.exports = { handleMessage }
