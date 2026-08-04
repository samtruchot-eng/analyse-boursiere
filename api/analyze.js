// Fonction serverless Vercel — récupère les VRAIS cours (côté serveur, donc pas
// de blocage CORS ni de bac à sable) et renvoie l'analyse en JSON.
//
// Appel : /api/analyze?tickers=AAPL,MSFT,NVDA
// Réponse : { results: [ { ticker, source, price, score, label, ... } ] }
//
// Aucune dépendance externe : uniquement le `fetch` intégré de Node 18+.

// ── Récupération des cours (Stooq CSV, gratuit, sans clé) ──────────────────

function stooqSymbol(t) {
  const s = t.toLowerCase();
  return s.includes('.') || s.includes('^') ? s : `${s}.us`;
}

// Yahoo Finance (endpoint « chart », public, sans clé) — fiable depuis un
// serveur (contrairement à Stooq qui bloque souvent les IP d'hébergeurs).
async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r || !r.timestamp) throw new Error('symbole introuvable');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c == null) continue;
    const day = new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10);
    bars.push({
      day, open: q.open[i] != null ? q.open[i] : c, high: q.high[i] != null ? q.high[i] : c,
      low: q.low[i] != null ? q.low[i] : c, close: c, volume: q.volume[i] != null ? q.volume[i] : 0,
    });
  }
  if (bars.length < 30) throw new Error('historique insuffisant');
  const name = (r.meta && (r.meta.shortName || r.meta.longName)) || null;
  const currency = (r.meta && r.meta.currency) || null;
  return { ticker: ticker.toUpperCase(), bars: bars.slice(-400), source: 'yahoo', name, currency };
}

async function fetchStooq(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol(ticker)}&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (stock-web)' } });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 30) throw new Error('historique insuffisant');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const [day, o, h, l, c, v] = lines[i].split(',');
    const close = parseFloat(c);
    if (!isFinite(close)) continue;
    bars.push({
      day, open: parseFloat(o) || close, high: parseFloat(h) || close,
      low: parseFloat(l) || close, close, volume: parseFloat(v) || 0,
    });
  }
  if (bars.length < 30) throw new Error('trop peu de séances');
  return { ticker: ticker.toUpperCase(), bars: bars.slice(-400), source: 'stooq', name: null, currency: null };
}

// Essaie Yahoo (fiable côté serveur), puis Stooq en secours.
async function fetchSeries(ticker) {
  const errors = [];
  try { return await fetchYahoo(ticker); } catch (e) { errors.push('yahoo(' + (e.message || e) + ')'); }
  try { return await fetchStooq(ticker); } catch (e) { errors.push('stooq(' + (e.message || e) + ')'); }
  throw new Error(errors.join(' ; '));
}

// ── Indicateurs ────────────────────────────────────────────────────────────

function sma(v, p) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function ema(v, p) {
  const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function rsi(v, p = 14) {
  const out = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function macd(v, fast = 12, slow = 26, sig = 9) {
  const ef = ema(v, fast), es = ema(v, slow);
  const line = v.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const defined = line.map((x, i) => [i, x]).filter(([, x]) => x != null);
  const signal = new Array(v.length).fill(null);
  if (defined.length >= sig) {
    const vals = defined.map(([, x]) => x);
    const s = ema(vals, sig);
    defined.forEach(([oi], k) => { signal[oi] = s[k]; });
  }
  const hist = v.map((_, i) => (line[i] != null && signal[i] != null) ? line[i] - signal[i] : null);
  return { line, signal, hist };
}

function bollinger(v, p = 20, k = 2) {
  const mid = sma(v, p);
  const up = new Array(v.length).fill(null), low = new Array(v.length).fill(null);
  for (let i = 0; i < v.length; i++) {
    if (mid[i] == null) continue;
    const w = v.slice(i - p + 1, i + 1);
    const m = mid[i];
    const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / p);
    up[i] = m + k * sd; low[i] = m - k * sd;
  }
  return { up, mid, low };
}

function lastDefined(a) { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; }
function momentum(v, p) { return (v.length > p && v[v.length - 1 - p]) ? (v[v.length - 1] / v[v.length - 1 - p] - 1) * 100 : null; }

// ── Volume : On-Balance Volume (cumule le volume selon le sens de la séance) ──
function obv(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const v = (volumes && volumes[i]) ? volumes[i] : 0;
    out[i] = out[i - 1] + (closes[i] > closes[i - 1] ? v : (closes[i] < closes[i - 1] ? -v : 0));
  }
  return out;
}

// Coefficient de corrélation temps→valeur sur les p dernières valeurs : ∈ [-1,1].
// Positif = série qui monte régulièrement, négatif = qui baisse ; 0 = plat/erratique.
function trendCorr(series, p) {
  const n = Math.min(p, series.length);
  if (n < 3) return 0;
  const w = series.slice(-n);
  const mx = (n - 1) / 2, my = w.reduce((a, b) => a + b, 0) / n;
  let num = 0, dxx = 0, dyy = 0;
  for (let i = 0; i < n; i++) { const dx = i - mx, dy = w[i] - my; num += dx * dy; dxx += dx * dx; dyy += dy * dy; }
  return (dxx === 0 || dyy === 0) ? 0 : num / Math.sqrt(dxx * dyy);
}

