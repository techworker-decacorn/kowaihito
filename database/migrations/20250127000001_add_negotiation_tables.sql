-- 交渉機能のためのテーブルとカラムを追加

-- profilesにStripe関連列を追加（既にあればskipされます）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_price_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_item_id TEXT;

-- 交渉セッション
CREATE TABLE IF NOT EXISTS negotiation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'open',         -- open / agreed / closed
  anchor_price INTEGER NOT NULL DEFAULT 49800,
  floor_price INTEGER NOT NULL DEFAULT 0,
  current_offer INTEGER,                      -- 現在提示中の価格(円)
  score INTEGER NOT NULL DEFAULT 0,           -- 交渉スコア（単純加点でOK）
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックスを追加
CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_user_id ON negotiation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_state ON negotiation_sessions(state);
CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_created_at ON negotiation_sessions(created_at);

-- 更新日時の自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_negotiation_sessions_updated_at 
    BEFORE UPDATE ON negotiation_sessions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
