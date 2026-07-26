// Receipt OCR: scans a photographed receipt and extracts its total amount.
// Runs entirely client-side via vendored Tesseract.js — see
// docs/superpowers/specs/2026-07-26-receipt-ocr-design.md.

const _TOTAL_KEYWORDS = [
  // English
  'AMOUNT DUE', 'TOTAL',
  // Spanish
  'TOTAL A PAGAR', 'IMPORTE',
  // French
  'MONTANT TOTAL', 'MONTANT',
  // German
  'GESAMTBETRAG', 'GESAMT', 'SUMME',
  // Greek
  'ΣΥΝΟΛΟ',
  // Dutch
  'TOTAAL', 'TE BETALEN',
];

// Matches a number in either decimal convention: 1.234,56 or 1,234.56 or plain 12.34 / 12,34
const _NUMBER_RE = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2}|\d+/g;

function _isWordChar(c) {
  return c !== undefined && /[\p{L}-]/u.test(c);
}

function _keywordMatchesLine(line, kw) {
  let idx = line.indexOf(kw);
  while (idx !== -1) {
    if (!_isWordChar(line[idx - 1]) && !_isWordChar(line[idx + kw.length])) return true;
    idx = line.indexOf(kw, idx + 1);
  }
  return false;
}

function _looksLikeDateOrTimeOrId(token, fullLine) {
  // Date-shaped: DD/MM/YYYY or DD-MM-YYYY appearing anywhere on the line
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(fullLine)) return true;
  // Time-shaped: HH:MM
  if (/\b\d{1,2}:\d{2}\b/.test(fullLine)) return true;
  // Long digit runs with no separators (phone numbers, receipt/transaction IDs) —
  // checked on the raw token, NOT after stripping punctuation, so a
  // thousands/decimal-separated amount like "4.250,00" is never misread as an ID.
  if (/^\d{6,}$/.test(token)) return true;
  return false;
}

function _normalizeNumber(raw) {
  // Decide the decimal convention by which separator appears last (closest to the end).
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;
  if (lastComma > lastDot) {
    // Comma is the decimal separator: strip dots (thousands), replace comma with dot.
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Dot is the decimal separator: strip commas (thousands).
    normalized = raw.replace(/,/g, '');
  }
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function extractAmountFromReceiptText(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const upperLines = lines.map(l => l.toUpperCase());

  // 1) Keyword-directed search: look for a keyword, then the nearest number
  //    on that same line or the next one.
  for (let i = 0; i < upperLines.length; i++) {
    const line = upperLines[i];
    const hasKeyword = _TOTAL_KEYWORDS.some(kw => _keywordMatchesLine(line, kw));
    if (!hasKeyword) continue;

    const candidates = [lines[i], lines[i + 1] || ''];
    for (const candidateLine of candidates) {
      const matches = candidateLine.match(_NUMBER_RE) || [];
      for (const m of matches) {
        if (_looksLikeDateOrTimeOrId(m, candidateLine)) continue;
        const value = _normalizeNumber(m);
        if (value !== null) return value;
      }
    }
  }

  // 2) Fallback: largest plausible number anywhere in the text.
  let best = null;
  for (const line of lines) {
    const matches = line.match(_NUMBER_RE) || [];
    for (const m of matches) {
      if (_looksLikeDateOrTimeOrId(m, line)) continue;
      const value = _normalizeNumber(m);
      if (value !== null && (best === null || value > best)) best = value;
    }
  }
  return best;
}

async function scanReceiptForAmount(file) {
  if (typeof Tesseract === 'undefined') return null;
  let worker;
  try {
    worker = await Tesseract.createWorker('eng+ell', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract/tesseract-core-simd-lstm.js',
      langPath: '/vendor/tesseract/lang-data',
      cachePath: '/vendor/tesseract/lang-data',
    });
    const { data } = await worker.recognize(file);
    return extractAmountFromReceiptText(data.text);
  } catch (err) {
    console.error('Receipt scan failed:', err);
    return null;
  } finally {
    if (worker) await worker.terminate();
  }
}
