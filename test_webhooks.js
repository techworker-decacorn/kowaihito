const axios = require('axios');

// テスト用のwebhook URL（デプロイ後に更新）
const BASE_URL = 'https://line-openai-p2mzpxy97-techworkers-projects.vercel.app';

async function testWebhooks() {
  console.log('=== Webhook Testing Started ===\n');
  
  try {
    // 1. 汎用Webhookのテスト
    console.log('1. Testing Generic Webhook...');
    const genericResponse = await axios.post(`${BASE_URL}/webhook/generic`, {
      test: true,
      message: 'This is a test webhook',
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Test-Header': 'test-value'
      }
    });
    console.log('✅ Generic Webhook Response:', genericResponse.data);
    console.log('Status:', genericResponse.status);
    console.log('');
    
    // 2. GitHub Webhookのテスト
    console.log('2. Testing GitHub Webhook...');
    const githubResponse = await axios.post(`${BASE_URL}/webhook/github`, {
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'Test PR',
        user: {
          login: 'testuser'
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'test-delivery-id'
      }
    });
    console.log('✅ GitHub Webhook Response:', githubResponse.data);
    console.log('Status:', githubResponse.status);
    console.log('');
    
    // 3. Stripe Webhookのテスト（署名なし）
    console.log('3. Testing Stripe Webhook (without signature)...');
    try {
      const stripeResponse = await axios.post(`${BASE_URL}/webhook/stripe`, {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            customer: 'cus_test_123'
          }
        }
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      console.log('✅ Stripe Webhook Response:', stripeResponse.data);
    } catch (error) {
      console.log('⚠️  Stripe Webhook Error (expected without signature):', error.response?.data || error.message);
    }
    console.log('');
    
    console.log('=== Webhook Testing Completed ===');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

// ローカルテスト用
async function testLocalWebhooks() {
  console.log('=== Local Webhook Testing ===\n');
  const LOCAL_URL = 'http://localhost:3000';
  
  try {
    console.log('Testing local generic webhook...');
    const response = await axios.post(`${LOCAL_URL}/webhook/generic`, {
      test: true,
      message: 'Local test webhook'
    });
    console.log('✅ Local Response:', response.data);
  } catch (error) {
    console.log('❌ Local test failed (server might not be running):', error.message);
  }
}

// コマンドライン引数に応じてテストを実行
if (process.argv.includes('--local')) {
  testLocalWebhooks();
} else {
  testWebhooks();
}
