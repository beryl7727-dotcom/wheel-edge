/**
 * Wheel Edge — Tiger API Backend Server
 * Runs on port 3001. Keeps the RSA private key server-side only.
 */

const path    = require('path');
const express = require('express');
const cors    = require('cors');

// Resolve tigeropen internal CJS files by path
// (package only exports '.' in the exports field, so we use resolve)
const tigerBase = path.dirname(require.resolve('tigeropen'));

const { createClientConfig } = require(path.join(tigerBase, 'config/client-config'));
const { HttpClient }         = require(path.join(tigerBase, 'client/http-client'));
const { QuoteClient }        = require(path.join(tigerBase, 'quote/quote-client'));
const { TradeClient }        = require(path.join(tigerBase, 'trade/trade-client'));
const { RetryPolicy }        = require(path.join(tigerBase, 'client/retry'));

// No-retry policy — surfaces errors immediately instead of waiting 30s
const NO_RETRY = new RetryPolicy({ maxRetries: 0 });

const app  = express();
const PORT = 3001;

app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json());

// ── Tiger SDK init ────────────────────────────────────────────────────────────

let quoteClient = null;
let tradeClient = null;
let tigerConfig = null;
let initError   = null;

function initTiger() {
  try {
    tigerConfig = createClientConfig({
      propertiesFilePath: path.join(__dirname, 'tiger_openapi_config.properties'),
    });
    const quoteHttp = new HttpClient(tigerConfig, NO_RETRY, { useQuoteServerUrl: true });
    const tradeHttp = new HttpClient(tigerConfig, NO_RETRY);
    quoteClient = new QuoteClient(quoteHttp);
    tradeClient = new TradeClient(tradeHttp, tigerConfig.account);
    console.log(`✅ Tiger API initialised`);
    console.log(`   Tiger ID    : ${tigerConfig.tigerId}`);
    console.log(`   Account     : ${tigerConfig.account}`);
    console.log(`   License     : ${tigerConfig.license || 'TBSG'}`);
    console.log(`   Quote server: ${tigerConfig.quoteServerUrl}`);
    return true;
  } catch (err) {
    initError = err.message || String(err);
    console.error('❌ Tiger init failed:', initError);
    return false;
  }
}

initTiger();

function requireClient(req, res, next) {
  if (!quoteClient) return res.status(503).json({ error: 'Tiger API not initialised', detail: initError });
  next();
}

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/status  (fast check — no live API call)
app.get('/api/status', (req, res) => {
  if (!quoteClient) return res.json({ connected: false, error: initError, timestamp: new Date().toISOString() });
  res.json({
    connected: true,
    tigerId:   '20160056',
    account:   '50757016',
    license:   'TBSG',
    mode:      'PROD',
    server:    'http://localhost:3001',
    timestamp: new Date().toISOString(),
  });
});

// GET /api/ping  (live Tiger API round-trip test)
app.get('/api/ping', requireClient, async (req, res) => {
  try {
    const states = await quoteClient.getMarketState('US');
    res.json({ connected: true, marketState: states?.[0] ?? null, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ connected: false, error: err.message, timestamp: new Date().toISOString() });
  }
});

// GET /api/quote/:symbol
app.get('/api/quote/:symbol', requireClient, async (req, res) => {
  const { symbol } = req.params;
  try {
    const briefs = await quoteClient.getBrief({ symbols: [symbol] });
    const b = briefs?.[0];
    if (!b) return res.status(404).json({ error: `No data for ${symbol}` });
    res.json({
      symbol:           b.symbol,
      price:            b.latestPrice ?? b.preClose ?? null,
      bid:              b.bidPrice ?? null,
      ask:              b.askPrice ?? null,
      volume:           b.volume ?? null,
      dayChange:        b.change ?? null,
      dayChangePercent: b.changeRatio ?? null,
      timestamp:        Date.now(),
      source:           'live',
    });
  } catch (err) {
    const isPermission = err.message?.includes('permission') || err.code === 4;
    res.status(isPermission ? 403 : 500).json({
      error:      err.message,
      code:       err.code,
      symbol,
      needsSetup: isPermission,
      hint:       isPermission
        ? 'Enable real-time market data in Tiger developer portal → API Settings → Market Data'
        : undefined,
    });
  }
});

// GET /api/quotes?symbols=TSLA,IBIT,BBAI
app.get('/api/quotes', requireClient, async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  try {
    const briefs = await quoteClient.getBrief({ symbols });
    res.json(briefs.map(b => ({
      symbol:           b.symbol,
      price:            b.latestPrice ?? b.preClose ?? null,
      bid:              b.bidPrice ?? null,
      ask:              b.askPrice ?? null,
      volume:           b.volume ?? null,
      dayChange:        b.change ?? null,
      dayChangePercent: b.changeRatio ?? null,
      timestamp:        Date.now(),
    })));
  } catch (err) {
    const isPermission = err.message?.includes('permission') || err.code === 4;
    res.status(isPermission ? 403 : 500).json({
      error: err.message, code: err.code, needsSetup: isPermission,
    });
  }
});

// GET /api/option-expiry/:symbol
app.get('/api/option-expiry/:symbol', requireClient, async (req, res) => {
  try {
    const expirations = await quoteClient.getOptionExpiration(req.params.symbol);
    res.json(expirations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/option-chain/:symbol?expiry=2026-07-18
app.get('/api/option-chain/:symbol', requireClient, async (req, res) => {
  const { symbol } = req.params;
  const { expiry } = req.query;
  if (!expiry) return res.status(400).json({ error: 'expiry query param required (YYYY-MM-DD)' });
  try {
    const chain = await quoteClient.getOptionChain(symbol, expiry);
    res.json(chain);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market-state?market=US
app.get('/api/market-state', requireClient, async (req, res) => {
  try {
    const states = await quoteClient.getMarketState(req.query.market || 'US');
    res.json(states);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/positions  (account positions from Tiger, used for Import From Tiger)
app.get('/api/positions', async (req, res) => {
  if (!tradeClient) return res.status(503).json({ error: 'Tiger API not initialised', useMock: true });
  try {
    const positions = await tradeClient.getPositions();
    const mapped = (positions || []).map(p => ({
      symbol:        p.symbol,
      secType:       p.secType || 'STK',
      quantity:      p.positionQty ?? p.position ?? 0,
      averageCost:   p.averageCost ?? 0,
      marketValue:   p.marketValue ?? 0,
      latestPrice:   p.latestPrice ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
      realizedPnl:   p.realizedPnl ?? 0,
      currency:      p.currency || 'USD',
      market:        p.market || 'US',
      identifier:    p.identifier || p.symbol,
    }));
    res.json({ positions: mapped, source: 'live' });
  } catch (err) {
    const isPerm = err.message?.includes('permission') || err.code === 4;
    // Return mock data alongside the error so the UI can still test the import flow
    res.status(isPerm ? 403 : 500).json({
      error:   err.message,
      code:    err.code,
      useMock: true,
      positions: [],
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Wheel Edge Tiger API server  →  http://localhost:${PORT}`);
  console.log(`   Health check: curl http://localhost:${PORT}/api/status\n`);
});
