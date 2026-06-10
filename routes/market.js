/**
 * /api/market — Vedpragya Streams public endpoints
 *
 * GET /api/market/search?q=<query>[&limit=20]
 *   Search 200k+ instruments. Returns Vedpragya's catalogue results.
 *   Auth required (JWT) so only your users can hit this.
 *
 * GET /api/market/ltp?symbols=NIFTY,BANKNIFTY,RELIANCE[&exchange=NSE]
 *   Bulk LTP lookup via Vedpragya search-based resolution.
 *
 * GET /api/market/stream-info?symbols=NIFTY,RELIANCE
 *   Returns { symbol, uirId, exchange, lotSize, tickSize } for each symbol —
 *   the data the frontend needs to subscribe to the Vedpragya WebSocket directly.
 *
 * GET /api/market/ws-url
 *   Returns the Vedpragya WebSocket URL + API key so authenticated frontend
 *   clients can connect directly (avoids proxying ticks through your server).
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const vp     = require('../services/vedpragyaService');

const BASE_WS = process.env.VEDPRAGYA_WS_URL || 'wss://marketdata.vedpragya.com/ws';
const API_KEY = process.env.VEDPRAGYA_API_KEY || process.env.vedpragya || '';

router.use(auth);

// ── GET /api/market/search ────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q     = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  if (!q || q.length < 1) {
    return res.status(400).json({ error: 'q is required' });
  }

  try {
    const results = await vp.search(q, { limit });
    res.json({ results, count: results.length });
  } catch (err) {
    console.error('[market/search]', err.message);
    res.status(502).json({ error: 'Upstream search failed', detail: err.message });
  }
});

// ── GET /api/market/ltp ───────────────────────────────────────────────────────
router.get('/ltp', async (req, res) => {
  const raw      = String(req.query.symbols || '').trim();
  const exchange = req.query.exchange;
  if (!raw) return res.status(400).json({ error: 'symbols is required (comma-separated)' });

  const symbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

  try {
    const results = await Promise.all(
      symbols.map(async (sym) => {
        const resolved = await vp.resolveUirId(sym, exchange);
        return {
          symbol   : sym,
          uirId    : resolved.uirId,
          name     : resolved.name,
          exchange : resolved.exchange,
          ltp      : resolved.ltp,
        };
      })
    );
    res.json({ prices: results });
  } catch (err) {
    console.error('[market/ltp]', err.message);
    res.status(502).json({ error: 'LTP lookup failed' });
  }
});

// ── GET /api/market/stream-info ───────────────────────────────────────────────
router.get('/stream-info', async (req, res) => {
  const raw      = String(req.query.symbols || '').trim();
  const exchange = req.query.exchange; // optional global exchange hint
  if (!raw) return res.status(400).json({ error: 'symbols is required' });

  const symbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50);

  try {
    const infos = await Promise.all(
      symbols.map(async (sym) => {
        // Per-symbol exchange hints can be passed as "SYM:EXCHANGE" format
        let symName = sym, symExchange = exchange;
        if (sym.includes(':')) {
          const [s, ex] = sym.split(':');
          symName = s; symExchange = ex;
        }
        const r = await vp.resolveUirId(symName, symExchange).catch(() => null);
        if (!r) return { symbol: symName, uirId: null };
        return {
          symbol   : symName,
          uirId    : r.uirId,
          name     : r.name,
          exchange : r.exchange,
          lotSize  : r.lotSize,
          tickSize : r.tickSize,
          ltp      : r.ltp,
        };
      })
    );
    res.json({ instruments: infos });
  } catch (err) {
    res.status(502).json({ error: 'stream-info lookup failed' });
  }
});

// ── GET /api/market/ws-url ────────────────────────────────────────────────────
// Returns the Socket.IO server URL + API key so the frontend can connect.
// This endpoint is JWT-gated — only your authenticated users get the key.
router.get('/ws-url', (req, res) => {
  const base = process.env.VEDPRAGYA_BASE_URL || 'https://marketdata.vedpragya.com';
  res.json({
    socketUrl: base,           // Socket.IO connects to https://, handles upgrade internally
    apiKey   : API_KEY || null,
  });
});

module.exports = router;
