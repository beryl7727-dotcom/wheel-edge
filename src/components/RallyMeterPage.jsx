/**
 * Wheel Edge — Rally Probability Meter
 *
 * Four-section feature:
 *   1. Wizard (7-step guided data entry)
 *   2. Report (gauge + weather + AI narrative)
 *   3. History (searchable table of saved reports)
 *   4. Trends (Recharts line charts over time)
 *
 * Business logic lives in src/services/rallyScorer.js (pure, no UI).
 * Data persisted in IndexedDB via Dexie (db.rallyReports, added in v4).
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useWheelStore } from '../wheel-edge-dashboard.jsx';
import { db } from '../services/db';
import {
  calculateScore, generateWeather, calculateConfidence, generateReport, interpretScore, SCORE_WEIGHTS,
} from '../services/rallyScorer';

// ── Constants ──────────────────────────────────────────────────────────────

const MARKETS = ['TSLA', 'IBIT', 'SPY', 'QQQ', 'Custom'];
const today = () => new Date().toISOString().split('T')[0];

const MACRO_IMPORTANCE = { earnings: 'High', economic: 'High', expiration: 'Medium', crypto: 'Medium', tesla: 'High', personal: 'Low' };

function defaultForm() {
  return {
    market: 'TSLA', customMarket: '', date: today(),
    // Step 2
    currentPrice: '', ema20: '', ema50: '', ema200: '',
    aboveEma20: false, aboveEma50: false, aboveEma200: false,
    priceTrend: 'Flat',
    // Step 3
    largestCallStrike: '', largestPutStrike: '',
    largestCallOIChange: '', largestPutOIChange: '',
    callOI: 'Neutral', putSupport: 'Neutral',
    dealerPosition: 'Unknown', deltaBias: 'Neutral',
    // Step 4
    currentIV: '', ivTrend: 'Flat',
    currentVIX: '', vixTrend: 'Flat',
    // Step 5
    todayVolume: '', volumeVsAvg: 'Average',
    accumulation: false, distribution: false,
    // Step 6
    bitcoinTrend: 'Sideways', etfFlows: 'Neutral',
    // Step 7
    macroEvents: [],
  };
}

// ── SVG Gauge ──────────────────────────────────────────────────────────────

function RallyGauge({ score }) {
  const R = 90, CX = 110, CY = 110;
  const startAngle = 200, sweep = 140; // degrees; arc from bottom-left to bottom-right
  const rad = (deg) => (deg * Math.PI) / 180;

  function arcPath(startDeg, endDeg) {
    const s = { x: CX + R * Math.cos(rad(startDeg)), y: CY + R * Math.sin(rad(startDeg)) };
    const e = { x: CX + R * Math.cos(rad(endDeg)),   y: CY + R * Math.sin(rad(endDeg)) };
    const large = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${R} ${R} 0 ${large} 1 ${e.x} ${e.y}`;
  }

  const totalSweep = 280; // -140° to +140° relative to top = 280° total arc
  const scoreAngle = startAngle + (score / 100) * totalSweep;

  const colour = score >= 81 ? '#16a34a' : score >= 61 ? '#65a30d' : score >= 31 ? '#d97706' : '#dc2626';

  // Needle
  const needleAngle = startAngle + (score / 100) * totalSweep;
  const needleLen = 68;
  const nx = CX + needleLen * Math.cos(rad(needleAngle));
  const ny = CY + needleLen * Math.sin(rad(needleAngle));

  return (
    <svg viewBox="0 0 220 170" className="w-full max-w-xs mx-auto select-none">
      {/* Background arc */}
      <path d={arcPath(startAngle, startAngle + totalSweep)} fill="none" stroke="#e2e8f0" strokeWidth={16} strokeLinecap="round" />
      {/* Score arc */}
      <path d={arcPath(startAngle, scoreAngle)} fill="none" stroke={colour} strokeWidth={16} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.6s ease, d 0.6s ease' }} />
      {/* Ticks for 30, 60, 80 */}
      {[30, 60, 80].map(v => {
        const a = startAngle + (v / 100) * totalSweep;
        const ix = CX + (R - 10) * Math.cos(rad(a)); const iy = CY + (R - 10) * Math.sin(rad(a));
        const ox = CX + (R + 10) * Math.cos(rad(a)); const oy = CY + (R + 10) * Math.sin(rad(a));
        return <line key={v} x1={ix} y1={iy} x2={ox} y2={oy} stroke="#94a3b8" strokeWidth={1.5} />;
      })}
      {/* Needle */}
      <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={colour} strokeWidth={2.5} strokeLinecap="round"
        style={{ transition: 'x2 0.6s ease, y2 0.6s ease' }} />
      <circle cx={CX} cy={CY} r={6} fill={colour} />
      {/* Score label */}
      <text x={CX} y={CY - 20} textAnchor="middle" fontSize={32} fontWeight="800" fill={colour}
        style={{ fontFamily: 'Playfair Display, serif' }}>{score}</text>
      <text x={CX} y={CY - 4} textAnchor="middle" fontSize={11} fill="#64748b">out of 100</text>
      {/* Range labels */}
      {[['0', 200], ['50', 270], ['100', 340]].map(([lbl, ang]) => {
        const lx = CX + (R + 18) * Math.cos(rad(Number(ang)));
        const ly = CY + (R + 18) * Math.sin(rad(Number(ang)));
        return <text key={lbl} x={lx} y={ly} textAnchor="middle" fontSize={9} fill="#94a3b8">{lbl}</text>;
      })}
    </svg>
  );
}

