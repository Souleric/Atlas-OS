const {
  getReminders,
  getRemindersByStatus,
  getRemindersDueToday,
  findReminderByName,
  addReminder,
  updateReminder,
  completeReminder,
  deleteReminder,
  REMINDER_STATUSES,
  normalizeStatus,
  normalizePriority
} = require('./notion')

const MYT = 'Asia/Kuala_Lumpur'

function formatDue(due, hasTime) {
  if (!due) return null
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return due
  const opts = { timeZone: MYT, day: 'numeric', month: 'short' }
  const base = d.toLocaleDateString('en-MY', opts)
  if (!hasTime) return base
  const time = d.toLocaleTimeString('en-MY', { timeZone: MYT, hour: 'numeric', minute: '2-digit' })
  return `${base} ${time}`
}

function formatReminder(r) {
  const dueStr = r.due ? ` (due ${formatDue(r.due, r.dueHasTime)})` : ''
  const pri = r.priority === 'High' ? ' 🔴' : r.priority === 'Medium' ? ' 🟡' : ''
  return `  - ${r.name}${pri}${dueStr}`
}

function formatGrouped(reminders) {
  if (!reminders || reminders.length === 0) return 'No pending reminders.'
  const grouped = {}
  for (const status of REMINDER_STATUSES) grouped[status] = []
  for (const r of reminders) {
    const bucket = grouped[r.status] || grouped['Do It']
    bucket.push(r)
  }
  const lines = []
  for (const status of REMINDER_STATUSES) {
    if (status === 'Done') continue
    const items = grouped[status]
    if (!items || items.length === 0) continue
    lines.push(`${status}:`)
    for (const r of items) lines.push(formatReminder(r))
  }
  return lines.join('\n')
}

async function getRemindersForBriefing() {
  const [all, dueToday] = await Promise.all([
    getRemindersByStatus('Do It'),
    getRemindersDueToday()
  ])
  const seen = new Set(all.map(r => r.id))
  const combined = [...all]
  for (const r of dueToday) {
    if (!seen.has(r.id)) combined.push(r)
  }
  if (combined.length === 0) return 'No active reminders.'
  return formatGrouped(combined)
}

module.exports = {
  // read
  getReminders,
  getRemindersByStatus,
  getRemindersDueToday,
  getRemindersForBriefing,
  findReminderByName,
  // mutate
  addReminder,
  updateReminder,
  completeReminder,
  deleteReminder,
  // format
  formatReminder,
  formatGrouped,
  formatDue,
  // constants / helpers
  REMINDER_STATUSES,
  normalizeStatus,
  normalizePriority
}
