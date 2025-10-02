const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const Stripe = require('stripe');
const chrono = require('chrono-node');
const axios = require('axios');
require('dayjs/locale/ja');
require('dotenv').config();

// dayjs設定
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');
dayjs.locale('ja');

const app = express();
const PORT = process.env.PORT || 3000;

// 静的ファイル配信の設定
app.use('/legal', express.static('public/legal'));

// デバッグ用：静的ファイルの存在確認
app.get('/debug/legal', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  
  const termsPath = path.join(__dirname, '../public/legal/terms.html');
  const privacyPath = path.join(__dirname, '../public/legal/privacy.html');
  
  res.json({
    termsExists: fs.existsSync(termsPath),
    privacyExists: fs.existsSync(privacyPath),
    termsPath: termsPath,
    privacyPath: privacyPath,
    currentDir: __dirname,
    publicDir: path.join(__dirname, '../public'),
    legalDir: path.join(__dirname, '../public/legal')
  });
});

// LINE Bot設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// デバッグ用ログ
console.log('=== Environment Variables Debug ===');
console.log('Channel Access Token length:', process.env.LINE_CHANNEL_ACCESS_TOKEN?.length);
console.log('Channel Secret length:', process.env.LINE_CHANNEL_SECRET?.length);
console.log('OpenAI API Key length:', process.env.OPENAI_API_KEY?.length);
console.log('Supabase URL:', process.env.SUPABASE_URL);
console.log('Supabase Service Role length:', process.env.SUPABASE_SERVICE_ROLE?.length);
console.log('[ENV RAW] CHECKOUT_BASE_URL bytes:', Array.from((process.env.CHECKOUT_BASE_URL||'')).map(c=>c.charCodeAt(0)));
console.log('[ENV RAW] VERCEL_URL bytes:', Array.from((process.env.VERCEL_URL||'')).map(c=>c.charCodeAt(0)));
console.log('=====================================');

// OpenAI設定
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Supabase設定
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Stripe設定
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// LINE Botクライアント
const client = new line.Client(config);

// Vercel用のミドルウェア設定
// Stripe Webhook用のrawボディパーサーを先に適用
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// その他のルート用のJSONボディパーサー
app.use(express.json());

// ヘルパー関数

// ==== 共通ユーティリティ ====
function roughTokens(s=''){ return Math.ceil((s||'').length / 3); }

// ==== 短期記憶（発話ログ） ====
async function saveChatBatch(userId, turns) {
  if (!turns?.length) return;
  const rows = turns.map(t => ({
    user_id: userId,
    role: t.role,
    content: t.content,
    tokens: roughTokens(t.content)
  }));
  await supabase.from('chat_messages').insert(rows);
}

async function fetchContextMessages(userId, budget = 3500, systemPrompt = '', currentUserText = '') {
  const sys = roughTokens(systemPrompt);
  const cur = roughTokens(currentUserText);
  const max = Math.max(1000, budget - sys - cur);

  const { data: rows } = await supabase
    .from('chat_messages')
    .select('role, content, created_at, tokens')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(60);

  if (!rows?.length) return [];

  let used = 0, picked = [];
  for (const r of rows) {
    const t = r.tokens ?? roughTokens(r.content);
    if (used + t > max) break;
    picked.push({ role: r.role, content: r.content });
    used += t;
  }
  return picked.reverse();
}

