/**
 * Wheel Edge — Tiger Import Service
 *
 * Provider-agnostic import layer. Tiger-specific logic lives here.
 * Future providers (IBKR, CSV, Manual) should follow the same interface.
 */

const BASE = 'http://localhost:3001/api';

// ── Mock data ─────────────────────────────────────────────────────────────────
// Used when Tiger API unavailable (permission error or server offline).

export const MOCK_TIGER_POSITIONS = [
  { symbol: 'TSLA', secType: 'STK', quantity: 100, averageCost: 385.80, marketValue: 41115, latestPrice: 411.15, currency: 'USD', unrealizedPnl: 2535,  realizedPnl: 0 },
  { symbol: 'IBIT', secType: 'STK', quantity: 100, averageCost: 84.50,  marketValue: 8432,  latestPrice: 84.32,  currency: 'USD', unrealizedPnl: -18,    realizedPnl: 0 },
  { symbol: 'BBAI', secType: 'STK', quantity: 100, averageCost: 11.15,  marketValue: 1245,  latestPrice: 12.45,  currency: 'USD', unrealizedPnl: 130,    realizedPnl: 0 },
  { symbol: 'XLF',  secType: 'STK', quantity: 100, averageCost: 37.50,  marketValue: 3782,  latestPrice: 37.82,  currency: 'USD', unrealizedPnl: 32,     realizedPnl: 0 },
];

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetch positions from Tiger via the local backend.
 * Returns { positions, source, error, useMock }
 */
export async function fetchTigerPositions() {
  try {
    const res = await fetch(`${BASE}/positions`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    if (!res.ok || data.error) {
      return {
        positions: [],
        source:    'error',
        error:     data.error || `HTTP ${res.status}`,
        useMock:   false,
      };
    }
    return { positions: data.positions || [], source: 'live', error: null, useMock: false };
  } catch {
    // Server not running — give the user a clear instruction rather than fake data.
    return {
      positions: [],
      source:    'offline',
      error:     'Backend server is not running.',
      useMock:   false,
    };
  }
}

// ── Category mapping ──────────────────────────────────────────────────────────

const SEC_TYPE_MAP = {
  STK:          'Long Shares',
  OPT:          'Short Put',
  PUT:          'Short Put',
  CALL:         'Covered Call',
  CASH:         'Cash',
  SHORT_PUT:    'Short Put',
  COVERED_CALL: 'Covered Call',
};

export function mapSecTypeToCategory(secType) {
  return SEC_TYPE_MAP[(secType || '').toUpperCase()] || 'Long Shares';
}

// ── Duplicate detection ───────────────────────────────────────────────────────

/**
 * Check whether a Tiger position likely duplicates an existing Wheel Edge position.
 * Matches on symbol + approximate average cost (within $0.05/share).
 */
export function detectDuplicates(tigerPos, existingPositions) {
  return existingPositions.filter(ep => {
    if (ep.symbol !== tigerPos.symbol) return false;
    if (ep.category === 'Long Shares') {
      return Math.abs((ep.purchasePrice || 0) - (tigerPos.averageCost || 0)) < 0.05;
    }
    if (ep.category === 'Short Put' || ep.category === 'Covered Call') {
      return Math.abs((ep.strike || 0) - (tigerPos.averageCost || 0)) < 1.0;
    }
    return false;
  });
}

// ── Normalise for review table ────────────────────────────────────────────────

/**
 * Turn a raw Tiger position into a review-row ready for the import modal.
 */
export function normaliseForReview(tigerPos, existingPositions, campaigns) {
  const category   = mapSecTypeToCategory(tigerPos.secType);
  const duplicates = detectDuplicates(tigerPos, existingPositions);

  // Default campaign: find existing campaign for this symbol
  const matchingCampaign = campaigns.find(c => c.symbol === tigerPos.symbol && c.status === 'ACTIVE');

  return {
    _id:           `${tigerPos.symbol}-${tigerPos.secType}-${tigerPos.averageCost}`,
    symbol:        tigerPos.symbol,
    secType:       tigerPos.secType || 'STK',
    quantity:      tigerPos.quantity,
    averageCost:   tigerPos.averageCost,
    marketValue:   tigerPos.marketValue,
    latestPrice:   tigerPos.latestPrice,
    unrealizedPnl: tigerPos.unrealizedPnl,
    currency:      tigerPos.currency || 'USD',
    // Editable fields
    selected:      duplicates.length === 0,   // auto-deselect duplicates
    category,
    campaignId:    matchingCampaign?.id || '',
    notes:         '',
    skipDuplicate: false,
    duplicates,
  };
}

// ── Build Wheel Edge position from review row ─────────────────────────────────

export function buildWheelEdgePosition(row) {
  const now   = new Date().toISOString();
  const today = now.split('T')[0];
  const base  = {
    symbol:       row.symbol,
    category:     row.category,
    status:       'OPEN',
    campaignId:   row.campaignId || null,
    entryDate:    today,
    notes:        row.notes || '',
    closedData:   null,
    journalEntryIds: [],
    importedFrom: 'Tiger',
    importDate:   now,
  };

  if (row.category === 'Long Shares') {
    return { ...base, shareCount: row.quantity, purchasePrice: row.averageCost, currentSharePrice: row.latestPrice || row.averageCost };
  }
  if (row.category === 'Short Put' || row.category === 'Covered Call') {
    return { ...base, strike: row.averageCost, premium: 0, currentValue: 0, contracts: Math.round(row.quantity / 100) || 1, expiry: '', dte: null };
  }
  if (row.category === 'Cash') {
    return { ...base, capitalAmount: row.marketValue, targetPrice: null, intent: row.notes };
  }
  return base;
}
