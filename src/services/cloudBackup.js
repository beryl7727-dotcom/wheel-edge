/**
 * Wheel Edge — Cloud Backup Service
 *
 * Manual, user-triggered only — nothing here runs automatically. Implements
 * the 6-step Save to Cloud pipeline:
 *
 *   1. Save to IndexedDB        — confirm the database is open and current
 *   2. Verify database integrity — abort before touching the network if corrupt
 *   3. Create local JSON snapshot — a standalone downloadable file, independent
 *                                    of IndexedDB
 *   4. Upload to Supabase        — per-record upsert, only records marked dirty
 *   5. Verify upload             — re-query Supabase to confirm what was sent
 *                                    actually landed
 *   6. Record backup timestamp   — written to the meta table, drives the
 *                                    status indicator
 */

import { supabase, isSupabaseConfigured } from './supabase';
import { db, DOMAIN_TABLE_NAMES } from './db';
import {
  toDbPosition, toDbCampaign, toDbJournalEntry,
  toDbCalendarEvent, toDbWatchlistItem, toDbSnapshot, toDbExecution,
} from './supabaseSync';

const TABLE_MAP = {
  positions:      { supabaseTable: 'positions',      mapper: toDbPosition },
  campaigns:      { supabaseTable: 'campaigns',       mapper: toDbCampaign },
  journal:        { supabaseTable: 'journal_entries', mapper: toDbJournalEntry },
  calendar:       { supabaseTable: 'calendar_events', mapper: toDbCalendarEvent },
  watchlist:      { supabaseTable: 'watchlist',       mapper: toDbWatchlistItem },
  priceSnapshots: { supabaseTable: 'recommendations', mapper: toDbSnapshot },
  executions:     { supabaseTable: 'executions',      mapper: toDbExecution },
};

// Local-only list (NOT the exported DOMAIN_TABLE_NAMES) — adds executions to
// the upload/verify loops here without exposing it to writeThrough.js's
// snapshot system or cloudRestore.js's clear+replace path, which must never
// touch the immutable ledger table.
const UPLOAD_TABLES = [...DOMAIN_TABLE_NAMES, 'executions'];

/**
 * @param {(progress: {phase: string, current?: number, total?: number, uploaded?: number, skipped?: number, failed?: number}) => void} onProgress
 */
export async function saveToCloud(onProgress) {
  const report = (phase, extra = {}) => onProgress?.({ phase, ...extra });

  // ── Step 1: Save to IndexedDB ───────────────────────────────────────────
  // writeThrough() already keeps IndexedDB current on every user action.
  // This step just confirms the database is actually open and responsive
  // before we start a backup against it.
  report('saving-local');
  if (!db.isOpen()) {
    try {
      await db.open();
    } catch (err) {
      return { ok: false, phase: 'saving-local', reason: `IndexedDB unavailable: ${err.message}` };
    }
  }

  // ── Step 2: Verify database integrity ───────────────────────────────────
  report('verifying-integrity');
  const integrity = await verifyLocalIntegrity();
  if (!integrity.ok) {
    return { ok: false, phase: 'verify-integrity', issues: integrity.issues };
  }

  // ── Step 3: Create local JSON snapshot (downloadable file) ──────────────
  report('json-snapshot');
  let jsonBackup;
  try {
    jsonBackup = await createJsonBackupFile();
  } catch (err) {
    return { ok: false, phase: 'json-snapshot', reason: err.message };
  }

  if (!isSupabaseConfigured() || !supabase) {
    return { ok: false, phase: 'upload', reason: 'Supabase not configured', jsonBackup, integrity };
  }

  // ── Step 4: Upload to Supabase ───────────────────────────────────────────
  // Includes the immutable executions ledger via UPLOAD_TABLES — uploaded
  // alongside the 6 domain tables, but never cleared/replaced like they can
  // be (executions only ever gets new rows added, never touched again).
  report('uploading');
  const summary = { uploaded: 0, skipped: 0, failed: 0, errors: [] };
  const uploadedByTable = {};
  const rowsByTable = {};
  let totalRecords = 0;
  for (const t of UPLOAD_TABLES) {
    rowsByTable[t] = await db[t].toArray();
    totalRecords += rowsByTable[t].length;
  }

  let done = 0;
  for (const t of UPLOAD_TABLES) {
    const { supabaseTable, mapper } = TABLE_MAP[t];
    uploadedByTable[t] = [];
    for (const record of rowsByTable[t]) {
      done++;
      if (!record._dirty) {
        summary.skipped++;
      } else {
        try {
          const { error } = await supabase.from(supabaseTable).upsert(mapper(record), { onConflict: 'id' });
          if (error) {
            summary.failed++;
            summary.errors.push({ table: t, id: record.id, message: error.message });
          } else {
            summary.uploaded++;
            uploadedByTable[t].push(record.id);
            // Confirm-only update — must not re-trigger the "updating" hook's
            // _updatedAt bump (see db.js hook guard).
            await db[t].update(record.id, { _dirty: 0 });
          }
        } catch (err) {
          summary.failed++;
          summary.errors.push({ table: t, id: record.id, message: err.message });
        }
      }
      report('uploading', { current: done, total: totalRecords, ...summary });
    }
  }

  // ── Step 5: Verify upload ────────────────────────────────────────────────
  report('verifying-upload');
  const verification = await verifyCloudUpload(uploadedByTable);

  // ── Step 6: Record backup timestamp ─────────────────────────────────────
  const finishedAt = new Date().toISOString();
  await db.meta.put({ key: 'lastCloudBackupAt', value: finishedAt });
  await db.meta.put({ key: 'lastJsonBackupFilename', value: jsonBackup.filename });

  report('done');
  return { ok: true, finishedAt, ...summary, integrity, jsonBackup, verification };
}

async function verifyLocalIntegrity() {
  const issues = [];
  if (!db.isOpen()) issues.push('Database is not open');
  for (const t of UPLOAD_TABLES) {
    const rows = await db[t].toArray();
    const badRows = rows.filter((r) => r.id === undefined || r.id === null);
    if (badRows.length) issues.push(`${t}: ${badRows.length} record(s) missing an id`);
  }
  return { ok: issues.length === 0, issues };
}

async function createJsonBackupFile() {
  const payload = { exportedAt: new Date().toISOString() };
  let recordCount = 0;
  for (const t of UPLOAD_TABLES) {
    payload[t] = await db[t].toArray();
    recordCount += payload[t].length;
  }
  const filename = `wheel-edge-backup-${payload.exportedAt.replace(/[:.]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { filename, recordCount };
}

async function verifyCloudUpload(uploadedByTable) {
  const mismatches = [];
  for (const t of UPLOAD_TABLES) {
    const ids = uploadedByTable[t];
    if (!ids || !ids.length) continue;
    const { supabaseTable } = TABLE_MAP[t];
    const { data, error } = await supabase.from(supabaseTable).select('id').in('id', ids);
    if (error) {
      mismatches.push({ table: t, reason: error.message });
      continue;
    }
    const foundIds = new Set((data || []).map((r) => r.id));
    for (const id of ids) {
      if (!foundIds.has(id)) mismatches.push({ table: t, id });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export async function getLastCloudBackupAt() {
  const row = await db.meta.get('lastCloudBackupAt');
  return row?.value ?? null;
}
