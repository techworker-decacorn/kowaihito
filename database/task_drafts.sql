-- task_draftsテーブルの作成
create table if not exists task_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text,
  due_at timestamptz,
  step text not null check (step in ('ask_title','ask_due')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- インデックスの作成
create index if not exists idx_task_drafts_user on task_drafts(user_id);
