const { Client } = require('@notionhq/client')

const notion = new Client({ auth: process.env.NOTION_TOKEN })

const PROJECTS_DB = process.env.NOTION_PROJECTS_DB_ID || '782b7bf8ff6e406fb1bc949d57ddb2e9'
const CONTACTS_DB = process.env.NOTION_CONTACTS_DB_ID || 'c6100f8aecb64fbc9b200c20d3fb0279'

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

module.exports = {
  getActiveProjects,
  updateProject,
  updateProjectFull,
  appendProjectNote,
  findProjectByName,
  searchContacts,
  logEmailToProject
}
