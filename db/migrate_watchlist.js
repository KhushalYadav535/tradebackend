const db = require('../db');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      segment VARCHAR(30) NOT NULL,
      name VARCHAR(100) NOT NULL,
      expiry VARCHAR(30),
      option_type VARCHAR(5),
      strike VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, segment, name, expiry, option_type, strike)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
  `);
  console.log('Watchlist table created/verified.');
  process.exit(0);
}

migrate().catch((e) => { console.error(e); process.exit(1); });