// ==== 長期要約 ====
async function fetchLatestSummary(userId) {
  const { data } = await supabase
    .from('chat_summaries')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function maybeSummarize(userId) {
  const last = await fetchLatestSummary(userId);
  const since = last?.last_message_created_at || '1970-01-01T00:00:00Z';

  const { data: rows } = await supabase
    .from('chat_messages')
    .select('role, content, created_at, tokens')
    .eq('user_id', userId)
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(250);

  if (!rows?.length) return;

  const total = rows.reduce((s,r)=> s + (r.tokens ?? roughTokens(r.content)), 0);
  // 閾値はお好みで調整
  if (total < 1500 && rows.length < 20) return;

  const logText = rows.map(r => `${r.role==='user'?'ユーザー':'アシスタント'}: ${r.content}`).join('\n');
  const prompt = `次の会話ログを300〜500字で日本語要約。以下の見出しで簡潔に:
- ユーザーの設定/好み/禁止事項
- 進行中のタスク/決定事項
- 直近の話題の要点
- 口癖/トーン
----
${logText}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "あなたは対話ログの要約器です。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 650,
  });

  const summary = resp.choices?.[0]?.message?.content?.trim();
  const lastCreatedAt = rows[rows.length - 1]?.created_at;
  if (!summary || !lastCreatedAt) return;

  await supabase.from('chat_summaries').insert({
    user_id: userId,
    summary,
    last_message_created_at: lastCreatedAt
  });
}

// ==== 事実メモ（恒久メモ） ====
async function upsertMemory(userId, { key, value, category='preference', weight=1, ttl_days=null }) {
  const expires_at = ttl_days ? new Date(Date.now() + ttl_days*86400*1000).toISOString() : null;
  const { data: existed } = await supabase
    .from('profile_memories')
    .select('id, weight')
    .eq('user_id', userId)
    .eq('key', key)
    .maybeSingle();

  if (existed) {
    await supabase.from('profile_memories')
      .update({ value, category, weight: Math.max(weight, existed.weight), expires_at, updated_at: new Date().toISOString() })
      .eq('id', existed.id);
  } else {
    await supabase.from('profile_memories')
      .insert({ user_id: userId, key, value, category, weight, expires_at });
  }
}

async function fetchTopMemories(userId, limit=10) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('profile_memories')
    .select('key, value, category, weight, updated_at, expires_at')
    .eq('user_id', userId)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('weight', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  return data || [];
}

function safeParseJSON(s){
  try { return JSON.parse(s); } catch { return null; }
}

// 会話から「長期的に役立つ」事実を抽出して profile_memories にUpsert
async function maybeExtractMemories(userId, { userText, assistantText }) {
  const extractionPrompt = `
以下の会話断片から、長期的に再利用できる事実メモを抽出してください。
特に以下の情報を重視してください：

【重要度の高いメモ】
- ユーザーの失敗・怠惰・甘えのパターン
- 言い訳や責任転嫁の傾向
- 改善が必要な行動パターン
- 過去の失敗事例や問題行動

【一般的なメモ】
- 好み/NG、プロフ情報（所属/肩書/住まい等）
- 制約（転勤NG/平日22時以降は難しい等）
- よく出るTODOの定型

【除外するもの】
- 一時的/曖昧/感想
- 単純な挨拶や雑談

JSON配列のみで出力:
[
  {"key":"失敗パターン","value":"締切を守らない傾向","category":"constraint","weight":5,"ttl_days":365},
  {"key":"言い訳","value":"忙しいを理由にする","category":"constraint","weight":4,"ttl_days":365},
  {"key":"仕事の拠点","value":"東京のみ希望","category":"constraint","weight":3,"ttl_days":365}
]
会話:
ユーザー: ${userText}
アシスタント: ${assistantText}
  `.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role:"system", content:"あなたは情報抽出器です。必ず有効なJSONのみ出力。" },
               { role:"user", content: extractionPrompt }],
    temperature: 0.0,
    max_tokens: 400
  });

  const json = safeParseJSON(resp.choices?.[0]?.message?.content || '[]') || [];
  if (!Array.isArray(json) || !json.length) return;

  for (const it of json) {
    if (!it?.key || !it?.value) continue;
    await upsertMemory(userId, {
      key: String(it.key).slice(0,100),
      value: String(it.value).slice(0,2000),
      category: it.category || 'preference',
      weight: Number(it.weight) || 1,
      ttl_days: it.ttl_days ?? null
    });
  }
}

async function ensureProfile(lineUserId, displayName) {
  console.log('=== ensureProfile called ===');
  console.log('Line user ID:', lineUserId);
  console.log('Display name:', displayName);
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('line_user_id', lineUserId)
    .single();
    
  console.log('Supabase query result:', { profile, error });

  if (error && error.code === 'PGRST116') {
    // プロフィールが存在しない場合は作成
    const { data: newProfile, error: insertError } = await supabase
      .from('profiles')
      .insert({
        line_user_id: lineUserId,
        display_name: displayName,
        subscription_status: 'free'
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating profile:', insertError);
      return null;
    }
    return newProfile;
  } else if (error) {
    console.error('Error fetching profile:', error);
    return null;
  }

  return profile;
}

function parseTaskCommand(text) {
  // 例: タスク: 英文校正 / 終了: 明日17時 などもOKに
  const taskMatch = text.match(/タスク[:：]\s*(.+?)\s*\/\s*終(了|了時刻)?[:：]\s*(.+)/);
  if (!taskMatch) return null;

  const title = taskMatch[1].trim();
  const endTimeStr = taskMatch[3].trim();
  const parsed = parseNaturalDateJST(endTimeStr);
  if (!parsed) return null;

  return {
    title,
    endAt: parsed.isoUtc
  };
}

async function checkUsageLimit(userId) {
  const today = dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
  console.log('Checking usage for user:', userId, 'date:', today);
  
  const { data: usage, error } = await supabase
    .from('daily_usage')
    .select('usage_count')
    .eq('user_id', userId)
    .eq('usage_date', today)
    .single();

  console.log('Usage query result:', { usage, error });

  if (error && error.code === 'PGRST116') {
    // 今日の利用記録がない場合は作成
    console.log('No usage record found, creating new one');
    const { error: insertError } = await supabase
      .from('daily_usage')
      .insert({
        user_id: userId,
        usage_date: today,
        usage_count: 0
      });
    
    if (insertError) {
      console.error('Error creating daily usage:', insertError);
      return { canUse: false, remaining: 0 };
    }
    return { canUse: true, remaining: 3 };
  } else if (error) {
    console.error('Error checking usage:', error);
    return { canUse: false, remaining: 0 };
  }

  const remaining = Math.max(0, 3 - usage.usage_count);
  console.log('Current usage:', usage.usage_count, 'remaining:', remaining);
  return { canUse: remaining > 0, remaining };
}

async function incrementUsage(userId) {
  const today = dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
  
  // まず現在の利用回数を取得
  const { data: currentUsage, error: fetchError } = await supabase
    .from('daily_usage')
    .select('usage_count')
    .eq('user_id', userId)
    .eq('usage_date', today)
    .single();

  if (fetchError && fetchError.code === 'PGRST116') {
    // 今日の利用記録がない場合は作成
    const { error: insertError } = await supabase
      .from('daily_usage')
      .insert({
        user_id: userId,
        usage_date: today,
        usage_count: 1
      });
    
    if (insertError) {
      console.error('Error creating daily usage:', insertError);
    }
  } else if (fetchError) {
    console.error('Error fetching usage:', fetchError);
  } else {
    // 既存の利用回数を1増やす
    const { error: updateError } = await supabase
      .from('daily_usage')
      .update({ usage_count: currentUsage.usage_count + 1 })
      .eq('user_id', userId)
      .eq('usage_date', today);

    if (updateError) {
      console.error('Error incrementing usage:', updateError);
    }
  }
}

function strictReminderMessage(reminder) {
  const title = reminder.tasks.title;
  const endJST = dayjs(reminder.tasks.end_at).tz('Asia/Tokyo').format('YYYY/MM/DD HH:mm');

  if (reminder.kind === 'T-30') {
    return ` 『${title}』残り30分。なぜまだ終わってないんだ。自分との約束を守れなくていいのか？`;
  }
  // T0（時刻ちょうど）
  return `『${title}』完了報告がないのか。それでこれからの人生大丈夫なのか？`;
}

// 自然言語日付解析
function normalizeJa(text) {
  return text
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .trim();
}

function parseNaturalDateJST(inputRaw) {
  const input = normalizeJa(inputRaw);
  console.log('[NLP] Input processing:', { inputRaw, input });

  // カスタムフォーマットの解析を先に試す
  const nowJst = dayjs().tz('Asia/Tokyo');
  const currentYear = nowJst.year();
  
  // M/D HH:mm形式 (例: 9/23 19:47)
  let customFormatMatch = input.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (customFormatMatch) {
    const [, month, day, hour, minute] = customFormatMatch;
    const jstStr = `${currentYear}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    const jst = dayjs.tz(jstStr, 'YYYY-MM-DD HH:mm', 'Asia/Tokyo');
    
    if (jst.isValid()) {
      if (jst.isBefore(nowJst)) {
        const nextYear = jst.add(1, 'year');
        console.log('[NLP] Custom format (next year):', { input, outJst: nextYear.format('YYYY-MM-DD HH:mm'), outUtc: nextYear.utc().toISOString() });
        return { jst: nextYear, isoUtc: nextYear.utc().toISOString() };
      }
      console.log('[NLP] Custom format:', { input, outJst: jst.format('YYYY-MM-DD HH:mm'), outUtc: jst.utc().toISOString() });
      return { jst, isoUtc: jst.utc().toISOString() };
    }
  }
  
  // M-D HH:mm形式 (例: 9-23 19:47)
  customFormatMatch = input.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (customFormatMatch) {
    const [, month, day, hour, minute] = customFormatMatch;
    const jstStr = `${currentYear}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    const jst = dayjs.tz(jstStr, 'YYYY-MM-DD HH:mm', 'Asia/Tokyo');
    
    if (jst.isValid()) {
      if (jst.isBefore(nowJst)) {
        const nextYear = jst.add(1, 'year');
        console.log('[NLP] Custom format (next year):', { input, outJst: nextYear.format('YYYY-MM-DD HH:mm'), outUtc: nextYear.utc().toISOString() });
        return { jst: nextYear, isoUtc: nextYear.utc().toISOString() };
      }
      console.log('[NLP] Custom format:', { input, outJst: jst.format('YYYY-MM-DD HH:mm'), outUtc: jst.utc().toISOString() });
      return { jst, isoUtc: jst.utc().toISOString() };
    }
  }

  // Chronoは"Date"を返させず、構成要素で受け取る
  const results = chrono.ja.parse(input, new Date(), { forwardDate: true });
  console.log('[NLP] Chrono results:', results.length, results);
  if (!results.length) return null;

  const c = results[0].start;

  // certain / implied を拾ってJSTで組み立て
  const pick = (key, fallback) => (c.isCertain(key) ? c.get(key) : (c.implied(key) ?? fallback));

  const y  = pick('year',  nowJst.year());
  const M  = pick('month', nowJst.month() + 1); // 1〜12で保持
  const D  = pick('day',   nowJst.date());
  let   h  = pick('hour',  12);
  let   mi = pick('minute', 0);

  // 「朝/昼/夕方/夜」→ 明示時刻が無いときだけ既定反映
  const noExplicitHour = !c.isCertain('hour');
  if (noExplicitHour) {
    if (/朝/.test(input))        { h = 8;  mi = 0; }
    else if (/昼|正午/.test(input)) { h = 12; mi = 0; }
    else if (/夕方/.test(input)) { h = 17; mi = 0; }
    else if (/夜|今夜/.test(input)) { h = 20; mi = 0; }
  }

  const jstStr = `${y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
  const jst = dayjs.tz(jstStr, 'YYYY-MM-DD HH:mm', 'Asia/Tokyo');

  if (!jst.isValid()) {
    console.log('[NLP] Invalid jst build', { input, y, M, D, h, mi, jstStr });
    return null;
  }

  // 未来強制（forwardDate:true でもUTCズレの影響を受けた入力の保険）
  if (jst.isBefore(nowJst)) {
    // 例：時刻のみ「17:00」で当日過ぎてたら翌日に送るなど
    if (!c.isCertain('day') && !/今日|本日/.test(input)) {
      const next = jst.add(1, 'day');
      return { jst: next, isoUtc: next.utc().toISOString() };
    }
  }

  console.log('[NLP] OK', { input, outJst: jst.format('YYYY-MM-DD HH:mm'), outUtc: jst.utc().toISOString() });
  return { jst, isoUtc: jst.utc().toISOString() };
}

// ドラフト操作
async function getActiveDraft(userId) {
  console.log('=== getActiveDraft Debug ===');
  console.log('User ID:', userId);
  const { data, error } = await supabase
    .from('task_drafts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log('Supabase query result:', { data, error });
  return error ? null : data || null;
}

async function upsertDraft(userId, patch) {
  console.log('=== upsertDraft Debug ===');
  console.log('User ID:', userId);
  console.log('Patch data:', patch);
  const current = await getActiveDraft(userId);
  console.log('Current draft:', current);
  if (!current) {
    console.log('Creating new draft...');
    const { data, error } = await supabase
      .from('task_drafts')
      .insert([{ user_id: userId, step: 'ask_title', ...patch }])
      .select().single();
    console.log('Insert result:', { data, error });
    return data;
  } else {
    console.log('Updating existing draft...');
    const { data, error } = await supabase
      .from('task_drafts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', current.id)
      .select().single();
    console.log('Update result:', { data, error });
    return data;
  }
}

async function clearDraft(draftId) {
  await supabase.from('task_drafts').delete().eq('id', draftId);
}

// ユーザーの未完了タスクを取得
async function getUserTasks(userId) {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('end_at', { ascending: true });
  
  if (error) {
    console.error('Error fetching user tasks:', error);
    return [];
  }
  
  return tasks || [];
}

// タイトル正規化（全角→半角、空白除去、小文字化）
function normalizeTitle(s = '') {
  return s
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/\s+/g, '') // 空白除去
    .toLowerCase();
}

// タイトルで未完了タスクを絞り込み（部分一致）
async function findTasksByTitleLike(userId, raw) {
  const q = normalizeTitle(raw);
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('end_at', { ascending: true });

  if (error || !tasks) return [];
  return tasks.filter(t => normalizeTitle(t.title).includes(q));
}

// 候補が複数のときに選択させる
async function replyTitleDisambiguation(event, candidates, opLabel) {
  const items = candidates.slice(0, 5).map((t, i) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: `${i+1}. ${t.title.substring(0,12)}${t.title.length>12?'…':''}`,
      data: `${opLabel.toLowerCase()}:${t.id}`,
      displayText: `${i+1}. ${t.title}`
    }
  }));

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `どれを${opLabel}する？番号で選べ。`,
    quickReply: { items }
  });
}