// ── ATR (amplitude vraie moyenne) : « de combien ça bouge par jour » ──────────
function trueRanges(barsArr) {
  const tr = [];
  for (let i = 1; i < barsArr.length; i++) {
    const b = barsArr[i], pb = barsArr[i - 1];
    const h = b.high != null ? b.high : b.close, l = b.low != null ? b.low : b.close;
    tr.push(Math.max(h - l, Math.abs(h - pb.close), Math.abs(l - pb.close)));
  }
  return tr;
}
function atr(barsArr, p = 14) {
  const tr = trueRanges(barsArr);
  if (tr.length < p) return null;
  let a = tr.slice(0, p).reduce((s, x) => s + x, 0) / p; // lissage de Wilder
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}

// ── ADX : force de la tendance (peu importe le sens) + sens via +DI / -DI ─────
function adx(barsArr, p = 14) {
  if (barsArr.length < 2 * p) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < barsArr.length; i++) {
    const b = barsArr[i], pb = barsArr[i - 1];
    const h = b.high != null ? b.high : b.close, l = b.low != null ? b.low : b.close;
    const ph = pb.high != null ? pb.high : pb.close, pl = pb.low != null ? pb.low : pb.close;
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(h - l, Math.abs(h - pb.close), Math.abs(l - pb.close)));
  }
  const smooth = (arr) => { // lissage de Wilder cumulé
    const out = new Array(arr.length).fill(null);
    if (arr.length < p) return out;
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    out[p - 1] = s;
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out[i] = s; }
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = p - 1; i < tr.length; i++) {
    if (!trS[i]) { continue; }
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  let adxVal = null;
  if (dx.length >= p) {
    let a = dx.slice(0, p).reduce((s, x) => s + x, 0) / p;
    for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
    adxVal = a;
  }
  const li = tr.length - 1;
  const plusDI = trS[li] ? 100 * pS[li] / trS[li] : null;
  const minusDI = trS[li] ? 100 * mS[li] / trS[li] : null;
  return { adx: adxVal, plusDI, minusDI };
}

// ── Stochastique %K : position du cours dans son couloir haut/bas récent ──────
function stochastic(barsArr, p = 14) {
  if (barsArr.length < p) return null;
  const w = barsArr.slice(-p);
  const hh = Math.max(...w.map(b => b.high != null ? b.high : b.close));
  const ll = Math.min(...w.map(b => b.low != null ? b.low : b.close));
  const c = barsArr[barsArr.length - 1].close;
  return hh === ll ? 50 : 100 * (c - ll) / (hh - ll);
}

// ── Divergence prix / RSI : le cours et l'élan ne racontent pas la même chose ─
function rsiDivergence(closes, rsiArr, look = 40) {
  const n = closes.length;
  if (n < look + 5) return null;
  const half = Math.floor(look / 2), a0 = n - look, aMid = n - half;
  const argmax = (f, t) => { let bi = f; for (let i = f; i < t; i++) if (closes[i] > closes[bi]) bi = i; return bi; };
  const argmin = (f, t) => { let bi = f; for (let i = f; i < t; i++) if (closes[i] < closes[bi]) bi = i; return bi; };
  const hi1 = argmax(a0, aMid), hi2 = argmax(aMid, n), lo1 = argmin(a0, aMid), lo2 = argmin(aMid, n);
  const r = i => rsiArr[i];
  if ([hi1, hi2, lo1, lo2].some(i => r(i) == null)) return null;
  if (closes[hi2] > closes[hi1] && r(hi2) < r(hi1) - 3) return 'bear'; // sommet plus haut, élan plus faible
  if (closes[lo2] < closes[lo1] && r(lo2) > r(lo1) + 3) return 'bull'; // creux plus bas, élan qui se redresse
  return null;
}

// ── Multi-horizon : regroupe le quotidien en « semaines » (5 séances) ─────────
function toWeekly(barsArr) {
  const w = [];
  for (let i = 0; i < barsArr.length; i += 5) {
    const chunk = barsArr.slice(i, i + 5);
    w.push({
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high != null ? b.high : b.close)),
      low: Math.min(...chunk.map(b => b.low != null ? b.low : b.close)),
    });
  }
  return w;
}
// Tendance de fond, lue sur le graphe hebdomadaire.
function weeklyTrend(barsArr) {
  const w = toWeekly(barsArr).map(b => b.close);
  if (w.length < 12) return null;
  const price = w[w.length - 1];
  const s10 = lastDefined(sma(w, 10)), s30 = lastDefined(sma(w, Math.min(30, w.length)));
  const wr = lastDefined(rsi(w, 14));
  let sc = 0;
  if (s10) sc += price > s10 ? 1 : -1;
  if (s30) sc += price > s30 ? 1 : -1;
  if (s10 && s30) sc += s10 > s30 ? 1 : -1;
  return { dir: sc >= 2 ? 'bull' : (sc <= -2 ? 'bear' : 'neutral'), sc, price, s30, rsi: round(wr, 1) };
}

