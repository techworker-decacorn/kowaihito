#!/usr/bin/env node

/**
 * Supabaseマイグレーション実行スクリプト
 * 
 * 使用方法:
 * 1. SupabaseダッシュボードのSQL Editorを開く
 * 2. このスクリプトの出力をコピーして実行
 */

const fs = require('fs');

console.log('=== Supabaseマイグレーション実行用SQL ===');
console.log('');
console.log('以下のSQLをSupabaseダッシュボードのSQL Editorで実行してください:');
console.log('');
console.log('--' + '='.repeat(50));
console.log('');

// マイグレーションファイルを読み込み
const migrationSQL = fs.readFileSync('./database/migrations/20250127000000_add_memory_tables.sql', 'utf8');

console.log(migrationSQL);

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
console.log('=== マイグレーション完了 ===');
