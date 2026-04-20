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

module.exports = { getHistory, appendHistory, checkMemoryHealth, setPendingApproval, getPendingApproval, clearPendingApproval }