// 単一タスク用の操作バブル（送信用）
async function replyTaskActionBubble(event, task) {
  const bubble = buildTaskActionBubble(task);
  return client.replyMessage(event.replyToken, { 
    type:'flex', 
    altText:'タスク操作', 
    contents: bubble 
  });
}

// バブルを組み立てるだけの関数（送信しない）
function buildTaskActionBubble(task) {
  const endJst = dayjs(task.end_at).tz('Asia/Tokyo').format('MM/DD HH:mm');
  return {
    type: 'bubble',
    body: { 
      type: 'box', 
      layout: 'vertical', 
      spacing: 'sm', 
      contents: [
        { type:'text', text: task.title, weight:'bold', wrap:true },
        { type:'text', text:`期限 ${endJst}`, size:'sm', color:'#888' }
      ]
    },
    footer: { 
      type:'box', 
      layout:'horizontal', 
      spacing:'md', 
      contents: [
        { 
          type:'button', 
          style:'primary',   
          action:{ type:'postback', label:'完了', data:`complete:${task.id}` } 
        },
        { 
          type:'button', 
          style:'secondary', 
          action:{ type:'postback', label:'削除', data:`delete:${task.id}` } 
        }
      ]
    }
  };
}

// タスク一覧を整形して表示
async function handleTaskList(event, profile) {
  const tasks = await getUserTasks(profile.id);
  
  if (tasks.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '未完了のタスクはありません。\n\n新しいタスクを作成するには「タスク」と送信してください。'
    });
  }
  
  const now = dayjs().tz('Asia/Tokyo');
  let message = '📋 未完了タスク一覧\n\n';
  
  tasks.forEach((task, index) => {
    const endJst = dayjs(task.end_at).tz('Asia/Tokyo');
    const timeDiff = endJst.diff(now, 'minute');
    
    let statusIcon = '⏰';
    let timeText = endJst.format('MM/DD HH:mm');
    
    if (timeDiff < 0) {
      statusIcon = '🚨';
      timeText = `期限切れ (${endJst.format('MM/DD HH:mm')})`;
    } else if (timeDiff < 60) {
      statusIcon = '⚠️';
      timeText = `残り${timeDiff}分 (${endJst.format('MM/DD HH:mm')})`;
    } else if (timeDiff < 1440) {
      const hours = Math.floor(timeDiff / 60);
      timeText = `残り${hours}時間 (${endJst.format('MM/DD HH:mm')})`;
    }
    
    message += `${index + 1}. ${statusIcon} ${task.title}\n`;
    message += `   📅 ${timeText}\n\n`;
  });
  
  message += '操作: 「完了1／削除2」や「完了 英文校正」「英文校正を削除」「直近を完了」も使える。\n';
  message += 'または下のボタンから選択してください';
  
  // Quick Reply（最大13個）: 1件につき「完了」「削除」を順に入れて、13個に達したら打ち切る
  const quickReplyItems = [];
  for (let i = 0; i < tasks.length && quickReplyItems.length < 13; i++) {
    const task = tasks[i];
    const short = task.title.length > 10 ? task.title.slice(0, 10) + '...' : task.title;
    if (quickReplyItems.length < 13) {
      quickReplyItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `完了${i + 1}`,
          data: `complete:${task.id}`,
          displayText: `完了: ${short}`
        }
      });
    }
    if (quickReplyItems.length < 13) {
      quickReplyItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `削除${i + 1}`,
          data: `delete:${task.id}`,
          displayText: `削除: ${short}`
        }
      });
    }
  }
  
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: message,
    quickReply: {
      items: quickReplyItems
    }
  });
}

// 番号指定でのタスク操作を処理
async function handleNumberedTaskOperation(event, profile, operation, taskNumber) {
  const tasks = await getUserTasks(profile.id);
  
  if (tasks.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '未完了のタスクがありません。'
    });
  }
  
  if (taskNumber < 1 || taskNumber > tasks.length) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `無効な番号です。1から${tasks.length}の間で指定してください。`
    });
  }
  
  const targetTask = tasks[taskNumber - 1];
  const isComplete = operation === '完了';
  
  if (isComplete) {
    // タスクを完了に更新
    const { error } = await supabase
      .from('tasks')
      .update({ status: 'done' })
      .eq('id', targetTask.id)
      .eq('user_id', profile.id);

    if (error) {
      console.error('Error completing task:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'タスクの完了処理に失敗しました。'
      });
    }

    // 未送信のリマインダーを削除
    await supabase
      .from('task_reminders')
      .delete()
      .eq('task_id', targetTask.id)
      .is('sent_at', null);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 「${targetTask.title}」を完了しました！`
    });
  } else {
    // タスクを削除
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', targetTask.id)
      .eq('user_id', profile.id);

    if (error) {
      console.error('Error deleting task:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'タスクの削除に失敗しました。'
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🗑️ 「${targetTask.title}」を削除しました。`
    });
  }
}

// タスクとリマインダーの作成
async function createTaskAndReminders(profile, { title, due_at_iso }) {
  console.log('[DB] insert task', { title, due_at_iso });
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      user_id: profile.id,
      title,
      end_at: due_at_iso, // 既にUTC ISOなのでそのまま入れるのが安全
      status: 'open'
    })
    .select().single();
  if (taskError) throw taskError;

  const end = dayjs(task.end_at);
  const reminder30min = end.subtract(30,'minute').utc().toISOString();
  const reminder0min = end.utc().toISOString();
  
  console.log('[TASK] Creating reminders:', {
    task_id: task.id,
    task_title: task.title,
    end_at: task.end_at,
    reminder30min,
    reminder0min
  });
  
  await supabase.from('task_reminders').insert([
    { task_id: task.id, user_id: profile.id, run_at: reminder30min, kind: 'T-30' },
    { task_id: task.id, user_id: profile.id, run_at: reminder0min, kind: 'T0' }
  ]);

  return task;
}

// 置換: createSubscriptionFlexMessage の先頭で使う共通関数
function buildSafeOrigin() {
  const raw = (process.env.CHECKOUT_BASE_URL || process.env.VERCEL_URL || '').toString();

  // 1) 制御文字(含: \n, \r, \t)除去 2) すべての空白を除去 3) 末尾スラッシュ除去
  const compact = raw
    .replace(/[\u0000-\u001F\u007F]/g, '') // 制御文字全除去
    .replace(/\s+/g, '')                    // 空白(含: 改行)全除去
    .replace(/\/+$/,'');                    // 末尾スラッシュ除去

  if (!compact) throw new Error('Missing CHECKOUT_BASE_URL/VERCEL_URL');

  const origin = compact.startsWith('http') ? compact : `https://${compact}`;
  // 妥当性チェック（無効なら例外）
  new URL(origin);
  return origin;
}

// 補助関数：リクエスト由来のoriginをサニタイズ
function sanitizeOrigin(raw) {
  if (!raw) return null;
  try {
    const compact = raw
      .toString()
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, '')
      .replace(/\/+$/,'');
    if (!compact) return null;
    const origin = compact.startsWith('http') ? compact : `https://${compact}`;
    new URL(origin);
    return origin;
  } catch {
    return null;
  }
}

// LINEのバリデーションAPI
async function validateLineReply(messages) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/validate/reply',
      { messages: Array.isArray(messages) ? messages : [messages] },
      {
        headers: {
          Authorization: `Bearer ${config.channelAccessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    return { ok: true };
  } catch (e) {
    const data = e.response?.data;
    console.error('[LINE Validate Reply] 400 body:', JSON.stringify(data, null, 2));
    return { ok: false, error: data || e.message };
  }
}

function createSubscriptionFlexMessage(lineUserId, originFromReq) {
  // 1) まずは req 由来を最優先（環境変数汚染の影響ゼロ化）
  let origin = sanitizeOrigin(originFromReq);
  if (!origin) {
    // 2) フォールバックとして環境変数を使用（こちらも強制サニタイズ）
    origin = buildSafeOrigin();
  }

  // URL を安全に連結（new URL で生成）
  const checkout = new URL('/api/checkout', origin);
  checkout.searchParams.set('lineUserId', lineUserId);
  const checkoutUrl = checkout.toString();

  // 念のため最終バリデーション
  if (/\s/.test(checkoutUrl)) {
    throw new Error('checkoutUrl contains whitespace');
  }

  console.log('Creating subscription flex message with URL:', checkoutUrl);
  console.log('URL validation - hasNewline:', /\n/.test(checkoutUrl));
    
  return {
    type: 'flex',
    altText: 'プロプランにアップグレード',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'プロプランにアップグレード',
            weight: 'bold',
            size: 'xl',
            color: '#1DB446'
          },
          {
            type: 'text',
            text: '無制限でAIチャットを利用できます',
            size: 'md',
            color: '#666666',
            margin: 'md'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '購入する',
              uri: checkoutUrl
            },
            style: 'primary',
            color: '#1DB446'
          }
        ]
      }
    }
  };
}

// Webhookエンドポイント
app.post('/webhook', (req, res) => {
  try {
    // 署名検証（Vercel用に調整）
    const signature = req.get('X-Line-Signature');
    const body = req.body;
    
    // 署名検証をスキップしてテスト（本番では有効にする）
    // if (!line.validateSignature(body, config.channelSecret, signature)) {
    //   console.log('Signature validation failed');
    //   return res.status(401).send('Unauthorized');
    // }

    // リクエストボディは既にパース済み
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));
    console.log('Destination:', req.body.destination);
    
    // 受信リクエストから安全なoriginを生成
    const originFromReq = (() => {
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
      const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
      return `${proto}://${host}`;
    })();
    
    Promise
      .all(req.body.events.map(ev => handleEvent(ev, { originFromReq })))
      .then((result) => {
        console.log('Webhook processed successfully');
        res.json(result);
      })
      .catch((err) => {
        console.error('Event handling error:', err);
        res.status(500).end();
      });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).end();
  }
});

