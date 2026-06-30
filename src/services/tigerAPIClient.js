/**
 * Wheel Edge — Tiger API Frontend Client
 * Calls the local backend server (port 3001) which holds the private key.
 */

const BASE = 'http://localhost:3001/api';

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function checkConnectionStatus() {
  try {
    const data = await apiFetch('/status');
    return { connected: data.connected, marketState: data.marketState, timestamp: data.timestamp, error: data.error };
  } catch (err) {
    return { connected: false, error: err.message, timestamp: new Date().toISOString() };
  }
}

export async function getQuote(symbol) {
  return apiFetch(`/quote/${encodeURIComponent(symbol)}`);
}

export async function getQuotes(symbols) {
  return apiFetch(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
}

export async function getOptionExpiry(symbol) {
  return apiFetch(`/option-expiry/${encodeURIComponent(symbol)}`);
}

export async function getOptionChain(symbol, expiry) {
  return apiFetch(`/option-chain/${encodeURIComponent(symbol)}?expiry=${encodeURIComponent(expiry)}`);
}

export async function getMarketState(market = 'US') {
  return apiFetch(`/market-state?market=${market}`);
}
