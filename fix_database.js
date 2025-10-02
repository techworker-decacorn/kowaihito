#!/usr/bin/env node

/**
 * データベース修正スクリプト
 * 
 * 使用方法:
 * 1. SupabaseダッシュボードのSQL Editorを開く
 * 2. このスクリプトの出力をコピーして実行
 */

console.log('=== データベース修正用SQL ===');
console.log('');
console.log('以下のSQLをSupabaseダッシュボードのSQL Editorで実行してください:');
console.log('');
console.log('--' + '='.repeat(50));
console.log('');

console.log(`
-- メモリ機能用テーブルを作成
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
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_profile_memories_user_key
  on profile_memories (user_id, key);

create index if not exists idx_profile_memories_user_weight
  on profile_memories (user_id, weight desc, updated_at desc);

-- テーブル作成確認
select 'chat_messages' as table_name, count(*) as row_count from chat_messages
union all
select 'chat_summaries' as table_name, count(*) as row_count from chat_summaries
union all
select 'profile_memories' as table_name, count(*) as row_count from profile_memories;
`);

console.log('');
console.log('--' + '='.repeat(50));
console.log('');
console.log('実行後、以下のコマンドで動作確認ができます:');
console.log('');
console.log('1. LINE Botにメッセージを送信');
console.log('2. メモ一覧: "メモ一覧"');
console.log('3. メモ追加: "メモ: 好み=厳しめ"');
console.log('4. メモ削除: "メモ削除 好み"');
console.log('');
console.log('=== データベース修正完了 ===');
