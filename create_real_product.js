require('dotenv').config();
const Stripe = require('stripe');

// 環境変数からAPIキーを取得
const apiKey = process.env.STRIPE_SECRET_KEY;
if (!apiKey || apiKey.includes('your_str')) {
  console.error('❌ STRIPE_SECRET_KEY is not properly set in .env file');
  console.log('Please set your Stripe secret key in .env file:');
  console.log('STRIPE_SECRET_KEY=sk_live_...');
  process.exit(1);
}

const stripe = Stripe(apiKey);

async function createRealProduct() {
  try {
    console.log('Creating Stripe product...');
    console.log('API Key:', apiKey.substring(0, 20) + '...');
    
    const product = await stripe.products.create({
      name: '寺子屋 AI チャット',
      description: 'AI チャットサービス - 月額サブスクリプション',
      metadata: {
        service: 'terakoya-ai-chat',
        type: 'subscription'
      }
    });
    
    console.log('✅ Product Created Successfully:');
    console.log(`Product ID: ${product.id}`);
    console.log(`Product Name: ${product.name}`);
    console.log(`Live Mode: ${product.livemode}`);
    
    return product.id;
  } catch (error) {
    console.error('❌ Error creating product:', error.message);
    if (error.type === 'StripeAuthenticationError') {
      console.error('Authentication failed. Please check your API key.');
    }
    return null;
  }
}

createRealProduct();
