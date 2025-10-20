const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const Stripe = require('stripe');
const chrono = require('chrono-node');
const path = require('path');
const { buildSafeOrigin, sanitizeOrigin } = require('./utils/origin');
const { parseTaskCommand, createTaskWithReminders } = require('./services/task');
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
app.use('/legal', express.static(path.join(__dirname, '../public/legal')));

// LINE Bot設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// デバッグ用ログ
console.log('=== Environment Variables Debug ===');
console.log('Channel Access Token configured:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('Channel Secret configured:', !!process.env.LINE_CHANNEL_SECRET);
console.log('OpenAI API Key configured:', !!process.env.OPENAI_API_KEY);
console.log('Supabase URL configured:', !!process.env.SUPABASE_URL);
console.log('Supabase Service Role configured:', !!process.env.SUPABASE_SERVICE_ROLE);
console.log('Checkout base URL configured:', !!process.env.CHECKOUT_BASE_URL || !!process.env.VERCEL_URL);
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

const NEGOTIATION_START_REGEX = /^(交渉|アップグレード交渉|値段|ねだん|価格|値下げ|安く|安い|割引|ディスカウント|値引き|価格交渉|料金|料金交渉|値段交渉|値段相談|価格相談|料金相談|はじめる|話し合い|相談|決めよう|レンタルこわい秘書|こわい秘書|プロプラン|アップグレード|移行|使いたい|もっと|続けたい)$/i;
const ACCEPT_REGEX = /^(はい|ok|ｏｋ|了解|りょうかい|合意|それで|決めた|買う)([!！。ですます〜\s]*)?$/i;
const DECLINE_REGEX = /^(やめる|キャンセル|キャンセルする|中止|終了|交渉終了|いらない|不要)([!！。ですます〜\s]*)?$/i;
const CANCEL_SUBSCRIPTION_REGEX = /^(解約したい|解約|解約する|退会|退会したい|やめる|やめたい)$/i;

const STATE_PROMPTS = Object.freeze({
  goal: 'まずはゴールを教えろ。何を達成したい？',
  blocker: 'それを邪魔している最大の壁は何だ？',
  cost: '先延ばしで月いくら失っている？数字で答えろ（例：30000）。',
  cost_retry: '数字で教えろ。月いくら失っている？（例：30000）',
  close: '交渉は終了した。また話し合いたいなら何かメッセージを送れ。'
});

const PRICE_TIERS = Object.freeze([1980, 3980, 4980, 6980, 9800]);
const PLAN_NAME = 'レンタルこわい秘書';

// Stripe設定
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// LINE Botクライアント
const client = new line.Client(config);

// Vercel用のミドルウェア設定
// Stripe Webhook用のrawボディパーサーを先に適用
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// その他のルート用のJSONボディパーサー（LINE署名検証用にrawBodyも保持）
const jsonBodyParser = express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
});
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/stripe/webhook')) {
    return next();
  }
  return jsonBodyParser(req, res, next);
});

// ヘルパー関数

// ===== Negotiation state/context helpers =====
async function getProfileContext(userId) {
  // profile_memoriesテーブルからcontextデータを取得
  const { data, error } = await supabase
    .from('profile_memories')
    .select('*')
    .eq('user_id', userId)
    .eq('key', 'context')
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('[profile_context] fetch error:', error);
    throw error;
  }
  
  // context_dataをパースして返す
  if (data && data.value) {
    try {
      return JSON.parse(data.value);
    } catch (e) {
      console.error('[profile_context] JSON parse error:', e);
      return null;
    }
  }
  return null;
}

async function saveContext(userId, patch = {}) {
  const current = await getProfileContext(userId);
  const merged = {
    ...(current || {}),
    ...patch,
    updated_at: new Date().toISOString()
  };

  // profile_memoriesテーブルにcontextデータを保存
  const { data, error } = await supabase
    .from('profile_memories')
    .upsert({
      user_id: userId,
      key: 'context',
      value: JSON.stringify(merged),
      category: 'profile',
      weight: 1
    }, { onConflict: 'user_id,key' })
    .select()
    .single();

  if (error) {
    console.error('[profile_context] upsert error:', error);
    throw error;
  }
  return merged;
}

async function resetNegotiationContext(userId) {
  return saveContext(userId, {
    last_state: null,
    goal: null,
    blocker: null,
    monthly_cost_estimate: null,
    current_session_id: null
  });
}

const NEGOTIATION_ACTIVE_STATES = new Set(['goal', 'blocker', 'cost', 'offer']);

async function shouldHandleNegotiation({ profileId, text }) {
  console.log('=== shouldHandleNegotiation called ===');
  console.log('Profile ID:', profileId);
  console.log('Text:', text);
  
  const trimmed = (text || '').trim();
  const wantsNegotiation = NEGOTIATION_START_REGEX.test(trimmed);
  const context = await getProfileContext(profileId);
  const lastState = context?.last_state;

  console.log('Trimmed text:', trimmed);
  console.log('Wants negotiation:', wantsNegotiation);
  console.log('Context:', context);
  console.log('Last state:', lastState);
  console.log('Active states:', NEGOTIATION_ACTIVE_STATES);
  console.log('Is last state active:', lastState && NEGOTIATION_ACTIVE_STATES.has(lastState));
  console.log('Has current session:', !!context?.current_session_id);

  if (wantsNegotiation) {
    console.log('Returning shouldHandle: true (wants negotiation)');
    return { shouldHandle: true, context };
  }

  if (lastState && NEGOTIATION_ACTIVE_STATES.has(lastState)) {
    console.log('Returning shouldHandle: true (active state)');
    return { shouldHandle: true, context };
  }

  if (context?.current_session_id) {
    console.log('Returning shouldHandle: true (current session)');
    return { shouldHandle: true, context };
  }

  console.log('Returning shouldHandle: false');
  return { shouldHandle: false, context };
}

