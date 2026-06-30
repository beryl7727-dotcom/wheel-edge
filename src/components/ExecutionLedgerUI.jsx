/**
 * Wheel Edge — Execution Ledger UI
 *
 * RollPositionModal: records a Roll as one combined order-ticket-style form
 * (close the old leg + open the new linked leg in a single action).
 *
 * PositionLineageTimeline: walks a position's Opened From / Rolled Into /
 * Closed By / Replacement Position links and renders the chain using the
 * same paired-card visual language already established for Campaign
 * Activity (src/wheel-edge-dashboard.jsx's buildCampaignTimeline).
 */

import React, { useState } from 'react';
import { useWheelStore, POSITION_CATEGORIES, calcDTE } from '../wheel-edge-dashboard.jsx';

// ── Roll Position Modal ──────────────────────────────────────────────────────

export function RollPositionModal({ position, onClose }) {
  const rollPosition = useWheelStore((s) => s.rollPosition);
  const cfg = POSITION_CATEGORIES[position.category] || {};

  const [form, setForm] = useState({
    buybackCost: '', oldFees: '',
    newStrike: position.strike ?? '', newExpiry: '', newPremium: '', newContracts: String(position.contracts || 1), newFees: '',
    newEntryDate: new Date().toISOString().split('T')[0], notes: '',
  });
  const [error, setError] = useState('');
  const upd = (f, v) => { setForm((p) => ({ ...p, [f]: v })); if (error) setError(''); };

  const newDte = calcDTE(form.newEntryDate, form.newExpiry);

  const oldContracts   = position.contracts || 1;
  const oldBuyback     = Number(form.buybackCost) || 0;
  const oldFees        = Number(form.oldFees) || 0;
  const oldRealizedPnL = (position.premium || 0) - (oldBuyback * oldContracts * 100) - oldFees;

  const newPremium = Number(form.newPremium) || 0;
  const newFees    = Number(form.newFees) || 0;
  const newCredit  = newPremium - newFees;

  const rollNetCreditDebit = newCredit - (oldBuyback * oldContracts * 100 + oldFees);

  const handleSubmit = () => {
    if (form.buybackCost === '' || isNaN(Number(form.buybackCost))) { setError('Buyback cost for the old leg is required (enter 0 if expiring worthless)'); return; }
    if (!form.newStrike || !form.newPremium || !form.newExpiry) { setError('New strike, expiry, and premium are required'); return; }
    rollPosition(position.id, {
      buybackCost: oldBuyback, oldFees,
      newStrike: Number(form.newStrike), newExpiry: form.newExpiry, newDte,
      newPremium, newContracts: Number(form.newContracts) || oldContracts, newFees,
      newEntryDate: form.newEntryDate, notes: form.notes,
    });
    onClose();
  };

  const inp = (label, field, placeholder = '') => (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      <input type="number" step="0.01" value={form[field]} onChange={(e) => upd(field, e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">🔄 Roll Position</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {position.category}</span>
              <span className="text-xs text-slate-500">{position.symbol} ${position.strike} · {position.expiry}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Closing Old Leg</p>
            <div className="grid grid-cols-2 gap-3">
              {inp('Buyback Cost per Contract ($)', 'buybackCost', 'e.g. 0.50')}
              {inp('Fees (optional)', 'oldFees', 'e.g. 1.30')}
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Opening New Leg</p>
            <div className="grid grid-cols-3 gap-3 mb-3">
              {inp('New Strike ($)', 'newStrike', 'e.g. 400')}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">New Expiry</label>
                <input type="date" value={form.newExpiry} onChange={(e) => upd('newExpiry', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">DTE <span className="text-blue-500 normal-case">auto</span></label>
                <input type="number" readOnly value={newDte ?? ''} className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-blue-50 font-bold text-blue-900" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {inp('New Premium ($)', 'newPremium', 'e.g. 900')}
              {inp('New Contracts', 'newContracts')}
              {inp('Fees (optional)', 'newFees', 'e.g. 1.30')}
            </div>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 text-sm space-y-1.5">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Roll Preview</p>
            <div className="flex justify-between">
              <span className="text-slate-600">Old Leg P&L (closing)</span>
              <span className={`font-semibold ${oldRealizedPnL >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {oldRealizedPnL >= 0 ? '+' : ''}${oldRealizedPnL.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">New Leg Net Credit (opening)</span>
              <span className={`font-semibold ${newCredit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {newCredit >= 0 ? '+' : ''}${newCredit.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-300">
              <span className="font-bold text-slate-900">Net Credit/Debit for this Roll</span>
              <span className={`font-bold text-lg ${rollNetCreditDebit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {rollNetCreditDebit >= 0 ? '+' : ''}${rollNetCreditDebit.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
            style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
            🔄 Confirm Roll
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Position Lineage Timeline ────────────────────────────────────────────────

function buildLineageChain(position, allPositions) {
  const byId = new Map(allPositions.map((p) => [p.id, p]));
  const chain = [position];

  let cur = position;
  const seenBack = new Set([position.id]);
  while (cur.openedFrom != null && byId.has(cur.openedFrom) && !seenBack.has(cur.openedFrom)) {
    cur = byId.get(cur.openedFrom);
    seenBack.add(cur.id);
    chain.unshift(cur);
  }

  cur = position;
  const seenFwd = new Set([position.id]);
  while (true) {
    const nextId = cur.rolledInto ?? cur.closedBy ?? cur.replacementPosition;
    if (nextId == null || !byId.has(nextId) || seenFwd.has(nextId)) break;
    cur = byId.get(nextId);
    seenFwd.add(cur.id);
    chain.push(cur);
  }

  return chain;
}

export function PositionLineageTimeline({ position, allPositions, onClose }) {
  const chain = buildLineageChain(position, allPositions);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">🔗 Position Lineage</h2>
            <p className="text-xs text-slate-500 mt-0.5">{position.symbol} · {chain.length} linked position{chain.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 overflow-y-auto space-y-0">
          {chain.map((pos, idx) => {
            const cfg      = POSITION_CATEGORIES[pos.category] || {};
            const isCur    = pos.id === position.id;
            const pnl      = pos.closedData?.realizedPnL;
            const pnlOk    = pnl != null && pnl >= 0;
            const isOpen   = pos.status === 'OPEN';
            const linkNote = pos.rolledInto != null ? '🔄 Rolled into →'
              : pos.replacementPosition != null ? '↪ Replaced by →'
              : pos.closedBy != null ? '🏦 Closed by →'
              : null;

            return (
              <div key={pos.id}>
                <div className={`rounded-xl border overflow-hidden ${isCur ? 'border-purple-400 ring-2 ring-purple-100' : isOpen ? 'border-green-200' : 'border-slate-200'}`}>
                  <div className={`flex items-center justify-between px-3 py-1.5 ${isOpen ? 'bg-green-50' : 'bg-slate-50'} border-b ${isOpen ? 'border-green-100' : 'border-slate-100'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.icon} {pos.category}</span>
                      {pos.strike && <span className="text-xs text-slate-600">${pos.strike} strike</span>}
                      {isCur && <span className="text-xs font-bold text-purple-600">· this position</span>}
                    </div>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      isOpen ? 'bg-green-200 text-green-800'
                      : pnl != null ? (pnlOk ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')
                      : 'bg-slate-200 text-slate-600'
                    }`}>
                      {pos.lifecycleStatus || pos.status}
                    </span>
                  </div>
                  <div className="px-3 py-2 text-xs text-slate-600 flex items-center justify-between">
                    <span>{pos.entryDate}{pos.closedData?.closedDate ? ` → ${pos.closedData.closedDate}` : ''}</span>
                    {pnl != null && (
                      <span className={`font-bold ${pnlOk ? 'text-green-700' : 'text-red-600'}`}>
                        {pnlOk ? '+' : ''}${pnl.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
                {idx < chain.length - 1 && (
                  <div className="flex items-center gap-2 pl-4 py-1.5">
                    <div className="w-px bg-slate-300" style={{ height: 12 }} />
                    {linkNote && <span className="text-xs text-slate-500 font-semibold">{linkNote}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">Close</button>
        </div>
      </div>
    </div>
  );
}
