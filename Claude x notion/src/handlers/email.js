const { sendApproval, getPending, clearPending, OWNER_ID } = require('../bot')
const { sendEmail, getAccountById, checkNow } = require('../email')
const { triageEmail, draftEmailReply } = require('../ai')
const { searchContacts } = require('../notion')

// In-memory store of last fetched emails — keyed by index (1-based)
let emailStore = []

function gmailLink(email) {
  if (!email.messageId) return null
  const msgId = email.messageId.replace(/[<>]/g, '')
  const accountIndex = email.accountId === 'gmail' ? 1 : 0
  return `https://mail.google.com/mail/u/${accountIndex}/#search/rfc822msgid:${encodeURIComponent(msgId)}`
}

// Fetch and store emails, return formatted list
async function fetchAndSummarise(ctx) {
  await ctx.reply('Checking emails...')
  const emails = await checkNow()

  if (emails.length === 0) {
    return ctx.reply('No new unread emails.')
  }

  emailStore = emails
  const lines = []

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i]
    const link = gmailLink(e)
    const linkText = link ? ` [open](${link})` : ''
    lines.push(`*${i + 1}.* [${e.accountLabel}] ${e.from.split('<')[0].trim()}\n_${e.subject}_${linkText}`)
  }

  const header = `📬 *${emails.length} unread email${emails.length > 1 ? 's' : ''}*\n\n`
  await ctx.reply(header + lines.join('\n\n') + '\n\nSay *details [n]* or *reply to [n]* for more.', {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  })
}

// Show full triage details for a specific email
async function showEmailDetails(ctx, index) {
  const email = emailStore[index - 1]
  if (!email) return ctx.reply(`No email at position ${index}. Run "check emails" first.`)

  await ctx.reply('Triaging...')
  const triage = await triageEmail(email)
  const link = gmailLink(email)
  const linkText = link ? `\n[Open in Gmail](${link})` : ''

  const msg = `*${index}. ${email.subject}*\n` +
    `From: ${email.from}\n` +
    `Account: ${email.accountLabel}\n\n` +
    `${triage.summary}\n\n` +
    `Priority: *${triage.priority}*\n` +
    `Action: ${triage.suggestedAction}` +
    linkText

  await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true })
}

// Draft a reply for a specific email
async function draftReplyForEmail(ctx, index) {
  const email = emailStore[index - 1]
  if (!email) return ctx.reply(`No email at position ${index}. Run "check emails" first.`)

  await ctx.reply('Drafting reply...')

  const senderName = email.from.replace(/<.*>/, '').trim()
  const clientContext = await searchContacts(senderName).catch(() => null)
  const contextText = clientContext
    ? `Client: ${clientContext.name}, Company: ${clientContext.company || 'unknown'}`
    : null

  const draft = await draftEmailReply(email, contextText)

  await sendApproval(OWNER_ID, {
    type: 'email_reply',
    emailData: email,
    draft
  })
}

// Called when Eric replies to an approval prompt
async function handleApprovalReply(ctx, text) {
  const userId = ctx.from.id
  const pending = getPending(userId)
  if (!pending) return false

  const normalized = text.trim().toLowerCase()

  if (pending.type === 'email_reply') {
    if (normalized === 'yes' || normalized === 'send') {
      const account = getAccountById(pending.emailData.accountId)
      if (!account) {
        await ctx.reply('Account not found. Cannot send.')
        clearPending(userId)
        return true
      }
      try {
        await sendEmail(account, {
          to: pending.emailData.from,
          subject: pending.emailData.subject.startsWith('Re:')
            ? pending.emailData.subject
            : `Re: ${pending.emailData.subject}`,
          body: pending.draft,
          cc: pending.cc || null,
          bcc: pending.bcc || null,
          inReplyTo: pending.emailData.messageId,
          references: pending.emailData.references
        })
        await ctx.reply('Sent.')
        clearPending(userId)
      } catch (err) {
        await ctx.reply(`Failed to send: ${err.message}`)
      }
      return true
    }

    if (normalized === 'skip' || normalized === 'cancel' || normalized === 'no') {
      await ctx.reply('Skipped.')
      clearPending(userId)
      return true
    }

    if (normalized.startsWith('edit ')) {
      pending.draft = text.slice(5).trim()
      await ctx.reply(
        `Updated:\n\`\`\`\n${pending.draft}\n\`\`\`\n\n*YES* to send · *SKIP* to discard`,
        { parse_mode: 'Markdown' }
      )
      return true
    }

    if (normalized.startsWith('cc ')) {
      pending.cc = text.slice(3).trim()
      await ctx.reply(`CC set to: ${pending.cc}\n\n*YES* to send · *SKIP* to discard`, { parse_mode: 'Markdown' })
      return true
    }

    if (normalized.startsWith('bcc ')) {
      pending.bcc = text.slice(4).trim()
      await ctx.reply(`BCC set to: ${pending.bcc}\n\n*YES* to send · *SKIP* to discard`, { parse_mode: 'Markdown' })
      return true
    }
  }

  if (pending.type === 'notion_update') {
    if (normalized === 'yes') {
      try {
        await pending.updateFn()
        await ctx.reply('Notion updated.')
      } catch (err) {
        await ctx.reply(`Notion update failed: ${err.message}`)
      }
      clearPending(userId)
      return true
    }
    if (normalized === 'no' || normalized === 'cancel') {
      await ctx.reply('Cancelled.')
      clearPending(userId)
      return true
    }
  }

  return false
}

module.exports = { fetchAndSummarise, showEmailDetails, draftReplyForEmail, handleApprovalReply }
