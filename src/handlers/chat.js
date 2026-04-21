const { getHistory, appendHistory, createFollowup, getPendingFollowups, markFollowup } = require('../memory')
const { chat, generateBriefing, parseIntent, parseFollowupRequest } = require('../ai')
const { sendApproval, setPending, getPending, clearPending } = require('../bot')
const { getActiveProjects } = require('../notion')
const { checkNow } = require('../email')
const { handleGetProjects, handleUpdateProject, handleAddNote, handleProgressUpdate, handleAddProject, handleProjectCreateStep } = require('./notion')
const { fetchAndSummarise, showEmailDetails, draftReplyForEmail, composeNewEmail, handleApprovalReply } = require('./email')
const { sendToOwner } = require('../bot')
const { sendToWhatsApp, getAllGroupSummaryData } = require('../whatsapp')
const { summariseGroupChat } = require('../ai')
const { getGroupMessagesByName, getActiveGroupsSince } = require('../memory')
const {
  getReminders,
  getRemindersByStatus,
  getRemindersDueToday,
  getRemindersForBriefing,
  findReminderByName,
  addReminder,
  updateReminder,
  completeReminder,
  deleteReminder,
  formatGrouped,
  formatReminder,
  REMINDER_STATUSES,
  normalizeStatus
} = require('../reminders')

const MYT = 'Asia/Kuala_Lumpur'

function parseDueNatural(text) {
  if (!text) return null
  const s = String(text).trim().toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2})?/.test(s)) return text
  const now = new Date()
  const ymd = d => d.toLocaleDateString('en-CA', { timeZone: MYT })
  if (s === 'today') return ymd(now)
  if (s === 'tomorrow' || s === 'tmr' || s === 'tmrw') {
    const t = new Date(now); t.setDate(t.getDate() + 1); return ymd(t)
  }
  if (s === 'next week') {
    const t = new Date(now); t.setDate(t.getDate() + 7); return ymd(t)
  }
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
  const idx = days.indexOf(s)
  if (idx >= 0) {
    const t = new Date(now)
    const diff = (idx - t.getDay() + 7) % 7 || 7
    t.setDate(t.getDate() + diff)
    return ymd(t)
  }
  return null
}

function groupNameMatches(groupName, lowerText) {
  const name = groupName.toLowerCase()
  if (lowerText.includes(name)) return true
  // Plural/singular flip: "directors" ↔ "director"
  if (name.endsWith('s') && lowerText.includes(name.slice(0, -1))) return true
  if (!name.endsWith('s') && lowerText.includes(name + 's')) return true
  // Word-stem match for multi-word names: "Kumkang Kind" → query containing "kumkang"
  const words = name.split(/\s+/).filter(w => w.length >= 4)
  for (const w of words) {
    const stem = w.endsWith('s') ? w.slice(0, -1) : w
    const re = new RegExp(`\\b${stem}s?\\b`, 'i')
    if (re.test(lowerText)) return true
  }
  return false
}

async function findGroupContext(lowerText) {
  try {
    // Union of in-memory (current session) + DB (persisted) to know candidate names
    const inMem = getAllGroupSummaryData() || []
    const dbGroups = await getActiveGroupsSince(30 * 24).catch(() => [])
    const known = new Map()
    for (const g of [...inMem, ...dbGroups]) {
      if (g?.name && !known.has(g.name.toLowerCase())) known.set(g.name.toLowerCase(), g)
    }
    if (known.size === 0) return { text: '', group: null }
    // Longer names first so "Kumkang Kind" wins over "Kind"
    const sorted = [...known.values()].sort((a, b) => b.name.length - a.name.length)
    for (const g of sorted) {
      if (!groupNameMatches(g.name, lowerText)) continue
      const rows = await getGroupMessagesByName(g.name, { limit: 200, sinceHours: 30 * 24 })
      if (!rows || rows.length === 0) {
        return { text: `\n\n[WhatsApp group "${g.name}" — no messages persisted yet]`, group: g }
      }
      const formatted = rows.map(r => `[${r.time}] ${r.sender}: ${r.body}`).join('\n')
      return { text: `\n\n[WhatsApp group "${g.name}" — last ${rows.length} message(s)]\n${formatted}`, group: g }
    }
  } catch (err) {
    console.error('[chat] findGroupContext error:', err.message)
  }
  return { text: '', group: null }
}

