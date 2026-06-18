const db = require('./db');

async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ip_address  TEXT,
      user_agent  TEXT,
      action      TEXT DEFAULT 'login',
      logged_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS login_logs_user_id_idx ON login_logs(user_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS login_logs_logged_at_idx ON login_logs(logged_at);`);
  console.log('login_logs table created OK');
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
