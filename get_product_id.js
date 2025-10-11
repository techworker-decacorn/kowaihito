// Stripe Price IDからProduct IDを取得するスクリプト
const Stripe = require('stripe');

async function getProductIdFromPriceId() {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  
  try {
    // 既存のPrice IDを取得（環境変数から）
    const priceId = process.env.STRIPE_PRICE_ID;
    console.log('Price ID:', priceId);
    
    if (priceId) {
      // Priceの詳細を取得
      const price = await stripe.prices.retrieve(priceId);
      console.log('Product ID:', price.product);
      return price.product;
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getProductIdFromPriceId();
