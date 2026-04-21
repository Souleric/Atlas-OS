const { Client } = require('@notionhq/client')

const notion = new Client({ auth: process.env.NOTION_TOKEN })

const PROJECTS_DB = process.env.NOTION_PROJECTS_DB_ID || '782b7bf8ff6e406fb1bc949d57ddb2e9'
const CONTACTS_DB = process.env.NOTION_CONTACTS_DB_ID || 'c6100f8aecb64fbc9b200c20d3fb0279'
const REMINDERS_DB = process.env.NOTION_REMINDERS_DB_ID || '349faedb-e138-81ee-b769-c520686c170e'

const REMINDER_STATUSES = ['Do It', 'Follow up', 'Schedule It', 'Delegate It', 'Do It later', 'Done']

function normalizeStatus(status) {
  if (!status) return null
  const s = String(status).toLowerCase().replace(/[-_]/g, ' ').trim()
  const map = {
    'do it': 'Do It',
    'do': 'Do It',
    'follow up': 'Follow up',
    'followup': 'Follow up',
    'schedule it': 'Schedule It',
    'schedule': 'Schedule It',
    'scheduled': 'Schedule It',
    'delegate it': 'Delegate It',
    'delegate': 'Delegate It',
    'do it later': 'Do It later',
    'later': 'Do It later',
    'done': 'Done',
    'complete': 'Done',
    'completed': 'Done'
  }
  return map[s] || null
}

function normalizePriority(p) {
  if (!p) return null
  const s = String(p).toLowerCase().trim()
  if (s === 'high' || s === 'h' || s === '!' || s === 'urgent') return 'High'
  if (s === 'medium' || s === 'med' || s === 'm' || s === 'normal') return 'Medium'
  if (s === 'low' || s === 'l') return 'Low'
  return null
}

function reminderFromPage(page) {
  const p = page.properties
  const status = p.Status?.select?.name || null
  const due = p.Due?.date?.start || null
  const dueHasTime = due && due.includes('T')
  return {
    id: page.id,
    name: p.Name?.title?.[0]?.plain_text || 'Untitled',
    status,
    due,
    dueHasTime,
    priority: p.Priority?.select?.name || null,
    tags: (p.Tags?.multi_select || []).map(t => t.name),
    notes: p.Notes?.rich_text?.[0]?.plain_text || null,
    url: page.url
  }
}

async function getReminders({ includeDone = false } = {}) {
  const filter = includeDone
    ? undefined
    : { property: 'Status', select: { does_not_equal: 'Done' } }
  const response = await notion.databases.query({
    database_id: REMINDERS_DB,
    ...(filter ? { filter } : {}),
    sorts: [{ property: 'Due', direction: 'ascending' }]
  })
  return response.results.map(reminderFromPage)
}

async function getRemindersByStatus(status) {
  const normalized = normalizeStatus(status)
  if (!normalized) return []
  const response = await notion.databases.query({
    database_id: REMINDERS_DB,
    filter: { property: 'Status', select: { equals: normalized } },
    sorts: [{ property: 'Due', direction: 'ascending' }]
  })
  return response.results.map(reminderFromPage)
}

async function getRemindersDueToday() {
  const now = new Date()
  const todayYmd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })
  const response = await notion.databases.query({
    database_id: REMINDERS_DB,
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Due', date: { equals: todayYmd } }
      ]
    },
    sorts: [{ property: 'Due', direction: 'ascending' }]
  })
  return response.results.map(reminderFromPage)
}

async function findReminderByName(name) {
  const response = await notion.databases.query({
    database_id: REMINDERS_DB,
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Name', title: { contains: name } }
      ]
    }
  })
  if (response.results.length === 0) return null
  return reminderFromPage(response.results[0])
}

async function addReminder({ name, status = 'Do It', due = null, priority = null, tags = null, notes = null }) {
  const normalizedStatus = normalizeStatus(status) || 'Do It'
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { select: { name: normalizedStatus } }
  }
  if (due) properties['Due'] = { date: { start: due } }
  const normalizedPriority = normalizePriority(priority)
  if (normalizedPriority) properties['Priority'] = { select: { name: normalizedPriority } }
  if (tags && tags.length > 0) properties['Tags'] = { multi_select: tags.map(t => ({ name: t })) }
  if (notes) properties['Notes'] = { rich_text: [{ text: { content: notes } }] }

  const page = await notion.pages.create({
    parent: { database_id: REMINDERS_DB },
    properties
  })
  return reminderFromPage(page)
}

async function updateReminder(pageId, fields) {
  const properties = {}
  if (fields.name) properties['Name'] = { title: [{ text: { content: fields.name } }] }
  if (fields.status) {
    const s = normalizeStatus(fields.status)
    if (s) properties['Status'] = { select: { name: s } }
  }
  if (fields.due !== undefined) {
    properties['Due'] = fields.due ? { date: { start: fields.due } } : { date: null }
  }
  if (fields.priority !== undefined) {
    const p = normalizePriority(fields.priority)
    properties['Priority'] = p ? { select: { name: p } } : { select: null }
  }
  if (fields.tags !== undefined) {
    properties['Tags'] = { multi_select: (fields.tags || []).map(t => ({ name: t })) }
  }
  if (fields.notes !== undefined) {
    properties['Notes'] = fields.notes
      ? { rich_text: [{ text: { content: fields.notes } }] }
      : { rich_text: [] }
  }
  await notion.pages.update({ page_id: pageId, properties })
}

