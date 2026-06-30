/**
 * Wheel Edge — POEMS (Phillip Securities) Contract Note Parser
 *
 * Pure parsing — no UI, no store imports. Independently testable, and the
 * shape every future broker adapter (IBKR/Tiger/Schwab) should implement so
 * the import wizard can be parameterized by adapter without being rewritten:
 *
 *   { id, label, parsePdf(file), parseImage(file), parseText(text, opts) }
 *
 * Field mapping below was reverse-engineered from a real POEMS "Statement of
 * Account & Contract Notes" (Options Account) sample — confirmed by
 * arithmetic: Gross − Commission − Fee = Total; Total − GST = Net.
 * The equity-row parser mirrors the same column shape by structural analogy
 * (no real equity sample was available) and is isolated in
 * `tryParseEquityRow` so it's a one-function fix once a real sample arrives.
 */

// ── number / date helpers ───────────────────────────────────────────────────

const num = (s) => (s == null || s === '' ? null : Number(String(s).replace(/,/g, '')));
const ddmmyyyyToIso = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const MONEY_RE = /^-?[\d,]+\.\d{2,3}$/;

// ── option symbol — "TSLA 20260724C400.000" → underlying/expiry/callPut/strike ──

export function parseOptionSymbol(raw) {
  const m = /^([A-Z.]+)\s*(\d{4})(\d{2})(\d{2})([CP])([\d.]+)$/.exec((raw || '').trim());
  if (!m) return null;
  const [, underlying, yyyy, mm, dd, cp, strike] = m;
  return { underlying, expiry: `${yyyy}-${mm}-${dd}`, callPut: cp === 'C' ? 'Call' : 'Put', strike: num(strike) };
}

// ── header fields (document-level, not row-based) ──────────────────────────

function extractHeader(text) {
  const broker = /PHILLIP SECURITIES/i.test(text) ? 'POEMS (Phillip Securities)' : null;
  const stmtDateM = /DATE:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text);
  const fallbackDateM = /STATEMENT OF HOLDINGS AS OF\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const acctM = /AE\/ACCOUNT NO:\s*(\S+)/i.exec(text) || /ACCOUNT NO:\s*(\S+)/i.exec(text);
  const dateStr = (stmtDateM && stmtDateM[1]) || (fallbackDateM && fallbackDateM[1]) || null;
  return {
    broker,
    statementDate: dateStr ? ddmmyyyyToIso(dateStr) : null,
    accountNo: acctM ? acctM[1] : null,
  };
}

// ── row parsers — token-scan based (tolerant of column-spacing variance from
// PDF/OCR text extraction) rather than one rigid whole-line regex ─────────

function tryParseOptionRow(tokens) {
  const typeIdx = tokens.findIndex((t) => t === 'BUY' || t === 'SELL');
  if (typeIdx === -1) return null;
  const buySell = tokens[typeIdx];

  const before = tokens.slice(0, typeIdx);
  const dateTokens = before.filter((t) => DATE_RE.test(t));
  const tradeDate = dateTokens[0] ? ddmmyyyyToIso(dateTokens[0]) : null;
  const settlementDate = dateTokens[1] ? ddmmyyyyToIso(dateTokens[1]) : null;
  const orderExecId = [...before].reverse().find((t) => /^\d+-\d+$/.test(t)) || null;

  // Symbol may appear as one fused token or two (underlying, then date+C/P+strike).
  const after = tokens.slice(typeIdx + 1);
  let parsedSymbol = null, consumed = 0;
  for (let i = 0; i < Math.min(after.length, 3); i++) {
    if (/^[A-Z.]+\d{8}[CP][\d.]+$/.test(after[i])) { parsedSymbol = parseOptionSymbol(after[i]); consumed = i + 1; break; }
    if (/^[A-Z.]+$/.test(after[i]) && after[i + 1] && /^\d{8}[CP][\d.]+$/.test(after[i + 1])) {
      parsedSymbol = parseOptionSymbol(`${after[i]} ${after[i + 1]}`); consumed = i + 2; break;
    }
  }
  if (!parsedSymbol) return null; // not an options transaction row

  const rest = after.slice(consumed).filter(Boolean);
  const qtyTok = rest.find((t) => /^-?\d+$/.test(t));
  const qtyIdx = qtyTok ? rest.indexOf(qtyTok) : -1;
  const currTok = rest.find((t) => /^[A-Z]{3}$/.test(t));
  const lotTok = qtyIdx >= 0 ? rest.slice(qtyIdx + 1).find((t) => /^\d+$/.test(t) && t !== currTok) : null;
  const moneyToks = rest.filter((t) => MONEY_RE.test(t));
  const [priceTok, grossTok, totalTok, netTok] = moneyToks;

  return {
    assetType: 'option',
    tradeDate, settlementDate, orderExecId, buySell,
    symbol: parsedSymbol.underlying, callPut: parsedSymbol.callPut,
    strike: parsedSymbol.strike, expiry: parsedSymbol.expiry,
    contracts: qtyTok ? Math.abs(num(qtyTok)) : null,
    lotSize: lotTok ? num(lotTok) : 100,
    currency: currTok || null,
    premium: num(priceTok),
    grossAmount: num(grossTok), totalAmount: num(totalTok), netAmount: num(netTok),
  };
}

