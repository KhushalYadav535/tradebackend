/**
 * VedPragya Streams — market data service
 *
 * Responsibilities
 * ─────────────────
 * 1. resolveUirId(symbol, exchange?)
 *      Searches the Vedpragya catalogue and returns the best-match
 *      wsSubscribeUirId + last_price for a given symbol.
 *      Results are cached so identical symbols don't hit the API twice.
 *
 * 2. getLtp(symbol, exchange?)
 *      Returns just the last traded price (number | null).
 *
 * 3. search(q, opts?)
 *      Raw search — returns the full results array. Used by the new
 *      /api/market/search route so the frontend can search instruments.
 *
 * 4. WebSocket tick stream (class VedpragyaTickStream)
 *      Connects to the Vedpragya real-time WebSocket, subscribes to a
 *      set of UIR IDs, and emits tick events.  The backend uses this to
 *      push prices to any connected browser clients (SSE or WS relay).
 *
 * Environment variables
 * ─────────────────────
 *   VEDPRAGYA_API_KEY   (required for authenticated / higher-limit access)
 *   VEDPRAGYA_BASE_URL  (optional override, default: https://marketdata.vedpragya.com)
 *   VEDPRAGYA_WS_URL    (optional override, default: wss://marketdata.vedpragya.com/ws)
 */

const { EventEmitter } = require('events');

const BASE_URL = process.env.VEDPRAGYA_BASE_URL || 'https://marketdata.vedpragya.com';
const WS_URL   = process.env.VEDPRAGYA_WS_URL   || 'wss://marketdata.vedpragya.com/ws';
const API_KEY  = process.env.VEDPRAGYA_API_KEY   || process.env.vedpragya || '';

const CACHE_TTL_MS  = 60_000;   // UIR structural data cache: 1 minute
const LTP_TTL_MS    = 3_000;    // LTP price cache: 3 s — updates every 3s in UI
const MAX_RETRIES   = 5;
const RETRY_BASE_MS = 2_000;

// ── helpers ─────────────────────────────────────────────────────────────────