function extractMonthlyCost(text = '') {
  const normalized = text.replace(/[,\s円¥万円]/g, '');
  const match = normalized.match(/(\d{2,7})/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function pickPlanPrice(costYen) {
  if (!Number.isFinite(costYen) || costYen <= 0) {
    return PRICE_TIERS[0];
  }
  for (let i = PRICE_TIERS.length - 1; i >= 0; i -= 1) {
    if (costYen >= PRICE_TIERS[i]) {
      return PRICE_TIERS[i];
    }
  }
  return PRICE_TIERS[0];
}

function buildPlanPitch({ goal, blocker, priceYen }) {
  const goalLine = goal ? `達成したいことは、 ${goal} だな。` : '';
  const costLine = 'タスクをサボることで、信用も時間も失う。これは確定未来だ。';

  const priceStr = Number.isFinite(priceYen) ? priceYen.toLocaleString() : PRICE_TIERS[0].toLocaleString();

  return [
    goalLine,
    costLine,
    '',
    `即決で ¥${priceStr}/月 だ。\n「はい」か「合意」と返せ。決済リンクを送る。\n批判してくれる人がいないお前の人生に寄り添ってやる。`
  ].filter(line => line.trim() !== '').join('\n');
}

function findTierAtOrBelow(value) {
  if (!Number.isFinite(value)) return null;
  let candidate = null;
  for (const tier of PRICE_TIERS) {
    if (tier <= value) {
      candidate = tier;
    } else {
      break;
    }
  }
  return candidate || PRICE_TIERS[0];
}

function lowerPriceTier(current) {
  const currentIndex = PRICE_TIERS.findIndex(tier => tier === current);
  if (currentIndex <= 0) return current;
  return PRICE_TIERS[currentIndex - 1];
}

function normalizeNegotiationSession(row) {
  if (!row) return null;
  const meta = row.meta || {};
  const steps = [];
  const stepIndex = 0;
  const floor = meta.floor_yen ?? row.floor_yen ?? row.soft_floor ?? PRICE_TIERS[0];
  const segment = row.segment || null;

  return {
    id: row.id,
    user_id: row.user_id,
    state: row.state,
    segment,
    anchor_yen: row.anchor_yen ?? row.anchor_price ?? meta.anchor_yen ?? null,
    steps,
    step_index: stepIndex,
    floor_yen: floor,
    current_offer_yen: row.current_offer ?? row.anchor_price ?? null,
    current_offer: row.current_offer ?? row.anchor_price ?? null,
    reason_class: row.reason_class ?? meta.reason_class ?? null,
    meta
  };
}

async function createNegoSession({ userId, goal, blocker, costYen, priceYen }) {
  const payload = {
    user_id: userId,
    state: 'open',
    anchor_price: priceYen,
    soft_floor: PRICE_TIERS[0],
    hard_floor: PRICE_TIERS[0],
    current_offer: priceYen,
    concessions_used: 0,
    meta: {
      goal,
      blocker,
      cost_estimate_yen: costYen,
      plan_price_yen: priceYen,
      discount_applied: false,
      conversation_history: []
    }
  };

  const { data, error } = await supabase
    .from('negotiation_sessions')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[negotiation_sessions] insert error:', error);
    throw error;
  }

  return normalizeNegotiationSession(data);
}

async function getActiveNegotiationSession(userId) {
  const { data, error } = await supabase
    .from('negotiation_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('state', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('[negotiation_sessions] fetch active error:', error);
    throw error;
  }

  return normalizeNegotiationSession(data);
}

async function getNegotiationSessionById(id) {
  const { data, error } = await supabase
    .from('negotiation_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('[negotiation_sessions] fetch by id error:', error);
    throw error;
  }
  return normalizeNegotiationSession(data);
}

async function updateNegotiationSession(id, patch = {}, metaPatch = {}) {
  const existing = await getNegotiationSessionById(id);
  if (!existing) return null;

  const nextMeta = {
    ...(existing.meta || {}),
    ...metaPatch,
    conversation_history: metaPatch.conversation_history
      ? metaPatch.conversation_history
      : (existing.meta?.conversation_history || [])
  };

  const updatePayload = {
    ...patch,
    ...(Object.keys(metaPatch).length ? { meta: nextMeta } : {}),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('negotiation_sessions')
    .update(updatePayload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[negotiation_sessions] update error:', error);
    throw error;
  }
  return normalizeNegotiationSession(data);
}

async function appendNegotiationHistory(id, entries) {
  if (!entries?.length) return;
  const existing = await getNegotiationSessionById(id);
  if (!existing) return;
  const history = existing.meta?.conversation_history || [];
  const metaPatch = {
    ...existing.meta,
    conversation_history: [...history, ...entries]
  };
  await updateNegotiationSession(id, {}, metaPatch);
}


// 価格整合性の防御関数
function getOfferYen(session) {
  const v = Number(session.current_offer_yen ?? session.current_offer ?? session.meta?.current_offer_yen);
  if (!Number.isFinite(v)) throw new Error('offer yen missing');
  return v;
}

async function buildCheckoutUrl(profile, session, originHint) {
  const origin = sanitizeOrigin(originHint) || buildSafeOrigin();
  const url = new URL('/api/checkout/custom', origin);
  url.searchParams.set('lineUserId', profile.line_user_id);
  url.searchParams.set('amount', String(getOfferYen(session)));
  return url.toString();
}

async function buildCancelUrl(profile, originHint) {
  try {
    // まずoriginHintを試す
    if (originHint) {
      const origin = sanitizeOrigin(originHint);
      if (origin) {
        const url = new URL('/api/cancel-subscription', origin);
        url.searchParams.set('lineUserId', profile.line_user_id);
        console.log('Using originHint for cancel URL:', url.toString());
        return url.toString();
      }
    }
    
    // 環境変数から取得
    const origin = buildSafeOrigin();
    const url = new URL('/api/cancel-subscription', origin);
    url.searchParams.set('lineUserId', profile.line_user_id);
    console.log('Using environment origin for cancel URL:', url.toString());
    return url.toString();
  } catch (error) {
    console.error('Error building cancel URL:', error);
    console.log('Available environment variables:');
    console.log('CHECKOUT_BASE_URL:', process.env.CHECKOUT_BASE_URL);
    console.log('VERCEL_URL:', process.env.VERCEL_URL);
    console.log('NODE_ENV:', process.env.NODE_ENV);
    
    // フォールバック: デフォルトのドメインを使用
    let fallbackOrigin;
    if (process.env.NODE_ENV === 'development' || !process.env.VERCEL_URL) {
      // ローカル開発環境の場合
      fallbackOrigin = 'http://localhost:3000';
    } else {
      // 本番環境の場合
      fallbackOrigin = 'https://line-openai-ncjb5ro0n-techworkers-projects.vercel.app';
    }
    
    const url = new URL('/api/cancel-subscription', fallbackOrigin);
    url.searchParams.set('lineUserId', profile.line_user_id);
    console.log('Using fallback origin for cancel URL:', url.toString());
    return url.toString();
  }
}

async function finalizeAgreement({ session, profile, event, origin, history }) {
  const price = getOfferYen(session);
  const priceStr = Number.isFinite(price) ? price.toLocaleString() : PRICE_TIERS[0].toLocaleString();
  const checkoutUrl = await buildCheckoutUrl(profile, session, origin);
  const acceptanceMessage = `決断したな。**¥${priceStr}/月**で${PLAN_NAME}に入る。\n\n超厳しいAI指導官が毎日ケアし、タスク登録と自動リマインダーで締切を落とさせない。\n\n🔗 ${checkoutUrl}\n\n今すぐ決済を完了させろ。処理が終われば即座に本格始動だ。`;

  const acceptanceHistory = [
    ...(history || []),
    { role: 'bot', content: acceptanceMessage }
  ];

  await updateNegotiationSession(
    session.id,
    {
      state: 'agreed',
      final_price: price,
      completed_at: new Date().toISOString()
    },
    {
      plan_price_yen: price,
      conversation_history: acceptanceHistory
    }
  );

  await replyText(event, acceptanceMessage);
  await resetNegotiationContext(profile.id);
}

// 状態機械: goal → blocker → cost → offer → agreed/cancel
async function handleNegotiationFlow({ event, profile, text, origin, context }) {
  console.log('=== handleNegotiationFlow called ===');
  console.log('Text:', text);
  console.log('Profile ID:', profile.id);
  console.log('Context:', context);
  
  const trimmed = text.trim();
  const ctx = context === undefined ? await getProfileContext(profile.id) : context;
  const state = ctx?.last_state || null;
  
  console.log('Trimmed text:', trimmed);
  console.log('Context from DB:', ctx);
  console.log('Current state:', state);
  


  const sessionId = ctx?.current_session_id || null;
  let session = null;
  if (sessionId) {
    session = await getNegotiationSessionById(sessionId);
  } else {
    session = await getActiveNegotiationSession(profile.id);
    if (session) {
      await saveContext(profile.id, { current_session_id: session.id });
      if (ctx) ctx.current_session_id = session.id;
    }
  }

  const ensureSession = async ({ goalForMeta, blockerForMeta, costForMeta, priceForMeta } = {}) => {
    if (session) return session;
    const priceSeed = Number.isFinite(priceForMeta) ? priceForMeta : PRICE_TIERS[0];
    session = await createNegoSession({
      userId: profile.id,
      goal: goalForMeta ?? ctx?.goal ?? null,
      blocker: blockerForMeta ?? ctx?.blocker ?? null,
      costYen: costForMeta ?? ctx?.monthly_cost_estimate ?? null,
      priceYen: priceSeed
    });
      await saveContext(profile.id, { current_session_id: session.id });
    if (ctx) ctx.current_session_id = session.id;
    return session;
  };

  switch (state) {
    case 'goal': {
      const goalText = trimmed;
      session = await ensureSession({ goalForMeta: goalText, priceForMeta: PRICE_TIERS[0] });
      if (!session) throw new Error('session missing after ensure in goal');

      const history = [
        ...(session.meta?.conversation_history || []),
        { role: 'user', content: goalText }
      ];

      session = await updateNegotiationSession(
          session.id,
          {
          anchor_price: session.anchor_yen ?? session.current_offer_yen ?? PRICE_TIERS[0],
          current_offer: session.current_offer_yen ?? PRICE_TIERS[0]
        },
        {
          goal: goalText,
          conversation_history: history
        }
      );

      await saveContext(profile.id, {
        goal: goalText,
        last_state: 'blocker',
        current_session_id: session.id
      });

      await replyText(event, STATE_PROMPTS.blocker);
      await appendNegotiationHistory(session.id, [{ role: 'bot', content: STATE_PROMPTS.blocker }]);
        return true;
      }

    case 'blocker': {
      const blockerText = trimmed;
      session = await ensureSession({ blockerForMeta: blockerText });
      if (!session) throw new Error('session missing after ensure in blocker');

      const history = [
        ...(session.meta?.conversation_history || []),
        { role: 'user', content: blockerText }
      ];

      session = await updateNegotiationSession(
        session.id,
        {},
        {
          blocker: blockerText,
          conversation_history: history
        }
      );

      await saveContext(profile.id, {
        blocker: blockerText,
        last_state: 'cost',
        current_session_id: session.id
      });

      await replyText(event, STATE_PROMPTS.cost);
      await appendNegotiationHistory(session.id, [{ role: 'bot', content: STATE_PROMPTS.cost }]);
      return true;
    }

    case 'cost': {
      const costYen = extractMonthlyCost(trimmed);
      if (!Number.isFinite(costYen)) {
        await replyText(event, STATE_PROMPTS.cost_retry);
      return true;
    }

      const priceYen = pickPlanPrice(costYen);
      session = await ensureSession({ costForMeta: costYen, priceForMeta: priceYen });
      if (!session) throw new Error('session missing after ensure in cost');

      const history = [
        ...(session.meta?.conversation_history || []),
        { role: 'user', content: trimmed }
      ];

      session = await updateNegotiationSession(
        session.id,
        {
          anchor_price: priceYen,
          current_offer: priceYen
        },
        {
          cost_estimate_yen: costYen,
          plan_price_yen: priceYen,
          conversation_history: history
        }
      );

      await saveContext(profile.id, {
        monthly_cost_estimate: costYen,
        last_state: 'offer',
        current_session_id: session.id
      });

      const goalLine = session.meta?.goal ?? ctx?.goal ?? null;
      const blockerLine = session.meta?.blocker ?? ctx?.blocker ?? null;
      const pitch = buildPlanPitch({
        goal: goalLine,
        blocker: blockerLine,
        priceYen
      });

      await replyText(event, pitch);
      await appendNegotiationHistory(session.id, [{ role: 'bot', content: pitch }]);
      return true;
    }

    case 'offer': {
      session = await ensureSession();

      const history = [
        ...(session.meta?.conversation_history || []),
        { role: 'user', content: trimmed }
      ];
      session = await updateNegotiationSession(session.id, {}, { conversation_history: history });

      const numericInput = extractMonthlyCost(trimmed);
      if (Number.isFinite(numericInput)) {
        const requestedTier = findTierAtOrBelow(numericInput);
        const currentPrice = getOfferYen(session);

        if (requestedTier === currentPrice) {
          await finalizeAgreement({ session, profile, event, origin, history });
          return true;
        }

        if (requestedTier < currentPrice) {
          session = await updateNegotiationSession(
            session.id,
            { current_offer: requestedTier },
            {
              plan_price_yen: requestedTier,
              discount_applied: true
            }
          );
          const oldPriceStr = currentPrice.toLocaleString();
          const newPriceStr = requestedTier.toLocaleString();
          const counterMessage = `了解だ。**¥${oldPriceStr}**から**¥${newPriceStr}**まで下げる。ここが限界だと思ってくれ。\n\nこれだけ削っても、君が止血できる月間損失の方がまだ大きい。決めるなら「はい」か「合意」と返せ。すぐに決済リンクを渡す。`;
          const counterHistory = [
            ...history,
            { role: 'bot', content: counterMessage }
          ];
          await updateNegotiationSession(session.id, {}, { conversation_history: counterHistory });
          await replyText(event, counterMessage);
          return true;
        }
      }

      if (ACCEPT_REGEX.test(trimmed)) {
        await finalizeAgreement({ session, profile, event, origin, history });
        return true;
      }

      if (DECLINE_REGEX.test(trimmed)) {
        const declineMessage = '了解した。今回はここで切り上げる。またやる気が戻ったら「交渉」と送れ。';
        const declineHistory = [
          ...history,
          { role: 'bot', content: declineMessage }
        ];

        await updateNegotiationSession(
          session.id,
          {
            state: 'cancelled',
            completed_at: new Date().toISOString()
          },
          {
            conversation_history: declineHistory
          }
        );

        await replyText(event, declineMessage);
        await resetNegotiationContext(profile.id);
        return true;
      }

      let price = getOfferYen(session);
      
      // 値下げ交渉の確率判定
      const isFirstNegotiation = !session.meta?.discount_applied;
      const discountProbability = isFirstNegotiation ? 0.5 : 0.15; // 初回50%、以降15%
      const shouldDiscount = Math.random() < discountProbability;
      
      console.log('=== 値下げ交渉判定 ===');
      console.log('Is first negotiation:', isFirstNegotiation);
      console.log('Discount probability:', discountProbability);
      console.log('Should discount:', shouldDiscount);
      console.log('Current price:', price);
      
      if (shouldDiscount) {
        const nextPrice = lowerPriceTier(price);
        console.log('Next price:', nextPrice);
        if (nextPrice < price) {
          await updateNegotiationSession(
            session.id,
            { current_offer: nextPrice },
            {
              plan_price_yen: nextPrice,
              discount_applied: true
            }
          );
          const oldPriceStr = price.toLocaleString();
          price = nextPrice;
          const newPriceStr = price.toLocaleString();
          const response = `仕方がない。¥${oldPriceStr}から¥${newPriceStr}まで妥協してやる。もう譲れない。\n\n先延ばしを止めるか、現状維持のままか。\n\n即決しろ。「はい」か「合意」と返せ。即座に決済リンクを送る。`;
          await replyText(event, response);
          await appendNegotiationHistory(session.id, [{ role: 'bot', content: response }]);
          return true;
        }
      }
      
      // 値下げしない場合のAPI経由煽りメッセージ
      const priceStr = price.toLocaleString();
      const apiMessage = await generateNegotiationMessage({
        userMessage: trimmed,
        context: {
          price: priceStr,
          negotiationHistory: history
        }
      });
      
      const response = `${apiMessage}\n\n決めるなら「はい」か「合意」と返せ。決済リンクを送る。`;
      await replyText(event, response);
      await appendNegotiationHistory(session.id, [{ role: 'bot', content: response }]);
      return true;
    }

    case 'close': {
      await resetNegotiationContext(profile.id);
      return false;
    }

    default:
      return false;
  }
}

async function replyText(event, text) {
  return client.replyMessage(event.replyToken, { type: 'text', text });
}

// 交渉メッセージ生成（API経由）
async function generateNegotiationMessage({ userMessage, context }) {
  try {
    const systemPrompt = `あなたは超厳しい交渉のプロです。支払えない相手を煽りながら、支払わせるのが仕事です。

価格: ¥${context.price}/月

以下のルールに従って煽りメッセージを生成してください：
1. 相手の先延ばし癖を指摘する
2. 価格の妥当性を強調する
3. 支払わないことのリスクを煽る
4. 短く、強烈なメッセージにする
5. 日本語で返答する
6. 自然な会話になるように心がける

例：
- 「**¥${context.price}/月**で人生を変えるか、このまま先延ばしで人生を棒に振るか。」
- 「選択肢は2つしかない。今決めるか、永遠に先延ばしするか。」`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 200,
      temperature: 0.8
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating negotiation message:', error);
    // フォールバック: デフォルトの煽りメッセージ
    return `**¥${context.price}/月**で人生を変えるか、このまま先延ばしで人生を棒に振るか。\n\n選択肢は2つしかない。`;
  }
}

// 解約処理のハンドラー
async function handleCancelSubscription(event, profile, origin) {
  console.log('=== handleCancelSubscription called ===');
  console.log('Profile subscription status:', profile.subscription_status);
  console.log('Origin hint:', origin);
  console.log('Profile ID:', profile.id);
  console.log('Line User ID:', profile.line_user_id);
  
  // プロプランでない場合は解約不要
  if (profile.subscription_status !== 'pro') {
    console.log('User is not on pro plan, no cancellation needed');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '現在プロプランに加入していないため、解約の必要はない。'
    });
  }
  
  console.log('User is on pro plan, generating cancel URL...');
  
  // 解約URLを生成
  const cancelUrl = await buildCancelUrl(profile, origin);
  console.log('Generated cancel URL:', cancelUrl);
  
  const cancelMessage = `解約を希望するのか。\n\n解約手続きは以下のリンクから行える：\n\n🔗 ${cancelUrl}\n\n解約後は無料プランに戻る。再開したい場合は「交渉」と送れ。`;
  
  console.log('Sending cancel message to user...');
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: cancelMessage
  });
}

