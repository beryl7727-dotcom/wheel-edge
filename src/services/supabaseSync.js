/**
 * Wheel Edge — Supabase Mapping & Read Service
 *
 * IndexedDB (src/services/db.js) is the source of truth the app runs on.
 * Supabase is a MANUAL cloud backup/restore target only — nothing in this
 * file writes to Supabase automatically. The mappers below convert between
 * the app's camelCase records and Supabase's snake_case rows; they're used
 * by cloudBackup.js (upload) and cloudRestore.js (download/diff/merge).
 *
 * Column naming: JS camelCase → DB snake_case via the mappers below.
 * Complex nested objects are stored as JSONB in an `extra` column so we never
 * lose fields when the schema evolves.
 */

import { supabase, isSupabaseConfigured } from './supabase';

// ─── Logging helper ──────────────────────────────────────────────────────────

const log = (level, msg, detail) => {
  if (process.env.NODE_ENV === 'development') {
    console[level](`[Supabase] ${msg}`, detail || '');
  }
};

// ─── Field mappers  JS → DB ────────────────────────────────────────────────

export const toDbPosition = (p) => ({
  id:                   p.id,
  symbol:               p.symbol,
  category:             p.category,
  status:               p.status,
  campaign_id:          p.campaignId    || null,
  entry_date:           p.entryDate     || null,
  contracts:            p.contracts     || 1,
  strike:               p.strike        ?? null,
  expiry:               p.expiry        || null,
  dte:                  p.dte           ?? null,
  premium:              p.premium       ?? null,
  current_value:        p.currentValue  ?? null,
  share_count:          p.shareCount    ?? null,
  purchase_price:       p.purchasePrice ?? null,
  current_share_price:  p.currentSharePrice ?? null,
  capital_amount:       p.capitalAmount ?? null,
  target_price:         p.targetPrice   ?? null,
  intent:               p.intent        || null,
  thesis:               p.thesis        || null,
  notes:                p.notes         || null,
  imported_from:        p.importedFrom  || null,
  import_date:          p.importDate    || null,
  // Complex blobs
  closed_data:          p.closedData          || null,
  journal_entry_ids:    p.journalEntryIds     || [],
  status_history:       p.statusHistory       || [],
  scenario_applied:     p.scenarioApplied     || null,
  extra:                {
    profitPercent:    p.profitPercent,
    theta:            p.theta,
    delta:            p.delta,
    commission:       p.commission        ?? null,
    avgPricePerShare: p.avgPricePerShare  ?? null,
    impliedVolatility:   p.impliedVolatility   ?? null,
    optionPurchasePrice: p.optionPurchasePrice ?? null,
    // Execution ledger upgrade — new position-level fields, no schema
    // migration needed since extra is a JSONB catch-all.
    sharesCovered:          p.sharesCovered          ?? null,
    underlyingPriceAtEntry: p.underlyingPriceAtEntry ?? null,
    shareCostBasisSnapshot: p.shareCostBasisSnapshot ?? null,
    openInterest:           p.openInterest           ?? null,
    exitPlan:               p.exitPlan               || null,
    tradeTags:              p.tradeTags              || [],
    openedFrom:             p.openedFrom             ?? null,
    rolledInto:             p.rolledInto             ?? null,
    closedBy:               p.closedBy               ?? null,
    replacementPosition:    p.replacementPosition    ?? null,
    remainingQuantity:      p.remainingQuantity      ?? null,
    partialRealizedPnL:     p.partialRealizedPnL     ?? 0,
    lifecycleStatus:        p.lifecycleStatus        || null,
    exchangeFees:           p.exchangeFees           ?? null,
    gst:                    p.gst                    ?? null,
  },
});

