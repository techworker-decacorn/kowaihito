-- 交渉セッションテーブル
CREATE TABLE IF NOT EXISTS negotiation_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'agreed', 'cancelled')),
  anchor_price INTEGER NOT NULL DEFAULT 15000,
  soft_floor INTEGER NOT NULL DEFAULT 12900,
  hard_floor INTEGER NOT NULL DEFAULT 9900,
  current_offer INTEGER,
  concessions_used INTEGER NOT NULL DEFAULT 0,
  conditions JSONB,
  final_price INTEGER,
  meta JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- 既存テーブルに列がなければ追加
ALTER TABLE negotiation_sessions ADD COLUMN IF NOT EXISTS soft_floor INTEGER DEFAULT 12900;
ALTER TABLE negotiation_sessions ADD COLUMN IF NOT EXISTS hard_floor INTEGER DEFAULT 9900;
ALTER TABLE negotiation_sessions ADD COLUMN IF NOT EXISTS concessions_used INTEGER DEFAULT 0;
ALTER TABLE negotiation_sessions ADD COLUMN IF NOT EXISTS conditions JSONB;

-- インデックス作成
CREATE INDEX IF NOT EXISTS negotiation_sessions_user_state_idx
  ON negotiation_sessions (user_id, state);

CREATE INDEX IF NOT EXISTS negotiation_sessions_created_at_idx
  ON negotiation_sessions (created_at);

-- 更新日時の自動更新トリガー
CREATE TRIGGER update_negotiation_sessions_updated_at 
  BEFORE UPDATE ON negotiation_sessions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
