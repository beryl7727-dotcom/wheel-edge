import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { checkConnectionStatus } from './services/tigerAPIClient.js';
import { fetchTigerPositions, normaliseForReview, buildWheelEdgePosition } from './services/tigerImportService.js';
import { db, DOMAIN_TABLE_NAMES } from './services/db.js';
import { writeThrough, deleteThrough, registerLocalSaveListener } from './services/writeThrough.js';
import { addExecution } from './services/executions.js';
import { getLastCloudBackupAt } from './services/cloudBackup.js';
import { SyncStatusIndicator, SaveToCloudButton, RestoreFromCloudButton, SnapshotHistoryList } from './components/BackupUI.jsx';
import { RollPositionModal, PositionLineageTimeline } from './components/ExecutionLedgerUI.jsx';
import PoemsImportWizard from './components/PoemsImportWizard.jsx';
import * as XLSX from 'xlsx';

const LOCALSTORAGE_MIGRATION_FLAG = 'migratedFromLocalStorage';
const LEGACY_PERSIST_KEY = 'wheel-edge-store-v1';

// ============================================================================
// MOCK DATA
// ============================================================================

const ACCOUNT_SNAPSHOT = {
  netLiqValue: 72843.21,
  dayPnL: { value: 1203.45, percent: 1.68 },
  buyingPower: 28642.11,
  cashAvailable: 12450.33,
  optionsBP: 16191.78,
  marketStatus: 'Live',
  marketsDate: 'US 🇺🇸',
};

// Position category metadata
export const POSITION_CATEGORIES = {
  'Cash':         { icon: '💵', bg: 'bg-yellow-100', text: 'text-yellow-800', dot: 'bg-yellow-500' },
  'Short Put':    { icon: '📉', bg: 'bg-red-100',    text: 'text-red-700',    dot: 'bg-red-500' },
  'Long Shares':  { icon: '📈', bg: 'bg-blue-100',   text: 'text-blue-700',   dot: 'bg-blue-500' },
  'Covered Call': { icon: '📋', bg: 'bg-green-100',  text: 'text-green-700',  dot: 'bg-green-500' },
  'Naked Call':   { icon: '🔺', bg: 'bg-orange-100', text: 'text-orange-800', dot: 'bg-orange-500' },
  'Naked Put':    { icon: '🔻', bg: 'bg-pink-100',   text: 'text-pink-700',   dot: 'bg-pink-500' },
};

// Option category helpers — always use these instead of hardcoded string comparisons.
export const isOptCat  = cat => cat === 'Short Put' || cat === 'Covered Call' || cat === 'Naked Call' || cat === 'Naked Put';
export const isCallCat = cat => cat === 'Covered Call' || cat === 'Naked Call';
export const isPutCat  = cat => cat === 'Short Put'    || cat === 'Naked Put';

const CALENDAR_CATEGORIES = [
  { id: 'earnings',   label: 'Earnings',    icon: '📊', bg: 'bg-red-100',    text: 'text-red-700',    color: '#ef4444' },
  { id: 'expiration', label: 'Expirations', icon: '⏰', bg: 'bg-orange-100', text: 'text-orange-700', color: '#f97316' },
  { id: 'economic',   label: 'Economic',    icon: '🏦', bg: 'bg-blue-100',   text: 'text-blue-700',   color: '#3b82f6' },
  { id: 'crypto',     label: 'Crypto',      icon: '₿',  bg: 'bg-amber-100',  text: 'text-amber-700',  color: '#f59e0b' },
  { id: 'tesla',      label: 'Tesla',       icon: '⚡', bg: 'bg-red-50',     text: 'text-red-600',    color: '#cc0000' },
  { id: 'personal',   label: 'Personal',    icon: '📝', bg: 'bg-green-100',  text: 'text-green-700',  color: '#22c55e' },
];

const CAT_COLOR = (catId) => (CALENDAR_CATEGORIES.find(c => c.id === catId)?.color || '#94a3b8');
const CAT_META  = (catId) =>  CALENDAR_CATEGORIES.find(c => c.id === catId) || { label: catId, icon: '📌', bg: 'bg-slate-100', text: 'text-slate-700', color: '#94a3b8' };

const MOCK_SCENARIOS = [
  {
    id: 1,
    positionId: 1,
    name: 'Bull Case - TSLA to $450',
    price: 450,
    dte: 15,
    probability: 0.25,
    outcome: 'Call Assigned, New Put',
    totalProfit: 420,
    notes: 'Spike on earnings beat',
  },
  {
    id: 2,
    positionId: 1,
    name: 'Base Case - TSLA stays 400-420',
    price: 410,
    dte: 31,
    probability: 0.50,
    outcome: 'Expired OTM, Repeat Wheel',
    totalProfit: 420,
    notes: 'Most likely scenario',
  },
];


// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export const useWheelStore = create(
  persist(
    (set, get) => ({
  positions: [],
  journal: [],
  calendar: [],
  calendarCategories: CALENDAR_CATEGORIES,
  visibleCategories: CALENDAR_CATEGORIES.map(c => c.id),
  selectedEvent: null,
  campaigns: [],
  watchlist: [],
  watchlistMode: 'MANUAL',
  scenarios: MOCK_SCENARIOS,
  accountSnapshot: ACCOUNT_SNAPSHOT,

  // Market Planning Board — standalone, not connected to positions/campaigns
  planningMeta: {
    tesla:   { lastUpdated: '' },
    bitcoin: { lastUpdated: '' },
  },

  // Legacy asset-specific calculator data — preserved, not displayed
  ccCalculator: {
    tesla:   { costBasis: '', premium: '', selectedStrike: '' },
    bitcoin: { costBasis: '', premium: '', selectedStrike: '' },
  },

  // Universal wheel trading calculators — planning tools only, no trade data connection
  wheelCalcs: {
    coveredCall: { costBasis: '', premium: '', selectedStrike: '' },
    cashPut:     { putStrike: '', premiumTotal: '', marketPrice: '' },
  },

  // Monthly goals for Income Tracker — keyed by year then month number
  monthlyGoals: {
    '2026': { 1:1500, 2:1500, 3:1500, 4:1500, 5:1500, 6:1500, 7:1500, 8:1500, 9:1500, 10:1500, 11:1500, 12:1500 },
    '2027': {},
    '2028': {},
  },
  planningBoard: {
    tesla: [
      { id: 1, dte: '7',  support: '', resistance: '', trigger: 'Sell Put',  notes: '' },
      { id: 2, dte: '14', support: '', resistance: '', trigger: 'Sell Call', notes: '' },
      { id: 3, dte: '30', support: '', resistance: '', trigger: 'Wait',      notes: '' },
    ],
    bitcoin: [
      { id: 1, dte: '7',  support: '', resistance: '', trigger: 'Sell Put',  notes: '' },
      { id: 2, dte: '14', support: '', resistance: '', trigger: 'Sell Call', notes: '' },
      { id: 3, dte: '30', support: '', resistance: '', trigger: 'Wait',      notes: '' },
    ],
  },

  // Supabase connection status (informational only — Supabase is a manual
  // backup target now, this is not used to gate any automatic sync)
  supabaseStatus: { ok: false, reason: 'Not checked yet', lastChecked: null },
  setSupabaseStatus: (s) => set({ supabaseStatus: { ...s, lastChecked: new Date().toISOString() } }),

  // "🟢 Local Saved" status — bumped by writeThrough/deleteThrough on every
  // successful IndexedDB write, surfaced by SyncStatusIndicator.
  localSyncStatus: { savedAt: null },

  // Data source toggle
  dataSource: 'MANUAL',
  tigerConnectionStatus: {
    connected: false, authenticated: false,
    accountVerified: false, realtimeQuotesEnabled: false,
    lastChecked: null, error: null,
  },

  // Price snapshots for Manual Mode
  priceSnapshots: [],

  // Immutable execution ledger — read-only display data, hydrated from
  // IndexedDB on boot and refreshed after any addExecution() call. Never
  // mutated directly via set() from anywhere else.
  executions: [],
  refreshExecutions: async () => {
    const executions = await db.executions.toArray();
    set({ executions });
  },

  setDataSource: (source) => set({ dataSource: source }),

  updateTigerStatus: (status) => set({
    tigerConnectionStatus: { ...status, lastChecked: new Date().toISOString() },
  }),

  addPriceSnapshot: (snapshot) => {
    writeThrough('priceSnapshots', snapshot);
    set(state => ({ priceSnapshots: [snapshot, ...state.priceSnapshots] }));
  },

  getPriceSnapshotsForPosition: (positionId) => {
    const state = get();
    return state.priceSnapshots
      .filter(s => s.positionId === positionId)
      .sort((a, b) => new Date(b.snapshotDate) - new Date(a.snapshotDate));
  },

  getLatestSnapshot: (positionId) => {
    const state = get();
    const snaps = state.priceSnapshots.filter(s => s.positionId === positionId);
    return snaps[0] ?? null;
  },

  updatePosition: (id, data) => set(state => {
    const updated = state.positions.map(p => p.id === id ? { ...p, ...data } : p);
    const pos = updated.find(p => p.id === id);
    if (pos) writeThrough('positions', pos);
    return { positions: updated };
  }),

  deletePosition: (id) => {
    deleteThrough('positions', id);
    set(state => ({ positions: state.positions.filter(p => p.id !== id) }));
  },

  addPosition: (position) => set(state => {
    const isShares = position.category === 'Long Shares';
    const isCash   = position.category === 'Cash';
    const newPos = {
      ...position,
      id: Math.max(0, ...state.positions.map(p => p.id)) + 1,
      status: 'OPEN', closedData: null, journalEntryIds: [],
      lifecycleStatus: isCash ? undefined : 'Open',
      remainingQuantity: isCash ? undefined : isShares ? (position.shareCount || 0) : (position.contracts || 1),
      partialRealizedPnL: 0,
    };
    writeThrough('positions', newPos);

    // Every opening trade becomes a permanent ledger entry. Cash reservations
    // aren't trades, so they're excluded — consistent with the backfill migration.
    if (!isCash) {
      const openQty = isShares ? (newPos.shareCount || 0) : (newPos.contracts || 1);
      const action  = isShares ? 'Buy to Open' : 'Sell to Open';
      const exec = {
        positionId: newPos.id, campaignId: newPos.campaignId || null, symbol: newPos.symbol,
        action, date: newPos.entryDate, quantity: openQty,
        executionPrice: isShares ? (newPos.purchasePrice || 0) : (newPos.premium || 0) / (openQty * 100 || 1),
        netCreditDebit: isShares ? -(newPos.purchasePrice || 0) * openQty : (newPos.premium || 0),
        commission: newPos.commission || 0, exchangeFees: newPos.exchangeFees || 0, gst: newPos.gst || 0,
        notes: '', linkedPositionId: null,
        importFingerprint: position.importFingerprint || null,
      };
      addExecution(exec).catch(err => console.error('[addPosition] failed to record execution', err));
      get().createAutoJournalEntry(newPos, exec, action);
    }

    return { positions: [...state.positions, newPos] };
  }),

  // Close (fully or partially) a position — category-aware P&L calculation.
  // closeData.quantity enables partial closes; omitted, it defaults to the
  // position's full remaining quantity (fully backward compatible with every
  // existing call site). closeData.action drives the new Action taxonomy
  // (Buy to Close/Sell to Close/Assignment/Exercise/Expired/Roll) and falls
  // back to closeData.reason for older callers.
  closePosition: (positionId, closeData) => set(state => {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos) return state;

    const isShares = pos.category === 'Long Shares';
    const isCash   = pos.category === 'Cash';
    const startingRemaining = pos.remainingQuantity ?? (isShares ? pos.shareCount : pos.contracts) ?? 1;
    const closeQty = closeData.quantity ?? closeData.shares ?? startingRemaining;
    const isFullClose = closeQty >= startingRemaining;

    let thisCloseRealizedPnL = 0;
    if (isOptCat(pos.category)) {
      const buybackTotal   = (closeData.buybackCost || 0) * closeQty * 100;
      const premiumPortion = (pos.premium || 0) * (closeQty / (pos.contracts || 1));
      thisCloseRealizedPnL = premiumPortion - buybackTotal - (closeData.fees || 0);
    } else if (isShares) {
      const gainPerShare = (closeData.salePrice || 0) - effectiveCostBasis(pos);
      thisCloseRealizedPnL = gainPerShare * closeQty - (closeData.fees || 0);
    } // Cash: 0, unchanged

    const newRemaining   = startingRemaining - closeQty;
    const action         = closeData.action || closeData.reason;
    const lifecycleStatus = !isFullClose ? 'Partial'
      : action === 'Assignment' ? 'Assigned'
      : action === 'Expired'    ? 'Expired'
      : action === 'Roll'       ? 'Rolled'
      : 'Closed';
    const accumulatedPnL = (pos.partialRealizedPnL || 0) + thisCloseRealizedPnL;

    const updated = {
      ...pos,
      remainingQuantity: newRemaining,
      partialRealizedPnL: isFullClose ? (pos.partialRealizedPnL || 0) : accumulatedPnL,
      lifecycleStatus,
      ...(isFullClose ? {
        status: 'CLOSED',
        closedData: {
          closedDate: new Date().toISOString().split('T')[0],
          ...closeData,
          realizedPnL: accumulatedPnL,
        },
      } : {}),
    };
    writeThrough('positions', updated);

    if (!isCash) {
      const execAction = action || (isShares ? 'Sell to Close' : 'Buy to Close');
      const exec = {
        positionId, campaignId: pos.campaignId || null, symbol: pos.symbol,
        action: execAction,
        date: updated.closedData?.closedDate || new Date().toISOString().split('T')[0],
        quantity: closeQty,
        executionPrice: closeData.buybackCost ?? closeData.salePrice ?? null,
        netCreditDebit: thisCloseRealizedPnL,
        commission: 0, exchangeFees: closeData.fees || 0, gst: closeData.gst || 0,
        notes: closeData.notes || '', linkedPositionId: null,
        importFingerprint: closeData.importFingerprint || null,
      };
      addExecution(exec).catch(err => console.error('[closePosition] failed to record execution', err));
      // Auto-journal only on a full close — a partial close is none of
      // "opened, closed, rolled, assigned, or expires" on its own.
      if (isFullClose) get().createAutoJournalEntry(updated, exec, execAction);
    }

    return { positions: state.positions.map(p => p.id === positionId ? updated : p) };
  }),

  // Reopen a closed position — clears closedData and restores OPEN status
  reopenPosition: (positionId) => set(state => {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos || pos.status !== 'CLOSED') return state;
    const reopened = {
      ...pos, status: 'OPEN', closedData: null,
      lifecycleStatus: pos.category === 'Cash' ? undefined : 'Open',
      remainingQuantity: pos.category === 'Cash' ? undefined
        : pos.category === 'Long Shares' ? (pos.shareCount || 0) : (pos.contracts || 1),
    };
    writeThrough('positions', reopened);
    return { positions: state.positions.map(p => p.id === positionId ? reopened : p) };
  }),

  // Roll a position — closes the old leg in full and opens a new linked leg
  // in one combined action, computing the net credit/debit across both.
  rollPosition: (oldPositionId, rollData) => set(state => {
    const oldPos = state.positions.find(p => p.id === oldPositionId);
    if (!oldPos) return state;

    const oldContracts   = oldPos.contracts || 1;
    const oldBuybackCost = rollData.buybackCost || 0;
    const oldFees        = rollData.oldFees || 0;
    const oldRealizedPnL = (oldPos.premium || 0) - (oldBuybackCost * oldContracts * 100) - oldFees;

    const newId = Math.max(0, ...state.positions.map(p => p.id)) + 1;

    const closedOld = {
      ...oldPos,
      status: 'CLOSED', lifecycleStatus: 'Rolled', remainingQuantity: 0,
      rolledInto: newId,
      closedData: {
        closedDate: rollData.newEntryDate || new Date().toISOString().split('T')[0],
        buybackCost: oldBuybackCost, fees: oldFees, reason: 'Roll', action: 'Roll',
        realizedPnL: (oldPos.partialRealizedPnL || 0) + oldRealizedPnL,
      },
    };

    const newPos = {
      symbol: oldPos.symbol, category: oldPos.category, campaignId: oldPos.campaignId,
      id: newId, status: 'OPEN', closedData: null, journalEntryIds: [],
      entryDate: rollData.newEntryDate, strike: rollData.newStrike, expiry: rollData.newExpiry,
      dte: rollData.newDte, premium: rollData.newPremium, contracts: rollData.newContracts || oldContracts,
      currentValue: rollData.newPremium,
      lifecycleStatus: 'Open', remainingQuantity: rollData.newContracts || oldContracts, partialRealizedPnL: 0,
      openedFrom: oldPositionId, thesis: oldPos.thesis, notes: rollData.notes || '',
    };

    writeThrough('positions', closedOld);
    writeThrough('positions', newPos);

    const closeExec = {
      positionId: oldPositionId, campaignId: oldPos.campaignId || null, symbol: oldPos.symbol,
      action: 'Roll', date: closedOld.closedData.closedDate, quantity: oldContracts,
      executionPrice: oldBuybackCost, netCreditDebit: -(oldBuybackCost * oldContracts * 100) - oldFees,
      commission: 0, exchangeFees: oldFees, gst: 0, notes: 'Roll — closing leg', linkedPositionId: newId,
    };
    const openExec = {
      positionId: newId, campaignId: newPos.campaignId || null, symbol: newPos.symbol,
      action: 'Sell to Open', date: newPos.entryDate, quantity: newPos.contracts,
      executionPrice: (rollData.newPremium || 0) / (newPos.contracts * 100 || 1),
      netCreditDebit: (rollData.newPremium || 0) - (rollData.newFees || 0),
      commission: 0, exchangeFees: rollData.newFees || 0, gst: 0, notes: 'Roll — opening leg', linkedPositionId: null,
    };
    addExecution(closeExec).catch(err => console.error('[rollPosition] failed to record closing execution', err));
    addExecution(openExec).catch(err => console.error('[rollPosition] failed to record opening execution', err));

    // One combined journal entry for the whole roll — not one per leg.
    get().createAutoJournalEntry(closedOld, closeExec, 'Roll');

    return { positions: [...state.positions.map(p => p.id === oldPositionId ? closedOld : p), newPos] };
  }),

  // Auto-generates a journal entry for a lifecycle event (opened/closed/
  // rolled/assigned/expired). Reuses the existing addJournalEntryFromScenario
  // write-through path verbatim.
  createAutoJournalEntry: (position, execution, action) => {
    const slug = (action || '').toLowerCase().replace(/\s+/g, '-');
    get().addJournalEntryFromScenario({
      id: Date.now(),
      date: execution?.date || new Date().toISOString().split('T')[0],
      symbol: position.symbol,
      positionId: position.id,
      trade: `${position.category} — ${action}`,
      result: 'Auto-logged',
      tags: ['auto-generated', slug],
      tradeThesis: { reason: `${action} recorded automatically.`, support: '', target: '', happyAssignment: false },
      simulatorRec: null,
      myDecision: { action: '', reasoning: '', decidedDate: '' },
      outcome: execution?.netCreditDebit != null
        ? { completedDate: execution.date, action, finalProfit: execution.netCreditDebit, lesson: '' }
        : { completedDate: '', action: '', finalProfit: null, lesson: '' },
    });
  },

  addCampaign: (campaign) => set(state => {
    const newCamp = {
      ...campaign,
      id: `${campaign.symbol.toLowerCase()}-${state.campaigns.filter(c => c.symbol === campaign.symbol).length + 1}`,
      createdDate: new Date().toISOString().split('T')[0],
      status: 'ACTIVE',
    };
    writeThrough('campaigns', newCamp);
    return { campaigns: [...state.campaigns, newCamp] };
  }),

  updateCampaign: (campaignId, data) => set(state => {
    const updated = state.campaigns.map(c => c.id === campaignId ? { ...c, ...data } : c);
    const camp = updated.find(c => c.id === campaignId);
    if (camp) writeThrough('campaigns', camp);
    return { campaigns: updated };
  }),

  deleteCampaignById: (campaignId) => {
    deleteThrough('campaigns', campaignId);
    set(state => ({ campaigns: state.campaigns.filter(c => c.id !== campaignId) }));
  },

  // ── Market Planning Board actions (standalone, no position/campaign link) ──
  updateCCCalculator: (asset, updates) => set(state => ({
    ccCalculator: {
      ...state.ccCalculator,
      [asset]: { ...(state.ccCalculator[asset] || {}), ...updates },
    },
  })),

  updateWheelCalc: (calcType, updates) => set(state => ({
    wheelCalcs: {
      ...state.wheelCalcs,
      [calcType]: { ...(state.wheelCalcs[calcType] || {}), ...updates },
    },
  })),

  setMonthlyGoal: (year, month, amount) => set(state => ({
    monthlyGoals: {
      ...state.monthlyGoals,
      [String(year)]: { ...(state.monthlyGoals[String(year)] || {}), [month]: amount },
    },
  })),

  updatePlanningMeta: (asset, updates) => set(state => ({
    planningMeta: {
      ...state.planningMeta,
      [asset]: { ...(state.planningMeta[asset] || {}), ...updates },
    },
  })),

  updatePlanningRow: (asset, rowId, updates) => set(state => ({
    planningBoard: {
      ...state.planningBoard,
      [asset]: state.planningBoard[asset].map(r => r.id === rowId ? { ...r, ...updates } : r),
    },
  })),
  addPlanningRow: (asset, row) => set(state => ({
    planningBoard: {
      ...state.planningBoard,
      [asset]: [...state.planningBoard[asset], row],
    },
  })),
  deletePlanningRow: (asset, rowId) => set(state => ({
    planningBoard: {
      ...state.planningBoard,
      [asset]: state.planningBoard[asset].filter(r => r.id !== rowId),
    },
  })),

  assignPositionToCampaign: (positionId, campaignId) => set(state => ({
    positions: state.positions.map(p =>
      p.id === positionId ? { ...p, campaignId } : p
    ),
  })),

  addJournalEntry: (entry) => {
    writeThrough('journal', entry);
    set(state => ({ journal: [entry, ...state.journal] }));
  },

  addJournalEntryToPosition: (positionId, journalEntryId) => set(state => ({
    positions: state.positions.map(p =>
      p.id === positionId
        ? { ...p, journalEntryIds: [...(p.journalEntryIds || []), journalEntryId] }
        : p
    ),
    journal: state.journal.map(j =>
      j.id === journalEntryId ? { ...j, positionId } : j
    ),
  })),

  removeJournalEntryFromPosition: (positionId, journalEntryId) => set(state => ({
    positions: state.positions.map(p =>
      p.id === positionId
        ? { ...p, journalEntryIds: (p.journalEntryIds || []).filter(id => id !== journalEntryId) }
        : p
    ),
    journal: state.journal.map(j =>
      j.id === journalEntryId ? { ...j, positionId: null } : j
    ),
  })),

  toggleCategoryVisibility: (catId) => set(state => ({
    visibleCategories: state.visibleCategories.includes(catId)
      ? state.visibleCategories.filter(id => id !== catId)
      : [...state.visibleCategories, catId],
  })),
  showAllCategories:  () => set(state => ({ visibleCategories: state.calendarCategories.map(c => c.id) })),
  hideAllCategories:  () => set({ visibleCategories: [] }),
  setSelectedEvent:   (event) => set({ selectedEvent: event }),

  setWatchlistMode:   (mode) => set({ watchlistMode: mode }),
  updateWatchlistItem: (id, data) => set(state => {
    const updated = state.watchlist.map(w => w.id === id ? { ...w, ...data, lastUpdated: new Date().toISOString() } : w);
    const item = updated.find(w => w.id === id);
    if (item) writeThrough('watchlist', item);
    return { watchlist: updated };
  }),
  addWatchlistItem: (item) => set(state => {
    const newItem = { ...item, id: Math.max(0, ...state.watchlist.map(w => w.id)) + 1, lastUpdated: new Date().toISOString() };
    writeThrough('watchlist', newItem);
    return { watchlist: [...state.watchlist, newItem] };
  }),
  deleteWatchlistItem: (id) => {
    deleteThrough('watchlist', id);
    set(state => ({ watchlist: state.watchlist.filter(w => w.id !== id) }));
  },

  addCalendarEvent: (event) => set(state => {
    const newEvent = { ...event, id: Math.max(0, ...state.calendar.map(e => e.id)) + 1 };
    writeThrough('calendar', newEvent);
    return { calendar: [...state.calendar, newEvent] };
  }),
  deleteCalendarEvent: (id) => {
    deleteThrough('calendar', id);
    set(state => ({
      calendar: state.calendar.filter(e => e.id !== id),
      selectedEvent: state.selectedEvent?.id === id ? null : state.selectedEvent,
    }));
  },

  updatePositionStatus: (positionId, statusData) => set(state => ({
    positions: state.positions.map(p =>
      p.id === positionId
        ? { ...p, status: statusData.status, statusHistory: statusData.statusHistory, scenarioApplied: statusData.scenarioApplied }
        : p
    ),
  })),

  addJournalEntryFromScenario: (entry) => {
    writeThrough('journal', entry);
    set(state => ({ journal: [entry, ...state.journal] }));
  },

  updateJournalEntry: (entryId, updates) => set(state => {
    const updated = state.journal.map(e =>
      e.id === entryId
        ? {
            ...e, ...updates, edited: true,
            editHistory: [
              ...(e.editHistory || []),
              { date: new Date().toISOString(), field: Object.keys(updates)[0], oldValue: e[Object.keys(updates)[0]], newValue: Object.values(updates)[0], editedBy: 'user' },
            ],
          }
        : e
    );
    const entry = updated.find(e => e.id === entryId);
    if (entry) writeThrough('journal', entry);
    return { journal: updated };
  }),

  deleteJournalEntry: (entryId) => {
    deleteThrough('journal', entryId);
    set(state => ({
      journal: state.journal.filter(e => e.id !== entryId),
      positions: state.positions.map(p =>
        (p.journalEntryIds || []).includes(entryId)
          ? { ...p, journalEntryIds: p.journalEntryIds.filter(id => id !== entryId) }
          : p
      ),
    }));
  },

  upsertJournalRecommendation: (positionId, rec) => {
    const { journal, positions, campaigns } = get();

    // Widen the search to all positions in the same campaign so the recommendation
    // lands on the campaign journal entry regardless of which position is selected.
    const simPos     = positions.find(p => p.id === positionId);
    const campaignId = simPos?.campaignId || null;
    const relatedIds = campaignId
      ? new Set(positions.filter(p => p.campaignId === campaignId).map(p => p.id))
      : new Set([positionId]);

    // All journal entries linked to any position in this campaign
    const candidates = journal.filter(e => e.positionId != null && relatedIds.has(e.positionId));

    // Prefer the campaign journal entry — identified by its trade field matching a
    // campaign name (set when created via "Create Journal Entry" on the Positions page).
    const campaignNames = new Set(campaigns.map(c => c.name));
    const existing =
      candidates.find(e => campaignNames.has(e.trade)) ||   // campaign entry (preferred)
      candidates.find(e => e.positionId === positionId)  ||  // direct position match
      candidates[0] ||                                        // any related entry
      null;

    if (existing) {
      const updated = { ...existing, simulatorRec: rec };
      set({ journal: journal.map(e => e.id === existing.id ? updated : e) });
      writeThrough('journal', updated);
    } else {
      // No existing entry — create a skeleton linked to the simulated position
      const pos = simPos;
      const newEntry = {
        id:           Date.now(),
        date:         new Date().toISOString().split('T')[0],
        symbol:       pos?.symbol || '',
        positionId,
        trade:        pos ? `${pos.category} $${pos.strike} Strike` : '',
        result:       'Outcome Pending',
        tags:         ['simulator'],
        tradeThesis:  { reason: pos?.thesis || '', support: '', target: '', happyAssignment: pos?.category !== 'Covered Call' },
        simulatorRec: rec,
        myDecision:   { action: '', reasoning: '', decidedDate: '' },
        outcome:      { completedDate: '', action: '', finalProfit: null, lesson: '' },
      };
      set(s => ({ journal: [newEntry, ...s.journal] }));
      writeThrough('journal', newEntry);
    }
  },
    }),
    {
      name:    'wheel-edge-store-v1',
      storage: createJSONStorage(() => localStorage),
      // IndexedDB (src/services/db.js) is now the source of truth for the 6
      // cloud-backed domains — they're excluded here so localStorage only
      // keeps the local-only UI/calculator state that has no IndexedDB
      // table. positions/campaigns/journal/calendar/watchlist/priceSnapshots
      // are hydrated from IndexedDB on boot by IndexedDbInitializer instead.
      partialize: (state) => {
        const {
          selectedEvent, tigerConnectionStatus, localSyncStatus,
          positions, campaigns, journal, calendar, watchlist, priceSnapshots, executions,
          ...rest
        } = state;
        return rest;
      },
    }
  )
);

// writeThrough.js cannot import the store directly (db.js/writeThrough.js
// are imported BY this file, so importing back would be circular) — this
// registers a callback so every successful IndexedDB write bumps the
// "🟢 Local Saved" status shown by SyncStatusIndicator.
registerLocalSaveListener((savedAt) => {
  useWheelStore.setState({ localSyncStatus: { savedAt } });
});

// ============================================================================
// SIDEBAR COMPONENT
// ============================================================================

function Sidebar() {
  const location = useLocation();
  
  const navItems = [
    { name: 'Dashboard',          path: '/',             icon: '📊' },
    { name: 'Positions',          path: '/positions',    icon: '📈' },
    { name: 'Scenario Simulator', path: '/simulator',    icon: '🎯' },
    { name: 'Calendar',           path: '/calendar',     icon: '📅' },
    { name: 'Rotation Watchlist', path: '/watchlist',    icon: '👁️' },
    { name: 'Income Tracker',     path: '/income',       icon: '💰' },
    { name: 'Journal',            path: '/journal',      icon: '📝' },
    { name: 'Backup',             path: '/backup',       icon: '☁️' },
    { name: 'Settings',           path: '/settings',     icon: '⚙️' },
  ];
  
  const isActive = (path) => location.pathname === path;
  
  return (
    <div className="fixed left-0 top-0 h-screen w-64 bg-gradient-to-b from-slate-50 to-slate-100 border-r border-slate-200 flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-slate-200">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <span className="text-white font-bold text-lg">⚙️</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-900" style={{ fontFamily: 'Georgia, serif' }}>
              WHEEL EDGE
            </h1>
            <p className="text-xs text-slate-600" style={{ fontFamily: 'Georgia, serif' }}>
              Trade. Manage. Compound.
            </p>
          </div>
        </div>
      </div>
      
      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              isActive(item.path)
                ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg'
                : 'text-slate-700 hover:bg-slate-200'
            }`}
          >
            <span className="text-sm font-medium">{item.name}</span>
          </Link>
        ))}
      </nav>
      
      {/* Account Snapshot */}
      <div className="border-t border-slate-200 p-4 space-y-3">
        <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">Account Snapshot</h3>
        <AccountSnapshot />
      </div>
    </div>
  );
}

// ============================================================================
// ACCOUNT SNAPSHOT COMPONENT
// ============================================================================

function AccountSnapshot() {
  const positions = useWheelStore(s => s.positions);
  const journal   = useWheelStore(s => s.journal);

  const fmt  = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

  // ── Derived from positions ──────────────────────────────────────────────────
  const openPositions = positions.filter(p => p.status === 'OPEN');
  const closedPos     = positions.filter(p => p.status === 'CLOSED');

  // Realized P&L — all closed positions
  const realizedPnL = closedPos.reduce((s, p) => s + (p.closedData?.realizedPnL || 0), 0);

  // Unrealized options (premium collected minus current cost to close)
  const unrealizedOptions = openPositions
    .filter(p => isOptCat(p.category))
    .reduce((s, p) => s + ((p.premium || 0) - (p.currentValue || 0)), 0);

  // Unrealized share gains — use avgPricePerShare as cost basis when available
  const unrealizedShares = openPositions
    .filter(p => p.category === 'Long Shares')
    .reduce((s, p) => s + ((p.currentSharePrice || effectiveCostBasis(p)) - effectiveCostBasis(p)) * (p.shareCount || 0), 0);

  const unrealizedTotal = unrealizedOptions + unrealizedShares;

  // Cash reserved (face value — what was set aside)
  const cashReserved = openPositions
    .filter(p => p.category === 'Cash')
    .reduce((s, p) => s + (p.capitalAmount || 0), 0);

  // Cash market value — uses currentSharePrice × shareCount when both are set,
  // otherwise falls back to capitalAmount (the reserved cash amount).
  const cashPositions = openPositions.filter(p => p.category === 'Cash');
  const cashMarketValue = cashPositions.reduce((s, p) => {
    if (p.currentSharePrice && p.shareCount) {
      return s + p.currentSharePrice * p.shareCount;
    }
    return s + (p.capitalAmount || 0);
  }, 0);
  const cashMarketDiff = cashMarketValue - cashReserved; // positive = stock risen, negative = fallen

  // Long share market value
  const shareValue = openPositions
    .filter(p => p.category === 'Long Shares')
    .reduce((s, p) => s + (p.currentSharePrice || effectiveCostBasis(p)) * (p.shareCount || 0), 0);

  // Options collateral requirement (all short options require strike × contracts × 100)
  const optionsBP = openPositions
    .filter(p => isOptCat(p.category))
    .reduce((s, p) => s + (p.strike || 0) * (p.contracts || 1) * 100, 0);

  // Premium YTD — only entries from the current calendar year
  const income       = computeIncome(positions, journal);
  const currentYear  = new Date().getFullYear().toString();
  const ytdPremium   = income.entries
    .filter(e => (e.date || '').startsWith(currentYear))
    .reduce((s, e) => s + e.premium, 0);

  // Commissions — all-time total across every position, tracked separately
  const totalCommissionsAll = positions.reduce((s, p) => s + (p.commission || 0), 0);

  // Net Liq: use cash market value (not face value) + shares + options P&L + realized − commissions
  // shareValue uses currentSharePrice already, so unrealizedShares must NOT be added again.
  const netLiqEst = cashMarketValue + shareValue + unrealizedOptions + realizedPnL - totalCommissionsAll;

  // ── Colour helpers ──────────────────────────────────────────────────────────
  const pnlColor = (v) => v >= 0 ? 'text-green-600' : 'text-red-600';
  const pnlSign  = (v) => v >= 0 ? '+' : '';

  const Row = ({ label, value, color = 'text-slate-900', small = false }) => (
    <div className="flex items-center justify-between">
      <span className={`text-xs text-slate-500 ${small ? '' : 'uppercase tracking-wide'}`}>{label}</span>
      <span className={`text-xs font-bold ${color}`}>{value}</span>
    </div>
  );

  return (
    <div className="space-y-2.5">
      {/* Net Liq Estimate */}
      <div className="pb-2 border-b border-slate-200">
        <p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Net Liq (est.)</p>
        <p className="text-xl font-bold text-slate-900">{fmt(netLiqEst)}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {realizedPnL !== 0 && (
            <p className={`text-xs font-semibold ${pnlColor(realizedPnL)}`}>
              {pnlSign(realizedPnL)}{fmt(realizedPnL)} realized
            </p>
          )}
          {unrealizedTotal !== 0 && (
            <p className={`text-xs font-semibold ${pnlColor(unrealizedTotal)}`}>
              {pnlSign(unrealizedTotal)}{fmt(unrealizedTotal)} open P&L
            </p>
          )}
          {realizedPnL === 0 && unrealizedTotal === 0 && (
            <p className="text-xs text-slate-400">$0 open P&L</p>
          )}
        </div>
      </div>

      {/* Key metrics */}
      <div className="space-y-1.5 pb-2 border-b border-slate-200">
        <Row label="Premium YTD"
             value={`+${fmt(ytdPremium)}`}
             color="text-green-700" />
        <Row label="Realized P&L"
             value={`${pnlSign(realizedPnL)}${fmt(realizedPnL)}`}
             color={pnlColor(realizedPnL)} />
        <Row label="Unrealized Options"
             value={`${pnlSign(unrealizedOptions)}${fmt(unrealizedOptions)}`}
             color={pnlColor(unrealizedOptions)} />
        <Row label="Share Gain/Loss"
             value={`${pnlSign(unrealizedShares)}${fmt(unrealizedShares)}`}
             color={pnlColor(unrealizedShares)} />
        {totalCommissionsAll > 0 && (
          <Row label="Commissions Paid"
               value={`-${fmt(totalCommissionsAll)}`}
               color="text-red-500" />
        )}
      </div>

      {/* Capital */}
      <div className="space-y-1.5 pb-2 border-b border-slate-200">
        <Row label="Cash Reserved"   value={fmt(cashReserved)} />
        {cashMarketValue !== cashReserved && (
          <>
            <Row label="Cash Market Value"
                 value={fmt(cashMarketValue)}
                 color={cashMarketDiff >= 0 ? 'text-green-700' : 'text-red-600'} />
            <Row label="  vs Reserved"
                 value={`${cashMarketDiff >= 0 ? '+' : ''}${fmt(cashMarketDiff)}`}
                 color={cashMarketDiff >= 0 ? 'text-green-600' : 'text-red-500'}
                 small />
          </>
        )}
        <Row label="Share Value"     value={fmt(shareValue)} />
        <Row label="Options BP Used" value={fmt(optionsBP)} color="text-orange-700" />
      </div>

      {/* Position count */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Open Positions</span>
        <span className="font-bold text-slate-900">{openPositions.length}</span>
      </div>

      <SupabaseStatusBadge />
      <TigerConnectionBadge />
    </div>
  );
}

// Compact sidebar badge — reflects manual cloud backup status (Supabase is
// no longer "synced" live; it's a backup target the user controls via the
// Save to Cloud button).
function SupabaseStatusBadge() {
  const [lastBackup, setLastBackup] = useState(null);
  useEffect(() => { getLastCloudBackupAt().then(setLastBackup); }, []);
  const backedUp = Boolean(lastBackup);
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-500">Cloud Backup</span>
      <div className="flex items-center gap-1">
        <span className={`w-2 h-2 rounded-full ${backedUp ? 'bg-green-500' : 'bg-amber-400'}`} />
        <span className={`font-semibold ${backedUp ? 'text-green-700' : 'text-amber-600'}`}>
          {backedUp ? 'Backed Up' : 'Not Backed Up'}
        </span>
      </div>
    </div>
  );
}

// ── IndexedDB Initializer ──────────────────────────────────────────────────────
// Mounts once: hydrates the Zustand store from IndexedDB only. No network
// call is ever made on boot — Supabase is a manual backup/restore target
// the user triggers explicitly (Save to Cloud / Restore from Cloud), never
// contacted automatically. IndexedDB is the only thing the app depends on
// to function, including fully offline.

async function migrateLocalStorageOnce() {
  const flag = await db.meta.get(LOCALSTORAGE_MIGRATION_FLAG);
  if (flag) return; // already migrated, or this is a fresh install — never run again

  try {
    const raw = localStorage.getItem(LEGACY_PERSIST_KEY);
    if (raw) {
      const legacyState = JSON.parse(raw)?.state || {};
      for (const t of DOMAIN_TABLE_NAMES) {
        const rows = legacyState[t];
        // bulkPut on first-ever insert runs through the `creating` hook in
        // db.js, which stamps _updatedAt/_dirty automatically — these rows
        // have never been cloud-backed, so _dirty:1 is exactly correct.
        if (Array.isArray(rows) && rows.length > 0) await db[t].bulkPut(rows);
      }
    }
  } catch (err) {
    console.error('[Migration] Failed to migrate legacy localStorage data into IndexedDB', err);
  }

  await db.meta.put({ key: LOCALSTORAGE_MIGRATION_FLAG, value: true });
}

const EXECUTION_LEDGER_BACKFILL_FLAG = 'executionLedgerBackfilled';

// One-time migration: every position that existed before the execution
// ledger shipped gets a synthesized opening (and closing, if applicable)
// execution reconstructed from its existing fields, so the ledger is
// complete from day one rather than having a gap before this feature.
async function backfillExecutionLedgerOnce() {
  if (await db.meta.get(EXECUTION_LEDGER_BACKFILL_FLAG)) return;

  try {
    const positions = await db.positions.toArray();
    let nextId = Math.max(0, ...(await db.executions.toArray()).map(e => e.id)) + 1;
    const now = new Date().toISOString();

    for (const pos of positions) {
      if (pos.category === 'Cash') continue; // reservations aren't trades

      const isShares = pos.category === 'Long Shares';
      const openQty  = isShares ? (pos.shareCount || 0) : (pos.contracts || 1);
      await db.executions.add({
        id: nextId++, positionId: pos.id, campaignId: pos.campaignId || null, symbol: pos.symbol,
        action: isShares ? 'Buy to Open' : 'Sell to Open', date: pos.entryDate, quantity: openQty,
        executionPrice: isShares ? (pos.purchasePrice || 0) : (pos.premium || 0) / (openQty * 100 || 1),
        netCreditDebit: isShares ? -(pos.purchasePrice || 0) * openQty : (pos.premium || 0),
        commission: pos.commission || 0, exchangeFees: 0, gst: 0,
        notes: '[Backfilled from existing position record]', linkedPositionId: null,
        _createdAt: now, _updatedAt: now, _dirty: 1,
      });

      if (pos.status === 'CLOSED' && pos.closedData) {
        const reason = (pos.closedData.reason || '').toLowerCase();
        const closeAction = reason.includes('assign') || reason.includes('call') ? 'Assignment'
          : reason.includes('roll')  ? 'Roll'
          : reason.includes('expir') ? 'Expired'
          : isShares ? 'Sell to Close' : 'Buy to Close';
        await db.executions.add({
          id: nextId++, positionId: pos.id, campaignId: pos.campaignId || null, symbol: pos.symbol,
          action: closeAction, date: pos.closedData.closedDate,
          quantity: isShares ? (pos.closedData.shares || pos.shareCount || 0) : (pos.contracts || 1),
          executionPrice: pos.closedData.buybackCost ?? pos.closedData.salePrice ?? null,
          netCreditDebit: pos.closedData.realizedPnL ?? 0,
          commission: 0, exchangeFees: pos.closedData.fees || 0, gst: 0,
          notes: '[Backfilled from existing closedData]', linkedPositionId: null,
          _createdAt: now, _updatedAt: now, _dirty: 1,
        });
      }
    }
  } catch (err) {
    console.error('[Migration] Failed to backfill execution ledger', err);
  }

  await db.meta.put({ key: EXECUTION_LEDGER_BACKFILL_FLAG, value: true });
}

function IndexedDbInitializer() {
  useEffect(() => {
    (async () => {
      await migrateLocalStorageOnce();
      await backfillExecutionLedgerOnce();
      const fresh = {};
      for (const t of DOMAIN_TABLE_NAMES) {
        fresh[t] = await db[t].toArray();
      }
      fresh.executions = await db.executions.toArray();
      useWheelStore.setState(fresh);
    })();
  }, []);

  return null; // invisible component
}

function TigerConnectionBadge() {
  const [status, setStatus]   = useState('checking');
  const [errorMsg, setErrorMsg] = useState('');
  const updateTigerStatus     = useWheelStore(s => s.updateTigerStatus);

  useEffect(() => {
    let cancelled = false;
    checkConnectionStatus()
      .then(s => {
        if (cancelled) return;
        if (s.connected) {
          setStatus('connected');
          // Test quote permission via the /api/ping endpoint
          fetch('http://localhost:3001/api/ping')
            .then(r => r.json())
            .then(p => {
              if (cancelled) return;
              const rtEnabled = p.connected && !p.error;
              updateTigerStatus({
                connected: true, authenticated: true,
                accountVerified: true, realtimeQuotesEnabled: rtEnabled,
                error: rtEnabled ? null : p.error,
              });
            })
            .catch(() => {
              if (!cancelled) updateTigerStatus({ connected: true, authenticated: true, accountVerified: true, realtimeQuotesEnabled: false, error: 'Ping failed' });
            });
        } else {
          setStatus('error');
          setErrorMsg(s.error || 'Unavailable');
          updateTigerStatus({ connected: false, authenticated: false, accountVerified: false, realtimeQuotesEnabled: false, error: s.error });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error'); setErrorMsg('Server offline');
          updateTigerStatus({ connected: false, authenticated: false, accountVerified: false, realtimeQuotesEnabled: false, error: 'Backend server offline' });
        }
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="pt-2 border-t border-slate-200">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600">Tiger API</span>
        <div className="flex items-center gap-1">
          {status === 'checking' && (
            <>
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-slate-500">Checking…</span>
            </>
          )}
          {status === 'connected' && (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span className="font-semibold text-green-700">Live</span>
            </>
          )}
          {status === 'error' && (
            <>
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="font-semibold text-red-600">Mock</span>
            </>
          )}
        </div>
      </div>
      {status === 'error' && errorMsg && (
        <p className="text-xs text-red-500 mt-1 leading-tight" title={errorMsg}>
          {errorMsg.length > 40 ? errorMsg.slice(0, 40) + '…' : errorMsg}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// LAYOUT WRAPPER
// ============================================================================

function LayoutWrapper({ children }) {
  return (
    <div className="flex h-screen bg-white">
      <Sidebar />
      <main className="flex-1 ml-64 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}

// ============================================================================
// MARKET PLANNING BOARD
// ============================================================================

const PLANNING_TRIGGER_GROUPS = [
  {
    label: 'Covered Call Triggers',
    options: ['CC-Bull-Roll', 'CC-Neutral', 'CC-Bear-BuyBack', 'CC-BullRun-Assign'],
  },
  {
    label: 'Cash Secured Put Triggers',
    options: ['P-Bull-BuyBack', 'P-Neutral', 'P-Bear-Roll', 'P-BearDrop-Assign'],
  },
];

const TRIGGER_AUTO_NOTES = {
  'CC-Bull-Roll':      'Bullish outlook. Consider rolling call up or out to maintain upside exposure.',
  'CC-Neutral':        'Range-bound outlook. Continue collecting premium and allow theta decay.',
  'CC-Bear-BuyBack':   'Bearish outlook. Consider buying back the covered call and preserving flexibility.',
  'CC-BullRun-Assign': 'Strong breakout. Accept assignment and redeploy capital.',
  'P-Bull-BuyBack':    'Bullish outlook. Consider buying back the put and freeing capital.',
  'P-Neutral':         'Range-bound outlook. Continue collecting premium.',
  'P-Bear-Roll':       'Bearish outlook. Consider rolling down and/or out for additional credit.',
  'P-BearDrop-Assign': 'Large decline into support. Accept assignment and transition to covered calls.',
};

// Round a numeric string to at most 1 decimal place on blur
const roundLevel = (val) => {
  if (val === '') return '';
  const n = parseFloat(val);
  return isNaN(n) ? '' : String(Math.round(n * 10) / 10);
};

// PlanCard owns its row data in local state (initialised once from Zustand on mount).
// This prevents the re-render-on-every-keystroke problem and keeps focus stable.
// Every edit also writes through to Zustand so values survive navigation.
function PlanCard({ asset, title, badge, headerStyle, initialRows, initialLastUpdated, onUpdate, onUpdateMeta, onAdd, onDelete }) {
  const [rows,        setRows]        = useState(initialRows);
  const [lastUpdated, setLastUpdated] = useState(initialLastUpdated || '');

  // ── Row helpers ────────────────────────────────────────────────────────────
  const upd = (rowId, field, value) => {
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, [field]: value } : r));
    onUpdate(asset, rowId, { [field]: value });
  };

  const handleTriggerChange = (rowId, newTrigger) => {
    const row     = rows.find(r => r.id === rowId);
    const updates = { trigger: newTrigger };
    if (row && !row.notes.trim() && TRIGGER_AUTO_NOTES[newTrigger]) {
      updates.notes = TRIGGER_AUTO_NOTES[newTrigger];
    }
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, ...updates } : r));
    onUpdate(asset, rowId, updates);
  };

  const handleAddRow = () => {
    const newId  = Math.max(0, ...rows.map(r => r.id)) + 1;
    const newRow = { id: newId, dte: '', support: '', resistance: '', trigger: '', notes: '' };
    setRows(prev => [...prev, newRow]);
    onAdd(asset, newRow);
  };

  const handleDeleteRow = (rowId) => {
    setRows(prev => prev.filter(r => r.id !== rowId));
    onDelete(asset, rowId);
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────
  const focusCell = (key) => {
    const el = document.querySelector(`[data-plankey="${key}"]`);
    if (el) { el.focus(); el.select?.(); }
  };

  const handleKeyDown = (e, rowId, field) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const FIELDS = ['dte', 'support', 'resistance', 'trigger', 'notes'];
    const idx    = rows.findIndex(r => r.id === rowId);
    const fIdx   = FIELDS.indexOf(field);
    if (fIdx < FIELDS.length - 1) {
      focusCell(`${asset}-${rowId}-${FIELDS[fIdx + 1]}`);
    } else if (idx < rows.length - 1) {
      focusCell(`${asset}-${rows[idx + 1].id}-dte`);
    }
  };

  const cellCls = 'bg-transparent rounded focus:outline-none focus:ring-1 px-2 py-1';

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-lg border border-slate-200 flex flex-col">

      {/* Gradient header */}
      <div className="px-6 py-5" style={{ background: headerStyle }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-0.5">
              <h3 className="text-2xl font-bold text-white" style={{ fontFamily: 'Playfair Display, serif' }}>
                {title}
              </h3>
              <span className="text-xs font-bold text-white/60 bg-white/15 px-2 py-0.5 rounded-full uppercase tracking-widest">
                {badge}
              </span>
            </div>
            <p className="text-xs text-white/50 uppercase tracking-widest">Support · Resistance · DTE Planning</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-white/50 uppercase tracking-widest mb-1">Last Updated</p>
            <input
              type="date"
              value={lastUpdated}
              onChange={e => {
                setLastUpdated(e.target.value);
                onUpdateMeta(asset, { lastUpdated: e.target.value });
              }}
              className="text-sm font-semibold text-white bg-white/10 border border-white/25 rounded-lg px-3 py-1 focus:outline-none focus:ring-2 focus:ring-white/30 cursor-pointer [color-scheme:dark]"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-2.5 text-left text-xs font-bold text-slate-400 uppercase tracking-wide w-14 whitespace-nowrap">DTE</th>
              <th className="px-3 py-2.5 text-left text-xs font-bold text-green-500 uppercase tracking-wide w-20 whitespace-nowrap">Support</th>
              <th className="px-3 py-2.5 text-left text-xs font-bold text-red-400 uppercase tracking-wide w-24 whitespace-nowrap">Resistance</th>
              <th className="px-3 py-2.5 text-left text-xs font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">Trigger</th>
              <th className="px-3 py-2.5 text-left text-xs font-bold text-slate-400 uppercase tracking-wide w-2/5 whitespace-nowrap">Notes</th>
              <th className="w-6 px-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">

                {/* DTE */}
                <td className="px-2 py-1.5">
                  <input
                    data-plankey={`${asset}-${row.id}-dte`}
                    value={row.dte}
                    onChange={e => upd(row.id, 'dte', e.target.value)}
                    onKeyDown={e => handleKeyDown(e, row.id, 'dte')}
                    placeholder="30"
                    className={`w-12 text-sm font-mono font-bold text-center text-slate-700 focus:bg-white focus:ring-slate-300 ${cellCls}`}
                  />
                </td>

                {/* Support — numeric, green */}
                <td className="px-2 py-1.5">
                  <input
                    data-plankey={`${asset}-${row.id}-support`}
                    type="number"
                    step="0.1"
                    min="0"
                    value={row.support}
                    onChange={e => upd(row.id, 'support', e.target.value)}
                    onBlur={e => upd(row.id, 'support', roundLevel(e.target.value))}
                    onKeyDown={e => handleKeyDown(e, row.id, 'support')}
                    placeholder="—"
                    className={`w-20 text-sm font-bold text-center text-green-700 focus:bg-green-50 focus:ring-green-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${cellCls}`}
                  />
                </td>

                {/* Resistance — numeric, red */}
                <td className="px-2 py-1.5">
                  <input
                    data-plankey={`${asset}-${row.id}-resistance`}
                    type="number"
                    step="0.1"
                    min="0"
                    value={row.resistance}
                    onChange={e => upd(row.id, 'resistance', e.target.value)}
                    onBlur={e => upd(row.id, 'resistance', roundLevel(e.target.value))}
                    onKeyDown={e => handleKeyDown(e, row.id, 'resistance')}
                    placeholder="—"
                    className={`w-20 text-sm font-bold text-center text-red-600 focus:bg-red-50 focus:ring-red-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${cellCls}`}
                  />
                </td>

                {/* Trigger — grouped dropdown */}
                <td className="px-2 py-1.5">
                  <select
                    data-plankey={`${asset}-${row.id}-trigger`}
                    value={row.trigger}
                    onChange={e => handleTriggerChange(row.id, e.target.value)}
                    onKeyDown={e => handleKeyDown(e, row.id, 'trigger')}
                    className="w-full px-2 py-1 text-xs font-semibold bg-transparent rounded border-0 focus:outline-none focus:bg-white focus:ring-1 focus:ring-slate-300 text-slate-700 cursor-pointer min-w-[140px]">
                    <option value="">— Select —</option>
                    {PLANNING_TRIGGER_GROUPS.map(group => (
                      <optgroup key={group.label} label={group.label}>
                        {group.options.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </td>

                {/* Notes — auto-expands */}
                <td className="px-2 py-1.5 w-2/5">
                  <textarea
                    data-plankey={`${asset}-${row.id}-notes`}
                    value={row.notes}
                    onChange={e => upd(row.id, 'notes', e.target.value)}
                    placeholder="Select a trigger to auto-fill, or type a note…"
                    rows={1}
                    className={`w-full text-xs text-slate-600 focus:bg-white focus:ring-slate-300 resize-none leading-snug ${cellCls}`}
                    onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                  />
                </td>

                {/* Delete row */}
                <td className="px-1 py-1.5">
                  <button
                    onClick={() => handleDeleteRow(row.id)}
                    className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 text-base leading-none transition-opacity w-4 text-center">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add row footer */}
      <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
        <button
          onClick={handleAddRow}
          className="text-xs font-semibold text-slate-400 hover:text-slate-700 transition-colors flex items-center gap-1">
          <span className="text-base leading-none">+</span> Add Row
        </button>
      </div>
    </div>
  );
}

// ── Shared input field for wheel calculators ─────────────────────────────────
function CalcInput({ label, field, value, onChange, placeholder = '0.00', step = '0.01' }) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-500 block mb-1">{label}</label>
      <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden bg-slate-50 focus-within:border-purple-400 focus-within:bg-white transition-colors">
        <span className="text-xs text-slate-400 pl-3 pr-1 select-none">$</span>
        <input
          type="number" step={step} min="0"
          value={value}
          onChange={e => onChange(field, e.target.value)}
          placeholder={placeholder}
          className="flex-1 py-2 pr-3 text-sm font-bold text-slate-900 bg-transparent focus:outline-none"
        />
      </div>
    </div>
  );
}

// ── Shared output row for calculator results ──────────────────────────────────
function CalcRow({ label, value, large = false, color = 'text-slate-900' }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`font-bold ${large ? 'text-xl' : 'text-sm'} ${color}`}>{value}</span>
    </div>
  );
}

// ============================================================================
// CALCULATOR 1 — Covered Call Breakeven
// Planning tool only. No connection to positions, campaigns, or any stored data.
// ============================================================================
function CoveredCallCalc({ initialData, onUpdate }) {
  const [v, setV] = useState({
    costBasis:     initialData?.costBasis     || '',
    premium:       initialData?.premium       || '',
    selectedStrike: initialData?.selectedStrike || '',
  });

  const upd = (field, value) => {
    const next = { ...v, [field]: value };
    setV(next);
    onUpdate('coveredCall', next);
  };

  const costBasis = parseFloat(v.costBasis)       || 0;
  const premium   = parseFloat(v.premium)         || 0;
  const selected  = v.selectedStrike !== '' ? parseFloat(v.selectedStrike) : null;

  const hasInputs       = costBasis > 0 || premium > 0;
  const minStrike       = costBasis - premium;
  const assignSaleValue = selected !== null ? selected + premium : null;
  const profitPerShare  = selected !== null ? assignSaleValue - costBasis : null;
  const totalProfit     = profitPerShare !== null ? profitPerShare * 100 : null;

  const isProfitable = selected !== null && hasInputs && selected >= minStrike;
  const pnlColor     = profitPerShare !== null ? (profitPerShare >= 0 ? 'text-green-700' : 'text-red-600') : 'text-slate-900';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">

      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100"
        style={{ background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">Covered Call Breakeven</h3>
            <p className="text-xs text-slate-500 mt-0.5">Will I profit if shares are called away?</p>
          </div>
          <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full border border-green-200">CC</span>
        </div>
      </div>

      <div className="p-5 space-y-4 flex-1">

        {/* Inputs */}
        <div className="space-y-2.5">
          <CalcInput label="Share Cost Basis"          field="costBasis"      value={v.costBasis}      onChange={upd} placeholder="37.70" />
          <CalcInput label="Call Premium Received / sh" field="premium"       value={v.premium}        onChange={upd} placeholder="0.50" />
          <CalcInput label="Selected Strike"            field="selectedStrike" value={v.selectedStrike} onChange={upd} placeholder="38.00" step="0.5" />
        </div>

        {/* Divider */}
        {hasInputs && <div className="border-t border-slate-100" />}

        {/* Results */}
        {hasInputs && (
          <div className="space-y-1">
            {/* Minimum strike — primary output */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 mb-2">
              <p className="text-xs text-slate-500 mb-0.5">Minimum Strike To Avoid Loss</p>
              <p className="text-3xl font-bold text-slate-900">${minStrike.toFixed(2)}</p>
              <p className="text-xs text-slate-400 mt-0.5">${costBasis.toFixed(2)} − ${premium.toFixed(2)} premium</p>
            </div>

            {selected !== null && (
              <>
                <CalcRow label="Assignment Sale Value"   value={`$${assignSaleValue.toFixed(2)}`} />
                <CalcRow label="Profit Per Share"        value={`${profitPerShare >= 0 ? '+' : ''}$${profitPerShare.toFixed(2)}`} color={pnlColor} />
                <CalcRow label="Total Profit (100 sh)"  value={`${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`}   color={pnlColor} large />
              </>
            )}
          </div>
        )}

        {/* Status badge */}
        {selected !== null && hasInputs && (
          <div className={`rounded-xl px-4 py-3 text-center border ${isProfitable ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <span className={`text-sm font-bold ${isProfitable ? 'text-green-700' : 'text-red-700'}`}>
              {isProfitable ? '✓ Profitable If Assigned' : '⚠ Loss If Assigned'}
            </span>
          </div>
        )}

        {!hasInputs && (
          <p className="text-xs text-slate-400 italic text-center py-2">Enter cost basis and premium to calculate.</p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// CALCULATOR 2 — Cash Secured Put Assignment
// Planning tool only. No connection to positions, campaigns, or any stored data.
// ============================================================================
function CashPutCalc({ initialData, onUpdate }) {
  const [v, setV] = useState({
    putStrike:    initialData?.putStrike    || '',
    premiumTotal: initialData?.premiumTotal || '',
    marketPrice:  initialData?.marketPrice  || '',
  });

  const upd = (field, value) => {
    const next = { ...v, [field]: value };
    setV(next);
    onUpdate('cashPut', next);
  };

  const putStrike    = parseFloat(v.putStrike)    || 0;
  const premiumTotal = parseFloat(v.premiumTotal) || 0;
  const marketPrice  = parseFloat(v.marketPrice)  || 0;

  const hasInputs      = putStrike > 0 || premiumTotal > 0;
  const premiumPerSh   = premiumTotal / 100;
  const expectedBasis  = putStrike - premiumPerSh;
  const diffFromMkt    = marketPrice > 0 ? expectedBasis - marketPrice : null;
  const diffPct        = marketPrice > 0 ? Math.abs((diffFromMkt / marketPrice) * 100) : null;

  const belowMarket = diffFromMkt !== null && diffFromMkt < 0;
  const nearMarket  = diffFromMkt !== null && !belowMarket && diffPct !== null && diffPct <= 2;
  const aboveMarket = diffFromMkt !== null && !belowMarket && !nearMarket;

  const badgeCls   = belowMarket ? 'bg-green-50 border-green-200 text-green-700'
                   : nearMarket  ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                   :               'bg-red-50 border-red-200 text-red-700';
  const badgeText  = belowMarket ? '✓ Buying Below Market'
                   : nearMarket  ? '~ Near Market Price'
                   :               '⚠ Buying Above Market';
  const diffColor  = belowMarket ? 'text-green-700' : aboveMarket ? 'text-red-600' : 'text-yellow-600';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">

      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100"
        style={{ background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">Cash Secured Put Assignment</h3>
            <p className="text-xs text-slate-500 mt-0.5">What is my effective purchase price if assigned?</p>
          </div>
          <span className="text-xs font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full border border-blue-200">CSP</span>
        </div>
      </div>

      <div className="p-5 space-y-4 flex-1">

        {/* Inputs */}
        <div className="space-y-2.5">
          <CalcInput label="Put Strike"                   field="putStrike"    value={v.putStrike}    onChange={upd} placeholder="390.00" step="0.5" />
          <CalcInput label="Premium Collected (total $)"  field="premiumTotal" value={v.premiumTotal} onChange={upd} placeholder="420.00" />
          <CalcInput label="Current Market Price"         field="marketPrice"  value={v.marketPrice}  onChange={upd} placeholder="400.00" />
        </div>

        {/* Divider */}
        {hasInputs && <div className="border-t border-slate-100" />}

        {/* Results */}
        {hasInputs && (
          <div className="space-y-1">
            {/* Expected cost basis — primary output */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 mb-2">
              <p className="text-xs text-slate-500 mb-0.5">Expected Cost Basis If Assigned</p>
              <p className="text-3xl font-bold text-slate-900">${expectedBasis.toFixed(2)}</p>
              <p className="text-xs text-slate-400 mt-0.5">${putStrike.toFixed(2)} strike − ${premiumPerSh.toFixed(2)}/sh premium</p>
            </div>

            <CalcRow label="Premium Per Share"         value={`$${premiumPerSh.toFixed(2)}`} />
            {marketPrice > 0 && (
              <>
                <CalcRow label="Current Market Price"   value={`$${marketPrice.toFixed(2)}`} />
                <CalcRow
                  label="Difference From Market"
                  value={`${diffFromMkt >= 0 ? '+' : ''}$${diffFromMkt.toFixed(2)}`}
                  color={diffColor}
                  large
                />
              </>
            )}
          </div>
        )}

        {/* Status badge */}
        {marketPrice > 0 && hasInputs && (
          <div className={`rounded-xl px-4 py-3 text-center border ${badgeCls}`}>
            <span className="text-sm font-bold">{badgeText}</span>
          </div>
        )}

        {!hasInputs && (
          <p className="text-xs text-slate-400 italic text-center py-2">Enter strike and premium to calculate.</p>
        )}
      </div>
    </div>
  );
}

function MarketPlanningBoard() {
  const planningBoard      = useWheelStore(s => s.planningBoard);
  const planningMeta       = useWheelStore(s => s.planningMeta);
  const wheelCalcs         = useWheelStore(s => s.wheelCalcs);
  const updatePlanningRow  = useWheelStore(s => s.updatePlanningRow);
  const updatePlanningMeta = useWheelStore(s => s.updatePlanningMeta);
  const updateWheelCalc    = useWheelStore(s => s.updateWheelCalc);
  const addPlanningRow     = useWheelStore(s => s.addPlanningRow);
  const deletePlanningRow  = useWheelStore(s => s.deletePlanningRow);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900" style={{ fontFamily: 'Playfair Display, serif' }}>
          Market Planning Board
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">Manual support, resistance, and DTE tracking for core assets.</p>
      </div>

      {/* Planning tables */}
      <div className="grid grid-cols-2 gap-6">
        <PlanCard
          asset="tesla"
          title="Tesla"
          badge="Equity"
          headerStyle="linear-gradient(135deg, #7c3aed 0%, #6d28d9 40%, #9333ea 70%, #ec4899 100%)"
          initialRows={planningBoard.tesla || []}
          initialLastUpdated={planningMeta?.tesla?.lastUpdated || ''}
          onUpdate={updatePlanningRow}
          onUpdateMeta={updatePlanningMeta}
          onAdd={addPlanningRow}
          onDelete={deletePlanningRow}
        />
        <PlanCard
          asset="bitcoin"
          title="Bitcoin / IBIT"
          badge="Crypto"
          headerStyle="linear-gradient(135deg, #2563eb 0%, #0891b2 40%, #06b6d4 70%, #10b981 100%)"
          initialRows={planningBoard.bitcoin || []}
          initialLastUpdated={planningMeta?.bitcoin?.lastUpdated || ''}
          onUpdate={updatePlanningRow}
          onUpdateMeta={updatePlanningMeta}
          onAdd={addPlanningRow}
          onDelete={deletePlanningRow}
        />
      </div>

      {/* Universal wheel trading calculators */}
      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Wheel Trading Calculators</p>
        <div className="grid grid-cols-2 gap-6">
          <CoveredCallCalc
            initialData={wheelCalcs?.coveredCall}
            onUpdate={updateWheelCalc}
          />
          <CashPutCalc
            initialData={wheelCalcs?.cashPut}
            onUpdate={updateWheelCalc}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PAGE COMPONENTS
// ============================================================================

function Dashboard() {
  const positions     = useWheelStore((s) => s.positions);
  const journal       = useWheelStore((s) => s.journal);
  const campaigns     = useWheelStore((s) => s.campaigns);

  const recentJournal  = [...journal].slice(0, 4);
  const openPositions  = positions.filter(p => p.status === 'OPEN');
  const avgDTE         = openPositions.length
    ? Math.round(openPositions.reduce((s, p) => s + (p.dte || 0), 0) / openPositions.length)
    : 0;

  // ── Three-way premium reporting ──────────────────────────────────────────
  const isOptPos    = p => isOptCat(p.category);

  // 1. PREMIUM COLLECTED — all credits received, both open and closed positions
  const allPremiumCollected = positions
    .filter(p => isOptPos(p) && (p.premium || 0) > 0)
    .reduce((s, p) => s + p.premium, 0);

  // 2. REALIZED PROFIT — actual P&L from CLOSED positions only.
  // Uses || 0 fallback (not != null) to avoid JS loose-equality trap where
  // undefined != null evaluates false, silently excluding valid closed positions.
  const totalRealizedProfit = positions
    .filter(p => p.status === 'CLOSED' && p.closedData != null)
    .reduce((s, p) => s + (p.closedData.realizedPnL || 0), 0);

  // 3. OPEN PREMIUM EXPOSURE — premium tied to currently open option positions
  const openPremiumExposure = openPositions
    .filter(p => isOptPos(p) && (p.premium || 0) > 0)
    .reduce((s, p) => s + p.premium, 0);

  // BUYING POWER — net exposure (premium tied up in open positions) plus realized profit.
  const buyingPower = openPremiumExposure + totalRealizedProfit;

  // 4. COMMISSIONS — tracked separately, never mixed into premium or realized P&L
  const thisYear = new Date().getFullYear().toString();
  const commissionsYTD = positions
    .filter(p => (p.commission || 0) > 0 && (p.entryDate || '').startsWith(thisYear))
    .reduce((s, p) => s + (p.commission || 0), 0);
  const commissionsTotal = positions.reduce((s, p) => s + (p.commission || 0), 0);
  const netPremiumAfterCommissions = allPremiumCollected - commissionsTotal;

  // ── New ledger-driven metrics ─────────────────────────────────────────────
  const winRate       = calcWinRate(positions);
  const closedOptsAll = positions.filter(p => p.status === 'CLOSED' && isOptPos(p));
  const assignmentRate = closedOptsAll.length
    ? Math.round((closedOptsAll.filter(p => p.lifecycleStatus === 'Assigned').length / closedOptsAll.length) * 100)
    : 0;
  const totalThetaCollected = openPositions.filter(isOptPos).reduce((s, p) => s + (p.theta || 0), 0);
  const weeksElapsed = (() => {
    const dates = positions.map(p => p.entryDate).filter(Boolean).sort();
    if (!dates.length) return 1;
    return Math.max(1, (Date.now() - new Date(dates[0]).getTime()) / 86400000 / 7);
  })();
  const avgPremiumPerWeek = allPremiumCollected / weeksElapsed;
  const optPositionsWithStrike = positions.filter(p => isOptPos(p) && (p.premium || 0) > 0 && (p.strike || 0) > 0);
  const avgPremiumPct = optPositionsWithStrike.length
    ? optPositionsWithStrike.reduce((s, p) => s + (p.premium / (p.strike * (p.contracts || 1) * 100)) * 100, 0) / optPositionsWithStrike.length
    : 0;
  const totalNetPremium = allPremiumCollected - commissionsTotal
    - positions.reduce((s, p) => s + (p.closedData?.fees || 0), 0);

  // Premium collected per month (by entry date) for Income Snapshot
  const premiumMonthMap = {};
  positions
    .filter(p => isOptPos(p) && (p.premium || 0) > 0)
    .forEach(pos => {
      const key = (pos.entryDate || '').slice(0, 7);
      if (!key) return;
      if (!premiumMonthMap[key]) premiumMonthMap[key] = { premium: 0, count: 0 };
      premiumMonthMap[key].premium += pos.premium;
      premiumMonthMap[key].count   += 1;
    });
  const premiumMonthly = Object.entries(premiumMonthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key,
      label:   new Date(key + '-02').toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      premium: v.premium,
      count:   v.count,
    }));

  // Realized P&L per month (from CLOSED positions, grouped by close date)
  const realizedMonthMap = {};
  positions
    .filter(p => p.status === 'CLOSED' && p.closedData != null)
    .forEach(pos => {
      const key = (pos.closedData.closedDate || pos.entryDate || '').slice(0, 7);
      if (!key) return;
      if (!realizedMonthMap[key]) realizedMonthMap[key] = { pnl: 0, count: 0 };
      realizedMonthMap[key].pnl   += (pos.closedData.realizedPnL || 0);
      realizedMonthMap[key].count += 1;
    });
  const realizedMonthly = Object.entries(realizedMonthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key,
      label: new Date(key + '-02').toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      pnl:   v.pnl,
      count: v.count,
    }));

  // ── Campaign Metrics ───────────────────────────────────────────────────────
  const campaignMetrics = campaigns.map(campaign => {
    const camPos      = positions.filter(p => p.campaignId === campaign.id);
    const { netPremium: premiumCollected, realizedPnL } = calcCampaignProfit(camPos);
    const openCount   = camPos.filter(p => p.status === 'OPEN').length;
    const closedCount = camPos.filter(p => p.status === 'CLOSED').length;
    const roi         = premiumCollected > 0 ? (realizedPnL / premiumCollected) * 100 : 0;
    return { id: campaign.id, name: campaign.name, premiumCollected, realizedPnL, openCount, closedCount, roi, totalTrades: camPos.length };
  }).filter(c => c.totalTrades > 0);
  const topCampaign = campaignMetrics.length > 0 ? [...campaignMetrics].sort((a, b) => b.roi - a.roi)[0] : null;

  // Active campaigns — 3-metric breakdown per campaign
  const activeCampaigns = campaigns
    .map(campaign => {
      const camPos         = positions.filter(p => p.campaignId === campaign.id);
      const openPos        = camPos.filter(p => p.status === 'OPEN');
      const { netPremium: premiumCollected, realizedPnL: realizedProfit } = calcCampaignProfit(camPos);
      const campOpenExp    = openPos
        .filter(p => isOptPos(p) && (p.premium || 0) > 0)
        .reduce((s, p) => s + p.premium, 0);
      return { ...campaign, openPos, premiumCollected, realizedProfit, openPremiumExposure: campOpenExp };
    })
    .filter(c => c.openPos.length > 0);

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Dashboard
            </h1>
            <p className="text-slate-600">Today's actions and key metrics</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <SaveToCloudButton />
              <Link to="/backup" className="text-xs text-purple-600 hover:text-purple-800 font-semibold whitespace-nowrap">
                Manage Backups →
              </Link>
            </div>
            <SyncStatusIndicator compact />
          </div>
        </div>

        {/* Stat cards — all 6 on one row */}
        <div className="grid grid-cols-6 gap-3">
          <StatCard compact title="Commissions YTD"     value={commissionsYTD > 0 ? `-$${commissionsYTD.toFixed(2)}` : '$0.00'}                             subtitle="Drag on performance"  color="from-amber-500 to-orange-500" />
          <StatCard compact title="Active Campaigns"    value={activeCampaigns.length}                                                                      subtitle="Open campaigns"       color="from-orange-500 to-red-500" />
          <StatCard compact title="Avg DTE"             value={avgDTE}                                                                                      subtitle="Days to expiry"       color="from-purple-500 to-pink-500" />
          <StatCard compact title="Buying Power"        value={`${buyingPower >= 0 ? '+' : '-'}$${Math.abs(buyingPower).toLocaleString()}`}                  subtitle="Open exposure + realized"  color={buyingPower >= 0 ? 'from-green-500 to-emerald-600' : 'from-red-500 to-orange-500'} />
          <StatCard compact title="Realized Profit"     value={`${totalRealizedProfit >= 0 ? '+' : ''}$${Math.abs(totalRealizedProfit).toLocaleString()}`}  subtitle="Closed only"          color={totalRealizedProfit >= 0 ? 'from-teal-500 to-green-600' : 'from-red-500 to-orange-500'} />
          <StatCard compact title="Open Exposure"       value={`$${openPremiumExposure.toLocaleString()}`}                                                  subtitle="In open positions"    color="from-blue-500 to-cyan-500" />
        </div>

        {/* Trading Ledger metrics — second row */}
        <div className="grid grid-cols-6 gap-3">
          <StatCard compact title="Win Rate"            value={winRate != null ? `${winRate}%` : '—'}                                                       subtitle="Closed options"       color="from-emerald-500 to-green-600" />
          <StatCard compact title="Assignment Rate"     value={`${assignmentRate}%`}                                                                         subtitle="Of closed options"    color="from-blue-500 to-indigo-600" />
          <StatCard compact title="Avg Premium / Week"  value={`$${avgPremiumPerWeek.toFixed(0)}`}                                                           subtitle="Since first trade"    color="from-teal-500 to-cyan-600" />
          <StatCard compact title="Avg Premium %"       value={`${avgPremiumPct.toFixed(2)}%`}                                                               subtitle="Of capital at risk"   color="from-purple-500 to-fuchsia-600" />
          <StatCard compact title="Total Theta"         value={`$${totalThetaCollected.toFixed(2)}/d`}                                                       subtitle="Open positions"       color="from-orange-500 to-amber-600" />
          <StatCard compact title="Total Net Premium"   value={`${totalNetPremium >= 0 ? '+' : ''}$${Math.abs(totalNetPremium).toLocaleString()}`}            subtitle="After all fees"       color={totalNetPremium >= 0 ? 'from-green-500 to-emerald-600' : 'from-red-500 to-orange-500'} />
        </div>

        {/* Top Performing Campaign */}
        {topCampaign && (
          <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-6 text-white shadow-xl">
            <p className="text-xs font-semibold opacity-70 uppercase tracking-widest mb-1">Top Performing Campaign</p>
            <p className="text-2xl font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>{topCampaign.name}</p>
            <div className="flex items-center gap-10 mt-4">
              <div>
                <p className="text-xs opacity-70 mb-0.5">Realized Profit</p>
                <p className={`text-2xl font-bold ${topCampaign.realizedPnL >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                  {topCampaign.realizedPnL >= 0 ? '+' : ''}${topCampaign.realizedPnL.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs opacity-70 mb-0.5">ROI</p>
                <p className={`text-2xl font-bold ${topCampaign.roi >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                  {topCampaign.roi >= 0 ? '+' : ''}{topCampaign.roi.toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-xs opacity-70 mb-0.5">Closed Trades</p>
                <p className="text-2xl font-bold">{topCampaign.closedCount}</p>
              </div>
            </div>
          </div>
        )}

        {/* Market Planning Board */}
        <MarketPlanningBoard />

        {/* Main grid */}
        <div className="grid grid-cols-3 gap-6">

          {/* Income Snapshot */}
          <div className="bg-white rounded-xl p-6 border border-slate-200 space-y-4">
            <h3 className="text-lg font-semibold text-slate-900">Income Snapshot</h3>

            {/* Three key metrics */}
            <div className="space-y-0">
              <div className="flex justify-between items-center py-2 border-b border-slate-100">
                <div>
                  <span className="text-sm font-semibold text-slate-700">Premium Collected</span>
                  <p className="text-xs text-slate-400">All option credits · open + closed</p>
                </div>
                <span className="text-base font-bold text-green-700">${allPremiumCollected.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-slate-100">
                <div>
                  <span className="text-sm font-semibold text-slate-700">Realized Profit</span>
                  <p className="text-xs text-slate-400">Closed positions only</p>
                </div>
                <span className={`text-base font-bold ${totalRealizedProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {totalRealizedProfit >= 0 ? '+' : ''}${totalRealizedProfit.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-slate-100">
                <div>
                  <span className="text-sm font-semibold text-slate-700">Open Exposure</span>
                  <p className="text-xs text-slate-400">Premium still in open trades</p>
                </div>
                <span className="text-base font-bold text-amber-600">${openPremiumExposure.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-slate-100">
                <div>
                  <span className="text-sm font-semibold text-slate-700">Commissions Paid</span>
                  <p className="text-xs text-slate-400">All-time · separate from P&L</p>
                </div>
                <span className="text-base font-bold text-red-500">
                  {commissionsTotal > 0 ? `-$${commissionsTotal.toFixed(2)}` : '$0.00'}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <div>
                  <span className="text-sm font-semibold text-slate-700">Net After Commissions</span>
                  <p className="text-xs text-slate-400">Premium − all commissions</p>
                </div>
                <span className={`text-base font-bold ${netPremiumAfterCommissions >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {netPremiumAfterCommissions >= 0 ? '+' : ''}${netPremiumAfterCommissions.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Buying power note */}
            <p className="text-xs text-slate-500 italic bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
              💡 Premium collected increases buying power immediately but does not become realized profit until the position closes or expires. Commissions are tracked separately and never deducted from premium or realized P&L figures.
            </p>

            {/* Monthly breakdowns */}
            <div className="space-y-3 pt-1">
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Realized profit / month</p>
                {realizedMonthly.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No closed positions yet.</p>
                ) : (
                  realizedMonthly.slice(-3).reverse().map((m) => (
                    <div key={m.key} className="flex justify-between">
                      <span className="text-xs text-slate-500">{m.label}</span>
                      <span className={`text-xs font-semibold ${m.pnl >= 0 ? 'text-slate-700' : 'text-red-600'}`}>
                        {m.pnl >= 0 ? '+' : ''}${m.pnl.toLocaleString()} <span className="text-slate-400">({m.count} closes)</span>
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Premium collected / month</p>
                {premiumMonthly.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No positions yet.</p>
                ) : (
                  premiumMonthly.slice(-3).reverse().map((m) => (
                    <div key={m.key} className="flex justify-between">
                      <span className="text-xs text-slate-500">{m.label}</span>
                      <span className="text-xs font-semibold text-green-700">
                        ${m.premium.toLocaleString()} <span className="text-slate-400">({m.count} trades)</span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Active Campaigns */}
          <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Active Campaigns</h3>
              <Link to="/positions" className="text-xs text-purple-600 hover:text-purple-800 font-semibold">View all →</Link>
            </div>
            {activeCampaigns.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No active campaigns.</p>
            ) : (
              <div className="space-y-2">
                {activeCampaigns.map((campaign) => (
                  <div key={campaign.id} className="p-3 bg-white rounded-lg border border-slate-100">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-semibold text-slate-900 text-sm">{campaign.name}</p>
                      <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700">
                        {campaign.openPos.length} open
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {campaign.openPos.map(pos => (
                        <p key={pos.id} className="text-xs text-slate-500">
                          {pos.category}{pos.strike ? ` $${pos.strike}` : ''}{pos.dte != null ? ` · ${pos.dte} DTE` : ''}
                        </p>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-slate-100">
                      <div>
                        <p className="text-slate-400 font-semibold" style={{ fontSize: '9px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Collected</p>
                        <p className="text-xs font-bold text-green-700">${campaign.premiumCollected.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-semibold" style={{ fontSize: '9px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Realized</p>
                        <p className={`text-xs font-bold ${campaign.realizedProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {campaign.realizedProfit >= 0 ? '+' : ''}${campaign.realizedProfit.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-semibold" style={{ fontSize: '9px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Open Exp.</p>
                        <p className="text-xs font-bold text-amber-600">${campaign.openPremiumExposure.toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent journal activity + Quick Actions */}
          <div className="space-y-4">
            {/* Recent Journal */}
            <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-slate-900">Recent Journal</h3>
                <Link to="/journal" className="text-xs text-purple-600 hover:text-purple-800 font-semibold">View all →</Link>
              </div>
              <div className="space-y-2">
                {recentJournal.map((entry) => {
                  const isActionTaken = (entry.lesson || '').startsWith('Action taken:');
                  return (
                    <div key={entry.id} className="bg-white rounded-lg p-3 border border-slate-100">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-slate-900">{entry.symbol}</span>
                        <span className="text-xs text-slate-400">{entry.date}</span>
                      </div>
                      <p className="text-xs text-slate-600 truncate">{entry.trade}</p>
                      {isActionTaken && (
                        <p className="text-xs font-semibold text-purple-700 mt-1 truncate">
                          {(entry.lesson || '').split('\n')[0]}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 mb-3">Quick Actions</h3>
              <div className="space-y-1.5">
                <Link to="/simulator"
                  className="w-full py-2 flex items-center justify-center bg-gradient-to-r from-purple-500 to-blue-500 text-white rounded-lg text-sm font-semibold hover:shadow-lg transition">
                  🎯 Run Simulator
                </Link>
                <Link to="/positions"
                  className="w-full py-2 flex items-center justify-center bg-slate-200 text-slate-900 rounded-lg text-sm font-semibold hover:bg-slate-300 transition">
                  📈 Positions
                </Link>
                <Link to="/income"
                  className="w-full py-2 flex items-center justify-center bg-slate-200 text-slate-900 rounded-lg text-sm font-semibold hover:bg-slate-300 transition">
                  💰 Income Report
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </LayoutWrapper>
  );
}

function PositionJournalDrawer({ position, onClose }) {
  const journal = useWheelStore((s) => s.journal);
  const addJournalEntryToPosition    = useWheelStore((s) => s.addJournalEntryToPosition);
  const removeJournalEntryFromPosition = useWheelStore((s) => s.removeJournalEntryFromPosition);

  const linkedIds     = position.journalEntryIds || [];
  // Match both by journalEntryIds list AND by positionId field so entries are found
  // regardless of which side of the link was set first.
  const linkedEntries = journal.filter(
    (j) => linkedIds.includes(j.id) || j.positionId === position.id
  );
  const linkedIdSet   = new Set(linkedEntries.map(e => e.id));
  const linkableEntries = journal.filter(
    (j) => !linkedIdSet.has(j.id) && j.symbol === position.symbol
  );

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1" />
      <div
        className="w-[420px] bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Journal Entries</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {position.symbol} · {position.category}{position.strike ? ` $${position.strike}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/journal" onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 whitespace-nowrap">
              Open Journal Tab →
            </Link>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none mt-0.5">&times;</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Linked entries */}
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">
              Linked Entries ({linkedEntries.length})
            </h3>
            {linkedEntries.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No journal entries linked yet.</p>
            ) : (
              <div className="space-y-3">
                {linkedEntries.map((entry) => {
                  const thesis = entry.tradeThesis?.reason || '';
                  const hasResult = entry.result && entry.result.trim();
                  return (
                    <div key={entry.id} className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{entry.trade}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{entry.date}</p>
                        </div>
                        <button
                          onClick={() => removeJournalEntryFromPosition(position.id, entry.id)}
                          className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-100"
                        >
                          Unlink
                        </button>
                      </div>
                      {thesis && (
                        <p className="text-xs text-slate-600 mt-1 line-clamp-2 italic">"{thesis}"</p>
                      )}
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                        {hasResult && (
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                            entry.result === 'Outcome Pending' || entry.result === 'Pending'
                              ? 'bg-amber-100 text-amber-700'
                              : entry.result.includes('+')
                                ? 'bg-green-100 text-green-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}>
                            {entry.result}
                          </span>
                        )}
                        <Link to="/journal" onClick={onClose}
                          className="ml-auto text-xs font-semibold text-purple-600 hover:text-purple-800 hover:underline">
                          View in Journal →
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Linkable entries for same symbol */}
          {linkableEntries.length > 0 && (
            <div>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">
                Available {position.symbol} Entries
              </h3>
              <div className="space-y-3">
                {linkableEntries.map((entry) => (
                  <div key={entry.id} className="bg-white rounded-xl p-4 border border-dashed border-slate-300">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-700 truncate">{entry.trade}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{entry.date}</p>
                        {entry.tradeThesis?.reason && (
                          <p className="text-xs text-slate-400 mt-1 line-clamp-1 italic">"{entry.tradeThesis.reason}"</p>
                        )}
                      </div>
                      <button
                        onClick={() => addJournalEntryToPosition(position.id, entry.id)}
                        className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded hover:bg-purple-100"
                      >
                        + Link
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {linkedEntries.length === 0 && linkableEntries.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-slate-400 italic mb-3">No journal entries for {position.symbol} yet.</p>
              <Link to="/journal" onClick={onClose}
                className="inline-block px-4 py-2 text-sm font-semibold text-white rounded-lg"
                style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                Go to Journal to create one →
              </Link>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <p className="text-xs text-slate-400">{linkedEntries.length} linked · {linkableEntries.length} available</p>
          <Link to="/journal" onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
            Open Full Journal →
          </Link>
        </div>
      </div>
    </div>
  );
}

function EditPositionModal({ position, onSave, onClose }) {
  const [form, setForm] = useState({ ...position });
  const upd = (f, v) => setForm(p => ({ ...p, [f]: v }));
  const on  = (f) => (e) => upd(f, e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value);

  // Auto-compute DTE from entry date → expiry whenever either changes (options only)
  const isOpt = isOptCat(form.category);
  useEffect(() => {
    if (!isOpt) return;
    const computed = calcDTE(form.entryDate, form.expiry);
    if (computed !== null) setForm(p => ({ ...p, dte: computed }));
  }, [form.entryDate, form.expiry]); // eslint-disable-line react-hooks/exhaustive-deps

  // For Cash positions: Actual Buy Price = (Capital − Commission) / Shares
  // Falls back to (Capital − Commission) when shares is blank/zero.
  const recalcActualBuyPrice = (capital, comm, shares) => {
    const gross = (Number(capital) || 0) - (Number(comm) || 0);
    const qty   = Number(shares) || 0;
    const price = qty > 0 ? gross / qty : gross;
    setForm(p => ({ ...p, targetPrice: price > 0 ? parseFloat(price.toFixed(4)) : p.targetPrice }));
  };

  const cat      = form.category;
  const isOption = isOptCat(cat);
  const isShares = cat === 'Long Shares';
  const isCash   = cat === 'Cash';
  const cfg      = POSITION_CATEGORIES[cat] || {};

  const inp = (label, field, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type={type} step={type === 'number' ? 'any' : undefined}
        value={form[field] ?? ''} onChange={on(field)} placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Edit Position</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {cat}</span>
              <span className="text-xs text-slate-500">{position.symbol}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* Common fields */}
          <div className="grid grid-cols-2 gap-4">
            {inp('Symbol', 'symbol')}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Entry Date</label>
              <input type="date" value={form.entryDate ?? ''}
                onChange={e => {
                  const val = e.target.value;
                  upd('entryDate', val);
                  const computed = calcDTE(val, form.expiry);
                  if (computed !== null) setForm(p => ({ ...p, entryDate: val, dte: computed }));
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
          </div>

          {/* Option fields */}
          {isOption && (
            <>
              <div className="grid grid-cols-3 gap-3">
                {inp('Strike ($)', 'strike', 'number')}
                {inp('Premium ($)', 'premium', 'number')}
                {inp('Contracts', 'contracts', 'number')}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {/* Expiry — triggers DTE recalc */}
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Expiry</label>
                  <input type="date" value={form.expiry ?? ''}
                    onChange={e => {
                      const val = e.target.value;
                      const computed = calcDTE(form.entryDate, val);
                      setForm(p => ({ ...p, expiry: val, ...(computed !== null ? { dte: computed } : {}) }));
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
                {/* DTE — auto-calculated, read-only */}
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    DTE <span className="font-normal text-blue-500 normal-case ml-1">auto-calculated</span>
                  </label>
                  <div className="relative">
                    <input type="number" readOnly value={form.dte ?? ''}
                      className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-blue-50 font-bold text-blue-900 cursor-default" />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-400 pointer-events-none">days</span>
                  </div>
                  {form.entryDate && form.expiry && (
                    <p className="text-xs text-blue-500 mt-0.5">Expiry − Entry Date</p>
                  )}
                </div>
                {inp('Current Value ($)', 'currentValue', 'number')}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {inp('Delta', 'delta', 'number')}
                {inp('Theta', 'theta', 'number')}
                <div>
                  <label className="block text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1">Commission ($) <span className="normal-case text-slate-400 font-normal">optional</span></label>
                  <input type="number" step="0.01" min="0"
                    value={form.commission ?? ''} onChange={e => upd('commission', e.target.value === '' ? null : Number(e.target.value))}
                    placeholder="e.g. 1.30"
                    className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-400 bg-amber-50" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {inp('Exchange Fees ($)', 'exchangeFees', 'number')}
                {inp('GST ($)', 'gst', 'number')}
              </div>
              {/* Option purchase price — shown for Naked Call/Put where user may have bought the option */}
              {(cat === 'Naked Call' || cat === 'Naked Put') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    Option Price Paid ($/share) <span className="font-normal text-slate-400 normal-case">— what you paid to enter</span>
                  </label>
                  <input type="number" step="0.01" min="0"
                    value={form.optionPurchasePrice ?? ''}
                    onChange={e => upd('optionPurchasePrice', e.target.value === '' ? null : Number(e.target.value))}
                    placeholder="e.g. 4.50"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 font-semibold" />
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Thesis</label>
                <textarea value={form.thesis ?? ''} onChange={e => upd('thesis', e.target.value)} rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
              </div>

              <div className="grid grid-cols-3 gap-3">
                {inp('Underlying Price at Entry ($)', 'underlyingPriceAtEntry', 'number')}
                {inp('Share Cost Basis Snapshot ($)', 'shareCostBasisSnapshot', 'number')}
                {inp('Open Interest', 'openInterest', 'number')}
              </div>
              {cat === 'Covered Call' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    Shares Covered <span className="font-normal text-slate-400 normal-case">— defaults to contracts × 100</span>
                  </label>
                  <input type="number" value={form.sharesCovered ?? ''} onChange={on('sharesCovered')}
                    placeholder={`${(form.contracts || 1) * 100}`}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Exit Plan</label>
                <input value={form.exitPlan ?? ''} onChange={e => upd('exitPlan', e.target.value)} placeholder="e.g. Close at 50% profit or 21 DTE"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Trade Tags <span className="font-normal text-slate-400 normal-case">comma-separated</span></label>
                <input value={(form.tradeTags || []).join(', ')}
                  onChange={e => upd('tradeTags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                  placeholder="e.g. earnings-play, high-iv"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>

              {/* ── Naked option live analysis ─────────────────────────── */}
              {(cat === 'Naked Call' || cat === 'Naked Put') && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-indigo-800 uppercase tracking-wide">Live Option Analysis</h4>
                    <span className="text-xs text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded font-semibold">Black-Scholes</span>
                  </div>

                  {/* Market data inputs */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Current Stock Price ($)</label>
                      <input type="number" step="0.01" min="0"
                        value={form.currentSharePrice ?? ''}
                        onChange={e => upd('currentSharePrice', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 374.60"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-400 bg-white font-semibold" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Implied Volatility (%)</label>
                      <input type="number" step="0.1" min="0" max="500"
                        value={form.impliedVolatility ?? ''}
                        onChange={e => upd('impliedVolatility', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 30"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-400 bg-white font-semibold" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Current Option Price ($)</label>
                      <input type="number" step="0.01" min="0"
                        value={form.currentValue ?? ''}
                        onChange={e => upd('currentValue', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 4.50"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-400 bg-white font-semibold" />
                    </div>
                  </div>

                  {/* Live Black-Scholes calculation */}
                  {form.currentSharePrice && form.strike && form.dte && form.impliedVolatility && (() => {
                    const S     = Number(form.currentSharePrice);
                    const K     = Number(form.strike);
                    const T_d   = Math.max(Number(form.dte) || 1, 0.001);
                    const iv    = (Number(form.impliedVolatility) || 30) / 100;
                    const r     = 0.05;
                    const type  = cat === 'Naked Call' ? 'Call' : 'Put';
                    const mkt   = calcOptionMetrics(S, K, T_d, r, iv, type);
                    const theoPx  = mkt.price;
                    const mktPx   = Number(form.currentValue) || 0;
                    const diff    = mktPx - theoPx;
                    const pctDiff = theoPx > 0 ? ((diff / theoPx) * 100).toFixed(1) : null;
                    const status  = Math.abs(diff) < 0.05
                      ? { label: 'Fair Value', cls: 'bg-slate-50 text-slate-700 border-slate-200' }
                      : diff > 0
                      ? { label: 'Overpriced', cls: 'bg-green-50 text-green-800 border-green-200' }  // seller benefits
                      : { label: 'Underpriced', cls: 'bg-red-50 text-red-700 border-red-200' };

                    return (
                      <div className="space-y-3">
                        {/* Value comparison */}
                        <div className="grid grid-cols-3 gap-2">
                          <div className="bg-white rounded-lg border border-indigo-100 p-3 text-center">
                            <p className="text-xs text-slate-500 mb-1">Theoretical Value</p>
                            <p className="text-xl font-bold text-indigo-800">${theoPx.toFixed(2)}</p>
                            <p className="text-xs text-slate-400 mt-0.5">per share</p>
                          </div>
                          <div className="bg-white rounded-lg border border-indigo-100 p-3 text-center">
                            <p className="text-xs text-slate-500 mb-1">Market Price</p>
                            <p className="text-xl font-bold text-slate-900">${mktPx > 0 ? mktPx.toFixed(2) : '—'}</p>
                            <p className="text-xs text-slate-400 mt-0.5">per share</p>
                          </div>
                          <div className={`rounded-lg border p-3 text-center ${status.cls}`}>
                            <p className="text-xs opacity-70 mb-1">Status</p>
                            <p className="text-base font-bold">{status.label}</p>
                            {pctDiff !== null && mktPx > 0 && (
                              <p className="text-xs mt-0.5 opacity-70">{diff >= 0 ? '+' : ''}{pctDiff}% vs theo</p>
                            )}
                          </div>
                        </div>

                        {/* Position P&L — only when purchase price is set */}
                        {form.optionPurchasePrice != null && (() => {
                          const entryPx   = Number(form.optionPurchasePrice);
                          const contracts = Number(form.contracts) || 1;
                          const mult      = contracts * 100;
                          const costTotal = entryPx * mult;
                          const currTotal = mktPx > 0 ? mktPx * mult : theoPx * mult;
                          const pnl       = currTotal - costTotal;
                          const pnlPct    = costTotal > 0 ? ((pnl / costTotal) * 100).toFixed(1) : null;
                          return (
                            <div className={`rounded-lg border p-3 ${pnl >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Position P&L</p>
                              <div className="grid grid-cols-4 gap-3 text-xs">
                                <div><p className="text-slate-400">Paid</p><p className="font-bold text-slate-800">${entryPx.toFixed(2)}/sh</p><p className="text-slate-400">${costTotal.toFixed(0)} total</p></div>
                                <div><p className="text-slate-400">Current</p><p className="font-bold text-slate-800">${(mktPx > 0 ? mktPx : theoPx).toFixed(2)}/sh</p><p className="text-slate-400">${currTotal.toFixed(0)} total</p></div>
                                <div><p className="text-slate-400">Unrealized P&L</p><p className={`font-bold text-base ${pnl >= 0 ? 'text-green-700' : 'text-red-600'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</p></div>
                                <div><p className="text-slate-400">Return</p><p className={`font-bold text-base ${pnl >= 0 ? 'text-green-700' : 'text-red-600'}`}>{pnlPct !== null ? `${pnl >= 0 ? '+' : ''}${pnlPct}%` : '—'}</p></div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Greeks */}
                        <div className="grid grid-cols-4 gap-2">
                          {[
                            { g: 'Δ Delta', v: mkt.delta.toFixed(3),                 c: 'text-purple-700' },
                            { g: 'Θ Theta', v: `-$${Math.abs(mkt.theta).toFixed(2)}/d`, c: 'text-blue-700' },
                            { g: 'Γ Gamma', v: mkt.gamma.toFixed(4),                 c: 'text-orange-700' },
                            { g: 'ν Vega',  v: `$${mkt.vega.toFixed(2)}/1%IV`,       c: 'text-green-700' },
                          ].map(({ g, v, c }) => (
                            <div key={g} className="bg-white rounded-lg border border-indigo-100 p-2 text-center">
                              <p className="text-xs text-slate-400">{g}</p>
                              <p className={`text-sm font-bold mt-0.5 ${c}`}>{v}</p>
                            </div>
                          ))}
                        </div>

                        {/* Interpretation */}
                        <p className="text-xs text-indigo-700 bg-indigo-100 rounded-lg px-3 py-2">
                          {cat === 'Naked Call'
                            ? `At $${S} with ${form.impliedVolatility}% IV, this call has a theoretical value of $${theoPx.toFixed(2)}. Delta ${mkt.delta.toFixed(3)} — the option moves $${Math.abs(mkt.delta).toFixed(2)} per $1 move in the stock. Vega $${mkt.vega.toFixed(2)} — gains/loses $${mkt.vega.toFixed(2)} per 1% IV change.`
                            : `At $${S} with ${form.impliedVolatility}% IV, this put has a theoretical value of $${theoPx.toFixed(2)}. Delta ${mkt.delta.toFixed(3)} — the option moves $${Math.abs(mkt.delta).toFixed(2)} per $1 move in the stock. Assignment risk ${(Math.abs(mkt.delta) * 100).toFixed(0)}% proxy probability.`}
                        </p>
                      </div>
                    );
                  })()}

                  {!(form.currentSharePrice && form.strike && form.dte && form.impliedVolatility) && (
                    <p className="text-xs text-indigo-500 italic">
                      Fill in Strike, DTE, Current Stock Price, and Implied Volatility to see the theoretical value.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* Long Shares fields */}
          {isShares && (
            <>
              <div className="grid grid-cols-3 gap-3">
                {inp('Shares', 'shareCount', 'number')}
                {inp('Purchase Price ($)', 'purchasePrice', 'number')}
                {inp('Current Price ($)', 'currentSharePrice', 'number')}
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-blue-800 uppercase tracking-wide">Avg Price Per Share ($)</label>
                  <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded font-semibold">Used for all calculations</span>
                </div>
                <input type="number" step="any" min="0"
                  value={form.avgPricePerShare ?? ''}
                  onChange={e => upd('avgPricePerShare', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder={`e.g. ${form.purchasePrice || '84.50'}`}
                  className="w-full px-3 py-2 border border-blue-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-400 bg-white font-semibold" />
                <p className="text-xs text-blue-700 mt-1.5 opacity-80">
                  Set this when you hold shares from multiple assignments at different prices. Overrides Purchase Price in all P&L, unrealized gain, and ledger calculations across every tab.
                </p>
                {form.purchasePrice && form.avgPricePerShare && form.avgPricePerShare !== form.purchasePrice && (
                  <p className="text-xs text-blue-800 font-semibold mt-1">
                    Active — using ${form.avgPricePerShare}/sh · original purchase was ${form.purchasePrice}/sh
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1">Commission ($) <span className="normal-case text-slate-400 font-normal">optional</span></label>
                <input type="number" step="0.01" min="0"
                  value={form.commission ?? ''} onChange={e => upd('commission', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="e.g. 1.30"
                  className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-400 bg-amber-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</label>
                <textarea value={form.notes ?? ''} onChange={e => upd('notes', e.target.value)} rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
              </div>
            </>
          )}

          {/* Cash fields */}
          {isCash && (
            <>
              {/* Row 1: Capital + Shares */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Capital Amount ($)</label>
                  <input type="number" step="any" value={form.capitalAmount ?? ''}
                    onChange={e => {
                      const val = e.target.value === '' ? null : Number(e.target.value);
                      upd('capitalAmount', val);
                      recalcActualBuyPrice(val, form.commission, form.shareCount);
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Number of Shares</label>
                  <input type="number" step="1" min="1" value={form.shareCount ?? ''}
                    onChange={e => {
                      const val = e.target.value === '' ? null : Number(e.target.value);
                      upd('shareCount', val);
                      recalcActualBuyPrice(form.capitalAmount, form.commission, val);
                    }}
                    placeholder="e.g. 100"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
              </div>

              {/* Actual Buy Price — calculated, still editable for override */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                  Actual Buy Price ($/share)
                  <span className="ml-1 font-normal text-slate-400 normal-case">= (Capital − Commission) ÷ Shares</span>
                </label>
                <input type="number" step="any" value={form.targetPrice ?? ''}
                  onChange={e => upd('targetPrice', e.target.value === '' ? null : Number(e.target.value))}
                  className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-400 bg-blue-50 font-semibold" />
                {/* Live formula preview */}
                {(form.capitalAmount || form.commission || form.shareCount) && (() => {
                  const gross = (Number(form.capitalAmount) || 0) - (Number(form.commission) || 0);
                  const qty   = Number(form.shareCount) || 0;
                  const price = qty > 0 ? gross / qty : gross;
                  return (
                    <p className="text-xs text-blue-700 mt-1 font-semibold">
                      ({Number(form.capitalAmount || 0).toFixed(2)} − {Number(form.commission || 0).toFixed(2)}) ÷ {qty || '?'} = <span className="text-blue-900">${price.toFixed(4)}/sh</span>
                    </p>
                  );
                })()}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Intent</label>
                <input value={form.intent ?? ''} onChange={e => upd('intent', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                  placeholder="e.g. Reserved for TSLA put assignment" />
              </div>

              {/* Commission — tracked separately, triggers Actual Buy Price recalc */}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-amber-800 uppercase tracking-wide">Commission Paid (optional)</label>
                  <span className="text-xs text-amber-600 bg-amber-100 px-2 py-0.5 rounded font-semibold">Tracked separately</span>
                </div>
                <div className="flex gap-2 items-center">
                  <input type="number" step="0.01" min="0"
                    value={form.commission ?? ''} onChange={e => {
                      const val = e.target.value === '' ? null : Number(e.target.value);
                      upd('commission', val);
                      recalcActualBuyPrice(form.capitalAmount, val, form.shareCount);
                    }}
                    placeholder="e.g. 1.30"
                    className="flex-1 px-3 py-2 border border-amber-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-400 bg-white" />
                  <button type="button"
                    onClick={() => recalcActualBuyPrice(form.capitalAmount, form.commission, form.shareCount)}
                    className="px-3 py-2 text-xs font-semibold text-amber-700 border border-amber-300 rounded-lg bg-white hover:bg-amber-50 whitespace-nowrap">
                    ↻ Recalc
                  </button>
                </div>
                <p className="text-xs text-amber-600 mt-1.5 opacity-75">
                  Subtracted from net totals. Not included in premium collected or realized P&L.
                </p>
              </div>

              {/* Current stock price — drives market value of liquid assets */}
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-green-800 uppercase tracking-wide">Current Stock Price ($)</label>
                  <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded font-semibold">Liquid asset value</span>
                </div>
                <input type="number" step="0.01" min="0"
                  value={form.currentSharePrice ?? ''}
                  onChange={e => upd('currentSharePrice', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="e.g. 374.60"
                  className="w-full px-3 py-2 border border-green-300 rounded-lg text-sm focus:ring-2 focus:ring-green-400 bg-white font-semibold" />
                {/* Live market value preview */}
                {form.currentSharePrice && form.shareCount && (() => {
                  const mktVal  = (Number(form.currentSharePrice) || 0) * (Number(form.shareCount) || 0);
                  const capital = Number(form.capitalAmount) || 0;
                  const diff    = mktVal - capital;
                  return (
                    <div className="mt-2 pt-2 border-t border-green-200 space-y-0.5">
                      <p className="text-xs text-green-800 font-semibold">
                        Market Value: ${mktVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        <span className="ml-1 font-normal opacity-70">({form.shareCount} sh × ${form.currentSharePrice})</span>
                      </p>
                      {capital > 0 && (
                        <p className={`text-xs font-semibold ${diff >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {diff >= 0 ? '+' : ''}${diff.toFixed(2)} vs reserved capital
                        </p>
                      )}
                    </div>
                  );
                })()}
                <p className="text-xs text-green-700 mt-1.5 opacity-75">
                  Used in Net Liq and liquid asset totals across all tabs.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</label>
                <textarea value={form.notes ?? ''} onChange={e => upd('notes', e.target.value)} rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
              </div>
            </>
          )}

          {/* Campaign assignment */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Campaign ID</label>
            <input value={form.campaignId ?? ''} onChange={e => upd('campaignId', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={() => { onSave(form); onClose(); }}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusHistoryModal({ position, onClose }) {
  const history = position.statusHistory || [];
  const statusColors = {
    Active: 'bg-green-100 text-green-700', Review: 'bg-blue-100 text-blue-700',
    Roll:   'bg-purple-100 text-purple-700', Close: 'bg-red-100 text-red-700',
    Assign: 'bg-amber-100 text-amber-700',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Status History</h2>
            <p className="text-sm text-slate-500 mt-0.5">{position.symbol} · {position.type} ${position.strike}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto space-y-3">
          {/* Current status */}
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
            <div className="w-2.5 h-2.5 rounded-full bg-green-500 shrink-0" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Current</p>
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusColors[position.status] || 'bg-slate-100 text-slate-600'}`}>
                {position.status}
              </span>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-4">No status changes recorded yet. Use the Scenario Simulator to take action.</p>
          ) : (
            [...history].reverse().map((h, i) => (
              <div key={i} className="flex gap-3 p-3 border border-slate-100 rounded-xl">
                <div className="w-2 h-2 rounded-full bg-slate-300 shrink-0 mt-1.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${statusColors[h.oldStatus] || 'bg-slate-100 text-slate-600'}`}>{h.oldStatus}</span>
                    <span className="text-slate-400 text-xs">→</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${statusColors[h.newStatus] || 'bg-slate-100 text-slate-600'}`}>{h.newStatus}</span>
                    <span className="text-xs text-slate-400 ml-auto">{h.date ? h.date.split('T')[0] : ''}</span>
                  </div>
                  {h.reason && <p className="text-xs text-slate-500">{h.reason}</p>}
                </div>
              </div>
            ))
          )}

          {position.scenarioApplied && (
            <div className="pt-3 border-t border-slate-100">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Last Scenario Applied</p>
              <div className="bg-purple-50 rounded-xl p-3 text-xs text-purple-700 space-y-1">
                <p>Price: <span className="font-semibold">${position.scenarioApplied.price}</span> · DTE: <span className="font-semibold">{position.scenarioApplied.dte}</span></p>
                <p>Recommendation: <span className="font-semibold">{position.scenarioApplied.recommendation}</span></p>
                <p>Confidence: <span className="font-semibold">{position.scenarioApplied.confidence}%</span></p>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Close</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// IMPORT FROM TIGER MODAL
// ============================================================================

function ImportFromTigerModal({ onClose }) {
  const existingPositions = useWheelStore(s => s.positions);
  const campaigns         = useWheelStore(s => s.campaigns);
  const addPosition       = useWheelStore(s => s.addPosition);
  const addCampaign       = useWheelStore(s => s.addCampaign);

  const [phase,    setPhase]    = useState('loading');  // loading | review | success | error
  const [rows,     setRows]     = useState([]);
  const [fetchSrc, setFetchSrc] = useState('live');     // live | offline | error
  const [apiError, setApiError] = useState('');
  const [result,   setResult]   = useState(null);

  // Fetch on mount
  useEffect(() => {
    let cancelled = false;
    fetchTigerPositions().then(({ positions, source, error }) => {
      if (cancelled) return;
      setFetchSrc(source);
      if (source === 'offline') {
        setApiError('Backend server is not running. In a separate terminal, run: npm run server  (or npm run dev to start everything at once)');
        setPhase('error');
        return;
      }
      if (error) setApiError(error);
      const normalised = (positions || []).map(p => normaliseForReview(p, existingPositions, campaigns));
      setRows(normalised);
      setPhase('review');
    }).catch(() => {
      if (!cancelled) setPhase('error');
    });
    return () => { cancelled = true; };
  }, []);

  const updRow = (id, patch) =>
    setRows(prev => prev.map(r => r._id === id ? { ...r, ...patch } : r));

  const toggleAll = (val) =>
    setRows(prev => prev.map(r => ({ ...r, selected: r.duplicates.length === 0 ? val : r.selected })));

  const handleImport = () => {
    const toImport = rows.filter(r => r.selected && (r.duplicates.length === 0 || !r.skipDuplicate === false));
    if (toImport.length === 0) return;

    const imported = [];
    toImport.forEach(row => {
      // Handle "Create New Campaign"
      let campaignId = row.campaignId;
      if (campaignId === '__new__') {
        addCampaign({ symbol: row.symbol, name: `${row.symbol} Campaign`, notes: 'Imported from Tiger' });
        // We can't easily get the new ID here synchronously — just leave unassigned
        campaignId = null;
      }
      const pos = buildWheelEdgePosition({ ...row, campaignId });
      addPosition(pos);
      imported.push(row.symbol);
    });

    // Group by symbol for the success notification
    const grouped = imported.reduce((acc, sym) => { acc[sym] = (acc[sym] || 0) + 1; return acc; }, {});
    setResult({ total: imported.length, grouped });
    setPhase('success');
  };

  const selectedCount   = rows.filter(r => r.selected).length;
  const duplicateCount  = rows.filter(r => r.selected && r.duplicates.length > 0).length;

  const catOptions = ['Long Shares', 'Short Put', 'Covered Call', 'Cash', 'Naked Call', 'Naked Put'];
  const campOptions = [
    { id: '', label: 'Leave Unassigned' },
    { id: '__new__', label: '+ Create New Campaign' },
    ...campaigns.map(c => ({ id: c.id, label: c.name })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Import From Tiger</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Review positions from your Tiger account before importing.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {fetchSrc === 'live' && (
              <span className="text-xs px-2 py-1 rounded-full font-semibold bg-green-100 text-green-700">🟢 Live Data</span>
            )}
            {fetchSrc === 'error' && (
              <span className="text-xs px-2 py-1 rounded-full font-semibold bg-amber-100 text-amber-700">⚠️ API Error</span>
            )}
            {fetchSrc === 'offline' && (
              <span className="text-xs px-2 py-1 rounded-full font-semibold bg-red-100 text-red-700">🔴 Server Offline</span>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
          </div>
        </div>

        {/* API error notice (Tiger API errors only — offline is handled in body) */}
        {apiError && fetchSrc === 'error' && (
          <div className="px-6 py-2 bg-amber-50 border-b border-amber-100 shrink-0">
            <p className="text-xs text-amber-800">
              <strong>Tiger API error:</strong> {apiError}
            </p>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {phase === 'loading' && (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-slate-500">Fetching positions from Tiger…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <span className="text-4xl">🔴</span>
              <p className="text-base font-semibold text-slate-800">Tiger backend server is not running</p>
              <p className="text-sm text-slate-500 max-w-md">
                The import feature requires the backend server to connect to the Tiger API.
                Open a separate terminal in the project folder and run:
              </p>
              <code className="text-sm bg-slate-100 border border-slate-300 rounded-lg px-4 py-2 font-mono text-slate-900 select-all">
                npm run dev
              </code>
              <p className="text-xs text-slate-400 mt-1">
                This starts both the React app and the Tiger API server together on port 3001.
                Then reopen this dialog.
              </p>
            </div>
          )}

          {phase === 'review' && rows.length === 0 && (
            <div className="text-center py-12">
              <p className="text-slate-500">No open positions found in your Tiger account.</p>
            </div>
          )}

          {phase === 'review' && rows.length > 0 && (
            <div className="space-y-3">
              {/* Select all bar */}
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox"
                    checked={rows.filter(r => r.duplicates.length === 0).every(r => r.selected)}
                    onChange={e => toggleAll(e.target.checked)}
                    className="w-4 h-4 accent-purple-600" />
                  <span className="text-slate-600 font-medium">Select all non-duplicates</span>
                </label>
                <span className="text-slate-400">{selectedCount} of {rows.length} selected</span>
                {duplicateCount > 0 && (
                  <span className="text-amber-600 font-semibold">⚠ {duplicateCount} possible duplicate{duplicateCount > 1 ? 's' : ''}</span>
                )}
              </div>

              {/* Review table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 border-b border-slate-200">
                    <tr>
                      {['', 'Symbol', 'Type', 'Qty', 'Avg Cost', 'Market Value', 'Unrealised', 'Category', 'Campaign', 'Notes'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const hasDup = row.duplicates.length > 0;
                      return (
                        <React.Fragment key={row._id}>
                          <tr className={`border-b border-slate-100 ${hasDup ? 'bg-amber-50' : row.selected ? 'bg-white' : 'bg-slate-50 opacity-60'}`}>
                            {/* Checkbox */}
                            <td className="px-3 py-2.5 text-center">
                              <input type="checkbox" checked={row.selected}
                                onChange={e => updRow(row._id, { selected: e.target.checked })}
                                className="w-4 h-4 accent-purple-600" />
                            </td>
                            <td className="px-3 py-2.5 font-bold text-slate-900">{row.symbol}</td>
                            <td className="px-3 py-2.5 text-slate-500 text-xs">{row.secType}</td>
                            <td className="px-3 py-2.5 text-slate-700">{row.quantity}</td>
                            <td className="px-3 py-2.5 text-slate-700">${row.averageCost.toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-slate-700">${row.marketValue.toLocaleString()}</td>
                            <td className={`px-3 py-2.5 font-semibold text-xs ${(row.unrealizedPnl || 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                              {(row.unrealizedPnl || 0) >= 0 ? '+' : ''}${(row.unrealizedPnl || 0).toFixed(0)}
                            </td>
                            {/* Category */}
                            <td className="px-3 py-2.5">
                              <select value={row.category}
                                onChange={e => updRow(row._id, { category: e.target.value })}
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs bg-white focus:ring-1 focus:ring-purple-500">
                                {catOptions.map(o => <option key={o}>{o}</option>)}
                              </select>
                            </td>
                            {/* Campaign */}
                            <td className="px-3 py-2.5">
                              <select value={row.campaignId}
                                onChange={e => updRow(row._id, { campaignId: e.target.value })}
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs bg-white focus:ring-1 focus:ring-purple-500">
                                {campOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                              </select>
                            </td>
                            {/* Notes */}
                            <td className="px-3 py-2.5">
                              <input value={row.notes} onChange={e => updRow(row._id, { notes: e.target.value })}
                                placeholder="Trade context…"
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-purple-500" />
                            </td>
                          </tr>
                          {/* Duplicate warning row */}
                          {hasDup && (
                            <tr className="bg-amber-50 border-b border-amber-100">
                              <td colSpan={10} className="px-4 py-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs text-amber-700 font-semibold">
                                    ⚠ Possible duplicate — matches existing: {row.duplicates.map(d => `${d.symbol} ${d.category}`).join(', ')}
                                  </span>
                                  <div className="flex gap-2">
                                    <button onClick={() => updRow(row._id, { selected: false })}
                                      className="text-xs px-2 py-1 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">Skip</button>
                                    <button onClick={() => updRow(row._id, { selected: true, skipDuplicate: true })}
                                      className="text-xs px-2 py-1 bg-amber-500 text-white rounded hover:bg-amber-600">Import Anyway</button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {phase === 'success' && result && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">✅</div>
              <h3 className="text-xl font-bold text-slate-900">Imported {result.total} position{result.total !== 1 ? 's' : ''}</h3>
              <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 w-72 space-y-1.5">
                {Object.entries(result.grouped).map(([sym, count]) => (
                  <div key={sym} className="flex justify-between text-sm">
                    <span className="font-semibold text-slate-900">{sym}</span>
                    <span className="text-slate-500">{count} position{count > 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 text-center max-w-sm">
                Review campaign assignments in the Positions page before tracking wheel performance.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between shrink-0">
          {phase === 'review' && (
            <>
              <p className="text-xs text-slate-500">
                {selectedCount} position{selectedCount !== 1 ? 's' : ''} will be imported as OPEN with status = Open.
              </p>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                <button onClick={handleImport} disabled={selectedCount === 0}
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Import {selectedCount > 0 ? `${selectedCount} Selected` : ''}
                </button>
              </div>
            </>
          )}
          {(phase === 'success' || phase === 'error') && (
            <div className="w-full flex justify-end">
              <button onClick={onClose}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
                style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                {phase === 'success' ? 'View Positions' : 'Close'}
              </button>
            </div>
          )}
          {phase === 'loading' && <div />}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CLOSE POSITION MODAL
// ============================================================================

function ClosePositionModal({ position, onClose }) {
  const closePosition = useWheelStore(s => s.closePosition);
  const cat      = position.category;
  const isOption = isOptCat(cat);
  const isShares = cat === 'Long Shares';
  const isCash   = cat === 'Cash';
  const cfg      = POSITION_CATEGORIES[cat] || {};

  const remainingQty = position.remainingQuantity ?? (isShares ? position.shareCount : position.contracts) ?? 1;
  const [form, setForm] = useState({
    buybackCost: '', salePrice: '', shares: String(position.shareCount || ''),
    quantity: String(remainingQty),
    fees: '', exchangeFees: '', gst: '', notes: '',
    action: isOption ? 'Buy to Close' : '',
    reason: isShares ? 'Called Away (CC)' : isCash ? 'Capital Deployed' : '',
  });
  const [error, setError] = useState('');
  const upd = (f, v) => { setForm(p => ({ ...p, [f]: v })); if (error) setError(''); };

  const closeQty = isOption ? (Number(form.quantity) || remainingQty) : (Number(form.shares) || position.shareCount || 0);
  const isPartial = isOption && closeQty < remainingQty;

  let realizedPnL = 0, pnlBase = 0;
  if (isOption) {
    const buybackTotal   = (Number(form.buybackCost) || 0) * closeQty * 100;
    const premiumPortion = (position.premium || 0) * (closeQty / (position.contracts || 1));
    realizedPnL = premiumPortion - buybackTotal - (Number(form.fees) || 0);
    pnlBase     = premiumPortion;
  } else if (isShares) {
    const sh   = closeQty;
    const gain = ((Number(form.salePrice) || 0) - effectiveCostBasis(position)) * sh;
    realizedPnL = gain - (Number(form.fees) || 0);
    pnlBase     = effectiveCostBasis(position) * sh;
  }
  const realizedPct = pnlBase > 0 ? ((realizedPnL / pnlBase) * 100).toFixed(1) : null;

  const handleClose = () => {
    if (isOption && (form.buybackCost === '' || isNaN(Number(form.buybackCost)))) { setError('Buyback cost required (enter 0 if expiring worthless)'); return; }
    if (isShares && (!form.salePrice || isNaN(Number(form.salePrice)))) { setError('Sale price required'); return; }
    if (isOption && (!form.quantity || Number(form.quantity) <= 0 || Number(form.quantity) > remainingQty)) { setError(`Quantity must be between 1 and ${remainingQty}`); return; }
    closePosition(position.id, {
      buybackCost: Number(form.buybackCost) || 0, salePrice: Number(form.salePrice) || 0,
      shares: Number(form.shares) || position.shareCount || 0,
      quantity: isOption ? Number(form.quantity) : undefined,
      fees: Number(form.fees) || 0, exchangeFees: Number(form.exchangeFees) || 0, gst: Number(form.gst) || 0,
      notes: form.notes,
      action: isOption ? form.action : undefined,
      reason: isOption ? form.action : form.reason,
    });
    onClose();
  };

  const inp = (label, field, placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type="number" step="0.01" min="0" value={form[field]} onChange={e => upd(field, e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Close Position</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {cat}</span>
              <span className="text-xs text-slate-500">
                {isOption ? `${position.symbol} $${position.strike} · $${position.premium} collected` :
                 isShares ? `${position.symbol} ${position.shareCount} shares @ $${position.purchasePrice}` :
                 `${position.symbol} $${position.capitalAmount} reserved`}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          {isOption && <>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Action</label>
              <select value={form.action} onChange={e => upd('action', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
                {['Buy to Close', 'Assignment', 'Exercise', 'Expired'].map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {inp('Buyback Cost per Contract ($)', 'buybackCost', 'e.g. 0.50')}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                  Quantity to Close <span className="text-blue-500 normal-case">of {remainingQty}</span>
                </label>
                <input type="number" step="1" min="1" max={remainingQty} value={form.quantity} onChange={e => upd('quantity', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
            </div>
            <p className="text-xs text-slate-400 -mt-2">Enter 0 buyback if expiring worthless. {isPartial && <span className="text-amber-600 font-semibold">Closing fewer than {remainingQty} leaves this position Partial.</span>}</p>
            <div className="grid grid-cols-3 gap-3">
              {inp('Fees (optional)', 'fees', 'e.g. 1.30')}
              {inp('Exchange Fees (optional)', 'exchangeFees', 'e.g. 0.50')}
              {inp('GST (optional)', 'gst', 'e.g. 0.10')}
            </div>
          </>}

          {isShares && <>
            <div className="grid grid-cols-2 gap-3">
              {inp('Sale Price per Share ($)', 'salePrice', `e.g. ${position.purchasePrice}`)}
              {inp('Shares', 'shares', `${position.shareCount}`)}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {inp('Fees (optional)', 'fees', 'e.g. 2.50')}
              {inp('Exchange Fees (optional)', 'exchangeFees', 'e.g. 0.50')}
              {inp('GST (optional)', 'gst', 'e.g. 0.10')}
            </div>
          </>}

          {isCash && (
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 text-sm space-y-1.5">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Position Summary</p>
              <div className="flex justify-between">
                <span className="text-slate-600">Capital Reserved</span>
                <span className="font-semibold text-slate-900">${(position.capitalAmount || 0).toLocaleString()}</span>
              </div>
              {position.shareCount && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Shares</span>
                  <span className="font-semibold text-slate-900">{position.shareCount}</span>
                </div>
              )}
              {position.targetPrice && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Actual Buy Price</span>
                  <span className="font-semibold text-slate-900">${position.targetPrice}/sh</span>
                </div>
              )}
              {position.commission > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Commission Paid</span>
                  <span className="font-semibold text-red-600">−${position.commission}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-300">
                <span className="font-bold text-slate-900">Realized P&L (this position)</span>
                <span className="font-bold text-slate-500">$0.00</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">Cash positions record capital deployment. P&L is tracked on the associated option or share trade.</p>
            </div>
          )}

          {!isOption && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Reason for Closure</label>
              <select value={form.reason} onChange={e => upd('reason', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
                {(isShares
                  ? ['Called Away (CC)', 'Sold for Profit', 'Stop Loss', 'Portfolio Rebalance', 'Other']
                  : ['Capital Deployed → Short Put', 'Deployed → Short Call', 'Capital Released', 'Other']
                ).map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}

          {isOption && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes (optional)</label>
              <textarea value={form.notes} onChange={e => upd('notes', e.target.value)} rows={2}
                placeholder="e.g. hit profit target, stopped out, IV crush..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
            </div>
          )}

          {(isOption || isShares) && (
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 text-sm space-y-1.5">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Realized P&L Preview</p>
              {isOption && <>
                <div className="flex justify-between">
                  <span className="text-slate-600">Premium ({closeQty}/{position.contracts}× contracts)</span>
                  <span className="font-semibold text-green-700">+${((position.premium || 0) * (closeQty / (position.contracts || 1))).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Buyback Cost ({closeQty}× × ${Number(form.buybackCost)||0} × 100)</span>
                  <span className="font-semibold text-red-600">-${((Number(form.buybackCost)||0)*closeQty*100).toFixed(0)}</span>
                </div>
                {isPartial && (
                  <p className="text-xs text-amber-600 font-semibold pt-1">⚠ Partial close — {remainingQty - closeQty} contract{remainingQty - closeQty !== 1 ? 's' : ''} will remain open.</p>
                )}
              </>}
              {isShares && <>
                <div className="flex justify-between">
                  <span className="text-slate-600">Sale ({form.shares||position.shareCount} sh × ${Number(form.salePrice)||0})</span>
                  <span className="font-semibold text-green-700">+${((Number(form.salePrice)||0)*(Number(form.shares)||position.shareCount||0)).toFixed(0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Cost ({form.shares||position.shareCount} sh × ${effectiveCostBasis(position)})</span>
                  <span className="font-semibold text-red-600">-${(effectiveCostBasis(position)*(Number(form.shares)||position.shareCount||0)).toFixed(0)}</span>
                </div>
              </>}
              {Number(form.fees) > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Fees</span>
                  <span className="font-semibold text-red-600">-${Number(form.fees)}</span>
                </div>
              )}
              {(Number(form.exchangeFees) > 0 || Number(form.gst) > 0) && (
                <div className="flex justify-between text-xs text-slate-400">
                  <span>Exchange Fees / GST (tracked on ledger, not deducted from P&L)</span>
                  <span>${(Number(form.exchangeFees) || 0).toFixed(2)} / ${(Number(form.gst) || 0).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-300">
                <span className="font-bold text-slate-900">Realized P&L</span>
                <span className={`font-bold text-lg ${realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {realizedPnL >= 0 ? '+' : ''}${realizedPnL.toFixed(0)}
                  {realizedPct !== null && ` (${Number(realizedPct) >= 0 ? '+' : ''}${realizedPct}%)`}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleClose}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-red-600 hover:bg-red-700 transition">
            ✓ Close Position
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CAMPAIGNS PANEL
// ============================================================================

// DTE = expiry − entry date in calendar days. Handles YYYY-MM-DD and human-readable formats.
export function calcDTE(entryDate, expiry) {
  if (!entryDate || !expiry) return null;
  const parse = s => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return new Date(String(s) + 'T00:00:00');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const e = parse(entryDate);
  const x = parse(expiry);
  if (!e || !x) return null;
  return Math.max(0, Math.round((x - e) / 86400000));
}

// Effective cost basis per share.
// avgPricePerShare (set when multiple lots are averaged) takes priority over purchasePrice.
// Use this everywhere share cost basis is required so all tabs stay in sync.
export const effectiveCostBasis = (p) => p.avgPricePerShare || p.purchasePrice || 0;

// Break-even price per share — computed on demand, never stored, since it's
// fully derivable from existing fields (mirrors effectiveCostBasis's pattern).
export function breakEvenPrice(p) {
  const premiumPerShare = (p.premium || 0) / ((p.contracts || 1) * 100);
  switch (p.category) {
    case 'Short Put':
    case 'Naked Put':    return (p.strike || 0) - premiumPerShare;
    case 'Naked Call':   return (p.strike || 0) + premiumPerShare;
    case 'Covered Call': return effectiveCostBasis(p) - premiumPerShare;
    case 'Long Shares':  return effectiveCostBasis(p);
    default:             return null; // Cash has no break-even
  }
}

// Derives a campaign's overall status from its positions. Single source of
// truth — both CampaignsPanel and JournalEntry call this instead of each
// keeping their own copy of the same if/else chain.
function deriveCampaignStatus(positions) {
  const openOpts  = positions.filter(p => p.status === 'OPEN' && isOptCat(p.category));
  const openSh    = positions.filter(p => p.status === 'OPEN' && p.category === 'Long Shares');
  const openCount = positions.filter(p => p.status === 'OPEN').length;
  if (openOpts.some(p => p.category === 'Covered Call')) return 'Active — Covered Call';
  if (openSh.length > 0)                                 return 'Active — Holding Shares';
  if (openOpts.some(p => p.category === 'Short Put'))    return 'Active — Short Put';
  if (openCount > 0)                                     return 'Active';
  return 'Closed';
}

// Win rate across closed option positions — generalized so the Dashboard
// and JournalEntry both call the same logic instead of duplicating it.
function calcWinRate(positions) {
  const closedOpts = positions.filter(p => p.status === 'CLOSED' && isOptCat(p.category));
  if (!closedOpts.length) return null;
  const wins = closedOpts.filter(p => (p.closedData?.realizedPnL || 0) > 0).length;
  return Math.round((wins / closedOpts.length) * 100);
}

// Campaign profit helper — returns all metrics including commissions as a separate line.
// Commission is NEVER mixed into netPremium or realizedPnL — it is a pure drag metric.
function calcCampaignProfit(positions) {
  const isOption = p => isOptCat(p.category);
  const isShares = p => p.category === 'Long Shares';
  const isCash   = p => p.category === 'Cash';

  const netPremium        = positions.filter(isOption).reduce((s, p) => s + (p.premium || 0), 0);
  // Realized P&L includes both fully-closed positions and the accumulated
  // running total from positions that are only Partially closed so far.
  const realizedPnL       = positions.filter(p => p.status === 'CLOSED').reduce((s, p) => s + (p.closedData?.realizedPnL || 0), 0)
    + positions.filter(p => p.lifecycleStatus === 'Partial').reduce((s, p) => s + (p.partialRealizedPnL || 0), 0);
  const unrealizedPremium = positions.filter(p => p.status === 'OPEN' && isOption(p))
    .reduce((s, p) => s + (p.premium || 0) - (p.currentValue || 0), 0);
  const unrealizedShares  = positions.filter(p => p.status === 'OPEN' && isShares(p))
    .reduce((s, p) => s + ((p.currentSharePrice || effectiveCostBasis(p)) - effectiveCostBasis(p)) * (p.shareCount || 0), 0);
  const cashReserved      = positions.filter(p => p.status === 'OPEN' && isCash(p))
    .reduce((s, p) => s + (p.capitalAmount || 0), 0);
  // Commission — tracked separately across ALL position types, never subtracted from premium/P&L
  const totalCommissions  = positions.reduce((s, p) => s + (p.commission || 0), 0);

  // ── Campaign Analytics additions ──────────────────────────────────────
  const totalFees             = positions.reduce((s, p) => s + (p.closedData?.fees || 0), 0);
  const numberOfRolls         = positions.filter(p => p.lifecycleStatus === 'Rolled').length;
  const callsAssigned         = positions.filter(p => isCallCat(p.category) && p.lifecycleStatus === 'Assigned').length;
  const callsExpiredWorthless = positions.filter(p => isCallCat(p.category) && p.lifecycleStatus === 'Expired').length;
  const openShares            = positions.filter(p => p.status === 'OPEN' && p.category === 'Long Shares');
  const totalOpenShares       = openShares.reduce((s, p) => s + (p.shareCount || 0), 0);
  const currentCostBasis      = totalOpenShares > 0
    ? openShares.reduce((s, p) => s + effectiveCostBasis(p) * (p.shareCount || 0), 0) / totalOpenShares
    : null;
  const roi = netPremium > 0 ? (realizedPnL / netPremium) * 100 : null;

  return {
    netPremium, realizedPnL, unrealizedPremium, unrealizedShares, cashReserved, totalCommissions,
    totalFees, numberOfRolls, callsAssigned, callsExpiredWorthless, currentCostBasis, roi,
  };
}

// Campaign timeline — positions ordered by entryDate
function CampaignTimeline({ campaign, positions }) {
  const sorted = [...positions]
    .filter(p => p.campaignId === campaign.id)
    .sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

  if (sorted.length === 0) return (
    <p className="text-xs text-slate-400 italic px-4 py-2">No positions in this campaign yet.</p>
  );

  return (
    <div className="relative pl-6 space-y-1 py-1">
      <div className="absolute left-2 top-0 bottom-0 w-0.5 bg-slate-200" />
      {sorted.map((pos, idx) => {
        const prev     = sorted[idx - 1];
        const gapDays  = prev ? Math.round((new Date(pos.entryDate) - new Date(prev.entryDate)) / 86400000) : null;
        const cfg      = POSITION_CATEGORIES[pos.category] || {};
        const isClosed = pos.status === 'CLOSED';
        return (
          <div key={pos.id}>
            {gapDays > 1 && (
              <div className="flex items-center gap-2 py-1 pl-3">
                <div className="absolute left-[5px] w-3 h-0.5 bg-dashed border-t-2 border-dashed border-slate-300" />
                <span className="text-xs text-slate-400 italic ml-2">{gapDays}d gap</span>
              </div>
            )}
            <div className={`relative flex items-start gap-3 py-2 ${isClosed ? 'opacity-60' : ''}`}>
              <div className={`absolute -left-4 w-3 h-3 rounded-full border-2 border-white mt-0.5 ${isClosed ? 'bg-slate-400' : cfg.dot || 'bg-slate-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {pos.category}</span>
                  {pos.category === 'Short Put' || pos.category === 'Covered Call'
                    ? <span className="text-xs text-slate-700">${pos.strike} strike · ${pos.premium} premium</span>
                    : pos.category === 'Long Shares'
                      ? <span className="text-xs text-slate-700">{pos.shareCount} sh @ ${pos.purchasePrice}</span>
                      : <span className="text-xs text-slate-700">${pos.capitalAmount} reserved</span>}
                  <span className={`text-xs px-1 rounded ${isClosed ? 'bg-slate-100 text-slate-500' : 'bg-green-100 text-green-700'}`}>
                    {isClosed ? `✓ ${pos.closedData?.reason || 'Closed'}` : 'OPEN'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{pos.entryDate}{isClosed ? ` → ${pos.closedData?.closedDate}` : ''}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CampaignsPanel({ positions, activeCampaignId, onSelectCampaign }) {
  const campaigns          = useWheelStore(s => s.campaigns);
  const addCampaign        = useWheelStore(s => s.addCampaign);
  const updateCampaign     = useWheelStore(s => s.updateCampaign);
  const deleteCampaignById = useWheelStore(s => s.deleteCampaignById);
  const addJournalEntry    = useWheelStore(s => s.addJournalEntry);
  const navigate           = useNavigate();
  const [showNew,        setShowNew]        = useState(false);
  const [newName,        setNewName]        = useState('');
  const [newSymbol,      setNewSymbol]      = useState('');
  const [expandedId,     setExpandedId]     = useState(null);
  const [editingId,      setEditingId]      = useState(null);
  const [editDraft,      setEditDraft]      = useState('');
  const [notesDrafts,    setNotesDrafts]    = useState({}); // campaignId → draft string

  const createJournalEntry = (camp, cPos, profit) => {
    const openPos   = cPos.filter(p => p.status === 'OPEN');
    const closedPos = cPos.filter(p => p.status === 'CLOSED');

    // Link to best position so the journal can resolve campaign via positionId → campaignId
    const linkedPos =
      openPos.find(p => p.category === 'Short Put' || p.category === 'Covered Call') ||
      openPos[0] ||
      [...cPos].sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || ''))[0] ||
      null;

    // Infer strategy tag from position mix
    const cats = new Set(cPos.map(p => p.category));
    let strategyTag = 'custom';
    if (cats.has('Short Put') && (cats.has('Covered Call') || cats.has('Long Shares'))) strategyTag = 'wheel';
    else if (cats.has('Covered Call')) strategyTag = 'covered-call';
    else if (cats.has('Short Put'))    strategyTag = 'short-put';

    // Auto-populate thesis with live campaign snapshot
    const summaryParts = [];
    if (openPos.length > 0)       summaryParts.push(`${openPos.length} open position${openPos.length > 1 ? 's' : ''}`);
    if (closedPos.length > 0)     summaryParts.push(`${closedPos.length} closed`);
    if (profit.netPremium > 0)    summaryParts.push(`$${profit.netPremium} premium collected`);
    if (profit.realizedPnL !== 0) summaryParts.push(`${profit.realizedPnL >= 0 ? '+' : ''}$${profit.realizedPnL.toFixed(0)} realized P&L`);

    addJournalEntry({
      id:          Date.now(),
      date:        new Date().toISOString().split('T')[0],
      symbol:      camp.symbol,
      trade:       camp.name,
      result:      'Pending',
      tags:        [strategyTag],
      positionId:  linkedPos?.id || null,
      tradeThesis: {
        reason:          summaryParts.join(' · '),
        support:         '',
        target:          '',
        happyAssignment: true,
      },
      simulatorRec: null,
      myDecision:   { action: '', reasoning: '', decidedDate: '' },
      outcome:      { completedDate: '', action: '', finalProfit: null, lesson: '' },
    });

    navigate('/journal');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wide">Campaigns</h2>
        <button onClick={() => setShowNew(v => !v)}
          className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition">+ New</button>
      </div>

      {showNew && (
        <div className="flex gap-2 items-end">
          <input value={newSymbol} onChange={e => setNewSymbol(e.target.value.toUpperCase())} placeholder="Symbol"
            className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Campaign name"
            className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          <button onClick={() => {
            if (newSymbol && newName) { addCampaign({ symbol: newSymbol, name: newName, notes: '' }); setShowNew(false); setNewName(''); setNewSymbol(''); }
          }} className="px-3 py-1.5 text-xs font-semibold text-white rounded"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>Add</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        {campaigns.map(camp => {
          const cPos   = positions.filter(p => p.campaignId === camp.id);
          const profit = calcCampaignProfit(cPos);
          const isActive   = activeCampaignId === camp.id;
          const isExpanded = expandedId === camp.id;
          const totalReturn = profit.realizedPnL + profit.unrealizedPremium + profit.unrealizedShares;

          return (
            <div key={camp.id} className={`border rounded-xl transition ${isActive ? 'border-purple-400' : 'border-slate-200'}`}>
              {/* Campaign header */}
              <div className="flex items-start justify-between p-3 cursor-pointer hover:bg-slate-50 rounded-xl"
                onClick={() => { onSelectCampaign(isActive ? null : camp.id); setExpandedId(isExpanded ? null : camp.id); }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {editingId === camp.id ? (
                      <>
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={e => setEditDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && editDraft.trim()) {
                              updateCampaign(camp.id, { name: editDraft.trim() });
                              setEditingId(null);
                            }
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          onClick={e => e.stopPropagation()}
                          className="text-sm font-bold text-slate-900 border border-purple-400 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-purple-400 w-40"
                        />
                        <button
                          onClick={e => { e.stopPropagation(); if (editDraft.trim()) { updateCampaign(camp.id, { name: editDraft.trim() }); } setEditingId(null); }}
                          className="text-xs font-semibold text-white bg-purple-500 hover:bg-purple-600 rounded px-2 py-0.5 transition">
                          Save
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setEditingId(null); }}
                          className="text-xs text-slate-500 hover:text-slate-700">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-bold text-slate-900 truncate">{camp.name}</p>
                        <button
                          onClick={e => { e.stopPropagation(); setEditingId(camp.id); setEditDraft(camp.name); }}
                          className="text-slate-400 hover:text-purple-600 rounded p-0.5 transition flex-shrink-0"
                          title="Rename campaign">
                          ✏️
                        </button>
                      </>
                    )}
                    <span className="text-xs text-slate-400">{cPos.filter(p => p.status === 'OPEN').length} open · {cPos.filter(p => p.status === 'CLOSED').length} closed</span>
                  </div>
                  {/* Profit strip */}
                  <div className="flex gap-3 mt-1.5 flex-wrap text-xs">
                    {profit.netPremium > 0 && <span className="text-slate-600">Premium: <strong>${profit.netPremium}</strong></span>}
                    {profit.realizedPnL !== 0 && <span className={profit.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}>Realized: <strong>{profit.realizedPnL >= 0 ? '+' : ''}${profit.realizedPnL.toFixed(0)}</strong></span>}
                    {profit.unrealizedPremium !== 0 && <span className="text-blue-600">Unreal. Premium: <strong>{profit.unrealizedPremium >= 0 ? '+' : ''}${profit.unrealizedPremium.toFixed(0)}</strong></span>}
                    {profit.unrealizedShares !== 0 && <span className={profit.unrealizedShares >= 0 ? 'text-green-600' : 'text-orange-600'}>Share Δ: <strong>{profit.unrealizedShares >= 0 ? '+' : ''}${profit.unrealizedShares.toFixed(0)}</strong></span>}
                    {profit.cashReserved > 0 && <span className="text-yellow-700">Cash: <strong>${profit.cashReserved.toLocaleString()}</strong></span>}
                  </div>
                </div>
                <div className="text-right ml-3 flex flex-col items-end gap-1">
                  <p className={`text-base font-bold ${totalReturn >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(0)}
                  </p>
                  <p className="text-xs text-slate-400">total</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{isExpanded ? '▲' : '▼'}</span>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${camp.name}"? This does not delete positions — only the campaign record.`)) {
                          deleteCampaignById(camp.id);
                        }
                      }}
                      className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded p-0.5 transition"
                      title="Delete campaign">
                      🗑
                    </button>
                  </div>
                </div>
              </div>
              {/* Timeline + Notes + Closed Trade Summary + Create Journal */}
              {isExpanded && (
                <div className="border-t border-slate-100 px-3 py-3 space-y-3">

                  {/* Campaign Notes — editable */}
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Campaign Notes</p>
                    <textarea
                      value={notesDrafts[camp.id] ?? camp.notes ?? ''}
                      onChange={e => setNotesDrafts(d => ({ ...d, [camp.id]: e.target.value }))}
                      onBlur={() => {
                        const draft = notesDrafts[camp.id];
                        if (draft !== undefined && draft !== camp.notes) {
                          updateCampaign(camp.id, { notes: draft });
                        }
                      }}
                      onClick={e => e.stopPropagation()}
                      placeholder="Add campaign notes, strategy observations, or reminders…"
                      rows={2}
                      className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs resize-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400 bg-white" />
                  </div>

                  {/* Campaign Analytics */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Campaign Analytics</p>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        deriveCampaignStatus(cPos).startsWith('Active') ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                      }`}>{deriveCampaignStatus(cPos)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Total Premium</p>
                        <p className="font-bold text-slate-800">${profit.netPremium.toLocaleString()}</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Total Fees</p>
                        <p className="font-bold text-red-600">-${(profit.totalFees + profit.totalCommissions).toFixed(2)}</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Net Premium</p>
                        <p className="font-bold text-slate-800">${(profit.netPremium - profit.totalFees - profit.totalCommissions).toFixed(2)}</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Rolls</p>
                        <p className="font-bold text-purple-700">{profit.numberOfRolls}</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Calls Assigned</p>
                        <p className="font-bold text-blue-700">{profit.callsAssigned}</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Expired Worthless</p>
                        <p className="font-bold text-slate-600">{profit.callsExpiredWorthless}</p>
                      </div>
                      {profit.currentCostBasis != null && (
                        <div className="bg-slate-50 rounded-lg p-2">
                          <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Cost Basis</p>
                          <p className="font-bold text-slate-800">${profit.currentCostBasis.toFixed(2)}</p>
                        </div>
                      )}
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Realized P/L</p>
                        <p className={`font-bold ${profit.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                          {profit.realizedPnL >= 0 ? '+' : ''}${profit.realizedPnL.toFixed(0)}
                        </p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>Unrealized P/L</p>
                        <p className={`font-bold ${(profit.unrealizedPremium + profit.unrealizedShares) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                          {(profit.unrealizedPremium + profit.unrealizedShares) >= 0 ? '+' : ''}${(profit.unrealizedPremium + profit.unrealizedShares).toFixed(0)}
                        </p>
                      </div>
                      {profit.roi != null && (
                        <div className="bg-slate-50 rounded-lg p-2">
                          <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>ROI</p>
                          <p className={`font-bold ${profit.roi >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {profit.roi >= 0 ? '+' : ''}{profit.roi.toFixed(1)}%
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Per-trade closed position P&L */}
                  {cPos.filter(p => p.status === 'CLOSED' && p.closedData).length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Closed Trades — Realized P&L</p>
                      <div className="space-y-1">
                        {cPos
                          .filter(p => p.status === 'CLOSED' && p.closedData)
                          .sort((a, b) => (b.closedData?.closedDate || '').localeCompare(a.closedData?.closedDate || ''))
                          .map(p => {
                            const pnl = p.closedData?.realizedPnL ?? 0;
                            const reason = p.closedData?.reason || '';
                            return (
                              <div key={p.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-2.5 py-1.5 text-xs">
                                <div className="flex-1 min-w-0">
                                  <span className="font-semibold text-slate-700">
                                    {p.category}{p.strike ? ` $${p.strike}` : p.capitalAmount ? ` $${p.capitalAmount}` : ''}
                                  </span>
                                  {reason && (
                                    <span className="ml-2 text-slate-400 truncate">· {reason}</span>
                                  )}
                                  {p.closedData?.closedDate && (
                                    <span className="ml-2 text-slate-400">{p.closedData.closedDate}</span>
                                  )}
                                </div>
                                <span className={`ml-2 font-bold flex-shrink-0 ${pnl >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
                                </span>
                              </div>
                            );
                          })}
                        <div className="flex justify-between px-2.5 pt-1 border-t border-slate-200 text-xs">
                          <span className="font-bold text-slate-600">Total Realized</span>
                          <span className={`font-bold ${profit.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {profit.realizedPnL >= 0 ? '+' : ''}${profit.realizedPnL.toFixed(0)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  <CampaignTimeline campaign={camp} positions={positions} />

                  <div className="pt-1 border-t border-slate-100">
                    <button
                      onClick={e => { e.stopPropagation(); createJournalEntry(camp, cPos, profit); }}
                      className="w-full py-2 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition">
                      📝 Create Journal Entry
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Add Position Modal — category-aware
function AddPositionModal({ onClose }) {
  const addPosition = useWheelStore(s => s.addPosition);
  const campaigns   = useWheelStore(s => s.campaigns);
  const [category, setCategory] = useState('Short Put');
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id || '');
  const [form, setForm] = useState({
    symbol: '', entryDate: new Date().toISOString().split('T')[0],
    commission: '',
    // options
    strike: '', expiry: '', dte: '', premium: '', contracts: '1',
    exchangeFees: '', gst: '', underlyingPriceAtEntry: '', sharesCovered: '', exitPlan: '', tradeTags: '',
    // shares
    shareCount: '', purchasePrice: '',
    // cash
    capitalAmount: '', targetPrice: '', intent: '',
    notes: '',
  });
  const [error, setError] = useState('');
  const upd = (f, v) => { setForm(p => ({ ...p, [f]: v })); if (error) setError(''); };
  const isOption = isOptCat(category);
  const isShares = category === 'Long Shares';
  const isCash   = category === 'Cash';

  const handleAdd = () => {
    if (!form.symbol.trim()) { setError('Symbol required'); return; }
    if (isOption && (!form.strike || !form.premium)) { setError('Strike and premium required'); return; }
    if (isShares && (!form.shareCount || !form.purchasePrice)) { setError('Share count and purchase price required'); return; }
    if (isCash && !form.capitalAmount) { setError('Capital amount required'); return; }
    addPosition({
      symbol: form.symbol.trim().toUpperCase(),
      category, campaignId: campaignId || null,
      entryDate: form.entryDate, notes: form.notes,
      commission: Number(form.commission) || 0,
      ...(isOption ? {
        strike: Number(form.strike), expiry: form.expiry, dte: Number(form.dte) || null,
        premium: Number(form.premium), currentValue: Number(form.premium),
        contracts: Number(form.contracts) || 1,
        exchangeFees: Number(form.exchangeFees) || 0, gst: Number(form.gst) || 0,
        underlyingPriceAtEntry: form.underlyingPriceAtEntry ? Number(form.underlyingPriceAtEntry) : null,
        sharesCovered: category === 'Covered Call'
          ? (form.sharesCovered ? Number(form.sharesCovered) : (Number(form.contracts) || 1) * 100)
          : null,
        exitPlan: form.exitPlan || '',
        tradeTags: form.tradeTags ? form.tradeTags.split(',').map(t => t.trim()).filter(Boolean) : [],
      } : {}),
      ...(isShares ? {
        shareCount:        Number(form.shareCount),
        purchasePrice:     Number(form.purchasePrice),
        currentSharePrice: Number(form.purchasePrice),
        avgPricePerShare:  form.avgPricePerShare ? Number(form.avgPricePerShare) : null,
      } : {}),
      ...(isCash ? {
        capitalAmount: Number(form.capitalAmount), targetPrice: Number(form.targetPrice) || null,
        intent: form.intent,
      } : {}),
    });
    onClose();
  };

  const cfg = POSITION_CATEGORIES[category] || {};
  const inp = (label, field, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type={type} step={type === 'number' ? 'any' : undefined} value={form[field]}
        onChange={e => upd(field, e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Add Position</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Category</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.keys(POSITION_CATEGORIES).map(cat => {
                const c = POSITION_CATEGORIES[cat];
                const isNaked = cat === 'Naked Call' || cat === 'Naked Put';
                return (
                  <button key={cat} onClick={() => setCategory(cat)}
                    className={`p-2.5 rounded-xl border-2 text-left transition ${category === cat ? `border-purple-400 ${c.bg}` : 'border-slate-200 hover:bg-slate-50'}`}>
                    <span className={`text-xs font-bold ${category === cat ? c.text : 'text-slate-700'}`}>{c.icon} {cat}</span>
                    {isNaked && <span className="block text-xs font-normal text-slate-400 mt-0.5">Uncovered · high risk</span>}
                  </button>
                );
              })}
            </div>
            {(category === 'Naked Call' || category === 'Naked Put') && (
              <div className="mt-2 flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                <span className="text-orange-500 text-sm mt-0.5">⚠</span>
                <p className="text-xs text-orange-700">
                  <strong>Uncovered option</strong> — {category === 'Naked Call' ? 'unlimited upside risk if the stock rallies above strike' : 'assignment risk without reserved capital to cover purchase'}.
                  Ensure appropriate margin is maintained with your broker.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {inp('Symbol', 'symbol', 'text', 'e.g. TSLA')}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Entry Date</label>
              <input type="date" value={form.entryDate ?? ''}
                onChange={e => {
                  const val = e.target.value;
                  const computed = calcDTE(val, form.expiry);
                  upd('entryDate', val);
                  if (computed !== null) upd('dte', computed);
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
          </div>

          {/* Commission — applies to every category, tracked separately from premium/P&L */}
          <div>
            <label className="block text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1">
              Commission ($) <span className="normal-case text-slate-400 font-normal">optional</span>
            </label>
            <input type="number" step="0.01" min="0"
              value={form.commission} onChange={e => upd('commission', e.target.value)}
              placeholder="e.g. 1.30"
              className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-400 bg-amber-50" />
          </div>

          {/* Campaign */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Campaign</label>
            <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
              <option value="">No campaign</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {isOption && <>
            <div className="grid grid-cols-3 gap-2">
              {inp('Strike ($)', 'strike', 'number', 'e.g. 390')}
              {inp('Premium ($)', 'premium', 'number', 'e.g. 420')}
              {inp('Contracts', 'contracts', 'number', '1')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Expiry</label>
                <input type="date" value={form.expiry ?? ''}
                  onChange={e => {
                    const val = e.target.value;
                    const computed = calcDTE(form.entryDate, val);
                    upd('expiry', val);
                    if (computed !== null) upd('dte', computed);
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                  DTE <span className="font-normal text-blue-500 normal-case ml-1">auto-calculated</span>
                </label>
                <div className="relative">
                  <input type="number" readOnly value={form.dte ?? ''}
                    className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-blue-50 font-bold text-blue-900 cursor-default" />
                  {form.dte && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-400 pointer-events-none">days</span>}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {inp('Exchange Fees (optional)', 'exchangeFees', 'number', 'e.g. 0.50')}
              {inp('GST (optional)', 'gst', 'number', 'e.g. 0.10')}
              {inp('Underlying Price at Entry ($)', 'underlyingPriceAtEntry', 'number', 'e.g. 374.60')}
            </div>
            {category === 'Covered Call' && (
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                  Shares Covered <span className="font-normal text-slate-400 normal-case">— defaults to contracts × 100</span>
                </label>
                <input type="number" value={form.sharesCovered} onChange={e => upd('sharesCovered', e.target.value)}
                  placeholder={`${(Number(form.contracts) || 1) * 100}`}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Exit Plan (optional)</label>
              <input value={form.exitPlan} onChange={e => upd('exitPlan', e.target.value)} placeholder="e.g. Close at 50% profit or 21 DTE"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Trade Tags (optional, comma-separated)</label>
              <input value={form.tradeTags} onChange={e => upd('tradeTags', e.target.value)} placeholder="e.g. earnings-play, high-iv"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
          </>}

          {isShares && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {inp('Shares', 'shareCount', 'number', 'e.g. 100')}
                {inp('Purchase Price ($)', 'purchasePrice', 'number', 'e.g. 84.50')}
              </div>
              <div>
                <label className="block text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
                  Avg Price Per Share ($) <span className="normal-case font-normal text-slate-400">— used for all P&L calculations</span>
                </label>
                <input type="number" step="any" min="0"
                  value={form.avgPricePerShare ?? ''}
                  onChange={e => upd('avgPricePerShare', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder={`Leave blank to use Purchase Price`}
                  className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-400 bg-blue-50" />
              </div>
            </>
          )}

          {isCash && <>
            <div className="grid grid-cols-2 gap-3">
              {inp('Capital Amount ($)', 'capitalAmount', 'number', 'e.g. 39000')}
              {inp('Target Price ($)', 'targetPrice', 'number', 'e.g. 390')}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Intent</label>
              <input value={form.intent} onChange={e => upd('intent', e.target.value)} placeholder="e.g. Reserved for TSLA put assignment"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
          </>}

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes (optional)</label>
            <textarea value={form.notes} onChange={e => upd('notes', e.target.value)} rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleAdd}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
            {cfg.icon} Add {category}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// POSITIONS PAGE
// ============================================================================

function Positions() {
  const positions       = useWheelStore((state) => state.positions);
  const updatePosition  = useWheelStore((state) => state.updatePosition);
  const deletePosition  = useWheelStore((state) => state.deletePosition);
  const reopenPosition  = useWheelStore((state) => state.reopenPosition);
  const [sortBy, setSortBy] = useState('dte');
  const [filterStatus, setFilterStatus] = useState('all');
  const [editingPosition, setEditingPosition] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [journalDrawerPosition, setJournalDrawerPosition] = useState(null);
  const [historyPosition, setHistoryPosition] = useState(null);
  const [closingPosition, setClosingPosition] = useState(null);
  const [rollingPosition, setRollingPosition] = useState(null);
  const [lineagePosition, setLineagePosition] = useState(null);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [expandedClosedId, setExpandedClosedId] = useState(null);
  const [showAddModal,    setShowAddModal]    = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showPoemsImport, setShowPoemsImport] = useState(false);
  const campaigns = useWheelStore(s => s.campaigns);

  const handleExport = () => {
    const wb = XLSX.utils.book_new();

    // ── Sheet 1: All Positions ────────────────────────────────────────
    const posRows = positions.map(p => {
      const camp = campaigns.find(c => c.id === p.campaignId);
      const isOption = isOptCat(p.category);
      const isShares = p.category === 'Long Shares';
      const cd = p.closedData;

      // Unrealized P&L for open positions
      let unrealizedPnL = null;
      if (p.status === 'OPEN') {
        if (isOption) unrealizedPnL = (p.premium || 0) - (p.currentValue || 0);
        if (isShares) unrealizedPnL = ((p.currentSharePrice || effectiveCostBasis(p)) - effectiveCostBasis(p)) * (p.shareCount || 0);
      }

      return {
        Status:           p.status,
        Category:         p.category,
        Symbol:           p.symbol,
        Campaign:         camp?.name || '',
        'Entry Date':     p.entryDate || '',
        // Option fields
        Strike:           isOption ? p.strike : '',
        Expiry:           isOption ? p.expiry : '',
        DTE:              isOption ? p.dte : '',
        'Premium ($)':    isOption ? p.premium : '',
        Contracts:        isOption ? (p.contracts || 1) : '',
        // Share fields
        Shares:                isShares ? p.shareCount : '',
        'Purchase Price':      isShares ? p.purchasePrice : '',
        'Avg Price / Share':   isShares ? (p.avgPricePerShare || '') : '',
        'Effective Cost Basis': isShares ? effectiveCostBasis(p) : '',
        'Current Price':       isShares ? (p.currentSharePrice || '') : '',
        // Cash fields
        'Capital Amount': p.category === 'Cash' ? p.capitalAmount : '',
        'Target Price':   p.category === 'Cash' ? (p.targetPrice || '') : '',
        Intent:           p.category === 'Cash' ? (p.intent || '') : '',
        // P&L
        'Unrealized P&L': unrealizedPnL !== null ? parseFloat(unrealizedPnL.toFixed(2)) : '',
        'Realized P&L':   cd ? parseFloat(cd.realizedPnL.toFixed(2)) : '',
        // Close data
        'Closed Date':    cd?.closedDate || '',
        'Close Reason':   cd?.reason || '',
        'Buyback Cost':   cd?.buybackCost != null ? cd.buybackCost : '',
        'Sale Price':     cd?.salePrice != null ? cd.salePrice : '',
        'Fees':           cd?.fees != null ? cd.fees : '',
        Thesis:           p.thesis || p.intent || '',
        Notes:            p.notes || '',
      };
    });

    const ws1 = XLSX.utils.json_to_sheet(posRows);
    // Auto column widths
    ws1['!cols'] = Object.keys(posRows[0] || {}).map(k => ({ wch: Math.max(k.length + 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws1, 'Positions');

    // ── Sheet 2: Campaign Summary ─────────────────────────────────────
    const campRows = campaigns.map(camp => {
      const cPos    = positions.filter(p => p.campaignId === camp.id);
      const profit  = calcCampaignProfit(cPos);
      return {
        Campaign:           camp.name,
        Symbol:             camp.symbol,
        'Created Date':     camp.createdDate,
        Status:             camp.status,
        'Open Positions':   cPos.filter(p => p.status === 'OPEN').length,
        'Closed Positions': cPos.filter(p => p.status === 'CLOSED').length,
        'Net Premium ($)':  profit.netPremium,
        'Realized P&L ($)': parseFloat(profit.realizedPnL.toFixed(2)),
        'Unrealized Premium ($)': parseFloat(profit.unrealizedPremium.toFixed(2)),
        'Share Gain/Loss ($)':    parseFloat(profit.unrealizedShares.toFixed(2)),
        'Cash Reserved ($)':      profit.cashReserved,
        'Total Return ($)': parseFloat((profit.realizedPnL + profit.unrealizedPremium + profit.unrealizedShares).toFixed(2)),
      };
    });

    if (campRows.length > 0) {
      const ws2 = XLSX.utils.json_to_sheet(campRows);
      ws2['!cols'] = Object.keys(campRows[0]).map(k => ({ wch: Math.max(k.length + 2, 16) }));
      XLSX.utils.book_append_sheet(wb, ws2, 'Campaign Summary');
    }

    // ── Sheet 3: Closed P&L Ledger ───────────────────────────────────
    const closedRows = positions
      .filter(p => p.status === 'CLOSED' && p.closedData)
      .sort((a, b) => (b.closedData.closedDate || '').localeCompare(a.closedData.closedDate || ''))
      .map(p => {
        const cd   = p.closedData;
        const camp = campaigns.find(c => c.id === p.campaignId);
        return {
          'Closed Date':    cd.closedDate,
          Symbol:           p.symbol,
          Category:         p.category,
          Campaign:         camp?.name || '',
          'Entry Date':     p.entryDate || '',
          'Premium / Cost': p.premium || p.purchasePrice * p.shareCount || 0,
          'Buyback / Sale': cd.buybackCost != null ? cd.buybackCost : (cd.salePrice || ''),
          'Fees ($)':       cd.fees,
          'Realized P&L':   parseFloat(cd.realizedPnL.toFixed(2)),
          Reason:           cd.reason,
        };
      });

    if (closedRows.length > 0) {
      const ws3 = XLSX.utils.json_to_sheet(closedRows);
      ws3['!cols'] = Object.keys(closedRows[0]).map(k => ({ wch: Math.max(k.length + 2, 14) }));
      XLSX.utils.book_append_sheet(wb, ws3, 'Closed P&L Ledger');
    }

    const filename = `wheel-edge-positions-${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, filename);
  };

  // Apply campaign + status filters
  const baseFiltered = positions
    .filter(p => !activeCampaign || p.campaignId === activeCampaign)
    .filter(p => filterStatus === 'all' || p.status === filterStatus);

  const sorted = [...baseFiltered].sort((a, b) => {
    // OPEN always before CLOSED
    if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
    if (sortBy === 'dte')    return a.dte - b.dte;
    if (sortBy === 'profit') return b.profitPercent - a.profitPercent;
    if (sortBy === 'symbol') return a.symbol.localeCompare(b.symbol);
    return 0;
  });

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Positions
            </h1>
            <p className="text-slate-600">Cash · Short Puts · Long Shares · Covered Calls — closed manually, no automatic rolling</p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <button onClick={() => setShowImportModal(true)}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg shadow flex items-center gap-1.5"
              style={{ background: 'linear-gradient(135deg, #f97316 0%, #ef4444 100%)' }}>
              🐯 Import From Tiger
            </button>
            <button onClick={() => setShowPoemsImport(true)}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg shadow flex items-center gap-1.5"
              style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }}>
              📄 Import POEMS Contract Note
            </button>
            <button onClick={handleExport}
              className="px-4 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition">
              📥 Export Excel
            </button>
            <button onClick={() => setShowAddModal(true)}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg shadow"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
              + Add Position
            </button>
          </div>
        </div>

        {/* Campaigns panel */}
        <CampaignsPanel positions={positions} activeCampaignId={activeCampaign} onSelectCampaign={setActiveCampaign} />

        {/* Controls */}
        <div className="flex gap-3 items-center flex-wrap">
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg bg-white text-sm">
            <option value="dte">Sort: DTE</option>
            <option value="profit">Sort: Profit %</option>
            <option value="symbol">Sort: Symbol</option>
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg bg-white text-sm">
            <option value="all">All Statuses</option>
            <option value="OPEN">Open Only</option>
            <option value="CLOSED">Closed Only</option>
          </select>
          <span className="text-sm text-slate-500 ml-auto">
            {sorted.filter(p => p.status === 'OPEN').length} open · {sorted.filter(p => p.status === 'CLOSED').length} closed
          </span>
        </div>

        {/* Table */}
        <div className="border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-200">
              <tr>
                {['Status', 'Category', 'Symbol', 'Position Summary', 'P&L / Return', 'Campaign', 'Journal', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((pos, idx) => {
                const isOpen     = pos.status === 'OPEN';
                const isClosed   = pos.status === 'CLOSED';
                const cd         = pos.closedData;
                const isExpanded = expandedClosedId === pos.id;
                const cfg        = POSITION_CATEGORIES[pos.category] || {};
                const isOption   = isOptCat(pos.category);
                const isShares   = pos.category === 'Long Shares';
                const isCashCat  = pos.category === 'Cash';

                // Summary text per category
                const summary = isOption
                  ? `$${pos.strike} strike · ${pos.expiry} · ${pos.dte} DTE`
                  : isShares
                    ? `${pos.shareCount} shares @ $${effectiveCostBasis(pos)}${pos.avgPricePerShare ? ' (avg)' : ''}`
                    : `$${pos.capitalAmount?.toLocaleString()} reserved${pos.shareCount ? ` · ${pos.shareCount} sh` : ''}${pos.currentSharePrice ? ` · mkt $${pos.currentSharePrice}` : ''}${pos.targetPrice && !pos.currentSharePrice ? ` · Buy $${pos.targetPrice}` : ''}`;

                // P&L column
                let pnlDisplay = '—', pnlColor = 'text-slate-500';
                if (isClosed && cd) {
                  pnlDisplay = `${cd.realizedPnL >= 0 ? '+' : ''}$${cd.realizedPnL.toFixed(0)} realized`;
                  pnlColor   = cd.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600';
                } else if (isOption && isOpen) {
                  const unreal = (pos.premium || 0) - (pos.currentValue || 0);
                  pnlDisplay = `${unreal >= 0 ? '+' : ''}$${unreal.toFixed(0)} MTM`;
                  pnlColor   = unreal >= 0 ? 'text-green-600' : 'text-red-500';
                } else if (isShares && isOpen) {
                  const shareGain = ((pos.currentSharePrice || effectiveCostBasis(pos)) - effectiveCostBasis(pos)) * pos.shareCount;
                  pnlDisplay = `${shareGain >= 0 ? '+' : ''}$${shareGain.toFixed(0)}`;
                  pnlColor   = shareGain >= 0 ? 'text-green-600' : 'text-red-500';
                } else if (isCashCat && isOpen && pos.currentSharePrice && pos.shareCount) {
                  // Cash position with current price — show market value vs reserved capital
                  const mktVal = pos.currentSharePrice * pos.shareCount;
                  const diff   = mktVal - (pos.capitalAmount || 0);
                  pnlDisplay = `${diff >= 0 ? '+' : ''}$${diff.toFixed(0)} mkt`;
                  pnlColor   = diff >= 0 ? 'text-green-600' : 'text-red-500';
                }

                return (
                  <>
                    <tr key={pos.id} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'} ${isClosed ? 'opacity-65' : ''}`}>
                      {/* Status */}
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1 items-start">
                          <span className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-bold w-fit ${isOpen ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-green-500' : 'bg-slate-400'}`} />
                            {pos.status}
                          </span>
                          {pos.lifecycleStatus && pos.lifecycleStatus !== 'Open' && pos.lifecycleStatus !== 'Closed' && (
                            <span className={`px-1.5 py-0.5 rounded text-xs font-semibold w-fit ${
                              pos.lifecycleStatus === 'Partial'  ? 'bg-amber-100 text-amber-700'
                              : pos.lifecycleStatus === 'Assigned' ? 'bg-blue-100 text-blue-700'
                              : pos.lifecycleStatus === 'Rolled'   ? 'bg-purple-100 text-purple-700'
                              : pos.lifecycleStatus === 'Expired'  ? 'bg-slate-200 text-slate-600'
                              : 'bg-slate-100 text-slate-600'
                            }`}>
                              {pos.lifecycleStatus}
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Category */}
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cfg.bg} ${cfg.text}`}>{cfg.icon} {pos.category}</span>
                      </td>
                      <td className="px-4 py-3 font-bold text-slate-900">{pos.symbol}</td>
                      <td className="px-4 py-3 text-sm text-slate-600 max-w-xs">{summary}</td>
                      <td className={`px-4 py-3 font-semibold text-sm ${pnlColor}`}>{pnlDisplay}</td>
                      {/* Campaign */}
                      <td className="px-4 py-3 text-xs text-slate-500">{pos.campaignId || '—'}</td>
                      {/* Journal — opens drawer with direct link through to Journal tab */}
                      <td className="px-4 py-3">
                        <button onClick={() => setJournalDrawerPosition(pos)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded hover:opacity-80 transition ${
                            (pos.journalEntryIds || []).length > 0
                              ? 'text-purple-700 bg-purple-50 border border-purple-200'
                              : 'text-slate-400 bg-slate-50 border border-slate-200'
                          }`}>
                          📝
                          <span>{(pos.journalEntryIds || []).length > 0 ? `${(pos.journalEntryIds || []).length} entr${(pos.journalEntryIds || []).length === 1 ? 'y' : 'ies'}` : 'Link'}</span>
                          <span className="opacity-60">→</span>
                        </button>
                      </td>
                      {/* Actions */}
                      <td className="px-4 py-3">
                        {confirmDeleteId === pos.id ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-red-600 font-semibold">Delete?</span>
                            <button onClick={() => { deletePosition(pos.id); setConfirmDeleteId(null); }}
                              className="px-2 py-1 text-xs font-semibold bg-red-600 text-white rounded">Yes</button>
                            <button onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 text-xs font-semibold bg-slate-200 text-slate-700 rounded">No</button>
                          </div>
                        ) : isOpen ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button onClick={() => setEditingPosition(pos)}
                              className="px-2 py-1 text-xs font-semibold text-purple-700 bg-purple-100 rounded hover:bg-purple-200">✏️ Edit</button>
                            <button onClick={() => setClosingPosition(pos)}
                              className="px-2 py-1 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700">✕ Close</button>
                            {isOption && (
                              <button onClick={() => setRollingPosition(pos)}
                                className="px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded hover:bg-blue-200">🔄 Roll</button>
                            )}
                            {(pos.openedFrom != null || pos.rolledInto != null || pos.closedBy != null || pos.replacementPosition != null) && (
                              <button onClick={() => setLineagePosition(pos)}
                                className="px-2 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded hover:bg-indigo-200">🔗 Lineage</button>
                            )}
                            <button onClick={() => setConfirmDeleteId(pos.id)}
                              className="px-2 py-1 text-xs font-semibold text-red-700 bg-red-100 rounded hover:bg-red-200">🗑️</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button onClick={() => setExpandedClosedId(isExpanded ? null : pos.id)}
                              className="px-2 py-1 text-xs font-semibold text-slate-600 bg-slate-100 rounded hover:bg-slate-200">
                              {isExpanded ? '▲ Hide' : '▼ Details'}
                            </button>
                            <button onClick={() => setEditingPosition(pos)}
                              className="px-2 py-1 text-xs font-semibold text-purple-700 bg-purple-100 rounded hover:bg-purple-200">✏️ Edit</button>
                            {(pos.openedFrom != null || pos.rolledInto != null || pos.closedBy != null || pos.replacementPosition != null) && (
                              <button onClick={() => setLineagePosition(pos)}
                                className="px-2 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded hover:bg-indigo-200">🔗 Lineage</button>
                            )}
                            <button onClick={() => reopenPosition(pos.id)}
                              className="px-2 py-1 text-xs font-semibold text-green-700 bg-green-100 rounded hover:bg-green-200">↩ Reopen</button>
                            <button onClick={() => setConfirmDeleteId(pos.id)}
                              className="px-2 py-1 text-xs font-semibold text-red-700 bg-red-100 rounded hover:bg-red-200">🗑️</button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {/* Closed details row */}
                    {isClosed && isExpanded && cd && (
                      <tr key={`${pos.id}-d`} className="bg-slate-50 border-t border-slate-100">
                        <td colSpan={8} className="px-6 py-3">
                          <div className="grid grid-cols-5 gap-4 text-xs">
                            <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Closed</p><p className="font-semibold">{cd.closedDate}</p></div>
                            {cd.buybackCost != null && <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Buyback Cost</p><p className="font-semibold">${cd.buybackCost}/contract</p></div>}
                            {cd.salePrice != null && <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Sale Price</p><p className="font-semibold">${cd.salePrice}/share</p></div>}
                            <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Fees</p><p className="font-semibold">${cd.fees}</p></div>
                            <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Reason</p><p className="font-semibold">{cd.reason}</p></div>
                            <div><p className="text-slate-500 uppercase tracking-wide mb-0.5">Realized P&L</p>
                              <p className={`font-bold text-sm ${cd.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                {cd.realizedPnL >= 0 ? '+' : ''}${cd.realizedPnL.toFixed(0)}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && <AddPositionModal onClose={() => setShowAddModal(false)} />}

      {showImportModal && <ImportFromTigerModal onClose={() => setShowImportModal(false)} />}

      {showPoemsImport && <PoemsImportWizard onClose={() => setShowPoemsImport(false)} />}

      {editingPosition && (
        <EditPositionModal
          position={editingPosition}
          onSave={(updated) => updatePosition(updated.id, updated)}
          onClose={() => setEditingPosition(null)}
        />
      )}

      {closingPosition && (
        <ClosePositionModal
          position={closingPosition}
          onClose={() => setClosingPosition(null)}
        />
      )}

      {rollingPosition && (
        <RollPositionModal
          position={rollingPosition}
          onClose={() => setRollingPosition(null)}
        />
      )}

      {lineagePosition && (
        <PositionLineageTimeline
          position={lineagePosition}
          allPositions={positions}
          onClose={() => setLineagePosition(null)}
        />
      )}

      {journalDrawerPosition && (
        <PositionJournalDrawer
          position={positions.find((p) => p.id === journalDrawerPosition.id) || journalDrawerPosition}
          onClose={() => setJournalDrawerPosition(null)}
        />
      )}

      {historyPosition && (
        <StatusHistoryModal
          position={positions.find((p) => p.id === historyPosition.id) || historyPosition}
          onClose={() => setHistoryPosition(null)}
        />
      )}
    </LayoutWrapper>
  );
}

// ============================================================================
// SCENARIO SIMULATOR — BLACK-SCHOLES ENGINE
// ============================================================================

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)));
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Black-Scholes: option price + Greeks only (no assignment prob)
function calcOptionMetrics(S, K, T_days, r, iv, type) {
  const T = Math.max(T_days, 0.001) / 365;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const isPut = type === 'Put';

  const price = Math.max(0,
    isPut
      ? K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1)
      : S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2)
  ) * 100;

  return {
    price:      parseFloat(price.toFixed(2)),
    delta:      parseFloat((isPut ? -normalCDF(-d1) : normalCDF(d1)).toFixed(4)),
    gamma:      parseFloat((normalPDF(d1) / (S * iv * sqrtT) * 100).toFixed(5)),
    theta:      parseFloat(((-(S * normalPDF(d1) * iv) / (2 * sqrtT) + (isPut ? 1 : -1) * r * K * Math.exp(-r * T) * normalCDF(isPut ? -d2 : d2)) / 365 * 100).toFixed(2)),
    vega:       parseFloat((S * normalPDF(d1) * sqrtT / 100 * 100).toFixed(2)),
  };
}

// Derive the BS option type from the position category
function positionOptionType(position) {
  return isCallCat(position.category) ? 'Call' : 'Put';
}

// Mark-to-market: what it costs to close the option today
function calcMarkToMarket(position, optionPrice) {
  const premium     = position.premium;
  const costToClose = optionPrice;
  const pnl         = premium - costToClose;
  const pnlPct      = premium > 0 ? (pnl / premium) * 100 : 0;
  return {
    premiumCollected: premium,
    currentOptionValue: parseFloat(optionPrice.toFixed(2)),
    costToClose:       parseFloat(costToClose.toFixed(2)),
    unrealizedPnL:     parseFloat(pnl.toFixed(2)),
    unrealizedPnLPct:  parseFloat(pnlPct.toFixed(1)),
    isProfitable:      pnl > 0,
  };
}

// Assignment outcome: what happens if you get assigned/exercised at expiration
function calcAssignmentOutcome(position, simPrice) {
  const isCC           = isCallCat(position.category);
  const strike         = position.strike;
  const premiumPerShare = position.premium / 100;

  if (isCC) {
    // Covered Call: shares get CALLED AWAY at strike price.
    // Effective sell price per share = strike + premium/share (premium enhances the sale)
    const effectiveSellPrice  = parseFloat((strike + premiumPerShare).toFixed(2));
    // Opportunity cost: upside foregone above strike (stock rose past what you'll receive)
    const opportunityCostPerSh = parseFloat(Math.max(0, simPrice - strike).toFixed(2));
    // CC yield = premium earned relative to strike (what the call added to your sale price)
    const returnPct = parseFloat(((premiumPerShare / strike) * 100).toFixed(1));
    return {
      isCall:               true,
      strikePrice:          strike,
      premiumPerShare:      parseFloat(premiumPerShare.toFixed(2)),
      effectiveSellPrice,
      currentPrice:         simPrice,
      opportunityCostPerSh,
      opportunityCostTotal: parseFloat((opportunityCostPerSh * 100).toFixed(2)),
      returnPct,
      isAboveStrike:        simPrice > strike,
      happyOwning:          true, // being called away at a planned price is the CC target
    };
  }

  // Short Put: you get ASSIGNED shares at strike price.
  // Your effective cost basis = strike − premium/share (premium reduces what you paid)
  const costBasis       = parseFloat((strike - premiumPerShare).toFixed(2));
  const unrealizedPerSh = parseFloat((simPrice - costBasis).toFixed(2));
  const unrealizedTotal = parseFloat((unrealizedPerSh * 100).toFixed(2));
  const returnPct       = parseFloat(((unrealizedPerSh / costBasis) * 100).toFixed(1));
  return {
    isCall:            false,
    strikePrice:       strike,
    premiumPerShare:   parseFloat(premiumPerShare.toFixed(2)),
    costBasis,
    currentPrice:      simPrice,
    unrealizedPerSh,
    unrealizedTotal,
    returnPct,
    happyOwning:       simPrice >= costBasis,
  };
}

// Heuristic assignment/exercise probability
function calcAssignmentProbability(simPrice, strikePrice, dte, iv, isCall = false) {
  // Put ITM: stock BELOW strike.  Call ITM: stock ABOVE strike.
  const itmDistance = isCall
    ? simPrice - strikePrice   // positive = ITM for call
    : strikePrice - simPrice;  // positive = ITM for put
  const pctITM      = (itmDistance / strikePrice) * 100;

  let base;
  if (pctITM > 10)      base = 0.85;
  else if (pctITM > 5)  base = 0.65;
  else if (pctITM > 0)  base = 0.40;
  else                   base = 0.10;

  const dteFactor  = Math.max(0.5, 1 - dte / 365);
  const ivFactor   = Math.max(0.5, 1 - iv / 2);
  const prob       = Math.min(0.99, base * (1 + dteFactor * 0.3) * ivFactor);

  return {
    probability:  Math.round(prob * 100),
    itmDistance:  parseFloat(itmDistance.toFixed(2)),
    pctITM:       parseFloat(pctITM.toFixed(1)),
    riskLevel:    prob > 0.70 ? 'HIGH' : prob > 0.40 ? 'MEDIUM' : 'LOW',
    isITM:        itmDistance > 0,
  };
}

// Buffer: how much room between current price and cost basis
function calcBuffer(costBasis, simPrice) {
  const bufferPerShare = simPrice - costBasis;
  const bufferPct      = parseFloat(((bufferPerShare / costBasis) * 100).toFixed(1));
  return {
    bufferPerShare: parseFloat(bufferPerShare.toFixed(2)),
    bufferPct,
    isUnderwater: bufferPerShare < 0,
    status: bufferPct > 10 ? 'Comfortable'
           : bufferPct > 5  ? 'Moderate'
           : bufferPct > 0  ? 'Tight'
           :                   'Underwater',
  };
}

// Classify where price sits relative to strike
function getPositionStatus(simPrice, strike, isCall = false) {
  // Put: ITM when below strike. Call: ITM when above strike.
  const itmPct = isCall
    ? ((simPrice - strike) / strike) * 100   // positive = ITM for call
    : ((strike - simPrice) / strike) * 100;  // positive = ITM for put
  if (itmPct <= -2)    return 'OTM';
  if (itmPct <= 0)     return 'ATM_NEAR';
  if (itmPct <= 2)     return 'ITM_NEAR';
  if (itmPct <= 5)     return 'ITM_MOD';
  return 'ITM_DEEP';
}

// Matrix-based recommendation engine — returns PRIMARY + SECONDARY array
function generateSmartRecommendations(position, simPrice, simDTE, assignment, assignProb, mtm) {
  const isCC   = isCallCat(position.category);
  const buffer = (!isCC && assignment.costBasis != null) ? calcBuffer(assignment.costBasis, simPrice) : null;
  const status = getPositionStatus(simPrice, position.strike, isCC);
  const recs   = [];

  if (isCC) {
    // ── COVERED CALL ─────────────────────────────────────────────────────────
    // OTM for CC = stock BELOW strike = good (call expires worthless, keep premium)
    // ITM for CC = stock ABOVE strike = stock will be called away at strike

    if (status === 'OTM') {
      if (mtm.unrealizedPnLPct >= 70 && simDTE > 7) {
        recs.push({ action: 'Close Early — Lock Profit', confidence: 80, icon: '💰', type: 'PRIMARY', color: 'green', reasons: [
          `Captured ${mtm.unrealizedPnLPct.toFixed(0)}% of max premium — near target`,
          `Cost to buy back: $${mtm.costToClose.toFixed(2)}`,
          'Release shares, sell a new call at an updated strike',
          'Avoid overnight risk this close to max profit',
        ]});
      } else if (simDTE <= 7) {
        recs.push({ action: 'Hold to Expiration', confidence: 90, icon: '🎯', type: 'PRIMARY', color: 'green', reasons: [
          `Only ${simDTE} DTE — stock OTM, call expires worthless`,
          `Exercise probability: ${assignProb.probability}% (low)`,
          'Keep full premium collected',
          'Prepare to sell the next covered call after expiry',
        ]});
      } else {
        recs.push({ action: 'Hold & Collect Theta', confidence: 85, icon: '⏰', type: 'PRIMARY', color: 'green', reasons: [
          `${simDTE} DTE — theta decay working in your favour`,
          `Exercise probability: ${assignProb.probability}% — stock comfortably OTM`,
          mtm.isProfitable ? `Mark-to-market profit: +${mtm.unrealizedPnLPct.toFixed(0)}%` : 'Wait for further time decay',
          'Review when profit exceeds 70% or DTE < 14',
        ]});
      }
    }

    if (status === 'ATM_NEAR' || status === 'ITM_NEAR') {
      if (simDTE < 7) {
        recs.push({ action: 'Decide: Let Go or Roll Up', confidence: 75, icon: '👀', type: 'PRIMARY', color: 'orange', reasons: [
          `${simDTE} DTE — stock near strike, shares may be called away`,
          `Exercise probability: ${assignProb.probability}%`,
          `Effective sell price if called: $${assignment.effectiveSellPrice?.toFixed(2)}/sh (strike + premium)`,
          'To keep shares: buy back call now, roll to higher strike further out',
        ]});
      } else {
        recs.push({ action: 'Monitor Closely', confidence: 70, icon: '📊', type: 'PRIMARY', color: 'orange', reasons: [
          'Stock hovering near strike — shares may be called away',
          `${simDTE} days remaining`,
          `Exercise probability: ${assignProb.probability}%`,
          'Consider rolling up if you want to capture more upside',
          `Effective sell price if called: $${assignment.effectiveSellPrice?.toFixed(2)}/sh`,
        ]});
      }
    }

    if (status === 'ITM_MOD' || status === 'ITM_DEEP') {
      const deep = status === 'ITM_DEEP';
      recs.push(simDTE < 7 ? {
        action: 'Decide Now: Accept or Roll', confidence: 88, icon: '⚠️', type: 'PRIMARY', color: 'orange',
        reasons: [
          `${simDTE} DTE — stock ${assignProb.pctITM.toFixed(1)}% above strike, exercise near certain`,
          `Exercise probability: ${assignProb.probability}%`,
          `If called: effective sell price $${assignment.effectiveSellPrice?.toFixed(2)}/sh`,
          deep ? 'Significant upside foregone — accept or roll up immediately' : 'Buy back and roll up if you want to keep shares',
        ],
      } : {
        action: deep ? 'Roll Up & Out — Capture More Upside' : 'Consider Rolling Up',
        confidence: deep ? 82 : 65, icon: '🔄', type: 'PRIMARY', color: 'orange',
        reasons: [
          `Stock $${assignProb.itmDistance.toFixed(2)} above strike — upside being capped`,
          `Exercise probability: ${assignProb.probability}%`,
          'Buy back this call, sell a higher-strike call further out',
          'Collect fresh premium at the new strike',
          `Opportunity cost if called here: $${assignment.opportunityCostPerSh?.toFixed(2)}/sh foregone`,
        ],
      });
    }

    // CC secondaries
    if (status !== 'OTM') {
      recs.push({ action: 'Accept Assignment (Called Away)', confidence: 55, icon: '✅', type: 'SECONDARY', color: 'green', reasons: [
        `Effective sell price: $${assignment.effectiveSellPrice?.toFixed(2)}/sh (strike + premium)`,
        'Realize the planned exit — clean close of the position',
        'Redeploy capital into a new wheel trade',
      ]});
    }
    if (mtm.unrealizedPnLPct >= 50 && simDTE > 7) {
      recs.push({ action: 'Close Early', confidence: 50, icon: '❌', type: 'SECONDARY', color: 'orange', reasons: [
        `Cost to buy back: $${mtm.costToClose.toFixed(2)}`,
        `Locked profit: +${mtm.unrealizedPnLPct.toFixed(0)}%`,
        'Sell a new call at an updated strike',
      ]});
    }

  } else {
    // ── SHORT PUT ─────────────────────────────────────────────────────────────

    if (status === 'OTM') {
      if (mtm.isProfitable && mtm.unrealizedPnLPct >= 70 && simDTE > 7) {
        recs.push({ action: 'Consider Closing', confidence: 80, icon: '💰', type: 'PRIMARY', color: 'green', reasons: [
          `Captured ${mtm.unrealizedPnLPct.toFixed(0)}% of max profit — near target`,
          'Risk/reward no longer favorable to hold',
          `Cost to close today: $${mtm.costToClose.toFixed(2)}`,
          'Redeploy capital to a new wheel position',
        ]});
      } else if (simDTE <= 7) {
        recs.push({ action: 'Hold to Expiration', confidence: 90, icon: '🎯', type: 'PRIMARY', color: 'green', reasons: [
          `Only ${simDTE} DTE — let it expire worthless`,
          `Assignment probability: ${assignProb.probability}% (low)`,
          'Avoid commissions from early close',
          'Keep full premium collected',
        ]});
      } else {
        recs.push({ action: 'Hold & Collect Theta', confidence: 85, icon: '⏰', type: 'PRIMARY', color: 'green', reasons: [
          `${simDTE} DTE — theta decay working for you`,
          `Assignment probability only ${assignProb.probability}%`,
          mtm.isProfitable ? `Mark-to-market P&L: +${mtm.unrealizedPnLPct.toFixed(0)}%` : 'Wait for price to move further OTM',
          'Review when profit exceeds 70% or DTE < 14',
        ]});
      }
    }

    if (status === 'ATM_NEAR' || status === 'ITM_NEAR') {
      if (simDTE < 7) {
        recs.push({ action: 'Review Position', confidence: 75, icon: '👀', type: 'PRIMARY', color: 'orange', reasons: [
          `${simDTE} DTE — decision point approaching`,
          'Stock near strike, assignment risk rising',
          `Assignment probability: ${assignProb.probability}%`,
          buffer ? `Buffer: ${buffer.bufferPerShare >= 0 ? '+' : ''}$${buffer.bufferPerShare.toFixed(2)}/sh` : '',
          'Decide: accept assignment or roll now',
        ].filter(Boolean)});
      } else {
        recs.push({ action: 'Monitor Closely', confidence: 70, icon: '📊', type: 'PRIMARY', color: 'orange', reasons: [
          'Stock hovering near strike — watch daily',
          `${simDTE} days remaining`,
          `Assignment probability: ${assignProb.probability}%`,
          'Be ready to roll if price moves deeper ITM',
          buffer ? `Your buffer: ${buffer.bufferPerShare >= 0 ? '+' : ''}$${buffer.bufferPerShare.toFixed(2)}/sh` : '',
        ].filter(Boolean)});
      }
    }

    if (status === 'ITM_MOD') {
      const primary = simDTE < 7 ? {
        action: 'Decide Now', confidence: 90, icon: '⚠️', type: 'PRIMARY',
        color: buffer?.isUnderwater ? 'red' : 'orange',
        reasons: [
          `${simDTE} DTE — must decide before expiration`,
          `Assignment probability: ${assignProb.probability}%`,
          buffer ? `Buffer: ${buffer.bufferPerShare >= 0 ? '+' : ''}$${buffer.bufferPerShare.toFixed(2)}/sh (${buffer.status})` : '',
          buffer?.isUnderwater ? 'Roll immediately to avoid underwater assignment' : 'Prepare for assignment — buffer intact',
        ].filter(Boolean),
      } : buffer?.isUnderwater ? {
        action: 'Roll Out & Up', confidence: 80, icon: '🔄', type: 'PRIMARY', color: 'red',
        reasons: [
          `Underwater by ${Math.abs(buffer.bufferPct).toFixed(1)}% ($${Math.abs(buffer.bufferPerShare).toFixed(2)}/sh)`,
          'Not comfortable owning at cost basis vs current price',
          'Roll to higher strike (further OTM)',
          'Extend to 30-45 DTE — collect more premium',
          'Improve cost basis before potential assignment',
        ],
      } : {
        action: 'Prepare for Assignment', confidence: 85, icon: '🎯', type: 'PRIMARY', color: 'green',
        reasons: [
          buffer ? `+${buffer.bufferPct.toFixed(1)}% buffer above cost basis (${buffer.status})` : '',
          `Cost basis $${assignment.costBasis?.toFixed(2)}/sh — happy to own at this price`,
          `Assignment probability: ${assignProb.probability}%`,
          'Ready for next wheel phase: sell covered calls',
        ].filter(Boolean),
      };
      recs.push(primary);
    }

    if (status === 'ITM_DEEP') {
      recs.push(buffer?.isUnderwater ? {
        action: 'Roll or Close Immediately', confidence: 95, icon: '🚨', type: 'PRIMARY', color: 'red',
        reasons: [
          `CRITICAL: Underwater by ${Math.abs(buffer.bufferPct).toFixed(1)}% ($${Math.abs(buffer.bufferPerShare).toFixed(2)}/sh)`,
          `Assignment probability: ${assignProb.probability}% — Almost Certain`,
          'Option 1: Roll to much higher strike + extend DTE',
          'Option 2: Close and accept the loss now',
          'Waiting makes it worse — act before expiration',
        ],
      } : {
        action: 'Prepare for Assignment', confidence: 90, icon: '🎯', type: 'PRIMARY', color: 'green',
        reasons: [
          buffer ? `+${buffer.bufferPct.toFixed(1)}% cushion above cost basis (${buffer.status})` : '',
          `Assignment probability: ${assignProb.probability}% — Very High`,
          'Deep ITM — assignment almost certain at this price',
          'Have capital ready for stock purchase',
          'Immediately sell covered calls after assignment',
        ].filter(Boolean),
      });
    }

    // Short Put secondaries
    if (simDTE > 14 && status !== 'OTM') {
      recs.push({ action: 'Consider Rolling', confidence: 60, icon: '🔄', type: 'SECONDARY', color: 'orange', reasons: [
        'Keep position alive with fresh premium',
        'Adjust strike and expiration to your preference',
        `Mark-to-market P&L: ${mtm.unrealizedPnLPct.toFixed(1)}%`,
        'Extend duration, continue wheel strategy',
      ]});
    }
    if (status === 'OTM' || mtm.isProfitable) {
      recs.push({ action: 'Close Position', confidence: 50, icon: '❌', type: 'SECONDARY', color: 'orange', reasons: [
        `Cost to close today: $${mtm.costToClose.toFixed(2)}`,
        mtm.isProfitable ? `Lock in +${mtm.unrealizedPnLPct.toFixed(1)}% profit` : 'Limit further losses',
        'Free up capital for another wheel trade',
      ]});
    }
  }

  recs.sort((a, b) => a.type === b.type ? b.confidence - a.confidence : a.type === 'PRIMARY' ? -1 : 1);
  return recs;
}

// ============================================================================
// DATA SOURCE TOGGLE
// ============================================================================

function DataSourceToggle() {
  const dataSource      = useWheelStore(s => s.dataSource);
  const setDataSource   = useWheelStore(s => s.setDataSource);
  const tigerStatus     = useWheelStore(s => s.tigerConnectionStatus);

  const Option = ({ value, label, desc, badges, grad }) => {
    const active = dataSource === value;
    const disabled = value === 'TIGER_LIVE' && !tigerStatus.realtimeQuotesEnabled;
    return (
      <div onClick={() => !disabled && setDataSource(value)}
        className={`p-4 rounded-xl border-2 transition ${
          active ? `border-${grad}-500 bg-${grad}-50` :
          disabled ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed' :
          'border-slate-200 bg-white hover:border-slate-300 cursor-pointer'
        }`}>
        <div className="flex items-start gap-3">
          <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
            active ? `border-${grad}-500 bg-${grad}-500` : 'border-slate-300'
          }`}>
            {active && <div className="w-2 h-2 bg-white rounded-full" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-900">{label}</p>
            <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {badges.map(b => (
                <span key={b.text} className={`text-xs px-2 py-0.5 rounded font-semibold ${b.color}`}>{b.text}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h3 className="text-sm font-bold text-slate-900 mb-3">Data Source</h3>
      <div className="space-y-2">
        <Option value="MANUAL" label="Manual Entry" grad="purple" desc="You enter price and option data. Full control, no API needed."
          badges={[{ text: '✓ Always Works', color: 'bg-green-100 text-green-700' }, { text: '✓ No Subscription', color: 'bg-blue-100 text-blue-700' }]} />
        <Option value="TIGER_LIVE" label="Tiger Live Data" grad="blue" desc="Auto-updates from Tiger API. Real-time quotes and Greeks."
          badges={tigerStatus.realtimeQuotesEnabled
            ? [{ text: '🟢 Live', color: 'bg-green-100 text-green-700' }]
            : [{ text: '⚠ Requires subscription', color: 'bg-yellow-100 text-yellow-700' }]} />
      </div>
      <p className="text-xs text-slate-400 mt-3 pt-2 border-t border-slate-100">
        Active: <span className="font-semibold text-slate-600">{dataSource === 'MANUAL' ? 'Manual Entry' : 'Tiger Live'}</span>
      </p>
    </div>
  );
}

// ============================================================================
// MARKET DATA STATUS CARD
// ============================================================================

function MarketDataStatus() {
  const tigerStatus      = useWheelStore(s => s.tigerConnectionStatus);
  const updateTigerStatus = useWheelStore(s => s.updateTigerStatus);
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const [statusRes, pingRes] = await Promise.allSettled([
        fetch('http://localhost:3001/api/status').then(r => r.json()),
        fetch('http://localhost:3001/api/ping').then(r => r.json()),
      ]);
      const s = statusRes.status === 'fulfilled' ? statusRes.value : {};
      const p = pingRes.status   === 'fulfilled' ? pingRes.value   : {};
      updateTigerStatus({
        connected:            !!s.connected,
        authenticated:        !!s.connected,
        accountVerified:      !!s.connected,
        realtimeQuotesEnabled: p.connected === true && !p.error,
        error:                s.error || p.error || null,
      });
    } catch (e) {
      updateTigerStatus({ connected: false, authenticated: false, accountVerified: false, realtimeQuotesEnabled: false, error: e.message });
    } finally {
      setChecking(false);
    }
  };

  const relTime = (ts) => {
    if (!ts) return 'Never';
    const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
    if (diff < 1) return 'Just now';
    if (diff < 60) return `${diff}m ago`;
    return `${Math.floor(diff / 60)}h ago`;
  };

  const Row = ({ label, ok, okLabel = '✓ Yes', failLabel = '✗ No', warn = false }) => (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ok ? 'bg-green-500' : warn ? 'bg-yellow-500' : 'bg-red-500'}`} />
        <span className="text-xs text-slate-700">{label}</span>
      </div>
      <span className={`text-xs font-semibold ${ok ? 'text-green-700' : warn ? 'text-yellow-600' : 'text-red-600'}`}>
        {ok ? okLabel : failLabel}
      </span>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-slate-900">Market Data Status</h3>
        <button onClick={handleCheck} disabled={checking}
          className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition disabled:opacity-50">
          {checking ? 'Checking…' : '🔄 Check'}
        </button>
      </div>
      <div className="space-y-2">
        <Row label="API Server"        ok={tigerStatus.connected} />
        <Row label="Authenticated"     ok={tigerStatus.authenticated} />
        <Row label="Account Verified"  ok={tigerStatus.accountVerified} />
        <Row label="Real-Time Quotes"  ok={tigerStatus.realtimeQuotesEnabled} warn={!tigerStatus.realtimeQuotesEnabled && tigerStatus.connected}
          okLabel="🟢 Enabled" failLabel="⚠ Need Subscription" />
      </div>
      {tigerStatus.error && (
        <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded-lg">
          <p className="text-xs text-red-600">{tigerStatus.error.slice(0, 80)}{tigerStatus.error.length > 80 ? '…' : ''}</p>
        </div>
      )}
      <p className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-100">
        Last checked: {relTime(tigerStatus.lastChecked)}
      </p>
    </div>
  );
}

// ============================================================================
// MANUAL SNAPSHOT MODAL
// ============================================================================

function ManualSnapshotModal({ position, onClose }) {
  const addSnapshot = useWheelStore(s => s.addPriceSnapshot);
  const [form, setForm] = useState({
    price: '', optionValue: '', bid: '', ask: '',
    iv: '30', daysToExpiry: String(position?.dte || 0),
    recommendation: 'Hold', notes: '',
  });
  const [error, setError] = useState('');

  const upd = (f, v) => { setForm(p => ({ ...p, [f]: v })); if (error) setError(''); };

  const handleSave = () => {
    if (!form.price || isNaN(Number(form.price))) { setError('Stock price required'); return; }
    if (!form.optionValue || isNaN(Number(form.optionValue))) { setError('Option value required'); return; }
    const price = Number(form.price);
    const optVal = Number(form.optionValue);
    addSnapshot({
      id:           Date.now(),
      positionId:   position.id,
      symbol:       position.symbol,
      snapshotDate: new Date().toISOString(),
      price,
      optionValue:  optVal,
      bidAsk: {
        bid: Number(form.bid) || parseFloat((optVal - 0.05).toFixed(2)),
        ask: Number(form.ask) || parseFloat((optVal + 0.05).toFixed(2)),
      },
      iv:           Number(form.iv) || 30,
      daysToExpiry: Number(form.daysToExpiry),
      recommendation: form.recommendation,
      notes:        form.notes,
    });
    onClose();
  };

  const inp = (label, field, type = 'number', placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type={type} step={type === 'number' ? 'any' : undefined} value={form[field]} placeholder={placeholder}
        onChange={e => upd(field, e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">📸 Save Snapshot</h2>
            <p className="text-xs text-slate-500 mt-0.5">{position.symbol} {position.category} ${position.strike}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5 space-y-3 max-h-[65vh] overflow-y-auto">
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          {inp('Stock Price ($)', 'price', 'number', `e.g. ${position.strike}`)}
          {inp('Option Value ($)', 'optionValue', 'number', 'e.g. 1.20')}
          <div className="grid grid-cols-2 gap-3">
            {inp('Bid ($)', 'bid', 'number', 'e.g. 1.15')}
            {inp('Ask ($)', 'ask', 'number', 'e.g. 1.25')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {inp('IV %', 'iv', 'number', 'e.g. 30')}
            {inp('Days to Expiry', 'daysToExpiry', 'number', '')}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Recommendation</label>
            <select value={form.recommendation} onChange={e => upd('recommendation', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
              {['Hold', 'Close', 'Roll', 'Assign', 'Review'].map(r => <option key={r} value={r}>{r} Position</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => upd('notes', e.target.value)} rows={2}
              placeholder="Why you made this decision at this price…"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #f97316 0%, #ef4444 100%)' }}>
            💾 Save Snapshot
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SNAPSHOT HISTORY
// ============================================================================

function SnapshotHistory({ position }) {
  const snapshots   = useWheelStore(s => s.getPriceSnapshotsForPosition(position.id));
  const [expanded, setExpanded] = useState(null);

  const recColor = { Hold: 'bg-blue-500', Close: 'bg-red-500', Roll: 'bg-orange-500', Assign: 'bg-green-500', Review: 'bg-yellow-500' };

  if (snapshots.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="text-sm font-bold text-slate-900 mb-2">📸 Snapshot History</h3>
        <p className="text-sm text-slate-400 italic">No snapshots saved yet. Click "📸 Save Snapshot" above to record your first data point.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-slate-900">📸 Snapshot History</h3>
        <span className="text-xs text-slate-400">{snapshots.length} saved</span>
      </div>
      <div className="space-y-2">
        {snapshots.map(snap => {
          const diff    = snap.price - position.strike;
          const diffPct = ((diff / position.strike) * 100).toFixed(1);
          const isExp   = expanded === snap.id;
          const d       = new Date(snap.snapshotDate);
          return (
            <div key={snap.id} onClick={() => setExpanded(isExp ? null : snap.id)}
              className="border border-slate-200 rounded-xl p-3 cursor-pointer hover:bg-slate-50 transition">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">${snap.price.toFixed(2)}</span>
                    <span className={`text-xs font-semibold ${diff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {diff >= 0 ? '+' : ''}{diffPct}% vs strike
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-xs text-slate-600">Option: <span className="font-bold">${snap.optionValue.toFixed(2)}</span></p>
                    <span className={`text-xs font-semibold text-white px-2 py-0.5 rounded ${recColor[snap.recommendation] || 'bg-slate-500'}`}>
                      {snap.recommendation}
                    </span>
                  </div>
                  <span className="text-slate-300 text-sm">{isExp ? '▼' : '▶'}</span>
                </div>
              </div>
              {isExp && (
                <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-4 gap-2">
                  {[
                    ['Bid', `$${snap.bidAsk.bid.toFixed(2)}`],
                    ['Ask', `$${snap.bidAsk.ask.toFixed(2)}`],
                    ['IV', `${snap.iv}%`],
                    ['DTE', `${snap.daysToExpiry}d`],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-slate-50 rounded-lg p-2 text-center">
                      <p className="text-xs text-slate-500">{l}</p>
                      <p className="text-xs font-bold text-slate-900 mt-0.5">{v}</p>
                    </div>
                  ))}
                  {snap.notes && (
                    <div className="col-span-4 mt-2 p-2 bg-blue-50 rounded-lg">
                      <p className="text-xs text-blue-700">{snap.notes}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SIM_DEFAULT_PRICES = { TSLA: 411.15, IBIT: 84.32, BBAI: 12.45, XLF: 37.82 };

// ============================================================================
// DECISION QUALITY CALCULATOR
// ============================================================================

function DecisionQualityCalculator({ snapshotRef }) {
  const positions               = useWheelStore(s => s.positions);
  const addJournalEntryFromScenario = useWheelStore(s => s.addJournalEntryFromScenario);

  const DEFAULTS = {
    qty: 100, costBasis: 389.16, currentPrice: 374.60,
    buybackCost: 288, newStrike: 377.50, newPremium: 900, futurePrice: 400,
    marketRegime: 'Bearish', confidence: 'High', strategyType: 'Standard CC',
  };

  const [qty,           setQty]           = useState(DEFAULTS.qty);
  const [costBasis,     setCostBasis]     = useState(DEFAULTS.costBasis);
  const [currentPrice,  setCurrentPrice]  = useState(DEFAULTS.currentPrice);
  const [buybackCost,   setBuybackCost]   = useState(DEFAULTS.buybackCost);
  const [newStrike,     setNewStrike]     = useState(DEFAULTS.newStrike);
  const [newPremium,    setNewPremium]    = useState(DEFAULTS.newPremium);
  const [futurePrice,   setFuturePrice]   = useState(DEFAULTS.futurePrice);
  const [marketRegime,  setMarketRegime]  = useState(DEFAULTS.marketRegime);
  const [confidence,    setConfidence]    = useState(DEFAULTS.confidence);
  const [strategyType,  setStrategyType]  = useState(DEFAULTS.strategyType);
  const [srcLabel,      setSrcLabel]      = useState('Sample Defaults');
  const [savedJournal,  setSavedJournal]  = useState(false);

  useEffect(() => {
    const tslaCC     = positions.find(p => p.symbol === 'TSLA' && p.category === 'Covered Call' && p.status === 'OPEN');
    const tslaShares = positions.find(p => p.symbol === 'TSLA' && p.category === 'Long Shares'  && p.status === 'OPEN');
    let loaded = false;
    if (tslaShares) {
      if (tslaShares.shareCount > 0) { setQty(tslaShares.shareCount); loaded = true; }
      // Use avgPricePerShare as cost basis when available — same as effectiveCostBasis()
      const basis = tslaShares.avgPricePerShare || tslaShares.purchasePrice;
      if (basis > 0) { setCostBasis(basis); loaded = true; }
      if (tslaShares.currentSharePrice > 0) { setCurrentPrice(tslaShares.currentSharePrice); loaded = true; }
    }
    if (tslaCC) {
      if (tslaCC.currentValue > 0) { setBuybackCost(tslaCC.currentValue); loaded = true; }
      if (tslaCC.strike       > 0) { setNewStrike(tslaCC.strike);         loaded = true; }
      if (tslaCC.premium      > 0) { setNewPremium(tslaCC.premium);       loaded = true; }
      loaded = true;
    }
    if (loaded) setSrcLabel('Supabase Prefilled');
  }, [positions]);

  const resetToDefaults = () => {
    setQty(DEFAULTS.qty); setCostBasis(DEFAULTS.costBasis); setCurrentPrice(DEFAULTS.currentPrice);
    setBuybackCost(DEFAULTS.buybackCost); setNewStrike(DEFAULTS.newStrike); setNewPremium(DEFAULTS.newPremium);
    setFuturePrice(DEFAULTS.futurePrice); setMarketRegime(DEFAULTS.marketRegime);
    setConfidence(DEFAULTS.confidence); setStrategyType(DEFAULTS.strategyType);
    setSrcLabel('Sample Defaults');
  };

  // ── Step 1 ──
  const netNewPremium       = newPremium - buybackCost;
  const premiumPerShare     = qty > 0 ? newPremium / qty : 0;
  const assignSaleValue     = newStrike + premiumPerShare;
  const realizedStockPnL    = (newStrike - costBasis) * qty;
  const netResultIfAssigned = realizedStockPnL + newPremium;

  // ── Step 2 (strategy always benchmarked "if assigned at new strike") ──
  const holdingResult          = (futurePrice - costBasis) * qty;
  const strategyResult         = (newStrike - costBasis) * qty + newPremium - buybackCost;
  const strategyOutperformance = strategyResult - holdingResult;

  // ── Step 3 ──
  const grossUpsideSacrificed = Math.max(futurePrice - newStrike, 0) * qty;
  const netPremiumBenefit     = newPremium - buybackCost;
  const netOpportunityCost    = grossUpsideSacrificed - netPremiumBenefit;

  // ── Step 4 ──
  const shareMovement   = (futurePrice - currentPrice) * qty;
  const cushionPerShare = qty > 0 ? netPremiumBenefit / qty : 0;

  // ── Risk helpers ──
  const ocRisk    = (oc) => oc < 500 ? 'Low' : oc < 1500 ? 'Medium' : 'High';
  const overallRisk = ocRisk(netOpportunityCost);

  // ── Step 5 summary rows ──
  const SCENARIO_PRICES = [360, 370, 377.50, 390, 400, 410, 420];
  const summaryRows = SCENARIO_PRICES.map(fp => {
    const hRes    = (fp - costBasis) * qty;
    const sRes    = (newStrike - costBasis) * qty + newPremium - buybackCost;
    const outperf = sRes - hRes;
    const gUpside = Math.max(fp - newStrike, 0) * qty;
    const netOC   = gUpside - netPremiumBenefit;
    const risk    = ocRisk(netOC);
    let interp;
    if (fp < newStrike - 5)              interp = 'Strategy helps — premium cushions downside.';
    else if (Math.abs(fp - newStrike) <= 5) interp = 'Assignment likely, upside sacrifice is limited.';
    else if (fp <= 400)                  interp = 'High opportunity cost — Tesla rallies above strike.';
    else                                 interp = 'Strategy severely underperforms holding.';
    return { fp, hRes, sRes, outperf, gUpside, netOC, risk, interp };
  });

  // ── Step 6 thesis alignment ──
  const ALIGNMENT_MAP = {
    'Bearish|Aggressive CC':  { text: 'Aligned with thesis',                          color: 'green'  },
    'Bullish|Aggressive CC':  { text: 'Contradicts bullish thesis',                   color: 'red'    },
    'Neutral|Standard CC':    { text: 'Balanced',                                     color: 'yellow' },
    'Bearish|Standard CC':    { text: 'Well aligned — conservative in bearish regime', color: 'green'  },
    'Bearish|Conservative CC':{ text: 'Very conservative — strong alignment',          color: 'green'  },
    'Bullish|Conservative CC':{ text: 'Overly conservative for bullish market',        color: 'yellow' },
    'Bullish|Standard CC':    { text: 'Moderate — consider a higher strike',           color: 'yellow' },
    'Neutral|Aggressive CC':  { text: 'Aggressive in neutral market — elevated risk',  color: 'red'    },
    'Neutral|Conservative CC':{ text: 'Conservative in neutral market — balanced',     color: 'green'  },
  };
  const alignment = ALIGNMENT_MAP[`${marketRegime}|${strategyType}`] || { text: 'Balanced', color: 'yellow' };

  // ── Keep snapshotRef current so ScenarioSimulator can read values at save time ──
  // Runs after every render — no deps array so it's always fresh.
  useEffect(() => {
    if (!snapshotRef) return;
    snapshotRef.current = {
      shareQty:             qty,
      shareCostBasis:       costBasis,
      currentSharePrice:    currentPrice,
      buybackCost,
      newCallStrike:        newStrike,
      newCallPremium:       newPremium,
      futurePrice,
      marketRegime,
      confidence,
      strategyType,
      // Step 1
      netNewPremium,
      premiumPerShare:      parseFloat(premiumPerShare.toFixed(2)),
      assignSaleValue:      parseFloat(assignSaleValue.toFixed(2)),
      realizedStockPnL:     parseFloat(realizedStockPnL.toFixed(2)),
      netResultIfAssigned:  parseFloat(netResultIfAssigned.toFixed(2)),
      // Step 2
      holdingResult:        parseFloat(holdingResult.toFixed(2)),
      strategyResult:       parseFloat(strategyResult.toFixed(2)),
      strategyOutperformance: parseFloat(strategyOutperformance.toFixed(2)),
      // Step 3
      grossUpsideSacrificed: parseFloat(grossUpsideSacrificed.toFixed(2)),
      netPremiumBenefit:    parseFloat(netPremiumBenefit.toFixed(2)),
      netOpportunityCost:   parseFloat(netOpportunityCost.toFixed(2)),
      // Step 4
      shareMovement:        parseFloat(shareMovement.toFixed(2)),
      cushionPerShare:      parseFloat(cushionPerShare.toFixed(2)),
      // Step 6
      thesisAlignment:      alignment.text,
      thesisAlignmentColor: alignment.color,
      overallRisk,
    };
  });

  // ── Save to journal ──
  const handleSaveToJournal = () => {
    const today = new Date().toISOString().split('T')[0];
    const note = [
      `[${today}] Decision Quality Calculator Simulation`,
      `Symbol: TSLA  |  Future Price: $${futurePrice}`,
      ``,
      `STEP 1 — STRATEGY SETUP`,
      `  Net New Premium:         ${netNewPremium >= 0 ? '+' : ''}$${netNewPremium.toFixed(2)}`,
      `  Premium Per Share:        $${premiumPerShare.toFixed(2)}/sh`,
      `  Assignment Sale Value:    $${assignSaleValue.toFixed(2)}/sh`,
      `  Realized Stock P&L:      ${realizedStockPnL >= 0 ? '+' : ''}$${realizedStockPnL.toFixed(2)}`,
      `  Net Result If Assigned:  ${netResultIfAssigned >= 0 ? '+' : ''}$${netResultIfAssigned.toFixed(2)}`,
      ``,
      `STEP 2 — VS HOLDING`,
      `  Holding Result:          ${holdingResult >= 0 ? '+' : ''}$${holdingResult.toFixed(2)}`,
      `  Strategy Result:         ${strategyResult >= 0 ? '+' : ''}$${strategyResult.toFixed(2)}`,
      `  Outperformance:          ${strategyOutperformance >= 0 ? '+' : ''}$${strategyOutperformance.toFixed(2)}  →  ${strategyOutperformance > 0 ? 'Strategy Beats Holding' : 'Holding Beats Strategy'}`,
      ``,
      `STEP 3 — OPPORTUNITY COST`,
      `  Gross Upside Sacrificed:  $${grossUpsideSacrificed.toFixed(2)}`,
      `  Net Premium Benefit:      $${netPremiumBenefit.toFixed(2)}`,
      `  Net Opportunity Cost:     $${netOpportunityCost.toFixed(2)}  (${overallRisk} Risk)`,
      ``,
      `STEP 4 — DOWNSIDE BENEFIT`,
      `  Net Premium Benefit:      $${netPremiumBenefit.toFixed(2)}`,
      `  Cushion Per Share:        $${cushionPerShare.toFixed(2)}/sh`,
      ``,
      `THESIS ALIGNMENT`,
      `  Regime: ${marketRegime}  |  Strategy: ${strategyType}  |  Confidence: ${confidence}`,
      `  Verdict: ${alignment.text}`,
      `  Risk Level: ${overallRisk}`,
    ].join('\n');

    addJournalEntryFromScenario({
      id:          Date.now(),
      date:        today,
      symbol:      'TSLA',
      positionId:  null,
      trade:       `Decision Quality Simulation — CC $${newStrike} Strike`,
      result:      `Outperformance vs Holding: ${strategyOutperformance >= 0 ? '+' : ''}$${strategyOutperformance.toFixed(2)}`,
      tags:        ['decision-quality', 'simulator', 'tsla', 'covered-call'],
      tradeThesis: { reason: note, support: `$${newStrike}`, target: `$${futurePrice}`, happyAssignment: false },
      simulatorRec: null,
      myDecision:  { action: '', reasoning: '', decidedDate: today },
      outcome:     { completedDate: '', action: '', finalProfit: null, lesson: '' },
    });
    setSavedJournal(true);
    setTimeout(() => setSavedJournal(false), 6000);
  };

  // ── Export as text ──
  const handleExport = () => {
    const today = new Date().toLocaleDateString();
    const pad   = (s, n) => String(s).padEnd(n);
    const lines = [
      '================================================================',
      '  DECISION QUALITY CALCULATOR — WHEEL EDGE',
      `  Generated: ${today}`,
      '================================================================',
      '',
      'INPUTS',
      `  Share Quantity         : ${qty}`,
      `  Share Cost Basis       : $${costBasis}`,
      `  Current Share Price    : $${currentPrice}`,
      `  Current Call Buyback   : $${buybackCost}`,
      `  New Call Strike        : $${newStrike}`,
      `  New Call Premium       : $${newPremium}`,
      `  Future Tesla Price     : $${futurePrice}`,
      `  Market Regime          : ${marketRegime}`,
      `  Confidence             : ${confidence}`,
      `  Strategy Type          : ${strategyType}`,
      '',
      'STEP 1 — STRATEGY SETUP',
      `  Net New Premium        : ${netNewPremium >= 0 ? '+' : ''}$${netNewPremium.toFixed(2)}`,
      `  Premium Per Share      : $${premiumPerShare.toFixed(2)}/sh`,
      `  Assignment Sale Value  : $${assignSaleValue.toFixed(2)}/sh`,
      `  Stock P&L If Assigned  : ${realizedStockPnL >= 0 ? '+' : ''}$${realizedStockPnL.toFixed(2)}`,
      `  Net Result If Assigned : ${netResultIfAssigned >= 0 ? '+' : ''}$${netResultIfAssigned.toFixed(2)}`,
      '',
      `STEP 2 — VS HOLDING (at $${futurePrice})`,
      `  Holding Result         : ${holdingResult >= 0 ? '+' : ''}$${holdingResult.toFixed(2)}`,
      `  Strategy Result        : ${strategyResult >= 0 ? '+' : ''}$${strategyResult.toFixed(2)}`,
      `  Outperformance         : ${strategyOutperformance >= 0 ? '+' : ''}$${strategyOutperformance.toFixed(2)}`,
      `  Verdict                : ${strategyOutperformance > 0 ? 'Strategy Beats Holding' : 'Holding Beats Strategy'}`,
      '',
      'STEP 3 — OPPORTUNITY COST',
      `  Gross Upside Sacrificed: $${grossUpsideSacrificed.toFixed(2)}`,
      `  Net Premium Benefit    : $${netPremiumBenefit.toFixed(2)}`,
      `  Net Opportunity Cost   : $${netOpportunityCost.toFixed(2)}  [${overallRisk}]`,
      '',
      'STEP 4 — DOWNSIDE BENEFIT',
      `  Net Premium Benefit    : $${netPremiumBenefit.toFixed(2)}`,
      `  Cushion Per Share      : $${cushionPerShare.toFixed(2)}/sh`,
      `  Share Movement         : ${shareMovement >= 0 ? '+' : ''}$${shareMovement.toFixed(2)}`,
      '',
      'THESIS ALIGNMENT',
      `  Market Regime          : ${marketRegime}`,
      `  Strategy Type          : ${strategyType}`,
      `  Confidence             : ${confidence}`,
      `  Alignment              : ${alignment.text}`,
      `  Overall Risk           : ${overallRisk}`,
      '',
      'DECISION SUMMARY TABLE',
      `  ${pad('Price', 8)} ${pad('Holding', 10)} ${pad('Strategy', 10)} ${pad('Outperf', 10)} ${pad('OppCost', 9)} ${pad('Risk', 8)} Interpretation`,
      `  ${'-'.repeat(82)}`,
      ...summaryRows.map(r =>
        `  $${pad(r.fp.toFixed(2), 7)} ${pad((r.hRes >= 0 ? '+' : '') + '$' + Math.abs(Math.round(r.hRes)), 10)} ${pad((r.sRes >= 0 ? '+' : '') + '$' + Math.abs(Math.round(r.sRes)), 10)} ${pad((r.outperf >= 0 ? '+' : '') + '$' + Math.abs(Math.round(r.outperf)), 10)} $${pad(Math.round(Math.abs(r.netOC)), 8)} ${pad(r.risk, 8)} ${r.interp}`
      ),
      '',
      '================================================================',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `decision-quality-tsla-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── UI helpers ──
  const fmtSgn = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
  const fmtInt = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(Math.round(n)).toLocaleString()}`;

  const NI = ({ label, value, onChange, prefix = '$', step = 0.01, min = 0 }) => (
    <div>
      {label && <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>}
      <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden bg-white focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-200 transition">
        {prefix && <span className="px-2.5 py-2 text-xs text-slate-400 bg-slate-50 border-r border-slate-200 select-none">{prefix}</span>}
        <input type="number" step={step} min={min} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="flex-1 px-2.5 py-2 text-sm font-bold text-slate-800 focus:outline-none bg-white" />
      </div>
    </div>
  );

  const MC = ({ label, value, sub, tone = 'neutral' }) => {
    const t = { positive: 'bg-green-50 border-green-200 text-green-800', negative: 'bg-red-50 border-red-200 text-red-800', caution: 'bg-amber-50 border-amber-200 text-amber-800', neutral: 'bg-slate-50 border-slate-200 text-slate-700' }[tone];
    return (
      <div className={`rounded-xl border p-4 ${t}`}>
        <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">{label}</p>
        <p className="text-xl font-bold leading-tight">{value}</p>
        {sub && <p className="text-xs opacity-55 mt-1">{sub}</p>}
      </div>
    );
  };

  const StepHeader = ({ num, color, title, desc }) => (
    <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center gap-3">
      <span className={`w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center flex-shrink-0 ${color}`}>{num}</span>
      <div>
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
    </div>
  );

  return (
    <div className="mt-10 space-y-8 pb-4">

      {/* ── Header ── */}
      <div className="border-t-2 border-slate-100 pt-8 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-slate-900 mb-1" style={{ fontFamily: 'Playfair Display, serif' }}>
            Decision Quality Calculator
          </h2>
          <p className="text-sm text-slate-500">
            Compare rolling, lowering strikes, assignment risk, and opportunity cost against simply holding your shares.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${srcLabel === 'Supabase Prefilled' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
            {srcLabel === 'Supabase Prefilled' ? '✓ Supabase Prefilled' : '✏️ Sample Defaults'}
          </span>
          <button onClick={resetToDefaults}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 font-semibold transition">
            Reset
          </button>
          <button onClick={handleExport}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-700 font-semibold transition">
            Export Text
          </button>
          {savedJournal ? (
            <Link to="/journal"
              className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-semibold">
              ✓ Saved → View
            </Link>
          ) : (
            <button onClick={handleSaveToJournal}
              className="text-xs px-3 py-1.5 rounded-lg text-white font-semibold"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
              💾 Save to Journal
            </button>
          )}
        </div>
      </div>

      {/* ── Step 1 — Strategy Setup ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="1" color="bg-blue-600"
          title="Strategy Setup Calculator"
          desc="Test the new covered call and see the net premium after buying back the current call." />
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <NI label="Share Quantity"           value={qty}          onChange={setQty}          prefix="#" step={1} min={1} />
            <NI label="Share Cost Basis"         value={costBasis}    onChange={setCostBasis} />
            <NI label="Current Share Price"      value={currentPrice} onChange={setCurrentPrice} />
            <NI label="Current Call Buyback Cost" value={buybackCost}  onChange={setBuybackCost} />
            <NI label="New Call Strike"          value={newStrike}    onChange={setNewStrike} />
            <NI label="New Call Premium"         value={newPremium}   onChange={setNewPremium} />
          </div>
          <div className="grid grid-cols-5 gap-3">
            <MC label="Net New Premium"
              value={fmtSgn(netNewPremium)}
              sub={`$${newPremium} − $${buybackCost}`}
              tone={netNewPremium >= 0 ? 'positive' : 'negative'} />
            <MC label="Premium Per Share"
              value={`$${premiumPerShare.toFixed(2)}/sh`}
              sub={`$${newPremium} ÷ ${qty} sh`} />
            <MC label="Assignment Sale Value"
              value={`$${assignSaleValue.toFixed(2)}/sh`}
              sub="Strike + premium/sh" />
            <MC label="Stock P&L If Assigned"
              value={fmtInt(realizedStockPnL)}
              sub={`($${newStrike} − $${costBasis}) × ${qty}`}
              tone={realizedStockPnL >= 0 ? 'positive' : 'negative'} />
            <MC label="Net Result If Assigned"
              value={fmtInt(netResultIfAssigned)}
              sub="Stock P&L + new premium"
              tone={netResultIfAssigned >= 0 ? 'positive' : 'negative'} />
          </div>
        </div>
      </div>

      {/* ── Step 2 — Outperformance vs Holding ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="2" color="bg-purple-600"
          title="Outperformance vs Holding Calculator"
          desc="Compare the covered call strategy against simply holding Tesla shares to the same future price." />
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-4 gap-4">
            <NI label="Future Tesla Price"      value={futurePrice}  onChange={setFuturePrice} />
            <NI label="Share Cost Basis"        value={costBasis}    onChange={setCostBasis} />
            <NI label="Share Quantity"          value={qty}          onChange={setQty} prefix="#" step={1} />
            <NI label="Current Call Buyback Cost" value={buybackCost} onChange={setBuybackCost} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <MC label="Holding Result"
              value={fmtInt(holdingResult)}
              sub={`($${futurePrice} − $${costBasis}) × ${qty}`}
              tone={holdingResult >= 0 ? 'positive' : 'negative'} />
            <MC label="Strategy Result"
              value={fmtInt(strategyResult)}
              sub="If assigned at new strike"
              tone={strategyResult >= 0 ? 'positive' : 'negative'} />
            <div className={`rounded-xl border p-4 ${strategyOutperformance > 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Strategy Outperformance</p>
              <p className={`text-xl font-bold ${strategyOutperformance >= 0 ? 'text-green-800' : 'text-red-800'}`}>
                {fmtInt(strategyOutperformance)}
              </p>
              <span className={`inline-block mt-2 text-xs font-bold px-2.5 py-0.5 rounded-full ${strategyOutperformance > 0 ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}`}>
                {strategyOutperformance > 0 ? '✓ Strategy Beats Holding' : '⚠ Holding Beats Strategy'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Step 3 — Upside Sacrifice ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="3" color="bg-orange-500"
          title="Upside Sacrifice / Opportunity Cost Calculator"
          desc="See how much upside you give up if Tesla rallies above the covered call strike." />
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-4 gap-4">
            <NI label="Future Tesla Price"       value={futurePrice}  onChange={setFuturePrice} />
            <NI label="New Call Strike"          value={newStrike}    onChange={setNewStrike} />
            <NI label="New Call Premium"         value={newPremium}   onChange={setNewPremium} />
            <NI label="Current Call Buyback Cost" value={buybackCost} onChange={setBuybackCost} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <MC label="Gross Upside Sacrificed"
              value={`$${grossUpsideSacrificed.toFixed(2)}`}
              sub={`max($${futurePrice}−$${newStrike}, 0) × ${qty}`}
              tone={grossUpsideSacrificed > 0 ? 'negative' : 'positive'} />
            <MC label="Net Premium Benefit"
              value={`$${netPremiumBenefit.toFixed(2)}`}
              sub={`$${newPremium} − $${buybackCost}`}
              tone={netPremiumBenefit >= 0 ? 'positive' : 'negative'} />
            <div className={`rounded-xl border p-4 ${netOpportunityCost < 500 ? 'bg-green-50 border-green-200' : netOpportunityCost < 1500 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Net Opportunity Cost</p>
              <p className={`text-xl font-bold ${netOpportunityCost < 500 ? 'text-green-800' : netOpportunityCost < 1500 ? 'text-amber-800' : 'text-red-800'}`}>
                ${netOpportunityCost.toFixed(2)}
              </p>
              <span className={`inline-block mt-2 text-xs font-bold px-2.5 py-0.5 rounded-full ${netOpportunityCost < 500 ? 'bg-green-200 text-green-800' : netOpportunityCost < 1500 ? 'bg-amber-200 text-amber-800' : 'bg-red-200 text-red-800'}`}>
                {netOpportunityCost < 500 ? 'Low Opportunity Cost' : netOpportunityCost < 1500 ? 'Medium Opportunity Cost' : 'High Opportunity Cost'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Step 4 — Downside / Sideways Benefit ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="4" color="bg-green-600"
          title="Downside / Sideways Benefit Calculator"
          desc="See how much the strategy helps if Tesla moves sideways or falls." />
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-4 gap-4">
            <NI label="Future Tesla Price"       value={futurePrice}  onChange={setFuturePrice} />
            <NI label="Current Share Price"      value={currentPrice} onChange={setCurrentPrice} />
            <NI label="New Call Premium"         value={newPremium}   onChange={setNewPremium} />
            <NI label="Current Call Buyback Cost" value={buybackCost} onChange={setBuybackCost} />
          </div>
          <div className="grid grid-cols-4 gap-3">
            <MC label="Net Premium Benefit"
              value={`$${netPremiumBenefit.toFixed(2)}`}
              sub={`$${newPremium} − $${buybackCost}`}
              tone={netPremiumBenefit >= 0 ? 'positive' : 'negative'} />
            <MC label="Cushion Per Share"
              value={`$${cushionPerShare.toFixed(2)}/sh`}
              sub={`$${netPremiumBenefit.toFixed(2)} ÷ ${qty} shares`}
              tone="positive" />
            <MC label="Share Movement"
              value={fmtInt(shareMovement)}
              sub={`($${futurePrice} − $${currentPrice}) × ${qty}`}
              tone={shareMovement >= 0 ? 'positive' : 'negative'} />
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-600 opacity-80 mb-1">Premium Cushion</p>
              <p className="text-xl font-bold text-blue-800">${cushionPerShare.toFixed(2)}/sh</p>
              <p className="text-xs text-blue-600 mt-1 opacity-70">
                ${cushionPerShare.toFixed(2)}/sh of cushion against downside or sideways movement.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Step 5 — Decision Summary Table ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="5" color="bg-slate-700"
          title="Decision Summary Table"
          desc="Click any row to set that price as your future price scenario. Highlighted row matches current input." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                {['Future Price','Holding Result','Strategy Result','Outperformance','Upside Sacrificed','Net Opp Cost','Risk','Interpretation'].map(h => (
                  <th key={h} className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap bg-slate-50">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row, i) => {
                const active  = Math.abs(row.fp - futurePrice) < 1;
                const rColors = { Low: 'bg-green-100 text-green-700', Medium: 'bg-amber-100 text-amber-700', High: 'bg-red-100 text-red-700' };
                return (
                  <tr key={i} onClick={() => setFuturePrice(row.fp)}
                    className={`border-b border-slate-100 cursor-pointer transition-colors ${active ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}>
                    <td className={`px-4 py-3 font-bold ${active ? 'text-blue-700' : 'text-slate-800'}`}>
                      ${row.fp.toFixed(2)}{active && <span className="ml-1.5 text-xs bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded font-bold">▶</span>}
                    </td>
                    <td className={`px-4 py-3 font-semibold tabular-nums ${row.hRes >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtInt(row.hRes)}</td>
                    <td className={`px-4 py-3 font-semibold tabular-nums ${row.sRes >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtInt(row.sRes)}</td>
                    <td className={`px-4 py-3 font-bold tabular-nums   ${row.outperf >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtInt(row.outperf)}</td>
                    <td className={`px-4 py-3 font-semibold tabular-nums ${row.gUpside > 0 ? 'text-red-600' : 'text-green-700'}`}>
                      ${Math.round(row.gUpside).toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 font-semibold tabular-nums ${row.netOC > 1500 ? 'text-red-600' : row.netOC > 500 ? 'text-amber-600' : 'text-green-700'}`}>
                      ${Math.round(Math.abs(row.netOC)).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${rColors[row.risk]}`}>{row.risk}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-xs">{row.interp}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Step 6 — Thesis Alignment ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <StepHeader num="6" color="bg-indigo-600"
          title="Thesis Alignment Score"
          desc="Check whether your strategy choice matches your market view and confidence level." />
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Market Regime',  val: marketRegime, set: setMarketRegime,  opts: ['Bearish','Neutral','Bullish'] },
              { label: 'Confidence',     val: confidence,   set: setConfidence,    opts: ['Low','Medium','High'] },
              { label: 'Strategy Type',  val: strategyType, set: setStrategyType,  opts: ['Conservative CC','Standard CC','Aggressive CC'] },
            ].map(({ label, val, set, opts }) => (
              <div key={label}>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
                <select value={val} onChange={e => set(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200 transition">
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
            <NI label="Future Price Scenario" value={futurePrice} onChange={setFuturePrice} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className={`rounded-xl border p-5 ${alignment.color === 'green' ? 'bg-green-50 border-green-200' : alignment.color === 'red' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-2">Thesis Alignment</p>
              <p className={`text-base font-bold mb-2 ${alignment.color === 'green' ? 'text-green-800' : alignment.color === 'red' ? 'text-red-800' : 'text-amber-800'}`}>
                {alignment.text}
              </p>
              <p className="text-xs opacity-60">{marketRegime} · {strategyType} · {confidence} Confidence</p>
            </div>

            <div className={`rounded-xl border p-5 ${overallRisk === 'Low' ? 'bg-green-50 border-green-200' : overallRisk === 'Medium' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-2">Overall Risk Level</p>
              <p className={`text-4xl font-black mb-1 ${overallRisk === 'Low' ? 'text-green-700' : overallRisk === 'Medium' ? 'text-amber-700' : 'text-red-700'}`}>
                {overallRisk}
              </p>
              <p className="text-xs opacity-55">Based on opportunity cost at ${futurePrice}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Key Metrics Summary</p>
              <div className="space-y-2 text-xs text-slate-700">
                {[
                  { label: 'Net premium collected', val: `$${netPremiumBenefit.toFixed(2)}`,         color: 'text-green-700' },
                  { label: `Vs holding at $${futurePrice}`, val: fmtInt(strategyOutperformance),    color: strategyOutperformance >= 0 ? 'text-green-700' : 'text-red-600' },
                  { label: 'Opportunity cost',       val: `$${netOpportunityCost.toFixed(2)}`,       color: netOpportunityCost > 1000 ? 'text-red-600' : 'text-slate-700' },
                  { label: 'Cushion per share',      val: `$${cushionPerShare.toFixed(2)}/sh`,       color: 'text-blue-700' },
                ].map(({ label, val, color }) => (
                  <div key={label} className="flex justify-between items-center">
                    <span>{label}</span>
                    <span className={`font-bold tabular-nums ${color}`}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// ============================================================================
// SCENARIO SIMULATOR PAGE
// ============================================================================

function ScenarioSimulator() {
  const positions                   = useWheelStore((s) => s.positions);
  const journal                     = useWheelStore((s) => s.journal);
  const addJournalEntryFromScenario = useWheelStore((s) => s.addJournalEntryFromScenario);
  const updateJournalEntry          = useWheelStore((s) => s.updateJournalEntry);

  const dataSource                  = useWheelStore(s => s.dataSource);
  const upsertJournalRecommendation = useWheelStore(s => s.upsertJournalRecommendation);
  // Default to first position that has a strike (options) — skip Cash/Shares positions
  const simulatablePositions = positions.filter(p => p.status === 'OPEN' && isOptCat(p.category));
  const [selectedId,    setSelectedId]    = useState(simulatablePositions[0]?.id || positions[0]?.id || null);
  const [simPrice,      setSimPrice]      = useState(411.15);
  const [simDTE,        setSimDTE]        = useState(31);
  const [actionDone,    setActionDone]    = useState(null);
  const [showSnapshot,  setShowSnapshot]  = useState(false);
  const [recSaved,      setRecSaved]      = useState(false);

  const position  = positions.find((p) => p.id === selectedId) || simulatablePositions[0] || positions[0];
  const hasStrike = position && position.strike != null && !isNaN(position.strike);
  const isCC         = isCallCat(position?.category);
  // Human-readable label — use actual category name so Naked Call/Put show correctly
  const posTypeLabel = position?.category || (isCC ? 'Covered Call' : 'Short Put');

  useEffect(() => {
    if (position) {
      setSimPrice(SIM_DEFAULT_PRICES[position.symbol] || (position.strike ? position.strike * 1.05 : 100));
      setSimDTE(position.dte || 30);
    }
  }, [selectedId]);

  const IV = 0.30, RISK_FREE = 0.05;
  const dqcSnapshotRef = useRef(null); // DecisionQualityCalculator keeps this current
  // Use the correct Black-Scholes formula based on position type
  const metrics     = (position && hasStrike) ? calcOptionMetrics(simPrice, position.strike, simDTE, RISK_FREE, IV, positionOptionType(position)) : null;
  const mtm         = metrics && position ? calcMarkToMarket(position, metrics.price) : null;
  const assignment  = (position && hasStrike) ? calcAssignmentOutcome(position, simPrice) : null;
  const assignProb  = (position && hasStrike) ? calcAssignmentProbability(simPrice, position.strike, simDTE, IV, isCC) : null;
  // Buffer (cushion vs cost basis) only applies to Short Put; CC uses effectiveSellPrice instead
  const buffer      = (assignment && !isCC) ? calcBuffer(assignment.costBasis, simPrice) : null;
  const recs        = (position && mtm && assignment && assignProb)
    ? generateSmartRecommendations(position, simPrice, simDTE, assignment, assignProb, mtm)
    : [];
  const primaryRec    = recs.find(r => r.type === 'PRIMARY') || null;
  const secondaryRecs = recs.filter(r => r.type === 'SECONDARY');

  const strike_   = (position?.strike && !isNaN(position.strike)) ? position.strike : 400;
  const PRICE_MIN = Math.round(strike_ * 0.7);
  const PRICE_MAX = Math.round(strike_ * 1.3);
  const strikePct = position ? ((position.strike - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * 100 : 50;
  // Short Put: red below strike (ITM), green above (OTM)
  // Covered Call: green below strike (OTM), red above (ITM) — gradient reversed
  const priceTrack = isCC
    ? `linear-gradient(to right, #22c55e 0%, #22c55e ${strikePct.toFixed(1)}%, #eab308 ${Math.min(strikePct + 8, 100).toFixed(1)}%, #ef4444 100%)`
    : `linear-gradient(to right, #ef4444 0%, #eab308 ${strikePct.toFixed(1)}%, #22c55e ${Math.min(strikePct + 8, 100).toFixed(1)}%, #22c55e 100%)`;
  // dteTrack kept for reference (replaced by per-slider IIFE gradient)

  const recPalette = {
    green:  { wrap: 'bg-green-50 border-green-200',   text: 'text-green-800',  badge: 'bg-green-100 text-green-700' },
    orange: { wrap: 'bg-orange-50 border-orange-200', text: 'text-orange-800', badge: 'bg-orange-100 text-orange-700' },
    red:    { wrap: 'bg-red-50 border-red-200',       text: 'text-red-800',    badge: 'bg-red-100 text-red-700' },
  };
  const pal = primaryRec ? (recPalette[primaryRec.color] || recPalette.green) : recPalette.green;

  const statusBadge = (s) => ({
    Active: 'bg-green-100 text-green-700', Review: 'bg-blue-100 text-blue-700',
    Roll: 'bg-purple-100 text-purple-700', Close: 'bg-red-100 text-red-700',
    Assign: 'bg-amber-100 text-amber-700',
  }[s] || 'bg-slate-100 text-slate-600');

  const handleAction = (action) => {
    if (!position || !primaryRec) return;
    const today = new Date().toISOString().split('T')[0];
    const rec   = primaryRec;

    // Build a concise action note to append to the thesis
    const actionNote = [
      `[${today}] Simulator Decision: ${action}`,
      `Recommendation: ${rec.action} (${rec.confidence}% confidence)`,
      `Scenario: $${Number(simPrice).toFixed(2)} · ${simDTE} DTE`,
      buffer ? `Safety Buffer: ${buffer.bufferPerShare >= 0 ? '+' : ''}$${buffer.bufferPerShare.toFixed(2)}/sh (${buffer.status})` : null,
      isCC && assignment?.effectiveSellPrice ? `Effective Sell Price if Called: $${assignment.effectiveSellPrice.toFixed(2)}/sh` : null,
      !isCC && assignment?.costBasis ? `Assignment Cost Basis: $${assignment.costBasis.toFixed(2)}/sh` : null,
      `MTM: ${mtm?.unrealizedPnLPct?.toFixed(1)}% (close costs $${mtm?.costToClose?.toFixed(2)})`,
      ...(rec.reasons || []).map(r => `• ${r}`),
    ].filter(Boolean).join('\n');

    // Push into existing journal entry for this position if one exists
    const existingEntry = journal.find(e => e.positionId === position.id);

    if (existingEntry) {
      const prevThesis   = existingEntry.tradeThesis || {};
      const prevReason   = prevThesis.reason || '';
      const updatedReason = prevReason
        ? `${prevReason}\n\n---\n\n${actionNote}`
        : actionNote;
      updateJournalEntry(existingEntry.id, {
        tradeThesis: { ...prevThesis, reason: updatedReason },
      });
      setActionDone({ action, entry: existingEntry, today, updatedExisting: true });
    } else {
      // No existing journal entry — create one
      const newEntry = {
        id:          Date.now(),
        date:        today,
        symbol:      position.symbol,
        positionId:  position.id,
        trade:       `${posTypeLabel} $${position.strike} — ${action}`,
        result:      `Modeled at $${Number(simPrice).toFixed(2)}, ${simDTE} DTE`,
        tags:        [action.toLowerCase(), 'simulator', position.symbol.toLowerCase()],
        tradeThesis: { reason: actionNote, support: '', target: '', happyAssignment: !isCC },
        simulatorRec: null,
        myDecision:  { action: '', reasoning: '', decidedDate: '' },
        outcome:     { completedDate: '', action: '', finalProfit: null, lesson: '' },
      };
      addJournalEntryFromScenario(newEntry);
      setActionDone({ action, entry: newEntry, today, updatedExisting: false });
    }
  };

  const actions = [
    { key: 'Active', label: '✅ Keep Active',        grad: 'from-green-500 to-emerald-500' },
    { key: 'Review', label: '👀 Review Position',    grad: 'from-blue-500 to-cyan-500' },
    { key: 'Roll',   label: '🔄 Roll Position',      grad: 'from-purple-500 to-blue-500' },
    { key: 'Close',  label: '❌ Close Position',     grad: 'from-orange-500 to-red-500' },
    { key: 'Assign', label: '🎯 Prepare Assignment', grad: 'from-amber-500 to-orange-500' },
  ];

  // Metric row helper
  const MRow = ({ label, value, sub, hi, note }) => (
    <div className="flex items-start justify-between py-2 border-b border-slate-100 last:border-0">
      <div>
        <p className="text-xs font-semibold text-slate-600">{label}</p>
        {note && <p className="text-xs text-slate-400">{note}</p>}
      </div>
      <div className="text-right">
        <p className={`text-sm font-bold ${hi === true ? 'text-green-700' : hi === false ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
        {sub && <p className="text-xs text-slate-400">{sub}</p>}
      </div>
    </div>
  );

  if (!position) return <LayoutWrapper><div className="p-8 text-slate-500">No positions to simulate.</div></LayoutWrapper>;

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Scenario Simulator
            </h1>
            <p className="text-slate-600">Separate mark-to-market from assignment — see the real risk</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-1 rounded-full text-xs font-semibold ${dataSource === 'MANUAL' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'}`}>
              {dataSource === 'MANUAL' ? '✏️ Manual Mode' : '🟢 Tiger Live'}
            </span>
            <span className="px-3 py-1.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
              📊 Black-Scholes · IV 30%
            </span>
          </div>
        </div>

        {/* Position selector — only options are simulatable */}
        <div className="flex gap-2 flex-wrap">
          {simulatablePositions.map((p) => (
            <button key={p.id} onClick={() => setSelectedId(p.id)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                p.id === position?.id ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}>
              {p.symbol} {p.category === 'Covered Call' ? 'CC' : 'Put'} ${p.strike}
              <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${statusBadge(p.status)}`}>{p.status}</span>
            </button>
          ))}
          {simulatablePositions.length === 0 && (
            <p className="text-sm text-slate-500 italic">No option positions to simulate. Add a Short Put or Covered Call first.</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-6">

          {/* LEFT — Sliders + Two outcome cards + Greeks */}
          <div className="col-span-2 space-y-5">

            {/* Position header */}
            <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl p-5 border border-slate-200 flex items-start justify-between">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">🎯 {position.symbol}</h2>
                <p className="text-slate-600 mt-1">{posTypeLabel} · ${position.strike} Strike · {position.expiry}</p>
                {position.thesis && <p className="text-xs text-slate-500 mt-1 italic">{position.thesis}</p>}
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500 uppercase tracking-wide">Premium Collected</p>
                <p className="text-2xl font-bold text-slate-900">${position.premium}</p>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${statusBadge(position.status)}`}>{position.status}</span>
                <div className="mt-2">
                  <button onClick={() => setShowSnapshot(true)}
                    className="px-3 py-1.5 text-xs font-semibold text-white rounded-lg"
                    style={{ background: 'linear-gradient(135deg, #f97316 0%, #ef4444 100%)' }}>
                    📸 Save Snapshot
                  </button>
                </div>
              </div>
            </div>

            {/* Dual sliders */}
            <div className="bg-white rounded-xl p-6 border border-slate-200 space-y-7">
              <h3 className="text-lg font-semibold text-slate-900">Simulation Controls</h3>

              {/* ── Price slider ── */}
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-slate-700">
                    Underlying Price: <span className="text-purple-700 font-bold">${Number(simPrice).toFixed(2)}</span>
                  </label>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                    assignProb?.isITM ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                  }`}>
                    {assignProb?.isITM ? 'ITM ⚠' : 'OTM ✓'}
                  </span>
                </div>

                {/* Track + thumb */}
                <div className="relative">
                  <input type="range" min={PRICE_MIN} max={PRICE_MAX} step="0.5" value={simPrice}
                    onChange={e => setSimPrice(Number(e.target.value))}
                    className="w-full h-4 rounded-full cursor-pointer appearance-none"
                    style={{ background: priceTrack }} />

                  {/* Strike marker line on track */}
                  <div className="absolute top-0 h-4 w-0.5 bg-slate-800 opacity-70 pointer-events-none rounded"
                    style={{ left: `calc(${strikePct.toFixed(1)}% - 1px)` }} />
                </div>

                {/* Tick marks + labels */}
                {(() => {
                  const range    = PRICE_MAX - PRICE_MIN;
                  const rawStep  = range / 6;
                  const niceStep = Math.ceil(rawStep / 5) * 5;
                  const ticks    = [];
                  // regular interval ticks
                  for (let v = PRICE_MIN; v <= PRICE_MAX + 0.5; v += niceStep) {
                    const clamped = Math.min(Math.round(v), PRICE_MAX);
                    if (!ticks.find(t => Math.abs(t.v - clamped) < niceStep * 0.3)) {
                      ticks.push({ v: clamped, special: false });
                    }
                  }
                  // always include strike
                  if (!ticks.find(t => t.v === position.strike)) {
                    ticks.push({ v: position.strike, special: true });
                  }
                  ticks.sort((a, b) => a.v - b.v);

                  return (
                    <div className="relative h-9 mt-1">
                      {ticks.map(({ v, special }) => {
                        const pct  = ((v - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * 100;
                        // Short Put OTM = above strike; Covered Call OTM = below strike
                        const isOTM = isCC ? v < position.strike : v > position.strike;
                        const isAt  = Math.abs(simPrice - v) <= niceStep * 0.4;
                        return (
                          <div key={v}
                            className="absolute flex flex-col items-center"
                            style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}>
                            {/* tick line */}
                            <div className={`w-px h-2 mb-0.5 ${
                              special ? 'bg-slate-700 w-0.5 h-2.5' :
                              isOTM   ? 'bg-green-400' : 'bg-red-400'
                            }`} />
                            {/* label */}
                            <span className={`text-xs leading-tight whitespace-nowrap select-none ${
                              special ? 'font-bold text-slate-800' :
                              isAt    ? 'font-bold text-slate-900' :
                              isOTM   ? 'text-green-600'           : 'text-red-500'
                            }`}>
                              {special ? `⬥$${v}` : `$${v}`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* ── DTE slider ── */}
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-slate-700">
                    Days to Expiry: <span className="text-blue-700 font-bold">{simDTE} DTE</span>
                  </label>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                    simDTE <= 7 ? 'bg-red-100 text-red-700' :
                    simDTE <= 14 ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {simDTE <= 7 ? 'Near Expiry' : simDTE <= 14 ? 'Watch' : 'Safe Zone'}
                  </span>
                </div>

                {/* DTE track — green (max DTE) fades to red (expiry) */}
                {(() => {
                  // dteFull reference removed — gradient computed inline below
                  const filledPct = (simDTE / position.dte) * 100;
                  // Blend full gradient for filled portion, grey for unfilled
                  const trackBg = `linear-gradient(to right,
                    #22c55e 0%, #84cc16 ${(30 * filledPct / 100).toFixed(1)}%,
                    #eab308 ${(55 * filledPct / 100).toFixed(1)}%,
                    #f97316 ${(75 * filledPct / 100).toFixed(1)}%,
                    #ef4444 ${filledPct.toFixed(1)}%,
                    #e2e8f0 ${filledPct.toFixed(1)}%, #e2e8f0 100%)`;

                  const dteMilestones = [0, 7, 14, 21, 30, 45, 60].filter(d => d <= position.dte);
                  if (!dteMilestones.includes(position.dte)) dteMilestones.push(position.dte);

                  return (
                    <>
                      <input type="range" min="0" max={position.dte} step="1" value={simDTE}
                        onChange={e => setSimDTE(Number(e.target.value))}
                        className="w-full h-4 rounded-full cursor-pointer appearance-none"
                        style={{ background: trackBg }} />

                      {/* Tick marks */}
                      <div className="relative h-9 mt-1">
                        {dteMilestones.map(d => {
                          const pct   = (d / position.dte) * 100;
                          const isAt  = simDTE === d;
                          const zone  = d === 0 ? 'bg-red-500' :
                                        d <= 7  ? 'bg-red-400' :
                                        d <= 14 ? 'bg-orange-400' :
                                        d <= 21 ? 'bg-yellow-500' : 'bg-green-500';
                          const tcol  = d === 0 ? 'text-red-600' :
                                        d <= 7  ? 'text-red-500' :
                                        d <= 14 ? 'text-orange-600' :
                                        d <= 21 ? 'text-yellow-600' : 'text-green-700';
                          const isMax = d === position.dte;
                          return (
                            <div key={d}
                              className="absolute flex flex-col items-center"
                              style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}>
                              <div className={`w-px h-2 mb-0.5 ${zone} ${isMax ? 'w-0.5 h-2.5' : ''}`} />
                              <span className={`text-xs leading-tight whitespace-nowrap select-none ${
                                isAt ? 'font-bold text-slate-900' : tcol
                              }`}>
                                {d === 0 ? 'Exp' : isMax ? `${d}d ⬥` : `${d}d`}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* TWO OUTCOME CARDS */}
            {mtm && assignment && (
              <div className="grid grid-cols-2 gap-4">

                {/* Card 1: Mark-to-Market */}
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-slate-900">Option Position</h3>
                    <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">Close Today</span>
                  </div>
                  <MRow label="Premium Collected"   value={`$${mtm.premiumCollected}`} />
                  <MRow label="Current Option Value" value={`$${mtm.currentOptionValue.toFixed(2)}`} sub="Black-Scholes estimate" />
                  <MRow label="Cost to Close Today" value={`$${mtm.costToClose.toFixed(2)}`} hi={false} />
                  <MRow label="Unrealized P&L"      value={`${mtm.unrealizedPnL >= 0 ? '+' : ''}$${mtm.unrealizedPnL.toFixed(2)}`} hi={mtm.isProfitable} />
                  <MRow label="Mark-to-Market %"    value={`${mtm.unrealizedPnLPct >= 0 ? '+' : ''}${mtm.unrealizedPnLPct.toFixed(1)}%`} hi={mtm.isProfitable} sub="Only matters if closing" />
                  <p className="text-xs text-slate-400 mt-3 pt-2 border-t border-slate-100">
                    ⚠ Deep ITM options are expensive to close. Wheel traders rarely close — they take assignment.
                  </p>
                </div>

                {/* Card 2: Assignment / Called-Away Outcome */}
                {isCC ? (
                  <div className={`rounded-xl border p-5 ${assignment.isAboveStrike ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-bold text-slate-900">Called-Away Outcome</h3>
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${assignment.isAboveStrike ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`}>
                        {assignment.isAboveStrike ? '⚠ Will Be Called' : '✓ OTM — Safe'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">At scenario price ${simPrice.toFixed(2)}, {simDTE} DTE</p>
                    <MRow label="Strike (Call Level)"     value={`$${assignment.strikePrice}`} />
                    <MRow label="Premium Credit"          value={`$${assignment.premiumPerShare.toFixed(2)}/sh`} hi={true} />
                    <MRow label="Effective Sell Price"    value={`$${assignment.effectiveSellPrice.toFixed(2)}/sh`} sub="Strike + premium/share" hi={true} />
                    <MRow label="Current Stock Price"     value={`$${simPrice.toFixed(2)}`} />
                    {assignment.opportunityCostPerSh > 0 && (
                      <MRow label="Upside Foregone"       value={`$${assignment.opportunityCostPerSh.toFixed(2)}/sh`} sub="Stock rose above strike" hi={false} />
                    )}
                    <MRow label="CC Yield on Strike"      value={`+${assignment.returnPct}%`} hi={true} sub="Premium ÷ strike price" />
                  </div>
                ) : (
                  <div className={`rounded-xl border p-5 ${assignment.happyOwning ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-bold text-slate-900">Assignment Outcome</h3>
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${assignment.happyOwning ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {assignment.happyOwning ? '✓ Acceptable' : '⚠ Underwater'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">At scenario price ${simPrice.toFixed(2)}, {simDTE} DTE</p>
                    <MRow label="Strike Price"      value={`$${assignment.strikePrice}`} />
                    <MRow label="Premium Credit"    value={`$${assignment.premiumPerShare.toFixed(2)}/sh`} hi={true} />
                    <MRow label="Your Cost Basis"   value={`$${assignment.costBasis.toFixed(2)}/sh`} sub="Strike − premium/share" />
                    <MRow label="Scenario Price"    value={`$${simPrice.toFixed(2)}`} />
                    <MRow label="Per Share P&L"     value={`${assignment.unrealizedPerSh >= 0 ? '+' : ''}$${assignment.unrealizedPerSh.toFixed(2)}/sh`} hi={assignment.unrealizedPerSh >= 0} />
                    <MRow label="Total (100 sh)"    value={`${assignment.unrealizedTotal >= 0 ? '+' : ''}$${assignment.unrealizedTotal.toFixed(0)}`} hi={assignment.unrealizedTotal >= 0} />
                    <MRow label="Assignment Return" value={`${assignment.returnPct >= 0 ? '+' : ''}${assignment.returnPct}%`} hi={assignment.happyOwning} sub="vs cost basis" />
                    {buffer && (
                      <div className={`mt-3 pt-3 border-t ${assignment.happyOwning ? 'border-green-200' : 'border-red-200'}`}>
                        <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Safety Buffer</p>
                        <div className="flex items-center justify-between">
                          <div>
                            <p className={`text-lg font-bold ${buffer.isUnderwater ? 'text-red-700' : 'text-green-700'}`}>
                              {buffer.bufferPerShare >= 0 ? '+' : ''}${buffer.bufferPerShare.toFixed(2)}/sh
                            </p>
                            <p className={`text-xs font-semibold ${buffer.isUnderwater ? 'text-red-600' : 'text-green-600'}`}>
                              {buffer.bufferPerShare >= 0 ? '+' : ''}{buffer.bufferPct}% · {buffer.status}
                            </p>
                          </div>
                          <div className="text-right text-xs text-slate-500"><p>current vs</p><p>cost basis</p></div>
                        </div>
                        <p className="text-xs mt-2 text-slate-500">
                          {buffer.isUnderwater
                            ? `⚠ $${Math.abs(buffer.bufferPerShare).toFixed(2)}/sh underwater at this scenario price`
                            : `✓ $${buffer.bufferPerShare.toFixed(2)}/sh of cushion before going underwater`}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ITM Status card */}
            {assignProb && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">{isCC ? 'Exercise Probability' : 'Assignment Probability'}</h3>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: 'ITM Distance',   val: assignProb.isITM ? `$${assignProb.itmDistance.toFixed(2)} (${assignProb.pctITM.toFixed(1)}% ${isCC ? 'above' : 'below'} strike)` : `OTM by $${Math.abs(assignProb.itmDistance).toFixed(2)}`, hi: !assignProb.isITM },
                    { label: isCC ? 'Exercise Prob' : 'Assignment Prob', val: `${assignProb.probability}%`, hi: assignProb.probability < 30 },
                    { label: 'Risk Level',     val: assignProb.riskLevel, hi: assignProb.riskLevel === 'LOW' },
                    { label: 'DTE Remaining', val: `${simDTE} days`, hi: simDTE > 14 },
                  ].map((m) => (
                    <div key={m.label} className={`rounded-lg p-3 text-center ${m.hi ? 'bg-green-50' : assignProb.riskLevel === 'HIGH' && m.label !== 'DTE Remaining' && m.label !== 'ITM Distance' ? 'bg-red-50' : 'bg-slate-50'}`}>
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{m.label}</p>
                      <p className={`text-sm font-bold ${m.hi === true ? 'text-green-700' : m.hi === false ? 'text-red-600' : 'text-slate-900'}`}>{m.val}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Greeks */}
            {metrics && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-slate-900">Greeks</h3>
                  <span className="text-xs text-slate-400">IV: 30% · r: 5%</span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { g: 'Δ Delta', v: metrics.delta.toFixed(3),               d: 'Price sensitivity',     c: 'text-purple-700' },
                    { g: 'Θ Theta', v: `$${Math.abs(metrics.theta).toFixed(2)}/d`, d: 'Daily decay',      c: 'text-blue-700' },
                    { g: 'Γ Gamma', v: metrics.gamma.toFixed(4),               d: 'Delta rate of change',  c: 'text-orange-700' },
                    { g: 'ν Vega',  v: `$${metrics.vega.toFixed(2)}`,          d: 'Per 1% IV',             c: 'text-green-700' },
                  ].map((g) => (
                    <div key={g.g} className="border border-slate-200 rounded-lg p-3 text-center">
                      <p className="text-xs text-slate-500">{g.g}</p>
                      <p className={`text-lg font-bold mt-0.5 ${g.c}`}>{g.v}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{g.d}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — Assignment gauge + Recommendation + Actions */}
          <div className="space-y-5">

            {/* Assignment gauge + buffer */}
            {assignment && buffer && (
              <div className="bg-white rounded-xl p-5 border border-slate-200">
                <p className="text-xs text-slate-500 uppercase tracking-wide mb-3 text-center">Assignment Outcome</p>
                <div className={`w-20 h-20 rounded-full mx-auto flex items-center justify-center text-white shadow-lg ${
                  assignment.happyOwning ? 'bg-gradient-to-br from-green-500 to-emerald-500' :
                  assignment.returnPct > -15 ? 'bg-gradient-to-br from-orange-400 to-amber-500' :
                                               'bg-gradient-to-br from-red-500 to-orange-500'
                }`}>
                  <div className="text-center">
                    <p className="text-base font-bold leading-tight">{assignment.returnPct >= 0 ? '+' : ''}{assignment.returnPct}%</p>
                    <p className="text-xs opacity-80">return</p>
                  </div>
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-600 text-center">
                  <p>Cost basis: <span className="font-bold">${assignment.costBasis.toFixed(2)}/sh</span></p>
                  <p>Scenario: <span className="font-bold">${simPrice.toFixed(2)}</span></p>
                </div>
                {/* Buffer strip */}
                <div className={`mt-3 pt-3 border-t border-slate-100 rounded-lg px-3 py-2 ${buffer.isUnderwater ? 'bg-red-50' : 'bg-green-50'}`}>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Safety Buffer</p>
                  <p className={`text-base font-bold ${buffer.isUnderwater ? 'text-red-700' : 'text-green-700'}`}>
                    {buffer.bufferPerShare >= 0 ? '+' : ''}${buffer.bufferPerShare.toFixed(2)}/sh
                  </p>
                  <p className={`text-xs font-semibold ${buffer.isUnderwater ? 'text-red-500' : 'text-green-600'}`}>
                    {buffer.bufferPct >= 0 ? '+' : ''}{buffer.bufferPct}% · {buffer.status}
                  </p>
                </div>
              </div>
            )}

            {/* Primary Recommendation */}
            {primaryRec && (
              <div className={`rounded-xl p-4 border ${pal.wrap}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-bold uppercase tracking-wide ${pal.text}`}>
                    {primaryRec.icon} Recommendation
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${pal.badge}`}>{primaryRec.confidence}%</span>
                </div>
                <p className={`text-sm font-bold mb-2 ${pal.text}`}>{primaryRec.action}</p>
                <ul className="space-y-1">
                  {primaryRec.reasons.map((r, i) => (
                    <li key={i} className={`text-xs ${pal.text} opacity-80 flex gap-1.5`}><span>·</span>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Secondary Recommendations */}
            {secondaryRecs.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">Alternative Strategies</p>
                <div className="space-y-2">
                  {secondaryRecs.map((r, i) => (
                    <div key={i} className="border border-slate-100 rounded-lg p-3 bg-slate-50">
                      <p className="text-xs font-bold text-slate-700">{r.icon} {r.action}</p>
                      <p className="text-xs text-slate-500 mt-1">{r.reasons[0]}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Save recommendation to journal */}
            {primaryRec && (
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Save to Journal</p>
                <p className="text-xs text-slate-500 mb-3">
                  Record this recommendation against your position journal entry for later review.
                </p>
                {recSaved ? (
                  <div className="flex items-center gap-2 text-green-700 text-xs font-semibold">
                    <span>✓</span> Saved to Journal
                    <Link to="/journal" onClick={() => setRecSaved(false)} className="underline ml-1">View →</Link>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      upsertJournalRecommendation(position.id, {
                        date: new Date().toISOString().split('T')[0],
                        action: primaryRec.action,
                        confidence: primaryRec.confidence,
                        reasons: primaryRec.reasons,
                        profitPct: assignment?.returnPct ?? null,
                        mtmPct: mtm?.unrealizedPnLPct ?? null,
                        price: simPrice,
                        simDTE,
                        bufferPerShare: buffer?.bufferPerShare ?? null,
                        bufferStatus: buffer?.status ?? null,
                        // Black-Scholes assumptions
                        iv: IV,
                        riskFreeRate: RISK_FREE,
                        // Decision Quality Calculator snapshot (all inputs + computed values)
                        dqc: dqcSnapshotRef.current ?? null,
                        generatedAt: new Date().toISOString(),
                      });
                      setRecSaved(true);
                      setTimeout(() => setRecSaved(false), 8000);
                    }}
                    className="w-full py-2 text-xs font-semibold text-white rounded-lg"
                    style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                    💾 Save Recommendation to Journal
                  </button>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Take Action</p>
              {actions.map(({ key, label, grad }) => (
                <button key={key} onClick={() => handleAction(key)}
                  className={`w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r ${grad} hover:shadow-md transition`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Decision Quality Calculator */}
        <DecisionQualityCalculator snapshotRef={dqcSnapshotRef} />

        {/* Snapshot history below simulator */}
        <SnapshotHistory position={position} />

        {showSnapshot && (
          <ManualSnapshotModal position={position} onClose={() => setShowSnapshot(false)} />
        )}

        {/* Confirmation modal */}
        {actionDone && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setActionDone(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
              <div className="text-center mb-4">
                <span className="text-5xl">✅</span>
                <h2 className="text-xl font-bold text-slate-900 mt-3">Action Recorded</h2>
                <p className="text-sm text-slate-500 mt-1">
                  <strong>{actionDone.action}</strong> · {actionDone.updatedExisting ? 'Added to existing journal entry' : 'New journal entry created'}
                </p>
              </div>
              <div className="bg-slate-50 rounded-xl p-4 text-sm space-y-1.5 mb-5">
                <p className="text-slate-700"><span className="font-semibold">Position:</span> {position.symbol} {posTypeLabel} ${position.strike}</p>
                <p className="text-slate-700"><span className="font-semibold">Date:</span> {actionDone.today}</p>
                <p className="text-xs text-slate-500 mt-1">
                  {actionDone.updatedExisting
                    ? 'Decision appended to Trade Thesis in the existing journal entry.'
                    : 'A new journal entry has been created with this decision in the Trade Thesis.'}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Link to="/positions" onClick={() => setActionDone(null)}
                  className="py-2 text-center text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">📈 Positions</Link>
                <Link to="/journal" onClick={() => setActionDone(null)}
                  className="py-2 text-center text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">📝 Journal</Link>
                <button onClick={() => setActionDone(null)}
                  className="py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>Continue</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </LayoutWrapper>
  );
}

// ============================================================================
// POSITION EXPIRY → CALENDAR DERIVATION
// ============================================================================

// Derives read-only calendar events from open positions that have an expiry date.
// These are never stored in the calendar state — they're computed fresh each render.
function derivePositionExpiryEvents(positions) {
  return positions
    .filter(p => p.status === 'OPEN' && p.expiry)
    .map(pos => {
      // If already in YYYY-MM-DD format use it directly — new Date("YYYY-MM-DD")
      // parses as UTC midnight which would shift the day in negative-offset timezones.
      let date;
      if (/^\d{4}-\d{2}-\d{2}$/.test(pos.expiry)) {
        date = pos.expiry;
      } else {
        const raw = new Date(pos.expiry);
        if (isNaN(raw.getTime())) return null;
        const yyyy = raw.getFullYear();
        const mm   = String(raw.getMonth() + 1).padStart(2, '0');
        const dd   = String(raw.getDate()).padStart(2, '0');
        date = `${yyyy}-${mm}-${dd}`;
      }
      if (!date) return null;

      const isOption = pos.category === 'Short Put' || pos.category === 'Covered Call';
      const contracts = pos.contracts || 1;
      const description = isOption
        ? `${pos.category} · $${pos.strike} strike · ${contracts} contract${contracts !== 1 ? 's' : ''} · $${pos.premium} premium${pos.dte != null ? ` · ${pos.dte} DTE` : ''}`
        : `${pos.category} position expiry`;

      return {
        id:          `pos-expiry-${pos.id}`,
        title:       `${pos.symbol} ${pos.category} Expiry`,
        date,
        time:        'Market Close',
        category:    'expiration',
        symbol:      pos.symbol,
        iconEmoji:   '⏰',
        description,
        notes:       pos.thesis || '',
        readOnly:    true,
      };
    })
    .filter(Boolean);
}

// ============================================================================
// CALENDAR MONTH VIEW
// ============================================================================

function CalendarMonthView({ year, month, events, onDateClick, onEventClick }) {
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today       = new Date();
  const isToday     = (d) => today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

  const eventsForDay = (d) => {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return events.filter(e => e.date === key);
  };

  const weeks = [];
  let days = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(d);
    if (days.length === 7) { weeks.push(days); days = []; }
  }
  if (days.length > 0) { while (days.length < 7) days.push(null); weeks.push(days); }

  return (
    <div>
      <div className="grid grid-cols-7 mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-center text-xs font-semibold text-slate-400 py-2">{d}</div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7 gap-px mb-px">
          {week.map((day, di) => {
            const dayEvts = day ? eventsForDay(day) : [];
            return (
              <div key={di}
                onClick={() => day && onDateClick(new Date(year, month, day))}
                className={`min-h-[72px] p-1 transition cursor-pointer ${
                  !day ? 'bg-slate-50' :
                  isToday(day) ? 'bg-purple-50 ring-2 ring-purple-400 ring-inset rounded' :
                  'bg-white border border-slate-100 hover:bg-slate-50 rounded'
                }`}>
                {day && (
                  <>
                    <p className={`text-xs font-semibold mb-1 ${isToday(day) ? 'text-purple-700' : 'text-slate-600'}`}>{day}</p>
                    <div className="space-y-0.5">
                      {dayEvts.slice(0, 2).map(e => (
                        <div key={e.id}
                          onClick={ev => { ev.stopPropagation(); onEventClick(e); }}
                          title={e.title}
                          className="text-xs px-1 py-0.5 rounded truncate font-medium text-white cursor-pointer hover:opacity-80 leading-tight"
                          style={{ backgroundColor: CAT_COLOR(e.category) }}>
                          {e.iconEmoji} {e.title}
                        </div>
                      ))}
                      {dayEvts.length > 2 && (
                        <p className="text-xs text-slate-400 pl-1">+{dayEvts.length - 2} more</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// EVENT CATEGORIES PANEL
// ============================================================================

function EventCategoriesPanel() {
  const categories        = useWheelStore(s => s.calendarCategories);
  const visibleCategories = useWheelStore(s => s.visibleCategories);
  const toggle            = useWheelStore(s => s.toggleCategoryVisibility);
  const showAll           = useWheelStore(s => s.showAllCategories);
  const hideAll           = useWheelStore(s => s.hideAllCategories);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-900">Event Categories</h3>
        <div className="flex gap-1">
          <button onClick={showAll} className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition">All</button>
          <button onClick={hideAll} className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition">None</button>
        </div>
      </div>
      <div className="space-y-2">
        {categories.map(cat => {
          const visible = visibleCategories.includes(cat.id);
          return (
            <label key={cat.id}
              onClick={() => toggle(cat.id)}
              className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-slate-50 transition select-none">
              <input type="checkbox" checked={visible} onChange={() => {}} className="w-4 h-4 cursor-pointer accent-purple-500" />
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-base">{cat.icon}</span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cat.bg} ${cat.text}`}>{cat.label}</span>
              </div>
              <span className="text-xs text-slate-400">{visible ? '👁' : '🔒'}</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-slate-400 mt-3 pt-3 border-t border-slate-100">
        {visibleCategories.length}/{categories.length} visible
      </p>
    </div>
  );
}

// ============================================================================
// EVENT DETAILS PANEL
// ============================================================================

function EventDetailsPanel() {
  const selectedEvent  = useWheelStore(s => s.selectedEvent);
  const setSelected    = useWheelStore(s => s.setSelectedEvent);
  const deleteEvent    = useWheelStore(s => s.deleteCalendarEvent);

  if (!selectedEvent) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="text-sm font-bold text-slate-900 mb-2">Event Details</h3>
        <p className="text-sm text-slate-400 italic">Click any event to view details</p>
      </div>
    );
  }

  const cat = CAT_META(selectedEvent.category);
  const dateStr = new Date(selectedEvent.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cat.bg} ${cat.text}`}>{cat.icon} {cat.label}</span>
        </div>
        <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
      </div>

      <h2 className="text-base font-bold text-slate-900 mb-3">{selectedEvent.iconEmoji} {selectedEvent.title}</h2>

      <div className="space-y-2 text-sm mb-4">
        <div><p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Date & Time</p>
          <p className="text-slate-800 font-medium">{dateStr} · {selectedEvent.time}</p></div>
        {selectedEvent.symbol && (
          <div><p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Symbol</p>
            <p className="font-bold text-slate-900">{selectedEvent.symbol}</p></div>
        )}
        {selectedEvent.description && (
          <div><p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Description</p>
            <p className="text-slate-700 text-xs leading-relaxed">{selectedEvent.description}</p></div>
        )}
        {selectedEvent.notes && (
          <div><p className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Notes</p>
            <p className="text-slate-600 text-xs">{selectedEvent.notes}</p></div>
        )}
      </div>

      {selectedEvent.readOnly ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500 italic text-center bg-orange-50 border border-orange-200 rounded-lg py-2 px-3">
            📈 Auto-generated from open position — edit in Positions tab
          </p>
          <button onClick={() => setSelected(null)}
            className="w-full py-1.5 text-xs font-semibold bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition">
            Close
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => { deleteEvent(selectedEvent.id); }}
            className="flex-1 py-1.5 text-xs font-semibold bg-red-50 text-red-700 rounded-lg hover:bg-red-100 transition">
            🗑 Delete
          </button>
          <button onClick={() => setSelected(null)}
            className="flex-1 py-1.5 text-xs font-semibold bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// UPCOMING EVENTS TIMELINE
// ============================================================================

function UpcomingEventsTimeline() {
  const calendar          = useWheelStore(s => s.calendar);
  const positions         = useWheelStore(s => s.positions);
  const visibleCategories = useWheelStore(s => s.visibleCategories);
  const setSelected       = useWheelStore(s => s.setSelectedEvent);

  const allEvents = [...calendar, ...derivePositionExpiryEvents(positions)];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today.getTime() + 60 * 86400000);

  const upcoming = allEvents
    .filter(e => {
      const d = new Date(e.date + 'T12:00:00');
      return d >= today && d <= cutoff && visibleCategories.includes(e.category);
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 8);

  const dayLabel = (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return `in ${diff}d`;
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h3 className="text-sm font-bold text-slate-900 mb-4">📅 Upcoming (60 days)</h3>
      {upcoming.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No upcoming events in visible categories</p>
      ) : (
        <div className="relative">
          <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-gradient-to-b from-purple-400 to-blue-400" />
          <div className="space-y-3 pl-6">
            {upcoming.map(event => {
              const cat = CAT_META(event.category);
              const label = dayLabel(event.date);
              const d = new Date(event.date + 'T12:00:00');
              return (
                <div key={event.id} onClick={() => setSelected(event)}
                  className="relative cursor-pointer group">
                  <div className="absolute -left-6 top-2 w-3.5 h-3.5 rounded-full border-2 border-white shadow group-hover:scale-110 transition-transform"
                    style={{ backgroundColor: cat.color }} />
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100 hover:border-purple-200 hover:shadow-sm transition">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-slate-900 group-hover:text-purple-700 truncate transition">
                          {event.iconEmoji} {event.title}
                        </p>
                        <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-xs font-semibold ${cat.bg} ${cat.text}`}>{cat.label}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-slate-500">{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                        <p className={`text-xs font-bold ${label === 'Today' ? 'text-red-600' : label === 'Tomorrow' ? 'text-orange-600' : 'text-purple-600'}`}>{label}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ADD EVENT MODAL
// ============================================================================

function AddEventModal({ onClose, defaultDate }) {
  const addEvent  = useWheelStore(s => s.addCalendarEvent);
  const today     = defaultDate ? defaultDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ title: '', date: today, time: 'All Day', category: 'personal', symbol: '', notes: '', description: '', iconEmoji: '📝' });
  const [error, setError] = useState('');

  const upd = (f, v) => setForm(p => ({ ...p, [f]: v }));
  const catEmojis = { earnings: '📊', expiration: '⏰', economic: '🏦', crypto: '₿', tesla: '⚡', personal: '📝' };

  const handleSave = () => {
    if (!form.title.trim()) { setError('Title is required'); return; }
    if (!form.date) { setError('Date is required'); return; }
    addEvent({ ...form, iconEmoji: catEmojis[form.category] || '📌' });
    onClose();
  };

  const inp = (label, field, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type={type} value={form[field]} onChange={e => upd(field, e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Add Event</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5 space-y-4 max-h-[65vh] overflow-y-auto">
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          {inp('Title', 'title', 'text', 'e.g. TSLA Earnings')}
          <div className="grid grid-cols-2 gap-3">
            {inp('Date', 'date', 'date')}
            {inp('Time', 'time', 'text', 'e.g. 2:00 PM ET')}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Category</label>
            <select value={form.category} onChange={e => upd('category', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
              {CALENDAR_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
            </select>
          </div>
          {inp('Symbol (optional)', 'symbol', 'text', 'e.g. TSLA')}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Description</label>
            <textarea value={form.description} onChange={e => upd('description', e.target.value)} rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-purple-500" />
          </div>
          {inp('Notes', 'notes', 'text', 'Short note...')}
        </div>
        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
            Add Event
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CALENDAR PAGE
// ============================================================================

function Calendar() {
  const calendar          = useWheelStore(s => s.calendar);
  const positions         = useWheelStore(s => s.positions);
  const visibleCategories = useWheelStore(s => s.visibleCategories);
  const setSelected       = useWheelStore(s => s.setSelectedEvent);

  const [year,         setYear]         = useState(new Date().getFullYear());
  const [month,        setMonth]        = useState(new Date().getMonth());
  const [showAddModal, setShowAddModal] = useState(false);
  const [addDate,      setAddDate]      = useState(null);

  // Merge stored events with position-derived expiry events
  const allEvents     = [...calendar, ...derivePositionExpiryEvents(positions)];
  const visibleEvents = allEvents.filter(e => visibleCategories.includes(e.category));

  const monthEvents = visibleEvents.filter(e => {
    const d = new Date(e.date + 'T12:00:00');
    return d.getFullYear() === year && d.getMonth() === month;
  });

  const navigate = (dir) => {
    if (dir === 0) { setYear(new Date().getFullYear()); setMonth(new Date().getMonth()); return; }
    let m = month + dir, y = year;
    if (m > 11) { m = 0; y++; } else if (m < 0) { m = 11; y--; }
    setMonth(m); setYear(y);
  };

  const handleExportCalendar = () => {
    const rows = allEvents.map(e => ({
      Title:       e.title,
      Date:        e.date,
      Time:        e.time || '',
      Category:    e.category,
      Symbol:      e.symbol || '',
      Description: e.description || '',
      Notes:       e.notes || '',
      IconEmoji:   e.iconEmoji || '',
    })).sort((a, b) => a.Date.localeCompare(b.Date));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length + 2, 16) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Calendar Events');
    XLSX.writeFile(wb, `wheel-edge-calendar-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const monthLabel = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Calendar
            </h1>
            <p className="text-slate-600">Track market events, earnings, expirations, and milestones</p>
          </div>
          <button onClick={handleExportCalendar}
            className="px-4 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition flex items-center gap-2">
            📥 Export Excel
          </button>
        </div>

        <div className="grid grid-cols-12 gap-5">

          {/* Left sidebar */}
          <div className="col-span-2 space-y-4">
            <EventCategoriesPanel />
            <EventDetailsPanel />
          </div>

          {/* Month grid */}
          <div className="col-span-7 bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-slate-900">{monthLabel}</h2>
              <div className="flex gap-2">
                <button onClick={() => navigate(-1)} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition">← Prev</button>
                <button onClick={() => navigate(0)}  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition">Today</button>
                <button onClick={() => navigate(1)}  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition">Next →</button>
                <button onClick={() => { setAddDate(null); setShowAddModal(true); }}
                  className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  + Add Event
                </button>
              </div>
            </div>
            <CalendarMonthView
              year={year} month={month}
              events={monthEvents}
              onDateClick={(d) => { setAddDate(d); setShowAddModal(true); }}
              onEventClick={(e) => setSelected(e)}
            />
          </div>

          {/* Right sidebar */}
          <div className="col-span-3">
            <UpcomingEventsTimeline />
          </div>
        </div>
      </div>

      {showAddModal && <AddEventModal onClose={() => setShowAddModal(false)} defaultDate={addDate} />}
    </LayoutWrapper>
  );
}

function RotationWatchlist() {
  const watchlist          = useWheelStore(s => s.watchlist);
  const mode               = useWheelStore(s => s.watchlistMode);
  const setMode            = useWheelStore(s => s.setWatchlistMode);
  const updateItem         = useWheelStore(s => s.updateWatchlistItem);
  const addItem            = useWheelStore(s => s.addWatchlistItem);
  const deleteItem         = useWheelStore(s => s.deleteWatchlistItem);

  const [editingId, setEditingId]     = useState(null);
  const [editForm, setEditForm]       = useState({});
  const [showAddRow, setShowAddRow]   = useState(false);
  const [newRow, setNewRow]           = useState({ symbol: '', price: '', trend: 'Bullish', support: '', resistance: '', bias: 'Neutral', notes: '' });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const isManual = mode === 'MANUAL';

  const startEdit = (item) => { setEditingId(item.id); setEditForm({ ...item }); };
  const cancelEdit = () => { setEditingId(null); setEditForm({}); };
  const saveEdit = () => { updateItem(editingId, editForm); setEditingId(null); setEditForm({}); };
  const upd = (f, v) => setEditForm(p => ({ ...p, [f]: v }));
  const updNew = (f, v) => setNewRow(p => ({ ...p, [f]: v }));

  const handleAddRow = () => {
    if (!newRow.symbol.trim()) return;
    addItem({ ...newRow, price: Number(newRow.price) || 0, support: Number(newRow.support) || 0, resistance: Number(newRow.resistance) || 0 });
    setNewRow({ symbol: '', price: '', trend: 'Bullish', support: '', resistance: '', bias: 'Neutral', notes: '' });
    setShowAddRow(false);
  };

  const handleExport = () => {
    const rows = watchlist.map(w => ({
      Symbol: w.symbol, Price: w.price, Trend: w.trend,
      Support: w.support, Resistance: w.resistance, Bias: w.bias, Notes: w.notes,
      'Last Updated': w.lastUpdated ? new Date(w.lastUpdated).toLocaleDateString() : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length + 2, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Watchlist');
    XLSX.writeFile(wb, `wheel-edge-watchlist-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const trendColor = t => t === 'Bullish' ? 'text-green-600' : t === 'Bearish' ? 'text-red-600' : 'text-slate-600';
  const cellInput = (field, type = 'text', placeholder = '') => (
    <input type={type} step={type === 'number' ? 'any' : undefined}
      value={editForm[field] ?? ''} onChange={e => upd(field, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
      placeholder={placeholder}
      className="w-full px-2 py-1 border border-purple-300 rounded text-sm focus:ring-1 focus:ring-purple-500 bg-white" />
  );
  const newInput = (field, type = 'text', placeholder = '') => (
    <input type={type} step={type === 'number' ? 'any' : undefined}
      value={newRow[field]} onChange={e => updNew(field, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
      placeholder={placeholder}
      className="w-full px-2 py-1 border border-blue-300 rounded text-sm focus:ring-1 focus:ring-blue-500 bg-blue-50" />
  );
  const selectInput = (field, options, form, updFn) => (
    <select value={form[field]} onChange={e => updFn(field, e.target.value)}
      className="w-full px-2 py-1 border border-purple-300 rounded text-sm bg-white focus:ring-1 focus:ring-purple-500">
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Rotation Watchlist
            </h1>
            <p className="text-slate-600">Monitor symbols for wheel trading rotation</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleExport}
              className="px-4 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition">
              📥 Export Excel
            </button>
            {isManual && (
              <button onClick={() => setShowAddRow(v => !v)}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg shadow"
                style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                + Add Symbol
              </button>
            )}
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200">
          <span className="text-sm font-semibold text-slate-600">Data Source:</span>
          <div className="flex rounded-lg overflow-hidden border border-slate-300">
            <button onClick={() => setMode('MANUAL')}
              className={`px-4 py-2 text-sm font-semibold transition ${isManual ? 'bg-purple-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              ✏️ Manual
            </button>
            <button onClick={() => setMode('LIVE')} disabled
              className="px-4 py-2 text-sm font-semibold bg-white text-slate-400 cursor-not-allowed border-l border-slate-300"
              title="Connect Tiger API in Settings to enable live mode">
              🔴 Live (API Required)
            </button>
          </div>
          {isManual ? (
            <span className="text-xs text-slate-500 bg-purple-50 border border-purple-200 px-2 py-1 rounded-lg">
              ✏️ Manual mode — click any row to edit, prices are entered manually
            </span>
          ) : (
            <span className="text-xs text-orange-700 bg-orange-50 border border-orange-200 px-2 py-1 rounded-lg">
              ⚠ Live mode requires Tiger API market data subscription. Enable in Settings.
            </span>
          )}
        </div>

        {/* Table */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-200">
              <tr>
                {['Symbol', 'Price', 'Trend', 'Support', 'Resistance', 'Bias', 'Notes', 'Last Updated', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {watchlist.map((item, idx) => {
                const isEditing = editingId === item.id;
                return (
                  <tr key={item.id} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'} ${isEditing ? 'ring-2 ring-inset ring-purple-300' : ''}`}>
                    {isEditing ? (
                      <>
                        <td className="px-3 py-2">{cellInput('symbol')}</td>
                        <td className="px-3 py-2">{cellInput('price', 'number', '0.00')}</td>
                        <td className="px-3 py-2">{selectInput('trend', ['Bullish', 'Neutral', 'Bearish'], editForm, upd)}</td>
                        <td className="px-3 py-2">{cellInput('support', 'number')}</td>
                        <td className="px-3 py-2">{cellInput('resistance', 'number')}</td>
                        <td className="px-3 py-2">{selectInput('bias', ['Bullish', 'Slightly Bullish', 'Neutral', 'Slightly Bearish', 'Bearish'], editForm, upd)}</td>
                        <td className="px-3 py-2">{cellInput('notes', 'text', 'Notes…')}</td>
                        <td className="px-3 py-2 text-xs text-slate-400">now</td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1.5">
                            <button onClick={saveEdit}
                              className="px-2 py-1 text-xs font-semibold text-white bg-purple-600 rounded hover:bg-purple-700">✓ Save</button>
                            <button onClick={cancelEdit}
                              className="px-2 py-1 text-xs font-semibold text-slate-600 bg-slate-200 rounded hover:bg-slate-300">Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 font-bold text-slate-900">{item.symbol}</td>
                        <td className="px-4 py-3 text-slate-700 font-semibold">
                          {item.price ? `$${item.price}` : <span className="text-slate-400 italic text-xs">—</span>}
                          {!isManual && <span className="ml-1 text-xs text-green-500 animate-pulse">●</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`font-semibold ${trendColor(item.trend)}`}>{item.trend}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{item.support ? `$${item.support}` : '—'}</td>
                        <td className="px-4 py-3 text-slate-700">{item.resistance ? `$${item.resistance}` : '—'}</td>
                        <td className="px-4 py-3 text-slate-600 text-sm">{item.bias || '—'}</td>
                        <td className="px-4 py-3 text-slate-500 text-sm max-w-xs truncate" title={item.notes}>{item.notes || '—'}</td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          {item.lastUpdated ? new Date(item.lastUpdated).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {confirmDeleteId === item.id ? (
                            <div className="flex gap-1.5 items-center">
                              <span className="text-xs text-red-600 font-semibold">Delete?</span>
                              <button onClick={() => { deleteItem(item.id); setConfirmDeleteId(null); }}
                                className="px-2 py-1 text-xs font-semibold bg-red-600 text-white rounded">Yes</button>
                              <button onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1 text-xs font-semibold bg-slate-200 text-slate-700 rounded">No</button>
                            </div>
                          ) : (
                            <div className="flex gap-1.5">
                              {isManual && (
                                <button onClick={() => startEdit(item)}
                                  className="px-2 py-1 text-xs font-semibold text-purple-700 bg-purple-100 rounded hover:bg-purple-200">
                                  ✏️ Edit
                                </button>
                              )}
                              <button onClick={() => setConfirmDeleteId(item.id)}
                                className="px-2 py-1 text-xs font-semibold text-red-700 bg-red-100 rounded hover:bg-red-200">🗑️</button>
                            </div>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}

              {/* Add Row form */}
              {showAddRow && (
                <tr className="bg-blue-50 border-t-2 border-blue-300">
                  <td className="px-3 py-2">{newInput('symbol', 'text', 'e.g. TSLA')}</td>
                  <td className="px-3 py-2">{newInput('price', 'number', '0.00')}</td>
                  <td className="px-3 py-2">{selectInput('trend', ['Bullish', 'Neutral', 'Bearish'], newRow, updNew)}</td>
                  <td className="px-3 py-2">{newInput('support', 'number', 'e.g. 380')}</td>
                  <td className="px-3 py-2">{newInput('resistance', 'number', 'e.g. 420')}</td>
                  <td className="px-3 py-2">{selectInput('bias', ['Bullish', 'Slightly Bullish', 'Neutral', 'Slightly Bearish', 'Bearish'], newRow, updNew)}</td>
                  <td className="px-3 py-2">{newInput('notes', 'text', 'Notes…')}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">new</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      <button onClick={handleAddRow}
                        className="px-2 py-1 text-xs font-semibold text-white bg-blue-600 rounded hover:bg-blue-700">+ Add</button>
                      <button onClick={() => setShowAddRow(false)}
                        className="px-2 py-1 text-xs font-semibold text-slate-600 bg-slate-200 rounded hover:bg-slate-300">Cancel</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {watchlist.length === 0 && !showAddRow && (
          <div className="text-center py-8">
            <p className="text-slate-400 text-sm">No symbols in watchlist.</p>
            <button onClick={() => setShowAddRow(true)}
              className="mt-2 text-sm text-purple-600 hover:underline font-semibold">+ Add your first symbol</button>
          </div>
        )}
      </div>
    </LayoutWrapper>
  );
}

// ============================================================================
// INCOME TRACKER HELPERS
// ============================================================================

function computeIncome(positions, journal) {
  const entries = [];

  // Build a set of position IDs so the journal loop can skip linked entries
  const positionIdSet = new Set(positions.map(p => p.id));

  positions.forEach((pos) => {
    if ((pos.premium || 0) > 0) {
      entries.push({
        id:       `pos-${pos.id}`,
        date:     pos.entryDate || '',
        symbol:   pos.symbol,
        source:   'position',
        sourceId: pos.id,
        strategy: pos.category === 'Covered Call' ? 'Covered Call'
                : pos.category === 'Short Put'    ? 'Put'
                : pos.category,
        premium:  pos.premium,
        status:   pos.status === 'CLOSED' ? 'Closed' : 'Active',
      });
    }
  });

  // Only include journal entries that are NOT linked to an existing position.
  // Linked entries would double-count premium already captured from pos.premium.
  journal.forEach((entry) => {
    if (entry.positionId && positionIdSet.has(entry.positionId)) return;

    const match = (entry.result || '').match(/\+\$(\d[\d,.]*)/);
    if (match) {
      const premium = parseFloat(match[1].replace(/,/g, ''));
      if (!premium || premium <= 0) return;
      let strategy = 'Put';
      if ((entry.tags || []).includes('cc') || (entry.trade || '').toLowerCase().includes('covered')) strategy = 'Covered Call';
      else if ((entry.tags || []).includes('wheel')) strategy = 'Wheel';
      entries.push({
        id:       `journal-${entry.id}`,
        date:     entry.date,
        symbol:   entry.symbol,
        source:   'journal',
        sourceId: entry.id,
        strategy,
        premium,
        status:   'Closed',
      });
    }
  });

  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const yearly = entries.reduce((s, e) => s + e.premium, 0);

  const monthMap = {};
  entries.forEach((e) => {
    const key = (e.date || '').slice(0, 7);
    if (!key) return;
    if (!monthMap[key]) monthMap[key] = { premium: 0, count: 0 };
    monthMap[key].premium += e.premium;
    monthMap[key].count += 1;
  });
  const monthly = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key,
      label: new Date(key + '-02').toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      premium: v.premium,
      count: v.count,
      avgPerTrade: Math.round(v.premium / v.count),
    }));

  const symMap = {};
  entries.forEach((e) => {
    if (!symMap[e.symbol]) symMap[e.symbol] = { premium: 0, count: 0 };
    symMap[e.symbol].premium += e.premium;
    symMap[e.symbol].count += 1;
  });
  const bySymbol = Object.entries(symMap)
    .map(([symbol, v]) => ({ symbol, premium: v.premium, count: v.count, pct: yearly ? Math.round((v.premium / yearly) * 100) : 0 }))
    .sort((a, b) => b.premium - a.premium);

  const strMap = {};
  entries.forEach((e) => {
    if (!strMap[e.strategy]) strMap[e.strategy] = { premium: 0, count: 0 };
    strMap[e.strategy].premium += e.premium;
    strMap[e.strategy].count += 1;
  });
  const byStrategy = Object.entries(strMap)
    .map(([strategy, v]) => ({ strategy, premium: v.premium, count: v.count, pct: yearly ? Math.round((v.premium / yearly) * 100) : 0 }))
    .sort((a, b) => b.premium - a.premium);

  const avgPerMonth = monthly.length > 0 ? Math.round(yearly / monthly.length) : 0;
  const allDates = entries.map((e) => new Date(e.date)).filter((d) => !isNaN(d));
  let projectedYearly = yearly;
  if (allDates.length >= 2) {
    const minD = new Date(Math.min(...allDates));
    const maxD = new Date(Math.max(...allDates));
    const span = Math.max(1, Math.round((maxD - minD) / 86400000));
    projectedYearly = Math.round((yearly / span) * 365);
  }

  return { entries, yearly, monthly, bySymbol, byStrategy, avgPerMonth, projectedYearly };
}

// ============================================================================
// INCOME TRACKER HELPERS
// ============================================================================

const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#6366f1'];
const MONTH_NAMES  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Per-stock aggregated scoreboard — all time + current-month contribution
function computeStockScoreboard(positions, monthKey) {
  const isOpt = p => isOptCat(p.category);
  const map   = {};
  positions.filter(isOpt).forEach(pos => {
    const sym = pos.symbol;
    if (!map[sym]) map[sym] = { symbol: sym, premiumCollected: 0, realizedProfit: 0, openExposure: 0, monthlyPremium: 0 };
    map[sym].premiumCollected += pos.premium || 0;
    if (pos.status === 'CLOSED' && pos.closedData != null) map[sym].realizedProfit += (pos.closedData.realizedPnL || 0);
    if (pos.status === 'OPEN')  map[sym].openExposure  += pos.premium || 0;
    if ((pos.entryDate || '').startsWith(monthKey)) map[sym].monthlyPremium += pos.premium || 0;
  });
  const monthTotal = Object.values(map).reduce((s, v) => s + v.monthlyPremium, 0);
  return Object.values(map)
    .map(s => ({
      ...s,
      roi:                   s.premiumCollected > 0 ? (s.realizedProfit / s.premiumCollected) * 100 : 0,
      monthlyContributionPct: monthTotal > 0 ? Math.round((s.monthlyPremium / monthTotal) * 100) : 0,
    }))
    .sort((a, b) => b.realizedProfit - a.realizedProfit);
}

// Full-year monthly breakdown with per-month goal tracking
function computeYearlyMonthly(positions, yearStr, monthlyGoals) {
  const isOpt  = p => p.category === 'Short Put' || p.category === 'Covered Call';
  const goals  = monthlyGoals[yearStr] || {};
  return Array.from({ length: 12 }, (_, i) => {
    const m   = i + 1;
    const key = `${yearStr}-${String(m).padStart(2, '0')}`;
    const premium  = positions.filter(p => isOpt(p) && (p.premium || 0) > 0 && (p.entryDate || '').startsWith(key)).reduce((s, p) => s + p.premium, 0);
    const realized = positions.filter(p => p.status === 'CLOSED' && p.closedData != null && (p.closedData.closedDate || p.entryDate || '').startsWith(key)).reduce((s, p) => s + (p.closedData.realizedPnL || 0), 0);
    const count    = positions.filter(p => isOpt(p) && (p.entryDate || '').startsWith(key)).length;
    const goal     = goals[m] || 0;
    const goalPct  = goal > 0 ? Math.min(100, Math.round((premium / goal) * 100)) : null;
    return { key, label: MONTH_NAMES[i], m, premium, realized, count, goal, goalPct };
  });
}

// Simple SVG donut chart — no external dependencies
function SimplePieChart({ data, size = 180 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <div className="flex items-center justify-center h-44 text-slate-400 text-sm italic">No data</div>;
  const cx = size / 2, cy = size / 2, r = size * 0.38, ir = size * 0.22;
  let cum = -Math.PI / 2;
  const slices = data.map(d => {
    const angle = (d.value / total) * 2 * Math.PI;
    const sa = cum; cum += angle; const ea = cum;
    const cos = (a, radius) => cx + radius * Math.cos(a);
    const sin = (a, radius) => cy + radius * Math.sin(a);
    const la   = angle > Math.PI ? 1 : 0;
    const path = `M${cos(sa,r)},${sin(sa,r)} A${r},${r} 0 ${la} 1 ${cos(ea,r)},${sin(ea,r)} L${cos(ea,ir)},${sin(ea,ir)} A${ir},${ir} 0 ${la} 0 ${cos(sa,ir)},${sin(sa,ir)}Z`;
    return { ...d, path, pct: Math.round((d.value / total) * 100) };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto block">
      {slices.map((s, i) => (
        <path key={i} d={s.path} fill={s.color} stroke="white" strokeWidth="2">
          <title>{s.label}: ${s.value.toLocaleString()} ({s.pct}%)</title>
        </path>
      ))}
    </svg>
  );
}

// ============================================================================
// INCOME TRACKER PAGE
// ============================================================================

function IncomeTracker() {
  const positions      = useWheelStore(s => s.positions);
  const journal        = useWheelStore(s => s.journal);
  const campaigns      = useWheelStore(s => s.campaigns);
  const monthlyGoals   = useWheelStore(s => s.monthlyGoals);
  const setMonthlyGoal = useWheelStore(s => s.setMonthlyGoal);

  const income = computeIncome(positions, journal);

  const today        = new Date();
  const currentMonth = today.getMonth() + 1;

  const [selectedYear,  setSelectedYear]  = useState(today.getFullYear());
  const [logFilter,     setLogFilter]     = useState({ symbol: '', strategy: '', status: '', month: '' });
  const [editingGoal,   setEditingGoal]   = useState(null); // month number being edited
  const [goalDraft,     setGoalDraft]     = useState('');

  const monthKey     = `${selectedYear}-${String(currentMonth).padStart(2,'0')}`;
  const yearGoals    = monthlyGoals[String(selectedYear)] || {};
  const currentGoal  = yearGoals[currentMonth] || 0;
  const isOpt        = p => p.category === 'Short Put' || p.category === 'Covered Call';

  // ── Monthly metrics for current month ────────────────────────────────────
  const premiumThisMonth = positions
    .filter(p => isOpt(p) && (p.premium || 0) > 0 && (p.entryDate || '').startsWith(monthKey))
    .reduce((s, p) => s + p.premium, 0);

  const realizedThisMonth = positions
    .filter(p => p.status === 'CLOSED' && p.closedData != null && (p.closedData.closedDate || '').startsWith(monthKey))
    .reduce((s, p) => s + (p.closedData.realizedPnL || 0), 0);

  // Commission metrics — separate from premium/P&L at all times
  const commissionsThisMonth = positions
    .filter(p => (p.commission || 0) > 0 && (p.entryDate || '').startsWith(monthKey))
    .reduce((s, p) => s + (p.commission || 0), 0);
  const commissionsThisYear = positions
    .filter(p => (p.commission || 0) > 0 && (p.entryDate || '').startsWith(String(selectedYear)))
    .reduce((s, p) => s + (p.commission || 0), 0);
  const commissionsAllTime = positions.reduce((s, p) => s + (p.commission || 0), 0);
  const netPremiumThisMonth = premiumThisMonth - commissionsThisMonth;

  // ── Ledger totals (all-time) ─────────────────────────────────────────────
  // Gross Capital = all Cash capitalAmounts (open + closed) + share purchase values
  const grossCapital = positions
    .filter(p => p.category === 'Cash')
    .reduce((s, p) => s + (p.capitalAmount || 0), 0)
    + positions
    .filter(p => p.category === 'Long Shares')
    .reduce((s, p) => s + effectiveCostBasis(p) * (p.shareCount || 0), 0);

  // Realized Profit all-time
  const realizedAllTime = positions
    .filter(p => p.status === 'CLOSED' && p.closedData != null)
    .reduce((s, p) => s + (p.closedData.realizedPnL || 0), 0);

  // Net After Commissions = Gross Capital + Realized Profit − All Commissions
  const netAfterCommissions = grossCapital + realizedAllTime - commissionsAllTime;

  const goalPct       = currentGoal > 0 ? Math.min(100, Math.round((premiumThisMonth / currentGoal) * 100)) : 0;
  const goalRemaining = Math.max(0, currentGoal - premiumThisMonth);
  const goalAchieved  = currentGoal > 0 && premiumThisMonth >= currentGoal;
  const goalBarColor  = goalPct >= 80 ? 'bg-green-500' : goalPct >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  const goalTextColor = goalPct >= 80 ? 'text-green-600' : goalPct >= 50 ? 'text-yellow-600' : 'text-red-600';

  // ── Scoreboard + breakdown ────────────────────────────────────────────────
  const stockBoard    = computeStockScoreboard(positions, monthKey);
  const yearlyMonthly = computeYearlyMonthly(positions, String(selectedYear), monthlyGoals);

  const pieData = stockBoard
    .filter(s => s.monthlyPremium > 0)
    .map((s, i) => ({ label: s.symbol, value: s.monthlyPremium, color: CHART_COLORS[i % CHART_COLORS.length], pct: s.monthlyContributionPct }));

  // ── Campaign performance ──────────────────────────────────────────────────
  const campaignMetrics = campaigns.map(campaign => {
    const camPos = positions.filter(p => p.campaignId === campaign.id);
    const { netPremium: premiumCollected, realizedPnL: realizedProfit } = calcCampaignProfit(camPos);
    const openPos      = camPos.filter(p => p.status === 'OPEN');
    const openExposure = openPos.filter(isOpt).reduce((s, p) => s + (p.premium || 0), 0);
    const openCount    = camPos.filter(p => p.status === 'OPEN').length;
    const closedCount  = camPos.filter(p => p.status === 'CLOSED').length;
    const cats = new Set(camPos.map(p => p.category));
    let strategy = 'Custom Strategy';
    if (cats.has('Short Put') && (cats.has('Covered Call') || cats.has('Long Shares'))) strategy = 'Wheel';
    else if (cats.has('Covered Call')) strategy = 'Covered Call';
    else if (cats.has('Short Put'))    strategy = 'Short Put';
    const roi = premiumCollected > 0 ? ((realizedProfit / premiumCollected) * 100).toFixed(1) : null;
    return { id: campaign.id, name: campaign.name, strategy, premiumCollected, realizedProfit, openExposure, openCount, closedCount, isActive: openCount > 0, roi, totalTrades: camPos.length };
  }).filter(c => c.totalTrades > 0);

  const topCampaign = campaignMetrics.length > 0 ? [...campaignMetrics].sort((a, b) => (Number(b.roi) || 0) - (Number(a.roi) || 0))[0] : null;

  // ── Income log filtering ──────────────────────────────────────────────────
  const yearEntries = income.entries.filter(e => (e.date || '').startsWith(String(selectedYear)));
  const filtered    = yearEntries.filter(e => {
    if (logFilter.symbol   && e.symbol   !== logFilter.symbol)   return false;
    if (logFilter.strategy && e.strategy !== logFilter.strategy) return false;
    if (logFilter.status   && e.status   !== logFilter.status)   return false;
    if (logFilter.month    && !(e.date || '').startsWith(`${selectedYear}-${logFilter.month.padStart(2,'0')}`)) return false;
    return true;
  });

  const allSymbols    = [...new Set(income.entries.map(e => e.symbol))].sort();
  const allStrategies = [...new Set(income.entries.map(e => e.strategy))].sort();
  const YEARS = ['2026', '2027', '2028'];

  const strategyBadge = { 'Wheel':'bg-purple-100 text-purple-700', 'Covered Call':'bg-green-100 text-green-700', 'Put':'bg-red-100 text-red-700' };
  const strategyGradient = { 'Wheel':'from-purple-500 to-blue-500', 'Covered Call':'from-green-500 to-emerald-500', 'Put':'from-red-500 to-orange-500' };
  const campaignStrategyBadge = {
    'Wheel':'bg-purple-100 text-purple-700', 'Covered Call':'bg-green-100 text-green-700',
    'Short Put':'bg-red-100 text-red-700', 'Custom Strategy':'bg-slate-100 text-slate-700',
  };

  const exportCSV = () => {
    const hdr  = ['Date','Symbol','Strategy','Premium','Source','Status'];
    const rows = income.entries.map(e => [e.date, e.symbol, e.strategy, e.premium, e.source, e.status]);
    const csv  = [hdr, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'wheel-edge-income.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const saveGoal = (month, value) => {
    const n = parseFloat(value);
    if (!isNaN(n) && n >= 0) setMonthlyGoal(selectedYear, month, Math.round(n));
    setEditingGoal(null);
  };

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-8">

        {/* ── HEADER ──────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-1" style={{ fontFamily: 'Playfair Display, serif' }}>
              Income & Premium Dashboard
            </h1>
            <p className="text-slate-500 text-sm">Premium collected, realized profit, and goal tracking · {selectedYear}</p>
          </div>
          <div className="flex gap-2 items-center">
            <select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white font-semibold text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={exportCSV}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg shadow"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
              📥 Export CSV
            </button>
          </div>
        </div>

        {/* ── ROW 1: 5 SUMMARY CARDS ──────────────────────────────────── */}
        <div className="grid grid-cols-5 gap-4">

          {/* Monthly Goal */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Monthly Goal</p>
            {editingGoal === currentMonth ? (
              <input autoFocus type="number" value={goalDraft}
                onChange={e => setGoalDraft(e.target.value)}
                onBlur={() => saveGoal(currentMonth, goalDraft)}
                onKeyDown={e => { if (e.key === 'Enter') saveGoal(currentMonth, goalDraft); if (e.key === 'Escape') setEditingGoal(null); }}
                className="text-3xl font-bold text-slate-900 w-full border-b-2 border-blue-400 focus:outline-none bg-transparent" placeholder="1500" />
            ) : (
              <div className="flex items-baseline gap-2 group cursor-pointer"
                onClick={() => { setEditingGoal(currentMonth); setGoalDraft(String(currentGoal)); }}>
                <p className="text-3xl font-bold text-slate-900">{currentGoal > 0 ? `$${currentGoal.toLocaleString()}` : '—'}</p>
                <span className="text-xs text-slate-300 group-hover:text-blue-400 transition">✏️</span>
              </div>
            )}
            <p className="text-xs text-slate-400 mt-1">{MONTH_NAMES[currentMonth - 1]} {selectedYear} target</p>
          </div>

          {/* Premium This Month */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Premium Collected</p>
            <p className="text-3xl font-bold text-green-600">${premiumThisMonth.toLocaleString()}</p>
            <p className="text-xs text-slate-400 mt-1">All credits · {MONTH_NAMES[currentMonth - 1]}</p>
            {commissionsThisMonth > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs text-amber-600 font-semibold">Commissions (drag)</span>
                <span className="text-xs font-bold text-red-500">-${commissionsThisMonth.toFixed(2)}</span>
              </div>
            )}
            {commissionsThisMonth > 0 && (
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs text-slate-500">Net this month</span>
                <span className={`text-xs font-bold ${netPremiumThisMonth >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  ${netPremiumThisMonth.toFixed(2)}
                </span>
              </div>
            )}
          </div>

          {/* Realized Profit This Month */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Realized Profit</p>
            <p className={`text-3xl font-bold ${realizedThisMonth >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {realizedThisMonth >= 0 ? '+' : ''}${Math.abs(realizedThisMonth).toLocaleString()}
            </p>
            <p className="text-xs text-slate-400 mt-1">Closed trades only · {MONTH_NAMES[currentMonth - 1]}</p>
          </div>

          {/* Commissions YTD card */}
          <div className={`rounded-xl border shadow-sm p-5 ${commissionsThisYear > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Commissions YTD</p>
            <p className={`text-3xl font-bold ${commissionsThisYear > 0 ? 'text-red-500' : 'text-slate-300'}`}>
              {commissionsThisYear > 0 ? `-$${commissionsThisYear.toFixed(2)}` : '$0.00'}
            </p>
            <p className="text-xs text-slate-400 mt-1">Drag on performance · {selectedYear}</p>
          </div>

          {/* Goal Completion */}
          <div className={`rounded-xl border shadow-sm p-5 ${goalAchieved ? 'bg-green-50 border-green-200' : 'bg-white border-slate-200'}`}>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Goal Completion</p>
            <p className={`text-3xl font-bold ${goalTextColor}`}>{currentGoal > 0 ? `${goalPct}%` : '—'}</p>
            <p className="text-xs text-slate-400 mt-1">
              {goalAchieved ? '🎯 Goal achieved!' : currentGoal > 0 ? `$${goalRemaining.toLocaleString()} remaining` : 'Set a goal above'}
            </p>
          </div>
        </div>

        {/* ── ROW 2: PROGRESS BAR ─────────────────────────────────────── */}
        {currentGoal > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 py-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-sm font-bold text-slate-800">Monthly Goal Progress</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Goal: ${currentGoal.toLocaleString()} · Collected: ${premiumThisMonth.toLocaleString()} · {MONTH_NAMES[currentMonth - 1]} {selectedYear}
                </p>
              </div>
              <span className={`text-2xl font-bold ${goalTextColor}`}>{goalPct}%</span>
            </div>
            <div className="w-full h-5 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full ${goalBarColor} rounded-full transition-all duration-700 flex items-center justify-end pr-2`}
                style={{ width: `${Math.max(goalPct > 0 ? 4 : 0, goalPct)}%` }}>
                {goalPct >= 20 && <span className="text-white text-xs font-bold">${premiumThisMonth.toLocaleString()}</span>}
              </div>
            </div>
            <p className={`text-xs mt-2 font-semibold ${goalAchieved ? 'text-green-600' : 'text-slate-500'}`}>
              {goalAchieved
                ? '🎯 Monthly goal reached — consider reducing new positions to avoid overtrading.'
                : `$${goalRemaining.toLocaleString()} more premium needed to reach the ${MONTH_NAMES[currentMonth - 1]} goal.`}
            </p>
          </div>
        )}

        {/* ── LEDGER SUMMARY ──────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Account Ledger Summary</h3>
              <p className="text-xs text-slate-500 mt-0.5">All-time · commissions tracked separately, never mixed into P&L</p>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-slate-200 text-slate-600 font-semibold">All Time</span>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-4 gap-0 divide-x divide-slate-100">
              {/* Gross Capital */}
              <div className="px-5 first:pl-0">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Gross Capital</p>
                <p className="text-2xl font-bold text-slate-900">${grossCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <p className="text-xs text-slate-400 mt-1">Cash + shares deployed</p>
              </div>
              {/* Realized Profit */}
              <div className="px-5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">+ Realized Profit</p>
                <p className={`text-2xl font-bold ${realizedAllTime >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {realizedAllTime >= 0 ? '+' : '−'}${Math.abs(realizedAllTime).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-slate-400 mt-1">Closed positions only</p>
              </div>
              {/* Commissions */}
              <div className="px-5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">− Commissions</p>
                <p className={`text-2xl font-bold ${commissionsAllTime > 0 ? 'text-red-500' : 'text-slate-300'}`}>
                  {commissionsAllTime > 0 ? `-$${commissionsAllTime.toFixed(2)}` : '$0.00'}
                </p>
                <p className="text-xs text-slate-400 mt-1">All broker fees paid</p>
                {commissionsThisYear > 0 && (
                  <p className="text-xs text-amber-600 font-semibold mt-0.5">{new Date().getFullYear()} YTD: -${commissionsThisYear.toFixed(2)}</p>
                )}
              </div>
              {/* Net After Commissions */}
              <div className="px-5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">= Net After Commissions</p>
                <p className={`text-2xl font-bold ${netAfterCommissions >= grossCapital ? 'text-emerald-600' : netAfterCommissions >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                  ${netAfterCommissions.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-slate-400 mt-1">Gross + Realized − Commissions</p>
                {grossCapital > 0 && (
                  <p className={`text-xs font-semibold mt-0.5 ${(netAfterCommissions - grossCapital) >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {(netAfterCommissions - grossCapital) >= 0 ? '+' : '−'}${Math.abs(netAfterCommissions - grossCapital).toFixed(2)} vs gross
                  </p>
                )}
              </div>
            </div>

            {/* Waterfall bar */}
            {grossCapital > 0 && (
              <div className="mt-5 pt-4 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Ledger Waterfall</p>
                <div className="flex items-center gap-1 text-xs">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 font-semibold text-slate-700">
                    <span>Capital</span><span className="font-bold">${grossCapital.toLocaleString()}</span>
                  </div>
                  <span className="text-slate-400 font-bold">+</span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold ${realizedAllTime >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                    <span>Realized</span>
                    <span className="font-bold">{realizedAllTime >= 0 ? '+' : ''}${realizedAllTime.toFixed(2)}</span>
                  </div>
                  <span className="text-slate-400 font-bold">−</span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold ${commissionsAllTime > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
                    <span>Commissions</span>
                    <span className="font-bold">${commissionsAllTime.toFixed(2)}</span>
                  </div>
                  <span className="text-slate-400 font-bold">=</span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold ${netAfterCommissions >= grossCapital ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-800'}`}>
                    <span>Net</span>
                    <span>${netAfterCommissions.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── ROW 3: PIE CHART + STOCK SCOREBOARD ─────────────────────── */}
        <div className="grid grid-cols-12 gap-6">

          {/* Pie chart */}
          <div className="col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h3 className="text-sm font-bold text-slate-800 mb-0.5">Income by Stock</h3>
            <p className="text-xs text-slate-400 mb-4">{MONTH_NAMES[currentMonth - 1]} {selectedYear} contributions</p>
            {pieData.length === 0 ? (
              <div className="flex items-center justify-center h-44 text-slate-400 text-sm italic">No premium this month</div>
            ) : (
              <>
                <SimplePieChart data={pieData} size={170} />
                <div className="space-y-2 mt-4">
                  {pieData.map(d => (
                    <div key={d.label} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                        <span className="text-xs font-semibold text-slate-700">{d.label}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-bold text-slate-900">${d.value.toLocaleString()}</span>
                        <span className="text-xs text-slate-400 ml-1.5">{d.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Stock Scoreboard */}
          <div className="col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-800">Stock Income Scoreboard</h3>
              <p className="text-xs text-slate-400 mt-0.5">All-time · sorted by realized profit</p>
            </div>
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>{['Stock','Premium Collected','Realized Profit','ROI %','Monthly %','Open Exposure'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {stockBoard.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400 text-sm italic">No option positions found.</td></tr>
                ) : stockBoard.map((s, i) => (
                  <tr key={s.symbol} className={`border-t border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                    <td className="px-4 py-3 text-sm font-bold text-slate-900">{s.symbol}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-green-700">${s.premiumCollected.toLocaleString()}</td>
                    <td className={`px-4 py-3 text-sm font-bold ${s.realizedProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {s.realizedProfit >= 0 ? '+' : ''}${s.realizedProfit.toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 text-sm font-bold ${s.roi >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      {s.roi >= 0 ? '+' : ''}{s.roi.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-400 rounded-full" style={{ width: `${s.monthlyContributionPct}%` }} />
                        </div>
                        <span className="text-xs text-slate-600 font-semibold">{s.monthlyContributionPct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {s.openExposure > 0
                        ? <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded" title="Premium received but not yet realized">${s.openExposure.toLocaleString()}</span>
                        : <span className="text-xs text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── BY STRATEGY ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
          <h2 className="text-base font-bold text-slate-800">By Strategy</h2>
          <div className="space-y-2.5">
            {income.byStrategy.map(s => (
              <div key={s.strategy}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-semibold text-slate-700">{s.strategy}</span>
                  <span className="text-slate-500">${s.premium.toLocaleString()} · {s.pct}%</span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full bg-gradient-to-r rounded-full ${strategyGradient[s.strategy] || 'from-slate-400 to-slate-500'}`}
                    style={{ width: `${s.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>{['Strategy','Premium','# Trades','Avg / Trade'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {income.byStrategy.map((s, i) => (
                  <tr key={s.strategy} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                    <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${strategyBadge[s.strategy] || 'bg-slate-100 text-slate-600'}`}>{s.strategy}</span></td>
                    <td className="px-4 py-2.5 text-sm font-semibold text-green-700">${s.premium.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-sm text-slate-600">{s.count}</td>
                    <td className="px-4 py-2.5 text-sm text-slate-600">${Math.round(s.premium / s.count).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── CAMPAIGN PERFORMANCE ────────────────────────────────────── */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-slate-900" style={{ fontFamily: 'Playfair Display, serif' }}>Campaign Performance</h2>

          {topCampaign && (
            <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-6 text-white shadow-xl">
              <p className="text-xs font-semibold opacity-70 uppercase tracking-widest mb-1">Top Performing Campaign</p>
              <p className="text-2xl font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>{topCampaign.name}</p>
              <div className="flex items-center gap-8 mt-4">
                <div>
                  <p className="text-xs opacity-70 mb-0.5">Realized Profit</p>
                  <p className={`text-2xl font-bold ${topCampaign.realizedProfit >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                    {topCampaign.realizedProfit >= 0 ? '+' : ''}${topCampaign.realizedProfit.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs opacity-70 mb-0.5">ROI</p>
                  <p className={`text-2xl font-bold ${Number(topCampaign.roi) >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                    {Number(topCampaign.roi) >= 0 ? '+' : ''}{topCampaign.roi}%
                  </p>
                </div>
                <div>
                  <p className="text-xs opacity-70 mb-0.5">Closed Trades</p>
                  <p className="text-2xl font-bold">{topCampaign.closedCount}</p>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            {campaignMetrics.length === 0 ? (
              <div className="p-10 text-center text-slate-400 text-sm italic">No campaign data. Assign positions to campaigns to see performance here.</div>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>{['Campaign','Strategy','Collected','Realized P&L','Open Exposure','Open','Closed','Status','ROI %'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {campaignMetrics.map((c, i) => (
                    <tr key={c.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                      <td className="px-4 py-3 text-sm font-bold text-slate-900">{c.name}</td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${campaignStrategyBadge[c.strategy] || 'bg-slate-100 text-slate-600'}`}>{c.strategy}</span></td>
                      <td className="px-4 py-3 text-sm font-semibold text-green-700">${c.premiumCollected.toLocaleString()}</td>
                      <td className={`px-4 py-3 text-sm font-bold ${c.realizedProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {c.realizedProfit >= 0 ? '+' : ''}${c.realizedProfit.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        {c.openExposure > 0
                          ? <span className="text-xs font-semibold text-amber-700">${c.openExposure.toLocaleString()}</span>
                          : <span className="text-xs text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{c.openCount}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{c.closedCount}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${c.isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                          {c.isActive ? 'Active' : 'Closed'}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-sm font-bold ${Number(c.roi) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                        {c.roi != null ? `${Number(c.roi) >= 0 ? '+' : ''}${c.roi}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── MONTHLY BREAKDOWN ───────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-800">Monthly Breakdown · {selectedYear}</h2>
              <p className="text-xs text-slate-400 mt-0.5">Click any goal cell to edit</p>
            </div>
          </div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>{['Month','Goal','Premium Collected','Realized Profit','Goal %','Trades'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-bold text-slate-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {yearlyMonthly.map((m, i) => {
                const isCurrent = m.m === currentMonth && String(selectedYear) === String(today.getFullYear());
                return (
                  <tr key={m.key} className={`border-t border-slate-100 ${isCurrent ? 'bg-blue-50' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        {isCurrent && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                        <span className={`text-sm font-semibold ${isCurrent ? 'text-blue-700' : m.premium > 0 ? 'text-slate-800' : 'text-slate-400'}`}>{m.label}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {editingGoal === m.m ? (
                        <input autoFocus type="number" value={goalDraft}
                          onChange={e => setGoalDraft(e.target.value)}
                          onBlur={() => saveGoal(m.m, goalDraft)}
                          onKeyDown={e => { if (e.key === 'Enter') saveGoal(m.m, goalDraft); if (e.key === 'Escape') setEditingGoal(null); }}
                          className="w-24 px-2 py-1 border border-blue-400 rounded text-sm font-semibold focus:outline-none" />
                      ) : (
                        <button onClick={() => { setEditingGoal(m.m); setGoalDraft(String(m.goal)); }}
                          className={`text-sm font-semibold text-left transition ${m.goal > 0 ? 'text-slate-700 hover:text-blue-600' : 'text-slate-300 hover:text-blue-400'}`}>
                          {m.goal > 0 ? `$${m.goal.toLocaleString()}` : '+ Set'}
                        </button>
                      )}
                    </td>
                    <td className={`px-5 py-3 text-sm font-semibold ${m.premium > 0 ? 'text-green-700' : 'text-slate-400'}`}>
                      {m.premium > 0 ? `$${m.premium.toLocaleString()}` : '—'}
                    </td>
                    <td className={`px-5 py-3 text-sm font-bold ${m.realized > 0 ? 'text-emerald-700' : m.realized < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {m.realized !== 0 ? `${m.realized > 0 ? '+' : ''}$${m.realized.toLocaleString()}` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      {m.goalPct != null ? (
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${m.goalPct >= 80 ? 'bg-green-500' : m.goalPct >= 50 ? 'bg-yellow-500' : 'bg-red-400'}`}
                              style={{ width: `${m.goalPct}%` }} />
                          </div>
                          <span className={`text-xs font-bold ${m.goalPct >= 80 ? 'text-green-600' : m.goalPct >= 50 ? 'text-yellow-600' : 'text-red-500'}`}>{m.goalPct}%</span>
                        </div>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-500">{m.count > 0 ? m.count : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── INCOME LOG ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-800">Income Log</h2>
              <p className="text-xs text-slate-400">{selectedYear} · {filtered.length} of {yearEntries.length} entries</p>
            </div>
            <button onClick={exportCSV} className="px-3 py-1.5 text-xs font-semibold text-white rounded-lg"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>📥 Export CSV</button>
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            <select value={logFilter.symbol} onChange={e => setLogFilter(f => ({ ...f, symbol: e.target.value }))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700">
              <option value="">All Symbols</option>
              {allSymbols.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={logFilter.strategy} onChange={e => setLogFilter(f => ({ ...f, strategy: e.target.value }))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700">
              <option value="">All Strategies</option>
              {allStrategies.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={logFilter.status} onChange={e => setLogFilter(f => ({ ...f, status: e.target.value }))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700">
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Closed">Closed</option>
            </select>
            <select value={logFilter.month} onChange={e => setLogFilter(f => ({ ...f, month: e.target.value }))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700">
              <option value="">All Months</option>
              {MONTH_NAMES.map((n, i) => <option key={i + 1} value={String(i + 1)}>{n}</option>)}
            </select>
            {(logFilter.symbol || logFilter.strategy || logFilter.status || logFilter.month) && (
              <button onClick={() => setLogFilter({ symbol:'', strategy:'', status:'', month:'' })}
                className="px-3 py-1.5 text-xs font-semibold text-slate-500 border border-slate-300 rounded-lg hover:bg-slate-50">Clear</button>
            )}
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>{['Date','Symbol','Strategy','Premium','Source','Status'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={e.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                    <td className="px-4 py-2.5 text-sm text-slate-500">{e.date}</td>
                    <td className="px-4 py-2.5 text-sm font-bold text-slate-900">{e.symbol}</td>
                    <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${strategyBadge[e.strategy] || 'bg-slate-100 text-slate-600'}`}>{e.strategy}</span></td>
                    <td className="px-4 py-2.5 text-sm font-bold text-green-700">${e.premium.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{e.source === 'position' ? '📈 Position' : '📝 Journal'}</td>
                    <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${e.status === 'Active' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{e.status}</span></td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-sm italic">No entries match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </LayoutWrapper>
  );
}


// Builds trade groups for the Journal Campaign Activity section.
// Each group = one position with its opening event + optional closing event paired together.
// Groups are sorted newest-first by entry date so the most recent trade is at the top.
function buildCampaignTimeline(positions) {
  const openLabel = (pos) => {
    const optDetails = d => [`Strike: $${d.strike}`, `Premium: $${d.premium}`, d.dte ? `DTE: ${d.dte}` : null].filter(Boolean);
    if (pos.category === 'Short Put')    return { icon: '📉', label: 'Sold Short Put',    details: optDetails(pos) };
    if (pos.category === 'Covered Call') return { icon: '📋', label: 'Sold Covered Call', details: optDetails(pos) };
    if (pos.category === 'Naked Call')   return { icon: '🔺', label: 'Sold Naked Call',   details: optDetails(pos) };
    if (pos.category === 'Naked Put')    return { icon: '🔻', label: 'Sold Naked Put',    details: optDetails(pos) };
    if (pos.category === 'Long Shares')  return { icon: '📈', label: 'Shares Acquired',   details: [`${pos.shareCount} sh @ $${effectiveCostBasis(pos)}${pos.avgPricePerShare ? ' (avg)' : ''}`] };
    if (pos.category === 'Cash')         return { icon: '💵', label: 'Capital Reserved',  details: [`$${pos.capitalAmount}`, pos.intent || null].filter(Boolean) };
    return { icon: '·', label: pos.category, details: [] };
  };

  const closeLabel = (pos) => {
    if (!pos.closedData) return null;
    const reason    = (pos.closedData.reason || '').toLowerCase();
    const pnl       = pos.closedData.realizedPnL;
    const pnlStr    = pnl != null ? `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}` : null;
    const buyback   = pos.closedData.buybackCost != null ? `Buyback: $${pos.closedData.buybackCost}` : null;
    const closeDate = pos.closedData.closedDate || pos.entryDate;
    let icon = '✓', label = `${pos.category} Closed`;
    if (reason.includes('assign'))  { icon = '🏦'; label = 'Assigned — Shares Purchased'; }
    else if (reason.includes('call'))  { icon = '🔔'; label = 'Shares Called Away'; }
    else if (reason.includes('roll'))  { icon = '🔄'; label = `Rolled ${pos.category}`; }
    else if (reason.includes('expir')) { icon = '✓';  label = `${pos.category} Expired Worthless`; }
    const details = [buyback, pnlStr ? `Realized: ${pnlStr}` : null, pos.closedData.reason ? `· ${pos.closedData.reason}` : null].filter(Boolean);
    return { icon, label, details, date: closeDate, pnl };
  };

  return [...positions]
    .sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || '')) // newest first
    .map(pos => ({
      pos,
      open:  openLabel(pos),
      close: pos.status === 'CLOSED' ? closeLabel(pos) : null,
      isOpen: pos.status === 'OPEN',
    }));
}

function JournalEntry({ entry, positions, campaigns }) {
  const updateJournalEntry = useWheelStore(s => s.updateJournalEntry);
  const deleteJournalEntry = useWheelStore(s => s.deleteJournalEntry);
  const linkedPos  = positions.find(p => p.id === entry.positionId) || null;
  const campaign   = linkedPos?.campaignId
    ? (campaigns || []).find(c => c.id === linkedPos.campaignId) || null
    : null;
  const camPositions = campaign
    ? positions.filter(p => p.campaignId === campaign.id)
    : linkedPos ? [linkedPos] : [];

  const [isOpen,      setIsOpen]      = useState(false);
  const [editSection, setEditSection] = useState(null); // 'thesis'
  const [editLesson,  setEditLesson]  = useState(false);
  const [lessonDraft, setLessonDraft] = useState('');
  const [titleDraft,  setTitleDraft]  = useState(entry.trade || '');

  const thesis   = entry.tradeThesis   || {};
  const simRec   = entry.simulatorRec  || null;
  const outcome  = entry.outcome       || {};

  // ── Campaign Activity timeline ────────────────────────────────────
  const timeline = camPositions.length > 0 ? buildCampaignTimeline(camPositions) : [];

  // ── Campaign Results ──────────────────────────────────────────────
  const camResults = camPositions.length > 0 ? (() => {
    const { netPremium: premiumCollected, realizedPnL, unrealizedPremium, unrealizedShares, totalFees, totalCommissions } = calcCampaignProfit(camPositions);
    const isShares  = p => p.category === 'Long Shares';
    const openSh    = camPositions.filter(p => p.status === 'OPEN' && isShares(p));

    // Single source of truth — same function CampaignsPanel calls.
    const campaignStatus = deriveCampaignStatus(camPositions);

    // Prefer the structured lifecycleStatus field; fall back to string-matching
    // closedData.reason for positions that predate this field (e.g. not yet
    // backfilled). Both paths give the same answer for current data.
    const rolls       = camPositions.filter(p => p.lifecycleStatus === 'Rolled' || (p.status === 'CLOSED' && (p.closedData?.reason || '').toLowerCase().includes('roll'))).length;
    const sharesOwned = openSh.reduce((s, p) => s + (p.shareCount || 0), 0);
    const assignments = camPositions.filter(p => p.lifecycleStatus === 'Assigned' || (p.status === 'CLOSED' && (p.closedData?.reason || '').toLowerCase().includes('assign'))).length;
    const calledAway  = camPositions.filter(p => p.status === 'CLOSED' && isShares(p)).length;
    const wheelCycles = Math.min(assignments, calledAway);

    const winRate     = calcWinRate(camPositions);
    const roi         = premiumCollected > 0 ? ((realizedPnL / premiumCollected) * 100).toFixed(1) : null;
    const unrealized  = unrealizedPremium + unrealizedShares;

    return { campaignStatus, premiumCollected, realizedPnL, unrealized, sharesOwned, assignments, calledAway,
             rolls, wheelCycles, winRate, roi, totalFees: totalFees + totalCommissions };
  })() : null;

  const recColors = {
    green:  'bg-green-50 border-green-200 text-green-800',
    orange: 'bg-orange-50 border-orange-200 text-orange-800',
    red:    'bg-red-50 border-red-200 text-red-800',
  };

  const InlineEdit = ({ section, label, children }) => (
    <div className="relative group">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">{label}</p>
        {editSection !== section && (
          <button onClick={() => setEditSection(section)}
            className="text-xs text-purple-500 opacity-0 group-hover:opacity-100 transition hover:text-purple-700">
            ✏️ Edit
          </button>
        )}
      </div>
      {children}
    </div>
  );

  const ThesisEditor = () => {
    const [form, setForm] = useState({ ...thesis });
    const upd = (k, v) => setForm(p => ({ ...p, [k]: v }));
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-slate-500">Support</label>
            <input value={form.support || ''} onChange={e => upd('support', e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm mt-0.5" placeholder="e.g. $390" />
          </div>
          <div>
            <label className="text-xs text-slate-500">Target</label>
            <input value={form.target || ''} onChange={e => upd('target', e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm mt-0.5" placeholder="e.g. $420" />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-500">Reason</label>
          <textarea value={form.reason || ''} onChange={e => upd('reason', e.target.value)} rows={2}
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm mt-0.5 resize-none" placeholder="Why did you enter this trade?" />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={!!form.happyAssignment} onChange={e => upd('happyAssignment', e.target.checked)}
            className="w-4 h-4 accent-purple-500" />
          Happy to own shares at strike if assigned
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={() => { updateJournalEntry(entry.id, { tradeThesis: form }); setEditSection(null); }}
            className="px-3 py-1.5 text-xs font-semibold text-white rounded"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>Save</button>
          <button onClick={() => setEditSection(null)} className="px-3 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50">Cancel</button>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition">

      {/* Entry header */}
      <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between bg-gradient-to-r from-slate-50 to-white">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold text-slate-900 shrink-0">{entry.symbol} ·</span>
              <input
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={() => { if (titleDraft !== entry.trade) updateJournalEntry(entry.id, { trade: titleDraft }); }}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                placeholder={campaign ? `📁 ${campaign.name}` : 'Enter trade description…'}
                className="text-lg font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-purple-400 focus:outline-none w-64 placeholder:font-normal placeholder:text-slate-400 transition-colors"
              />
            </div>
            {campaign ? (
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
                📁 {campaign.name}
              </span>
            ) : linkedPos && (
              <Link to="/positions"
                className="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-700 hover:bg-purple-200 transition">
                📈 {linkedPos.category} {linkedPos.strike ? `$${linkedPos.strike}` : ''}
              </Link>
            )}
            {entry.edited && <span className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-500">edited</span>}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{entry.date}</p>
        </div>
        <div className="flex items-center gap-2">
          {(() => {
            const r = entry.result || 'Outcome Pending';
            const isPending = r === 'Outcome Pending' || r === 'Pending';
            const cls = isPending
              ? 'px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700'
              : r.includes('+')
                ? 'px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700'
                : 'px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700';
            return <span className={cls}>{r}</span>;
          })()}
          <button
            onClick={() => {
              if (window.confirm(`Delete this journal entry for ${entry.symbol}? This cannot be undone.`)) {
                deleteJournalEntry(entry.id);
              }
            }}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
            title="Delete entry">
            🗑
          </button>
          <button
            onClick={() => setIsOpen(o => !o)}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
            title={isOpen ? 'Collapse' : 'Expand'}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`w-4 h-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {isOpen && <><div className="grid grid-cols-2 divide-x divide-slate-100">

        {/* ── SECTION 1: Trade Thesis ─────────────────────────────── */}
        <div className="p-5 border-b border-slate-100">
          <InlineEdit section="thesis" label="1 · Trade Thesis">
            {editSection === 'thesis' ? <ThesisEditor /> : (
              <div className="space-y-2 text-sm">
                {thesis.reason ? (
                  <p className="text-slate-800">{thesis.reason}</p>
                ) : (
                  <p className="text-slate-400 italic text-xs">No thesis yet — hover to add</p>
                )}
                {(thesis.support || thesis.target) && (
                  <div className="flex gap-3 text-xs">
                    {thesis.support && <span className="bg-red-50 text-red-700 px-2 py-0.5 rounded">Support: {thesis.support}</span>}
                    {thesis.target  && <span className="bg-green-50 text-green-700 px-2 py-0.5 rounded">Target: {thesis.target}</span>}
                  </div>
                )}
                {thesis.happyAssignment !== undefined && (
                  <p className="text-xs text-slate-500">
                    {thesis.happyAssignment ? '✓ Happy to own at strike' : '⚠ Not happy to own at strike'}
                  </p>
                )}
              </div>
            )}
          </InlineEdit>
        </div>

        {/* ── SECTION 2: Simulator Recommendation ─────────────────── */}
        <div className="p-5 border-b border-slate-100">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">2 · Latest Recommendation</p>
            <Link to="/simulator" className="text-xs text-purple-500 hover:text-purple-700">Run Simulator →</Link>
          </div>
          {simRec ? (
            <div className="space-y-2">
              {/* Recommendation header */}
              <div className={`border rounded-xl p-3 text-xs space-y-2 ${recColors.green}`}>
                <div className="flex items-center justify-between">
                  <p className="font-bold text-sm">{simRec.action}</p>
                  <span className="text-xs opacity-70">{simRec.date}</span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {simRec.profitPct != null && <span className="bg-white/60 px-1.5 py-0.5 rounded font-semibold">Return: {simRec.profitPct}%</span>}
                  {simRec.mtmPct != null && <span className="bg-white/60 px-1.5 py-0.5 rounded font-semibold">MTM: {simRec.mtmPct}%</span>}
                  {simRec.simDTE != null && <span className="bg-white/60 px-1.5 py-0.5 rounded">DTE: {simRec.simDTE}</span>}
                  {simRec.confidence && <span className="bg-white/60 px-1.5 py-0.5 rounded">{simRec.confidence}% conf.</span>}
                  {simRec.iv != null && <span className="bg-white/60 px-1.5 py-0.5 rounded">IV: {(simRec.iv * 100).toFixed(0)}%</span>}
                  {simRec.riskFreeRate != null && <span className="bg-white/60 px-1.5 py-0.5 rounded">r: {(simRec.riskFreeRate * 100).toFixed(0)}%</span>}
                  {simRec.bufferPerShare != null && (
                    <span className={`px-1.5 py-0.5 rounded font-semibold ${simRec.bufferPerShare >= 0 ? 'bg-green-200/60' : 'bg-red-200/60'}`}>
                      Buffer: {simRec.bufferPerShare >= 0 ? '+' : ''}${simRec.bufferPerShare.toFixed(2)}/sh
                    </span>
                  )}
                </div>
                {simRec.reasons?.length > 0 && (
                  <ul className="space-y-0.5 pt-1 border-t border-current/20">
                    {simRec.reasons.slice(0, 3).map((r, i) => (
                      <li key={i} className="flex gap-1"><span>✓</span>{r}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Decision Quality Calculator snapshot */}
              {simRec.dqc && (
                <div className="border border-slate-200 rounded-xl p-3 text-xs bg-slate-50 space-y-2">
                  <p className="font-bold text-slate-600 uppercase tracking-wide text-xs">Decision Quality Snapshot</p>

                  {/* Inputs row */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      ['Shares', simRec.dqc.shareQty],
                      ['Cost Basis', `$${simRec.dqc.shareCostBasis}`],
                      ['Spot Price', `$${simRec.dqc.currentSharePrice}`],
                      ['New Strike', `$${simRec.dqc.newCallStrike}`],
                      ['New Premium', `$${simRec.dqc.newCallPremium}`],
                      ['Buyback', `$${simRec.dqc.buybackCost}`],
                      ['Future Price', `$${simRec.dqc.futurePrice}`],
                      ['Regime', simRec.dqc.marketRegime],
                      ['Strategy', simRec.dqc.strategyType],
                    ].map(([label, val]) => (
                      <div key={label} className="bg-white rounded px-2 py-1 border border-slate-100">
                        <p className="text-slate-400 uppercase tracking-wide" style={{ fontSize: '9px' }}>{label}</p>
                        <p className="font-semibold text-slate-800">{val}</p>
                      </div>
                    ))}
                  </div>

                  {/* Key computed results */}
                  <div className="pt-1.5 border-t border-slate-200 space-y-1">
                    {[
                      { label: 'Net New Premium',       val: simRec.dqc.netNewPremium,          sign: true },
                      { label: 'Net Result If Assigned', val: simRec.dqc.netResultIfAssigned,   sign: true },
                      { label: 'Holding Result',        val: simRec.dqc.holdingResult,           sign: true },
                      { label: 'Strategy Result',       val: simRec.dqc.strategyResult,          sign: true },
                      { label: 'Outperformance vs Hold', val: simRec.dqc.strategyOutperformance, sign: true },
                      { label: 'Net Opportunity Cost',  val: simRec.dqc.netOpportunityCost,      sign: false },
                      { label: 'Cushion / Share',       val: simRec.dqc.cushionPerShare,         sign: false, suffix: '/sh' },
                    ].map(({ label, val, sign, suffix }) => (
                      <div key={label} className="flex justify-between items-center">
                        <span className="text-slate-500">{label}</span>
                        <span className={`font-bold tabular-nums ${sign && val >= 0 ? 'text-emerald-700' : sign && val < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                          {sign && val >= 0 ? '+' : sign && val < 0 ? '−' : ''}${Math.abs(val).toFixed(2)}{suffix || ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Thesis alignment */}
                  {simRec.dqc.thesisAlignment && (
                    <div className={`flex items-center justify-between pt-1.5 border-t border-slate-200`}>
                      <span className="text-slate-500">Thesis Alignment</span>
                      <span className={`font-semibold px-2 py-0.5 rounded ${
                        simRec.dqc.thesisAlignmentColor === 'green' ? 'bg-green-100 text-green-700' :
                        simRec.dqc.thesisAlignmentColor === 'red'   ? 'bg-red-100 text-red-700'     :
                        'bg-amber-100 text-amber-700'
                      }`}>{simRec.dqc.thesisAlignment}</span>
                    </div>
                  )}
                  {simRec.dqc.overallRisk && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Overall Risk</span>
                      <span className={`font-bold px-2 py-0.5 rounded ${
                        simRec.dqc.overallRisk === 'Low'    ? 'bg-green-100 text-green-700' :
                        simRec.dqc.overallRisk === 'Medium' ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>{simRec.dqc.overallRisk}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="border border-dashed border-slate-300 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-400">No recommendation saved yet.</p>
              <Link to="/simulator" className="text-xs text-purple-600 font-semibold hover:underline mt-1 inline-block">
                Open Simulator → Save Recommendation
              </Link>
            </div>
          )}
        </div>

        {/* ── SECTION 3: Campaign Activity — grouped by trade ─────── */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">3 · Campaign Activity</p>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">Newest first · grouped by trade</span>
          </div>
          {timeline.length === 0 ? (
            <p className="text-xs text-slate-400 italic">
              {linkedPos ? 'No activity yet — positions are still open.' : 'Link this entry to a position to see campaign activity.'}
            </p>
          ) : (
            <div className="space-y-2">
              {timeline.map(({ pos, open, close, isOpen }, idx) => {
                const cfg   = POSITION_CATEGORIES[pos.category] || {};
                const pnlOk = close?.pnl != null && close.pnl >= 0;
                const pnlBad= close?.pnl != null && close.pnl < 0;
                return (
                  <div key={pos.id ?? idx} className={`rounded-xl border overflow-hidden ${isOpen ? 'border-green-200' : 'border-slate-200'}`}>
                    {/* Trade header bar */}
                    <div className={`flex items-center justify-between px-3 py-1.5 ${isOpen ? 'bg-green-50' : 'bg-slate-50'} border-b ${isOpen ? 'border-green-100' : 'border-slate-100'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {pos.category}</span>
                        {pos.strike     && <span className="text-xs text-slate-600">$<strong>{pos.strike}</strong> strike</span>}
                        {pos.capitalAmount && !pos.strike && <span className="text-xs text-slate-600">${pos.capitalAmount?.toLocaleString()}</span>}
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isOpen ? 'bg-green-200 text-green-800' : pnlOk ? 'bg-emerald-100 text-emerald-700' : pnlBad ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'}`}>
                        {isOpen ? '● Open' : close?.pnl != null ? `${pnlOk ? '+' : '−'}$${Math.abs(close.pnl).toFixed(2)}` : 'Closed'}
                      </span>
                    </div>

                    {/* Opening row */}
                    <div className="flex items-start gap-2.5 px-3 py-2 border-b border-slate-100">
                      <div className="flex flex-col items-center mt-1 shrink-0">
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                        {(close || isOpen) && <div className="w-px bg-slate-200 mt-0.5" style={{ height: 14 }} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-blue-700">{open.icon} {open.label}</span>
                          <span className="text-xs text-slate-400 shrink-0">{pos.entryDate}</span>
                        </div>
                        {open.details.length > 0 && (
                          <div className="flex gap-1.5 mt-1 flex-wrap">
                            {open.details.map((d, i) => (
                              <span key={i} className="text-xs text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded">{d}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Closing row */}
                    {close && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${pnlOk ? 'bg-green-500' : pnlBad ? 'bg-red-400' : 'bg-slate-400'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs font-semibold ${pnlOk ? 'text-green-700' : pnlBad ? 'text-red-600' : 'text-slate-700'}`}>{close.icon} {close.label}</span>
                            <span className="text-xs text-slate-400 shrink-0">{close.date}</span>
                          </div>
                          {close.details.length > 0 && (
                            <div className="flex gap-1.5 mt-1 flex-wrap">
                              {close.details.map((d, i) => (
                                <span key={i} className={`text-xs px-1.5 py-0.5 rounded border ${
                                  d.startsWith('Realized:')
                                    ? pnlOk ? 'bg-green-50 text-green-700 border-green-200 font-semibold' : 'bg-red-50 text-red-600 border-red-200 font-semibold'
                                    : 'text-slate-600 bg-white border-slate-200'
                                }`}>{d}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Still open row */}
                    {isOpen && (
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        <span className="text-xs text-green-600 font-semibold">Still Open</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── SECTION 4: Campaign Results (read-only) ──────────────── */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">4 · Campaign Results</p>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">Auto-generated</span>
          </div>
          {camResults ? (
            <div className="space-y-2">
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${camResults.campaignStatus === 'Closed' ? 'bg-slate-100 text-slate-600' : 'bg-blue-100 text-blue-700'}`}>
                {camResults.campaignStatus}
              </span>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs pt-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Premium Collected</span>
                  <span className="font-semibold text-slate-900">${camResults.premiumCollected.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Realized P&L</span>
                  <span className={`font-semibold ${camResults.realizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {camResults.realizedPnL >= 0 ? '+' : ''}${camResults.realizedPnL.toLocaleString()}
                  </span>
                </div>
                {camResults.unrealized !== 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Unrealized</span>
                    <span className={`font-semibold ${camResults.unrealized >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {camResults.unrealized >= 0 ? '+' : ''}${Math.round(camResults.unrealized).toLocaleString()}
                    </span>
                  </div>
                )}
                {camResults.totalFees > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total Fees</span>
                    <span className="font-semibold text-red-600">-${camResults.totalFees.toFixed(2)}</span>
                  </div>
                )}
                {camResults.sharesOwned > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Shares Owned</span>
                    <span className="font-semibold text-slate-900">{camResults.sharesOwned}</span>
                  </div>
                )}
                {camResults.assignments > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Assignments</span>
                    <span className="font-semibold text-slate-900">{camResults.assignments}</span>
                  </div>
                )}
                {camResults.calledAway > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Shares Called Away</span>
                    <span className="font-semibold text-slate-900">{camResults.calledAway}</span>
                  </div>
                )}
                {camResults.rolls > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Rolls</span>
                    <span className="font-semibold text-slate-900">{camResults.rolls}</span>
                  </div>
                )}
                {camResults.wheelCycles > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Wheel Cycles</span>
                    <span className="font-semibold text-slate-900">{camResults.wheelCycles}</span>
                  </div>
                )}
                {camResults.winRate != null && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Win Rate</span>
                    <span className="font-semibold text-slate-900">{camResults.winRate}%</span>
                  </div>
                )}
                {camResults.roi != null && (
                  <div className="flex justify-between col-span-2 pt-1.5 border-t border-slate-100">
                    <span className="text-slate-600 font-semibold">ROI</span>
                    <span className={`font-bold text-sm ${Number(camResults.roi) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {Number(camResults.roi) >= 0 ? '+' : ''}{camResults.roi}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">Link this entry to a position to see campaign results.</p>
          )}
        </div>
      </div>

      {/* ── LESSONS LEARNED (editable) ───────────────────────────────── */}
      <div className="px-5 py-4 border-t border-slate-100">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Lessons Learned</p>
          {!editLesson && (
            <button
              onClick={() => { setEditLesson(true); setLessonDraft(outcome.lesson || ''); }}
              className="text-xs text-purple-500 hover:text-purple-700">
              ✏️ Edit
            </button>
          )}
        </div>
        {editLesson ? (
          <div className="space-y-2">
            <textarea
              value={lessonDraft}
              onChange={e => setLessonDraft(e.target.value)}
              rows={3}
              placeholder={`"Rolled too early."\n"Wait for IV expansion before selling calls."\n"Assignment would have been preferable."`}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm resize-none focus:ring-2 focus:ring-purple-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { updateJournalEntry(entry.id, { outcome: { ...outcome, lesson: lessonDraft } }); setEditLesson(false); }}
                className="px-3 py-1.5 text-xs font-semibold text-white rounded"
                style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                Save
              </button>
              <button onClick={() => setEditLesson(false)} className="px-3 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50">
                Cancel
              </button>
            </div>
          </div>
        ) : outcome.lesson ? (
          <p className="text-sm text-slate-700 whitespace-pre-line">{outcome.lesson}</p>
        ) : (
          <p className="text-xs text-slate-400 italic">No lessons recorded yet — click Edit to add.</p>
        )}
      </div>

      {/* Tags */}
      {(entry.tags || []).length > 0 && (
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex gap-1.5 flex-wrap">
          {entry.tags.map(t => (
            <span key={t} className="px-2 py-0.5 bg-white border border-slate-200 text-slate-600 rounded text-xs font-medium">#{t}</span>
          ))}
        </div>
      )}
      </>}
    </div>
  );
}

function Journal() {
  const journal   = useWheelStore(s => s.journal);
  const positions = useWheelStore(s => s.positions);
  const campaigns = useWheelStore(s => s.campaigns);

  // Entries that resolve to a known campaign via their linked position
  const hasCampaign = e => {
    const pos = positions.find(p => p.id === e.positionId);
    return !!(pos?.campaignId && campaigns.find(c => c.id === pos.campaignId));
  };
  const campaignEntries  = journal.filter(e => hasCampaign(e));
  const standaloneEntries = journal.filter(e => !hasCampaign(e));

  const handleExportJournal = () => {
    // Sheet 1: Journal entries (flat, all fields)
    const mainRows = journal.map(e => {
      const pos = positions.find(p => p.id === e.positionId);
      const th  = e.tradeThesis   || {};
      const rec = e.simulatorRec  || {};
      const dec = e.myDecision    || {};
      const out = e.outcome       || {};
      return {
        'Date':                   e.date,
        'Symbol':                 e.symbol,
        'Trade':                  e.trade || '',
        'Result':                 e.result || '',
        'Linked Position':        pos ? `${pos.symbol} ${pos.category} $${pos.strike || pos.capitalAmount}` : '',
        'Tags':                   (e.tags || []).join(', '),
        // Thesis
        'Thesis — Reason':        th.reason || '',
        'Thesis — Support':       th.support || '',
        'Thesis — Target':        th.target || '',
        'Thesis — Happy Assign':  th.happyAssignment ? 'Yes' : 'No',
        // Simulator rec
        'Rec — Date':             rec.date || '',
        'Rec — Action':           rec.action || '',
        'Rec — Confidence %':     rec.confidence || '',
        'Rec — Return %':         rec.profitPct ?? '',
        'Rec — MTM %':            rec.mtmPct ?? '',
        'Rec — DTE':              rec.simDTE ?? '',
        'Rec — Price':            rec.price ?? '',
        'Rec — Reasons':          (rec.reasons || []).join(' | '),
        // My Decision
        'Decision — Action':      dec.action || '',
        'Decision — Reasoning':   dec.reasoning || '',
        'Decision — Date':        dec.decidedDate || '',
        // Outcome
        'Outcome — Date':         out.completedDate || '',
        'Outcome — Action':       out.action || '',
        'Outcome — Final P&L %':  out.finalProfit ?? '',
        'Outcome — Lesson':       out.lesson || '',
      };
    });

    const ws1 = XLSX.utils.json_to_sheet(mainRows);
    ws1['!cols'] = Object.keys(mainRows[0] || {}).map(k => ({ wch: Math.max(k.length + 2, 16) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Journal Entries');

    // Sheet 2: Simulator recommendations only
    const recRows = journal.filter(e => e.simulatorRec).map(e => {
      const rec = e.simulatorRec;
      return {
        'Date':         e.date,
        'Symbol':       e.symbol,
        'Rec Date':     rec.date || '',
        'Action':       rec.action || '',
        'Confidence %': rec.confidence || '',
        'Return %':     rec.profitPct ?? '',
        'MTM %':        rec.mtmPct ?? '',
        'DTE':          rec.simDTE ?? '',
        'Price':        rec.price ?? '',
        'Buffer $/sh':  rec.bufferPerShare ?? '',
        'Buffer Status': rec.bufferStatus || '',
        'Reasons':      (rec.reasons || []).join(' | '),
        'Generated':    rec.generatedAt ? new Date(rec.generatedAt).toLocaleString() : '',
      };
    });
    if (recRows.length > 0) {
      const ws2 = XLSX.utils.json_to_sheet(recRows);
      ws2['!cols'] = Object.keys(recRows[0]).map(k => ({ wch: Math.max(k.length + 2, 14) }));
      XLSX.utils.book_append_sheet(wb, ws2, 'Simulator Recommendations');
    }

    // Sheet 3: Outcomes
    const outcomeRows = journal.filter(e => e.outcome?.completedDate).map(e => ({
      'Symbol':        e.symbol,
      'Trade':         e.trade || '',
      'Entry Date':    e.date,
      'Closed Date':   e.outcome.completedDate,
      'Action Taken':  e.outcome.action || '',
      'Final P&L %':   e.outcome.finalProfit ?? '',
      'Lesson':        e.outcome.lesson || '',
    }));
    if (outcomeRows.length > 0) {
      const ws3 = XLSX.utils.json_to_sheet(outcomeRows);
      ws3['!cols'] = Object.keys(outcomeRows[0]).map(k => ({ wch: Math.max(k.length + 2, 14) }));
      XLSX.utils.book_append_sheet(wb, ws3, 'Completed Outcomes');
    }

    XLSX.writeFile(wb, `wheel-edge-journal-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
              Campaign Journal
            </h1>
            <p className="text-slate-600">Live narrative of each campaign — activity and results pulled automatically from positions</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleExportJournal}
              className="px-4 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition">
              📥 Export Excel
            </button>
            <Link to="/simulator"
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
              🎯 Run Simulator
            </Link>
          </div>
        </div>

        {campaignEntries.length > 0 && (
          <div className="space-y-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Campaign Entries</p>
            {campaignEntries.map(entry => (
              <JournalEntry key={entry.id} entry={entry} positions={positions} campaigns={campaigns} />
            ))}
          </div>
        )}

        {standaloneEntries.length > 0 && (
          <div className="space-y-4">
            {campaignEntries.length > 0 && (
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Other Entries</p>
            )}
            {standaloneEntries.map(entry => (
              <JournalEntry key={entry.id} entry={entry} positions={positions} campaigns={campaigns} />
            ))}
          </div>
        )}

        {journal.length === 0 && (
          <div className="text-center py-12">
            <p className="text-slate-400">No journal entries yet.</p>
            <p className="text-sm text-slate-400 mt-1">Run the Simulator and click "Save Recommendation to Journal".</p>
          </div>
        )}
      </div>
    </LayoutWrapper>
  );
}

// ============================================================================
// SETTINGS PAGE
// ============================================================================

// ============================================================================
// BACKUP PAGE
// ============================================================================

function Backup() {
  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6 max-w-3xl">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
            Backup
          </h1>
          <p className="text-slate-600">
            IndexedDB is your local database — it's always the source of truth and works fully offline.
            Supabase is a manual cloud backup you control.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <SyncStatusIndicator />
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-1">Cloud Backup</h3>
          <p className="text-xs text-slate-500 mb-4">
            Save uploads every record from your local database to Supabase. Restore lets you
            pull the cloud copy back down — you'll always see what's different before anything changes.
          </p>
          <div className="flex gap-3">
            <SaveToCloudButton />
            <RestoreFromCloudButton />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-1">Local Version History</h3>
          <p className="text-xs text-slate-500 mb-4">
            A snapshot of your entire local database is saved automatically every time you add, edit,
            or delete something. The last 30 are kept — restore any of them without needing the cloud.
          </p>
          <SnapshotHistoryList />
        </div>
      </div>
    </LayoutWrapper>
  );
}

function Settings() {
  return (
    <LayoutWrapper>
      <div className="p-8 space-y-6 max-w-2xl">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 mb-2" style={{ fontFamily: 'Playfair Display, serif' }}>
            Settings
          </h1>
          <p className="text-slate-600">Data source, Tiger API connection, and snapshot preferences</p>
        </div>

        {/* Market Data Status */}
        <MarketDataStatus />

        {/* Data Source Toggle */}
        <DataSourceToggle />

        {/* Snapshot info */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-3">📸 About Snapshots</h3>
          <p className="text-sm text-slate-600 mb-3">
            Snapshots record your price observations and decisions at a point in time.
            Open the Scenario Simulator, hit <strong>📸 Save Snapshot</strong>, and build a history of what you saw and decided.
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
            {[
              'Stock price at decision point',
              'Option bid / ask / value',
              'Implied volatility',
              'Your recommendation',
              'Days to expiry',
              'Personal notes',
            ].map(item => (
              <div key={item} className="flex items-center gap-1.5">
                <span className="text-green-500">✓</span> {item}
              </div>
            ))}
          </div>
        </div>

        {/* Tiger API info */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-3">🐯 Tiger API</h3>
          <div className="space-y-2 text-sm text-slate-600">
            <p>Backend server runs on <code className="bg-slate-100 px-1 rounded">localhost:3001</code></p>
            <p>Start with: <code className="bg-slate-100 px-1 rounded">npm run server</code></p>
            <p>Or both together: <code className="bg-slate-100 px-1 rounded">npm run dev</code></p>
            <p className="pt-2 border-t border-slate-100 text-xs text-slate-500">
              Real-time quotes require market data subscription on Tiger's developer portal.
              Until then, Manual Entry Mode works perfectly for all simulator features.
            </p>
          </div>
        </div>
      </div>
    </LayoutWrapper>
  );
}

// ============================================================================
// STAT CARD COMPONENT
// ============================================================================

function StatCard({ title, value, subtitle, color, compact = false }) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-xl text-white shadow-lg ${compact ? 'p-4' : 'p-6'}`}>
      <p className={`font-semibold opacity-80 uppercase tracking-wide truncate ${compact ? 'text-xs' : 'text-sm'}`}>{title}</p>
      <p className={`font-bold mt-1 truncate ${compact ? 'text-xl' : 'text-3xl'}`}>{value}</p>
      <p className={`opacity-70 mt-0.5 truncate ${compact ? 'text-xs' : 'text-sm'}`}>{subtitle}</p>
    </div>
  );
}

// ============================================================================
// MAIN APP
// ============================================================================

function App() {
  return (
    <BrowserRouter>
      <IndexedDbInitializer />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/positions" element={<Positions />} />
        <Route path="/simulator" element={<ScenarioSimulator />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/watchlist" element={<RotationWatchlist />} />
        <Route path="/income" element={<IncomeTracker />} />
        <Route path="/journal" element={<Journal />} />
        <Route path="/backup" element={<Backup />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
