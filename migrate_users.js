/**
 * Migration: Add master_id, broker_id, phone, city, commission_pct to users table
 * Add roles: master, broker
 * Run once: node migrate_users.js
 */
const db = require('./db');

async function migrate() {
  console.log('Running migration...');
  try {
    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
        ADD COLUMN IF NOT EXISTS city VARCHAR(100),
        ADD COLUMN IF NOT EXISTS master_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS broker_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) DEFAULT 0
    `);

    // Extend role check constraint to allow master, broker
    await db.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check
    `);
    await db.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin','master','broker'))
    `);

    console.log('✅ Migration complete!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}

migrate();