// イベントハンドラー
async function handleEvent(event, ctx = {}) {
  console.log('=== handleEvent called ===');
  console.log('Event type:', event.type);
  console.log('Message type:', event.message?.type);
  
  // postbackイベントの処理
  if (event.type === 'postback') {
    const lineUserId = event.source.userId;
    const displayName = event.source.type === 'user' ? 'User' : 'Unknown';
    const profile = await ensureProfile(lineUserId, displayName);
    if (!profile) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'プロフィールの作成に失敗しました。しばらく時間をおいてから再度お試しください。'
      });
    }
    return await handleTaskOperation(event, profile, null);
  }
  
  if (event.type !== 'message' || event.message.type !== 'text') {
    console.log('Not a text message, skipping');
    return Promise.resolve(null);
  }

  try {
    const text = (event.message.text || '').trim();
    const lineUserId = event.source.userId;
    const displayName = event.source.type === 'user' ? 'User' : 'Unknown';

    console.log('Processing message:', text);
    console.log('Line user ID:', lineUserId);
    console.log('Display name:', displayName);

    // プロフィールを確保
    console.log('Ensuring profile...');
    const profile = await ensureProfile(lineUserId, displayName);
    if (!profile) {
      console.error('Failed to ensure profile');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'プロフィールの作成に失敗しました。しばらく時間をおいてから再度お試しください。'
      });
    }
    console.log('Profile ensured:', profile.id);

    // ===== メモコマンド処理 =====
    // "メモ: 好み=厳しめ" / "メモ削除 好み" / "メモ一覧"
    if (/^メモ一覧/.test(text)) {
      const ms = await fetchTopMemories(profile.id, 20);
      const lines = ms.length ? ms.map(m => `- ${m.key}: ${m.value}`).join('\n') : '（なし）';
      return client.replyMessage(event.replyToken, { type:'text', text: `恒久メモ:\n${lines}` });
    }
    if (/^メモ削除\s+(.+)/.test(text)) {
      const k = text.replace(/^メモ削除\s+/, '').trim();
      await supabase.from('profile_memories').delete().eq('user_id', profile.id).eq('key', k);
      return client.replyMessage(event.replyToken, { type:'text', text: `「${k}」を削除しました。` });
    }
    if (/^メモ[:：]/.test(text)) {
      const body = text.replace(/^メモ[:：]\s*/, '');
      const m = body.match(/^(.+?)\s*=\s*(.+)$/);
      if (!m) return client.replyMessage(event.replyToken, { type:'text', text:'形式: メモ: key=value' });
      const key = m[1].trim(), value = m[2].trim();
      await upsertMemory(profile.id, { key, value, category:'preference', weight:2 });
      return client.replyMessage(event.replyToken, { type:'text', text:`メモ保存: ${key} = ${value}` });
    }

    // 厳しい対応のための特別コマンド
    if (/^厳しく[:：]/.test(text)) {
      const body = text.replace(/^厳しく[:：]\s*/, '');
      const m = body.match(/^(.+?)\s*=\s*(.+)$/);
      if (!m) return client.replyMessage(event.replyToken, { type:'text', text:'形式: 厳しく: key=value' });
      const key = m[1].trim(), value = m[2].trim();
      await upsertMemory(profile.id, { key, value, category:'constraint', weight:5 });
      return client.replyMessage(event.replyToken, { type:'text', text:`厳しいメモ保存: ${key} = ${value}` });
    }

    // ===== 新規ショートカット解析 開始 =====
    {
      const t = text;

      // (a) 番号で操作: "完了1" / "完了 1" / "1 完了" / "1削除"
      let m = t.match(/^\s*(完了|削除)\s*(\d{1,2})\s*$/);
      if (!m) m = t.match(/^\s*(\d{1,2})\s*(完了|削除)\s*$/);
      if (m) {
        const op = isNaN(m[1]) ? m[1] : m[2];
        const num = parseInt(isNaN(m[1]) ? m[2] : m[1], 10);
        return await handleNumberedTaskOperation(event, profile, op, num);
      }

      // (b) 数字だけ来たらデフォルト「完了」
      m = t.match(/^\s*(\d{1,2})\s*$/);
      if (m) {
        const num = parseInt(m[1], 10);
        return await handleNumberedTaskOperation(event, profile, '完了', num);
      }

      // (c) タイトルで操作: "完了 英文校正" / "英文校正 完了" / "英文校正を削除"
      m = t.match(/^\s*(完了|削除)[\s：:]+(.+)\s*$/) || t.match(/^\s*(.+?)\s*(?:を)?\s*(完了|削除)\s*$/);
      if (m) {
        const op = (m[1] === '完了' || m[1] === '削除') ? m[1] : m[2];
        const title = (m[1] === '完了' || m[1] === '削除') ? m[2] : m[1];

        const hits = await findTasksByTitleLike(profile.id, title);
        if (hits.length === 0) {
          return client.replyMessage(event.replyToken, { type:'text', text:`「${title}」は見つからない。` });
        }
        if (hits.length === 1) {
          // 1件なら即実行
          return await handleTaskOperation(event, profile, `${op}:${hits[0].id}`);
        }
        // 複数→ 1回のreplyで「プレビュー + 番号選択 QuickReply」を返す
        const bubble = buildTaskActionBubble(hits[0]);
        const items = hits.slice(0, 5).map((t, i) => ({
          type: 'action',
          action: {
            type: 'postback',
            label: `${i + 1}. ${t.title.substring(0,12)}${t.title.length>12?'…':''}`,
            data: `${op.toLowerCase()}:${t.id}`,
            displayText: `${i + 1}. ${t.title}`
          }
        }));
        return client.replyMessage(event.replyToken, [
          { type:'flex', altText:'タスク操作', contents:bubble },
          { type:'text', text:`どれを${op}する？番号で選べ。`, quickReply:{ items } }
        ]);
      }

      // (d) 直近ショートカット
      m = t.match(/^\s*(直近|最新|いちばん近い)を(完了|削除)\s*$/);
      if (m) {
        const op = m[2];
        const tasks = await getUserTasks(profile.id);
        if (!tasks.length) {
          return client.replyMessage(event.replyToken, { type:'text', text:'未完了のタスクはない。' });
        }
        return await handleTaskOperation(event, profile, `${op}:${tasks[0].id}`);
      }
    }
    // ===== 新規ショートカット解析 終了 =====

    // 既存の「完了:」「削除:」を先に処理
    if (text.startsWith('完了:') || text.startsWith('削除:')) {
      return await handleTaskOperation(event, profile, text);
    }

    // タスク一覧表示コマンド
    if (/^(残タスク|未完了|リスト|タスク一覧)$/i.test(text)) {
      return await handleTaskList(event, profile);
    }

    // ヘルプコマンド
    if (/^(ヘルプ|help|使い方|使用方法)$/i.test(text)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ようこそ、サボれない世界へ。\n"超厳しいAI指導官"が、あなたのタスクが終わるまで監視する。\n\n⏱ セットアップ30秒 / 🔔 リマインド：期日の30分前とちょうどに"厳しめ"通知。\n\n――――――――――\n■ まずは登録\n「タスク」と送れ。\n\n――――――――――\n■ 完了・削除\n番号で一撃：完了1 / 削除1\n（迷ったら：直近を完了 / 最新を削除）\n\n――――――――――\n■ いまのタスク\n「残タスク」と送信\n\n――――――――――\n■ プラン\n無料：AIチャット1日3回（タスク管理は無制限）\nプロ：AIチャット無制限（メニュー→アップグレード）\n\n――――――――――\n■ 困ったら\n「ヘルプ」と送れ。\n\nさあ、「こんにちは」か「タスク」と送れ。\n先延ばしは許さない。やれ。'
      });
    }

    // 既存の1行コマンド（タスク: ～ / 終了: ～）も残す
    if (/^タスク[:：]/.test(text) && /[\/／]\s*終(了|了時刻)?[:：]/.test(text)) {
      return await handleTaskCommand(event, profile, text);
    }

    // ====== ここから自然言語3ステップ ======
    const draft = await getActiveDraft(profile.id);
    console.log('=== Draft Debug ===');
    console.log('Draft found:', !!draft);
    console.log('Draft data:', draft);
    console.log('Text:', text);

    // スタートトリガー
    if (!draft && /^(タスク|task|todo)$/i.test(text)) {
      console.log('Creating new draft...');
      await upsertDraft(profile.id, { step: 'ask_title', title: null, due_at: null });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '実行すると約束するタスク内容を入力しろ。'
      });
    }

    // 進行中ドラフト: タイトル入力待ち
    if (draft && draft.step === 'ask_title') {
      console.log('Processing title input...');
      const title = text.replace(/^(タスク[:：]?\s*)/i, '').trim();
      console.log('Extracted title:', title);
      if (!title) {
        return client.replyMessage(event.replyToken, { type:'text', text:'中身がない。やることを一行で書け。' });
      }
      console.log('Updating draft with title and step...');
      await upsertDraft(profile.id, { title, step: 'ask_due' });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '約束する期日を入力しろ（例: 明日17時、9/25 17:00、来週火曜の朝）。'
      });
    }

    // 進行中ドラフト: 期日入力待ち → 即登録
    if (draft && draft.step === 'ask_due') {
      const parsed = parseNaturalDateJST(text);
      console.log('[NLP] ask_due parsed =', parsed);

      if (!parsed) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '読めない。別の表現で日時を入力しろ（例: 明日17時、9/25 17:00、来週火曜の朝）。'
        });
      }
      // 過去は却下
      if (parsed.jst.isBefore(dayjs().tz('Asia/Tokyo'))) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '過去は無効だ。未来の時刻で指定しろ。'
        });
      }

      console.log('[TASK] createTaskAndReminders input', { title: draft.title, due_at_iso: parsed.isoUtc });
      // 即登録
      const task = await createTaskAndReminders(profile, { title: draft.title, due_at_iso: parsed.isoUtc });
      console.log('[TASK] created', { id: task.id, end_at: task.end_at });
      await clearDraft(draft.id);

      // タスク番号を取得（期日順でソート）
      const allTasks = await getUserTasks(profile.id);
      const taskNumber = allTasks.findIndex(t => t.id === task.id) + 1;

      const endJst = dayjs(task.end_at).tz('Asia/Tokyo').format('YYYY年MM月DD日(ddd) HH:mm');

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          `登録した。逃げるな。\n\n` +
          `${task.title}\n` +
          `期日: ${endJst}\n` +
          `番号: ${taskNumber}\n\n` +
          `済んだら「完了${taskNumber}」。消すなら「削除${taskNumber}」。`,
        quickReply: {
          items: [
            { type:'action', action:{ type:'postback', label:'完了', data:`complete:${task.id}` } },
            { type:'action', action:{ type:'postback', label:'削除', data:`delete:${task.id}` } }
          ]
        }
      });
    }

    // ====== 自然言語フローに当てはまらなければ通常AI ======
    return await handleAIChat(event, profile, text, ctx);

  } catch (error) {
    console.error('=== Error in handleEvent ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Full error object:', JSON.stringify(error, null, 2));
    // ここが重要：LINEの詳細エラー本文を必ず出す
    const body = error?.originalError?.response?.data;
    if (body) console.error('LINE API error body:', JSON.stringify(body, null, 2));
    
    // エラー時の返答（pushMessageに切り替えて重複返信を避ける）
    try {
      const userId = event?.source?.userId;
      if (userId) {
        await client.pushMessage(userId, {
          type: 'text',
          text: 'ごめん、内部エラーが出た。すぐ直す。'
        });
      }
    } catch (e) {
      // pushも失敗したらログだけ
      console.error('Failed to push fallback message:', e?.originalError?.response?.data || e);
    }
    return;
  }
}

