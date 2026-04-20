const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const { Resend } = require('resend')

// Load accounts from env: JSON array of account configs
function loadAccounts() {
  try {
    return JSON.parse(process.env.EMAIL_ACCOUNTS || '[]')
  } catch {
    console.error('[email] Failed to parse EMAIL_ACCOUNTS env var')
    return []
  }
}

// Track last-checked time per account (resets on restart — acceptable for personal use)
const lastChecked = new Map()

// Max emails to process per account per poll (prevents rate limit floods)
const MAX_PER_POLL = 5

async function fetchNewEmails(account) {
  const since = lastChecked.get(account.id) || new Date(Date.now() - 60 * 60 * 1000) // default: last hour on first run
  lastChecked.set(account.id, new Date())

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false
  })

  const emails = []

  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    const allUids = await client.search({ seen: false, since }, { uid: true })
    if (allUids.length === 0) return emails

    // Cap to most recent MAX_PER_POLL to avoid rate limit floods
    const uids = allUids.slice(-MAX_PER_POLL)
    if (allUids.length > MAX_PER_POLL) {
      console.log(`[email] ${account.label}: ${allUids.length} unread, processing latest ${MAX_PER_POLL}`)
    }

    for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
      try {
        const parsed = await simpleParser(msg.source)
        emails.push({
          uid: msg.uid,
          accountId: account.id,
          accountLabel: account.label,
          from: parsed.from?.text || msg.envelope.from?.[0]?.address || 'unknown',
          to: parsed.to?.text || '',
          subject: parsed.subject || '(no subject)',
          date: parsed.date?.toISOString() || new Date().toISOString(),
          body: parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '',
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references
        })
      } catch (parseErr) {
        console.error(`[email] Failed to parse message uid=${msg.uid}:`, parseErr.message)
      }
    }

    await client.logout()
  } catch (err) {
    console.error(`[email] IMAP error for ${account.label}:`, err.message)
    try { await client.logout() } catch {}
  }

  return emails
}

async function sendEmail(account, { to, subject, body, cc, bcc, inReplyTo, references }) {
  const resend = new Resend(process.env.RESEND_API_KEY)

  // RESEND_FROM must be a verified domain address (e.g. atlas@betasocial.my)
  // If account.user differs (e.g. gmail), set reply_to so replies go to the right inbox
  const fromAddress = process.env.RESEND_FROM || account.user
  const payload = {
    from: `${account.label} <${fromAddress}>`,
    to: [to],
    subject,
    text: body
  }

  if (account.user !== fromAddress) payload.reply_to = account.user
  if (cc) payload.cc = [cc]
  if (bcc) payload.bcc = [bcc]

  const headers = {}
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo
  if (references) headers['References'] = Array.isArray(references) ? references.join(' ') : references
  if (Object.keys(headers).length) payload.headers = headers

  const { data, error } = await resend.emails.send(payload)
  if (error) throw new Error(error.message)
  console.log(`[email] Sent to ${to} via Resend (${account.label}) — id: ${data.id}`)
}

// Poll all accounts for new emails. Calls onNewEmail(email) for each.
function startPolling(onNewEmail, intervalMs = 5 * 60 * 1000) {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    console.warn('[email] No accounts configured. Set EMAIL_ACCOUNTS in .env')
    return
  }

  console.log(`[email] Polling ${accounts.length} account(s) every ${intervalMs / 1000}s`)

  const poll = async () => {
    for (const account of accounts) {
      const emails = await fetchNewEmails(account)
      for (const email of emails) {
        await onNewEmail(email)
        await delay(2000) // 2s between each email to stay under rate limits
      }
    }
  }

  // Run immediately on start, then on interval
  poll()
  setInterval(poll, intervalMs)
}

// Delay helper for sequential processing
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// One-off manual check — returns all new emails across all accounts
async function checkNow() {
  const accounts = loadAccounts()
  const all = []
  for (const account of accounts) {
    const emails = await fetchNewEmails(account)
    all.push(...emails)
  }
  return all
}

function getAccountById(id) {
  return loadAccounts().find(a => a.id === id) || null
}

module.exports = { startPolling, checkNow, sendEmail, getAccountById }
