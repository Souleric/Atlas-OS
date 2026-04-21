#!/usr/bin/env node
// One-shot migration: dump Apple Reminders "Inbox" list into the Notion Reminders DB.
// Run from a real terminal session (not launchd) so macOS TCC can prompt for Reminders access.
//
//   node scripts/migrate-apple-reminders.js            # dry run, prints what would be imported
//   node scripts/migrate-apple-reminders.js --commit   # actually creates pages in Notion
//
// All items land in the "Do It" column by default.

require('dotenv').config()
const { execSync } = require('child_process')
const { addReminder } = require('../src/notion')

const LIST_NAME = process.env.APPLE_REMINDER_LIST || 'Inbox'
const DEFAULT_STATUS = 'Do It'
const COMMIT = process.argv.includes('--commit')

const SEP = '§§§'
const REC_SEP = '¶¶¶'

const SCRIPT = `
set AppleScript's text item delimiters to "${REC_SEP}"
tell application "Reminders"
  set theList to list "${LIST_NAME}"
  set items to every reminder of theList whose completed is false
  set out to {}
  repeat with r in items
    set n to name of r as string
    set bd to ""
    try
      set bd to body of r as string
    end try
    set dueStr to ""
    try
      set dueStr to ((due date of r) as string)
    end try
    set remindStr to ""
    try
      set remindStr to ((remind me date of r) as string)
    end try
    set pri to priority of r as integer
    set end of out to n & "${SEP}" & bd & "${SEP}" & dueStr & "${SEP}" & remindStr & "${SEP}" & pri
  end repeat
  return out as string
end tell
`.trim()

function priorityFromApple(n) {
  // AppleScript priority: 0 none, 1 high, 5 medium, 9 low
  if (n === 1) return 'High'
  if (n === 5) return 'Medium'
  if (n === 9) return 'Low'
  return null
}

function parseAppleDate(str) {
  if (!str) return null
  const d = new Date(str)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function dumpReminders() {
  const out = execSync(`osascript -e ${JSON.stringify(SCRIPT)}`, {
    encoding: 'utf8',
    timeout: 20000,
    killSignal: 'SIGKILL'
  })
  if (!out.trim()) return []
  return out.split(REC_SEP).map(rec => {
    const [name, body, due, remind, priRaw] = rec.split(SEP)
    return {
      name: (name || '').trim(),
      body: (body || '').trim(),
      due: parseAppleDate((due || '').trim()),
      remind: parseAppleDate((remind || '').trim()),
      priority: priorityFromApple(parseInt((priRaw || '0').trim(), 10))
    }
  }).filter(r => r.name)
}

async function run() {
  console.log(`[migrate] Reading Apple Reminders from list "${LIST_NAME}"...`)
  let items
  try {
    items = dumpReminders()
  } catch (err) {
    console.error('[migrate] AppleScript failed:', err.message)
    console.error('  Make sure you are running this in a real Terminal window so macOS can prompt for Reminders access.')
    process.exit(1)
  }

  console.log(`[migrate] Found ${items.length} open reminders.\n`)
  for (const [i, r] of items.entries()) {
    const tags = []
    if (r.due) tags.push(`due ${r.due.slice(0, 10)}`)
    if (r.priority) tags.push(r.priority)
    console.log(`  ${i + 1}. ${r.name}${tags.length ? `  [${tags.join(', ')}]` : ''}`)
    if (r.body) console.log(`     note: ${r.body.slice(0, 120)}`)
  }

  if (!COMMIT) {
    console.log('\n[migrate] Dry run only. Re-run with --commit to create these in Notion.')
    return
  }

  console.log(`\n[migrate] Creating ${items.length} reminders in Notion (status=${DEFAULT_STATUS})...`)
  let ok = 0
  for (const r of items) {
    try {
      await addReminder({
        name: r.name,
        status: DEFAULT_STATUS,
        due: r.due || r.remind || null,
        priority: r.priority,
        notes: r.body || null
      })
      ok++
      process.stdout.write('.')
    } catch (err) {
      process.stdout.write('x')
      console.error(`\n  failed "${r.name}": ${err.message}`)
    }
  }
  console.log(`\n[migrate] Done. Created ${ok}/${items.length}.`)
}

run().catch(err => {
  console.error('[migrate] Fatal:', err)
  process.exit(1)
})
