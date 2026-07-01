/**
 * Wheel Edge — Rally Probability Scorer & Market Weather Report Generator
 *
 * Pure business logic — no UI, no store imports.  Takes the wizard form
 * data and returns a fully computed scoring breakdown, market weather
 * visualisation, and rule-based narrative report.
 *
 * All output is deterministic (same inputs → same output) so historical
 * records can be reliably reproduced and compared.
 */

// ── Category weights (must sum to 100) ────────────────────────────────
export const SCORE_WEIGHTS = {
  priceTrend:   20,
  openInterest: 15,
  changeInOI:   10,
  dealerGamma:  15,
  volume:       10,
  iv:           10,
  vix:          10,
  macroEvents:   5,
  bitcoin:       5,
};

// ── Scoring ─────────────────────────────────────────────────────────────────

export function calculateScore(form) {
  const b = {}; // breakdown

  // ─ Price Trend (20) ─────────────────────────────────────────────────
  const emaAbove = [form.aboveEma20, form.aboveEma50, form.aboveEma200].filter(Boolean).length;
  const emaBase  = [0, 5, 10, 15][emaAbove];
  const trendPts = { Rising: 5, Flat: 2, Falling: 0 }[form.priceTrend] ?? 2;
  b.priceTrend   = Math.min(20, emaBase + trendPts);

  // ─ Open Interest (15) ───────────────────────────────────────────────
  const callPts  = { Increasing: 6, Neutral: 3, Decreasing: 0 }[form.callOI]      ?? 3;
  const putPts   = { Increasing: 5, Neutral: 3, Decreasing: 0 }[form.putSupport]  ?? 3;
  const deltaPts = { Bullish: 4, Neutral: 2, Bearish: 0 }[form.deltaBias]         ?? 2;
  b.openInterest = Math.min(15, callPts + putPts + deltaPts);

  // ─ Change in OI (10) ────────────────────────────────────────────────
  const callChg = Math.abs(parseFloat(form.largestCallOIChange) || 0);
  const putChg  = Math.abs(parseFloat(form.largestPutOIChange)  || 0);
  const total   = callChg + putChg;
  let changeScore = 5;
  if (total > 0) {
    const ratio = callChg / total;
    changeScore = ratio > 0.6 ? 10 : ratio > 0.4 ? 6 : 2;
  }
  b.changeInOI = changeScore;

  // ─ Dealer Gamma (15) ────────────────────────────────────────────────
  // Short Gamma = dealers amplify moves = rally fuel; Long Gamma = dampens.
  b.dealerGamma = { 'Short Gamma': 15, Unknown: 7, 'Long Gamma': 3 }[form.dealerPosition] ?? 7;

  // ─ Volume (10) ──────────────────────────────────────────────────────
  let volPts = { 'Above Average': 6, Average: 4, Low: 1 }[form.volumeVsAvg] ?? 4;
  if (form.accumulation)  volPts = Math.min(10, volPts + 3);
  if (form.distribution)  volPts = Math.max(0,  volPts - 3);
  b.volume = volPts;

  // ─ IV (10) ──────────────────────────────────────────────────────────
  // Falling IV = fear subsiding = rally-conducive; Rising IV = increasing fear.
  b.iv = { Falling: 10, Flat: 6, Rising: 3 }[form.ivTrend] ?? 6;

  // ─ VIX (10) ─────────────────────────────────────────────────────────
  b.vix = { Falling: 10, Flat: 6, Rising: 2 }[form.vixTrend] ?? 6;

  // ─ Macro Events (5) ─────────────────────────────────────────────────
  const events = form.macroEvents || [];
  const impWt  = { High: 3, Medium: 2, Low: 1 };
  let wtBull = 0, wtBear = 0, wtTotal = 0;
  events.forEach(ev => {
    const w = impWt[ev.importance] || 1;
    wtTotal += w;
    if (ev.direction === 'Bullish') wtBull += w;
    if (ev.direction === 'Bearish') wtBear += w;
  });
  let macroScore = 3;
  if (wtTotal > 0) {
    const bullRatio = wtBull / wtTotal;
    const bearRatio = wtBear / wtTotal;
    macroScore = bearRatio > 0.6 ? 0 : bullRatio > 0.6 ? 5 : 3;
  }
  b.macroEvents = macroScore;

  // ─ Bitcoin Confirmation (5) ─────────────────────────────────────────
  // Only scored for IBIT; others default to neutral (3).
  if (form.market === 'IBIT') {
    const btcPts  = { 'Higher Highs': 3, Sideways: 1, 'Lower Highs': 0 }[form.bitcoinTrend] ?? 1;
    const flowPts = { Positive: 2, Neutral: 1, Negative: 0 }[form.etfFlows] ?? 1;
    b.bitcoin = Math.min(5, btcPts + flowPts);
  } else {
    b.bitcoin = 3; // not applicable — neutral
  }

  const totalScore = Math.round(Object.values(b).reduce((s, v) => s + v, 0));

  return { totalScore: Math.min(100, Math.max(0, totalScore)), breakdown: b };
}

