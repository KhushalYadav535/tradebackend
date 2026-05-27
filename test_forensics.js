const axios = require('axios');

async function testForensics() {
    const baseUrl = 'http://localhost:5000/api';
    
    try {
        // 1. Login as admin
        const loginRes = await axios.post(`${baseUrl}/auth/login`, {
            username: 'admin',
            password: 'admin123'
        });
        const token = loginRes.data.token;
        const headers = { Authorization: `Bearer ${token}` };
        
        console.log('Logged in as admin successfully');
        
        // 2. Find a user
        const studentsRes = await axios.get(`${baseUrl}/admin/students`, { headers });
        const users = studentsRes.data.students.filter(u => u.role === 'user');
        if (users.length === 0) {
            console.log('No regular users found to test');
            return;
        }
        const testUser = users[0];
        console.log(`Testing forensics on user: ${testUser.username} (ID: ${testUser.id})`);
        
        // 3. Call forensics API
        const forensicsRes = await axios.get(`${baseUrl}/admin/forensics/${testUser.id}`, { headers });
        
        console.log('\n--- Forensic Report ---');
        console.log(JSON.stringify(forensicsRes.data, null, 2));
        console.log('-----------------------\n');
        
        console.log('PASS: Forensics API responded successfully');
    } catch (err) {
        console.error('FAIL: Error calling forensics API', err.response?.data || err.message);
    }
}

testForensics();