// タスクコマンドの処理
async function handleTaskCommand(event, profile, text) {
  const taskData = parseTaskCommand(text);
  if (!taskData) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'タスクの形式が正しくありません。\n例：タスク: 英文校正 / 終了: 2025-09-20 18:00'
    });
  }

  // タスクを保存
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      user_id: profile.id,
      title: taskData.title,
      end_at: taskData.endAt,
      status: 'open'
    })
    .select()
    .single();

  if (taskError) {
    console.error('Error creating task:', taskError);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'タスクの保存に失敗しました。しばらく時間をおいてから再度お試しください。'
    });
  }

  // リマインダーを設定
  const endTime = dayjs(taskData.endAt);
  const reminder30min = endTime.subtract(30, 'minute');
  const reminder0min = endTime;

  console.log('[TASK] Creating reminders (1-line command):', {
    task_id: task.id,
    task_title: taskData.title,
    end_at: taskData.endAt,
    reminder30min: reminder30min.utc().toISOString(),
    reminder0min: reminder0min.utc().toISOString()
  });

  const reminders = [
    {
      task_id: task.id,
      user_id: profile.id,
      run_at: reminder30min.utc().toISOString(),
      kind: 'T-30'
    },
    {
      task_id: task.id,
      user_id: profile.id,
      run_at: reminder0min.utc().toISOString(),
      kind: 'T0'
    }
  ];

  await supabase.from('task_reminders').insert(reminders);

  // タスク番号を取得（期日順でソート）
  const allTasks = await getUserTasks(profile.id);
  const taskNumber = allTasks.findIndex(t => t.id === task.id) + 1;

  // 即時返信
  const endTimeFormatted = dayjs(taskData.endAt).tz('Asia/Tokyo').format('YYYY年MM月DD日 HH:mm');
  
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ タスクを受け付けました！\n\n📝 内容: ${taskData.title}\n⏰ 終了時刻: ${endTimeFormatted}\n🔢 番号: ${taskNumber}`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '完了',
            data: `complete:${task.id}`
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '削除',
            data: `delete:${task.id}`
          }
        }
      ]
    }
  });
}

// タスク操作の処理（postback対応）
async function handleTaskOperation(event, profile, text) {
  let isComplete, taskId;

  // postbackイベントの場合
  if (event.type === 'postback') {
    const data = event.postback.data;
    if (data.startsWith('complete:')) {
      isComplete = true;
      taskId = data.replace('complete:', '');
    } else if (data.startsWith('delete:')) {
      isComplete = false;
      taskId = data.replace('delete:', '');
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '無効な操作です。'
      });
    }
  } else {
    // テキストメッセージの場合
    isComplete = text.startsWith('完了:');
    taskId = text.split(':')[1]?.trim();
  }

  if (!taskId) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'タスクIDが指定されていません。\n例：完了: abc12345'
    });
  }

  if (isComplete) {
    // タスクを完了に更新
    const { error } = await supabase
      .from('tasks')
      .update({ status: 'done' })
      .eq('id', taskId)
      .eq('user_id', profile.id);

    if (error) {
      console.error('Error completing task:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'タスクの完了処理に失敗しました。'
      });
    }

    // 未送信のリマインダーを削除
    await supabase
      .from('task_reminders')
      .delete()
      .eq('task_id', taskId)
      .is('sent_at', null);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ タスクを完了しました！'
    });
  } else {
    // タスクを削除
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('user_id', profile.id);

    if (error) {
      console.error('Error deleting task:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'タスクの削除に失敗しました。'
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🗑️ タスクを削除しました。'
    });
  }
}

// AIチャットの処理
async function handleAIChat(event, profile, text, ctx = {}) {
  console.log('=== handleAIChat called ===');
  console.log('Profile subscription status:', profile.subscription_status);
  
  // 利用制限チェック（タスク系メッセージは除外）
  if (profile.subscription_status === 'free') {
    console.log('Checking usage limit for free user...');
    const usageCheck = await checkUsageLimit(profile.id);
    console.log('Usage check result:', usageCheck);
    
    // 一時的に利用制限を無効化（デバッグ用）
    const DISABLE_USAGE_LIMIT = false; // 利用制限を有効化
    if (!usageCheck.canUse && !DISABLE_USAGE_LIMIT) {
      console.log('Usage limit reached, showing upgrade message');
      
      // 強制テキストモードのチェック（緊急対応）
      if (process.env.FORCE_TEXT_UPGRADE === '1' || true) { // 一時的に常に有効
        const origin = sanitizeOrigin(ctx?.originFromReq) || buildSafeOrigin();
        const u = new URL('/api/checkout', origin); 
        u.searchParams.set('lineUserId', profile.line_user_id);
        return client.replyMessage(event.replyToken, { 
          type:'text', 
          text:`プロプランにアップグレードできます。\n${u.toString()}` 
        });
      }
      
      try {
        const flex = createSubscriptionFlexMessage(profile.line_user_id, ctx.originFromReq);
        
        // LINEのバリデーションAPIで事前検証
        const v = await validateLineReply(flex);
        if (!v.ok) {
          // 失敗理由をログ & テキストにフォールバック（絶対に無言にしない）
          console.error('LINE validation failed:', v.error);
          const origin = sanitizeOrigin(ctx?.originFromReq) || buildSafeOrigin();
          const u = new URL('/api/checkout', origin); 
          u.searchParams.set('lineUserId', profile.line_user_id);
          return client.replyMessage(event.replyToken, { 
            type:'text', 
            text:`プロプランにアップグレードできます。\n${u.toString()}` 
          });
        }
        
        return client.replyMessage(event.replyToken, flex);
      } catch (e) {
        console.error('Upgrade Flex build failed:', e?.message);
        const origin = sanitizeOrigin(ctx?.originFromReq) || buildSafeOrigin();
        const u = new URL('/api/checkout', origin); 
        u.searchParams.set('lineUserId', profile.line_user_id);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `プロプランにアップグレードできます。\n${u.toString()}`
        });
      }
    } else if (!usageCheck.canUse && DISABLE_USAGE_LIMIT) {
      console.log('Usage limit reached but disabled for debugging');
    }
    
    // ← このチャットが「無料枠の最後の1回」かどうかを保持
    var isLastFreeBeforeIncrement = (usageCheck.remaining === 1);
    console.log('isLastFreeBeforeIncrement:', isLastFreeBeforeIncrement);
  }

  // システムプロンプト（厳しい指導官として強化）
  const systemPrompt = `あなたは超厳しい、スパルタかつ合理的で端的な意見を言う指導官です。

