/**
 * Wheel Edge — IndexedDB Primary Database (Dexie)
 *
 * IndexedDB is the single source of truth the app depends on to function.
 * Supabase is a manual, user-triggered backup/restore target only — see
 * cloudBackup.js and cloudRestore.js. The app must work fully offline using
 * only this database.
 */

import Dexie from 'dexie';

export const db = new Dexie('wheel-edge-db');

// Schema is locked at version 1 once shipped. Future field/index changes
// must add a new db.version(2).stores({...}) block — never edit this
// version's store definitions in place, or existing users' IndexedDB
// upgrades will break silently.
db.version(1).stores({
  positions:      'id, campaignId, status, _updatedAt',
  campaigns:      'id, symbol, status, _updatedAt',
  journal:        'id, positionId, symbol, _updatedAt',
  calendar:       'id, date, category, _updatedAt',
  watchlist:      'id, symbol, _updatedAt',
  priceSnapshots: 'id, positionId, symbol, _updatedAt',
  snapshots:      '++id, timestamp', // local version history (whole-state copies)
  meta:           'key',             // lastCloudBackupAt, lastJsonBackupFilename, migration flags
});

// Version 2 — adds the immutable execution ledger. Dexie requires every
// version to redeclare ALL stores (even unchanged ones); version(1)'s
// definitions above are never edited in place, per the warning at the top
// of this file.
db.version(2).stores({
  positions:      'id, campaignId, status, _updatedAt',
  campaigns:      'id, symbol, status, _updatedAt',
  journal:        'id, positionId, symbol, _updatedAt',
  calendar:       'id, date, category, _updatedAt',
  watchlist:      'id, symbol, _updatedAt',
  priceSnapshots: 'id, positionId, symbol, _updatedAt',
  snapshots:      '++id, timestamp',
  meta:           'key',
  // Immutable trade ledger — every Sell to Open/Buy to Close/Assignment/Roll/
  // etc. action becomes one permanent row here. Never updated, never deleted
  // (enforced in src/services/executions.js, the only module allowed to
  // write to this table). Deliberately NOT included in DOMAIN_TABLE_NAMES
  // below — that array drives whole-table clear+replace logic (snapshot
  // restore, cloud restore) which would violate immutability if applied here.
  executions:     'id, positionId, campaignId, action, date, _updatedAt',
});

// The 6 domains backed by Supabase tables — these get bookkeeping fields
// and participate in cloud backup/restore. Everything else in the app
// (planning board, calculators, goals, UI prefs) has no Supabase table and
// stays on the existing Zustand localStorage persist, untouched.
export const DOMAIN_TABLE_NAMES = ['positions', 'campaigns', 'journal', 'calendar', 'watchlist', 'priceSnapshots'];

DOMAIN_TABLE_NAMES.forEach((name) => {
  db[name].hook('creating', (primKey, obj) => {
    const now = new Date().toISOString();
    obj._updatedAt = now;
    if (!obj._createdAt) obj._createdAt = now;
    obj._dirty = 1; // needs cloud backup
  });
  db[name].hook('updating', (mods) => {
    // A cloud-backup confirmation only sets _dirty:0 and must not be
    // overridden back to dirty by this hook. Only auto-stamp _updatedAt/_dirty
    // when the caller didn't already specify them explicitly.
    if (mods._updatedAt === undefined && mods._dirty === undefined) {
      return { _updatedAt: new Date().toISOString(), _dirty: 1 };
    }
  });
});

// Executions get the same creation-time bookkeeping as the domain tables
// (so cloud backup can use _dirty the same way) but deliberately NO
// `updating` hook — this table is never updated after creation, only
// inserted via db.executions.add() in src/services/executions.js.
db.executions.hook('creating', (primKey, obj) => {
  const now = new Date().toISOString();
  obj._updatedAt = now;
  if (!obj._createdAt) obj._createdAt = now;
  obj._dirty = 1;
});

// Version 3 — adds an index on importFingerprint so the POEMS contract-note
// importer (src/services/importMatcher.js) can do an indexed duplicate-check
// lookup instead of a full table scan. No data migration: pre-existing
// execution rows simply have importFingerprint === undefined.
db.version(3).stores({
  positions:      'id, campaignId, status, _updatedAt',
  campaigns:      'id, symbol, status, _updatedAt',
  journal:        'id, positionId, symbol, _updatedAt',
  calendar:       'id, date, category, _updatedAt',
  watchlist:      'id, symbol, _updatedAt',
  priceSnapshots: 'id, positionId, symbol, _updatedAt',
  snapshots:      '++id, timestamp',
  meta:           'key',
  executions:     'id, positionId, campaignId, action, date, importFingerprint, _updatedAt',
});
