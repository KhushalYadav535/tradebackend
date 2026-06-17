require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const scriptsRoutes = require('./routes/scripts');
const tradesRoutes = require('./routes/trades');
const positionsRoutes = require('./routes/positions');
const ledgerRoutes = require('./routes/ledger');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const watchlistRoutes = require('./routes/watchlist');
const marketRoutes    = require('./routes/market');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

app.get('/api/health', (req, res) => {
  console.log('Health check requested at /api/health');
  res.json({ status: 'ok', service: 'avadh15-backend', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  console.log('Health check requested at /health');
  res.json({ status: 'ok', service: 'avadh15-backend', time: new Date().toISOString() });
});

// Public settings endpoint (no auth) — exposes only safe feature flags
app.get('/api/settings/public', async (req, res) => {
  try {
    const db = require('./db');
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('maintenance_mode', 'allow_trading', 'market_open')`
    );
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) {
    console.error('settings.public', err);
    res.json({ settings: {} }); // fail gracefully
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/market',   marketRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Avadh15 backend running on http://localhost:${PORT}`);
  
  // Start background security jobs
  const securityService = require('./services/securityService');
  // Run every 5 minutes (300000 ms)
  setInterval(() => {
    securityService.runPortfolioIntegrityCheck();
  }, 300000);
});