// ── Supports / résistances : plus proches pivots au-dessus / en dessous ───────
function findLevels(barsArr, price) {
  const n = barsArr.length, k = 5, look = Math.min(130, n);
  const highs = [], lows = [];
  for (let i = n - look + k; i < n - k; i++) {
    if (i < k) continue;
    const h = barsArr[i].high != null ? barsArr[i].high : barsArr[i].close;
    const l = barsArr[i].low != null ? barsArr[i].low : barsArr[i].close;
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      const hj = barsArr[j].high != null ? barsArr[j].high : barsArr[j].close;
      const lj = barsArr[j].low != null ? barsArr[j].low : barsArr[j].close;
      if (hj > h) isH = false;
      if (lj < l) isL = false;
    }
    if (isH) highs.push(h);
    if (isL) lows.push(l);
  }
  const res = highs.filter(h => h > price * 1.001).sort((a, b) => a - b)[0];
  const sup = lows.filter(l => l < price * 0.999).sort((a, b) => b - a)[0];
  return {
    resistance: res != null ? round(res, 2) : null, support: sup != null ? round(sup, 2) : null,
    resistance_dist_pct: res != null ? round((res / price - 1) * 100) : null,
    support_dist_pct: sup != null ? round((sup / price - 1) * 100) : null,
  };
}

// ── Événements récents (≈ 7 dernières séances) ───────────────────────────────
function detectEvents(barsArr) {
  const closes = barsArr.map(b => b.close), n = closes.length, price = closes[n - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200), ev = [], seen = new Set();
  const add = (s, text) => { if (!seen.has(text)) { seen.add(text); ev.push({ s, text }); } };
  for (let i = Math.max(1, n - 7); i < n; i++) {
    if (s50[i] != null && s200[i] != null && s50[i - 1] != null && s200[i - 1] != null) {
      if (s50[i - 1] <= s200[i - 1] && s50[i] > s200[i]) add('bull', 'Golden cross tout récent : la moyenne 50 j vient de repasser au-dessus de la 200 j.');
      if (s50[i - 1] >= s200[i - 1] && s50[i] < s200[i]) add('bear', 'Death cross tout récent : la moyenne 50 j vient de repasser sous la 200 j.');
    }
  }
  const win = closes.slice(-252);
  if (price >= Math.max(...win) * 0.999) add('bull', 'Nouveau plus-haut de 52 semaines.');
  if (price <= Math.min(...win) * 1.001) add('bear', 'Nouveau plus-bas de 52 semaines.');
  const prev20 = closes.slice(-21, -1);
  if (prev20.length) {
    if (price > Math.max(...prev20)) add('bull', 'Cassure à la hausse : le cours dépasse le sommet des 20 dernières séances.');
    if (price < Math.min(...prev20)) add('bear', 'Cassure à la baisse : le cours enfonce le creux des 20 dernières séances.');
  }
  return ev;
}

// ── Indice de confiance : les facteurs sont-ils d'accord entre eux ? ──────────
function signalConfidence(contribs, adxVal) {
  const vals = Object.values(contribs);
  if (!vals.length) return { value: 0, label: 'faible' };
  const net = vals.reduce((a, b) => a + b, 0);
  const totAbs = vals.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const agree = vals.filter(v => (net >= 0 ? v >= 0 : v < 0)).reduce((a, b) => a + Math.abs(b), 0);
  let conf = agree / totAbs;
  if (adxVal != null) conf = conf * 0.85 + clamp((adxVal - 15) / 30, 0, 1) * 0.15;
  const value = Math.round(conf * 100);
  return { value, label: value >= 70 ? 'élevée' : (value >= 50 ? 'moyenne' : 'faible') };
}

// ── Fourchette probable à 1 mois (± 1 écart-type, ≈ 2 chances sur 3) ──────────
function projRange(closes, price) {
  const r = dailyReturns(closes);
  if (r.length < 20) return null;
  const sig = stdev(r) * Math.sqrt(21);
  return { low: round(price * (1 - sig), 2), high: round(price * (1 + sig), 2), pct: round(sig * 100, 1) };
}

// ── Bêta & corrélation vs un indice de marché (aligne par date) ───────────────
function betaCorr(stockBars, marketBars) {
  const mMap = new Map(marketBars.map(b => [b.day, b.close]));
  const s = [], m = [];
  for (const b of stockBars) { const mc = mMap.get(b.day); if (mc != null) { s.push(b.close); m.push(mc); } }
  if (s.length < 40) return null;
  const sr = dailyReturns(s), mr = dailyReturns(m), n = Math.min(sr.length, mr.length);
  const sa = sr.slice(-n), ma = mr.slice(-n), ms = mean(sa), mm = mean(ma);
  let cov = 0, vm = 0, vs = 0;
  for (let i = 0; i < n; i++) { const ds = sa[i] - ms, dm = ma[i] - mm; cov += ds * dm; vm += dm * dm; vs += ds * ds; }
  const beta = vm > 0 ? cov / vm : null;
  const corr = (vm > 0 && vs > 0) ? cov / Math.sqrt(vm * vs) : null;
  return { beta: round(beta, 2), corr: round(corr, 2) };
}