// ── Interpretation helpers ──────────────────────────────────────────────────

export function interpretScore(score) {
  if (score >= 81) return { band: 'HIGH',    label: 'High-Probability Momentum', color: '#16a34a', text: 'text-green-700' };
  if (score >= 61) return { band: 'PREPARE', label: 'Prepare to Enter',          color: '#65a30d', text: 'text-lime-700' };
  if (score >= 31) return { band: 'WATCH',   label: 'Watchlist Only',            color: '#d97706', text: 'text-amber-700' };
  return                  { band: 'AVOID',   label: 'Avoid Buying Calls',        color: '#dc2626', text: 'text-red-700' };
}

// ── Market Weather ──────────────────────────────────────────────────────────

export function generateWeather(form, { totalScore, breakdown }) {
  // Wind Direction — driven by price trend + delta bias + call OI
  const directionScore = [
    { v: form.priceTrend  === 'Rising',     w: 3 },
    { v: form.priceTrend  === 'Falling',    w: -3 },
    { v: form.deltaBias   === 'Bullish',    w: 2 },
    { v: form.deltaBias   === 'Bearish',    w: -2 },
    { v: form.callOI      === 'Increasing', w: 2 },
    { v: form.callOI      === 'Decreasing', w: -2 },
    { v: form.aboveEma20,                   w: 1 },
    { v: form.aboveEma50,                   w: 1 },
    { v: form.aboveEma200,                  w: 1 },
  ].reduce((s, {v,w}) => s + (v ? w : 0), 0);

  const windDirection = directionScore >= 3 ? 'Bullish' : directionScore <= -3 ? 'Bearish' : 'Neutral';

  // Wind Strength — driven by gamma + volume + ema alignment
  const alignedEMAs = [form.aboveEma20, form.aboveEma50, form.aboveEma200].filter(Boolean).length;
  const strengthRaw = (breakdown.dealerGamma / 15) * 40
    + (breakdown.volume / 10) * 30
    + (alignedEMAs / 3) * 30;
  const windStrength = strengthRaw >= 65 ? 'Strong' : strengthRaw >= 35 ? 'Moderate' : 'Weak';

  // Pressure — driven by IV trend, VIX trend, momentum direction
  const pressurePts = [
    form.ivTrend  === 'Falling' ?  1 : form.ivTrend  === 'Rising' ? -1 : 0,
    form.vixTrend === 'Falling' ?  1 : form.vixTrend === 'Rising' ? -1 : 0,
    form.priceTrend === 'Rising' ? 1 : form.priceTrend === 'Falling' ? -1 : 0,
    form.callOI === 'Increasing' ? 1 : form.callOI === 'Decreasing' ? -1 : 0,
  ].reduce((a, b) => a + b, 0);
  const pressure = pressurePts >= 2 ? 'Rising' : pressurePts <= -2 ? 'Falling' : 'Stable';

  // Storm Probability — VIX spike, high current VIX, rising IV, bearish macro
  const vixNum = parseFloat(form.currentVIX) || 0;
  const stormPts = [
    form.vixTrend === 'Rising'  ? 2 : 0,
    vixNum > 25                 ? 2 : vixNum > 18 ? 1 : 0,
    form.ivTrend  === 'Rising'  ? 1 : 0,
    breakdown.macroEvents < 2   ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
  const stormProbability = stormPts >= 4 ? 'High' : stormPts >= 2 ? 'Medium' : 'Low';

  // Current Condition — named characterization of market state
  let condition = 'Consolidation';
  if (totalScore >= 85 && windDirection === 'Bullish')                          condition = 'Strong Momentum';
  else if (totalScore >= 70 && form.dealerPosition === 'Short Gamma')           condition = 'Breakout Watch';
  else if (totalScore >= 61 && windDirection === 'Bullish')                     condition = 'Building Momentum';
  else if (totalScore >= 50 && form.distribution)                               condition = 'Exhaustion Risk';
  else if (totalScore >= 40 && stormProbability === 'High')                     condition = 'High Volatility';
  else if (totalScore < 40 && windDirection === 'Bearish')                      condition = 'Bearish Pressure';
  else if (totalScore < 40 && pressure === 'Rising')                            condition = 'Trend Reversal Watch';
  else if (totalScore >= 50 && totalScore < 61 && windDirection === 'Neutral')  condition = 'Cooling Off';

  return { windDirection, windStrength, pressure, stormProbability, condition };
}

// ── Confidence ──────────────────────────────────────────────────────────────

export function calculateConfidence(form, { totalScore }) {
  const indicators = [
    { bull: form.aboveEma20,                           bear: !form.aboveEma20 && form.currentPrice > 0 },
    { bull: form.aboveEma50,                           bear: !form.aboveEma50 && form.currentPrice > 0 },
    { bull: form.aboveEma200,                          bear: !form.aboveEma200 && form.currentPrice > 0 },
    { bull: form.priceTrend === 'Rising',              bear: form.priceTrend === 'Falling' },
    { bull: form.callOI === 'Increasing',              bear: form.callOI === 'Decreasing' },
    { bull: form.deltaBias === 'Bullish',              bear: form.deltaBias === 'Bearish' },
    { bull: form.dealerPosition === 'Short Gamma',     bear: form.dealerPosition === 'Long Gamma' },
    { bull: form.accumulation,                         bear: form.distribution },
    { bull: form.ivTrend === 'Falling',                bear: form.ivTrend === 'Rising' },
    { bull: form.vixTrend === 'Falling',               bear: form.vixTrend === 'Rising' },
  ];

  const bullish = indicators.filter(i => i.bull).length;
  const bearish = indicators.filter(i => i.bear).length;
  const total   = indicators.length;

  const dominant   = Math.max(bullish, bearish);
  const agreement  = dominant / total; // 0.5 = split, 1.0 = unanimous
  const confidence = Math.round(30 + agreement * 70); // 30–100%

  const majority = bullish > bearish ? 'bullish' : bullish < bearish ? 'bearish' : 'mixed';
  let reason;
  if (agreement >= 0.8)      reason = `High confidence — ${dominant}/${total} indicators align ${majority}.`;
  else if (agreement >= 0.6) reason = `Moderate confidence — most indicators point ${majority} but a few conflict.`;
  else                       reason = `Low confidence — signals are mixed. Price action and options positioning may be conflicting.`;

  return { confidence: Math.min(100, confidence), reason, bullish, bearish, total };
}

// ── Narrative Report ────────────────────────────────────────────────────────

export function generateReport(form, scoring, weather) {
  const { totalScore, breakdown } = scoring;
  const { windDirection, windStrength, stormProbability, condition } = weather;
  const interp = interpretScore(totalScore);

  const paragraphs = [];

  // Opening context
  paragraphs.push(
    `The Rally Probability Meter for ${form.market} on ${form.date} reads **${totalScore}/100** — ${interp.label.toLowerCase()}. ` +
    `Market conditions are characterised as **${condition}**, with ${windDirection.toLowerCase()} wind direction and ${windStrength.toLowerCase()} strength.`
  );

  // Price structure commentary
  const emaAbove = [form.aboveEma20, form.aboveEma50, form.aboveEma200].filter(Boolean).length;
  if (emaAbove === 3) {
    paragraphs.push(
      `**Price Structure is Strong.** Price is trading above all three EMAs (20 / 50 / 200), a bullish alignment that supports a sustained upward move. ` +
      `The ${form.priceTrend === 'Rising' ? 'rising trend adds further conviction' : form.priceTrend === 'Flat' ? 'flat trend suggests consolidation before the next leg' : 'falling trend is a yellow flag — watch closely before adding exposure'}.`
    );
  } else if (emaAbove === 0) {
    paragraphs.push(
      `**Price Structure is Weak.** Price is below all three EMAs. A meaningful rally would first require reclaiming the 20 EMA as support. ` +
      `${form.priceTrend === 'Rising' ? 'The rising trend may signal a bottoming attempt — watch for a close above the 20 EMA.' : 'Avoid buying calls until structure improves.'}`
    );
  } else {
    paragraphs.push(
      `**Price Structure is Mixed.** Price is above ${emaAbove} of 3 EMAs. ` +
      `${form.priceTrend === 'Rising' ? 'The rising trend is constructive, but full EMA reclamation would strengthen the case for calls.' : 'Momentum needs to confirm before committing.'}`
    );
  }

  // Options positioning
  if (breakdown.openInterest >= 12) {
    paragraphs.push(
      `**Buying Pressure is Increasing.** Call open interest is ${form.callOI?.toLowerCase() ?? 'elevated'} and delta bias reads ${form.deltaBias?.toLowerCase() ?? 'bullish'}. ` +
      `Put support is ${form.putSupport?.toLowerCase() ?? 'present'}, acting as a floor that discourages aggressive selling.`
    );
  } else if (form.callOI === 'Decreasing' && form.deltaBias === 'Bearish') {
    paragraphs.push(
      `**Selling Pressure is Increasing.** Call open interest is declining and the delta bias is bearish. ` +
      `Options positioning currently favours downside protection over upside participation.`
    );
  }

  // Dealer gamma
  if (form.dealerPosition === 'Short Gamma') {
    paragraphs.push(
      `**Dealer Positioning Amplifies Moves.** Dealers are short gamma, meaning they must delta-hedge by buying as price rises and selling as it falls. ` +
      `This creates a feedback loop that can accelerate a rally once it starts — a key ingredient for breakout conditions.`
    );
  } else if (form.dealerPosition === 'Long Gamma') {
    paragraphs.push(
      `**Dealers Are Dampening Volatility.** With dealers long gamma, they hedge by selling into strength and buying weakness. ` +
      `This constrains explosive moves in either direction — conditions are more suited for range-bound premium selling than directional call buying.`
    );
  }

  // Volume / accumulation
  if (form.accumulation && form.volumeVsAvg === 'Above Average') {
    paragraphs.push(
      `**Volume Confirms Buying Pressure.** Today's volume is above average with accumulation signals present. ` +
      `Institutional participation at this level increases the probability that the move is sustainable rather than a low-conviction bounce.`
    );
  } else if (form.distribution) {
    paragraphs.push(
      `**Distribution is Present.** Volume shows distribution rather than accumulation. ` +
      `${condition === 'Exhaustion Risk' ? 'This is a high-caution signal — the current rally may be losing institutional support.' : 'Be cautious adding new long exposure until distribution clears.'}`
    );
  } else if (form.volumeVsAvg === 'Low') {
    paragraphs.push(
      `**Volume is Thin.** Below-average volume limits the reliability of today's price action. ` +
      `Moves on light volume can reverse quickly — confirmation on stronger volume is preferred before acting.`
    );
  }

  // Volatility
  if (form.ivTrend === 'Falling' && form.vixTrend === 'Falling') {
    paragraphs.push(
      `**Volatility is Contracting.** Both implied volatility and VIX are falling, which is historically conducive to rallies. ` +
      `Options premiums are declining, meaning buying calls may offer better value now than when fear was elevated.`
    );
  } else if (form.ivTrend === 'Rising' && form.vixTrend === 'Rising') {
    paragraphs.push(
      `**Volatility is Expanding.** Both IV and VIX are rising. Elevated volatility inflates call premiums, ` +
      `which reduces the risk/reward of buying calls. Storm probability is rated **${stormProbability}**. Consider whether the premium cost justifies the entry.`
    );
  }

  // IBIT / Bitcoin
  if (form.market === 'IBIT') {
    if (form.bitcoinTrend === 'Higher Highs' && form.etfFlows === 'Positive') {
      paragraphs.push(
        `**Bitcoin Confirms the Move.** Bitcoin is making higher highs and ETF flows are positive. ` +
        `IBIT tends to track BTC momentum closely — the underlying confirmation strengthens the rally thesis.`
      );
    } else if (form.bitcoinTrend === 'Lower Highs') {
      paragraphs.push(
        `**Bitcoin Divergence is a Risk.** Bitcoin is forming lower highs, which conflicts with any bullish IBIT thesis. ` +
        `Historically, ETF price without Bitcoin confirmation has a high reversal rate.`
      );
    }
  }

  // Macro events
  const events = form.macroEvents || [];
  const bearishEvents = events.filter(e => e.direction === 'Bearish');
  const bullishEvents = events.filter(e => e.direction === 'Bullish');
  if (bearishEvents.length > 0) {
    const names = bearishEvents.slice(0, 3).map(e => e.title).join(', ');
    paragraphs.push(
      `**Macro Risk is Elevated.** Upcoming events with bearish implications include: ${names}. ` +
      `Consider reducing size or waiting for these catalysts to pass before adding directional exposure.`
    );
  } else if (bullishEvents.length > 0 && bearishEvents.length === 0) {
    paragraphs.push(
      `**Macro Events Are Supportive.** Upcoming calendar events lean bullish. ` +
      `If the rest of the setup holds, macro conditions are not adding headwinds at this time.`
    );
  }

  // Closing recommendation
  if (totalScore >= 81) {
    paragraphs.push(
      `**Conclusion — High-Probability Setup.** The weight of evidence supports a high-probability momentum environment. ` +
      `Only act if personal entry rules are confirmed (entry trigger, defined risk, position size). The meter does not replace rules — it provides context.`
    );
  } else if (totalScore >= 61) {
    paragraphs.push(
      `**Conclusion — Conditions Are Improving.** The setup is constructive but not fully confirmed. ` +
      `Watch for a volume-confirmed trigger and EMA reclamation. Prepare the trade thesis now so you can act quickly if conditions align.`
    );
  } else if (totalScore >= 31) {
    paragraphs.push(
      `**Conclusion — Watchlist Mode.** Conditions do not yet justify a call-buying entry. ` +
      `Add to the watchlist, monitor for improving signals, and revisit tomorrow's report.`
    );
  } else {
    paragraphs.push(
      `**Conclusion — Avoid Buying Calls.** Multiple indicators are unfavourable. The risk of a failed rally is elevated. ` +
      `Selling premium (puts on support, or covered calls into bounces) may be better suited to current conditions.`
    );
  }

  return { paragraphs };
}
