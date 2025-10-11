require('dotenv').config();
const Stripe = require('stripe');

// テスト環境のAPIキーを使用
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function createTestProduct() {
  try {
    console.log('Creating test mode Stripe product...');
    
    const product = await stripe.products.create({
      name: '寺子屋 AI チャット (テスト)',
      description: 'AI チャットサービス - 月額サブスクリプション (テスト環境)',
      metadata: {
        service: 'terakoya-ai-chat',
        type: 'subscription',
        environment: 'test'
      }
    });
    
    console.log('✅ Test Product Created Successfully:');
    console.log(`Product ID: ${product.id}`);
    console.log(`Product Name: ${product.name}`);
    console.log(`Product Description: ${product.description}`);
    console.log(`Live Mode: ${product.livemode}`);
    
    return product.id;
  } catch (error) {
    console.error('❌ Error creating test product:', error.message);
    console.error('Error details:', error);
    return null;
  }
}

createTestProduct();
