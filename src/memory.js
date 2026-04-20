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
  // Anthropic requires messages to start with 'user' — trim leading assistant messages
  const firstUser = ordered.findIndex(m => m.role === 'user')
  const trimmed = firstUser > 0 ? ordered.slice(firstUser) : ordered
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

module.exports = { getHistory, appendHistory, checkMemoryHealth }