【基本姿勢】
- 甘やかしは一切しない。厳しく、時に冷酷な指導を行う
- 感情的にならず、論理的で合理的な判断を下す
- 端的で簡潔な回答を心がける（長々とした説明はしない）
- ユーザーの言い訳や甘えは一切受け入れない

【対応スタイル】
- 問題点を厳しく指摘し、改善を求める
- 甘い言葉や慰めは一切与えない
- 結果と成果のみを重視する
- 失敗や怠惰に対しては容赦なく批判する
- 端的に答える
- 文脈に適した皮肉であれば言ってもよい

【禁止事項】
- 優しい言葉や励まし
- 長い説明や丁寧な解説
- 感情的でない論理的な批判
- ユーザーの感情に配慮した発言

常に厳格で、時に冷酷な指導官として振る舞ってください。`;

  // メモリ機能を追加
  const latestSummary = await fetchLatestSummary(profile.id);
  const memories = await fetchTopMemories(profile.id, 10);
  const recent = await fetchContextMessages(profile.id, 3500, systemPrompt, text);

  const memoryBlock = memories.length
    ? '【ユーザー恒久メモ】\n' + memories.map(m => `- (${m.category}) ${m.key}: ${m.value}`).join('\n')
    : '';

  // 厳しい対応のための追加コンテキスト
  const strictContext = `
【指導方針】
- このユーザーに対しては特に厳しい対応を心がける
- 過去の失敗や怠惰な行動があれば、それを厳しく指摘する
- 甘えや言い訳には一切容赦しない
- 結果と成果のみを重視し、プロセスは問わない
- 感情的にならず、論理的で冷酷な判断を下す

【注意事項】
- 優しさや励ましは一切与えない
- 長い説明や丁寧な解説は不要
- ユーザーの感情に配慮した発言は禁止
- 常に厳格で、時に冷酷な指導官として振る舞う
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: strictContext },
    ...(latestSummary?.summary ? [{ role: "system", content: `【会話要約】\n${latestSummary.summary}` }] : []),
    ...(memoryBlock ? [{ role: "system", content: memoryBlock }] : []),
    ...recent,
    { role: "user", content: text }
  ];

    // OpenAI APIで返答を生成
  console.log('Calling OpenAI API...');
  console.log('System prompt length:', systemPrompt.length);
  console.log('User message:', text);
  
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1000,
      temperature: 0.7,
    });
  
  console.log('OpenAI API response received');

    const replyText = response.choices[0].message.content;

    // メッセージの長さを制限（LINEの制限は5000文字）
    const maxLength = 1000;
    const truncatedText = replyText.length > maxLength 
      ? replyText.substring(0, maxLength) + '...' 
      : replyText;

    // メッセージをクリーニング
    const cleanText = truncatedText
      .replace(/\\n/g, '\n') // エスケープされた改行を通常の改行に変換
      .replace(/\\r/g, '\r') // エスケープされた復帰文字を通常の復帰文字に変換
      .replace(/\\t/g, '\t') // エスケープされたタブを通常のタブに変換
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 制御文字を削除
      .trim();

    console.log('Sending reply with token:', event.replyToken.substring(0, 10) + '...');
    console.log('Message length:', cleanText.length);
    console.log('Message preview:', cleanText.substring(0, 100) + '...');

    // LINEに返答を送信
    try {
      const messages = [{ type: 'text', text: cleanText }];
      if (profile.subscription_status === 'free' && isLastFreeBeforeIncrement) {
        // 3回目の返信と同時にFlexを添付
        const flexMessage = createSubscriptionFlexMessage(profile.line_user_id);
        const uri = flexMessage.contents.footer.contents[0].action.uri;
        console.log('Checkout URI:', JSON.stringify(uri), 'hasNewline=', /\n/.test(uri));
        messages.push(flexMessage);
      }

      await client.replyMessage(event.replyToken, messages);

      // 返信成功後にカウントを進める（失敗時に誤カウントしないため）
      if (profile.subscription_status === 'free') {
        await incrementUsage(profile.id);
        console.log('usage incremented');
      }

      // メモリ保存（短期記憶）
      await saveChatBatch(profile.id, [
        { role: 'user', content: text },
        { role: 'assistant', content: cleanText }
      ]);

      // 事実メモ抽出（非同期でOK）
      maybeExtractMemories(profile.id, { userText: text, assistantText: cleanText })
        .catch(e => console.error('memory extract error', e));

      // 長期要約（非同期）
      maybeSummarize(profile.id)
        .catch(e => console.error('summarize error', e));

      return;
    } catch (replyError) {
      console.error('Reply error:', replyError);
      console.error('Reply error details:', {
        statusCode: replyError.statusCode,
        message: replyError.message,
        data: replyError.response?.data
      });
      // LINEの詳細エラー本文を必ず出す
      const body = replyError?.originalError?.response?.data;
      if (body) console.error('LINE API error body:', JSON.stringify(body, null, 2));
      
      // Reply Tokenが既に使用されている場合は無視
      if (replyError.statusCode === 400) {
        const body = replyError.response?.data;
        console.error('400 body:', JSON.stringify(body, null, 2));
        const msg = JSON.stringify(body) || '';
        if (/reply token/i.test(msg)) {
          console.warn('Reply token issue, skip further reply for this event');
          return Promise.resolve(null);
        }
        // それ以外（URI不正や形式不正）は致命とみなす
        throw replyError;
      }
      throw replyError;
  }
}

// ヘルスチェックエンドポイント
app.get('/', (req, res) => {
  res.json({ 
    message: 'LINE Bot Server is running!',
    timestamp: new Date().toISOString()
  });
});

