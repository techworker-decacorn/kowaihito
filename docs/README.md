# レンタルこわい秘書 - AI指導官 × タスク管理ボット

超厳しいAI指導官とタスク管理機能を組み合わせたLINE公式アカウントボットです。自然言語でタスクを登録し、期日管理とリマインダー機能で確実にタスクを完了させます。

## 主要機能

### 🤖 AI指導官チャット
- 超厳しい、スパルタかつ合理的なAI指導官との対話
- OpenAI GPT-4o-miniによる高品質な返答
- **メモリ機能**: 過去の会話を記憶し、一貫した厳しい指導を提供
- **短期記憶**: 直近の会話を自動保存・復元
- **長期要約**: 会話が溜まったら自動要約
- **事実メモ**: 重要な情報を自動抽出・保存
- 無料プラン（1日3回）とプロプラン（無制限）の料金体系

### 📋 タスク管理システム
- **自然言語タスク登録**: 「タスク」→「英文校正」→「明日17時」の3ステップ
- **1行コマンド**: `タスク: 英文校正 / 終了: 明日17時` で即座に登録
- **柔軟な日時入力**: 全角・半角混在、自然言語（「明日17時」「来週火曜の朝」「9/23 19:47」等）に対応
- **自動リマインダー**: 期日30分前と期日ちょうどに厳しい通知
- **タスク操作**: 番号指定（`完了1`）、タイトル指定（`完了 英文校正`）、直近ショートカット（`直近を完了`）
- **タスク一覧**: `残タスク`、`未完了`、`リスト`、`タスク一覧`で確認

### 💳 決済システム
- Stripe連携によるプロプラン決済
- 月額サブスクリプション対応
- プロモーションコード機能

### 🗄️ データ管理
- Supabaseによる堅牢なデータベース管理
- ユーザープロフィール管理
- 利用制限管理
- **メモリ機能用テーブル**:
  - `chat_messages` - 短期記憶（発話ログ）
  - `chat_summaries` - 長期要約（ローリング要約）
  - `profile_memories` - 事実メモ（恒久メモ）

## セットアップ手順

### 1. 必要なアカウント・APIキーの準備

