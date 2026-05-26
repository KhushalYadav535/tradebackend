require('dotenv').config();
const { Pool } = require('pg');

async function testConnection() {
  console.log('Testing connection to:', process.env.DATABASE_URL);
  
  // Try standard connection
  const pool1 = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool1.connect();
    console.log('SUCCESS: Connected without SSL');
    client.release();
    pool1.end();
    return;
  } catch (err) {
    console.log('FAILED without SSL:', err.message);
  }

  // Try with SSL
  console.log('Trying with SSL...');
  const pool2 = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  try {
    const client = await pool2.connect();
    console.log('SUCCESS: Connected WITH SSL');
    client.release();
  } catch (err) {
    console.log('FAILED with SSL:', err.message);
  } finally {
    pool2.end();
  }
}

testConnection();
