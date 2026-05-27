const axios = require('axios');
const crypto = require('crypto');

async function runTests() {
    const baseUrl = 'http://localhost:5000/api';
    
    // 1. Login to get token
    const loginRes = await axios.post(`${baseUrl}/auth/login`, {
        username: 'admin',
        password: 'admin123'
    });
    const token = loginRes.data.token;
    const headers = { Authorization: `Bearer ${token}` };
    
    console.log('Logged in successfully');
    
    // Get script
    const scriptsRes = await axios.get(`${baseUrl}/scripts`, { headers });
    const script = scriptsRes.data.scripts[0];
    
    if (!script) {
        console.log('No scripts found');
        return;
    }
    
    // Test 1: Missing nonce/timestamp
    try {
        await axios.post(`${baseUrl}/trades`, {
            script_id: script.id,
            trade_type: 'BUY',
            lots: 1,
            price: script.current_price,
            order_type: 'MARKET',
            product_type: 'INTRADAY'
        }, { headers });
        console.error('FAIL: Should have rejected due to missing security headers');
    } catch (err) {
        console.log('PASS: Rejected missing security headers');
    }
    
    // Test 2: Expired timestamp
    try {
        await axios.post(`${baseUrl}/trades`, {
            script_id: script.id,
            trade_type: 'BUY',
            lots: 1,
            price: script.current_price,
            order_type: 'MARKET',
            product_type: 'INTRADAY',
            nonce: crypto.randomUUID(),
            timestamp: Date.now() - 100000 // 100 seconds ago
        }, { headers });
        console.error('FAIL: Should have rejected expired timestamp');
    } catch (err) {
        console.log('PASS: Rejected expired timestamp');
    }
    
    // Test 3: Price manipulation
    try {
        await axios.post(`${baseUrl}/trades`, {
            script_id: script.id,
            trade_type: 'BUY',
            lots: 1,
            price: Number(script.current_price) * 0.8, // 20% lower
            order_type: 'LIMIT',
            product_type: 'INTRADAY',
            nonce: crypto.randomUUID(),
            timestamp: Date.now()
        }, { headers });
        console.error('FAIL: Should have rejected manipulated price');
    } catch (err) {
        console.log('PASS: Rejected manipulated price');
    }
    
    // Test 4: Replay attack (Duplicate nonce)
    const validNonce = crypto.randomUUID();
    try {
        await axios.post(`${baseUrl}/trades`, {
            script_id: script.id,
            trade_type: 'BUY',
            lots: 1,
            price: script.current_price,
            order_type: 'MARKET',
            product_type: 'INTRADAY',
            nonce: validNonce,
            timestamp: Date.now()
        }, { headers });
        console.log('PASS: Successfully placed valid order');
        
        // Replay
        await axios.post(`${baseUrl}/trades`, {
            script_id: script.id,
            trade_type: 'BUY',
            lots: 1,
            price: script.current_price,
            order_type: 'MARKET',
            product_type: 'INTRADAY',
            nonce: validNonce,
            timestamp: Date.now()
        }, { headers });
        console.error('FAIL: Should have rejected duplicate request (replay)');
    } catch (err) {
        if (err.response && err.response.data.error.includes('Duplicate')) {
            console.log('PASS: Rejected duplicate request (replay attack)');
        } else {
            console.error('FAIL: Unexpected error', err.response?.data);
        }
    }
    
    console.log('All tests finished.');
}

runTests();
