/**
 * Wheel Edge — POEMS Contract Note Import Wizard
 *
 * Modeled on ImportFromTigerModal (wheel-edge-dashboard.jsx) — same modal
 * shell, same store-action access, same selected-row-table pattern —
 * extended to four stages: Upload -> Resolve Matching (conditional) ->
 * Preview -> Summary.
 */

import React, { useState } from 'react';
import { useWheelStore } from '../wheel-edge-dashboard.jsx';
import { POEMS_ADAPTER } from '../services/poemsParser';
import { resolveBatch } from '../services/importMatcher';
import { commitImportBatch } from '../services/poemsImportCommit';

const OPTION_CATEGORY_OPTIONS = ['Short Put', 'Covered Call', 'Naked Call', 'Naked Put'];
const ACTION_OPTIONS = ['Sell to Open', 'Buy to Close', 'Buy to Open', 'Sell to Close'];

function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(png|jpe?g)$/i.test(file.name);
}
function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export default function PoemsImportWizard({ onClose }) {
  const positions   = useWheelStore((s) => s.positions);
  const campaigns    = useWheelStore((s) => s.campaigns);
  const executions   = useWheelStore((s) => s.executions);
  const addPosition  = useWheelStore((s) => s.addPosition);
  const closePosition = useWheelStore((s) => s.closePosition);
  const addCampaign  = useWheelStore((s) => s.addCampaign);

  const [stage, setStage] = useState('upload'); // upload | resolve | preview | summary
  const [fileRows, setFileRows] = useState([]); // [{id, name, status, trades, error, warnings}]
  const [trades, setTrades] = useState([]); // resolved trade rows (post resolveBatch)
  const [result, setResult] = useState(null);

  // ── Upload stage ──────────────────────────────────────────────────────

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList);
    const newRows = files.map((f, i) => ({
      id: `${Date.now()}_${i}`, name: f.name, status: 'parsing', trades: [], error: null, warnings: [],
    }));
    setFileRows((prev) => [...prev, ...newRows]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rowId = newRows[i].id;
      try {
        let parsed;
        if (isPdfFile(file)) parsed = await POEMS_ADAPTER.parsePdf(file);
        else if (isImageFile(file)) parsed = await POEMS_ADAPTER.parseImage(file);
        else parsed = { ok: false, reason: 'Unsupported file type — only PDF, PNG, and JPG are accepted.', trades: [], warnings: [] };

        setFileRows((prev) => prev.map((r) => r.id === rowId ? {
          ...r,
          status: parsed.ok && parsed.trades.length ? 'parsed' : parsed.ok ? 'empty' : 'error',
          trades: parsed.trades || [],
          error: parsed.ok ? null : parsed.reason,
          warnings: parsed.warnings || [],
        } : r));
      } catch (err) {
        setFileRows((prev) => prev.map((r) => r.id === rowId ? { ...r, status: 'error', error: err.message } : r));
      }
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  const removeFile = (id) => setFileRows((prev) => prev.filter((r) => r.id !== id));

  const allParsedTrades = fileRows.flatMap((r) => r.trades);
  const stillParsing = fileRows.some((r) => r.status === 'parsing');

  const proceedToMatching = () => {
    const resolved = resolveBatch(allParsedTrades, {
      existingPositions: positions, existingCampaigns: campaigns, existingExecutions: executions,
    }).map((t) => ({
      ...t,
      selected: !t.isDuplicate && !t.needsResolution && !t.lowConfidence,
    }));
    setTrades(resolved);
    const needsResolution = resolved.some((t) => t.needsResolution);
    setStage(needsResolution ? 'resolve' : 'preview');
  };

  // ── Resolve Matching stage ───────────────────────────────────────────

  const resolveTrade = (idx, candidateId) => {
    setTrades((prev) => prev.map((t, i) => {
      if (i !== idx) return t;
      if (candidateId === '__skip__' || candidateId == null) return { ...t, selected: false };
      const target = t.candidates.find((c) => String(c.id) === String(candidateId));
      if (!target) return t;
      const action = t.buySell === 'SELL' ? 'Sell to Close' : 'Buy to Close';
      return { ...t, action, category: target.category, targetPositionId: target.id, needsResolution: false, selected: true };
    }));
  };

  const unresolvedTrades = trades.map((t, idx) => ({ t, idx })).filter(({ t }) => t.needsResolution);

  // ── Preview stage ─────────────────────────────────────────────────────

  const updTrade = (idx, patch) => setTrades((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
  const toggleAll = (val) => setTrades((prev) => prev.map((t) => (!t.isDuplicate && !t.needsResolution) ? { ...t, selected: val } : t));
  const skipSelected = () => setTrades((prev) => prev.map((t) => t.selected ? { ...t, selected: false } : t));

  const handleImportAll = () => {
    const res = commitImportBatch(trades, { addPosition, closePosition, addCampaign, campaigns });
    setResult(res);
    setStage('summary');
  };

  const selectedCount = trades.filter((t) => t.selected).length;
  const duplicateCount = trades.filter((t) => t.isDuplicate).length;

  // ── Summary stage ─────────────────────────────────────────────────────

  const exportErrorReport = () => {
    if (!result?.errors?.length) return;
    const payload = result.errors.map((e) => ({ message: e.message, trade: e.trade }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `poems-import-errors-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const statusBadge = (t) => {
    if (t.isDuplicate) return <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Duplicate</span>;
    if (t.needsResolution) return <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Needs Review</span>;
    if (t.lowConfidence) return <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">Low Confidence</span>;
    return <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Ready</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-xl font-bold text-slate-900">📄 Import POEMS Contract Note</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {stage === 'upload' && 'Upload one or many PDF contract notes or screenshots.'}
              {stage === 'resolve' && 'A few trades need manual matching before they can be previewed.'}
              {stage === 'preview' && 'Review and select trades before committing.'}
              {stage === 'summary' && 'Import complete.'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">

          {/* ── Upload ────────────────────────────────────────────────── */}
          {stage === 'upload' && (
            <div className="space-y-4">
              <div
                onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
                className="border-2 border-dashed border-purple-300 rounded-xl p-8 text-center bg-purple-50/30 hover:bg-purple-50 transition"
              >
                <p className="text-sm text-slate-600 mb-2">Drag &amp; drop PDF / PNG / JPG contract notes here</p>
                <label className="inline-block px-4 py-2 text-sm font-semibold text-white rounded-lg cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Choose Files
                  <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                    className="hidden" onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
                </label>
              </div>

              {fileRows.length > 0 && (
                <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                  {fileRows.map((r) => (
                    <div key={r.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-slate-700 font-medium">{r.name}</span>
                        {r.status === 'parsing' && <span className="text-xs text-purple-600 flex items-center gap-1"><span className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" /> parsing…</span>}
                        {r.status === 'parsed' && <span className="text-xs text-green-700 font-semibold">✓ {r.trades.length} trade{r.trades.length !== 1 ? 's' : ''} found</span>}
                        {r.status === 'empty' && <span className="text-xs text-amber-600 font-semibold">No trades recognized</span>}
                        {r.status === 'error' && <span className="text-xs text-red-600 font-semibold" title={r.error}>Error — {r.error?.slice(0, 60)}</span>}
                      </div>
                      <button onClick={() => removeFile(r.id)} className="text-slate-400 hover:text-red-600 text-xs ml-3 shrink-0">Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Resolve Matching ─────────────────────────────────────── */}
          {stage === 'resolve' && (
            <div className="space-y-3">
              {unresolvedTrades.map(({ t, idx }) => (
                <div key={idx} className="border border-red-200 bg-red-50 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {t.tradeDate} · {t.buySell} {t.symbol} {t.strike ? `$${t.strike} ${t.callPut}` : ''} {t.expiry ? `exp ${t.expiry}` : ''}
                    </p>
                  </div>
                  <p className="text-xs text-red-700 mb-3">{t.resolutionReason}</p>
                  {t.candidates?.length > 0 ? (
                    <select defaultValue="" onChange={(e) => resolveTrade(idx, e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                      <option value="" disabled>Pick which open position this trade closes…</option>
                      {t.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          #{c.id} — {c.category} · entry {c.entryDate} · {c.contracts || c.shareCount} {c.contracts ? 'contracts' : 'shares'} · remaining {c.remainingQuantity ?? '—'}
                        </option>
                      ))}
                      <option value="__skip__">— Skip this trade —</option>
                    </select>
                  ) : (
                    <button onClick={() => resolveTrade(idx, '__skip__')}
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300">
                      Acknowledge — skip this trade
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Preview ───────────────────────────────────────────────── */}
          {stage === 'preview' && (
            <div className="space-y-3">
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox"
                    checked={trades.filter((t) => !t.isDuplicate && !t.needsResolution).every((t) => t.selected) && trades.length > 0}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="w-4 h-4 accent-purple-600" />
                  <span className="text-slate-600 font-medium">Select all eligible</span>
                </label>
                <span className="text-slate-400">{selectedCount} of {trades.length} selected</span>
                {duplicateCount > 0 && <span className="text-amber-600 font-semibold">⚠ {duplicateCount} duplicate{duplicateCount > 1 ? 's' : ''} (pre-excluded)</span>}
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 border-b border-slate-200">
                    <tr>
                      {['', 'Status', 'Trade Date', 'Type', 'Action', 'Symbol', 'Strike', 'Expiry', 'Contracts', 'Premium', 'Fees', 'Campaign'].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, idx) => {
                      const totalFees = (t.commission || 0) + (t.exchangeFees || 0) + (t.gst || 0);
                      const disabled = t.isDuplicate || t.needsResolution;
                      return (
                        <tr key={idx} className={`border-b border-slate-100 ${disabled ? 'bg-slate-50 opacity-60' : t.selected ? 'bg-white' : 'bg-slate-50 opacity-70'}`}>
                          <td className="px-3 py-2.5 text-center">
                            <input type="checkbox" checked={t.selected} disabled={disabled}
                              onChange={(e) => updTrade(idx, { selected: e.target.checked })}
                              className="w-4 h-4 accent-purple-600" />
                          </td>
                          <td className="px-3 py-2.5">{statusBadge(t)}</td>
                          <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{t.tradeDate}</td>
                          <td className="px-3 py-2.5 text-slate-500 text-xs">{t.assetType === 'option' ? t.callPut : 'Equity'}</td>
                          <td className="px-3 py-2.5">
                            {t.action ? (
                              <select value={t.action} onChange={(e) => updTrade(idx, { action: e.target.value })}
                                className="px-2 py-1 border border-slate-300 rounded text-xs bg-white">
                                {ACTION_OPTIONS.map((a) => <option key={a}>{a}</option>)}
                              </select>
                            ) : <span className="text-xs text-slate-400">—</span>}
                            {t.assetType === 'option' && (t.action === 'Sell to Open' || t.action === 'Buy to Open') && (
                              <select value={t.category || ''} onChange={(e) => updTrade(idx, { category: e.target.value })}
                                className="mt-1 px-2 py-1 border border-slate-300 rounded text-xs bg-white block">
                                {OPTION_CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-bold text-slate-900">{t.symbol}</td>
                          <td className="px-3 py-2.5 text-slate-700">{t.strike ?? '—'}</td>
                          <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{t.expiry ?? '—'}</td>
                          <td className="px-3 py-2.5 text-slate-700">{t.contracts ?? t.quantity ?? '—'}</td>
                          <td className="px-3 py-2.5 text-slate-700">{t.premium != null ? `$${t.premium}` : t.averagePrice != null ? `$${t.averagePrice}` : '—'}</td>
                          <td className="px-3 py-2.5 text-slate-700">${totalFees.toFixed(2)}</td>
                          <td className="px-3 py-2.5">
                            <select value={t.campaignId || (t.isNewCampaign ? '__new__' : '')}
                              onChange={(e) => updTrade(idx, e.target.value === '__new__' ? { isNewCampaign: true, campaignId: null } : { campaignId: e.target.value, isNewCampaign: false })}
                              className="px-2 py-1 border border-slate-300 rounded text-xs bg-white">
                              <option value="">Unassigned</option>
                              <option value="__new__">+ New {t.symbol} Campaign</option>
                              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Summary ───────────────────────────────────────────────── */}
          {stage === 'summary' && result && (
            <div className="flex flex-col items-center justify-center py-8 gap-5">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">✅</div>
              <h3 className="text-xl font-bold text-slate-900">Import Complete</h3>
              <div className="grid grid-cols-4 gap-3 w-full max-w-2xl">
                {[
                  ['Imported', result.imported, 'text-green-700 bg-green-50 border-green-200'],
                  ['Skipped', result.skipped, 'text-slate-600 bg-slate-50 border-slate-200'],
                  ['Duplicates', result.duplicates, 'text-amber-700 bg-amber-50 border-amber-200'],
                  ['Errors', result.errors.length, result.errors.length ? 'text-red-700 bg-red-50 border-red-200' : 'text-slate-400 bg-slate-50 border-slate-200'],
                  ['Positions Created', result.positionsCreated, 'text-blue-700 bg-blue-50 border-blue-200'],
                  ['Executions Created', result.executionsCreated, 'text-purple-700 bg-purple-50 border-purple-200'],
                  ['Journal Entries', result.journalEntriesCreated, 'text-indigo-700 bg-indigo-50 border-indigo-200'],
                  ['Campaigns Updated', result.campaignsUpdated, 'text-teal-700 bg-teal-50 border-teal-200'],
                ].map(([label, val, cls]) => (
                  <div key={label} className={`rounded-xl border p-3 text-center ${cls}`}>
                    <p className="text-xl font-bold">{val}</p>
                    <p className="text-xs opacity-75 mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
              {result.errors.length > 0 && (
                <button onClick={exportErrorReport}
                  className="px-4 py-2 text-sm font-semibold border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                  ⬇ Export Error Report
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between shrink-0">
          {stage === 'upload' && (
            <>
              <p className="text-xs text-slate-500">{allParsedTrades.length} trade{allParsedTrades.length !== 1 ? 's' : ''} parsed so far.</p>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                <button onClick={proceedToMatching} disabled={stillParsing || allParsedTrades.length === 0}
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Continue
                </button>
              </div>
            </>
          )}
          {stage === 'resolve' && (
            <>
              <p className="text-xs text-slate-500">{unresolvedTrades.length} trade{unresolvedTrades.length !== 1 ? 's' : ''} still need resolving.</p>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                <button onClick={() => setStage('preview')}
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Continue to Preview
                </button>
              </div>
            </>
          )}
          {stage === 'preview' && (
            <>
              <p className="text-xs text-slate-500">{selectedCount} trade{selectedCount !== 1 ? 's' : ''} will be imported.</p>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                <button onClick={skipSelected} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Skip Selected</button>
                <button onClick={handleImportAll} disabled={selectedCount === 0}
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Import All ({selectedCount})
                </button>
              </div>
            </>
          )}
          {stage === 'summary' && (
            <div className="w-full flex justify-end">
              <button onClick={onClose}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
                style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