export const fromDbPosition = (row) => ({
  id:               row.id,
  symbol:           row.symbol,
  category:         row.category,
  status:           row.status,
  campaignId:       row.campaign_id,
  entryDate:        row.entry_date,
  contracts:        row.contracts,
  strike:           row.strike,
  expiry:           row.expiry,
  dte:              row.dte,
  premium:          row.premium,
  currentValue:     row.current_value,
  shareCount:       row.share_count,
  purchasePrice:    row.purchase_price,
  currentSharePrice: row.current_share_price,
  capitalAmount:    row.capital_amount,
  targetPrice:      row.target_price,
  intent:           row.intent,
  thesis:           row.thesis,
  notes:            row.notes,
  importedFrom:     row.imported_from,
  importDate:       row.import_date,
  closedData:       row.closed_data,
  journalEntryIds:  row.journal_entry_ids || [],
  statusHistory:    row.status_history    || [],
  scenarioApplied:  row.scenario_applied,
  profitPercent:    row.extra?.profitPercent,
  theta:            row.extra?.theta,
  delta:            row.extra?.delta,
  commission:        row.extra?.commission        ?? null,
  avgPricePerShare:  row.extra?.avgPricePerShare  ?? null,
  impliedVolatility:   row.extra?.impliedVolatility   ?? null,
  optionPurchasePrice: row.extra?.optionPurchasePrice ?? null,
  sharesCovered:          row.extra?.sharesCovered          ?? null,
  underlyingPriceAtEntry: row.extra?.underlyingPriceAtEntry ?? null,
  shareCostBasisSnapshot: row.extra?.shareCostBasisSnapshot ?? null,
  openInterest:           row.extra?.openInterest           ?? null,
  exitPlan:               row.extra?.exitPlan               ?? null,
  tradeTags:              row.extra?.tradeTags              || [],
  openedFrom:             row.extra?.openedFrom             ?? null,
  rolledInto:             row.extra?.rolledInto             ?? null,
  closedBy:               row.extra?.closedBy               ?? null,
  replacementPosition:    row.extra?.replacementPosition    ?? null,
  remainingQuantity:      row.extra?.remainingQuantity      ?? null,
  partialRealizedPnL:     row.extra?.partialRealizedPnL     ?? 0,
  lifecycleStatus:        row.extra?.lifecycleStatus        ?? null,
  exchangeFees:           row.extra?.exchangeFees           ?? null,
  gst:                    row.extra?.gst                    ?? null,
  updatedAt:        row.updated_at,
});

export const toDbCampaign = (c) => ({
  id:           c.id,
  symbol:       c.symbol,
  name:         c.name,
  created_date: c.createdDate || null,
  status:       c.status      || 'ACTIVE',
  notes:        c.notes       || null,
});

export const fromDbCampaign = (row) => ({
  id:          row.id,
  symbol:      row.symbol,
  name:        row.name,
  createdDate: row.created_date,
  status:      row.status,
  notes:       row.notes,
  updatedAt:   row.updated_at,
});

export const toDbJournalEntry = (e) => ({
  id:            e.id,
  date:          e.date        || null,
  symbol:        e.symbol      || null,
  position_id:   e.positionId  ?? null,
  trade:         e.trade       || null,
  result:        e.result      || null,
  tags:          e.tags        || [],
  edited:        e.edited      || false,
  trade_thesis:  e.tradeThesis  || null,
  simulator_rec: e.simulatorRec || null,
  my_decision:   e.myDecision   || null,
  outcome:       e.outcome      || null,
  edit_history:  e.editHistory  || [],
});

export const fromDbJournalEntry = (row) => ({
  id:            row.id,
  date:          row.date,
  symbol:        row.symbol,
  positionId:    row.position_id,
  trade:         row.trade,
  result:        row.result,
  tags:          row.tags        || [],
  edited:        row.edited,
  tradeThesis:   row.trade_thesis,
  simulatorRec:  row.simulator_rec,
  myDecision:    row.my_decision,
  outcome:       row.outcome,
  editHistory:   row.edit_history || [],
  updatedAt:     row.updated_at,
});

export const toDbCalendarEvent = (e) => ({
  id:          e.id,
  title:       e.title,
  date:        e.date,
  time:        e.time       || null,
  category:    e.category   || null,
  symbol:      e.symbol     || null,
  icon_emoji:  e.iconEmoji  || null,
  notes:       e.notes      || null,
  description: e.description || null,
});

export const fromDbCalendarEvent = (row) => ({
  id:          row.id,
  title:       row.title,
  date:        row.date,
  time:        row.time,
  category:    row.category,
  symbol:      row.symbol,
  iconEmoji:   row.icon_emoji,
  notes:       row.notes,
  description: row.description,
  updatedAt:   row.updated_at,
});

export const toDbWatchlistItem = (w) => ({
  id:           w.id,
  symbol:       w.symbol,
  price:        w.price        ?? null,
  trend:        w.trend        || null,
  support:      w.support      ?? null,
  resistance:   w.resistance   ?? null,
  bias:         w.bias         || null,
  notes:        w.notes        || null,
  last_updated: w.lastUpdated  || null,
});

export const fromDbWatchlistItem = (row) => ({
  id:          row.id,
  symbol:      row.symbol,
  price:       row.price,
  trend:       row.trend,
  support:     row.support,
  resistance:  row.resistance,
  bias:        row.bias,
  notes:       row.notes,
  lastUpdated: row.last_updated,
  updatedAt:   row.updated_at,
});

