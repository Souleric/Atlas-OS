const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const nodemailer = require('nodemailer')

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

  // Prevent unhandled 'error' events from crashing the process
  client.on('error', err => {
    console.error(`[email] IMAP socket error (${account.label}):`, err.message)
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
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    requireTLS: account.smtpPort === 587,
    auth: { user: account.user, pass: account.pass },
    tls: { rejectUnauthorized: true }
  })

  await transporter.verify()

  const mailOptions = {
    from: `${account.label} <${account.user}>`,
    to,
    subject,
    text: body
  }

  if (cc) mailOptions.cc = cc
  if (bcc) mailOptions.bcc = bcc
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo
  if (references) mailOptions.references = Array.isArray(references) ? references.join(' ') : references

  const info = await transporter.sendMail(mailOptions)
  console.log(`[email] Sent to ${to} via ${account.label} — messageId: ${info.messageId}`)
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
