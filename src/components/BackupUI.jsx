/**
 * Wheel Edge — Backup UI Components
 *
 * SyncStatusIndicator, SaveToCloudButton, RestoreFromCloudButton, and
 * SnapshotHistoryList. Used on both the Dashboard (prominent placement) and
 * the dedicated /backup page. All cloud actions here are manual/user-
 * triggered only — nothing in this file runs automatically.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useWheelStore } from '../wheel-edge-dashboard.jsx';
import { db } from '../services/db';
import { saveToCloud, getLastCloudBackupAt } from '../services/cloudBackup';
import { fetchCloudSnapshot, diffLocalVsCloud, summarizeDiff, restoreFromCloud } from '../services/cloudRestore';
import { restoreWholeState } from '../services/writeThrough';

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

function relativeTime(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ── Status Indicator ─────────────────────────────────────────────────────────

export function SyncStatusIndicator({ compact = false }) {
  const localSavedAt = useWheelStore((s) => s.localSyncStatus?.savedAt);
  const [lastCloudBackup, setLastCloudBackup] = useState(null);

  const refresh = useCallback(() => {
    getLastCloudBackupAt().then(setLastCloudBackup);
  }, []);

  useEffect(() => { refresh(); }, [refresh, localSavedAt]);

  const localFmt = formatDateTime(localSavedAt);
  const cloudFmt = formatDateTime(lastCloudBackup);

  return (
    <div className={`flex items-center gap-3 ${compact ? '' : 'flex-wrap'}`}>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-200">
        <span className="text-lg leading-none">🟢</span>
        <div>
          <p className="text-xs font-bold text-green-800 leading-tight">Local Database</p>
          <p className="text-xs text-green-600 leading-tight">
            {localFmt ? `✓ Saved ${localFmt.time}` : 'Not saved yet'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200">
        <span className="text-lg leading-none">☁️</span>
        <div>
          <p className="text-xs font-bold text-blue-800 leading-tight">Cloud Backup</p>
          <p className="text-xs text-blue-600 leading-tight">
            {cloudFmt ? `✓ Last Backup ${cloudFmt.date} ${cloudFmt.time}` : 'Never backed up'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Save to Cloud ────────────────────────────────────────────────────────────

const PHASE_LABELS = {
  'saving-local':        'Saving to IndexedDB...',
  'verifying-integrity': 'Verifying database integrity...',
  'json-snapshot':       'Creating local JSON backup file...',
  'uploading':           'Uploading to Supabase...',
  'verifying-upload':    'Verifying cloud upload...',
  'done':                'Done',
};
const PHASE_ORDER = ['saving-local', 'verifying-integrity', 'json-snapshot', 'uploading', 'verifying-upload', 'done'];

export function SaveToCloudButton({ className = '' }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const start = async () => {
    setOpen(true);
    setRunning(true);
    setResult(null);
    setPhase('saving-local');
    setProgress({ current: 0, total: 0 });
    const res = await saveToCloud((p) => {
      setPhase(p.phase);
      if (p.total) setProgress({ current: p.current, total: p.total });
    });
    setResult(res);
    setRunning(false);
  };

  const close = () => { if (!running) setOpen(false); };
  const phaseIdx = PHASE_ORDER.indexOf(phase);
  const pct = phase === 'uploading' && progress.total
    ? Math.round((progress.current / progress.total) * 100)
    : phaseIdx >= 0 ? Math.round((phaseIdx / (PHASE_ORDER.length - 1)) * 100) : 0;

  return (
    <>
      <button
        onClick={start}
        className={`px-5 py-2.5 text-sm font-bold text-white rounded-lg shadow flex items-center gap-2 hover:shadow-md transition ${className}`}
        style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)' }}>
        ☁️ Save to Cloud
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            {!result ? (
              <>
                <h2 className="text-lg font-bold text-slate-900 mb-4">Backing Up to Cloud</h2>
                <div className="space-y-3">
                  <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct}%`, background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)' }} />
                  </div>
                  <p className="text-sm text-slate-600">{PHASE_LABELS[phase] || 'Working...'}</p>
                  {phase === 'uploading' && progress.total > 0 && (
                    <p className="text-xs text-slate-400">{progress.current} / {progress.total} records</p>
                  )}
                </div>
              </>
            ) : result.ok ? (
              <>
                <div className="text-center mb-4">
                  <span className="text-4xl">✅</span>
                  <h2 className="text-lg font-bold text-slate-900 mt-2">Cloud Backup Successful</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {formatDateTime(result.finishedAt)?.date} {formatDateTime(result.finishedAt)?.time}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-green-50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-green-700">{result.uploaded}</p>
                    <p className="text-xs text-green-600">Uploaded</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-slate-600">{result.skipped}</p>
                    <p className="text-xs text-slate-500">Skipped</p>
                  </div>
                  <div className={`rounded-lg p-2.5 text-center ${result.failed > 0 ? 'bg-red-50' : 'bg-slate-50'}`}>
                    <p className={`text-lg font-bold ${result.failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>{result.failed}</p>
                    <p className={`text-xs ${result.failed > 0 ? 'text-red-500' : 'text-slate-400'}`}>Failed</p>
                  </div>
                </div>
                {result.jsonBackup && (
                  <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-2">
                    📄 JSON backup downloaded: <span className="font-mono">{result.jsonBackup.filename}</span>
                  </p>
                )}
                {result.verification && !result.verification.ok && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
                    ⚠ Upload verification found {result.verification.mismatches.length} discrepancy(ies) — consider running Save to Cloud again.
                  </p>
                )}
                {result.errors?.length > 0 && (
                  <details className="text-xs text-red-600 mb-2">
                    <summary className="cursor-pointer font-semibold">{result.errors.length} error(s)</summary>
                    <ul className="mt-1 space-y-0.5">
                      {result.errors.slice(0, 5).map((e, i) => <li key={i}>{e.table}#{e.id}: {e.message}</li>)}
                    </ul>
                  </details>
                )}
                <button onClick={close} className="w-full mt-2 py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Close
                </button>
              </>
            ) : (
              <>
                <div className="text-center mb-4">
                  <span className="text-4xl">⚠</span>
                  <h2 className="text-lg font-bold text-slate-900 mt-2">Backup Did Not Complete</h2>
                  <p className="text-xs text-slate-500 mt-1">Failed at: {PHASE_LABELS[result.phase] || result.phase}</p>
                </div>
                {result.reason && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2">{result.reason}</p>}
                {result.issues?.length > 0 && (
                  <ul className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2 space-y-0.5">
                    {result.issues.map((iss, i) => <li key={i}>• {iss}</li>)}
                  </ul>
                )}
                <p className="text-xs text-slate-400 mb-3">
                  Your local data in IndexedDB is unaffected. {result.jsonBackup ? 'A JSON backup file was still downloaded.' : ''}
                </p>
                <button onClick={close} className="w-full py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Restore from Cloud ───────────────────────────────────────────────────────

export function RestoreFromCloudButton({ className = '' }) {
  const [step, setStep] = useState(null); // null | 'loading' | 'diff' | 'applying' | 'result' | 'error'
  const [cloud, setCloud] = useState(null);
  const [diff, setDiff] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const start = async () => {
    setStep('loading');
    const cloudResult = await fetchCloudSnapshot();
    if (!cloudResult.ok) {
      setErrorMsg(cloudResult.reason || 'Could not reach Supabase');
      setStep('error');
      return;
    }
    const d = await diffLocalVsCloud(cloudResult);
    setCloud(cloudResult);
    setDiff(d);
    setStep('diff');
  };

  const choose = async (strategy) => {
    if (strategy === 'cancel') { setStep(null); return; }
    setStep('applying');
    const res = await restoreFromCloud(strategy, cloud, diff);
    if (res.applied) {
      useWheelStore.setState(res.fresh);
    }
    setApplyResult({ strategy, ...res });
    setStep('result');
  };

  const close = () => { setStep(null); setCloud(null); setDiff(null); setApplyResult(null); };
  const summary = diff ? summarizeDiff(diff) : null;

  return (
    <>
      <button
        onClick={start}
        className={`px-5 py-2.5 text-sm font-bold text-slate-700 bg-white border-2 border-slate-300 rounded-lg shadow-sm flex items-center gap-2 hover:bg-slate-50 transition ${className}`}>
        📥 Restore from Cloud
      </button>

      {step && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={step === 'applying' ? undefined : close}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6" onClick={(e) => e.stopPropagation()}>

            {step === 'loading' && (
              <div className="text-center py-6">
                <p className="text-sm text-slate-500">Fetching latest data from Supabase...</p>
              </div>
            )}

            {step === 'error' && (
              <>
                <div className="text-center mb-4">
                  <span className="text-4xl">⚠</span>
                  <h2 className="text-lg font-bold text-slate-900 mt-2">Could Not Restore</h2>
                </div>
                <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{errorMsg}</p>
                <p className="text-xs text-slate-400 mb-3">Your local data was not touched.</p>
                <button onClick={close} className="w-full py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Close</button>
              </>
            )}

            {step === 'diff' && summary && (
              <>
                <h2 className="text-lg font-bold text-slate-900 mb-1">Compare Local vs Cloud</h2>
                <p className="text-xs text-slate-500 mb-4">Review the differences before choosing how to proceed. Nothing has changed yet.</p>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <div className="bg-slate-50 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-slate-800">{summary.onlyLocal}</p>
                    <p className="text-xs text-slate-500">Local Only</p>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-blue-700">{summary.onlyCloud}</p>
                    <p className="text-xs text-blue-600">Cloud Only</p>
                  </div>
                  <div className={`rounded-lg p-3 text-center ${summary.conflicting > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
                    <p className={`text-xl font-bold ${summary.conflicting > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{summary.conflicting}</p>
                    <p className={`text-xs ${summary.conflicting > 0 ? 'text-amber-600' : 'text-slate-400'}`}>Conflicts</p>
                  </div>
                </div>
                {(summary.executions.onlyLocal > 0 || summary.executions.onlyCloud > 0) && (
                  <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-4">
                    📒 Trade history (execution ledger): {summary.executions.onlyLocal} local-only, {summary.executions.onlyCloud} cloud-only —
                    <strong> always preserved and merged, never deleted or overwritten</strong>, regardless of which option you choose below.
                  </p>
                )}
                {summary.conflicting > 0 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                    Conflicts will be resolved by keeping whichever copy (local or cloud) was edited most recently, if you choose Merge.
                  </p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={() => choose('cloud-wins')}
                    className="py-2.5 text-xs font-bold text-white rounded-lg" style={{ background: 'linear-gradient(135deg, #ef4444 0%, #f97316 100%)' }}>
                    Restore<br />Cloud → Local
                  </button>
                  <button onClick={() => choose('merge')}
                    className="py-2.5 text-xs font-bold text-white rounded-lg" style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                    Merge<br />Cloud + Local
                  </button>
                  <button onClick={() => choose('cancel')}
                    className="py-2.5 text-xs font-semibold text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">
                    Cancel
                  </button>
                </div>
              </>
            )}

            {step === 'applying' && (
              <div className="text-center py-6">
                <p className="text-sm text-slate-500">Applying changes to your local database...</p>
              </div>
            )}

            {step === 'result' && applyResult && (
              <>
                <div className="text-center mb-4">
                  <span className="text-4xl">✅</span>
                  <h2 className="text-lg font-bold text-slate-900 mt-2">
                    {applyResult.strategy === 'cloud-wins' ? 'Restored from Cloud' : 'Merge Complete'}
                  </h2>
                </div>
                <p className="text-xs text-slate-500 text-center mb-4">
                  {applyResult.strategy === 'cloud-wins'
                    ? 'All local data has been replaced with the cloud copy.'
                    : 'Cloud-only records were added, and conflicts were resolved using the most recently edited copy.'}
                </p>
                <button onClick={close} className="w-full py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Local Version History (last 30 snapshots) ───────────────────────────────

export function SnapshotHistoryList() {
  const [snapshots, setSnapshots] = useState([]);
  const [confirmId, setConfirmId] = useState(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(() => {
    db.snapshots.orderBy('timestamp').reverse().toArray().then(setSnapshots);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const doRestore = async (snapshotId) => {
    setRestoring(true);
    const snap = await db.snapshots.get(snapshotId);
    const fresh = await restoreWholeState(snap.payload);
    useWheelStore.setState(fresh);
    setRestoring(false);
    setConfirmId(null);
    refresh();
  };

  if (snapshots.length === 0) {
    return <p className="text-sm text-slate-400 italic">No local snapshots yet — they're created automatically every time you add, edit, or delete something.</p>;
  }

  return (
    <div className="space-y-2">
      {snapshots.map((snap) => {
        return (
          <div key={snap.id} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-4 py-2.5">
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {formatDateTime(snap.timestamp)?.date} {formatDateTime(snap.timestamp)?.time}
                <span className="text-xs text-slate-400 font-normal ml-2">({relativeTime(snap.timestamp)})</span>
              </p>
              <p className="text-xs text-slate-400">
                {snap.payload?.positions?.length ?? 0} positions · {snap.payload?.journal?.length ?? 0} journal entries · {snap.payload?.campaigns?.length ?? 0} campaigns
              </p>
            </div>
            {confirmId === snap.id ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600 font-semibold">Replace current data?</span>
                <button disabled={restoring} onClick={() => doRestore(snap.id)}
                  className="px-2.5 py-1 text-xs font-semibold bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                  {restoring ? 'Restoring...' : 'Yes, Restore'}
                </button>
                <button onClick={() => setConfirmId(null)} className="px-2.5 py-1 text-xs font-semibold bg-slate-200 text-slate-700 rounded">No</button>
              </div>
            ) : (
              <button onClick={() => setConfirmId(snap.id)}
                className="px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100">
                ↩ Restore this snapshot
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