async function handleMessage(ctx) {
  const userId = ctx.from.id
  const text = ctx.message.text?.trim()
  if (!text) return

  // First: check if this is a reply to a pending approval
  const wasApproval = await handleApprovalReply(ctx, text)
  if (wasApproval) return

  // Check project creation multi-step flow
  const wasProjectCreate = await handleProjectCreateStep(ctx, text)
  if (wasProjectCreate) return

  // Group messages bypass Eric's private DM command suite (briefings, emails, reminders,
  // projects, etc.). The group context prefix from whatsapp.js is already on `text`.
  if (ctx.isGroup) {
    const history = await getHistory(userId)
    const reply = await chat(text, history)
    await appendHistory(userId, 'user', text)
    await appendHistory(userId, 'assistant', reply)

    const askMatch = reply.match(/\[ASK_ERIC\]\s*([\s\S]+?)\s*$/)
    if (askMatch) {
      const askQuestion = askMatch[1].trim()
      const publicReply = reply.replace(/\n*\[ASK_ERIC\][\s\S]*$/, '').trim()
      await ctx.reply(publicReply || "Noted, I'll confirm with Eric and follow up.")
      const senderLabel = ctx.from?.first_name || 'Someone'
      const dm = `🔔 *Context check — ${ctx.groupName || 'group'}*\n\n*${senderLabel}:* ${text}\n\n*Atlas asks:* ${askQuestion}`
      try {
        if (ctx.platform === 'whatsapp' && process.env.WHATSAPP_OWNER_ID) {
          const plain = dm.replace(/\*/g, '')
          await sendToWhatsApp(process.env.WHATSAPP_OWNER_ID, plain)
        } else {
          await sendToOwner(dm)
        }
      } catch (err) {
        console.error('[ask_eric] DM failed:', err.message)
      }
      return
    }
    await ctx.reply(reply)
    return
  }

  // Guard: if user says yes/send but no pending exists, don't let Claude hallucinate a send
  const lc = text.trim().toLowerCase()
  if (['yes','send','ok','go','confirm','yes send','ok send'].includes(lc) || lc.startsWith('yes ') || lc.startsWith('ok send') || lc.startsWith('send it')) {
    return ctx.reply('No pending action. Ask me to draft the email first.')
  }

  // If replying to a specific Atlas message, prepend that context
  const replyContext = ctx.message.reply_to_message?.text
  const baseText = replyContext
    ? `[Replying to: "${replyContext.slice(0, 200)}"]\n${text}`
    : text

  const lower = text.toLowerCase()

  // --- WhatsApp send-to-group commands (only from Eric's DM) ---
  if (!ctx.isGroup) {
    // "send/post/forward/share this to/in [group]" — forwards Atlas's last DM response
    const forwardMatch = text.match(/^(?:send|post|forward|share)\s+(?:this|that|it)\s+(?:to|in)\s+(.+?)(?:\s+group(?:\s+chat)?)?\.?$/i)
    if (forwardMatch) return handleSendToGroup(ctx, forwardMatch[1].trim(), null)

    // "send/post to/in [group]: [message]" or "...saying [message]"
    const sendWithMsgMatch = text.match(/^(?:send|post|message)\s+(?:to|in)\s+(.+?)(?:\s+group(?:\s+chat)?)?\s*(?::|saying)\s*(.+)/i)
    if (sendWithMsgMatch) return handleSendToGroup(ctx, sendWithMsgMatch[1].trim(), sendWithMsgMatch[2].trim())
  }

  // --- WhatsApp follow-up commands (only from Eric's DM, not from within a group) ---
  if (!ctx.isGroup) {
    if (/^(list|show)\s+(follow[\s-]?ups?|followups?)\b/i.test(text)) {
      return handleListFollowups(ctx)
    }
    const cancelFu = text.match(/^cancel\s+follow[\s-]?up(?:\s+(\d+))?$/i)
    if (cancelFu) return handleCancelFollowup(ctx, cancelFu[1] ? parseInt(cancelFu[1]) : null)

    const hasDuration = /\b(?:in|after)\s+\d+\s*(?:sec|second|min|minute|hour|hr|day)s?\b/i.test(text)
    const hasFollowupIntent = /\b(?:follow[\s-]?up|nudge|ping|text\s+(?:in|them)|send\s+in|message\s+(?:in|them)|remind\s+them)\b/i.test(text)
    if (hasDuration && hasFollowupIntent) {
      return handleFollowupRequest(ctx, text)
    }
  }

  // If Eric names a WhatsApp group he's in, inject its recorded messages as context
  const { text: groupContext, group: matchedGroup } = await findGroupContext(lower)
  const fullText = groupContext ? `${baseText}${groupContext}` : baseText

  // Short-circuit: if the question names a known WhatsApp group, the answer
  // lives in the injected group context — skip project/email/intent routing
  // and hand straight to Claude. Auto-offer to forward Atlas's reply to the group.
  if (groupContext && !ctx.isGroup) {
    const history = await getHistory(userId)
    const reply = await chat(fullText, history)
    await appendHistory(userId, 'user', text)
    await appendHistory(userId, 'assistant', reply)

    // Auto-offer to forward only if the reply looks like a group-focused response.
    // Skip if the reply contains Eric's personal content markers — Eric must then
    // explicitly say "send this to [group]" to forward.
    const personalMarkers = /\b(morning\s+briefing|weekly\s+summary|action\s+required|due\s+today|unread\s+email|your\s+(?:todo|reminders?|inbox)|\*(?:do\s+it|follow\s+up|schedule\s+it|delegate\s+it|do\s+it\s+later)\*)\b/i
    const hasPersonalContent = personalMarkers.test(reply)
    if (matchedGroup && !hasPersonalContent) {
      await setPending(userId, {
        type: 'send_to_group',
        groupId: matchedGroup.id,
        groupName: matchedGroup.name,
        message: reply
      })
      await ctx.reply(`${reply}\n\n— Send this to *${matchedGroup.name}*? Reply *YES* / *NO*`, { parse_mode: 'Markdown' })
    } else {
      await ctx.reply(reply)
    }
    return
  }

  // --- Email commands ---
  if ((lower.includes('check') && lower.includes('email')) || lower.includes('new email') || lower.includes('any email')) {
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

  // "add new project: [name]" or "add project: [name]"
  const addProjectMatch = text.match(/add\s+(?:new\s+)?project[:\s]+(.+)/i)
  if (addProjectMatch) return handleAddProject(ctx, addProjectMatch[1].trim())

  // "add note to [project]: [text]"
  const noteMatch = text.match(/add\s+note\s+(?:to\s+)?(.+?):\s*(.+)/i)
  if (noteMatch) {
    return handleAddNote(ctx, noteMatch[1].trim(), noteMatch[2].trim())
  }

  // "summarise" or "briefing"
  if (lower.includes('summar') || lower.includes('briefing') || lower.includes('brief me')) {
    await ctx.reply('Generating briefing...')
    const [projects, emails, remindersText] = await Promise.all([
      getActiveProjects(),
      checkNow(),
      getRemindersForBriefing().catch(() => null)
    ])
    const summary = await generateBriefing(projects, emails, 'morning', remindersText)
    return ctx.reply(summary)
  }

  // --- Reminders: quick natural-language patterns ---
  const addReminderMatch = text.match(/^(?:add\s+reminder|remind\s+me(?:\s+to)?|new\s+todo|add\s+todo)[:\s]+(.+)/i)
  if (addReminderMatch) return handleAddReminder(ctx, addReminderMatch[1].trim())

  const doneMatch = text.match(/^(?:mark\s+)?(.+?)\s+(?:is\s+)?(?:done|complete(?:d)?|finished)$/i)
  if (doneMatch && !lower.startsWith('project')) return handleCompleteReminder(ctx, doneMatch[1].trim())

  const moveMatch = text.match(/^(?:move|put)\s+(.+?)\s+(?:to|in|into)\s+(.+)$/i)
  if (moveMatch && normalizeStatus(moveMatch[2].trim())) {
    return handleMoveReminder(ctx, moveMatch[1].trim(), moveMatch[2].trim())
  }

  const deleteMatch = text.match(/^(?:delete|remove|cancel)\s+(?:reminder\s+)?(.+)$/i)
  if (deleteMatch && (lower.includes('reminder') || lower.includes('todo') || lower.includes('to-do'))) {
    return handleDeleteReminder(ctx, deleteMatch[1].replace(/reminder|todo|to-do/gi, '').trim())
  }

  if (lower.includes('reminder') || lower.includes('to-do') || lower.includes('todo') ||
      lower.includes('my list') || lower.includes('do it list') || lower.includes('what\'s due')) {
    return handleReminders(ctx, lower)
  }

  // --- Intent routing fallback ---
  const intent = await parseIntent(fullText)
  console.log(`[chat] parsed intent: ${intent.intent}`)

  if (intent.intent === 'get_projects') return handleGetProjects(ctx)
  if (intent.intent === 'summarize') {
    await ctx.reply('Generating briefing...')
    const [projects, emails, remindersText] = await Promise.all([
      getActiveProjects(),
      checkNow(),
      getRemindersForBriefing().catch(() => null)
    ])
    const summary = await generateBriefing(projects, emails, 'morning', remindersText)
    return ctx.reply(summary)
  }
  if (intent.intent === 'update_project' && intent.projectName) return handleProgressUpdate(ctx, text)
  if (intent.intent === 'compose_email' && intent.to) return composeNewEmail(ctx, intent.to, intent.brief || text)
  if (intent.intent === 'check_emails') return fetchAndSummarise(ctx)
  if (intent.intent === 'check_reminders') return handleReminders(ctx, lower)
  if (intent.intent === 'add_reminder' && intent.reminderName) {
    return handleAddReminder(ctx, intent.reminderName, {
      status: intent.reminderStatus,
      priority: intent.reminderPriority,
      due: intent.reminderDue
    })
  }
  if (intent.intent === 'complete_reminder' && intent.reminderName) {
    return handleCompleteReminder(ctx, intent.reminderName)
  }
  if (intent.intent === 'move_reminder' && intent.reminderName && intent.reminderStatus) {
    return handleMoveReminder(ctx, intent.reminderName, intent.reminderStatus)
  }
  if (intent.intent === 'delete_reminder' && intent.reminderName) {
    return handleDeleteReminder(ctx, intent.reminderName)
  }

  // --- General chat ---
  const history = await getHistory(userId)
  console.log(`[chat] sending ${history.length} history messages to Claude for user ${userId}`)
  const reply = await chat(fullText, history)
  await appendHistory(userId, 'user', text)
  await appendHistory(userId, 'assistant', reply)

  // Clarification backchannel: if Atlas asked Eric something privately in a group,
  // strip [ASK_ERIC] from the group reply and DM Eric on the same platform.
  const askMatch = reply.match(/\[ASK_ERIC\]\s*([\s\S]+?)\s*$/)
  if (ctx.isGroup && askMatch) {
    const askQuestion = askMatch[1].trim()
    const publicReply = reply.replace(/\n*\[ASK_ERIC\][\s\S]*$/, '').trim()
    await ctx.reply(publicReply || "Noted, I'll confirm with Eric and follow up.")
    const senderLabel = ctx.from?.first_name || 'Someone'
    const dm = `🔔 *Context check — ${ctx.groupName || 'group'}*\n\n*${senderLabel}:* ${text}\n\n*Atlas asks:* ${askQuestion}`
    try {
      if (ctx.platform === 'whatsapp' && process.env.WHATSAPP_OWNER_ID) {
        const plain = dm.replace(/\*/g, '')
        await sendToWhatsApp(process.env.WHATSAPP_OWNER_ID, plain)
      } else {
        await sendToOwner(dm)
      }
    } catch (err) {
      console.error('[ask_eric] DM failed:', err.message)
    }
    return
  }

  await ctx.reply(reply)
}

async function handleReminders(ctx, lower) {
  try {
    // Specific status lookups: "do it", "follow up", "schedule it", "delegate it", "do it later"
    for (const status of REMINDER_STATUSES) {
      if (status === 'Done') continue
      if (lower.includes(status.toLowerCase())) {
        const items = await getRemindersByStatus(status)
        if (items.length === 0) return ctx.reply(`No items in *${status}*.`)
        const lines = items.map(formatReminder)
        return ctx.reply(`*${status}*\n\n${lines.join('\n')}`)
      }
    }

    if (lower.includes('due today') || lower.includes('what\'s due') || lower.includes('whats due')) {
      const items = await getRemindersDueToday()
      if (items.length === 0) return ctx.reply('Nothing due today.')
      return ctx.reply(`*Due Today*\n\n${items.map(formatReminder).join('\n')}`)
    }

    const all = await getReminders()
    if (all.length === 0) return ctx.reply('No pending reminders.')
    return ctx.reply(`*Reminders*\n\n${formatGrouped(all)}`)
  } catch (err) {
    console.error('[reminders] handler error:', err.message)
    return ctx.reply('Could not read reminders right now.')
  }
}

async function handleAddReminder(ctx, rawName, opts = {}) {
  try {
    let name = rawName
    let status = opts.status || null
    let priority = opts.priority || null
    let due = opts.due || null

    // Inline parse: "... high priority", "... due tomorrow", "... schedule it"
    const priMatch = name.match(/\b(high|medium|med|low)\s*(?:priority|pri)?\b/i)
    if (priMatch && !priority) {
      priority = priMatch[1]
      name = name.replace(priMatch[0], '').trim()
    }

    const dueMatch = name.match(/\bdue\s+(today|tomorrow|tmr|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|\d{4}-\d{2}-\d{2})\b/i)
    if (dueMatch && !due) {
      due = dueMatch[1]
      name = name.replace(dueMatch[0], '').trim()
    }

    for (const s of REMINDER_STATUSES) {
      const lc = s.toLowerCase()
      if (name.toLowerCase().includes(lc)) {
        if (!status) status = s
        name = name.replace(new RegExp(`,?\\s*${lc}\\s*$`, 'i'), '').replace(new RegExp(`\\b${lc}\\b`, 'i'), '').trim()
        break
      }
    }

    name = name.replace(/^[,.\s]+|[,.\s]+$/g, '')
    if (!name) return ctx.reply('What should I add? Try: `add reminder call Maybank, schedule it, high priority, due tomorrow`.')

    const dueIso = parseDueNatural(due)
    const r = await addReminder({ name, status: status || 'Do It', priority, due: dueIso })
    const statusLabel = r.status || 'Do It'
    const extras = [
      r.priority ? `${r.priority} priority` : null,
      r.due ? `due ${r.due}` : null
    ].filter(Boolean)
    const extraStr = extras.length ? ` (${extras.join(', ')})` : ''
    return ctx.reply(`Added to *${statusLabel}*: ${r.name}${extraStr}.`)
  } catch (err) {
    console.error('[reminders] add error:', err.message)
    return ctx.reply('Could not add reminder.')
  }
}

async function handleCompleteReminder(ctx, name) {
  try {
    const r = await findReminderByName(name)
    if (!r) return ctx.reply(`No reminder matching "${name}".`)
    await completeReminder(r.id)
    return ctx.reply(`Marked done: ${r.name}.`)
  } catch (err) {
    console.error('[reminders] complete error:', err.message)
    return ctx.reply('Could not update reminder.')
  }
}

async function handleMoveReminder(ctx, name, targetStatus) {
  try {
    const normalized = normalizeStatus(targetStatus)
    if (!normalized) {
      return ctx.reply(`Unknown column "${targetStatus}". Valid: ${REMINDER_STATUSES.filter(s => s !== 'Done').join(', ')}.`)
    }
    const r = await findReminderByName(name)
    if (!r) return ctx.reply(`No reminder matching "${name}".`)
    await updateReminder(r.id, { status: normalized })
    return ctx.reply(`Moved *${r.name}* → ${normalized}.`)
  } catch (err) {
    console.error('[reminders] move error:', err.message)
    return ctx.reply('Could not move reminder.')
  }
}

async function handleDeleteReminder(ctx, name) {
  try {
    const r = await findReminderByName(name)
    if (!r) return ctx.reply(`No reminder matching "${name}".`)
    await deleteReminder(r.id)
    return ctx.reply(`Deleted: ${r.name}.`)
  } catch (err) {
    console.error('[reminders] delete error:', err.message)
    return ctx.reply('Could not delete reminder.')
  }
}

function formatDelay(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

async function resolveGroup(groupNameGuess) {
  if (!groupNameGuess) return null
  const dbGroups = await getActiveGroupsSince(30 * 24).catch(() => [])
  const inMem = getAllGroupSummaryData() || []
  const seen = new Map()
  for (const g of [...inMem, ...dbGroups]) {
    if (g?.id && g?.name && !seen.has(g.id)) seen.set(g.id, g)
  }
  const candidates = [...seen.values()].sort((a, b) => b.name.length - a.name.length)
  const target = groupNameGuess.toLowerCase()
  // Exact → case-insensitive exact → groupNameMatches fallback
  for (const g of candidates) if (g.name.toLowerCase() === target) return g
  for (const g of candidates) if (groupNameMatches(g.name, target)) return g
  return null
}

async function handleSendToGroup(ctx, groupNameGuess, message) {
  try {
    const group = await resolveGroup(groupNameGuess)
    if (!group) {
      const dbGroups = await getActiveGroupsSince(30 * 24).catch(() => [])
      const inMem = getAllGroupSummaryData() || []
      const names = Array.from(new Set([...inMem, ...dbGroups].map(g => g?.name).filter(Boolean))).slice(0, 10)
      const list = names.length > 0 ? names.map(n => `- ${n}`).join('\n') : '(none on record)'
      return ctx.reply(`I don't recognise "${groupNameGuess}" as a group. Known groups:\n${list}`)
    }

    let messageToSend = message
    if (!messageToSend) {
      const history = await getHistory(ctx.from.id)
      const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')
      if (!lastAssistant) return ctx.reply('I have no previous message to forward.')
      messageToSend = lastAssistant.content
      // Strip any Eric-facing instructional footer Atlas may have appended
      messageToSend = messageToSend
        .replace(/\n*---+\s*\n[\s\S]*?(?:to send|say[:\s]).*$/i, '')
        .replace(/\n*(?:to\s+(?:send|post|forward)\s+this|say[:\s]*["'*]?send\s+this).*$/i, '')
        .trim()
    }

    await sendToWhatsApp(group.id, messageToSend)
    return ctx.reply(`📤 Sent to *${group.name}*.`, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[sendtogroup] error:', err.message)
    return ctx.reply(`Failed to send: ${err.message}`)
  }
}

async function handleFollowupRequest(ctx, text) {
  try {
    const dbGroups = await getActiveGroupsSince(30 * 24).catch(() => [])
    const inMem = getAllGroupSummaryData() || []
    const names = Array.from(new Set([...inMem, ...dbGroups].map(g => g?.name).filter(Boolean)))

    if (names.length === 0) {
      return ctx.reply('I have no WhatsApp groups on record yet. Once Atlas sees activity in a group, I can schedule follow-ups there.')
    }

    const parsed = await parseFollowupRequest(text, names)
    const delaySeconds = Math.max(30, Math.min(7 * 24 * 3600, parsed.delaySeconds || 900))

    const group = await resolveGroup(parsed.groupName)
    if (!group) {
      const list = names.slice(0, 10).map(n => `- ${n}`).join('\n')
      return ctx.reply(
        `Which group should I follow up in?\n\n${list}\n\nRe-send with the group name, e.g.\n\`follow up in ${formatDelay(delaySeconds)} on ${names[0]} saying "${parsed.followUpText}"\``,
        { parse_mode: 'Markdown' }
      )
    }

    const triggerAt = new Date(Date.now() + delaySeconds * 1000).toISOString()

    await setPending(ctx.from.id, {
      type: 'followup_create',
      groupId: group.id,
      groupName: group.name,
      originalText: text,
      followUpText: parsed.followUpText,
      delaySeconds,
      triggerAt
    })

    return ctx.reply(
      `⏱ *Confirm follow-up*\n\n` +
      `Group: *${group.name}*\n` +
      `In: ${formatDelay(delaySeconds)}\n` +
      `Message: "${parsed.followUpText}"\n\n` +
      `If anyone replies in that group first, I'll cancel automatically.\n\n` +
      `Reply *YES* to queue · *NO* to cancel`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    console.error('[followup] request error:', err.message)
    return ctx.reply(`Could not set up follow-up: ${err.message}`)
  }
}

async function handleListFollowups(ctx) {
  try {
    const rows = await getPendingFollowups()
    if (rows.length === 0) return ctx.reply('No pending follow-ups.')
    const lines = rows.map((r, i) => {
      const ms = new Date(r.trigger_at).getTime() - Date.now()
      const rel = ms <= 0 ? 'due now' : `in ${formatDelay(Math.round(ms / 1000))}`
      return `*${i + 1}.* ${r.group_name} — ${rel}\n   "${r.follow_up_text}"`
    })
    return ctx.reply(`*Pending follow-ups*\n\n${lines.join('\n\n')}\n\n_cancel follow up [n]_`, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[followup] list error:', err.message)
    return ctx.reply('Could not list follow-ups.')
  }
}

async function handleCancelFollowup(ctx, n) {
  try {
    const rows = await getPendingFollowups()
    if (rows.length === 0) return ctx.reply('No pending follow-ups to cancel.')
    if (!n) {
      if (rows.length === 1) {
        await markFollowup(rows[0].id, { status: 'cancelled', cancelReason: 'manual' })
        return ctx.reply(`Cancelled follow-up in *${rows[0].group_name}*.`, { parse_mode: 'Markdown' })
      }
      return handleListFollowups(ctx)
    }
    const row = rows[n - 1]
    if (!row) return ctx.reply(`No follow-up at position ${n}.`)
    await markFollowup(row.id, { status: 'cancelled', cancelReason: 'manual' })
    return ctx.reply(`Cancelled follow-up in *${row.group_name}*.`, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[followup] cancel error:', err.message)
    return ctx.reply('Could not cancel follow-up.')
  }
}

module.exports = { handleMessage }
