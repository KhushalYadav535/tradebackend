const db = require('../db');
const priceService = require('../services/priceService');

// Fallback jitter when no upstream quote is available.
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

exports.list = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, expiry, exchange, lot_size, current_price, prev_close,
              is_banned, ban_reason, max_lots, margin_per_lot
       FROM scripts ORDER BY exchange, name`
    );

    // Single batch fetch from Yahoo (cached server-side for 15s).
    await priceService.getAll().catch(() => {});

    const updated = [];
    for (const s of rows) {
      const q = await priceService.quoteFor(s.name);

      let ltp, open, high, low, prev, bid, ask, source;
      if (q && q.regularMarketPrice) {
        ltp = Number(q.regularMarketPrice);
        prev = Number(q.regularMarketPreviousClose ?? ltp);
        open = Number(q.regularMarketOpen ?? ltp);
        high = Number(q.regularMarketDayHigh ?? ltp);
        low = Number(q.regularMarketDayLow ?? ltp);
        const sp = spread(ltp);
        bid = Number(q.bid) > 0 ? Number(q.bid) : Number((ltp - sp).toFixed(4));
        ask = Number(q.ask) > 0 ? Number(q.ask) : Number((ltp + sp).toFixed(4));
        source = 'yahoo';
        // Persist so trade execution uses the real current price.
        if (Number(s.current_price) !== ltp) {
          await db.query('UPDATE scripts SET current_price=$1 WHERE id=$2', [ltp, s.id]);
        }
      } else {
        // Fallback: jitter the last DB price.
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
        current_price: ltp,
        ltp, bid, ask, open, high, low, close: prev,
        net_change: Number(netChange.toFixed(4)),
        change_pct: Number(change.toFixed(2)),
        source,
      });
    }

    res.json({ scripts: updated, source_cache_age_ms: Date.now() - (priceService.SYMBOL_MAP ? 0 : 0) });
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
