const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

async function createProfileContextTable() {
  console.log('=== Creating profile_context table ===');
  
  try {
    // テーブル作成SQL
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS profile_context (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
        context_data JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `;
    
    // インデックス作成SQL
    const createIndexSQL = `
      CREATE INDEX IF NOT EXISTS idx_profile_context_user_id ON profile_context(user_id);
    `;
    
    // トリガー作成SQL
    const createTriggerSQL = `
      CREATE TRIGGER update_profile_context_updated_at 
        BEFORE UPDATE ON profile_context 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;
    
    console.log('Creating table...');
    const { error: tableError } = await supabase.rpc('exec', { sql: createTableSQL });
    if (tableError) {
      console.error('Table creation error:', tableError);
    } else {
      console.log('✅ Table created successfully');
    }
    
    console.log('Creating index...');
    const { error: indexError } = await supabase.rpc('exec', { sql: createIndexSQL });
    if (indexError) {
      console.error('Index creation error:', indexError);
    } else {
      console.log('✅ Index created successfully');
    }
    
    console.log('Creating trigger...');
    const { error: triggerError } = await supabase.rpc('exec', { sql: createTriggerSQL });
    if (triggerError) {
      console.error('Trigger creation error:', triggerError);
    } else {
      console.log('✅ Trigger created successfully');
    }
    
    // テーブルの存在確認
    console.log('Verifying table creation...');
    const { data: tables, error: checkError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'profile_context');
    
    if (checkError) {
      console.error('Table verification error:', checkError);
    } else {
      console.log('✅ Table verification:', tables.length > 0 ? 'EXISTS' : 'NOT FOUND');
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  }
}

createProfileContextTable();
