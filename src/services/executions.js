/**
 * Wheel Edge — Execution Ledger
 *
 * Every trade action (Sell to Open, Buy to Close, Assignment, Roll, etc.)
 * becomes one permanent row here. This module is the ONLY place allowed to
 * write to db.executions, and it deliberately exposes no update/delete
 * functions — that absence IS the immutability enforcement. Positions stay
 * the primary editable/visible unit; this ledger is the permanent audit
 * trail underneath, never overwritten, suitable for auditing and
 * performance analysis.
 */

import { db } from './db';
import { maybeSnapshot, notifyLocalSave } from './writeThrough';

let nextExecId = null; // lazily computed once per session, then incremented in memory

async function nextExecutionId() {
  if (nextExecId == null) {
    const all = await db.executions.toArray();
    nextExecId = Math.max(0, ...all.map((e) => e.id)) + 1;
  }
  return nextExecId++;
}

/**
 * Record a new execution. Throws if an execution with the same id already
 * exists — this is a deliberate loud failure (unlike writeThrough's
 * swallow-and-log convention) because a duplicate-id collision here means
 * the ledger is about to silently lose history, which is the one failure
 * mode this whole feature exists to prevent.
 */
export async function addExecution(execution) {
  const id = execution.id ?? (await nextExecutionId());
  const existing = await db.executions.get(id);
  if (existing) {
    throw new Error(`[executions] Refusing to overwrite existing execution id=${id}`);
  }
  const record = { ...execution, id };
  await db.executions.add(record); // create-only primitive — throws ConstraintError on duplicate key
  await maybeSnapshot();
  notifyLocalSave();
  return record;
}

export async function getExecutionsForPosition(positionId) {
  return db.executions.where('positionId').equals(positionId).sortBy('date');
}

export async function getExecutionsForCampaign(campaignId) {
  return db.executions.where('campaignId').equals(campaignId).sortBy('date');
}

export async function getAllExecutions() {
  return db.executions.toArray();
}

// No updateExecution, no deleteExecution — intentionally absent.