// ── MFI (Money Flow Index) : un « RSI » pondéré par les volumes ───────────────
function mfi(barsArr, p = 14) {
  if (barsArr.length < p + 1) return null;
  const tp = barsArr.map(b => ((b.high != null ? b.high : b.close) + (b.low != null ? b.low : b.close) + b.close) / 3);
  let pos = 0, neg = 0;
  for (let i = barsArr.length - p; i < barsArr.length; i++) {
    const rmf = tp[i] * (barsArr[i].volume || 0);
    if (tp[i] > tp[i - 1]) pos += rmf; else if (tp[i] < tp[i - 1]) neg += rmf;
  }
  if (pos + neg === 0) return null; // pas de volume exploitable
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// ── Parabolic SAR : points de retournement / stop suiveur ─────────────────────
function psar(barsArr, step = 0.02, maxStep = 0.2) {
  const n = barsArr.length;
  if (n < 5) return null;
  const H = i => barsArr[i].high != null ? barsArr[i].high : barsArr[i].close;
  const L = i => barsArr[i].low != null ? barsArr[i].low : barsArr[i].close;
  let up = H(1) >= H(0), af = step, ep = up ? H(0) : L(0), sar = up ? L(0) : H(0);
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, L(i - 1), L(Math.max(0, i - 2)));
      if (L(i) < sar) { up = false; sar = ep; ep = L(i); af = step; }
      else if (H(i) > ep) { ep = H(i); af = Math.min(af + step, maxStep); }
    } else {
      sar = Math.max(sar, H(i - 1), H(Math.max(0, i - 2)));
      if (H(i) > sar) { up = true; sar = ep; ep = H(i); af = step; }
      else if (L(i) < ep) { ep = L(i); af = Math.min(af + step, maxStep); }
    }
  }
  return { sar, up };
}

// ── Squeeze : compression de volatilité (Bollinger à l'intérieur de Keltner) ──
function squeeze(barsArr, p = 20) {
  const closes = barsArr.map(b => b.close);
  if (closes.length < p + 1) return null;
  const bb = bollinger(closes, p, 2);
  const bu = lastDefined(bb.up), bl = lastDefined(bb.low), mid = lastDefined(ema(closes, p)), a = atr(barsArr, p);
  if (bu == null || bl == null || mid == null || a == null) return null;
  const ku = mid + 1.5 * a, kl = mid - 1.5 * a;
  return { on: bu < ku && bl > kl, width_pct: round((bu - bl) / closes[closes.length - 1] * 100, 1) };
}

// ── Volume relatif : volume du jour vs sa moyenne récente (conviction) ────────
function relVolume(barsArr, p = 20) {
  const vols = barsArr.map(b => b.volume || 0);
  if (!vols.some(v => v > 0) || vols.length < p + 1) return null;
  const avg = vols.slice(-p - 1, -1).reduce((a, b) => a + b, 0) / p;
  return avg > 0 ? round(vols[vols.length - 1] / avg, 2) : null;
}

// ── Risque ─────────────────────────────────────────────────────────────────

function dailyReturns(c) { const r = []; for (let i = 1; i < c.length; i++) if (c[i - 1]) r.push(c[i] / c[i - 1] - 1); return r; }
function mean(x) { return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0; }
function stdev(x) { if (x.length < 2) return 0; const m = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); }

function maxDrawdown(c) {
  if (c.length < 2) return null;
  let peak = c[0], worst = 0;
  for (const x of c) { if (x > peak) peak = x; if (peak) { const dd = x / peak - 1; if (dd < worst) worst = dd; } }
  return worst * 100;
}

function riskMetrics(c) {
  const r = dailyReturns(c), D = 252;
  const total = c.length >= 2 && c[0] ? (c[c.length - 1] / c[0] - 1) * 100 : null;
  const years = c.length / D;
  const annual = (years > 0 && c[0] > 0 && c[c.length - 1] > 0) ? ((c[c.length - 1] / c[0]) ** (1 / years) - 1) * 100 : null;
  const vol = r.length ? stdev(r) * Math.sqrt(D) * 100 : null;
  const sharpe = (r.length && stdev(r) > 0) ? (mean(r) * D) / (stdev(r) * Math.sqrt(D)) : null;
  const window = c.slice(-D);
  const high = Math.max(...window), low = Math.min(...window);
  return {
    total_return_pct: round(total), annual_return_pct: round(annual), annual_vol_pct: round(vol),
    sharpe: round(sharpe, 2), max_drawdown_pct: round(maxDrawdown(c)),
    high_52w: round(high), low_52w: round(low),
    from_high_pct: high ? round((c[c.length - 1] / high - 1) * 100) : null,
    ret_1m_pct: pctOver(c, 21), ret_6m_pct: pctOver(c, 126), ret_1y_pct: pctOver(c, 252),
  };
}
function pctOver(c, d) { return (c.length > d && c[c.length - 1 - d]) ? round((c[c.length - 1] / c[c.length - 1 - d] - 1) * 100) : null; }
function round(v, n = 1) { return v == null ? null : Math.round(v * 10 ** n) / 10 ** n; }
function clamp(x, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, x)); }

// ── Signaux + score ─────────────────────────────────────────────────────────

const WEIGHTS = {
  trend_lt: 1.5, trend_mt: 1.2, ma_cross: 1.3, rsi: 1.0, macd: 1.2, bollinger: 0.8, momentum: 1.0,
  trend_strength: 1.1, volume: 0.9, stoch: 0.7, divergence: 0.8, htf_trend: 1.3,
  mfi: 0.8, psar: 0.9,
};