// EQUITY ROW — best-effort, no real sample available yet. Same token-scan
// shape as the options row but without the option-symbol suffix.
function tryParseEquityRow(tokens) {
  const typeIdx = tokens.findIndex((t) => t === 'BUY' || t === 'SELL');
  if (typeIdx === -1) return null;
  const buySell = tokens[typeIdx];

  const before = tokens.slice(0, typeIdx);
  const dateTokens = before.filter((t) => DATE_RE.test(t));
  const tradeDate = dateTokens[0] ? ddmmyyyyToIso(dateTokens[0]) : null;
  const settlementDate = dateTokens[1] ? ddmmyyyyToIso(dateTokens[1]) : null;
  const orderExecId = [...before].reverse().find((t) => /^\d+-\d+$/.test(t)) || null;

  const after = tokens.slice(typeIdx + 1);
  const symbolTok = after.find((t) => /^[A-Z.]{1,6}$/.test(t) && t !== 'USD' && t !== 'SGD');
  if (!symbolTok) return null;
  const rest = after.slice(after.indexOf(symbolTok) + 1).filter(Boolean);
  const qtyTok = rest.find((t) => /^-?[\d,]+$/.test(t) && !MONEY_RE.test(t));
  const currTok = rest.find((t) => /^[A-Z]{3}$/.test(t));
  const moneyToks = rest.filter((t) => MONEY_RE.test(t));
  const [priceTok, grossTok, totalTok, netTok] = moneyToks;

  return {
    assetType: 'equity',
    tradeDate, settlementDate, orderExecId, buySell,
    symbol: symbolTok, securityName: null,
    quantity: qtyTok ? Math.abs(num(qtyTok)) : null,
    currency: currTok || null,
    averagePrice: num(priceTok),
    grossAmount: num(grossTok), totalAmount: num(totalTok), netAmount: num(netTok),
  };
}

// Fee/commission continuation line, e.g.:
// "Comm (SR) 2.88   Fee (SR) 0.09   Exchange Rate 1.2883   Tax @ 9%* 0.26|SGD0.33"
function applyFeeLine(trade, line) {
  const commM = /Comm\s*\([A-Z]+\)\s*([\d,]+\.\d+)/i.exec(line);
  const feeM = /Fee\s*\([A-Z]+\)\s*([\d,]+\.\d+)/i.exec(line);
  const fxM = /Exchange Rate\s*([\d.]+)/i.exec(line);
  const taxM = /Tax\s*@\s*\d+%\*?\s*([\d,]+\.\d+)/i.exec(line);
  if (!commM && !feeM && !fxM && !taxM) return false;
  if (commM) trade.commission = num(commM[1]);
  if (feeM) trade.exchangeFees = num(feeM[1]);
  if (fxM) trade.exchangeRate = num(fxM[1]);
  if (taxM) trade.gst = num(taxM[1]);
  return true;
}

// ── core text parser ─────────────────────────────────────────────────────

