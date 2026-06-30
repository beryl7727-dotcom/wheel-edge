/**
 * Wheel Edge — Import Matching & Inference
 *
 * Pure logic — duplicate detection, position/campaign matching, and
 * Action/Category inference for the POEMS import wizard. No UI or store
 * imports (only the broker-agnostic POSITION_CATEGORIES helpers); takes
 * plain data in, returns plain data out, so it's reusable by future broker
 * adapters without modification.
 */

import { isOptCat } from '../wheel-edge-dashboard.jsx';

// ── fingerprinting ──────────────────────────────────────────────────────

// FNV-1a — small deterministic string hash, no crypto dependency needed.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function fingerprintTrade(trade) {
  const parts = [
    trade.contractNumber || '', trade.orderExecId || '', trade.tradeDate || '',
    trade.symbol || '', trade.strike ?? '', trade.expiry || '',
    trade.contracts ?? trade.quantity ?? '',
  ];
  return fnv1a(parts.join('|'));
}

export function findDuplicates(trades, existingExecutions) {
  const existingFingerprints = new Set(
    existingExecutions.map((e) => e.importFingerprint).filter(Boolean)
  );
  return trades.map((t) => {
    const fingerprint = fingerprintTrade(t);
    return { ...t, fingerprint, isDuplicate: existingFingerprints.has(fingerprint) };
  });
}

// ── position matching ───────────────────────────────────────────────────

function tradeMatchesPosition(trade, p) {
  if (trade.assetType === 'option') {
    // This app only models short option categories (Naked Call/Put, Short
    // Put, Covered Call). Only a BUY can close one — a SELL never "closes"
    // an option position here, it only opens or adds to a short. Without
    // this direction check, two same-contract SELL fills in one batch would
    // wrongly match each other as an open/close pair.
    if (trade.buySell !== 'BUY') return false;
    return isOptCat(p.category) && p.symbol === trade.symbol
      && Number(p.strike) === Number(trade.strike) && p.expiry === trade.expiry;
  }
  // Equity: only a SELL can close/reduce an existing Long Shares lot.
  if (trade.buySell !== 'SELL') return false;
  return p.category === 'Long Shares' && p.symbol === trade.symbol;
}

export function findCandidatePositions(trade, openPositions) {
  return openPositions.filter((p) => tradeMatchesPosition(trade, p));
}

// ── action/category inference ───────────────────────────────────────────

export function inferActionAndCategory(trade, candidates, sharePositionsForSymbol) {
  const isSell = trade.buySell === 'SELL';
  const isOption = trade.assetType === 'option';

  if (candidates.length === 1) {
    const target = candidates[0];
    return { action: isSell ? 'Sell to Close' : 'Buy to Close', category: target.category, targetPositionId: target.id, needsResolution: false };
  }
  if (candidates.length > 1) {
    return {
      action: null, category: null, targetPositionId: null, needsResolution: true,
      resolutionReason: 'Multiple open positions match this trade’s symbol/strike/expiry — pick which one this closes.',
    };
  }

  // No candidates — an opening trade (or unsupported short-sale of equity).
  if (isSell) {
    if (!isOption) {
      return {
        action: null, category: null, targetPositionId: null, needsResolution: true,
        resolutionReason: 'Sell with no matching open Long Shares position — short selling isn’t a supported category here.',
      };
    }
    const coveringShares = sharePositionsForSymbol.reduce((s, p) => s + (p.shareCount || 0), 0);
    const neededShares = (trade.contracts || 1) * 100;
    const category = trade.callPut === 'Call'
      ? (coveringShares >= neededShares ? 'Covered Call' : 'Naked Call')
      : 'Short Put';
    return { action: 'Sell to Open', category, targetPositionId: null, needsResolution: false };
  }

  // BUY with no candidates.
  if (!isOption) {
    return { action: 'Buy to Open', category: 'Long Shares', targetPositionId: null, needsResolution: false };
  }
  // A genuinely new long option position isn't a category this app's P&L
  // model supports yet — Dashboard/Campaign aggregates assume option
  // `premium` is always a credit received, which would be wrong for a long
  // (debit-paid) position. Flag for manual handling rather than silently
  // creating a mismodeled position.
  return {
    action: 'Buy to Open', category: null, targetPositionId: null, needsResolution: true,
    resolutionReason: 'Buying to open a new long option position isn’t a supported category yet — please handle this trade manually.',
  };
}

// ── campaign grouping ───────────────────────────────────────────────────

export function groupIntoCampaigns(trades, existingCampaigns) {
  const bySymbol = new Map();
  for (const t of trades) {
    if (bySymbol.has(t.symbol)) continue;
    const active = existingCampaigns.find((c) => c.symbol === t.symbol && c.status === 'ACTIVE');
    bySymbol.set(t.symbol, active ? { campaignId: active.id, isNewCampaign: false } : { campaignId: null, isNewCampaign: true });
  }
  return trades.map((t) => ({ ...t, ...bySymbol.get(t.symbol) }));
}

// ── full batch resolution ───────────────────────────────────────────────

/**
 * Resolves an entire import batch in one pass: duplicate-flags every trade,
 * then walks trades in tradeDate order maintaining a list of synthetic
 * "will-exist" open positions seeded from earlier OPENING trades in the
 * same batch — so a same-statement open+close pair (e.g. sold then bought
 * back within one month's contract notes) links correctly even though
 * neither side exists in the store yet. Synthetic targets are tagged
 * `targetIsSynthetic: true` with a string `_syntheticId` so the commit layer
 * (poemsImportCommit.js) can resolve them to real position ids as it goes.
 */
export function resolveBatch(trades, { existingPositions, existingCampaigns, existingExecutions }) {
  const withDupes = findDuplicates(trades, existingExecutions);
  const sorted = [...withDupes].sort((a, b) => (a.tradeDate || '').localeCompare(b.tradeDate || ''));

  const realOpen = existingPositions.filter((p) => p.status === 'OPEN');
  const synthetic = []; // positions that will exist once earlier trades in this batch commit

  const resolved = sorted.map((trade, idx) => {
    if (trade.isDuplicate) {
      return { ...trade, action: null, category: null, targetPositionId: null, needsResolution: false };
    }

    const candidates = [
      ...findCandidatePositions(trade, realOpen),
      ...findCandidatePositions(trade, synthetic),
    ];
    const sharePositionsForSymbol = realOpen.filter((p) => p.category === 'Long Shares' && p.symbol === trade.symbol);
    const inference = inferActionAndCategory(trade, candidates, sharePositionsForSymbol);

    const targetIsSynthetic = inference.targetPositionId != null
      && synthetic.some((p) => p.id === inference.targetPositionId);

    const result = { ...trade, ...inference, targetIsSynthetic, candidates };

    // Opening trades become synthetic candidates for later trades in this batch.
    if (inference.action === 'Sell to Open' || inference.action === 'Buy to Open') {
      const syntheticId = `__batch_${idx}__`;
      synthetic.push({
        id: syntheticId, status: 'OPEN', category: inference.category,
        symbol: trade.symbol, strike: trade.strike, expiry: trade.expiry,
        shareCount: trade.assetType === 'equity' ? trade.quantity : undefined,
      });
      result._syntheticId = syntheticId;
    }
    return result;
  });

  return groupIntoCampaigns(resolved, existingCampaigns);
}