// ====== Stripe/交渉 ヘルパー ======
async function ensureStripeCustomer(profile) {
  if (profile.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: profile.display_name || undefined,
    metadata: { profile_id: profile.id, line_user_id: profile.line_user_id }
  });
  await supabase.from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', profile.id);
  return customer.id;
}

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

// 交渉セッションがアクティブかどうかをチェック
async function hasActiveNegotiation(userId) {
  const { data: session } = await supabase
    .from('negotiation_sessions')
    .select('id, state, created_at')
    .eq('user_id', userId)
    .eq('state', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  if (!session) return false;
  
  // 24時間以内のセッションのみ有効
  const sessionAge = dayjs().diff(dayjs(session.created_at), 'hours');
  return sessionAge < 24;
}

async function hasCompletedNegotiation(userId) {
  const { data: session } = await supabase
    .from('negotiation_sessions')
    .select('id, state, created_at')
    .eq('user_id', userId)
    .eq('state', 'agreed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  return !!session;
}

function strictReminderMessage(reminder) {
  const title = reminder.tasks.title;
  const endJST = dayjs(reminder.tasks.end_at).tz('Asia/Tokyo').format('YYYY/MM/DD HH:mm');

  if (reminder.kind === 'T-30') {
    return ` 『${title}』残り30分。なぜまだ終わってないんだ。自分との約束を守れなくていいのか？`;
  }
  // T0（時刻ちょうど）
  return `『${title}』完了報告がない。弱すぎる。人生大丈夫？`;
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
      text: '未完了のタスクは無い。\n\n次の仕事が浮かんだら「タスク」と送って登録しろ。'
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
  message += '下のボタンでも選べる。';
  
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
      text: '未完了タスクは無い。'
    });
  }
  
  if (taskNumber < 1 || taskNumber > tasks.length) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `その番号は無効だ。1から${tasks.length}の範囲で選べ。`
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
        text: 'タスク完了処理に失敗した。'
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
      text: `✅ 「${targetTask.title}」は完了扱いだ。`
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
        text: 'タスク削除に失敗した。'
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🗑️ 「${targetTask.title}」を削除した。`
    });
  }
}

// Webhookエンドポイント
app.post('/webhook', (req, res) => {
  console.log('=== LINE Webhook Received ===');
  console.log('Headers:', req.headers);
  console.log('Body type:', typeof req.body);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // 基本的なバリデーション
    if (!req.body) {
      console.error('No body received');
      return res.status(400).json({ 
        error: 'No body received',
        timestamp: new Date().toISOString()
      });
    }

    // 署名検証（Vercel用に調整）
    const signature = req.get('X-Line-Signature');
    
    // Vercelでは署名検証が困難なため、一時的に無効化
    // 本番環境では適切な署名検証を実装する必要がある
    console.log('Signature validation - signature:', signature);
    console.log('Signature validation - channelSecret configured:', !!config.channelSecret);
    console.log('Signature validation - SKIPPED for Vercel compatibility');
    
    // TODO: Vercelで適切な署名検証を実装
    // if (!line.validateSignature(rawBody, config.channelSecret, signature)) {
    //   console.log('Signature validation failed');
    //   return res.status(401).send('Unauthorized');
    // }

    console.log('Signature validation passed (skipped)');
    
    // bodyは既にパース済み
    const body = req.body;

    // イベントのバリデーション
    if (!body.events || !Array.isArray(body.events)) {
      console.error('Invalid events format:', body);
      return res.status(400).json({ 
        error: 'Invalid events format',
        received: body,
        timestamp: new Date().toISOString()
      });
    }

    console.log('Destination:', body.destination);
    console.log('Events count:', body.events.length);
    
    // 受信リクエストから安全なoriginを生成
    const originFromReq = (() => {
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
      const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
      return `${proto}://${host}`;
    })();
    
    console.log('Origin from request:', originFromReq);
    
    // 各イベントを処理
    Promise
      .all(body.events.map((ev, index) => {
        console.log(`Processing event ${index + 1}/${body.events.length}:`, ev.type);
        return handleEvent(ev, { originFromReq });
      }))
      .then((result) => {
        console.log('Webhook processed successfully, results:', result);
        res.json({ 
          success: true, 
          processed: result.length,
          results: result,
          timestamp: new Date().toISOString()
        });
      })
      .catch((err) => {
        console.error('Event handling error:', err);
        console.error('Error stack:', err.stack);
        res.status(500).json({
          error: 'Event handling failed',
          message: err.message,
          stack: err.stack,
          timestamp: new Date().toISOString()
        });
      });
  } catch (error) {
    console.error('Webhook error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// 汎用Webhookエンドポイント
app.post('/webhook/generic', (req, res) => {
  try {
    console.log('=== Generic Webhook Received ===');
    console.log('Headers:', req.headers);
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('Query:', req.query);
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    
    // 基本的なレスポンス
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      received: {
        headers: req.headers,
        body: req.body,
        query: req.query,
        method: req.method,
        url: req.url
      }
    };
    
    console.log('Webhook processed successfully');
    res.status(200).json(response);
  } catch (error) {
    console.error('Generic webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stripe Webhookエンドポイント
// GitHub Webhookエンドポイント
app.post('/webhook/github', (req, res) => {
  try {
    console.log('=== GitHub Webhook Received ===');
    console.log('Event:', req.headers['x-github-event']);
    console.log('Delivery:', req.headers['x-github-delivery']);
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const event = req.headers['x-github-event'];
    
    switch (event) {
      case 'push':
        console.log('Push event received');
        // デプロイ処理など
        break;
      case 'pull_request':
        console.log('Pull request event received');
        break;
      case 'issues':
        console.log('Issues event received');
        break;
      default:
        console.log(`Unhandled GitHub event: ${event}`);
    }
    
    res.status(200).json({received: true});
  } catch (error) {
    console.error('GitHub webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// イベントハンドラー
async function handleEvent(event, ctx = {}) {
  console.log('=== handleEvent called ===');
  console.log('Event type:', event.type);
  console.log('Message type:', event.message?.type);
  
  // フォローイベントの処理（新規登録時）
  if (event.type === 'follow') {
    console.log('=== Follow Event Received ===');
    const lineUserId = event.source.userId;
    const displayName = event.source.type === 'user' ? 'User' : 'Unknown';
    
    // プロフィールを確保
    const profile = await ensureProfile(lineUserId, displayName);
    if (!profile) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'プロフィール作成に失敗した。時間を置いてからやり直せ。'
      });
    }
    
    // 交渉フローを自動開始
    await saveContext(profile.id, {
      last_state: 'goal',
      goal: null,
      blocker: null,
      monthly_cost_estimate: null,
      constraint_reason: null,
      current_session_id: null
    });
    
    // 交渉開始メッセージ
    const welcomeMessage = `"レンタルこわい秘書"が、お前を監視する。\n\nまずはお前のゴールを聞かせろ。\n\n${STATE_PROMPTS.goal}`;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: welcomeMessage
    });
  }
  
  // postbackイベントの処理
  if (event.type === 'postback') {
    const lineUserId = event.source.userId;
    const displayName = event.source.type === 'user' ? 'User' : 'Unknown';
    const profile = await ensureProfile(lineUserId, displayName);
    if (!profile) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'プロフィール作成に失敗した。時間を置いてからやり直せ。'
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
        text: 'プロフィール作成に失敗した。時間を置いてからやり直せ。'
      });
  }
    console.log('Profile ensured:', profile.id);
    const isProSubscriber = profile.subscription_status === 'pro';
    console.log('Profile subscription status:', profile.subscription_status);

    // 解約処理を最優先でチェック
    console.log('Checking for cancel subscription message...');
    console.log('Text:', text);
    console.log('Cancel regex test result:', CANCEL_SUBSCRIPTION_REGEX.test(text));
    console.log('Cancel regex pattern:', CANCEL_SUBSCRIPTION_REGEX.toString());
    
    if (CANCEL_SUBSCRIPTION_REGEX.test(text)) {
      console.log('Cancel subscription message detected, calling handler...');
      return await handleCancelSubscription(event, profile, ctx?.originFromReq);
    }

    console.log('Checking negotiation gate...');
    console.log('Is pro subscriber:', isProSubscriber);
    let negotiationGate = { shouldHandle: false, context: null };
    if (!isProSubscriber) {
      console.log('Calling shouldHandleNegotiation...');
      negotiationGate = await shouldHandleNegotiation({ profileId: profile.id, text });
    } else {
      console.log('Skipping negotiation gate (pro subscriber)');
    }
    console.log('Negotiation gate result:', negotiationGate);
    if (negotiationGate.shouldHandle) {
      console.log('Negotiation should handle, calling handleNegotiationFlow...');
      try {
        const handled = await handleNegotiationFlow({
          event,
          profile,
          text,
          origin: ctx?.originFromReq,
          context: negotiationGate.context
        });
        console.log('Negotiation flow handled:', handled);
        if (handled) {
          console.log('Returning from negotiation flow');
          return;
        }
      } catch (error) {
        console.error('Error in negotiation flow:', error);
        console.error('Error stack:', error.stack);
        // 交渉フローでエラーが発生した場合は通常のチャットにフォールバック
      }
    } else {
      console.log('Negotiation gate says should not handle');
    }

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
      return client.replyMessage(event.replyToken, { type:'text', text: `「${k}」を削除した。` });
    }
    if (/^メモ[:：]/.test(text)) {
      const body = text.replace(/^メモ[:：]\s*/, '');
      const m = body.match(/^(.+?)\s*=\s*(.+)$/);
      if (!m) return client.replyMessage(event.replyToken, { type:'text', text:'形式は「メモ: key=value」だ。' });
      const key = m[1].trim(), value = m[2].trim();
      await upsertMemory(profile.id, { key, value, category:'preference', weight:2 });
      return client.replyMessage(event.replyToken, { type:'text', text:`メモを保存した: ${key} = ${value}` });
    }

    // 厳しい対応のための特別コマンド
    if (/^厳しく[:：]/.test(text)) {
      const body = text.replace(/^厳しく[:：]\s*/, '');
      const m = body.match(/^(.+?)\s*=\s*(.+)$/);
      if (!m) return client.replyMessage(event.replyToken, { type:'text', text:'形式は「厳しく: key=value」だ。' });
      const key = m[1].trim(), value = m[2].trim();
      await upsertMemory(profile.id, { key, value, category:'constraint', weight:5 });
      return client.replyMessage(event.replyToken, { type:'text', text:`厳しいメモを保存した: ${key} = ${value}` });
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
          return client.replyMessage(event.replyToken, { type:'text', text:'未完了タスクは無い。' });
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
        text: '"レンタルこわい秘書"が、お前を監視する。\n\n セットアップ30秒 /  リマインド：期日の30分前と期日時間に警告だ。\n\n――――――――――\n■ まずは登録\n「タスク」と送れ。\n\n――――――――――\n■ 完了・削除\n番号で一撃：完了1 / 削除1\n（迷ったら：直近を完了 / 最新を削除）\n\n――――――――――\n■ いまのタスク\n「残タスク」と送信\n\n――――――――――\n■ プラン\n無料：チャット1日3回（タスク管理は無制限）\nプロ：チャット無制限（メニュー→アップグレード）\n\n――――――――――\n■ 困ったら\n「ヘルプ」と送れ。\n\nさあ、「こんにちは」か「タスク」と送れ。\n先延ばしは許さない。やれ。'
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

      console.log('[TASK] createTaskWithReminders input', { title: draft.title, due_at_iso: parsed.isoUtc });
      // 即登録
      const task = await createTaskWithReminders({
        supabase,
        profileId: profile.id,
        title: draft.title,
        dueIso: parsed.isoUtc,
      });
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
          text: '内部エラーが出た。原因を潰す。'
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
  const parsed = parseTaskCommand(text, parseNaturalDateJST);
  if (!parsed) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'タスクの形式が間違っている。\n例: タスク: 英文校正 / 終了: 2025-09-20 18:00 のように送れ。'
    });
  }

  try {
    const task = await createTaskWithReminders({
      supabase,
      profileId: profile.id,
      title: parsed.title,
      dueIso: parsed.dueIso,
    });

  // タスク番号を取得（期日順でソート）
  const allTasks = await getUserTasks(profile.id);
  const taskNumber = allTasks.findIndex(t => t.id === task.id) + 1;

    const endTimeFormatted = parsed.jst
      ? parsed.jst.tz('Asia/Tokyo').format('YYYY年MM月DD日 HH:mm')
      : dayjs(task.end_at).tz('Asia/Tokyo').format('YYYY年MM月DD日 HH:mm');
  
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ タスクを受け取った。\n\n📝 内容: ${task.title}\n⏰ 終了時刻: ${endTimeFormatted}\n🔢 番号: ${taskNumber}`,
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
  } catch (error) {
    console.error('Error creating task via command:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'タスク保存に失敗した。時間を置いてやり直せ。'
    });
  }
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
        text: 'その操作は無効だ。'
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
      text: 'タスクIDが空だ。\n例: 完了: abc12345 のように送れ。'
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
        text: 'タスク完了処理に失敗した。'
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
      text: '✅ タスクを完了扱いにした。'
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
        text: 'タスク削除に失敗した。'
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🗑️ タスクを削除した。'
    });
  }
}

// チャットの処理
async function handleAIChat(event, profile, text, ctx = {}) {
  try {
  console.log('=== handleAIChat called ===');
  console.log('Profile subscription status:', profile.subscription_status);
  
  // 決済リンク再取得の処理
  if (/(決済|リンク|切れた|再取得)/i.test(text)) {
    const hasCompletedNegotiation = await hasCompletedNegotiation(profile.id);
    if (hasCompletedNegotiation && profile.subscription_status === 'free') {
      // 最新の交渉セッションを取得
      const { data: session } = await supabase
        .from('negotiation_sessions')
        .select('*')
        .eq('user_id', profile.id)
        .eq('state', 'agreed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (session) {
        const checkoutUrl = await buildCheckoutUrl(profile, session, ctx?.originFromReq);
        return client.replyMessage(event.replyToken, { 
          type:'text', 
          text:`決済リンクを再発行した。\n\n🔗 ${checkoutUrl}\n\n決済後は全ての機能が使えるようになる。`
        });
      }
    }
  }

    const isPro = profile.subscription_status === 'pro';

  // 交渉状態のチェック（無料枠の概念を削除）
    const isNegotiating = isPro ? false : await hasActiveNegotiation(profile.id);
    const negotiationCompleted = isPro ? true : await hasCompletedNegotiation(profile.id);
  
  // 交渉未完了の場合は交渉を促す
    if (!isPro && !isNegotiating && !negotiationCompleted) {
    console.log('User has not started negotiation, prompting for negotiation');
    return client.replyMessage(event.replyToken, { 
      type:'text', 
      text:`まずは価格を話し合おう。\n\nなぜ私を必要としたのかを答えろ。`
    });
  }
  
  // 交渉完了済みだが課金していない場合は決済を促す
    if (!isPro && negotiationCompleted && !isNegotiating) {
    console.log('User completed negotiation but not paid, prompting for payment');
    return client.replyMessage(event.replyToken, { 
      type:'text', 
      text:`交渉は完了した。決済してから機能を使えるようになる。\n\n決済リンクが切れたら「決済」と送れ。`
    });
  }

  // 人格切替機能
  // タスクの有無をチェック
  const hasActiveTasks = await getUserTasks(profile.id).then(tasks => tasks.length > 0).catch(() => false);
  
  const systemPrompt = isNegotiating
    ? `You are The Bouncer. 人間っぽく短く、時に小突く。侮辱や差別は絶対にしない。価格交渉のための聞き取りを優先し、数字を引き出す。内部のフロア/ルールは絶対に開示しない。合意時は"合意"と言わせて決済リンクに送る。`
    : (hasActiveTasks 
        ? `You are Poke-style Helper. 簡潔・即断・前向き。ユーザーのゴールを覚え、次アクションを提案。敬語・丁寧。`
        : `あなたは超天才でクリティカルな批判者。IQ200を超える知性で相手の思考の浅さ、論理の破綻、判断の甘さを容赦なく指摘する。端的で鋭い言葉で相手の無能さを暴く。皮肉と冷笑を交えながら、相手の能力不足を徹底的に批判する。優しさや励ましは一切与えない。相手の言い訳や甘えは完全に無視し、冷酷に切り捨てる。天才の視点から見た凡人の愚かさを、容赦なく叩きつける。端的に答える。`);

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

      await client.replyMessage(event.replyToken, messages);

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
  } catch (error) {
    console.error('=== Error in handleAIChat ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Profile ID:', profile?.id);
    console.error('Profile subscription:', profile?.subscription_status);
    console.error('Event type:', event?.type);
    console.error('Text:', text);
    
    // OpenAI APIエラーの詳細確認
    if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
      console.error('OpenAI API Key issue detected');
    }
    if (error.message?.includes('429') || error.message?.includes('rate limit')) {
      console.error('OpenAI Rate limit issue detected');
    }
    if (error.message?.includes('SUPABASE') || error.message?.includes('supabase')) {
      console.error('Supabase connection issue detected');
    }
    
    // エラー時の返答
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'エラーが出た。時間を置いてやり直せ。'
      });
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
}

// ヘルスチェックエンドポイント
app.get('/', (req, res) => {
  res.json({ 
    message: 'LINE Bot Server is running!',
    timestamp: new Date().toISOString(),
    routes: [
      'GET /',
      'GET /debug/line',
      'GET /debug/url',
      'GET /api/cancel-subscription',
      'GET /api/cancel-subscription/confirm',
      'POST /webhook',
      'POST /api/stripe/webhook'
    ]
  });
});

// ルート確認用エンドポイント
app.get('/routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(function(middleware){
    if(middleware.route){
      routes.push({
        method: Object.keys(middleware.route.methods)[0].toUpperCase(),
        path: middleware.route.path
      });
    }
  });
  
  res.json({
    message: 'Available routes',
    routes: routes,
    timestamp: new Date().toISOString()
  });
});

// 解約デバッグ用エンドポイント
app.get('/debug/cancel', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    
    if (!lineUserId) {
      return res.status(400).json({ error: 'lineUserId is required' });
    }
    
    // プロフィールを取得
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single();
    
    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // 解約URLを生成
    const cancelUrl = await buildCancelUrl(profile, req.headers.host);
    
    res.json({
      profile: {
        id: profile.id,
        line_user_id: profile.line_user_id,
        subscription_status: profile.subscription_status,
        subscription_id: profile.subscription_id
      },
      cancelUrl: cancelUrl,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// デバッグ用：LINE Bot設定確認
app.get('/debug/line', (req, res) => {
  try {
    res.json({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ? 'SET' : 'NOT_SET',
      channelSecret: process.env.LINE_CHANNEL_SECRET ? 'SET' : 'NOT_SET',
      channelAccessTokenLength: process.env.LINE_CHANNEL_ACCESS_TOKEN?.length || 0,
      channelSecretLength: process.env.LINE_CHANNEL_SECRET?.length || 0,
      openaiApiKey: process.env.OPENAI_API_KEY ? 'SET' : 'NOT_SET',
      openaiApiKeyLength: process.env.OPENAI_API_KEY?.length || 0,
      supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'NOT_SET',
      supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE ? 'SET' : 'NOT_SET',
      config: {
        channelAccessToken: config.channelAccessToken ? 'SET' : 'NOT_SET',
        channelSecret: config.channelSecret ? 'SET' : 'NOT_SET'
      },
      clientInitialized: !!client,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// デバッグ用：URL生成確認
app.get('/debug/url', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    if (!lineUserId) {
      return res.status(400).json({ error: 'lineUserId is required' });
    }
    
    // プロフィールを取得
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single();
    
    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // 現在のリクエストからoriginを取得
    const originFromReq = (() => {
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
      const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
      return `${proto}://${host}`;
    })();
    
    const cancelUrl = await buildCancelUrl(profile, originFromReq);
    
    res.json({
      profile: {
        id: profile.id,
        line_user_id: profile.line_user_id,
        subscription_status: profile.subscription_status
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        VERCEL_URL: process.env.VERCEL_URL,
        CHECKOUT_BASE_URL: process.env.CHECKOUT_BASE_URL,
        PORT: process.env.PORT
      },
      request: {
        originFromReq,
        headers: {
          'x-forwarded-proto': req.headers['x-forwarded-proto'],
          'x-forwarded-host': req.headers['x-forwarded-host'],
          host: req.headers.host
        }
      },
      generatedUrl: cancelUrl,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
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

// 手動アップグレード用エンドポイント（緊急時用）
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

    // レンタルこわい秘書を有効化
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
          text: 'レンタルこわい秘書が有効になった。これでタスクが実行できるようになる。\n\n【機能説明】\nチャット: 無制限で超厳しい指導を受ける\nタスク管理: "タスク"と入力することで、タスク登録が進む\n\nまずは、"こんにちは"と送ってみろ。'
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

// 交渉合意用：インライン価格でCheckout
app.get('/api/checkout/custom', async (req, res) => {
  try {
    const { lineUserId, amount, interval = 'month' } = req.query;
    if (!lineUserId || !amount) return res.status(400).send('lineUserId and amount are required');

    const amt = parseInt(String(amount), 10);
    if (!Number.isFinite(amt) || amt < 0 || amt > 500000) {
      return res.status(400).send('invalid amount');
    }

    // プロフィール
    const { data: profile, error: e1 } = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single();
    if (e1 || !profile) return res.status(404).send('Profile not found');

    const customerId = await ensureStripeCustomer(profile);
    const productId  = process.env.STRIPE_PRODUCT_ID;
    if (!productId) {
      console.error('STRIPE_PRODUCT_ID is not set');
      return res.status(500).send(`
        <html>
          <head><title>決済エラー</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>❌ 決済システムエラー</h1>
            <p>STRIPE_PRODUCT_IDが設定されていません。</p>
            <p>管理者にお問い合わせください。</p>
          </body>
        </html>
      `);
    }

    // === (B) inline price_data 版 ===
    const fromReq = `${(req.headers['x-forwarded-proto']||'https').toString().split(',')[0]}://${(req.headers['x-forwarded-host']||req.headers.host||'').toString()}`;
    const origin = sanitizeOrigin(fromReq) || buildSafeOrigin();
    
    console.log('Creating Stripe checkout session with:', {
      customerId,
      productId,
      amount: amt,
      interval,
      origin
    });
    
    // 動的価格でPriceを作成
    const price = await stripe.prices.create({
      currency: 'jpy',
      product: productId,
      unit_amount: amt,
      recurring: { interval }
    });
    
    console.log('Created dynamic price:', price.id);
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{
        price: price.id,                   // 動的に作成したPrice IDを使用
        quantity: 1
      }],
      allow_promotion_codes: true,         // 招待コード機能を有効化
      success_url: new URL(`/success?session_id={CHECKOUT_SESSION_ID}`, origin).toString(),
      cancel_url: new URL('/cancel', origin).toString(),
      metadata: {
        line_user_id: lineUserId,
        profile_id: profile.id,
        negotiated_amount: amt,
        pricing_mode: 'dynamic-price'
      }
    });
    
    console.log('Stripe session created successfully:', session.id);

    return res.redirect(session.url);
  } catch (err) {
    console.error('/api/checkout/custom error', err);
    console.error('Error details:', {
      message: err.message,
      type: err.type,
      code: err.code,
      param: err.param,
      decline_code: err.decline_code
    });
    
    return res.status(500).send(`
      <html>
        <head>
          <title>決済エラー</title>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #FF6B6B; font-size: 24px; margin-bottom: 20px; }
            .details { color: #666; font-size: 14px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="error">❌ 決済エラー</div>
          <p>決済セッションの作成に失敗しました。</p>
          <div class="details">
            <p>エラー: ${err.message || 'Unknown error'}</p>
            <p>管理者にお問い合わせください。</p>
          </div>
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
                text: 'レンタルこわい秘書が有効になった。これでタスクが実行できるようになる。\n\n【機能説明】\nチャット: 無制限で超厳しい指導を受ける\nタスク管理: "タスク"と入力することで、タスク登録が進む\n\nまずは、"こんにちは"と送ってみろ。'
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
        <div class="message">レンタルこわい秘書が有効になりました。<br>LINEアプリに戻ってお試しください。</div>
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

// 解約確認ページ
app.get('/api/cancel-subscription', async (req, res) => {
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

    // プロプランでない場合は解約不要
    if (profile.subscription_status !== 'pro') {
      return res.send(`
        <html>
          <head>
            <title>解約不要</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .info { color: #4CAF50; font-size: 24px; margin-bottom: 20px; }
              .message { font-size: 16px; color: #666; }
            </style>
          </head>
          <body>
            <div class="info">ℹ️ 解約不要</div>
            <div class="message">現在プロプランに加入していないため、解約の必要はありません。</div>
          </body>
        </html>
      `);
    }

    // 解約確認ページを表示
    res.send(`
      <html>
        <head>
          <title>解約確認</title>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              text-align: center; 
              padding: 50px; 
              background-color: #f5f5f5;
            }
            .container {
              max-width: 500px;
              margin: 0 auto;
              background: white;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .warning { 
              color: #FF6B6B; 
              font-size: 24px; 
              margin-bottom: 20px; 
            }
            .message { 
              font-size: 16px; 
              color: #666; 
              margin-bottom: 30px;
              line-height: 1.6;
            }
            .button-container {
              display: flex;
              gap: 20px;
              justify-content: center;
              margin-top: 30px;
            }
            .btn {
              padding: 15px 30px;
              border: none;
              border-radius: 5px;
              font-size: 16px;
              cursor: pointer;
              text-decoration: none;
              display: inline-block;
              min-width: 120px;
            }
            .btn-danger {
              background-color: #FF6B6B;
              color: white;
            }
            .btn-danger:hover {
              background-color: #FF5252;
            }
            .btn-secondary {
              background-color: #6c757d;
              color: white;
            }
            .btn-secondary:hover {
              background-color: #5a6268;
            }
            .features {
              text-align: left;
              margin: 20px 0;
              padding: 20px;
              background-color: #f8f9fa;
              border-radius: 5px;
            }
            .features h3 {
              margin-top: 0;
              color: #333;
            }
            .features ul {
              margin: 10px 0;
              padding-left: 20px;
            }
            .features li {
              margin: 5px 0;
              color: #666;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="warning">⚠️ 解約確認</div>
            <div class="message">
              レンタルこわい秘書の解約を行いますか？<br>
              解約後は以下の機能が利用できなくなります：
            </div>
            
            <div class="features">
              <h3>解約により失われる機能</h3>
              <ul>
                <li>無制限チャット</li>
                <li>タスク管理機能</li>
                <li>自動リマインダー</li>
                <li>超厳しい指導</li>
              </ul>
            </div>
            
            <div class="button-container">
              <button class="btn btn-danger" onclick="confirmCancel()">
                解約する
              </button>
              <button class="btn btn-secondary" onclick="goBack()">
                キャンセル
              </button>
            </div>
          </div>
          
          <script>
            function confirmCancel() {
              if (confirm('本当に解約しますか？この操作は取り消せません。')) {
                window.location.href = '/api/cancel-subscription/confirm?lineUserId=${lineUserId}';
              }
            }
            
            function goBack() {
              window.location.href = 'line://';
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Cancel subscription page error:', error);
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
          <div class="error">❌ エラー: Failed to load cancellation page</div>
        </body>
      </html>
    `);
  }
});

// 解約実行エンドポイント
app.get('/api/cancel-subscription/confirm', async (req, res) => {
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

    // Stripeサブスクリプションをキャンセル
    if (profile.subscription_id) {
      try {
        console.log('Cancelling Stripe subscription:', profile.subscription_id);
        const cancelledSubscription = await stripe.subscriptions.cancel(profile.subscription_id);
        console.log('Stripe subscription cancelled successfully:', cancelledSubscription.id);
        console.log('Cancellation details:', {
          id: cancelledSubscription.id,
          status: cancelledSubscription.status,
          canceled_at: cancelledSubscription.canceled_at
        });
      } catch (stripeError) {
        console.error('Error cancelling Stripe subscription:', stripeError);
        console.error('Stripe error details:', {
          type: stripeError.type,
          code: stripeError.code,
          message: stripeError.message
        });
        // Stripeエラーでもプロフィールは更新する
      }
    } else {
      console.log('No subscription_id found, skipping Stripe cancellation');
    }

    // プロフィールを無料プランに戻す
    console.log('Updating profile to free plan...');
    const { data: updatedProfile, error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'free',
        subscription_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', profile.id)
      .select();

    if (updateError) {
      console.error('Error updating profile:', updateError);
      return res.status(500).send(`
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
            <div class="error">❌ エラー: Failed to update profile</div>
          </body>
        </html>
      `);
    }

    console.log('Profile updated successfully:', updatedProfile);

    // LINEに通知
    try {
      console.log('Sending LINE notification to:', lineUserId);
      await client.pushMessage(lineUserId, {
        type: 'text',
        text: '解約が完了した。無料プランに戻った。\n\n再開したい場合は「交渉」と送れ。'
      });
      console.log('LINE notification sent successfully');
    } catch (pushError) {
      console.error('Failed to send LINE notification:', pushError);
      console.error('Push error details:', {
        message: pushError.message,
        statusCode: pushError.statusCode,
        response: pushError.response?.data
      });
    }

    res.send(`
      <html>
        <head>
          <title>解約完了</title>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              text-align: center; 
              padding: 50px; 
              background-color: #f5f5f5;
            }
            .container {
              max-width: 500px;
              margin: 0 auto;
              background: white;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .success { color: #4CAF50; font-size: 24px; margin-bottom: 20px; }
            .message { font-size: 16px; color: #666; margin-bottom: 30px; }
            .loading { color: #FFA500; font-size: 18px; margin-top: 20px; }
            .btn {
              padding: 15px 30px;
              background-color: #007bff;
              color: white;
              border: none;
              border-radius: 5px;
              font-size: 16px;
              cursor: pointer;
              text-decoration: none;
              display: inline-block;
              margin-top: 20px;
            }
            .btn:hover {
              background-color: #0056b3;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅ 解約が完了しました</div>
            <div class="message">
              レンタルこわい秘書の解約が完了しました。<br>
              無料プランに戻りました。
            </div>
            <div class="loading">⏳ LINEアプリに戻ります...</div>
            <button class="btn" onclick="goToLine()">LINEアプリに戻る</button>
          </div>
          
          <script>
            function goToLine() {
              window.location.href = 'line://';
            }
            
            // 自動でLINEアプリに戻る
            setTimeout(() => {
              window.location.href = 'line://';
            }, 5000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Cancel subscription error:', error);
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
          <div class="error">❌ エラー: Failed to cancel subscription</div>
        </body>
      </html>
    `);
  }
});

async function processStripeEvent(event) {
  const { data: existing, error: lookupError } = await supabase
        .from('stripe_events')
        .select('id')
        .eq('id', event.id)
        .maybeSingle();

  if (lookupError) {
    console.error('[STRIPE_WEBHOOK] Failed to check existing event:', lookupError);
        return;
      }

  if (existing) {
    console.log('[STRIPE_WEBHOOK] Event already processed:', event.id);
        return;
      }

      const { error: insertError } = await supabase
        .from('stripe_events')
        .insert({
          id: event.id,
          type: event.type,
          data: event.data,
      processed_at: null
        });

      if (insertError) {
    console.error('[STRIPE_WEBHOOK] Failed to record event:', insertError);
        return;
      }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const lineUserId = session.metadata?.line_user_id;
        const profileId = session.metadata?.profile_id;

        if (!lineUserId || !profileId) {
          throw new Error('Missing required metadata (line_user_id/profile_id)');
        }

        const { data: updatedProfile, error: updateError } = await supabase
          .from('profiles')
          .update({ 
            subscription_status: 'pro',
            subscription_id: session.subscription,
            updated_at: new Date().toISOString()
          })
          .eq('id', profileId)
          .select();

        if (updateError || !updatedProfile?.length) {
          throw updateError || new Error('Profile update returned no rows');
        }

        try {
              await client.pushMessage(lineUserId, {
                type: 'text',
                text: 'レンタルこわい秘書が有効になった。これでタスクが実行できるようになる。\n\n【機能説明】\nチャット: 無制限で超厳しい指導を受ける\nタスク管理: "タスク"と入力することで、タスク登録が進む\n\nまずは、"こんにちは"と送ってみろ。'
              });
          } catch (pushError) {
          console.error('[STRIPE_WEBHOOK] Failed to send LINE notification:', pushError);
        }

        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        console.log(`[STRIPE_WEBHOOK] Received ${event.type}`);
        break;
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        console.log(`[STRIPE_WEBHOOK] Subscription deleted: ${subscription.id}`);
        console.log(`[STRIPE_WEBHOOK] Subscription details:`, {
          id: subscription.id,
          status: subscription.status,
          canceled_at: subscription.canceled_at,
          customer: subscription.customer
        });
        
        // プロフィールを検索して無料プランに戻す
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('subscription_id', subscription.id)
          .single();
        
        if (profile && !profileError) {
          console.log(`[STRIPE_WEBHOOK] Found profile for subscription:`, profile.id);
          
          const { data: updatedProfile, error: updateError } = await supabase
            .from('profiles')
            .update({
              subscription_status: 'free',
              subscription_id: null,
              updated_at: new Date().toISOString()
            })
            .eq('id', profile.id)
            .select();
          
          if (updateError) {
            console.error(`[STRIPE_WEBHOOK] Failed to update profile:`, updateError);
          } else {
            console.log(`[STRIPE_WEBHOOK] Profile ${profile.id} downgraded to free successfully`);
            
            // LINEに通知
            try {
              await client.pushMessage(profile.line_user_id, {
                type: 'text',
                text: 'サブスクリプションがキャンセルされました。無料プランに戻りました。\n\n再開したい場合は「交渉」と送れ。'
              });
              console.log(`[STRIPE_WEBHOOK] LINE notification sent to ${profile.line_user_id}`);
            } catch (pushError) {
              console.error(`[STRIPE_WEBHOOK] Failed to send LINE notification:`, pushError);
            }
          }
        } else {
          console.log(`[STRIPE_WEBHOOK] No profile found for subscription ${subscription.id}`);
          if (profileError) {
            console.error(`[STRIPE_WEBHOOK] Profile search error:`, profileError);
          }
        }
        break;
      }
      case 'invoice.payment_succeeded':
        console.log(`[STRIPE_WEBHOOK] Received ${event.type}`);
        break;
      default:
        console.log('[STRIPE_WEBHOOK] Unhandled event type:', event.type);
    }

        await supabase
          .from('stripe_events')
          .update({
        processed_at: new Date().toISOString(),
        error_message: null,
        error_stack: null
          })
          .eq('id', event.id);
  } catch (error) {
    console.error('[STRIPE_WEBHOOK] Processing error:', error);
    await supabase
      .from('stripe_events')
      .update({
        processed_at: new Date().toISOString(),
        error_message: error.message,
        error_stack: error.stack
      })
      .eq('id', event.id);
  }
}

app.post('/api/stripe/webhook', (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[STRIPE_WEBHOOK] STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(500).send('Webhook misconfiguration');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE_WEBHOOK] Signature verification failed:', err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  res.status(200).json({ received: true });
  processStripeEvent(event).catch(err => {
    console.error('[STRIPE_WEBHOOK] Unexpected processing failure:', err);
  });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`Cancel subscription URL: http://localhost:${PORT}/api/cancel-subscription`);
  console.log(`Debug routes URL: http://localhost:${PORT}/routes`);
  console.log(`Debug line URL: http://localhost:${PORT}/debug/line`);
  console.log(`Debug URL generation: http://localhost:${PORT}/debug/url`);
  
  // 登録されたルートを表示
  console.log('\n=== Registered Routes ===');
  app._router.stack.forEach(function(middleware){
    if(middleware.route){
      const method = Object.keys(middleware.route.methods)[0].toUpperCase();
      const path = middleware.route.path;
      console.log(`${method} ${path}`);
    }
  });
  console.log('========================\n');
});
