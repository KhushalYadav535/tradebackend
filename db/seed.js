require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

const SCRIPTS = [
  ['NIFTY', 'OCT', 'NSE', 50, 19842.50, 19718.20, 100, 45000],
  ['BANKNIFTY', 'OCT', 'NSE', 15, 44892.15, 45107.95, 100, 38000],
  ['RELIANCE', 'OCT', 'NSE', 250, 2487.65, 2469.20, 80, 18000],
  ['HDFCBANK', 'OCT', 'NSE', 550, 1524.30, 1533.00, 80, 28000],
  ['INFOSYS', 'OCT', 'NSE', 400, 1672.45, 1649.85, 80, 22000],
  ['CRUDEOIL', 'NOV', 'MCX', 100, 6824.00, 6668.00, 50, 22000],
  ['GOLD', 'DEC', 'MCX', 1, 62180.00, 61760.00, 50, 35000],
  ['SILVER', 'DEC', 'MCX', 30, 72450.00, 72770.00, 30, 28000],
  ['NATURALGAS', 'NOV', 'MCX', 1250, 248.40, 243.20, 50, 15000],
  ['USDINR', 'OCT', 'FOREX', 1000, 84.22, 84.04, 200, 8000],
  ['EURUSD', 'OCT', 'FOREX', 1000, 1.0842, 1.0865, 100, 12000],
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Clearing existing data...');
    await client.query('TRUNCATE trade_logs, ledger, positions, trades, scripts, users RESTART IDENTITY CASCADE');

    console.log('Seeding scripts...');
    for (const s of SCRIPTS) {
      await client.query(
        `INSERT INTO scripts (name, expiry, exchange, lot_size, current_price, prev_close, max_lots, margin_per_lot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        s
      );
    }

    console.log('Marking HDFCBANK as banned...');
    await client.query(
      `UPDATE scripts SET is_banned=true, ban_reason='High Volatility' WHERE name='HDFCBANK'`
    );

    console.log('Hashing passwords...');
    const adminHash = await bcrypt.hash('admin123', 10);
    const demoHash = await bcrypt.hash('demo123', 10);

    console.log('Seeding users...');
    await client.query(
      `INSERT INTO users (username, password_hash, full_name, role, balance)
       VALUES ($1,$2,$3,$4,$5)`,
      ['admin', adminHash, 'Admin User', 'admin', 1000000]
    );
    await client.query(
      `INSERT INTO users (username, password_hash, full_name, role, balance)
       VALUES ($1,$2,$3,$4,$5)`,
      ['demo', demoHash, 'Demo Trader', 'user', 500000]
    );

    console.log('Seeding opening-balance ledger entries...');
    await client.query(
      `INSERT INTO ledger (user_id, description, credit, balance)
       SELECT id, 'Opening Balance', balance, balance FROM users`
    );

    await client.query('COMMIT');
    console.log('\nSeed complete.');
    console.log('  admin / admin123');
    console.log('  demo  / demo123');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