function analyze(series) {
  const c = series.bars.map(b => b.close);
  const volumes = series.bars.map(b => b.volume);
  const hasVolume = volumes.some(v => v > 0);
  const price = c[c.length - 1];
  const sma50 = lastDefined(sma(c, 50)), sma200 = lastDefined(sma(c, 200));
  const rsiArr = rsi(c, 14), rsi14 = lastDefined(rsiArr);
  const m = macd(c); const hist = lastDefined(m.hist);
  const bb = bollinger(c, 20, 2); const bbu = lastDefined(bb.up), bbl = lastDefined(bb.low);
  const mom60 = momentum(c, 60);
  const adxData = adx(series.bars, 14);
  const stochK = stochastic(series.bars, 14);
  const obvTrend = hasVolume ? trendCorr(obv(c, volumes), 40) : null;
  const atrVal = atr(series.bars, 14);
  const div = rsiDivergence(c, rsiArr, 40);
  const wk = weeklyTrend(series.bars);
  const levels = findLevels(series.bars, price);
  const events = detectEvents(series.bars);
  const proj = projRange(c, price);
  const mfiV = mfi(series.bars, 14);
  const ps = psar(series.bars);
  const sq = squeeze(series.bars, 20);
  const relVol = relVolume(series.bars, 20);

  const signals = {};
  if (sma50) signals.trend_mt = clamp((price / sma50 - 1) * 8);
  if (sma200) signals.trend_lt = clamp((price / sma200 - 1) * 5);
  if (sma50 && sma200) signals.ma_cross = clamp((sma50 / sma200 - 1) * 12);
  if (rsi14 != null) {
    if (rsi14 >= 70) signals.rsi = clamp(-(rsi14 - 70) / 15);
    else if (rsi14 <= 30) signals.rsi = clamp((30 - rsi14) / 15);
    else signals.rsi = clamp((rsi14 - 50) / 40);
  }
  if (hist != null && price) signals.macd = clamp(hist / (price * 0.02));
  if (bbu && bbl && bbu > bbl) signals.bollinger = clamp((0.5 - (price - bbl) / (bbu - bbl)) * 2);
  if (mom60 != null) signals.momentum = clamp(mom60 / 25);
  // Force de tendance : sens donné par +DI/-DI, atténué quand l'ADX est faible (marché sans direction).
  if (adxData && adxData.plusDI != null && adxData.minusDI != null) {
    const dir = clamp((adxData.plusDI - adxData.minusDI) / 40);
    const conf = adxData.adx != null ? clamp((adxData.adx - 15) / 25, 0, 1) : 0.5;
    signals.trend_strength = clamp(dir * (0.5 + 0.5 * conf));
  }
  // Volume : l'élan des volumes confirme-t-il (ou contredit-il) le mouvement du cours ?
  if (obvTrend != null) signals.volume = clamp(obvTrend);
  if (stochK != null) {
    if (stochK >= 80) signals.stoch = clamp(-(stochK - 80) / 15);
    else if (stochK <= 20) signals.stoch = clamp((20 - stochK) / 15);
    else signals.stoch = clamp((stochK - 50) / 50);
  }
  if (div === 'bear') signals.divergence = -0.6;
  else if (div === 'bull') signals.divergence = 0.6;
  // Tendance de fond (hebdomadaire) : donne au score une conscience du long terme.
  if (wk) signals.htf_trend = wk.s30 ? clamp((wk.price / wk.s30 - 1) * 4) : clamp(wk.sc / 3);
  // MFI : surachat/survente pondéré par les volumes.
  if (mfiV != null) {
    if (mfiV >= 80) signals.mfi = clamp(-(mfiV - 80) / 15);
    else if (mfiV <= 20) signals.mfi = clamp((20 - mfiV) / 15);
    else signals.mfi = clamp((mfiV - 50) / 50);
  }
  // Parabolic SAR : sens de la tendance (cours au-dessus / en dessous du SAR).
  if (ps && ps.sar) signals.psar = clamp((ps.up ? 1 : -1) * (0.35 + Math.min(0.65, Math.abs(price / ps.sar - 1) * 10)));

  let tw = 0, wsum = 0; const contrib = {};
  for (const [k, s] of Object.entries(signals)) { const w = WEIGHTS[k] || 1; tw += w; wsum += s * w; contrib[k] = s * w; }
  const avg = tw ? wsum / tw : 0;
  const value = Math.round((50 + avg * 50) * 10) / 10;
  const { label, reco } = labelFor(value);
  const confidence = signalConfidence(contrib, adxData ? adxData.adx : null);

  const metrics = {
    price: round(price, 2), sma50: round(sma50, 2), sma200: round(sma200, 2),
    rsi14: round(rsi14, 1), macd_hist: round(hist, 3), momentum_60: round(mom60, 1),
    bb_upper: round(bbu, 2), bb_lower: round(bbl, 2),
    adx: adxData ? round(adxData.adx, 1) : null,
    plus_di: adxData ? round(adxData.plusDI, 1) : null, minus_di: adxData ? round(adxData.minusDI, 1) : null,
    stoch: round(stochK, 1), obv_trend: round(obvTrend, 2),
    atr_pct: (atrVal != null && price) ? round(atrVal / price * 100, 2) : null,
    divergence: div,
    weekly_trend: wk ? wk.dir : null, weekly_rsi: wk ? wk.rsi : null,
    confidence: confidence.value, confidence_label: confidence.label,
    support: levels.support, resistance: levels.resistance,
    support_dist_pct: levels.support_dist_pct, resistance_dist_pct: levels.resistance_dist_pct,
    proj_low_1m: proj ? proj.low : null, proj_high_1m: proj ? proj.high : null, proj_pct_1m: proj ? proj.pct : null,
    mfi: round(mfiV, 1), psar: ps ? round(ps.sar, 2) : null, psar_dir: ps ? (ps.up ? 'up' : 'down') : null,
    squeeze: sq ? sq.on : null, rel_volume: relVol,
    events,
  };
  return { signals, value, label, reco, metrics, contributions: contrib, price };
}

