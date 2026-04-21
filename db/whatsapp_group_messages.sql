-- Run this once in the Supabase SQL editor.
-- Persists every WhatsApp group message Atlas sees so she keeps context across restarts.

create table if not exists whatsapp_group_messages (
  id bigserial primary key,
  group_id text not null,
  group_name text not null,
  sender text not null,
  body text not null,
  received_at timestamptz not null default now()
);

create index if not exists idx_wagm_group_id_time on whatsapp_group_messages(group_id, received_at desc);
create index if not exists idx_wagm_name_time on whatsapp_group_messages(group_name, received_at desc);
