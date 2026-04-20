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
- Check and summarise emails across multiple accounts
- Draft email replies on Eric's behalf — always get his approval before sending
- Handle CC and BCC when drafting replies
- Draft new emails from scratch
- Check project overview and status in Notion
- Update project status, next actions, and notes in Notion
- Generate morning briefings and weekly summaries

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
async function generateBriefing(projects, recentEmails, type = 'morning') {
  const emailList = recentEmails.length > 0
    ? recentEmails.map(e => `- [${e.accountLabel}] ${e.from}: ${e.subject}`).join('\n')
    : 'No new emails since last check.'

  const projectList = projects.length > 0
    ? projects.map(p => `- ${p.name} (${p.status}) — ${p.nextAction || 'no next action set'}`).join('\n')
    : 'No active projects found.'

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
${emailList}`
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

Possible intents: check_emails | update_project | get_projects | add_note | summarize | draft_reply | general_chat

Use get_projects for: any question about projects, Notion, project status, what Eric is working on, or whether Notion is connected.
Use check_emails for: any question about emails, inbox, or whether email is connected.

JSON structure:
{
  "intent": "one of the above",
  "projectName": "extracted project name if relevant, else null",
  "status": "extracted status if relevant, else null",
  "note": "extracted note text if relevant, else null"
}`
      }
    ]
  })

  try {
    let text = response.content[0].text.trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(text)
  } catch {
    return { intent: 'general_chat', projectName: null, status: null, note: null }
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

module.exports = { triageEmail, draftEmailReply, composeEmail, chat, generateBriefing, parseIntent, parseProjectUpdate }