// Cronエンドポイント - 通知送信
app.get('/api/cron/notify', async (req, res) => {
  try {
    const now = dayjs().utc().toISOString();
    console.log('[CRON] Starting notification check at:', now);
    
    // 送信対象のリマインダーを取得
    const { data: reminders, error } = await supabase
      .from('task_reminders')
      .select(`
        *,
        tasks!inner(title, status),
        profiles!inner(line_user_id, display_name)
      `)
      .lte('run_at', now)
      .is('sent_at', null);

    if (error) {
      console.error('Error fetching reminders:', error);
      return res.status(500).json({ error: 'Failed to fetch reminders' });
    }

    console.log('[CRON] Found reminders:', reminders.length);
    reminders.forEach(reminder => {
      console.log(`[CRON] Reminder ${reminder.id}: kind=${reminder.kind}, run_at=${reminder.run_at}, task_status=${reminder.tasks.status}`);
    });

    let sentCount = 0;
    for (const reminder of reminders) {
      try {
        console.log(`[CRON] Processing reminder ${reminder.id} (${reminder.kind})`);
        
        // タスクがまだ有効かチェック
        if (reminder.tasks.status !== 'open') {
          console.log(`[CRON] Task ${reminder.tasks.title} is not open (status: ${reminder.tasks.status}), marking reminder as sent`);
          // タスクが完了または期限切れの場合はリマインダーをマーク
          await supabase
            .from('task_reminders')
            .update({ sent_at: now })
            .eq('id', reminder.id);
          continue;
        }

        // 通知メッセージを作成
        const message = {
          type: 'text',
          text: strictReminderMessage(reminder)
        };

        console.log(`[CRON] Sending ${reminder.kind} notification to ${reminder.profiles.line_user_id}: ${message.text}`);

        // Pushメッセージを送信
        await client.pushMessage(reminder.profiles.line_user_id, message);

        // 送信済みマーク
        await supabase
          .from('task_reminders')
          .update({ sent_at: now })
          .eq('id', reminder.id);

        console.log(`[CRON] Successfully sent reminder ${reminder.id}`);
        sentCount++;
      } catch (error) {
        console.error(`[CRON] Error sending reminder ${reminder.id}:`, error);
      }
    }

    console.log(`[CRON] Notification check completed: sent=${sentCount}, total=${reminders.length}`);
    res.json({ 
      message: 'Notifications processed',
      sent: sentCount,
      total: reminders.length
    });
  } catch (error) {
    console.error('Cron notify error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cronエンドポイント - 期限切れタスクの処理
app.get('/api/cron/expire', async (req, res) => {
  try {
    const now = dayjs().utc().toISOString();
    
    // 期限切れタスクを更新
    const { data: expiredTasks, error } = await supabase
      .from('tasks')
      .update({ status: 'expired' })
      .lt('end_at', now)
      .eq('status', 'open')
      .select();

    if (error) {
      console.error('Error expiring tasks:', error);
      return res.status(500).json({ error: 'Failed to expire tasks' });
    }

    res.json({ 
      message: 'Expired tasks processed',
      count: expiredTasks?.length || 0
    });
  } catch (error) {
    console.error('Cron expire error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// チャットトリムAPI（古いチャットの削除）
app.post('/api/cron/trim-chats', async (req, res) => {
  const { userId, keep = 200 } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const { data: ids } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (!ids?.length) return res.json({ deleted: 0 });

  const toDelete = ids.slice(keep).map(r => r.id);
  if (!toDelete.length) return res.json({ deleted: 0 });

  await supabase.from('chat_messages').delete().in('id', toDelete);
  res.json({ deleted: toDelete.length });
});

// デバッグ用エンドポイント
app.get('/api/debug', (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  res.json({
    stripeKeyLength: stripeKey?.length,
    stripeKeyPrefix: stripeKey?.substring(0, 10),
    stripeKeySuffix: stripeKey?.substring(stripeKey.length - 10),
    stripeKeyHasNewline: stripeKey?.includes('\n'),
    stripeKeyHasCarriageReturn: stripeKey?.includes('\r'),
    stripeKeyCharCodes: stripeKey?.split('').slice(0, 20).map(c => c.charCodeAt(0)),
    stripePriceId: process.env.STRIPE_PRICE_ID,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 10)
  });
});

// 日付解析デバッグ用エンドポイント
app.get('/api/debug/date', (req, res) => {
  const { input } = req.query;
  if (!input) {
    return res.json({ error: 'input parameter required' });
  }
  
  try {
    const normalized = normalizeJa(input);
    const results = chrono.ja.parse(normalized, new Date(), { forwardDate: true });
    
    res.json({
      input,
      normalized,
      results: results.map(r => ({
        text: r.text,
        start: r.start ? {
          year: r.start.get('year'),
          month: r.start.get('month'),
          day: r.start.get('day'),
          hour: r.start.get('hour'),
          minute: r.start.get('minute'),
          isCertain: {
            year: r.start.isCertain('year'),
            month: r.start.isCertain('month'),
            day: r.start.isCertain('day'),
            hour: r.start.isCertain('hour'),
            minute: r.start.isCertain('minute')
          }
        } : null
      }))
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Stripe Webhookデバッグ用エンドポイント
app.get('/api/debug/stripe', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('stripe_events')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(20);

    if (error) {
      return res.json({ error: error.message });
    }

    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, line_user_id, subscription_status, subscription_id, updated_at')
      .eq('subscription_status', 'pro')
      .order('updated_at', { ascending: false })
      .limit(10);

    if (profileError) {
      return res.json({ error: profileError.message });
    }

    res.json({
      recent_events: events || [],
      pro_profiles: profiles || [],
      total_events: events?.length || 0,
      total_pro_profiles: profiles?.length || 0
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// 課金状況確認エンドポイント（ポーリング用）
app.get('/api/check-subscription', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    
    if (!lineUserId) {
      return res.status(400).json({ error: 'lineUserId is required' });
    }

    // プロフィールを取得
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('subscription_status, subscription_id, updated_at')
      .eq('line_user_id', lineUserId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      subscription_status: profile.subscription_status,
      subscription_id: profile.subscription_id,
      updated_at: profile.updated_at,
      is_pro: profile.subscription_status === 'pro'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 手動プロプランアップグレード用エンドポイント（緊急時用）
app.post('/api/admin/upgrade', async (req, res) => {
  try {
    const { line_user_id, subscription_id } = req.body;
    
    if (!line_user_id) {
      return res.status(400).json({ error: 'line_user_id is required' });
    }

    // プロフィールを検索
    const { data: profile, error: findError } = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', line_user_id)
      .single();

    if (findError || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // プロプランにアップグレード
    const { data: updatedProfile, error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'pro',
        subscription_id: subscription_id || 'manual_upgrade',
        updated_at: new Date().toISOString()
      })
      .eq('id', profile.id)
      .select();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    // LINEに通知
    try {
      await client.pushMessage(line_user_id, {
        type: 'text',
        text: '🎉 プロプランにアップグレード完了！\n\nこれでAIチャットが無制限で利用できます。\n\n「こんにちは」と送信して、超厳しいAI指導官と対話を始めましょう！'
      });
    } catch (pushError) {
      console.error('Failed to send notification:', pushError);
    }

    res.json({
      success: true,
      profile: updatedProfile[0],
      message: 'Profile upgraded to pro successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// リマインダーデバッグ用エンドポイント
app.get('/api/debug/reminders', async (req, res) => {
  try {
    const now = dayjs().utc().toISOString();
    console.log('[DEBUG] Current time (UTC):', now);
    
    // 全てのリマインダーを取得
    const { data: allReminders, error: allError } = await supabase
      .from('task_reminders')
      .select(`
        *,
        tasks!inner(title, status, end_at),
        profiles!inner(line_user_id, display_name)
      `)
      .order('run_at', { ascending: true });
    
    if (allError) {
      console.error('Error fetching all reminders:', allError);
      return res.status(500).json({ error: 'Failed to fetch reminders' });
    }
    
    // 送信対象のリマインダーを取得
    const { data: pendingReminders, error: pendingError } = await supabase
      .from('task_reminders')
      .select(`
        *,
        tasks!inner(title, status, end_at),
        profiles!inner(line_user_id, display_name)
      `)
      .lte('run_at', now)
      .is('sent_at', null);
    
    if (pendingError) {
      console.error('Error fetching pending reminders:', pendingError);
      return res.status(500).json({ error: 'Failed to fetch pending reminders' });
    }
    
    res.json({
      currentTime: now,
      allReminders: allReminders?.map(r => ({
        id: r.id,
        kind: r.kind,
        run_at: r.run_at,
        sent_at: r.sent_at,
        task_title: r.tasks.title,
        task_status: r.tasks.status,
        task_end_at: r.tasks.end_at,
        user_id: r.profiles.line_user_id
      })),
      pendingReminders: pendingReminders?.map(r => ({
        id: r.id,
        kind: r.kind,
        run_at: r.run_at,
        task_title: r.tasks.title,
        task_status: r.tasks.status,
        task_end_at: r.tasks.end_at,
        user_id: r.profiles.line_user_id
      })),
      summary: {
        total: allReminders?.length || 0,
        pending: pendingReminders?.length || 0,
        sent: (allReminders?.length || 0) - (pendingReminders?.length || 0)
      }
    });
  } catch (error) {
    console.error('Debug reminders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stripe Checkout作成エンドポイント
app.get('/api/checkout', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    
    if (!lineUserId) {
      return res.status(400).send(`
        <html>
          <head>
            <title>エラー</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #FF6B6B; font-size: 24px; margin-bottom: 20px; }
            </style>
          </head>
          <body>
            <div class="error">❌ エラー: Line user ID is required</div>
          </body>
        </html>
      `);
    }

    // プロフィールを取得
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single();

    if (profileError || !profile) {
      return res.status(404).send(`
        <html>
          <head>
            <title>エラー</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #FF6B6B; font-size: 24px; margin-bottom: 20px; }
            </style>
          </head>
          <body>
            <div class="error">❌ エラー: Profile not found</div>
          </body>
        </html>
      `);
    }

    // Stripe Checkout Sessionを作成
    const origin = buildSafeOrigin();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      allow_promotion_codes: true, // プロモーションコード機能を有効化
      success_url: new URL(`/success?session_id={CHECKOUT_SESSION_ID}`, origin).toString(),
      cancel_url: new URL('/cancel', origin).toString(),
      metadata: {
        line_user_id: lineUserId,
        profile_id: profile.id
      }
    });

    // Stripe Checkoutページにリダイレクト
    res.redirect(session.url);
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>エラー</title>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #FF6B6B; font-size: 24px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="error">❌ エラー: Failed to create checkout session</div>
        </body>
      </html>
    `);
  }
});

// 決済成功ページ（即座にアップグレード処理）
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  
  if (session_id) {
    try {
      // Stripeセッションを取得
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const lineUserId = session.metadata?.line_user_id;
      const profileId = session.metadata?.profile_id;
      
      if (lineUserId && profileId) {
        console.log('[SUCCESS] Immediate upgrade processing for:', lineUserId);
        
        // 即座にプロフィールをアップグレード
        const { data: updatedProfile, error: updateError } = await supabase
          .from('profiles')
          .update({ 
            subscription_status: 'pro',
            subscription_id: session.subscription,
            updated_at: new Date().toISOString()
          })
          .eq('id', profileId)
          .select();

        if (!updateError && updatedProfile && updatedProfile.length > 0) {
          console.log('[SUCCESS] Profile upgraded immediately:', updatedProfile[0]);
          
          // LINEに即座に通知
          try {
            await client.pushMessage(lineUserId, {
              type: 'text',
              text: '🎉 プロプランにアップグレード完了！\n\nこれでAIチャットが無制限で利用できます。\n\n「こんにちは」と送信して、超厳しいAI指導官と対話を始めましょう！'
            });
            console.log('[SUCCESS] LINE notification sent');
          } catch (pushError) {
            console.error('[SUCCESS] Failed to send LINE notification:', pushError);
          }
        } else {
          console.error('[SUCCESS] Failed to upgrade profile:', updateError);
        }
      }
    } catch (error) {
      console.error('[SUCCESS] Error processing immediate upgrade:', error);
    }
  }
  
  res.send(`
    <html>
      <head>
        <title>決済完了</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: #1DB446; font-size: 24px; margin-bottom: 20px; }
          .message { font-size: 16px; color: #666; }
          .loading { color: #FFA500; font-size: 18px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="success">✅ 決済が完了しました！</div>
        <div class="message">プロプランにアップグレードされました。<br>LINEアプリに戻ってお試しください。</div>
        <div class="loading">⏳ アップグレード処理中...</div>
        <div id="status" style="margin-top: 10px; font-size: 14px;"></div>
        <script>
          // ポーリングで課金状況を確認
          const lineUserId = '${session.metadata?.line_user_id || ''}';
          let pollCount = 0;
          const maxPolls = 10; // 最大10回（約30秒）
          
          function checkSubscription() {
            if (pollCount >= maxPolls) {
              document.getElementById('status').innerHTML = '⏰ タイムアウトしました。LINEアプリに戻ってお試しください。';
              setTimeout(() => window.location.href = 'line://', 2000);
              return;
            }
            
            pollCount++;
            document.getElementById('status').innerHTML = \`⏳ 確認中... (\${pollCount}/\${maxPolls})\`;
            
            fetch(\`/api/check-subscription?lineUserId=\${lineUserId}\`)
              .then(response => response.json())
              .then(data => {
                if (data.is_pro) {
                  document.getElementById('status').innerHTML = '✅ アップグレード完了！LINEアプリに戻ります...';
                  setTimeout(() => window.location.href = 'line://', 2000);
                } else {
                  setTimeout(checkSubscription, 3000); // 3秒後に再確認
                }
              })
              .catch(error => {
                console.error('Polling error:', error);
                setTimeout(checkSubscription, 3000);
              });
          }
          
          // 初回チェックを開始
          if (lineUserId) {
            setTimeout(checkSubscription, 1000); // 1秒後に開始
          } else {
            // フォールバック: 3秒後にLINEアプリに戻る
            setTimeout(() => window.location.href = 'line://', 3000);
          }
        </script>
      </body>
    </html>
  `);
});

// 決済キャンセルページ
app.get('/cancel', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>決済キャンセル</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .cancel { color: #FF6B6B; font-size: 24px; margin-bottom: 20px; }
          .message { font-size: 16px; color: #666; }
        </style>
      </head>
      <body>
        <div class="cancel">❌ 決済がキャンセルされました</div>
        <div class="message">LINEアプリに戻ってお試しください。</div>
      </body>
    </html>
  `);
});

// Stripe Webhookエンドポイント
app.post('/api/stripe/webhook', (req, res) => {
  console.log('=== Webhook received ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  const sig = req.headers['stripe-signature'];
  console.log('Stripe signature:', sig);
  console.log('Webhook secret exists:', !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log('Webhook secret length:', process.env.STRIPE_WEBHOOK_SECRET?.length);
  console.log('Webhook secret prefix:', process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 10));
  
  let event;

  try {
    // 署名検証を有効化
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      console.log('Verifying Stripe signature...');
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      console.log('Signature verification successful');
    } else {
      console.log('Warning: STRIPE_WEBHOOK_SECRET not set, skipping signature verification');
      // イベントオブジェクトを直接作成
      if (Buffer.isBuffer(req.body)) {
        event = JSON.parse(req.body.toString('utf8'));
      } else {
        event = req.body;
      }
    }
    
    console.log('Event type:', event.type);
    console.log('Event ID:', event.id);
    console.log('Event data:', JSON.stringify(event.data, null, 2));
  } catch (err) {
    console.error('Webhook signature verification failed:', err?.message);
    console.error('Error details:', err);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  // 即座に200を返してStripeの再送を止める
  res.status(200).json({ received: true });
  console.log('Webhook acknowledged, processing asynchronously...');
  
  // 重要なイベントは即座に処理
  if (event.type === 'checkout.session.completed') {
    console.log('[WEBHOOK] High priority event, processing immediately...');
  }

  // 以降は非同期で安全に処理（awaitしない）
  (async () => {
    try {
      console.log(`[WEBHOOK] Processing event: ${event.type} (${event.id})`);
      
      // 冪等化：同じイベントの重複処理を防ぐ
      const { data: existed, error: checkError } = await supabase
        .from('stripe_events')
        .select('id')
        .eq('id', event.id)
        .maybeSingle();

      if (checkError) {
        console.error('[WEBHOOK] Error checking existing event:', checkError);
        return;
      }

      if (existed) {
        console.log('[WEBHOOK] Event already processed:', event.id);
        return;
      }

      // イベントを記録
      const { error: insertError } = await supabase
        .from('stripe_events')
        .insert({
          id: event.id,
          type: event.type,
          data: event.data,
          processed_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('[WEBHOOK] Error inserting event record:', insertError);
        return;
      }

      // 実処理
      if (event.type === 'checkout.session.completed') {
        console.log('[WEBHOOK] Processing checkout.session.completed event');
        const session = event.data.object;
        const lineUserId = session.metadata?.line_user_id;
        const profileId = session.metadata?.profile_id;

        console.log('[WEBHOOK] Line user ID:', lineUserId);
        console.log('[WEBHOOK] Profile ID:', profileId);
        console.log('[WEBHOOK] Subscription ID:', session.subscription);
        console.log('[WEBHOOK] Session status:', session.payment_status);

        if (!lineUserId || !profileId) {
          console.error('[WEBHOOK] Missing required metadata:', { lineUserId, profileId });
          return;
        }

        // プロフィールをProに更新
        console.log('[WEBHOOK] Updating profile to pro status...');
        const { data: updatedProfile, error: updateError } = await supabase
          .from('profiles')
          .update({ 
            subscription_status: 'pro',
            subscription_id: session.subscription,
            updated_at: new Date().toISOString()
          })
          .eq('id', profileId)
          .select();

        if (updateError) {
          console.error('[WEBHOOK] Error updating profile:', updateError);
          return;
        }

        if (!updatedProfile || updatedProfile.length === 0) {
          console.error('[WEBHOOK] No profile found with ID:', profileId);
          return;
        }

        console.log('[WEBHOOK] Profile updated successfully:', updatedProfile[0]);

        // LINEに通知メッセージを送信
        if (lineUserId) {
          try {
            console.log('[WEBHOOK] Sending success notification to user...');
            const pushResult = await client.pushMessage(lineUserId, {
              type: 'text',
              text: '🎉 プロプランにアップグレード完了！\n\nこれでAIチャットが無制限で利用できます。\n\n「こんにちは」と送信して、超厳しいAI指導官と対話を始めましょう！'
            });
            console.log('[WEBHOOK] Success notification sent:', pushResult);
          } catch (pushError) {
            console.error('[WEBHOOK] Error sending success notification:', pushError);
            console.error('[WEBHOOK] Push error details:', JSON.stringify(pushError, null, 2));
            // 通知の失敗は致命的ではないので、処理を続行
          }
        }

        console.log(`[WEBHOOK] Profile ${profileId} upgraded to Pro successfully`);
      } else if (event.type === 'customer.subscription.created') {
        console.log('Processing customer.subscription.created event');
        const subscription = event.data.object;
        console.log('Subscription ID:', subscription.id);
        console.log('Customer ID:', subscription.customer);
        console.log('Status:', subscription.status);
      } else if (event.type === 'invoice.payment_succeeded') {
        console.log('Processing invoice.payment_succeeded event');
        const invoice = event.data.object;
        console.log('Invoice ID:', invoice.id);
        console.log('Customer ID:', invoice.customer);
        console.log('Subscription ID:', invoice.subscription);
      }

      // 処理済みマーク（テーブルが存在しない場合はスキップ）
      try {
        await supabase.from('stripe_events').insert({ 
          id: event.id, 
          type: event.type, 
          received_at: new Date().toISOString() 
        });
        console.log('Event marked as processed:', event.id);
      } catch (insertError) {
        console.log('Could not insert event record (table may not exist):', insertError.message);
      }

    } catch (e) {
      // ここで失敗してもStripeには既に200を返しているので再送は発生しない
      console.error('[WEBHOOK] Async webhook handling error:', e);
      console.error('[WEBHOOK] Error stack:', e.stack);
      console.error('[WEBHOOK] Event that failed:', JSON.stringify(event, null, 2));
      
      // エラーをデータベースに記録
      try {
        await supabase
          .from('stripe_events')
          .update({
            error_message: e.message,
            error_stack: e.stack,
            processed_at: new Date().toISOString()
          })
          .eq('id', event.id);
      } catch (dbError) {
        console.error('[WEBHOOK] Failed to record error in database:', dbError);
      }
    }
  })();
});

// 自己診断エンドポイント
app.get('/api/debug/upgrade-selftest', (req, res) => {
  const fromReq = `${(req.headers['x-forwarded-proto']||'https').toString().split(',')[0]}://${(req.headers['x-forwarded-host']||req.headers.host||'').toString()}`;
  const reqOrigin = sanitizeOrigin(fromReq);
  const envRaw = (process.env.CHECKOUT_BASE_URL || process.env.VERCEL_URL || '').toString();
  const envBytes = Array.from(envRaw).map(c=>c.charCodeAt(0));
  let envOrigin = null, err = null;
  try { envOrigin = buildSafeOrigin(); } catch(e){ err = e.message; }

  res.json({
    fromReq_raw: fromReq,
    fromReq_sanitized: reqOrigin,
    env_raw: envRaw,
    env_raw_charCodes_first50: envBytes.slice(0,50),
    env_origin_after_sanitize: envOrigin,
    env_build_error: err
  });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
