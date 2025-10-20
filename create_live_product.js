// 本番環境用のStripe Productを作成するスクリプト
// 注意: 本番環境のAPIキーを使用します

const Stripe = require('stripe');

// 本番環境のAPIキーを設定（実際のキーに置き換えてください）
const stripe = Stripe('sk_live_...'); // 実際の本番環境のAPIキーに置き換え

async function createLiveProduct() {
  try {
    console.log('Creating live mode Stripe product...');
    
    const product = await stripe.products.create({
      name: 'レンタルこわい秘書',
      description: 'AI指導官が伴走するタスク管理サブスクリプション',
      metadata: {
        service: 'rental-kowai-secretary',
        type: 'subscription'
      }
    });
    
    console.log('✅ Live Product Created Successfully:');
    console.log(`Product ID: ${product.id}`);
    console.log(`Product Name: ${product.name}`);
    console.log(`Product Description: ${product.description}`);
    console.log(`Live Mode: ${product.livemode}`);
    
    return product.id;
  } catch (error) {
    console.error('❌ Error creating live product:', error.message);
    console.error('Error details:', error);
    return null;
  }
}

// 注意: 本番環境のAPIキーが必要です
console.log('⚠️  WARNING: This script requires a live mode Stripe API key.');
console.log('Please update the API key in this script before running.');
console.log('');

// createLiveProduct();