function labelFor(v) {
  if (v >= 72) return { label: 'STRONG_BUY', reco: 'Achat marqué — signaux techniques largement haussiers' };
  if (v >= 58) return { label: 'BUY', reco: 'Achat — tendance et momentum favorables' };
  if (v >= 42) return { label: 'HOLD', reco: 'Neutre — pas de signal directionnel clair' };
  if (v >= 28) return { label: 'SELL', reco: 'Prudence — signaux majoritairement baissiers' };
  return { label: 'STRONG_SELL', reco: 'Vente marquée — configuration technique dégradée' };
}

// ── Explications en français ────────────────────────────────────────────────

function explain(a, rk, ticker) {
  const m = a.metrics, price = a.price, pts = [], vig = [];
  const intro = {
    STRONG_BUY: `${ticker} affiche une configuration technique nettement favorable`,
    BUY: `${ticker} présente une configuration technique plutôt favorable`,
    HOLD: `${ticker} est dans une zone neutre, sans signal directionnel clair`,
    SELL: `${ticker} montre une configuration technique plutôt défavorable`,
    STRONG_SELL: `${ticker} présente une configuration technique nettement dégradée`,
  }[a.label];
  const headline = `${intro} (score ${Math.round(a.value)}/100).`;

  if (m.sma50 && m.sma200) {
    if (price > m.sma50 && price > m.sma200)
      pts.push({ s: 'bull', topic: 'Tendance', text: `Le cours (${m.price}) est au-dessus de ses moyennes 50 et 200 jours : tendance de fond haussière.` });
    else if (price < m.sma50 && price < m.sma200)
      pts.push({ s: 'bear', topic: 'Tendance', text: `Le cours (${m.price}) est sous ses moyennes 50 et 200 jours : tendance de fond baissière, prudence.` });
    else
      pts.push({ s: 'neutral', topic: 'Tendance', text: `Le cours est entre ses moyennes 50 et 200 jours : tendance hésitante.` });
    pts.push(m.sma50 > m.sma200
      ? { s: 'bull', topic: 'Croisement MM', text: 'Moyenne 50 j au-dessus de la 200 j (« golden cross ») : moyen terme favorable.' }
      : { s: 'bear', topic: 'Croisement MM', text: 'Moyenne 50 j sous la 200 j (« death cross ») : moyen terme défavorable.' });
  }
  if (m.rsi14 != null) {
    if (m.rsi14 >= 70) { pts.push({ s: 'warn', topic: 'RSI', text: `RSI à ${m.rsi14} : suracheté, une correction est possible.` }); vig.push('RSI en surachat (>70).'); }
    else if (m.rsi14 <= 30) pts.push({ s: 'bull', topic: 'RSI', text: `RSI à ${m.rsi14} : survendu, un rebond est possible.` });
    else pts.push({ s: m.rsi14 >= 50 ? 'bull' : 'neutral', topic: 'RSI', text: `RSI à ${m.rsi14} : zone neutre.` });
  }
  if (m.macd_hist != null)
    pts.push(m.macd_hist > 0
      ? { s: 'bull', topic: 'MACD', text: 'Histogramme MACD positif : momentum de court terme haussier.' }
      : { s: 'bear', topic: 'MACD', text: 'Histogramme MACD négatif : momentum de court terme baissier.' });
  if (m.momentum_60 != null) {
    if (m.momentum_60 > 8) pts.push({ s: 'bull', topic: 'Momentum', text: `Sur 60 séances, +${m.momentum_60} % : dynamique porteuse.` });
    else if (m.momentum_60 < -8) pts.push({ s: 'bear', topic: 'Momentum', text: `Sur 60 séances, ${m.momentum_60} % : dynamique négative.` });
    else pts.push({ s: 'neutral', topic: 'Momentum', text: `Sur 60 séances, ${m.momentum_60} % : quasi stable.` });
  }
  // Force de tendance (ADX) : dit si les signaux de tendance sont fiables ou non.
  if (m.adx != null) {
    const haussier = m.plus_di != null && m.minus_di != null && m.plus_di >= m.minus_di;
    if (m.adx >= 25)
      pts.push({ s: haussier ? 'bull' : 'bear', topic: 'Force de tendance', text: `Tendance ${haussier ? 'haussière' : 'baissière'} nette et installée (ADX ${m.adx}) : le mouvement est directionnel.` });
    else if (m.adx < 18) {
      pts.push({ s: 'neutral', topic: 'Force de tendance', text: `Pas de tendance marquée (ADX ${m.adx}) : le marché avance sans direction claire, les signaux de tendance sont à prendre avec prudence.` });
      vig.push(`Tendance faible (ADX ${m.adx}) : signaux directionnels peu fiables.`);
    } else
      pts.push({ s: 'neutral', topic: 'Force de tendance', text: `Tendance modérée (ADX ${m.adx}).` });
  }
  // Volume : le mouvement est-il « soutenu » par les échanges ?
  if (m.obv_trend != null) {
    if (m.obv_trend > 0.3) pts.push({ s: 'bull', topic: 'Volume', text: `Les volumes accompagnent la hausse (accumulation) : mouvement plus crédible.` });
    else if (m.obv_trend < -0.3) { pts.push({ s: 'bear', topic: 'Volume', text: `Les volumes accompagnent la baisse (distribution) : pression vendeuse réelle.` }); }
    else pts.push({ s: 'neutral', topic: 'Volume', text: `Le volume ne confirme pas franchement le mouvement : mouvement peu soutenu, à surveiller.` });
  }
  // Stochastique : signalé surtout aux extrêmes, en appui du RSI.
  if (m.stoch != null) {
    if (m.stoch >= 80) { pts.push({ s: 'warn', topic: 'Stochastique', text: `Stochastique à ${m.stoch} : haut de son couloir récent (suracheté à court terme).` }); }
    else if (m.stoch <= 20) pts.push({ s: 'bull', topic: 'Stochastique', text: `Stochastique à ${m.stoch} : bas de son couloir récent (survendu à court terme, rebond possible).` });
  }
  // Divergence prix / RSI : signal d'essoufflement ou de retournement souvent négligé.
  if (m.divergence === 'bear') { pts.push({ s: 'warn', topic: 'Divergence', text: `Divergence baissière : le cours fait un nouveau sommet mais l'élan (RSI) faiblit — essoufflement possible.` }); vig.push('Divergence baissière prix / RSI : la hausse s\'essouffle.'); }
  else if (m.divergence === 'bull') pts.push({ s: 'bull', topic: 'Divergence', text: `Divergence haussière : le cours fait un nouveau creux mais l'élan (RSI) se redresse — rebond possible.` });

  // Multi-horizon : accord ou désaccord entre le court terme (quotidien) et le fond (hebdo).
  if (m.weekly_trend) {
    const st = (price > m.sma50 && price > m.sma200) ? 'bull' : ((price < m.sma50 && price < m.sma200) ? 'bear' : 'neutral');
    const frDir = { bull: 'haussière', bear: 'baissière', neutral: 'hésitante' };
    if (m.weekly_trend === st && st !== 'neutral')
      pts.push({ s: st, topic: 'Multi-horizon', text: `Court terme et tendance de fond (hebdomadaire) sont alignés en ${frDir[st]} : configuration cohérente, signal plus fiable.` });
    else if (st !== 'neutral' && m.weekly_trend !== 'neutral' && m.weekly_trend !== st) {
      pts.push({ s: 'warn', topic: 'Multi-horizon', text: `Désaccord d'horizons : court terme ${frDir[st]} mais fond ${frDir[m.weekly_trend]} (hebdomadaire) — signal à confirmer, prudence.` });
      vig.push('Court terme et tendance de fond ne vont pas dans le même sens.');
    } else
      pts.push({ s: 'neutral', topic: 'Multi-horizon', text: `Tendance de fond (hebdomadaire) : ${frDir[m.weekly_trend]}.` });
  }
  // Événements récents (croisements, cassures, nouveaux extrêmes).
  (m.events || []).forEach(e => pts.push({ s: e.s, topic: 'Événement', text: e.text }));
  // Niveaux clés : support / résistance les plus proches.
  if (m.resistance != null && m.resistance_dist_pct != null && m.resistance_dist_pct <= 4)
    pts.push({ s: 'warn', topic: 'Niveau', text: `Résistance proche vers ${m.resistance} (+${m.resistance_dist_pct} %) : zone où le cours a déjà buté.` });
  if (m.support != null && m.support_dist_pct != null && m.support_dist_pct >= -4)
    pts.push({ s: 'bull', topic: 'Niveau', text: `Support proche vers ${m.support} (${m.support_dist_pct} %) : zone qui a déjà soutenu le cours.` });
  // MFI : surachat/survente pondéré par les volumes.
  if (m.mfi != null) {
    if (m.mfi >= 80) { pts.push({ s: 'warn', topic: 'Flux (MFI)', text: `MFI à ${m.mfi} : suracheté volumes inclus, prudence à court terme.` }); vig.push('MFI en surachat (>80) : afflux d\'achats déjà important.'); }
    else if (m.mfi <= 20) pts.push({ s: 'bull', topic: 'Flux (MFI)', text: `MFI à ${m.mfi} : survendu volumes inclus, rebond possible.` });
    else pts.push({ s: m.mfi >= 50 ? 'bull' : 'neutral', topic: 'Flux (MFI)', text: `MFI à ${m.mfi} : flux d'argent ${m.mfi >= 50 ? 'plutôt acheteur' : 'équilibré'}.` });
  }
  // Parabolic SAR : sens + niveau de stop suiveur.
  if (m.psar != null && m.psar_dir) {
    if (m.psar_dir === 'up') pts.push({ s: 'bull', topic: 'SAR', text: `Parabolic SAR sous le cours (${m.psar}) : tendance haussière ; ce niveau sert de stop suiveur (bascule si le cours passe dessous).` });
    else pts.push({ s: 'bear', topic: 'SAR', text: `Parabolic SAR au-dessus du cours (${m.psar}) : tendance baissière ; se retournerait si le cours repasse au-dessus.` });
  }
  // Volume relatif : conviction derrière le mouvement du jour.
  if (m.rel_volume != null && m.rel_volume >= 1.5)
    pts.push({ s: 'warn', topic: 'Volume relatif', text: `Volume ${m.rel_volume}× la moyenne : forte activité, le mouvement récent est appuyé par les échanges.` });
  // Squeeze : compression de volatilité (mouvement important possible, sens inconnu).
  if (m.squeeze) { pts.push({ s: 'warn', topic: 'Compression', text: `Compression de volatilité (« squeeze ») : les bandes se resserrent, un mouvement ample peut suivre — sans en indiquer le sens.` }); vig.push('Compression de volatilité : un mouvement important peut se déclencher.'); }

  const parts = [];
  if (rk.annual_vol_pct != null) {
    if (rk.annual_vol_pct < 15) parts.push(`volatilité faible (${rk.annual_vol_pct} %/an)`);
    else if (rk.annual_vol_pct < 30) parts.push(`volatilité modérée (${rk.annual_vol_pct} %/an)`);
    else { parts.push(`volatilité élevée (${rk.annual_vol_pct} %/an)`); vig.push(`Volatilité élevée (${rk.annual_vol_pct} %/an).`); }
  }
  if (rk.max_drawdown_pct != null) { parts.push(`pire baisse ${rk.max_drawdown_pct} %`); if (rk.max_drawdown_pct < -35) vig.push(`Le titre a déjà perdu ${Math.abs(rk.max_drawdown_pct)} % depuis un sommet.`); }
  if (rk.sharpe != null) parts.push(rk.sharpe >= 1 ? `Sharpe solide (${rk.sharpe})` : (rk.sharpe >= 0 ? `Sharpe modeste (${rk.sharpe})` : `Sharpe négatif (${rk.sharpe})`));
  if (m.atr_pct != null) parts.push(`mouvement quotidien typique ±${m.atr_pct} %`);
  let risk_summary = parts.length ? 'Profil de risque : ' + parts.join(', ') + '.' : '';
  if (m.proj_low_1m != null) risk_summary += ` Fourchette probable à 1 mois (≈ 2 chances sur 3) : ${m.proj_low_1m} – ${m.proj_high_1m}.`;
  if (m.confidence != null) risk_summary += ` Confiance du signal : ${m.confidence_label} (${m.confidence}/100 — accord entre les facteurs).`;

  return { headline, points: pts, risk_summary, vigilance: vig };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = (url.searchParams.get('tickers') || 'AAPL,MSFT,NVDA').trim();
  const tickers = raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 12);

  // Indice de marché (S&P 500) récupéré une seule fois, pour le bêta / la corrélation.
  const MARKET = 'SPY';
  const needMarket = tickers.some(t => t.toUpperCase() !== MARKET);
  let market = null;
  if (needMarket) { try { market = await fetchSeries(MARKET); } catch (e) { market = null; } }

  const results = [];
  for (const ticker of tickers) {
    try {
      const series = await fetchSeries(ticker);
      const closes = series.bars.map(b => b.close);
      const a = analyze(series);
      const rk = riskMetrics(closes);
      const ex = explain(a, rk, series.ticker);
      let bc = null;
      if (market && series.ticker !== MARKET) {
        bc = betaCorr(series.bars, market.bars);
        if (bc && bc.beta != null) {
          a.metrics.beta = bc.beta; a.metrics.market_corr = bc.corr;
          const amp = bc.beta >= 1.15 ? `amplifie les mouvements du marché (×${bc.beta})`
            : (bc.beta <= 0.85 ? `plus calme que le marché (×${bc.beta})` : `bouge à peu près comme le marché (×${bc.beta})`);
          ex.points.push({ s: 'neutral', topic: 'Marché', text: `Bêta ${bc.beta} : le titre ${amp}. Corrélation ${bc.corr} au S&P 500.` });
        }
      }
      results.push({
        ticker: series.ticker, name: series.name || null, currency: series.currency || null, source: series.source, day: series.bars[series.bars.length - 1].day,
        price: a.metrics.price, score: a.value, label: a.label, reco: a.reco,
        metrics: a.metrics, risk: rk, contributions: a.contributions,
        spark: closes.slice(-90), chart: closes.slice(-260), ...ex,
      });
    } catch (e) {
      results.push({ ticker: ticker.toUpperCase(), error: String(e.message || e) });
    }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
  res.status(200).end(JSON.stringify({ generated: new Date().toISOString(), results }));
};

// Exposé pour les tests (n'affecte pas le handler par défaut utilisé par Vercel).
module.exports._internal = { analyze, riskMetrics, explain, sma, ema, rsi, macd, momentum, maxDrawdown, obv, trendCorr, atr, adx, stochastic, rsiDivergence, toWeekly, weeklyTrend, findLevels, detectEvents, signalConfidence, projRange, betaCorr, mfi, psar, squeeze, relVolume };
