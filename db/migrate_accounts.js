const db = require('../db');

async function migrate() {
  console.log('Running Accounts migration...');

  // ── cash_entries: admin manual cash credit/debit ──────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_entries (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type         VARCHAR(10) NOT NULL CHECK (type IN ('CREDIT','DEBIT')),
      amount       NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      description  TEXT,
      reference_no VARCHAR(50),
      done_by      INTEGER REFERENCES users(id),
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('  ✓ cash_entries table ready');

  // ── jv_entries: Journal Voucher (double-entry) ────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS jv_entries (
      id            SERIAL PRIMARY KEY,
      jv_number     VARCHAR(30) UNIQUE NOT NULL,
      narration     TEXT,
      entry_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      done_by       INTEGER REFERENCES users(id),
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS jv_lines (
      id         SERIAL PRIMARY KEY,
      jv_id      INTEGER REFERENCES jv_entries(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      account    VARCHAR(100) NOT NULL,
      debit      NUMERIC(15,2) NOT NULL DEFAULT 0,
      credit     NUMERIC(15,2) NOT NULL DEFAULT 0,
      remarks    TEXT
    )
  `);
  console.log('  ✓ jv_entries + jv_lines tables ready');

  // Sequence for JV numbers
  await db.query(`CREATE SEQUENCE IF NOT EXISTS jv_seq START 1`);
  console.log('  ✓ jv_seq sequence ready');

  console.log('Accounts migration complete!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
