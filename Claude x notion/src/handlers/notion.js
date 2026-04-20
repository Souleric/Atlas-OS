const { sendApproval, OWNER_ID } = require('../bot')
const { getActiveProjects, updateProject, updateProjectFull, appendProjectNote, findProjectByName } = require('../notion')
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
    updateFn: () => updateProject(project.id, { status: newStatus })
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
    updateFn: () => appendProjectNote(project.id, note)
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
    updateFn: () => updateProjectFull(project.id, update)
  })
}

module.exports = { handleGetProjects, handleUpdateProject, handleAddNote, handleProgressUpdate }
