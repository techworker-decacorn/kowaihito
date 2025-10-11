# Webhook エンドポイント一覧

このアプリケーションでは以下のwebhookエンドポイントが利用可能です。

## 基本URL
- 本番環境: `https://line-openai-p2mzpxy97-techworkers-projects.vercel.app`
- ローカル環境: `http://localhost:3000`

## 1. 汎用Webhook
**エンドポイント:** `POST /webhook/generic`

### 説明
任意のデータを受け取って処理する汎用webhookエンドポイントです。

### リクエスト例
```bash
curl -X POST https://line-openai-p2mzpxy97-techworkers-projects.vercel.app/webhook/generic \
  -H "Content-Type: application/json" \
  -d '{
    "test": true,
    "message": "Hello from webhook",
    "data": {
      "key": "value"
    }
  }'
```

### レスポンス例
```json
{
  "success": true,
  "timestamp": "2025-01-27T12:00:00.000Z",
  "received": {
    "headers": {...},
    "body": {...},
    "query": {...},
    "method": "POST",
    "url": "/webhook/generic"
  }
}
```

## 2. Stripe Webhook
**エンドポイント:** `POST /webhook/stripe`

### 説明
Stripeからの決済イベントを受け取るwebhookエンドポイントです。

### 対応イベント
- `checkout.session.completed` - チェックアウト完了
- `customer.subscription.created` - サブスクリプション作成
- `customer.subscription.updated` - サブスクリプション更新
- `customer.subscription.deleted` - サブスクリプション削除

### 環境変数
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook署名検証用のシークレット

### リクエスト例
```bash
curl -X POST https://line-openai-p2mzpxy97-techworkers-projects.vercel.app/webhook/stripe \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1234567890,v1=signature" \
  -d '{
    "type": "checkout.session.completed",
    "data": {
      "object": {
        "id": "cs_test_123",
        "customer": "cus_test_123"
      }
    }
  }'
```

## 3. GitHub Webhook
**エンドポイント:** `POST /webhook/github`

### 説明
GitHubからのイベントを受け取るwebhookエンドポイントです。

### 対応イベント
- `push` - プッシュイベント
- `pull_request` - プルリクエストイベント
- `issues` - イシューイベント

### リクエスト例
```bash
curl -X POST https://line-openai-p2mzpxy97-techworkers-projects.vercel.app/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-GitHub-Delivery: delivery-id" \
  -d '{
    "action": "opened",
    "pull_request": {
      "number": 123,
      "title": "Test PR"
    }
  }'
```

## 4. LINE Bot Webhook
**エンドポイント:** `POST /webhook`

### 説明
LINE Botからのメッセージイベントを受け取るwebhookエンドポイントです。

### 対応イベント
- メッセージ受信
- Postbackイベント
- フォロー/アンフォロー

## テスト方法

### 1. テストスクリプトの実行
```bash
# 本番環境のテスト
node test_webhooks.js

# ローカル環境のテスト
node test_webhooks.js --local
```

### 2. 個別テスト
```bash
# 汎用webhookのテスト
curl -X POST https://line-openai-p2mzpxy97-techworkers-projects.vercel.app/webhook/generic \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

## ログ確認
webhookの受信ログはVercelのダッシュボードまたはローカル環境のコンソールで確認できます。

## セキュリティ
- Stripe webhookは署名検証を実装
- 必要に応じて他のwebhookにも認証を追加可能
- 本番環境では適切なCORS設定を推奨
