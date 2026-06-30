/**
 * Wheel Edge — POEMS Import Commit Layer
 *
 * Bridges resolved, user-approved import rows into the EXISTING store
 * actions (addPosition/closePosition/addCampaign) — this file never talks
 * to IndexedDB directly. Every imported trade goes through exactly the same
 * position/execution-ledger/auto-journal pipeline as a manually-entered
 * trade, so imports can never drift out of sync with those invariants.
 */

import { useWheelStore } from '../wheel-edge-dashboard.jsx';
import { fingerprintTrade } from './importMatcher';

function mapTradeToPositionFields(trade) {
  const base = {
    symbol: trade.symbol,
    category: trade.category,
    entryDate: trade.tradeDate,
    notes: `Imported from ${trade.broker || 'POEMS'} contract note (${trade.sourceFile || 'unknown file'}).`,
    commission: trade.commission || 0,
    exchangeFees: trade.exchangeFees || 0,
    gst: trade.gst || 0,
    importedFrom: 'POEMS',
    importDate: new Date().toISOString(),
    importFingerprint: trade.fingerprint || fingerprintTrade(trade),
  };
  if (trade.assetType === 'option') {
    return {
      ...base,
      strike: trade.strike, expiry: trade.expiry, contracts: trade.contracts || 1,
      premium: trade.netAmount != null ? Math.abs(trade.netAmount) : (trade.premium || 0) * (trade.contracts || 1) * 100,
      currentValue: trade.premium,
    };
  }
  return {
    ...base,
    shareCount: trade.quantity,
    purchasePrice: trade.averagePrice,
    currentSharePrice: trade.averagePrice,
  };
}

function mapTradeToCloseFields(trade) {
  const closeQty = trade.assetType === 'option' ? (trade.contracts || 1) : (trade.quantity || 1);
  const action = trade.buySell === 'BUY' ? 'Buy to Close' : 'Sell to Close';
  return {
    quantity: closeQty,
    buybackCost: trade.assetType === 'option' ? trade.premium : undefined,
    salePrice: trade.assetType === 'equity' ? trade.averagePrice : undefined,
    fees: trade.commission || 0,
    exchangeFees: trade.exchangeFees || 0,
    gst: trade.gst || 0,
    notes: `Imported from ${trade.broker || 'POEMS'} contract note (${trade.sourceFile || 'unknown file'}).`,
    action,
    importFingerprint: trade.fingerprint || fingerprintTrade(trade),
  };
}

// New-campaign ids are computed deterministically (matching addCampaign's
// own `${symbol}-${n}` scheme) rather than re-read from the store after the
// call, since the `campaigns` array passed in is a snapshot, not a live
// reference, and would appear stale immediately after addCampaign() runs.
function resolveOrCreateCampaign(trade, campaigns, addCampaign, newCampaignIdsBySymbol, result) {
  if (!trade.isNewCampaign) return trade.campaignId || null;
  if (newCampaignIdsBySymbol.has(trade.symbol)) return newCampaignIdsBySymbol.get(trade.symbol);
  const existingCount = campaigns.filter((c) => c.symbol === trade.symbol).length;
  const id = `${trade.symbol.toLowerCase()}-${existingCount + 1}`;
  addCampaign({ symbol: trade.symbol, name: `${trade.symbol} Wheel`, notes: 'Auto-created during POEMS import.' });
  newCampaignIdsBySymbol.set(trade.symbol, id);
  result.campaignsUpdated++;
  return id;
}

/**
 * @param {Array} resolvedTrades  output of importMatcher.resolveBatch(), with
 *   `selected` flags applied by the Preview stage
 * @param {{addPosition, closePosition, addCampaign, campaigns}} actions
 */
export function commitImportBatch(resolvedTrades, { addPosition, closePosition, addCampaign, campaigns }) {
  const result = {
    imported: 0, skipped: 0, duplicates: 0, errors: [],
    positionsCreated: 0, executionsCreated: 0, journalEntriesCreated: 0, campaignsUpdated: 0,
  };
  const newCampaignIdsBySymbol = new Map();
  const syntheticToRealId = new Map();

  for (const trade of resolvedTrades) {
    if (!trade.selected) { result.skipped++; continue; }
    if (trade.isDuplicate) { result.duplicates++; continue; }

    try {
      const isOpen = trade.action === 'Sell to Open' || trade.action === 'Buy to Open';
      if (!trade.action || (isOpen ? !trade.category : !trade.targetPositionId)) {
        throw new Error('Trade is missing a resolved action/category/target position.');
      }

      const campaignId = resolveOrCreateCampaign(trade, campaigns, addCampaign, newCampaignIdsBySymbol, result);

      if (isOpen) {
        addPosition({ ...mapTradeToPositionFields(trade), campaignId });
        result.positionsCreated++; result.executionsCreated++; result.journalEntriesCreated++;
        if (trade._syntheticId) {
          // addPosition's id assignment is Math.max(existingIds)+1, applied
          // synchronously inside set() — the freshest position is the one
          // just added.
          const fresh = useWheelStore.getState().positions;
          const created = fresh[fresh.length - 1];
          syntheticToRealId.set(trade._syntheticId, created.id);
        }
      } else {
        const realTargetId = trade.targetIsSynthetic
          ? syntheticToRealId.get(trade.targetPositionId)
          : trade.targetPositionId;
        if (realTargetId == null) throw new Error('Could not resolve the linked position for this closing trade.');
        closePosition(realTargetId, mapTradeToCloseFields(trade));
        result.executionsCreated++; // closePosition only auto-journals on a full close — still counted as one execution
      }
      result.imported++;
    } catch (err) {
      result.errors.push({ trade, message: err.message });
    }
  }
  return result;
}
