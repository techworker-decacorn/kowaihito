-- profile_contextテーブルの作成
CREATE TABLE IF NOT EXISTS profile_context (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  context_data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_profile_context_user_id ON profile_context(user_id);

-- 更新日時の自動更新トリガー
CREATE TRIGGER update_profile_context_updated_at 
  BEFORE UPDATE ON profile_context 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
