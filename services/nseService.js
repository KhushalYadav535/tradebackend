// Real NSE option-chain data via nse-bse-api.
// We can't use equity quotes (403 from NSE), but option chains work reliably
// and give us real strike ladders + CE/PE prices for NIFTY/BANKNIFTY/etc.

const CACHE_MS = 30000; // option chain refreshes every 30s server-side

let nseClientPromise = null;
async function getClient() {
  if (!nseClientPromise) {
    nseClientPromise = (async () => {
      const mod = await import('nse-bse-api');
      const nse = new mod.NSE('./downloads');
      // Warm cookies — NSE rejects calls without them
      try { await nse.market.getStatus(); } catch {}
      return nse;
    })();
  }
  return nseClientPromise;
}

const cache = new Map(); // symbol -> { fetchedAt, data, inflight }

async function fetchChain(symbol) {
  const nse = await getClient();
  const oc = await nse.options.getOptionChain(symbol);
  const records = oc?.records?.data || [];
  const filtered = oc?.filtered?.data || records;
  const underlying = Number(oc?.records?.underlyingValue || 0);
  const expiries = (oc?.records?.expiryDates || []).slice(0, 8);

  const rowsByExpiry = {};
  for (const r of records) {
    const exp = r.expiryDate;
    if (!exp) continue;
    if (!rowsByExpiry[exp]) rowsByExpiry[exp] = [];
    rowsByExpiry[exp].push({
      strike: Number(r.strikePrice),
      ce: r.CE
        ? {
            ltp: Number(r.CE.lastPrice || 0),
            bid: Number(r.CE.bidprice || 0),
            ask: Number(r.CE.askPrice || 0),
            oi: Number(r.CE.openInterest || 0),
            iv: Number(r.CE.impliedVolatility || 0),
            change: Number(r.CE.change || 0),
            change_pct: Number(r.CE.pChange || 0),
          }
        : null,
      pe: r.PE
        ? {
            ltp: Number(r.PE.lastPrice || 0),
            bid: Number(r.PE.bidprice || 0),
            ask: Number(r.PE.askPrice || 0),
            oi: Number(r.PE.openInterest || 0),
            iv: Number(r.PE.impliedVolatility || 0),
            change: Number(r.PE.change || 0),
            change_pct: Number(r.PE.pChange || 0),
          }
        : null,
    });
  }
  // sort each expiry's rows by strike
  for (const exp of Object.keys(rowsByExpiry)) {
    rowsByExpiry[exp].sort((a, b) => a.strike - b.strike);
  }

  return {
    symbol,
    underlying,
    expiries,
    rowsByExpiry,
    fetchedAt: Date.now(),
  };
}

async function getOptionChain(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const entry = cache.get(sym);
  const fresh = entry && Date.now() - entry.fetchedAt < CACHE_MS;
  if (fresh && entry.data) return entry.data;
  if (entry?.inflight) return entry.inflight;

  const inflight = fetchChain(sym).then(
    (data) => {
      cache.set(sym, { fetchedAt: Date.now(), data, inflight: null });
      return data;
    },
    (err) => {
      console.warn(`[nse] option chain ${sym} failed:`, err.message);
      cache.set(sym, { ...(entry || {}), inflight: null });
      // Serve stale on failure if we have any
      if (entry?.data) return entry.data;
      throw err;
    }
  );

  cache.set(sym, { ...(entry || { fetchedAt: 0 }), inflight });
  return inflight;
}

async function getUnderlying(symbol) {
  try {
    const oc = await getOptionChain(symbol);
    return oc.underlying || null;
  } catch {
    return null;
  }
}

// Quick lookup for a specific strike + CE/PE → returns LTP/bid/ask
async function getOptionQuote(symbol, expiry, strike, optionType) {
  try {
    const oc = await getOptionChain(symbol);
    const rows = oc.rowsByExpiry[expiry] || [];
    const row = rows.find((r) => r.strike === Number(strike));
    if (!row) return null;
    const leg = optionType === 'PE' ? row.pe : row.ce;
    if (!leg) return null;
    return { ...leg, underlying: oc.underlying };
  } catch {
    return null;
  }
}

module.exports = {
  getOptionChain,
  getUnderlying,
  getOptionQuote,
};
