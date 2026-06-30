/**
 * Wheel Edge — Write-Through Helpers
 *
 * Every mutating store action calls writeThrough()/deleteThrough() in place
 * of the old syncX()/deleteX() Supabase calls. These write to IndexedDB
 * (the source of truth) and create a version snapshot. Errors are caught
 * and logged here, never thrown back into the synchronous Zustand `set()`
 * callback that calls them — a failed write must never block or crash a
 * user action.
 */

import { db, DOMAIN_TABLE_NAMES } from './db';

const SNAPSHOT_LIMIT = 30;

export async function writeThrough(table, record) {
  try {
    await db[table].put(record);
    await maybeSnapshot();
    notifyLocalSave();
  } catch (err) {
    console.error(`[IndexedDB] write failed on ${table}`, err);
  }
  return record;
}

export async function deleteThrough(table, id) {
  try {
    await db[table].delete(id);
    await maybeSnapshot();
    notifyLocalSave();
  } catch (err) {
    console.error(`[IndexedDB] delete failed on ${table}`, err);
  }
}

export async function maybeSnapshot() {
  const payload = {};
  for (const t of DOMAIN_TABLE_NAMES) payload[t] = await db[t].toArray();
  await db.snapshots.add({ timestamp: new Date().toISOString(), payload });
  const all = await db.snapshots.orderBy('timestamp').toArray();
  if (all.length > SNAPSHOT_LIMIT) {
    await db.snapshots.bulkDelete(all.slice(0, all.length - SNAPSHOT_LIMIT).map((s) => s.id));
  }
}

// Set by wheel-edge-dashboard.jsx after the store is created, so this module
// (which db.js/writeThrough.js cannot import the store into without a
// circular dependency) can still update the "🟢 Local Saved" status field.
let onLocalSave = null;
export function registerLocalSaveListener(fn) {
  onLocalSave = fn;
}
export function notifyLocalSave() {
  onLocalSave?.(new Date().toISOString());
}

// Restore a whole-state snapshot (from version history or a cloud restore
// "Restore Cloud → Local" / "Merge" operation) — clears and replaces all 6
// domain tables in a single transaction, then returns the fresh state for
// the caller to push into Zustand.
export async function restoreWholeState(payloadByTable) {
  await db.transaction('rw', DOMAIN_TABLE_NAMES.map((t) => db[t]), async () => {
    for (const t of DOMAIN_TABLE_NAMES) {
      await db[t].clear();
      await db[t].bulkPut(payloadByTable[t] || []);
    }
  });
  const fresh = {};
  for (const t of DOMAIN_TABLE_NAMES) fresh[t] = await db[t].toArray();
  notifyLocalSave();
  return fresh;
}