function headers() {
  const h = { 'Accept': 'application/json' };
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

async function apiFetch(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Vedpragya ${res.status} ${path}`), { status: res.status, body: text });
  }
  return res.json();
}
// ── symbol → UIR resolution cache ───────────────────────────────────────────

/** @type {Map<string, { fetchedAt: number, uirId: number|null, ltp: number|null, name: string }>} */
const resolveCache = new Map();

/** @type {Map<string, { fetchedAt: number, ltp: number|null }>} */
const ltpCache = new Map();

/**
 * Pick the best result from a search response.
 */
function pickBest(results, exchangeHint, symbolQuery) {
  if (!results || results.length === 0) return null;
  
  // 1. Filter by exchange if a hint is provided
  let filtered = results;
  if (exchangeHint) {
    const ex = exchangeHint.toUpperCase();
    const exMatch = results.filter(r => r.exchange?.toUpperCase() === ex);
    // Only restrict to exchange if we actually found results for that exchange
    if (exMatch.length > 0) filtered = exMatch;
  }

  // 2. Filter to only live prices
  const live = filtered.filter(r => r.priceStatus === 'live');
  const pool = live.length > 0 ? live : filtered;

  // 3. Try to find an exact match on symbol or name within our pool
  if (symbolQuery) {
    const sq = symbolQuery.toUpperCase();
    const exact = pool.find(r => r.symbol?.toUpperCase() === sq || r.name?.toUpperCase() === sq);
    if (exact) return exact;
  }

  // 4. Default to NSE if no exchange hint was provided
  if (!exchangeHint) {
    const nse = pool.find(r => r.exchange === 'NSE');
    if (nse) return nse;
  }

  // 5. Fallback to the first result in the pool
  return pool[0];
}

// ── symbol alias map ─────────────────────────────────────────────────────────

// Maps common trading-app symbol names to the exact query Vedpragya expects.
// Add entries here whenever you notice a symbol returning null.
const SYMBOL_ALIASES = {
  // NSE Index
  NIFTY       : 'NIFTY 50',
  NIFTY50     : 'NIFTY 50',
  BANKNIFTY   : 'NIFTY BANK',
  FINNIFTY    : 'NIFTY FIN SERVICE',
  MIDCPNIFTY  : 'NIFTY MIDCAP SELECT',
  // MCX Commodities — use full contract names Vedpragya recognises
  GOLD        : 'GOLD',
  GOLDM       : 'GOLD MINI',
  SILVER      : 'SILVER',
  SILVERM     : 'SILVER MINI',
  CRUDEOIL    : 'CRUDE OIL',
  CRUDEOILM   : 'CRUDE OIL MINI',
  NATURALGAS  : 'NATURAL GAS',
  COPPER      : 'COPPER',
  ZINC        : 'ZINC',
  LEAD        : 'LEAD',
  ALUMINIUM   : 'ALUMINIUM',
  NICKEL      : 'NICKEL',
  MENTHAOIL   : 'MENTHA OIL',
  // Forex / CDS
  USDINR      : 'USD-INR',
  EURINR      : 'EUR-INR',
  GBPINR      : 'GBP-INR',
  JPYINR      : 'JPY-INR',
  EURUSD      : 'EUR-USD',
};

// Exchange aliases for known MCX segments so resolveUirId gets the right exchange hint
const EXCHANGE_FOR_SEGMENT = {
  MCXFUT  : 'MCX',
  MCXOPT  : 'MCX',
  NSEFUT  : 'NSE',
  NSEOPT  : 'NSE',
  NSECDS  : 'NSE',
  NSEEQT  : 'NSE',
};

/**
 * resolveUirId — returns { uirId, ltp, name } for a symbol.
 * Cached for CACHE_TTL_MS.
 */
async function resolveUirId(symbol, exchange) {
  const cacheKey = `${symbol.toUpperCase()}:${(exchange || '').toUpperCase()}`;
  const entry = resolveCache.get(cacheKey);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry;

  const query = SYMBOL_ALIASES[symbol.toUpperCase()] || symbol;

  try {
    const json = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
    const results = json.data || json.results || [];

    const best = pickBest(results, exchange, symbol);

    const resolved = {
      fetchedAt : Date.now(),
      uirId     : best?.wsSubscribeUirId ?? null,
      ltp       : best?.last_price != null ? Number(best.last_price) : null,
      name      : best?.name || symbol,
      exchange  : best?.exchange || null,
      lotSize   : best?.lotSize ?? null,
      tickSize  : best?.tickSize ?? null,
    };
    resolveCache.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    console.warn(`[vedpragya] resolveUirId(${symbol}) failed:`, err.message);
    // return stale if we have it
    if (entry) return entry;
    return { uirId: null, ltp: null, name: symbol };
  }
}


/**
 * getLtp — return the last traded price for a symbol (number | null).
 *
 * Does its OWN direct search API call with a SHORT cache (LTP_TTL_MS = 5s).
 * Does NOT go through resolveUirId() which has a 60s structural cache —
 * that would mean prices update only every 60s instead of every 5s.
 */
async function getLtp(symbol, exchange) {
  const cacheKey = `ltp:${symbol.toUpperCase()}:${(exchange || '').toUpperCase()}`;
  const cached = ltpCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LTP_TTL_MS) return cached.ltp;

  // Fresh search call — not going through resolveUirId's 60s cache
  const query = SYMBOL_ALIASES[symbol.toUpperCase()] || symbol;
  try {
    const json = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
    const results = json.data || json.results || [];

    const best = pickBest(results, exchange, symbol);
    const ltp = best?.last_price != null ? Number(best.last_price) : null;

    ltpCache.set(cacheKey, { fetchedAt: Date.now(), ltp });
    return ltp;
  } catch {
    return cached?.ltp ?? null;
  }
}

/**
 * search — expose raw Vedpragya search to callers (e.g. API route).
 */
async function search(q, { limit = 20 } = {}) {
  const json = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
  const results = json.data || json.results || [];
  return results.slice(0, limit);
}

// ── Real-time WebSocket tick stream ──────────────────────────────────────────

/**
 * VedpragyaTickStream
 *
 * Usage:
 *   const stream = new VedpragyaTickStream();
 *   stream.subscribe([114996, 5371]);
 *   stream.on('tick', ({ uirId, ltp, timestamp }) => { ... });
 *   stream.on('error', (err) => { ... });
 *   stream.on('connected', () => { ... });
 *   stream.on('disconnected', () => { ... });
 */
class VedpragyaTickStream extends EventEmitter {
  constructor() {
    super();
    this._ws          = null;
    this._uirIds      = new Set();
    this._retries     = 0;
    this._reconnTimer = null;
    this._closed      = false;
    this._latestTicks = new Map(); // uirId → tick
  }

  // ── public API ────────────────────────────────────────────────────────────

  subscribe(uirIds) {
    for (const id of uirIds) this._uirIds.add(Number(id));
    if (this._ws && this._ws.readyState === 1 /* OPEN */) {
      this._sendSubscribe(uirIds);
    } else if (!this._ws) {
      this._connect();
    }
  }

  unsubscribe(uirIds) {
    for (const id of uirIds) this._uirIds.delete(Number(id));
    if (this._ws && this._ws.readyState === 1) {
      this._sendUnsubscribe(uirIds);
    }
  }

  getLatest(uirId) {
    return this._latestTicks.get(Number(uirId)) ?? null;
  }

  getAllLatest() {
    return Object.fromEntries(this._latestTicks);
  }

  close() {
    this._closed = true;
    clearTimeout(this._reconnTimer);
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async _connect() {
    if (this._closed) return;
    try {
      // Dynamic import of 'ws' so this module works even if ws isn't installed
      // (the service degrades gracefully to polling-only mode).
      let WS;
      try {
        const mod = await import('ws');
        WS = mod.default || mod.WebSocket || mod;
      } catch {
        console.warn('[vedpragya] ws package not available — real-time stream disabled');
        return;
      }

      const wsUrl = API_KEY
        ? `${WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`
        : WS_URL;

      console.log('[vedpragya] Connecting WebSocket…');
      const ws = new WS(wsUrl);
      this._ws = ws;

      ws.on('open', () => {
        console.log('[vedpragya] WebSocket connected');
        this._retries = 0;
        this.emit('connected');
        if (this._uirIds.size > 0) {
          this._sendSubscribe([...this._uirIds]);
        }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch { /* ignore malformed frames */ }
      });

      ws.on('close', (code, reason) => {
        console.log(`[vedpragya] WebSocket closed (${code})`);
        this._ws = null;
        this.emit('disconnected', { code, reason: reason?.toString() });
        if (!this._closed) this._scheduleReconnect();
      });

      ws.on('error', (err) => {
        console.warn('[vedpragya] WebSocket error:', err.message);
        this.emit('error', err);
      });

    } catch (err) {
      console.warn('[vedpragya] _connect failed:', err.message);
      if (!this._closed) this._scheduleReconnect();
    }
  }

  _handleMessage(msg) {
    // Vedpragya tick frame — adjust field names if the wire format differs
    // Common patterns: { type: 'tick', uirId, ltp, timestamp }
    //                  { uirId, price, ts }
    //                  array of ticks
    const frames = Array.isArray(msg) ? msg : [msg];

    for (const frame of frames) {
      const type = frame.type || frame.event;
      if (type && type !== 'tick' && type !== 'quote' && type !== 'price') continue;

      const uirId = Number(frame.uirId ?? frame.id ?? frame.instrumentId ?? 0);
      const ltp   = Number(frame.ltp   ?? frame.price ?? frame.last_price ?? NaN);
      if (!uirId || isNaN(ltp)) continue;

      const tick = {
        uirId,
        ltp,
        timestamp: frame.timestamp ?? frame.ts ?? new Date().toISOString(),
        change    : frame.change    ?? null,
        changePct : frame.changePct ?? frame.pchange ?? null,
        volume    : frame.volume    ?? null,
        bid       : frame.bid       ?? null,
        ask       : frame.ask       ?? null,
      };
      this._latestTicks.set(uirId, tick);
      this.emit('tick', tick);
    }
  }

  _sendSubscribe(uirIds) {
    // Try common subscribe message formats; real format TBD from docs/wire capture
    const payload = JSON.stringify({
      action     : 'subscribe',
      type       : 'subscribe',
      uirIds     : uirIds.map(Number),
      instrumentIds: uirIds.map(Number),
    });
    try { this._ws.send(payload); } catch {}
  }

  _sendUnsubscribe(uirIds) {
    const payload = JSON.stringify({
      action     : 'unsubscribe',
      type       : 'unsubscribe',
      uirIds     : uirIds.map(Number),
      instrumentIds: uirIds.map(Number),
    });
    try { this._ws.send(payload); } catch {}
  }

  _scheduleReconnect() {
    this._retries = Math.min(this._retries + 1, MAX_RETRIES);
    const delay = RETRY_BASE_MS * Math.pow(2, this._retries - 1);
    console.log(`[vedpragya] Reconnecting in ${delay}ms (attempt ${this._retries})…`);
    this._reconnTimer = setTimeout(() => this._connect(), delay);
  }
}

// ── Singleton tick stream ────────────────────────────────────────────────────
// Lazily created on first subscriber so startup doesn't open a connection
// unless something actually subscribes.

let _sharedStream = null;

function getSharedStream() {
  if (!_sharedStream) {
    _sharedStream = new VedpragyaTickStream();
  }
  return _sharedStream;
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  resolveUirId,
  getLtp,
  search,
  VedpragyaTickStream,
  getSharedStream,
  EXCHANGE_FOR_SEGMENT,
};
