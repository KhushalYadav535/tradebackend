require('dotenv').config();
const db = require('./index');

async function migrate() {
  try {
    console.log('Adding is_active flag to scripts table...');
    
    // Check if column exists before adding
    const checkColumn = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'scripts' AND column_name = 'is_active'
      )
    `);
    
    if (!checkColumn.rows[0].exists) {
      await db.query(`
        ALTER TABLE scripts ADD COLUMN is_active BOOLEAN DEFAULT true
      `);
      console.log('Added is_active column to scripts table');
    } else {
      console.log('is_active column already exists');
    }

    console.log('Creating indices table...');
    
    // Check if table exists
    const checkTable = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'indices'
      )
    `);
    
    if (!checkTable.rows[0].exists) {
      await db.query(`
        CREATE TABLE indices (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) NOT NULL UNIQUE,
          display_name VARCHAR(100) NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('Created indices table');
      
      // Seed with common indices
      await db.query(`
        INSERT INTO indices (name, display_name, is_active) VALUES
        ('NSE', 'NSE - National Stock Exchange', true),
        ('NSEFUT', 'NSE Futures', true),
        ('NSEOPT', 'NSE Options', false),
        ('BSE', 'BSE - Bombay Stock Exchange', false),
        ('BSEFUT', 'BSE Futures', false)
        ON CONFLICT (name) DO NOTHING
      `);
      console.log('Seeded indices table');
    } else {
      console.log('indices table already exists');
    }

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

migrate();