export function parseText(rawText, opts = {}) {
  const warnings = [];
  const text = (rawText || '').replace(/\r/g, '');
  const header = extractHeader(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const trades = [];
  let section = null; // 'option' | 'equity' | null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^OPTIONS TRANSACTION/i.test(line)) { section = 'option'; continue; }
    if (/^(EQUITY|SHARES) TRANSACTION/i.test(line)) { section = 'equity'; continue; }
    if (/^FUND MOVEMENT/i.test(line) || /^FUND BALANCE/i.test(line) || /^STATEMENT OF HOLDINGS/i.test(line)) { section = null; continue; }
    if (/^Sub\s*Total/i.test(line)) continue; // restatement of the row above — cross-check only, not a new trade
    if (!section) continue;

    const tokens = line.split(/\s+/).filter(Boolean);
    const parsed = section === 'option' ? tryParseOptionRow(tokens) : tryParseEquityRow(tokens);
    if (!parsed) continue;

    const trade = {
      sourceFile: opts.sourceFile || null, rawLine: line,
      broker: header.broker, statementDate: header.statementDate, accountNo: header.accountNo,
      contractNumber: null, commission: 0, exchangeFees: 0, gst: 0, exchangeRate: null,
      lowConfidence: !!opts.lowConfidence,
      parseWarnings: [],
      ...parsed,
    };

    let feeFound = false;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      if (applyFeeLine(trade, lines[j])) { feeFound = true; break; }
      if (/^Sub\s*Total/i.test(lines[j]) || /BUY|SELL/.test(lines[j])) break;
    }
    if (!feeFound) {
      trade.parseWarnings.push('No commission/fee/GST line found for this trade — defaulted to 0, please verify.');
      warnings.push(`Row "${trade.symbol}" (line ${i + 1}): no fee/commission line matched.`);
    }
    trades.push(trade);
  }

  if (!header.broker) warnings.push('Could not confirm this document is a POEMS statement (broker header not found).');
  if (!trades.length) warnings.push('No transaction rows recognized in this file.');

  return { ok: true, broker: header.broker, statementDate: header.statementDate, accountNo: header.accountNo, trades, warnings };
}

// ── PDF — extract text via pdfjs-dist, reconstructing visual rows by
// y-coordinate clustering (far more reliable for tabular layouts than raw
// content-stream order, which often interleaves columns) ─────────────────

function reconstructRows(items) {
  const Y_TOLERANCE = 3;
  const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const rows = [];
  let current = null, currentY = null;
  for (const it of sorted) {
    const y = it.transform[5];
    if (currentY == null || Math.abs(y - currentY) > Y_TOLERANCE) {
      if (current) rows.push(current);
      current = []; currentY = y;
    }
    current.push(it);
  }
  if (current) rows.push(current);
  return rows.map((row) => row.sort((a, b) => a.transform[4] - b.transform[4]).map((it) => it.str).join(' '));
}

export async function parsePdf(file) {
  try {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      lines.push(...reconstructRows(content.items));
    }
    return parseText(lines.join('\n'), { sourceFile: file.name });
  } catch (err) {
    return { ok: false, reason: err.message, broker: null, statementDate: null, accountNo: null, trades: [], warnings: [`Failed to parse PDF ${file.name}: ${err.message}`] };
  }
}

// ── Image — OCR via Tesseract.js. Per-document average word confidence
// drives a single lowConfidence flag applied to every trade from that file
// (per-field confidence mapping isn't reliable enough post-tokenization to
// be worth the complexity — a file-level "please verify" signal is). ──────

export async function parseImage(file) {
  try {
    const Tesseract = await import('tesseract.js');
    const { data } = await Tesseract.recognize(file, 'eng');
    const avgConfidence = data.words?.length
      ? data.words.reduce((s, w) => s + w.confidence, 0) / data.words.length
      : 100;
    const lines = (data.lines || []).map((l) => l.text);
    const text = lines.length ? lines.join('\n') : data.text;
    return parseText(text, { sourceFile: file.name, lowConfidence: avgConfidence < 75 });
  } catch (err) {
    return { ok: false, reason: err.message, broker: null, statementDate: null, accountNo: null, trades: [], warnings: [`Failed to OCR ${file.name}: ${err.message}`] };
  }
}

export const POEMS_ADAPTER = { id: 'poems', label: 'POEMS (Phillip Securities)', parsePdf, parseImage, parseText };
