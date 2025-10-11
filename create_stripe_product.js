require('dotenv').config();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function createStripeProduct() {
  try {
    // 新しいProductを作成
    const product = await stripe.products.create({
      name: '寺子屋 AI チャット',
      description: 'AI チャットサービス - 月額サブスクリプション',
      metadata: {
        service: 'terakoya-ai-chat',
        type: 'subscription'
      }
    });
    
    console.log('Created Stripe Product:');
    console.log(`Product ID: ${product.id}`);
    console.log(`Product Name: ${product.name}`);
    console.log(`Product Description: ${product.description}`);
    
    return product.id;
  } catch (error) {
    console.error('Error creating Stripe product:', error.message);
    return null;
  }
}

createStripeProduct();