#### LINE Developers アカウント
1. [LINE Developers](https://developers.line.biz/) にアクセス
2. アカウントを作成・ログイン
3. 新しいプロバイダーを作成
4. 新しいチャネルを作成（Messaging API）
5. チャネルアクセストークンとチャネルシークレットを取得

#### OpenAI API アカウント
1. [OpenAI](https://platform.openai.com/) にアクセス
2. アカウントを作成・ログイン
3. APIキーを生成

#### Supabase アカウント
1. [Supabase](https://supabase.com/) にアクセス
2. アカウントを作成・ログイン
3. 新しいプロジェクトを作成
4. プロジェクトURLとService Role Keyを取得
5. データベーススキーマを実行（schema.sql）

#### Stripe アカウント（決済機能用）
1. [Stripe](https://stripe.com/) にアクセス
2. アカウントを作成・ログイン
3. プロダクトと価格を作成
4. Webhookエンドポイントを設定
5. APIキーとWebhookシークレットを取得

### 2. プロジェクトのセットアップ

```bash
# 依存関係をインストール
npm install

# 環境変数ファイルを作成
cp config/env.example .env
```

### 3. 環境変数の設定

`.env` ファイルを編集して、以下の値を設定してください：

```env
# LINE Messaging API設定
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token_here
LINE_CHANNEL_SECRET=your_line_channel_secret_here

# OpenAI API設定
OPENAI_API_KEY=your_openai_api_key_here

# Supabase設定
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE=your_supabase_service_role_key

# Stripe設定（決済機能用）
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_PRICE_ID=your_stripe_price_id
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

# サーバー設定
PORT=3000
VERCEL_URL=your_vercel_domain
```

### 4. データベースのセットアップ

1. SupabaseプロジェクトのSQL Editorを開く
2. `database/schema.sql`の内容を実行してテーブルを作成
3. 必要に応じて`database/task_drafts.sql`も実行
4. **メモリ機能用テーブル**を作成:
   ```sql
   -- 短期記憶（発話ログ）
   create table if not exists chat_messages (
     id uuid primary key default gen_random_uuid(),
     user_id uuid references profiles(id) on delete cascade,
     role text check (role in ('user','assistant','system')) not null,
     content text not null,
     tokens int,
     created_at timestamptz not null default now()
   );
   
   -- 長期要約（ローリング要約）
   create table if not exists chat_summaries (
     id uuid primary key default gen_random_uuid(),
     user_id uuid references profiles(id) on delete cascade,
     summary text not null,
     last_message_created_at timestamptz not null,
     created_at timestamptz not null default now()
   );
   
   -- 事実メモ（恒久メモ）
   create table if not exists profile_memories (
     id uuid primary key default gen_random_uuid(),
     user_id uuid references profiles(id) on delete cascade,
     key text not null,
     value text not null,
     category text check (category in ('preference','profile','constraint','todo')) default 'preference',
     weight int default 1,
     expires_at timestamptz,
     updated_at timestamptz not null default now()
   );
   ```

### 5. LINE Developers での設定

1. LINE Developers コンソールでチャネル設定を開く
2. 「Messaging API設定」タブを選択
3. Webhook URL に `https://your-domain.com/webhook` を設定
4. Webhookの利用を「利用する」に設定
5. 応答メッセージを「無効」に設定（ボットが自動返答するため）

### 6. Stripe Webhook設定（決済機能用）

1. Stripe DashboardのWebhooksセクションを開く
2. 新しいエンドポイントを作成
3. URL: `https://your-domain.com/api/stripe/webhook`
4. イベント: `checkout.session.completed`, `customer.subscription.created`, `invoice.payment_succeeded`
5. Webhookシークレットを取得して環境変数に設定

### 7. サーバーの起動

```bash
# 開発モード（自動再起動）
npm run dev

# 本番モード
npm start

# Vercelにデプロイ
npx vercel --prod
```

### 8. テスト

#### AI指導官チャット
1. LINE公式アカウントを友だち追加
2. 任意のメッセージを送信
3. 超厳しいAI指導官からの返答を確認
4. **メモリ機能のテスト**:
   - 1回目のメッセージ: 「こんにちは」
   - 2回目のメッセージ: 「私の名前は何ですか？」（前の会話を覚えているか確認）
5. **メモコマンドのテスト**:
   - `メモ一覧` - 保存されたメモを表示
   - `メモ: 好み=厳しめ` - メモを手動追加
   - `厳しく: 失敗パターン=締切を守らない` - 高重要度でメモ保存
   - `メモ削除 好み` - メモを削除

#### タスク管理機能
1. **自然言語タスク登録**:
   - `タスク` と送信
   - `英文校正` と送信
   - `明日17時` と送信

2. **1行コマンド**:
   - `タスク: 英文校正 / 終了: 明日17時` と送信

3. **タスク一覧確認**:
   - `残タスク`、`未完了`、`リスト`、`タスク一覧` のいずれかを送信

4. **タスク操作**:
   - 完了: `完了1` またはボタンタップ
   - 削除: `削除1` またはボタンタップ
   - タイトル指定: `完了 英文校正` や `英文校正を削除`
   - 直近タスク: `直近を完了` や `最新を削除`

#### 決済機能
1. 無料プランの利用制限に達する
2. プロプランアップグレードボタンをタップ
3. Stripe決済ページで決済完了

## ファイル構成

```
├── src/                   # ソースコード
│   └── server.js          # メインサーバーファイル
├── database/              # データベース関連
│   ├── schema.sql         # データベーススキーマ
│   ├── task_drafts.sql    # タスクドラフトテーブル
│   └── migrations/        # マイグレーションファイル
├── config/                # 設定ファイル
│   ├── vercel.json        # Vercelデプロイ設定
│   └── env.example        # 環境変数のテンプレート
├── docs/                  # ドキュメント
│   ├── README.md          # このファイル
│   └── TODO.md            # プロジェクト現状・タスク管理
├── supabase/              # Supabase設定
│   └── config.toml
├── package.json           # 依存関係とスクリプト
└── package-lock.json
```

## 📋 プロジェクト現状

現在の開発状況と残タスクは [TODO.md](./TODO.md) で管理しています。

## API エンドポイント

- `POST /webhook` - LINE Webhook
- `GET /` - ヘルスチェック
- `GET /api/cron/notify` - リマインダー送信（Cron用）
- `GET /api/cron/expire` - 期限切れタスク処理（Cron用）
- `POST /api/cron/trim-chats` - チャットトリム（古いチャットの削除）
- `GET /api/checkout` - Stripe決済ページ
- `POST /api/stripe/webhook` - Stripe Webhook
- `GET /success` - 決済成功ページ
- `GET /cancel` - 決済キャンセルページ
- `GET /api/debug/date` - 日付解析デバッグ（開発用）
- `GET /api/debug/reminders` - リマインダーデバッグ（開発用）

## 利用制限

- **無料プラン**: 1日3回までAIチャット利用可能
- **プロプラン**: 無制限でAIチャット利用可能
- タスク管理機能は全プランで無制限利用可能

## 注意事項

- OpenAI APIの利用には料金が発生します
- LINE Messaging APIの無料メッセージ数制限があります
- 本番環境ではHTTPSが必要です
- リマインダー機能はCronジョブで動作します（Vercel Cron推奨）
- **メモリ機能**: 会話データが蓄積されるため、定期的なチャットトリムを推奨
- **厳しい対応**: AIは一貫して厳格で端的な回答を心がけます

## トラブルシューティング

### よくある問題

1. **Webhook URLが正しく設定されていない**
   - LINE Developers コンソールでWebhook URLを確認
   - サーバーが起動していることを確認

2. **環境変数が正しく設定されていない**
   - `.env` ファイルの内容を確認
   - 値に余分なスペースがないか確認

3. **OpenAI APIキーが無効**
   - APIキーが正しく設定されているか確認
   - OpenAIアカウントにクレジットが残っているか確認

4. **タスクの期日が正しく設定されない**
   - 自然言語の日時入力が正しく解析されているかログで確認
   - 全角・半角の混在に対応済み
   - `9/23 19:47`形式も対応済み
   - `/api/debug/date?input=日時文字列`で解析結果を確認可能

5. **決済が完了しない**
   - Stripe Webhookが正しく設定されているか確認
   - 環境変数のStripe設定を確認

6. **リマインダーが送信されない**
   - Cronジョブが正しく設定されているか確認
   - `/api/cron/notify`エンドポイントが動作しているか確認
   - `/api/debug/reminders`でリマインダーの状態を確認可能

7. **メモリ機能が動作しない**
   - メモリ機能用テーブル（`chat_messages`, `chat_summaries`, `profile_memories`）が作成されているか確認
   - Supabaseのデータベース接続が正常か確認
   - メモリ機能のテスト: `メモ一覧`コマンドで動作確認

8. **AIの回答が長すぎる**
   - システムプロンプトが端的な回答を促すように設定済み
   - メモリ機能により過去の会話を記憶し、一貫した厳しい指導を提供

## ライセンス

MIT
