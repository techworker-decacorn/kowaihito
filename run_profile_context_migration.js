const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

async function runMigration() {
  console.log('=== Running profile_context table migration ===');
  
  try {
    // マイグレーションSQLを読み込み
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.join(__dirname, 'database/migrations/20250127000003_create_profile_context_table.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Migration SQL:', migrationSQL);
    
    // SQLを実行
    const { data, error } = await supabase.rpc('exec_sql', { sql: migrationSQL });
    
    if (error) {
      console.error('Migration error:', error);
      return;
    }
    
    console.log('Migration completed successfully:', data);
    
    // テーブルの存在確認
    const { data: tables, error: tableError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'profile_context');
    
    if (tableError) {
      console.error('Table check error:', tableError);
    } else {
      console.log('Table exists:', tables.length > 0);
    }
    
  } catch (error) {
    console.error('Migration failed:', error);
  }
}

runMigration();
