const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const MAX_HISTORY = 20

async function checkMemoryHealth() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { ok: false, reason: 'SUPABASE_URL or SUPABASE_SERVICE_KEY not set' }
  }
  const { error } = await supabase.from('chat_history').select('id').limit(1)
  if (error) return { ok: false, reason: error.message }
  return { ok: true }
}

async function getHistory(userId) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY)

  if (error) {
    console.error('[memory] getHistory error:', error.message)
    return []
  }

  const ordered = data.reverse()

  // Merge consecutive same-role messages (Anthropic requires strictly alternating roles)
  const merged = []
  for (const msg of ordered) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.content
    } else {
      merged.push({ role: msg.role, content: msg.content })
    }
  }

  // Anthropic requires messages to start with 'user'
  const firstUser = merged.findIndex(m => m.role === 'user')
  const trimmed = firstUser > 0 ? merged.slice(firstUser) : merged
  console.log(`[memory] loaded ${trimmed.length} rows for user ${userId}`)
  return trimmed
}

async function appendHistory(userId, role, content) {
  const { error } = await supabase
    .from('chat_history').insert({ user_id: userId, role, content })

  if (error) {
    console.error('[memory] appendHistory error:', error.message)
  }
}

async function setPendingApproval(userId, action) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const { error } = await supabase.from('pending_approvals')
    .upsert({ user_id: userId, action, expires_at: expiresAt })
  if (error) console.error('[memory] setPendingApproval error:', error.message)
}

async function getPendingApproval(userId) {
  const { data, error } = await supabase.from('pending_approvals')
    .select('action, expires_at')
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  if (new Date(data.expires_at) < new Date()) {
    await clearPendingApproval(userId)
    return null
  }
  return data.action
}

async function clearPendingApproval(userId) {
  const { error } = await supabase.from('pending_approvals').delete().eq('user_id', userId)
  if (error) console.error('[memory] clearPendingApproval error:', error.message)
}

async function saveGroupMessage({ groupId, groupName, sender, body }) {
  const { error } = await supabase
    .from('whatsapp_group_messages')
    .insert({ group_id: groupId, group_name: groupName, sender, body })
  if (error) console.error('[memory] saveGroupMessage error:', error.message)
}

function formatMyt(iso) {
  return new Date(iso).toLocaleTimeString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit'
  })
}

async function getGroupMessagesById(groupId, { limit = 300, sinceHours = 7 * 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('whatsapp_group_messages')
    .select('group_id, group_name, sender, body, received_at')
    .eq('group_id', groupId)
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(limit)
  if (error) { console.error('[memory] getGroupMessagesById error:', error.message); return [] }
  return (data || []).map(r => ({
    groupId: r.group_id,
    groupName: r.group_name,
    sender: r.sender,
    body: r.body,
    time: formatMyt(r.received_at),
    receivedAt: r.received_at
  }))
}

async function getGroupMessagesByName(name, { limit = 200, sinceHours = 72 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('whatsapp_group_messages')
    .select('group_id, group_name, sender, body, received_at')
    .ilike('group_name', `%${name}%`)
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(limit)
  if (error) { console.error('[memory] getGroupMessagesByName error:', error.message); return [] }
  return (data || []).map(r => ({
    groupId: r.group_id,
    groupName: r.group_name,
    sender: r.sender,
    body: r.body,
    time: formatMyt(r.received_at),
    receivedAt: r.received_at
  }))
}

async function getActiveGroupsSince(sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('whatsapp_group_messages')
    .select('group_id, group_name, sender, body, received_at')
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(2000)
  if (error) { console.error('[memory] getActiveGroupsSince error:', error.message); return [] }
  const byId = new Map()
  for (const row of data || []) {
    if (!byId.has(row.group_id)) {
      byId.set(row.group_id, { id: row.group_id, name: row.group_name, messages: [] })
    }
    byId.get(row.group_id).messages.push({
      sender: row.sender, body: row.body, time: formatMyt(row.received_at)
    })
  }
  return [...byId.values()]
}

async function createFollowup({ groupId, groupName, originalText, followUpText, triggerAt }) {
  const { data, error } = await supabase
    .from('whatsapp_followups')
    .insert({
      group_id: groupId,
      group_name: groupName,
      original_text: originalText || null,
      follow_up_text: followUpText,
      trigger_at: triggerAt
    })
    .select()
    .single()
  if (error) { console.error('[memory] createFollowup error:', error.message); return null }
  return data
}

async function getDueFollowups() {
  const { data, error } = await supabase
    .from('whatsapp_followups')
    .select('*')
    .eq('status', 'pending')
    .lte('trigger_at', new Date().toISOString())
    .limit(20)
  if (error) { console.error('[memory] getDueFollowups error:', error.message); return [] }
  return data || []
}

async function getPendingFollowups() {
  const { data, error } = await supabase
    .from('whatsapp_followups')
    .select('*')
    .eq('status', 'pending')
    .order('trigger_at', { ascending: true })
  if (error) { console.error('[memory] getPendingFollowups error:', error.message); return [] }
  return data || []
}

async function markFollowup(id, { status, cancelReason = null, sentAt = null }) {
  const patch = { status }
  if (cancelReason !== null) patch.cancel_reason = cancelReason
  if (sentAt !== null) patch.sent_at = sentAt
  const { error } = await supabase.from('whatsapp_followups').update(patch).eq('id', id)
  if (error) console.error('[memory] markFollowup error:', error.message)
}

async function hasNewMessagesInGroupSince(groupId, sinceIso) {
  const { data, error } = await supabase
    .from('whatsapp_group_messages')
    .select('id')
    .eq('group_id', groupId)
    .gt('received_at', sinceIso)
    .limit(1)
  if (error) { console.error('[memory] hasNewMessagesInGroupSince error:', error.message); return false }
  return (data || []).length > 0
}

module.exports = {
  getHistory, appendHistory, checkMemoryHealth,
  setPendingApproval, getPendingApproval, clearPendingApproval,
  saveGroupMessage, getGroupMessagesByName, getGroupMessagesById, getActiveGroupsSince,
  createFollowup, getDueFollowups, getPendingFollowups, markFollowup, hasNewMessagesInGroupSince
}
