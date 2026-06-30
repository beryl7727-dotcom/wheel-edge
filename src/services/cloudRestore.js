/**
 * Wheel Edge — Cloud Restore Service
 *
 * Manual, user-triggered only. Pulls the cloud snapshot, computes a diff
 * against IndexedDB (local-only / cloud-only / conflicting), and applies the
 * user's chosen strategy. NEVER overwrites local data without the diff
 * having been shown and a strategy explicitly chosen — 'cancel' always
 * leaves IndexedDB untouched.
 */

import { loadAllFromSupabase } from './supabaseSync';
import { db, DOMAIN_TABLE_NAMES } from './db';

const RESULT_KEY = {
  positions: 'positions', campaigns: 'campaigns', journal: 'journal',
  calendar: 'calendar', watchlist: 'watchlist', priceSnapshots: 'priceSnapshots',
};

// Read-only pull from Supabase — does not touch IndexedDB.
export async function fetchCloudSnapshot() {
  const result = await loadAllFromSupabase();
  return result.ok ? { ok: true, ...result } : result;
}

// Per-table: which ids exist only locally, only in the cloud, or in both
// with differing content (a real conflict).
export async function diffLocalVsCloud(cloud) {
  const diff = {};
  for (const t of DOMAIN_TABLE_NAMES) {
    const localRows = await db[t].toArray();
    const cloudRows = cloud[RESULT_KEY[t]] || [];
    const localById = new Map(localRows.map((r) => [r.id, r]));
    const cloudById = new Map(cloudRows.map((r) => [r.id, r]));
    const onlyLocal = [...localById.keys()].filter((id) => !cloudById.has(id));
    const onlyCloud = [...cloudById.keys()].filter((id) => !localById.has(id));
    const conflicting = [...localById.keys()]
      .filter((id) => cloudById.has(id))
      .filter((id) => {
        const l = localById.get(id);
        const c = cloudById.get(id);
        if (l._updatedAt && c.updatedAt && l._updatedAt === c.updatedAt) return false;
        return JSON.stringify(stripBookkeeping(l)) !== JSON.stringify(stripBookkeeping(c));
      });
    diff[t] = { onlyLocal, onlyCloud, conflicting, localById, cloudById };
  }

  // Informational only — executions are never mutated, so there's nothing
  // to conflict. They're always additively merged regardless of strategy
  // (see reconcileExecutions), shown here just so the diff summary is complete.
  const localExecIds = new Set((await db.executions.toArray()).map((e) => e.id));
  const cloudExecIds = new Set((cloud.executions || []).map((e) => e.id));
  diff.executions = {
    onlyLocal: [...localExecIds].filter((id) => !cloudExecIds.has(id)),
    onlyCloud: [...cloudExecIds].filter((id) => !localExecIds.has(id)),
    conflicting: [],
  };

  return diff;
}

function stripBookkeeping(obj) {
  const { _updatedAt, _createdAt, _dirty, updatedAt, createdAt, ...rest } = obj;
  return rest;
}

export function summarizeDiff(diff) {
  let onlyLocal = 0, onlyCloud = 0, conflicting = 0;
  const perTable = {};
  for (const t of DOMAIN_TABLE_NAMES) {
    const d = diff[t];
    perTable[t] = { onlyLocal: d.onlyLocal.length, onlyCloud: d.onlyCloud.length, conflicting: d.conflicting.length };
    onlyLocal += d.onlyLocal.length;
    onlyCloud += d.onlyCloud.length;
    conflicting += d.conflicting.length;
  }
  // Reported separately, not folded into the totals above — executions are
  // always additively merged regardless of strategy, never "lost," so they
  // don't belong in the same at-risk count as the other 6 tables.
  const executions = diff.executions
    ? { onlyLocal: diff.executions.onlyLocal.length, onlyCloud: diff.executions.onlyCloud.length }
    : { onlyLocal: 0, onlyCloud: 0 };
  return { onlyLocal, onlyCloud, conflicting, perTable, executions };
}

// Executions are immutable — they NEVER go through the clear+replace or
// timestamp-wins logic above, regardless of which restore strategy was
// picked. The only possible operation is adding rows that exist in the
// cloud but not yet locally. An existing local execution is never deleted
// or overwritten, even under 'cloud-wins' — discarding ledger history would
// violate "never overwrite trades."
export async function reconcileExecutions(cloud) {
  const localIds = new Set((await db.executions.toArray()).map((e) => e.id));
  const toAdd = (cloud.executions || [])
    .filter((e) => !localIds.has(e.id))
    .map((e) => ({ ...e, _dirty: 0, _updatedAt: e.createdAt || new Date().toISOString() }));
  if (toAdd.length) await db.executions.bulkAdd(toAdd);
  return { added: toAdd.length };
}

/**
 * @param {'cloud-wins'|'merge'|'cancel'} strategy
 * @param {object} cloud   result of fetchCloudSnapshot()
 * @param {object} diff    result of diffLocalVsCloud(cloud)
 */
export async function restoreFromCloud(strategy, cloud, diff) {
  if (strategy === 'cancel') return { ok: true, applied: false };

  await db.transaction('rw', DOMAIN_TABLE_NAMES.map((t) => db[t]), async () => {
    for (const t of DOMAIN_TABLE_NAMES) {
      const { onlyCloud, conflicting, localById, cloudById } = diff[t];
      const cloudRows = cloud[RESULT_KEY[t]] || [];

      if (strategy === 'cloud-wins') {
        // Whole-table replace — cloud is authoritative for everything it
        // has. Local-only records are discarded; the user explicitly chose
        // this option in the picker after seeing the diff counts.
        await db[t].clear();
        await db[t].bulkPut(
          cloudRows.map((r) => ({ ...r, _dirty: 0, _updatedAt: r.updatedAt || new Date().toISOString() }))
        );
      } else if (strategy === 'merge') {
        // Additive for local-only/cloud-only. For true conflicts, the
        // most-recently-edited copy wins (user-confirmed decision).
        for (const id of onlyCloud) {
          const c = cloudById.get(id);
          await db[t].put({ ...c, _dirty: 0, _updatedAt: c.updatedAt || new Date().toISOString() });
        }
        // onlyLocal rows are already correct in IndexedDB — no-op.
        for (const id of conflicting) {
          const l = localById.get(id);
          const c = cloudById.get(id);
          const localTime = new Date(l._updatedAt || 0).getTime();
          const cloudTime = new Date(c.updatedAt || 0).getTime();
          if (cloudTime > localTime) {
            await db[t].put({ ...c, _dirty: 0, _updatedAt: c.updatedAt });
          }
          // else: local is newer or equal, keep local untouched.
        }
      }
    }
  });

  // Executions reconcile additively regardless of strategy — entirely
  // outside the transaction above, since the table isn't in DOMAIN_TABLE_NAMES.
  const executionResult = await reconcileExecutions(cloud);

  const fresh = {};
  for (const t of DOMAIN_TABLE_NAMES) fresh[t] = await db[t].toArray();
  fresh.executions = await db.executions.toArray();
  return { ok: true, applied: true, fresh, executionsAdded: executionResult.added };
}