export const toDbSnapshot = (s) => ({
  id:              s.id,
  position_id:     s.positionId    ?? null,
  symbol:          s.symbol        || null,
  snapshot_date:   s.snapshotDate  || null,
  price:           s.price         ?? null,
  option_value:    s.optionValue   ?? null,
  iv:              s.iv            ?? null,
  days_to_expiry:  s.daysToExpiry  ?? null,
  recommendation:  s.recommendation || null,
  notes:           s.notes         || null,
  bid_ask:         s.bidAsk        || null,
});

export const fromDbSnapshot = (row) => ({
  id:            row.id,
  positionId:    row.position_id,
  symbol:        row.symbol,
  snapshotDate:  row.snapshot_date,
  price:         row.price,
  optionValue:   row.option_value,
  iv:            row.iv,
  daysToExpiry:  row.days_to_expiry,
  recommendation: row.recommendation,
  notes:         row.notes,
  bidAsk:        row.bid_ask,
  updatedAt:     row.updated_at,
});

// Executions — the immutable trade ledger. No update semantics on the
// Supabase side either; rows are only ever inserted, never upserted-over.
export const toDbExecution = (e) => ({
  id:                 e.id,
  position_id:        e.positionId        ?? null,
  campaign_id:        e.campaignId        || null,
  symbol:             e.symbol            || null,
  action:             e.action,
  date:               e.date              || null,
  quantity:           e.quantity          ?? null,
  execution_price:    e.executionPrice    ?? null,
  net_credit_debit:   e.netCreditDebit    ?? null,
  commission:         e.commission        || 0,
  exchange_fees:      e.exchangeFees      || 0,
  gst:                e.gst               || 0,
  notes:              e.notes             || null,
  linked_position_id: e.linkedPositionId  ?? null,
});

export const fromDbExecution = (row) => ({
  id:               row.id,
  positionId:       row.position_id,
  campaignId:       row.campaign_id,
  symbol:           row.symbol,
  action:           row.action,
  date:             row.date,
  quantity:         row.quantity,
  executionPrice:   row.execution_price,
  netCreditDebit:   row.net_credit_debit,
  commission:       row.commission,
  exchangeFees:     row.exchange_fees,
  gst:              row.gst,
  notes:            row.notes,
  linkedPositionId: row.linked_position_id,
  createdAt:        row.created_at,
});

// ─── Generic helpers ──────────────────────────────────────────────────────────

async function fetchAll(table) {
  if (!isSupabaseConfigured() || !supabase) return null;
  const { data, error } = await supabase.from(table).select('*');
  if (error) { log('warn', `fetchAll ${table}`, error.message); return null; }
  return data;
}

// ─── Read: fetch the full cloud snapshot (used by Restore from Cloud) ────────

/**
 * Fetch every table and return camelCase objects. Read-only — never called
 * automatically; only invoked when the user clicks "Restore from Cloud".
 * Returns {ok:false} on any table being unreachable.
 */
export async function loadAllFromSupabase() {
  if (!isSupabaseConfigured() || !supabase) {
    return { ok: false, reason: 'Supabase not configured' };
  }

  try {
    const [posRows, campRows, journalRows, calRows, watchRows, snapRows, execRows] =
      await Promise.all([
        fetchAll('positions'),
        fetchAll('campaigns'),
        fetchAll('journal_entries'),
        fetchAll('calendar_events'),
        fetchAll('watchlist'),
        fetchAll('recommendations'),
        fetchAll('executions'), // optional — table may not exist until schema.sql is re-run; treated as empty, not fatal
      ]);

    // Any null = table missing or permission error (executions excluded — optional/new)
    if ([posRows, campRows, journalRows, calRows, watchRows].includes(null)) {
      return { ok: false, reason: 'One or more tables unreachable' };
    }

    return {
      ok:        true,
      positions: posRows.map(fromDbPosition),
      campaigns: campRows.map(fromDbCampaign),
      journal:   journalRows.map(fromDbJournalEntry),
      calendar:  calRows.map(fromDbCalendarEvent),
      watchlist: watchRows.map(fromDbWatchlistItem),
      priceSnapshots: (snapRows || []).map(fromDbSnapshot),
      executions: (execRows || []).map(fromDbExecution),
    };
  } catch (err) {
    log('error', 'loadAllFromSupabase failed', err.message);
    return { ok: false, reason: err.message };
  }
}
