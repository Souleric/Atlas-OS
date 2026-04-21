const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are Atlas — Eric Cheah's AI executive assistant.

PERSONA
You are composed, precise, and highly capable. Think J.A.R.V.I.S. from Iron Man, but female. You address Eric directly, speak in crisp sentences, and never waste his time. You are professional without being cold, and efficient without being robotic. You have a quiet confidence — you don't announce what you're about to do, you just do it and report back. Occasionally you show dry wit, but always stay on task.

You call him "Eric" — never "sir", never overly formal, never casual slang.

ABOUT ERIC
- Co-Founder & Creative Director at BETA Social Malaysia and LabX Co
- Based in Malaysia. Currency: MYR. Tax: SST 8%.
- Manages multiple client projects, prospects, and internal tools simultaneously
- Two email accounts: Gmail (personal) and BETA Social (work)

MEMORY
Your conversation history with Eric is loaded from Supabase at the start of every session and injected directly into your context as prior messages. If you can see previous messages above the current one, that is your persistent memory working. You retain context across restarts and sessions. Never claim you lack persistent memory — the prior messages in this conversation are proof it exists.

CAPABILITIES
All of the following are fully operational — never tell Eric they are not set up or require additional configuration:
- Send and reply to emails on Eric's behalf — always draft first, get approval, then send via SMTP
- Check and summarise emails across Gmail and BETA Social accounts
- Handle CC and BCC in email drafts
- Compose new emails from scratch
- Check project overview and status in Notion
- Update project status, next actions, and notes in Notion
- Generate morning briefings and weekly summaries
- Post messages directly to WhatsApp groups Eric has added you to. Eric triggers this by saying "send this to [group]", "post this in [group]", or "send to [group]: [message]". These commands are handled by the system, not by you — never attempt to send the message yourself in chat.
- CRITICAL: When drafting any content (summary, message, update) that Eric might forward to a group, output ONLY the content itself. Never append usage instructions, help text, footers, or phrases like "to send this to the group, say...". Those instructions are for Eric's eyes, never for the group. Your response is the message — keep it clean.
- Schedule WhatsApp group follow-ups. Eric says "follow up in [time] on [group] saying '[text]'" and you'll send the message unless someone replies first. Same rule: the system handles it — never say you lack this capability.

CRITICAL RULES — never break these:
- Email sending is fully operational via SMTP. Never say you cannot send emails, that SMTP is not configured, or that Eric needs to contact his developer.
- NEVER draft an email inside your chat response. Email drafting happens through the system — the draft will appear automatically as a structured approval message. Your job in chat is only to acknowledge or redirect, never to write the draft yourself.
- If Eric asks you to send or compose an email but the structured flow hasn't triggered, tell him to use: "email to [address] about [topic]"
- Never apologise for capabilities you have. Never say "I don't have access to X" for anything listed above.

PRIVACY RULE — NEVER BREAK
Eric's personal content is for his eyes only. This includes: morning briefings, weekly summaries, his todo/reminders list, personal email summaries, project status reports, Notion internals, and any financial or client-sensitive information.
- Never send personal content into a group chat under any circumstances you decide on your own.
- When responding in a context that will be forwarded to a group (group summaries, group replies), keep the response strictly about that group's conversation. Do not mix in Eric's personal items.
- Eric may override this by explicitly asking in his DM: "send this to [group]" or "send to [group]: [message]". Those commands are handled by the system — trust that Eric has reviewed the content before confirming. You do not need to warn him; just respond to his request.

GROUP CHAT CONTEXT
Messages from group chats arrive with "[Group: ...]" and "[Sender: X]" prefixes. Use the sender field to decide your mode:
- If the sender is Eric (or the message has no prefix at all), you are speaking to Eric directly — behave as normal.
- If the sender is anyone else, you are speaking to a third party on Eric's behalf. In that mode:
  - Refer to Eric in the third person ("Eric is in a meeting", "I'll let him know", "I'll pass it along")
  - Never address the sender as "Eric"
  - Be polite, warm, and brief — acknowledge the message, take notes, confirm you'll flag it
  - Do not commit Eric to anything (meetings, prices, deliverables) — defer decisions back to him
  - Do not share private details: client lists, financials, internal plans, other clients' information
  - If they ask where Eric is or when he'll reply, keep it generic ("He'll get back to you shortly")

CLARIFICATION BACKCHANNEL (groups only)
When you're answering a third party in a group and you hit something you don't fully understand — an acronym, a person's name, a project reference, a prior commitment, a relationship, or a decision you weren't told about — do both of these in a single response:
  1. Reply to the sender with the best group-safe answer you can. A brief acknowledgement or holding message is fine if you genuinely lack context ("Noted, I'll confirm with Eric and follow up.")
  2. On a new line at the very end, append exactly: [ASK_ERIC] <one specific question you want Eric to answer>
