const db = require('../db');
const priceService = require('../services/priceService');
const nseService = require('../services/nseService');

function jitter(price) {
  const p = Number(price);
  if (!p) return p;
  const drift = (Math.random() - 0.5) * 0.004;
  return Number((p * (1 + drift)).toFixed(4));
}

const session = new Map();
function ensureSession(s, ltp) {
  let st = session.get(s.id);
  if (!st) {
    st = { open: ltp, high: ltp, low: ltp };
    session.set(s.id, st);
  } else {
    if (ltp > st.high) st.high = ltp;
    if (ltp < st.low) st.low = ltp;
  }
  return st;
}

function spread(price) {
  return Math.max(0.05, Number(price) * 0.0005);
}

// Symbols where the NSE option-chain `underlyingValue` is more accurate
// (and Yahoo's index value is sometimes stale or off-hours) — try NSE first.
const PREFER_NSE = new Set(['NIFTY', 'BANKNIFTY']);

exports.list = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, expiry, exchange, lot_size, current_price, prev_close,
              is_banned, ban_reason, max_lots, margin_per_lot
       FROM scripts ORDER BY exchange, name`
    );

    await priceService.getAll().catch(() => {});

    const updated = [];
    for (const s of rows) {
      let ltp = null, source = null;

      // 1) Prefer NSE option-chain underlying for index symbols
      if (PREFER_NSE.has(s.name)) {
        const u = await nseService.getUnderlying(s.name).catch(() => null);
        if (u && u > 0) { ltp = u; source = 'nse'; }
      }

      // 2) Fall back to Yahoo
      if (ltp == null) {
        const q = await priceService.quoteFor(s.name);
        if (q && q.regularMarketPrice) {
          ltp = Number(q.regularMarketPrice);
          source = 'yahoo';
          var prevYahoo = Number(q.regularMarketPreviousClose ?? ltp);
          var openYahoo = Number(q.regularMarketOpen ?? ltp);
          var highYahoo = Number(q.regularMarketDayHigh ?? ltp);
          var lowYahoo = Number(q.regularMarketDayLow ?? ltp);
        }
      }

      let prev, open, high, low, bid, ask;
      if (ltp != null) {
        // Use Yahoo OHLC if we got it, else session-tracked
        if (source === 'yahoo' && typeof prevYahoo === 'number') {
          prev = prevYahoo; open = openYahoo; high = highYahoo; low = lowYahoo;
        } else {
          const st = ensureSession(s, ltp);
          prev = Number(s.prev_close) || ltp;
          open = st.open; high = st.high; low = st.low;
        }
        if (Number(s.current_price) !== ltp) {
          await db.query('UPDATE scripts SET current_price=$1 WHERE id=$2', [ltp, s.id]);
        }
        const sp = spread(ltp);
        bid = Number((ltp - sp).toFixed(4));
        ask = Number((ltp + sp).toFixed(4));
      } else {
        // 3) Synthetic fallback
        ltp = jitter(s.current_price);
        if (ltp !== Number(s.current_price)) {
          await db.query('UPDATE scripts SET current_price=$1 WHERE id=$2', [ltp, s.id]);
        }
        const st = ensureSession(s, ltp);
        prev = Number(s.prev_close) || ltp;
        open = st.open; high = st.high; low = st.low;
        const sp = spread(ltp);
        bid = Number((ltp - sp).toFixed(4));
        ask = Number((ltp + sp).toFixed(4));
        source = 'sim';
      }

      const change = prev ? ((ltp - prev) / prev) * 100 : 0;
      const netChange = ltp - prev;

      updated.push({
        id: s.id, name: s.name, expiry: s.expiry, exchange: s.exchange,
        lot_size: s.lot_size, prev_close: prev,
        is_banned: s.is_banned, ban_reason: s.ban_reason,
        max_lots: s.max_lots, margin_per_lot: s.margin_per_lot,
        current_price: ltp, ltp, bid, ask, open, high, low, close: prev,
        net_change: Number(netChange.toFixed(4)),
        change_pct: Number(change.toFixed(2)),
        source,
      });
    }

    res.json({ scripts: updated });
  } catch (err) {
    console.error('scripts.list', err);
    res.status(500).json({ error: 'Failed to load scripts' });
  }
};

exports.banned = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, exchange, ban_reason, created_at
       FROM scripts WHERE is_banned = true ORDER BY name`
    );
    res.json({ scripts: rows });
  } catch (err) {
    console.error('scripts.banned', err);
    res.status(500).json({ error: 'Failed to load banned scripts' });
  }
};

exports.maxQty = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, exchange, lot_size, max_lots, margin_per_lot,
              (lot_size * max_lots) AS max_qty
       FROM scripts ORDER BY exchange, name`
    );
    res.json({ scripts: rows });
  } catch (err) {
    console.error('scripts.maxQty', err);
    res.status(500).json({ error: 'Failed to load max-qty data' });
  }
};

exports.optionChain = async (req, res) => {
  try {
    const data = await nseService.getOptionChain(req.params.symbol);
    res.json(data);
  } catch (err) {
    console.error('scripts.optionChain', err.message);
    res.status(503).json({ error: 'Option chain temporarily unavailable' });
  }
};

exports.optionQuote = async (req, res) => {
  const { symbol, expiry, strike, type } = req.query;
  if (!symbol || !expiry || !strike || !type) {
    return res.status(400).json({ error: 'symbol, expiry, strike, type required' });
  }
  try {
    const q = await nseService.getOptionQuote(symbol, expiry, strike, String(type).toUpperCase());
    if (!q) return res.status(404).json({ error: 'Option quote not found' });
    res.json(q);
  } catch (err) {
    console.error('scripts.optionQuote', err.message);
    res.status(503).json({ error: 'Option quote temporarily unavailable' });
  }
};
