require('dotenv').config();
const { pool } = require('./index');

// Safe migration — adds new columns to users table if they don't already exist.
// Run this once on an existing live database instead of schema.sql (which drops all tables).

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration: add brokerage + auto_cut columns to users...');

    await client.query('BEGIN');

    // brokerage_type
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS brokerage_type VARCHAR(20) DEFAULT 'per_lot'
    `);

    // brokerage_value
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS brokerage_value DECIMAL(15,4) DEFAULT 0
    `);

    // auto_cut
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auto_cut BOOLEAN DEFAULT false
    `);

    // auto_cut_limit
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auto_cut_limit DECIMAL(15,2) DEFAULT NULL
    `);

    await client.query('COMMIT');
    console.log('Migration complete. All columns added (or already existed).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
