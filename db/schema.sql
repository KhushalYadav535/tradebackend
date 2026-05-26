-- Avadh15 Virtual Trading Platform - Database Schema

DROP TABLE IF EXISTS trade_logs CASCADE;
DROP TABLE IF EXISTS ledger CASCADE;
DROP TABLE IF EXISTS positions CASCADE;
DROP TABLE IF EXISTS trades CASCADE;
DROP TABLE IF EXISTS scripts CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

CREATE TABLE settings (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100),
  balance DECIMAL(15,2) DEFAULT 500000.00,
  exposure DECIMAL(15,2) DEFAULT 0.00,
  role VARCHAR(20) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE scripts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  expiry VARCHAR(20),
  exchange VARCHAR(20),
  lot_size INTEGER DEFAULT 1,
  current_price DECIMAL(15,4),
  prev_close DECIMAL(15,4),
  is_banned BOOLEAN DEFAULT false,
  ban_reason TEXT,
  max_lots INTEGER DEFAULT 100,
  margin_per_lot DECIMAL(15,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  script_id INTEGER REFERENCES scripts(id),
  trade_type VARCHAR(10) NOT NULL,
  quantity INTEGER NOT NULL,
  price DECIMAL(15,4) NOT NULL,
  total_value DECIMAL(15,2),
  order_type VARCHAR(20) DEFAULT 'MARKET',
  product_type VARCHAR(20) DEFAULT 'INTRADAY',
  status VARCHAR(20) DEFAULT 'EXECUTED',
  reject_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE positions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  script_id INTEGER REFERENCES scripts(id),
  buy_qty INTEGER DEFAULT 0,
  sell_qty INTEGER DEFAULT 0,
  avg_buy_price DECIMAL(15,4),
  avg_sell_price DECIMAL(15,4),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, script_id)
);

CREATE TABLE ledger (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  description TEXT,
  debit DECIMAL(15,2) DEFAULT 0,
  credit DECIMAL(15,2) DEFAULT 0,
  balance DECIMAL(15,2),
  trade_id INTEGER REFERENCES trades(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE trade_logs (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(20),
  old_values JSONB,
  new_values JSONB,
  done_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trades_user ON trades(user_id, created_at DESC);
CREATE INDEX idx_positions_user ON positions(user_id);
CREATE INDEX idx_ledger_user ON ledger(user_id, created_at DESC);
CREATE INDEX idx_scripts_exchange ON scripts(exchange);
