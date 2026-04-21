const { sendApproval, OWNER_ID, setPending, getPending, clearPending } = require('../bot')
const { getActiveProjects, createProject, updateProject, updateProjectFull, appendProjectNote, findProjectByName } = require('../notion')

async function executeNotionUpdate(pending) {
  const { updateType, pageId, updateData } = pending
  if (updateType === 'status') return updateProject(pageId, { status: updateData.status })
  if (updateType === 'note') return appendProjectNote(pageId, updateData.note)
  if (updateType === 'full') return updateProjectFull(pageId, updateData)
  throw new Error(`Unknown updateType: ${updateType}`)
}
const { parseProjectUpdate } = require('../ai')

async function handleGetProjects(ctx) {
  const projects = await getActiveProjects()

  if (projects.length === 0) {
    return ctx.reply('No active projects found in Notion.')
  }

  const priorityEmoji = { P0: '🔴', P1: '🟠', P2: '🟡' }
  const statusEmoji = { 'In progress': '🔵', 'Not started': '⚪', Done: '✅' }

  const lines = projects.map(p => {
    const pe = priorityEmoji[p.priority] || '⚫'
    const se = statusEmoji[p.status] || '⚫'
    const nextAction = p.nextAction ? `\n  → ${p.nextAction}` : ''
    return `${pe} ${se} *${p.name}*${p.client ? ` (${p.client})` : ''}${nextAction}`
  })

  await ctx.reply(`*Active Projects*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' })
}

async function handleUpdateProject(ctx, projectName, newStatus) {
  const project = await findProjectByName(projectName)

  if (!project) {
    return ctx.reply(`Project "${projectName}" not found in Notion.`)
  }

  await sendApproval(OWNER_ID, {
    type: 'notion_update',
    projectName: project.name,
    field: 'Status',
    value: newStatus,
    updateType: 'status',
    pageId: project.id,
    updateData: { status: newStatus }
  })
}

async function handleAddNote(ctx, projectName, note) {
  const project = await findProjectByName(projectName)

  if (!project) {
    return ctx.reply(`Project "${projectName}" not found in Notion.`)
  }

  await sendApproval(OWNER_ID, {
    type: 'notion_update',
    projectName: project.name,
    field: 'Note',
    value: note.slice(0, 60) + (note.length > 60 ? '...' : ''),
    updateType: 'note',
    pageId: project.id,
    updateData: { note }
  })
}

async function handleProgressUpdate(ctx, text) {
  const update = await parseProjectUpdate(text)

  if (!update.projectName) {
    return ctx.reply('Which project? e.g. "update Atlas OS: finished email module, status In Progress"')
  }

  const project = await findProjectByName(update.projectName)
  if (!project) {
    return ctx.reply(`Project "${update.projectName}" not found in Notion.`)
  }

  // Build confirmation summary
  const changes = []
  if (update.status) changes.push(`Status → *${update.status}*`)
  if (update.nextAction) changes.push(`Next action → ${update.nextAction}`)
  if (update.note) changes.push(`Note: "${update.note}"`)

  if (changes.length === 0) {
    return ctx.reply('Nothing to update. Try: "update [project]: status In Progress, next action Deploy to Railway, note: finished email module"')
  }

  const confirmMsg = `📋 *Update for ${project.name}*\n\n${changes.join('\n')}\n\nReply *YES* to save · *NO* to cancel`

  await sendApproval(OWNER_ID, {
    type: 'notion_update',
    projectName: project.name,
    field: 'progress',
    value: changes.join(', '),
    updateType: 'full',
    pageId: project.id,
    updateData: update
  })
}

async function handleAddProject(ctx, name) {
  const userId = ctx.from.id
  await setPending(userId, { type: 'project_create', step: 'priority', data: { name } })
  await ctx.reply(`New project: *${name}*\n\nPriority? Reply *P0* (urgent), *P1* (high), or *P2* (normal)`, { parse_mode: 'Markdown' })
}

async function handleProjectCreateStep(ctx, text) {
  const userId = ctx.from.id
  const pending = await getPending(userId)
  if (!pending || pending.type !== 'project_create') return false

  const val = text.trim()
  const skip = val.toLowerCase() === 'skip' || val === '-'

  if (pending.step === 'priority') {
    const priority = ['P0','P1','P2'].includes(val.toUpperCase()) ? val.toUpperCase() : 'P2'
    pending.data.priority = priority
    pending.step = 'client'
    await setPending(userId, pending)
    await ctx.reply('Client name? (or *skip*)', { parse_mode: 'Markdown' })
    return true
  }

  if (pending.step === 'client') {
    pending.data.client = skip ? null : val
    pending.step = 'next_action'
    await setPending(userId, pending)
    await ctx.reply('First next action? (or *skip*)', { parse_mode: 'Markdown' })
    return true
  }

  if (pending.step === 'next_action') {
    pending.data.nextAction = skip ? null : val
    pending.step = 'confirm'
    await setPending(userId, pending)
    const { name, priority, client, nextAction } = pending.data
    const lines = [`*${name}*`, `Priority: ${priority}`]
    if (client) lines.push(`Client: ${client}`)
    if (nextAction) lines.push(`Next action: ${nextAction}`)
    await ctx.reply(`📋 Create project:\n\n${lines.join('\n')}\n\nReply *YES* to create · *NO* to cancel`, { parse_mode: 'Markdown' })
    return true
  }

  if (pending.step === 'confirm') {
    if (val.toLowerCase() === 'yes') {
      try {
        await createProject(pending.data)
        await ctx.reply(`Project "${pending.data.name}" created in Notion.`)
      } catch (err) {
        await ctx.reply(`Failed to create project: ${err.message}`)
      }
    } else {
      await ctx.reply('Cancelled.')
    }
    await clearPending(userId)
    return true
  }

  return false
}

module.exports = { handleGetProjects, handleUpdateProject, handleAddNote, handleProgressUpdate, executeNotionUpdate, handleAddProject, handleProjectCreateStep }
