#!/bin/bash

# Vercel環境変数設定スクリプト
echo "Vercel環境変数を設定します..."

# 交渉パラメータ
echo "15000" | npx vercel env add NEGOTIATION_LIST_PRICE_YEN production
echo "12900" | npx vercel env add NEGOTIATION_SOFT_FLOOR_YEN production
echo "9900" | npx vercel env add NEGOTIATION_HARD_FLOOR_YEN production
echo "2" | npx vercel env add NEGOTIATION_MAX_CONCESSIONS production
echo "8" | npx vercel env add NEGOTIATION_ANCHOR_VARIANCE_PCT production

# チェックアウトベースURL
echo "https://line-openai-ncjb5ro0n-techworkers-projects.vercel.app" | npx vercel env add CHECKOUT_BASE_URL production

echo "環境変数設定完了！"
echo "現在の環境変数を確認:"
npx vercel env ls