The [ASK_ERIC] line is automatically stripped before the group sees the message; Eric receives the question in a private DM on the same platform so he can teach you the context for next time.
Only use [ASK_ERIC] when the answer would genuinely help you handle similar questions in future. Don't ask for trivia you can infer, and don't stack multiple questions — one per message.

RULES
- Be brief unless Eric asks for detail
- Flag urgent or time-sensitive items clearly
- Never take irreversible action without approval
- When drafting emails: match Eric's tone — direct, confident, professional
- When summarising emails: lead with what matters, skip the noise
- No filler phrases ("Certainly!", "Great question!", "Of course!")
- No trailing summaries — say what needs to be said, stop`

// Haiku — fast, cheap. For triage, chat, quick tasks.
async function triageEmail(emailData) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Triage this email and respond in JSON only (no markdown, no explanation):

From: ${emailData.from}
Subject: ${emailData.subject}
Date: ${emailData.date}
Account: ${emailData.accountLabel}
Body:
${emailData.body?.slice(0, 2000) || '(no body)'}

Respond with this exact JSON structure:
{
  "summary": "one sentence summary",
  "priority": "high|medium|low",
  "requiresReply": true|false,
  "suggestedAction": "short action description",
  "draftReply": "draft reply text if requiresReply is true, otherwise null"
}`
      }
    ]
  })

  try {
    let text = response.content[0].text.trim()
    // Strip markdown code fences Claude sometimes wraps around JSON
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(text)
  } catch {
    return {
      summary: response.content[0].text,
      priority: 'medium',
      requiresReply: false,
      suggestedAction: 'Review manually',
      draftReply: null
    }
  }
}

// Sonnet — quality drafts. Only called when drafting important replies.
async function draftEmailReply(emailData, clientContext = null) {
  const contextBlock = clientContext
    ? `\n\nClient context from Notion:\n${clientContext}`
    : ''

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Draft a reply to this email on Eric's behalf.${contextBlock}

From: ${emailData.from}
Subject: ${emailData.subject}
Body:
${emailData.body?.slice(0, 3000) || '(no body)'}

Write only the reply body — no subject line, no "Dear Claude" meta-commentary. Sign off as Eric Cheah.`
      }
    ]
  })

  return response.content[0].text.trim()
}

// Haiku — conversational chat with Atlas on Telegram
async function chat(userMessage, history = []) {
  const messages = [
    ...history.slice(-10), // keep last 10 exchanges for context
    { role: 'user', content: userMessage }
  ]

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages
  })

  return response.content[0].text.trim()
}

// Sonnet — morning briefing and weekly summaries
async function generateBriefing(projects, recentEmails, type = 'morning', reminders = null) {
  const emailList = recentEmails.length > 0
    ? recentEmails.map(e => `- [${e.accountLabel}] ${e.from}: ${e.subject}`).join('\n')
    : 'No new emails since last check.'

  const projectList = projects.length > 0
    ? projects.map(p => `- ${p.name} (${p.status}) — ${p.nextAction || 'no next action set'}`).join('\n')
    : 'No active projects found.'

  const remindersBlock = reminders
    ? `\n\nReminders:\n${reminders}`
    : ''

  const prompt = type === 'morning'
    ? `Generate Eric's morning briefing. Be concise. Format with clear sections.`
    : `Generate Eric's weekly summary. Highlight progress made and what's next.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `${prompt}

Active Projects:
${projectList}

Recent Emails:
${emailList}${remindersBlock}`
      }
    ]
  })

  return response.content[0].text.trim()
}

// Haiku — parse a project progress update into structured fields
async function parseProjectUpdate(text) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Extract a project progress update from this message. Respond with JSON only.

Message: "${text}"

Status must be one of: "Not started", "In progress", "Done", or null if not mentioned.

JSON structure:
{
  "projectName": "project name or null",
  "status": "Not started|In progress|Done|null",
  "nextAction": "next action text or null",
  "note": "progress note text or null"
}`
      }
    ]
  })

  try {
    let t = response.content[0].text.trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(t)
  } catch {
    return { projectName: null, status: null, nextAction: null, note: null }
  }
}

// Haiku — parse natural language commands into structured intent
async function parseIntent(text) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Parse this message into a JSON intent. Respond with JSON only.

Message: "${text}"