async function completeReminder(pageId) {
  await updateReminder(pageId, { status: 'Done' })
}

async function deleteReminder(pageId) {
  await notion.pages.update({ page_id: pageId, archived: true })
}

async function getActiveProjects() {
  const response = await notion.databases.query({
    database_id: PROJECTS_DB,
    filter: {
      property: 'Status',
      status: { does_not_equal: 'Done' }
    },
    sorts: [{ property: 'Priority', direction: 'ascending' }]
  })

  return response.results.map(page => ({
    id: page.id,
    name: page.properties.Project?.title?.[0]?.plain_text || 'Untitled',
    status: page.properties.Status?.status?.name || 'Unknown',
    priority: page.properties.Priority?.select?.name || null,
    client: page.properties.Client?.rich_text?.[0]?.plain_text || null,
    company: page.properties.Company?.select?.name || null,
    nextAction: page.properties['Next Action']?.rich_text?.[0]?.plain_text || null,
    billingStatus: page.properties['Billing Status']?.select?.name || null,
    url: page.url
  }))
}

async function updateProject(pageId, fields) {
  const properties = {}

  if (fields.status) {
    properties['Status'] = { status: { name: fields.status } }
  }

  if (fields.nextAction !== undefined) {
    properties['Next Action'] = {
      rich_text: fields.nextAction ? [{ text: { content: fields.nextAction } }] : []
    }
  }

  if (fields.billingStatus) {
    properties['Billing Status'] = { select: { name: fields.billingStatus } }
  }

  await notion.pages.update({ page_id: pageId, properties })
}

async function appendProjectNote(pageId, text) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: 'callout',
        callout: {
          rich_text: [{ text: { content: text } }],
          icon: { emoji: '📝' },
          color: 'gray_background'
        }
      },
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              text: { content: `— Atlas, ${new Date().toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}` },
              annotations: { italic: true, color: 'gray' }
            }
          ]
        }
      }
    ]
  })
}

async function findProjectByName(name) {
  const response = await notion.databases.query({
    database_id: PROJECTS_DB,
    filter: {
      property: 'Project',
      title: { contains: name }
    }
  })

  if (response.results.length === 0) return null

  const page = response.results[0]
  return {
    id: page.id,
    name: page.properties.Project?.title?.[0]?.plain_text || 'Untitled',
    status: page.properties.Status?.status?.name || 'Unknown',
    nextAction: page.properties['Next Action']?.rich_text?.[0]?.plain_text || null,
    url: page.url
  }
}

async function searchContacts(name) {
  const response = await notion.databases.query({
    database_id: CONTACTS_DB,
    filter: {
      property: 'Name',
      title: { contains: name }
    }
  })

  if (response.results.length === 0) return null

  const page = response.results[0]
  const props = page.properties
  return {
    id: page.id,
    name: props.Name?.title?.[0]?.plain_text || name,
    company: props.Company?.rich_text?.[0]?.plain_text || null,
    email: props.Email?.email || null,
    notes: props.Notes?.rich_text?.[0]?.plain_text || null
  }
}

// Update multiple fields at once
async function updateProjectFull(pageId, { status, nextAction, note }) {
  if (status || nextAction !== undefined) {
    await updateProject(pageId, { status, nextAction })
  }
  if (note) {
    await appendProjectNote(pageId, note)
  }
}

// Append an email summary as a note to a project
async function logEmailToProject(pageId, emailData, summary) {
  const text = `Email from ${emailData.from}\nSubject: ${emailData.subject}\n\n${summary}`
  await appendProjectNote(pageId, text)
}

async function createProject({ name, status = 'Not started', priority = 'P2', client = null, company = null, nextAction = null }) {
  const properties = {
    Project: { title: [{ text: { content: name } }] },
    Status: { status: { name: status } },
    Priority: { select: { name: priority } }
  }
  if (client) properties['Client'] = { rich_text: [{ text: { content: client } }] }
  if (company) properties['Company'] = { select: { name: company } }
  if (nextAction) properties['Next Action'] = { rich_text: [{ text: { content: nextAction } }] }

  const page = await notion.pages.create({ parent: { database_id: PROJECTS_DB }, properties })
  return page.id
}

module.exports = {
  getActiveProjects,
  createProject,
  updateProject,
  updateProjectFull,
  appendProjectNote,
  findProjectByName,
  searchContacts,
  logEmailToProject,
  getReminders,
  getRemindersByStatus,
  getRemindersDueToday,
  findReminderByName,
  addReminder,
  updateReminder,
  completeReminder,
  deleteReminder,
  REMINDER_STATUSES,
  normalizeStatus: normalizeStatus,
  normalizePriority: normalizePriority
}