// ── Weather Icon Components ────────────────────────────────────────────────

function WeatherCard({ label, value, icon, colorClass }) {
  return (
    <div className={`rounded-xl border p-3 text-center ${colorClass}`}>
      <p className="text-xl mb-1">{icon}</p>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}

const windDirectionStyle = { Bullish: 'bg-green-50 border-green-200', Neutral: 'bg-slate-50 border-slate-200', Bearish: 'bg-red-50 border-red-200' };
const windIcons = { Bullish: '↑ Bullish', Neutral: '→ Neutral', Bearish: '↓ Bearish' };
const strengthColors = { Strong: 'bg-indigo-50 border-indigo-200', Moderate: 'bg-blue-50 border-blue-200', Weak: 'bg-slate-50 border-slate-200' };
const pressureColors = { Rising: 'bg-emerald-50 border-emerald-200', Stable: 'bg-slate-50 border-slate-200', Falling: 'bg-orange-50 border-orange-200' };
const stormColors = { Low: 'bg-green-50 border-green-200', Medium: 'bg-amber-50 border-amber-200', High: 'bg-red-50 border-red-200' };

// ── Breakdown Bar ──────────────────────────────────────────────────────────

function BreakdownRow({ label, score, max }) {
  const pct = Math.round((score / max) * 100);
  const col = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-400';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-600 w-32 shrink-0">{label}</span>
      <div className="flex-1 bg-slate-100 rounded-full h-2">
        <div className={`${col} h-2 rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700 w-10 text-right">{score}/{max}</span>
    </div>
  );
}

// ── Step components ────────────────────────────────────────────────────────

function StepHeader({ n, title, subtitle }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-6 h-6 rounded-full bg-purple-600 text-white text-xs font-bold flex items-center justify-center">{n}</span>
        <h3 className="text-base font-bold text-slate-900">{title}</h3>
      </div>
      {subtitle && <p className="text-xs text-slate-500 ml-8">{subtitle}</p>}
    </div>
  );
}

function Label({ children }) { return <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{children}</label>; }
function NInput({ value, onChange, placeholder }) {
  return <input type="number" step="any" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />;
}
function RadioGroup({ options, value, onChange }) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${value === o ? 'bg-purple-600 text-white border-purple-600' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
          {o}
        </button>
      ))}
    </div>
  );
}
function CheckBox({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="w-4 h-4 accent-purple-600" />
      {label}
    </label>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function RallyMeterPage() {
  const calendarEvents = useWheelStore(s => s.calendar);

  const [view, setView]       = useState('wizard'); // wizard | report | history | trends
  const [step, setStep]       = useState(1);
  const [form, setForm]       = useState(defaultForm());
  const [scoring, setScoring] = useState(null);
  const [weather, setWeather] = useState(null);
  const [confidence, setConf] = useState(null);
  const [report, setReport]   = useState(null);
  const [reports, setReports] = useState([]);
  const [trendsRange, setTrendsRange] = useState(30);
  const [histSearch, setHistSearch]   = useState('');
  const [histMarket, setHistMarket]   = useState('All');
  const [viewingReport, setViewingReport] = useState(null);
  const [outcomeEdit, setOutcomeEdit] = useState(null);

  const upd = (field, val) => setForm(f => ({ ...f, [field]: val }));

  // Load historical reports
  const loadReports = async () => {
    const all = await db.rallyReports.orderBy('createdAt').reverse().toArray();
    setReports(all);
  };
  useEffect(() => { loadReports(); }, []);

  // Step 7: auto-populate macro events from calendar
  useEffect(() => {
    if (step !== 7) return;
    const thirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const relevant = calendarEvents
      .filter(e => e.date >= today() && e.date <= thirtyDays)
      .map(e => ({
        id: e.id, title: e.title, date: e.date,
        importance: MACRO_IMPORTANCE[e.category] || 'Medium',
        direction: 'Neutral', // user overrides
      }));
    setForm(f => {
      const existing = new Map(f.macroEvents.map(ev => [ev.id, ev]));
      const merged = relevant.map(ev => existing.get(ev.id) ?? ev);
      return { ...f, macroEvents: merged };
    });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute results and navigate to report
  const handleSubmit = () => {
    const sc  = calculateScore(form);
    const wt  = generateWeather(form, sc);
    const cf  = calculateConfidence(form, sc);
    const rp  = generateReport(form, sc, wt);
    setScoring(sc); setWeather(wt); setConf(cf); setReport(rp);
    setView('report');
  };

  const saveReport = async () => {
    const record = {
      market: form.market === 'Custom' ? (form.customMarket || 'Custom') : form.market,
      date: form.date,
      score: scoring.totalScore,
      condition: weather.condition,
      createdAt: new Date().toISOString(),
      inputs: form,
      breakdown: scoring.breakdown,
      weather,
      confidence: confidence.confidence,
      confidenceReason: confidence.reason,
      report: report.paragraphs,
      outcome: null,
    };
    await db.rallyReports.add(record);
    await loadReports();
    alert('Report saved to history.');
  };

  const deleteReport = async (id) => {
    if (!window.confirm('Delete this report?')) return;
    await db.rallyReports.delete(id);
    await loadReports();
  };

  const saveOutcome = async (id, outcome) => {
    await db.rallyReports.update(id, { outcome });
    await loadReports();
    setOutcomeEdit(null);
  };

  const exportCSV = () => {
    const rows = reports.map(r => [
      r.date, r.market, r.score, r.condition, r.confidence, r.outcome?.actual ?? '',
    ]);
    const csv = [['Date','Market','Score','Condition','Confidence','Outcome'], ...rows]
      .map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'rally-reports.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'rally-reports.json'; a.click(); URL.revokeObjectURL(a.href);
  };

  const resetWizard = () => { setForm(defaultForm()); setStep(1); setView('wizard'); };

  // ── Trend chart data ────────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - trendsRange * 86400000).toISOString().split('T')[0];
  const chartData = reports
    .filter(r => r.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({
      date: r.date.slice(5), // MM-DD
      'Rally Score': r.score,
      'Confidence': r.confidence,
      'Price Trend': Math.round((r.breakdown?.priceTrend ?? 0) / SCORE_WEIGHTS.priceTrend * 100),
      'Dealer Gamma': Math.round((r.breakdown?.dealerGamma ?? 0) / SCORE_WEIGHTS.dealerGamma * 100),
      'Volume': Math.round((r.breakdown?.volume ?? 0) / SCORE_WEIGHTS.volume * 100),
      'IV Score': Math.round((r.breakdown?.iv ?? 0) / SCORE_WEIGHTS.iv * 100),
      'VIX Score': Math.round((r.breakdown?.vix ?? 0) / SCORE_WEIGHTS.vix * 100),
      'OI Score': Math.round((r.breakdown?.openInterest ?? 0) / SCORE_WEIGHTS.openInterest * 100),
      'Macro': Math.round((r.breakdown?.macroEvents ?? 0) / SCORE_WEIGHTS.macroEvents * 100),
    }));

  // ── Learning mode stats ─────────────────────────────────────────────────
  const withOutcome = reports.filter(r => r.outcome?.actual);
  const rallied     = withOutcome.filter(r => r.outcome.actual === 'Rally Occurred');
  const accuracy    = withOutcome.length ? Math.round((rallied.filter(r => r.score >= 61).length / Math.max(1, reports.filter(r => r.score >= 61 && r.outcome).length)) * 100) : null;
  const avgRallyScore = rallied.length ? Math.round(rallied.reduce((s, r) => s + r.score, 0) / rallied.length) : null;
  const avgFailScore  = withOutcome.filter(r => r.outcome.actual === 'Rally Failed').length
    ? Math.round(withOutcome.filter(r => r.outcome.actual === 'Rally Failed').reduce((s, r) => s + r.score, 0) / withOutcome.filter(r => r.outcome.actual === 'Rally Failed').length)
    : null;

  // ── Filtered history ────────────────────────────────────────────────────
  const filteredReports = reports.filter(r => {
    if (histMarket !== 'All' && r.market !== histMarket) return false;
    if (histSearch && !r.market.toLowerCase().includes(histSearch.toLowerCase()) && !r.condition.toLowerCase().includes(histSearch.toLowerCase())) return false;
    return true;
  });

  const STEP_LABELS = ['Market', 'Price Structure', 'Options Positioning', 'Volatility', 'Volume', 'Bitcoin', 'Macro Events'];
  const totalSteps = form.market === 'IBIT' ? 7 : 7; // always 7 (step 6 just greys out for non-IBIT)

  // ── Render ──────────────────────────────────────────────────────────────

  const interp = scoring ? interpretScore(scoring.totalScore) : null;

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900" style={{ fontFamily: 'Playfair Display, serif' }}>
            🌤 Rally Probability Meter
          </h1>
          <p className="text-slate-500 mt-1">A market weather forecast — not a prediction engine.</p>
        </div>
        <div className="flex gap-2">
          {['wizard','history','trends'].map(v => (
            <button key={v} onClick={() => setView(v === 'wizard' && view === 'report' ? 'report' : v)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg capitalize transition ${view === v || (v === 'wizard' && view === 'report') ? 'bg-purple-600 text-white' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              {v === 'wizard' ? (view === 'report' ? 'Report' : 'Wizard') : v === 'history' ? 'History' : 'Trends'}
            </button>
          ))}
          {(view === 'wizard' || view === 'report') && (
            <button onClick={resetWizard} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700">↺ New</button>
          )}
        </div>
      </div>

      {/* ── WIZARD VIEW ───────────────────────────────────────────────────── */}
      {view === 'wizard' && (
        <div className="grid grid-cols-3 gap-4">
          {/* Step sidebar */}
          <div className="col-span-1">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-1 sticky top-6">
              {STEP_LABELS.map((label, i) => {
                const n = i + 1;
                const active = n === step;
                const done   = n < step;
                const skip   = n === 6 && form.market !== 'IBIT';
                return (
                  <button key={n} onClick={() => setStep(n)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition text-sm
                      ${active ? 'bg-purple-600 text-white font-semibold' : done ? 'text-slate-600 bg-slate-50' : skip ? 'text-slate-300' : 'text-slate-500 hover:bg-slate-50'}`}>
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                      ${active ? 'bg-white text-purple-600' : done ? 'bg-purple-100 text-purple-700' : 'bg-slate-200 text-slate-500'}`}>
                      {done ? '✓' : n}
                    </span>
                    {label} {skip && <span className="text-xs opacity-50 ml-1">(IBIT only)</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Step content */}
          <div className="col-span-2 bg-white rounded-2xl border border-slate-200 p-6">
            {/* Step 1 — Market */}
            {step === 1 && (
              <div>
                <StepHeader n={1} title="Market" subtitle="Select the instrument you are analysing today." />
                <div className="space-y-4">
                  <div>
                    <Label>Market</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {MARKETS.map(m => (
                        <button key={m} onClick={() => upd('market', m)}
                          className={`py-2.5 text-sm font-semibold rounded-xl border-2 transition
                            ${form.market === m ? 'border-purple-500 bg-purple-50 text-purple-800' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
                          {m}
                        </button>
                      ))}
                    </div>
                    {form.market === 'Custom' && (
                      <input className="mt-2 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                        placeholder="Enter ticker symbol…" value={form.customMarket} onChange={e => upd('customMarket', e.target.value.toUpperCase())} />
                    )}
                  </div>
                  <div>
                    <Label>Date</Label>
                    <input type="date" value={form.date} onChange={e => upd('date', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                </div>
              </div>
            )}

            {/* Step 2 — Price Structure */}
            {step === 2 && (
              <div>
                <StepHeader n={2} title="Price Structure" subtitle="Enter the key moving averages and tick the boxes if price is above each." />
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div><Label>Current Price</Label><NInput value={form.currentPrice} onChange={v => upd('currentPrice', v)} placeholder="e.g. 411.15" /></div>
                  <div><Label>20 EMA</Label><NInput value={form.ema20}           onChange={v => upd('ema20', v)}         placeholder="e.g. 400.00" /></div>
                  <div><Label>50 EMA</Label><NInput value={form.ema50}           onChange={v => upd('ema50', v)}         placeholder="e.g. 390.00" /></div>
                  <div><Label>200 EMA</Label><NInput value={form.ema200}          onChange={v => upd('ema200', v)}        placeholder="e.g. 360.00" /></div>
                </div>
                <div className="space-y-2 mb-5 p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs font-semibold text-slate-500 mb-2">Price Position</p>
                  <CheckBox label="Price above 20 EMA"  checked={form.aboveEma20}  onChange={v => upd('aboveEma20', v)} />
                  <CheckBox label="Price above 50 EMA"  checked={form.aboveEma50}  onChange={v => upd('aboveEma50', v)} />
                  <CheckBox label="Price above 200 EMA" checked={form.aboveEma200} onChange={v => upd('aboveEma200', v)} />
                </div>
                <div>
                  <Label>Trend</Label>
                  <RadioGroup options={['Rising','Flat','Falling']} value={form.priceTrend} onChange={v => upd('priceTrend', v)} />
                </div>
              </div>
            )}

            {/* Step 3 — Options Positioning */}
            {step === 3 && (
              <div>
                <StepHeader n={3} title="Options Positioning" subtitle="Enter open interest data and dealer positioning." />
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div><Label>Largest Call OI Strike</Label><NInput value={form.largestCallStrike} onChange={v => upd('largestCallStrike', v)} placeholder="e.g. 420" /></div>
                  <div><Label>Largest Put OI Strike</Label><NInput value={form.largestPutStrike}  onChange={v => upd('largestPutStrike', v)}  placeholder="e.g. 390" /></div>
                  <div><Label>Largest Change in Call OI</Label><NInput value={form.largestCallOIChange} onChange={v => upd('largestCallOIChange', v)} placeholder="e.g. 15000" /></div>
                  <div><Label>Largest Change in Put OI</Label><NInput value={form.largestPutOIChange}  onChange={v => upd('largestPutOIChange', v)}  placeholder="e.g. 8000" /></div>
                </div>
                <div className="space-y-4">
                  <div><Label>Call Open Interest</Label><RadioGroup options={['Increasing','Neutral','Decreasing']} value={form.callOI}     onChange={v => upd('callOI', v)} /></div>
                  <div><Label>Put Support</Label>         <RadioGroup options={['Increasing','Neutral','Decreasing']} value={form.putSupport} onChange={v => upd('putSupport', v)} /></div>
                  <div><Label>Dealer Position</Label>     <RadioGroup options={['Long Gamma','Short Gamma','Unknown']} value={form.dealerPosition} onChange={v => upd('dealerPosition', v)} /></div>
                  <div><Label>Delta Bias</Label>           <RadioGroup options={['Bullish','Neutral','Bearish']}        value={form.deltaBias}      onChange={v => upd('deltaBias', v)} /></div>
                </div>
              </div>
            )}

            {/* Step 4 — Volatility */}
            {step === 4 && (
              <div>
                <StepHeader n={4} title="Volatility" subtitle="Enter current implied volatility and VIX readings." />
                <div className="grid grid-cols-2 gap-4 mb-5">
                  <div><Label>Current IV (%)</Label><NInput value={form.currentIV}  onChange={v => upd('currentIV', v)}  placeholder="e.g. 32" /></div>
                  <div><Label>Current VIX</Label>    <NInput value={form.currentVIX} onChange={v => upd('currentVIX', v)} placeholder="e.g. 18.5" /></div>
                </div>
                <div className="space-y-4">
                  <div><Label>IV Trend</Label> <RadioGroup options={['Rising','Flat','Falling']} value={form.ivTrend}  onChange={v => upd('ivTrend', v)} /></div>
                  <div><Label>VIX Trend</Label><RadioGroup options={['Rising','Flat','Falling']} value={form.vixTrend} onChange={v => upd('vixTrend', v)} /></div>
                </div>
              </div>
            )}

            {/* Step 5 — Volume */}
            {step === 5 && (
              <div>
                <StepHeader n={5} title="Volume" subtitle="Assess whether today's volume supports the price move." />
                <div className="mb-5">
                  <Label>Today's Volume</Label>
                  <NInput value={form.todayVolume} onChange={v => upd('todayVolume', v)} placeholder="e.g. 82000000" />
                </div>
                <div className="space-y-4">
                  <div>
                    <Label>Compared to Average</Label>
                    <RadioGroup options={['Above Average','Average','Low']} value={form.volumeVsAvg} onChange={v => upd('volumeVsAvg', v)} />
                  </div>
                  <div className="space-y-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                    <CheckBox label="Accumulation (institutions buying)"   checked={form.accumulation}  onChange={v => { upd('accumulation', v); if (v) upd('distribution', false); }} />
                    <CheckBox label="Distribution (institutions selling)"  checked={form.distribution}  onChange={v => { upd('distribution', v);  if (v) upd('accumulation', false); }} />
                  </div>
                </div>
              </div>
            )}

            {/* Step 6 — Bitcoin (IBIT only) */}
            {step === 6 && (
              form.market === 'IBIT' ? (
                <div>
                  <StepHeader n={6} title="Bitcoin Confirmation" subtitle="IBIT tracks Bitcoin closely — confirm the underlying trend." />
                  <div className="space-y-4">
                    <div><Label>Bitcoin Trend</Label><RadioGroup options={['Higher Highs','Sideways','Lower Highs']} value={form.bitcoinTrend} onChange={v => upd('bitcoinTrend', v)} /></div>
                    <div><Label>ETF Flows</Label>    <RadioGroup options={['Positive','Neutral','Negative']}         value={form.etfFlows}     onChange={v => upd('etfFlows', v)} /></div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <span className="text-4xl mb-3">₿</span>
                  <p className="text-slate-500 font-medium">Bitcoin confirmation only applies to IBIT.</p>
                  <p className="text-xs text-slate-400 mt-1">This step is automatically skipped for {form.market}.</p>
                </div>
              )
            )}

            {/* Step 7 — Macro Events */}
            {step === 7 && (
              <div>
                <StepHeader n={7} title="Macro Events" subtitle="Upcoming calendar events (auto-loaded). Set direction for each or add manual entries." />
                {form.macroEvents.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    <p>No upcoming calendar events found in the next 30 days.</p>
                    <p className="text-xs mt-1">Add events in the Calendar tab, or add manual entries below.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {form.macroEvents.map((ev, i) => (
                      <div key={ev.id || i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-800 truncate">{ev.title}</p>
                          <p className="text-xs text-slate-500">{ev.date} · {ev.importance} importance</p>
                        </div>
                        <RadioGroup
                          options={['Bullish','Neutral','Bearish']}
                          value={ev.direction}
                          onChange={dir => setForm(f => ({
                            ...f,
                            macroEvents: f.macroEvents.map((e, j) => j === i ? { ...e, direction: dir } : e),
                          }))}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {/* Manual add */}
                <button onClick={() => setForm(f => ({
                  ...f,
                  macroEvents: [...f.macroEvents, { id: `manual-${Date.now()}`, title: '', date: today(), importance: 'Medium', direction: 'Neutral' }],
                }))} className="mt-3 text-xs text-purple-600 hover:underline">+ Add manual event</button>
              </div>
            )}

            {/* Step navigation */}
            <div className="flex justify-between mt-8 pt-4 border-t border-slate-200">
              <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
                className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg disabled:opacity-30 hover:bg-slate-50">
                ← Back
              </button>
              {step < 7 ? (
                <button onClick={() => setStep(s => s + 1)}
                  className="px-5 py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
                  Next →
                </button>
              ) : (
                <button onClick={handleSubmit}
                  className="px-5 py-2 text-sm font-semibold text-white rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)' }}>
                  🌤 Generate Report
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── REPORT VIEW ───────────────────────────────────────────────────── */}
      {view === 'report' && scoring && weather && confidence && report && (
        <div className="space-y-6">
          {/* Top row: gauge + weather */}
          <div className="grid grid-cols-2 gap-4">
            {/* Gauge card */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col items-center">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                {form.market === 'Custom' ? form.customMarket || 'Custom' : form.market} · {form.date}
              </p>
              <RallyGauge score={scoring.totalScore} />
              <p className="text-lg font-bold mt-2" style={{ color: interp.color }}>{interp.label}</p>
              <p className="text-xs text-slate-500 mt-1 text-center">
                {interp.band === 'AVOID'   && 'Avoid buying calls. Multiple indicators unfavourable.'}
                {interp.band === 'WATCH'   && 'Watchlist only. Conditions are not yet aligned.'}
                {interp.band === 'PREPARE' && 'Prepare to enter. Conditions improving — wait for trigger.'}
                {interp.band === 'HIGH'    && 'High-probability momentum. Enter only when rules confirm.'}
              </p>
            </div>

            {/* Weather card */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">Market Weather</p>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <WeatherCard label="Wind Direction" value={windIcons[weather.windDirection]}  icon="🧭" colorClass={windDirectionStyle[weather.windDirection]} />
                <WeatherCard label="Wind Strength"  value={weather.windStrength}              icon="💨" colorClass={strengthColors[weather.windStrength]} />
                <WeatherCard label="Pressure"       value={weather.pressure}                  icon="🌡" colorClass={pressureColors[weather.pressure]} />
                <WeatherCard label="Storm Risk"     value={weather.stormProbability}          icon="⛈" colorClass={stormColors[weather.stormProbability]} />
              </div>
              <div className="rounded-xl p-3 bg-slate-50 border border-slate-200 text-center">
                <p className="text-xs text-slate-500 mb-1">Current Condition</p>
                <p className="text-base font-bold text-slate-900">{weather.condition}</p>
              </div>
              {/* Confidence */}
              <div className="mt-4 p-3 rounded-xl bg-purple-50 border border-purple-200">
                <div className="flex justify-between items-center mb-1">
                  <p className="text-xs font-semibold text-purple-800">AI Confidence</p>
                  <p className="text-sm font-bold text-purple-900">{confidence.confidence}%</p>
                </div>
                <div className="h-2 bg-purple-200 rounded-full mb-2">
                  <div className="h-2 bg-purple-600 rounded-full" style={{ width: `${confidence.confidence}%` }} />
                </div>
                <p className="text-xs text-purple-700 italic">{confidence.reason}</p>
              </div>
            </div>
          </div>

          {/* Score breakdown */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">Score Breakdown</p>
            <div className="space-y-2.5">
              {Object.entries(scoring.breakdown).map(([key, val]) => {
                const max = SCORE_WEIGHTS[key] ?? 10;
                const labels = { priceTrend: 'Price Trend', openInterest: 'Open Interest', changeInOI: 'Change in OI', dealerGamma: 'Dealer Gamma', volume: 'Volume', iv: 'Implied Volatility', vix: 'VIX', macroEvents: 'Macro Events', bitcoin: 'Bitcoin' };
                return <BreakdownRow key={key} label={labels[key] ?? key} score={val} max={max} />;
              })}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-200 flex justify-between items-center">
              <span className="text-sm font-bold text-slate-700">Total Score</span>
              <span className="text-xl font-bold" style={{ color: interp.color }}>{scoring.totalScore} / 100</span>
            </div>
          </div>

          {/* AI narrative */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">Market Weather Report</p>
            <div className="space-y-3">
              {report.paragraphs.map((para, i) => (
                <p key={i} className="text-sm text-slate-700 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
              ))}
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end gap-3">
            <button onClick={resetWizard} className="px-4 py-2 text-sm font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">↺ New Analysis</button>
            <button onClick={saveReport}
              className="px-5 py-2 text-sm font-semibold text-white rounded-lg"
              style={{ background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)' }}>
              💾 Save to History
            </button>
          </div>
        </div>
      )}

      {/* ── HISTORY VIEW ──────────────────────────────────────────────────── */}
      {view === 'history' && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex items-center gap-3">
            <input value={histSearch} onChange={e => setHistSearch(e.target.value)}
              placeholder="Search…" className="px-3 py-2 border border-slate-300 rounded-lg text-sm flex-1 focus:ring-2 focus:ring-purple-500" />
            <select value={histMarket} onChange={e => setHistMarket(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
              <option>All</option>
              {[...new Set(reports.map(r => r.market))].map(m => <option key={m}>{m}</option>)}
            </select>
            <button onClick={exportCSV}  className="px-3 py-2 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">📥 CSV</button>
            <button onClick={exportJSON} className="px-3 py-2 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-50">📥 JSON</button>
          </div>

          {/* Learning mode stats */}
          {withOutcome.length >= 3 && (
            <div className="grid grid-cols-3 gap-3">
              {accuracy !== null && <div className="bg-white rounded-xl border border-slate-200 p-4 text-center"><p className="text-2xl font-bold text-purple-700">{accuracy}%</p><p className="text-xs text-slate-500">Accuracy Rate</p></div>}
              {avgRallyScore !== null && <div className="bg-white rounded-xl border border-green-200 p-4 text-center"><p className="text-2xl font-bold text-green-700">{avgRallyScore}</p><p className="text-xs text-slate-500">Avg Score before Rally</p></div>}
              {avgFailScore !== null  && <div className="bg-white rounded-xl border border-red-200 p-4 text-center"><p className="text-2xl font-bold text-red-600">{avgFailScore}</p><p className="text-xs text-slate-500">Avg Score before Fail</p></div>}
            </div>
          )}

          {/* Table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {filteredReports.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p>No saved reports yet. Complete a wizard and save to history.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>{['Date','Market','Score','Condition','Confidence','Outcome','Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredReports.map(r => {
                    const inp = interpretScore(r.score);
                    return (
                      <React.Fragment key={r.id}>
                        <tr className="hover:bg-slate-50 transition">
                          <td className="px-4 py-3 text-slate-700">{r.date}</td>
                          <td className="px-4 py-3 font-semibold text-slate-900">{r.market}</td>
                          <td className="px-4 py-3 font-bold" style={{ color: inp.color }}>{r.score}</td>
                          <td className="px-4 py-3 text-slate-600">{r.condition}</td>
                          <td className="px-4 py-3 text-slate-600">{r.confidence}%</td>
                          <td className="px-4 py-3">
                            {r.outcome?.actual ? (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{r.outcome.actual}</span>
                            ) : (
                              <button onClick={() => setOutcomeEdit(r.id)} className="text-xs text-purple-600 hover:underline">Record outcome</button>
                            )}
                          </td>
                          <td className="px-4 py-3 flex gap-2">
                            <button onClick={() => setViewingReport(r)} className="text-xs text-blue-600 hover:underline">View</button>
                            <button onClick={() => deleteReport(r.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                          </td>
                        </tr>
                        {outcomeEdit === r.id && (
                          <tr className="bg-purple-50">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <p className="text-xs font-semibold text-purple-700">Actual Outcome:</p>
                                {['Rally Occurred','Rally Failed','Sideways','Bear Trend Continued','Reversal Confirmed'].map(opt => (
                                  <button key={opt} onClick={() => saveOutcome(r.id, { actual: opt, recordedAt: new Date().toISOString() })}
                                    className="text-xs px-2 py-1 rounded border border-purple-300 text-purple-700 hover:bg-purple-100">{opt}</button>
                                ))}
                                <button onClick={() => setOutcomeEdit(null)} className="text-xs text-slate-500 hover:underline ml-auto">Cancel</button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* View saved report modal */}
          {viewingReport && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setViewingReport(null)}>
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center sticky top-0 bg-white">
                  <div>
                    <h3 className="font-bold text-slate-900">{viewingReport.market} — {viewingReport.date}</h3>
                    <p className="text-xs text-slate-500">Score {viewingReport.score}/100 · {viewingReport.condition}</p>
                  </div>
                  <button onClick={() => setViewingReport(null)} className="text-2xl text-slate-400 hover:text-slate-700">&times;</button>
                </div>
                <div className="px-6 py-4 space-y-3">
                  {(viewingReport.report || []).map((para, i) => (
                    <p key={i} className="text-sm text-slate-700 leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TRENDS VIEW ───────────────────────────────────────────────────── */}
      {view === 'trends' && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {[7,30,90,365].map(d => (
              <button key={d} onClick={() => setTrendsRange(d)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition ${trendsRange === d ? 'bg-purple-600 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                {d === 365 ? '1Y' : `${d}D`}
              </button>
            ))}
          </div>

          {chartData.length < 2 ? (
            <div className="bg-white rounded-2xl border border-slate-200 flex items-center justify-center py-16 text-center">
              <div>
                <p className="text-slate-400 font-medium">Not enough data for charts yet.</p>
                <p className="text-xs text-slate-400 mt-1">Save at least 2 reports to see trend charts.</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {/* Rally Score + Confidence */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">Rally Score & Confidence</p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="Rally Score" stroke="#a855f7" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Confidence"  stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Component scores (normalised to 0-100%) */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">Indicator Scores (% of max)</p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="Price Trend"  stroke="#16a34a" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="Dealer Gamma" stroke="#dc2626" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="OI Score"     stroke="#f97316" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="Volume"       stroke="#0891b2" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="IV Score"     stroke="#7c3aed" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="VIX Score"    stroke="#be185d" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="Macro"        stroke="#854d0e" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
