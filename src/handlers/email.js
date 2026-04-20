const { sendApproval, getPending, clearPending, escapeMarkdown, OWNER_ID } = require('../bot')
const { sendEmail, getAccountById, checkNow } = require('../email')
const { triageEmail, draftEmailReply, composeEmail } = require('../ai')
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
    if (normalized === 'yes' || normalized === 'send' || normalized.startsWith('yes ') || normalized === 'yes send') {
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

  if (pending.type === 'email_compose') {
    // Waiting for account selection
    if (pending.awaitingAccount) {
      const accounts = JSON.parse(process.env.EMAIL_ACCOUNTS || '[]')
      const index = parseInt(normalized) - 1
      const account = accounts[index]
      if (!account) {
        const list = accounts.map((a, i) => `*${i + 1}.* ${a.label}`).join('\n')
        await ctx.reply(`Pick a number:\n${list}`, { parse_mode: 'Markdown' })
        return true
      }
      pending.emailData.accountId = account.id
      pending.emailData.accountLabel = account.label
      pending.awaitingAccount = false

      const { emailData, draft, cc, bcc } = pending
      const ccLine = cc ? `\nCC: ${escapeMarkdown(cc)}` : ''
      const bccLine = bcc ? `\nBCC: ${escapeMarkdown(bcc)}` : ''
      await ctx.reply(
        `📬 *Email draft*\n` +
        `From: ${escapeMarkdown(account.label)}\n` +
        `To: ${escapeMarkdown(emailData.from)}\n` +
        `Subject: ${escapeMarkdown(emailData.subject)}${ccLine}${bccLine}\n\n` +
        `\`\`\`\n${draft}\n\`\`\`\n\n` +
        `*YES* to send · *EDIT [text]* · *SUBJECT [text]* · *CC [email]* · *BCC [email]* · *SKIP*`,
        { parse_mode: 'Markdown' }
      )
      return true
    }

    if (normalized === 'yes' || normalized === 'send' || normalized.startsWith('yes ') || normalized === 'yes send') {
      const accounts = JSON.parse(process.env.EMAIL_ACCOUNTS || '[]')
      const account = accounts.find(a => a.id === pending.emailData.accountId) || accounts[0]
      if (!account) {
        await ctx.reply('No email account configured.')
        clearPending(userId)
        return true
      }
      try {
        await sendEmail(account, {
          to: pending.emailData.from,
          subject: pending.emailData.subject,
          body: pending.draft,
          cc: pending.cc || null,
          bcc: pending.bcc || null
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
      await ctx.reply(`Updated:\n\`\`\`\n${pending.draft}\n\`\`\`\n\n*YES* to send · *SKIP* to discard`, { parse_mode: 'Markdown' })
      return true
    }

    if (normalized.startsWith('subject ')) {
      pending.emailData.subject = text.slice(8).trim()
      await ctx.reply(`Subject updated to: ${pending.emailData.subject}\n\n*YES* to send · *SKIP* to discard`, { parse_mode: 'Markdown' })
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

    if (normalized.startsWith('from ')) {
      const accountId = text.slice(5).trim().toLowerCase()
      const accounts = JSON.parse(process.env.EMAIL_ACCOUNTS || '[]')
      const account = accounts.find(a => a.id === accountId || a.label.toLowerCase() === accountId)
      if (!account) {
        await ctx.reply(`Account "${accountId}" not found. Available: ${accounts.map(a => a.id).join(', ')}`)
      } else {
        pending.emailData.accountId = account.id
        pending.emailData.accountLabel = account.label
        await ctx.reply(`Sending from: ${account.label}\n\n*YES* to send · *SKIP* to discard`, { parse_mode: 'Markdown' })
      }
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

// Compose a new email from scratch
async function composeNewEmail(ctx, to, brief) {
  await ctx.reply('Drafting...')

  // If 'to' is a name (no @), look up email in Notion contacts
  let resolvedTo = to
  let contextText = null
  if (!to.includes('@')) {
    const contact = await searchContacts(to).catch(() => null)
    if (contact) {
      if (contact.email) resolvedTo = contact.email
      contextText = `Contact: ${contact.name}, Company: ${contact.company || 'unknown'}, Email: ${contact.email || 'unknown'}`
    }
  } else {
    const recipientName = to.split('@')[0]
    const contact = await searchContacts(recipientName).catch(() => null)
    if (contact) contextText = `Contact: ${contact.name}, Company: ${contact.company || 'unknown'}`
  }

  const { subject, body } = await composeEmail(resolvedTo, brief, contextText)

  const accounts = JSON.parse(process.env.EMAIL_ACCOUNTS || '[]')
  const accountList = accounts.map((a, i) => `*${i + 1}.* ${a.label} (${a.user})`).join('\n')

  await sendApproval(OWNER_ID, {
    type: 'email_compose',
    emailData: {
      from: resolvedTo,
      subject,
      accountId: null,
      accountLabel: null,
      messageId: null,
      references: null
    },
    draft: body,
    awaitingAccount: true
  })

  await ctx.reply(
    `📬 *Draft ready — which account to send from?*\n\n${accountList}\n\nReply with the number.`,
    { parse_mode: 'Markdown' }
  )
}

module.exports = { fetchAndSummarise, showEmailDetails, draftReplyForEmail, composeNewEmail, handleApprovalReply }
