// Free real-time quotes from Yahoo Finance via their public chart endpoint.
// We hit query1.finance.yahoo.com/v8/finance/chart/<symbol> which doesn't
// need a crumb token, and pull `regularMarketPrice`, prev close, OHLC, etc.
// from the `meta` object.

const SYMBOL_MAP = {
  NIFTY: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  RELIANCE: 'RELIANCE.NS',
  HDFCBANK: 'HDFCBANK.NS',
  INFOSYS: 'INFY.NS',
  CRUDEOIL: 'CL=F',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  NATURALGAS: 'NG=F',
  USDINR: 'INR=X',
  EURUSD: 'EURUSD=X',
};

const CACHE_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

let cache = { quotes: {}, fetchedAt: 0, inflight: null };

async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`yahoo ${symbol}: ${r.status}`);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`yahoo ${symbol}: no meta`);

  const ltp = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? ltp);
  const open = Number(meta.regularMarketOpen ?? meta.previousClose ?? ltp);
  const high = Number(meta.regularMarketDayHigh ?? ltp);
  const low = Number(meta.regularMarketDayLow ?? ltp);

  return {
    symbol,
    regularMarketPrice: ltp,
    regularMarketPreviousClose: prev,
    regularMarketOpen: open,
    regularMarketDayHigh: high,
    regularMarketDayLow: low,
  };
}

async function fetchQuotes() {
  const symbols = Object.values(SYMBOL_MAP);
  const map = { ...cache.quotes }; // keep stale on individual failures
  const results = await Promise.allSettled(symbols.map(fetchOne));
  let ok = 0, fail = 0;
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      map[symbols[i]] = res.value;
      ok++;
    } else {
      fail++;
    }
  });
  cache = { quotes: map, fetchedAt: Date.now(), inflight: null };
  if (fail) console.warn(`[yahoo] fetched ${ok}/${ok + fail} symbols (${fail} failed)`);
  return map;
}

async function getAll() {
  const fresh = Date.now() - cache.fetchedAt < CACHE_MS;
  if (fresh && Object.keys(cache.quotes).length) return cache.quotes;
  if (!cache.inflight) cache.inflight = fetchQuotes();
  return cache.inflight;
}

async function quoteFor(name) {
  const sym = SYMBOL_MAP[name];
  if (!sym) return null;
  const all = await getAll();
  return all[sym] || null;
}

module.exports = { quoteFor, getAll, SYMBOL_MAP };
