/**
 * Wheel Edge — Supabase Sync Service
 *
 * All writes are optimistic: Zustand updates immediately, Supabase syncs in
 * the background.  Reads on startup populate the Zustand store from Supabase
 * (source of truth).  Falls back to localStorage cache if Supabase is
 * unreachable.
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
});

// ─── Generic helpers ──────────────────────────────────────────────────────────

async function upsert(table, row) {
  if (!isSupabaseConfigured() || !supabase) return;
  const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
  if (error) log('warn', `upsert ${table}`, error.message);
}

async function remove(table, id) {
  if (!isSupabaseConfigured() || !supabase) return;
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) log('warn', `delete ${table}:${id}`, error.message);
}

async function fetchAll(table) {
  if (!isSupabaseConfigured() || !supabase) return null;
  const { data, error } = await supabase.from(table).select('*');
  if (error) { log('warn', `fetchAll ${table}`, error.message); return null; }
  return data;
}

// ─── Public sync API ──────────────────────────────────────────────────────────

export const syncPosition   = (p) => upsert('positions',      toDbPosition(p));
export const deletePos      = (id) => remove('positions',     id);

export const syncCampaign   = (c) => upsert('campaigns',      toDbCampaign(c));
export const deleteCampaign = (id) => remove('campaigns',     id);

export const syncJournal    = (e) => upsert('journal_entries', toDbJournalEntry(e));
export const deleteJournal  = (id) => remove('journal_entries', id);

export const syncCalEvent   = (e) => upsert('calendar_events', toDbCalendarEvent(e));
export const deleteCalEvent = (id) => remove('calendar_events', id);

export const syncWatchlist  = (w) => upsert('watchlist',       toDbWatchlistItem(w));
export const deleteWatch    = (id) => remove('watchlist',      id);

export const syncSnapshot   = (s) => upsert('recommendations', toDbSnapshot(s));

// ─── Bootstrap: load all data from Supabase on startup ───────────────────────

/**
 * Fetch every table and return camelCase objects ready for the Zustand store.
 * Returns null on any table if Supabase is unreachable — the caller should
 * fall back to localStorage.
 */
export async function loadAllFromSupabase() {
  if (!isSupabaseConfigured() || !supabase) {
    return { ok: false, reason: 'Supabase not configured' };
  }

  try {
    const [posRows, campRows, journalRows, calRows, watchRows, snapRows] =
      await Promise.all([
        fetchAll('positions'),
        fetchAll('campaigns'),
        fetchAll('journal_entries'),
        fetchAll('calendar_events'),
        fetchAll('watchlist'),
        fetchAll('recommendations'),
      ]);

    // Any null = table missing or permission error
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
    };
  } catch (err) {
    log('error', 'loadAllFromSupabase failed', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Push the entire local Zustand state to Supabase (used for initial seed
 * when the database is empty).
 */
export async function seedSupabaseFromLocal(state) {
  if (!isSupabaseConfigured() || !supabase) return;

  const batches = [
    { table: 'positions',      rows: state.positions.map(toDbPosition) },
    { table: 'campaigns',      rows: state.campaigns.map(toDbCampaign) },
    { table: 'journal_entries', rows: state.journal.map(toDbJournalEntry) },
    { table: 'calendar_events', rows: state.calendar.map(toDbCalendarEvent) },
    { table: 'watchlist',      rows: state.watchlist.map(toDbWatchlistItem) },
    { table: 'recommendations', rows: state.priceSnapshots.map(toDbSnapshot) },
  ];

  for (const { table, rows } of batches) {
    if (!rows.length) continue;
    const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' });
    if (error) log('warn', `seed ${table}`, error.message);
    else log('info', `seeded ${table}`, `${rows.length} rows`);
  }
}
