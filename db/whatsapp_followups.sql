-- Run this once in the Supabase SQL editor.
-- Stores queued WhatsApp group follow-ups that Atlas sends if no one replies.

create table if not exists whatsapp_followups (
  id bigserial primary key,
  group_id text not null,
  group_name text not null,
  original_text text,
  follow_up_text text not null,
  created_at timestamptz not null default now(),
  trigger_at timestamptz not null,
  status text not null default 'pending',
  cancel_reason text,
  sent_at timestamptz
);

create index if not exists idx_wafu_due on whatsapp_followups(status, trigger_at);
create index if not exists idx_wafu_group on whatsapp_followups(group_id, created_at desc);
