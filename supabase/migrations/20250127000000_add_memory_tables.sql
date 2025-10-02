-- 短期記憶（発話ログ）
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  role text check (role in ('user','assistant','system')) not null,
  content text not null,
  tokens int,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_user_created
  on chat_messages (user_id, created_at desc);

-- 長期要約（ローリング要約）
create table if not exists chat_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  summary text not null,
  last_message_created_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_summaries_user_created
  on chat_summaries (user_id, created_at desc);

-- 事実メモ（恒久メモ）
create table if not exists profile_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  key text not null,
  value text not null,
  category text check (category in ('preference','profile','constraint','todo')) default 'preference',
  weight int default 1,
  expires_at timestamptz, -- 任意: 期限付きメモ
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_profile_memories_user_key
  on profile_memories (user_id, key);
create index if not exists idx_profile_memories_user_weight
  on profile_memories (user_id, weight desc, updated_at desc);