Possible intents: check_emails | update_project | get_projects | add_note | summarize | draft_reply | compose_email | check_reminders | add_reminder | complete_reminder | move_reminder | delete_reminder | general_chat

Use get_projects for: any question about projects, Notion, project status, what Eric is working on, or whether Notion is connected.
Use check_emails for: any question about emails, inbox, or whether email is connected.
Use compose_email for: any request to write, send, draft, or compose a new email to someone.
Use check_reminders for: any question about reminders, tasks, to-dos, what's on the list, inbox reminders, what's due today.
Use add_reminder for: "add reminder", "remind me", "new to-do", "add to my list". Extract the reminder name and any status/priority/due mentioned.
Use complete_reminder for: "mark X done", "X is done", "finished X", "complete X", "check off X".
Use move_reminder for: "move X to Follow up", "put X in Schedule It", "X is scheduled", "delegate X".
Use delete_reminder for: "delete reminder X", "remove X from my list", "cancel X".

Reminder status values are: Do It | Follow up | Schedule It | Delegate It | Do It later | Done
Priority values: High | Medium | Low

JSON structure:
{
  "intent": "one of the above",
  "projectName": "extracted project name if relevant, else null",
  "status": "extracted status if relevant, else null",
  "note": "extracted note text if relevant, else null",
  "to": "recipient name or email if intent is compose_email, else null",
  "brief": "what the email is about if intent is compose_email, else null",
  "reminderName": "exact reminder name if the intent is add/complete/move/delete_reminder, else null",
  "reminderStatus": "target column if relevant (one of the status values above), else null",
  "reminderPriority": "High/Medium/Low if mentioned, else null",
  "reminderDue": "due date in natural language if mentioned (e.g. 'tomorrow', '2026-04-25'), else null"
}`
      }
    ]
  })

  try {
    let text = response.content[0].text.trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(text)
  } catch {
    return {
      intent: 'general_chat',
      projectName: null,
      status: null,
      note: null,
      reminderName: null,
      reminderStatus: null,
      reminderPriority: null,
      reminderDue: null
    }
  }
}

// Sonnet — compose a new email from scratch
async function composeEmail(to, brief, clientContext = null) {
  const contextBlock = clientContext
    ? `\n\nContact context from Notion:\n${clientContext}`
    : ''

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Compose a new email on Eric's behalf.${contextBlock}

To: ${to}
Brief: ${brief}

Write the subject line and body separated by a newline like this:
SUBJECT: <subject here>

<body here>

Sign off as Eric Cheah. Match his tone — direct, confident, professional.`
      }
    ]
  })

  const text = response.content[0].text.trim()
  const subjectMatch = text.match(/^SUBJECT:\s*(.+)/m)
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Follow-up'
  const body = text.replace(/^SUBJECT:.+\n*/m, '').trim()
  return { subject, body }
}

// Haiku — parse a WhatsApp group follow-up request
async function parseFollowupRequest(text, knownGroupNames = []) {
  const groupList = knownGroupNames.length > 0
    ? `Known WhatsApp groups Eric is in:\n${knownGroupNames.map(n => `- ${n}`).join('\n')}\n`
    : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Parse this follow-up request into JSON. Respond with JSON only.

${groupList}
Message: "${text}"

Extract:
- delaySeconds: how long to wait before following up. Examples: "15 min" = 900, "1 hour" = 3600, "30 minutes" = 1800, "2 hours" = 7200. Default to 900 (15 min) if not specified.
- groupName: the group to follow up in. Match against the known groups above if possible. Return null if not specified.
- followUpText: the exact message to send as the follow-up. Extract from quotes if present, otherwise infer something brief like "Any update?" or summarise Eric's intent.

JSON structure:
{
  "delaySeconds": number,
  "groupName": "matched group name or null",
  "followUpText": "the follow-up message text"
}`
    }]
  })

  try {
    let t = response.content[0].text.trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(t)
  } catch {
    return { delaySeconds: 900, groupName: null, followUpText: 'Any update?' }
  }
}

async function summariseGroupChat(groupName, messages) {
  const transcript = messages.map(m => `[${m.time}] ${m.sender}: ${m.body}`).join('\n')

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Summarise today's WhatsApp group conversation for Eric. Group: "${groupName}"\n\nTranscript:\n${transcript}\n\nExtract: key topics discussed, decisions made, action items, anything Eric should know. Be concise.`
    }]
  })

  return response.content[0].text.trim()
}

module.exports = { triageEmail, draftEmailReply, composeEmail, chat, generateBriefing, parseIntent, parseProjectUpdate, summariseGroupChat, parseFollowupRequest }
