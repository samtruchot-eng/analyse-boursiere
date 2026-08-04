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

// Depuis 2023, Yahoo protège l'endpoint « quote » par un cookie de consentement
// + un jeton « crumb ». On reproduit ce que fait un navigateur : on récupère le
// cookie, puis le crumb, puis on rejoue la requête. Tout est défensif.
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

async function yahooCreds() {
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': YF_UA } });
  let cookie = '';
  const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie()
    : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
  if (sc && sc.length) cookie = sc.map(c => String(c).split(';')[0]).join('; ');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': YF_UA, cookie } });
  const crumb = (await r2.text()).trim();
  return { cookie, crumb };
}

async function yahooQuote(syms, creds) {
  const c = (creds && creds.crumb) ? `&crumb=${encodeURIComponent(creds.crumb)}` : '';
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}${c}`;
  const headers = { 'User-Agent': YF_UA };
  if (creds && creds.cookie) headers.cookie = creds.cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  return (data && data.quoteResponse && data.quoteResponse.result) || null;
}

// Détails fondamentaux enrichis (objectif de cours, marges, croissance, dette,
// consensus des analystes) via l'endpoint « quoteSummary » — un appel par
// symbole. Best effort : renvoie null si indisponible.
async function yahooSummary(sym, creds) {
  const mods = 'financialData,defaultKeyStatistics,summaryDetail,calendarEvents,price';
  const c = (creds && creds.crumb) ? `&crumb=${encodeURIComponent(creds.crumb)}` : '';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}${c}`;
  const headers = { 'User-Agent': YF_UA };
  if (creds && creds.cookie) headers.cookie = creds.cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  return (data && data.quoteSummary && data.quoteSummary.result && data.quoteSummary.result[0]) || null;
}

// Yahoo enveloppe ses nombres en { raw, fmt } : on extrait la valeur brute.
function rawOf(o) { return (o && typeof o === 'object' && 'raw' in o) ? o.raw : (typeof o === 'number' ? o : null); }
function pctRound(x) { return (typeof x === 'number' && isFinite(x)) ? round(x * 100, 2) : null; }

// Fondamentaux via Yahoo : base « quote » (PER, dividende, capitalisation, date
// de résultats, note des analystes) + enrichissement « quoteSummary » (objectif
// de cours, marges, croissance, dette). Purement optionnel et défensif : si un
// appel échoue, on garde ce qu'on a et l'analyse technique reste inchangée.
async function fetchFundamentals(tickers) {
  const out = {};
  try {
    const list = tickers.map(t => t.toUpperCase());
    let creds = null;
    let arr = await yahooQuote(list.join(','), null);   // tentative directe
    if (!arr || !arr.length) {                          // sinon : cookie + crumb
      creds = await yahooCreds();
      arr = await yahooQuote(list.join(','), creds);
    }
    const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
    for (const q of (arr || [])) {
      const sym = String(q.symbol || '').toUpperCase();
      if (!sym) continue;
      let earningsDate = null, earningsInDays = null;
      const et = q.earningsTimestampStart || q.earningsTimestamp;
      if (typeof et === 'number' && isFinite(et)) {
        earningsDate = new Date(et * 1000).toISOString().slice(0, 10);
        earningsInDays = Math.round((et * 1000 - Date.now()) / 86400000);
      }
      const dy = num(q.trailingAnnualDividendYield);
      let analystLabel = null, analystMean = null;
      if (typeof q.averageAnalystRating === 'string' && q.averageAnalystRating.includes('-')) {
        const [mean, lab] = q.averageAnalystRating.split('-');
        analystMean = num(parseFloat(mean)); analystLabel = lab.trim() || null;
      }
      let pos52 = null;
      if (num(q.fiftyTwoWeekLow) != null && num(q.fiftyTwoWeekHigh) != null && q.fiftyTwoWeekHigh > q.fiftyTwoWeekLow && num(q.regularMarketPrice) != null) {
        pos52 = round((q.regularMarketPrice - q.fiftyTwoWeekLow) / (q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow) * 100, 0);
      }
      out[sym] = {
        pe: num(q.trailingPE), forwardPE: num(q.forwardPE), eps: num(q.epsTrailingTwelveMonths),
        pb: num(q.priceToBook), divYield: dy != null ? round(dy * 100, 2) : null,
        marketCap: num(q.marketCap), currency: q.currency || null,
        analystLabel, analystMean, pos52, price52: num(q.regularMarketPrice),
        earningsDate, earningsInDays,
      };
    }

    // Enrichissement quoteSummary (objectif de cours, marges, croissance…).
    if (!creds) { try { creds = await yahooCreds(); } catch (e) { creds = null; } }
    await Promise.all(list.map(async (sym) => {
      try {
        const s = await yahooSummary(sym, creds);
        if (!s) return;
        const fd = s.financialData || {}, ks = s.defaultKeyStatistics || {}, sd = s.summaryDetail || {}, pr = s.price || {}, ce = s.calendarEvents || {};
        const base = out[sym] || (out[sym] = {});
        const price = rawOf(fd.currentPrice) != null ? rawOf(fd.currentPrice) : rawOf(pr.regularMarketPrice);
        const target = rawOf(fd.targetMeanPrice);
        if (target != null) { base.targetMean = round(target, 2); if (price) base.targetUpsidePct = round((target / price - 1) * 100, 1); }
        if (fd.recommendationKey && fd.recommendationKey !== 'none') base.recommendation = fd.recommendationKey;
        if (rawOf(fd.recommendationMean) != null) base.recMean = round(rawOf(fd.recommendationMean), 1);
        base.profitMargin = pctRound(rawOf(fd.profitMargins));
        base.revenueGrowth = pctRound(rawOf(fd.revenueGrowth));
        base.roe = pctRound(rawOf(fd.returnOnEquity));
        const de = rawOf(fd.debtToEquity); if (de != null) base.debtToEquity = round(de / 100, 2); // ratio (150 % → 1.5)
        if (base.peg == null && rawOf(ks.pegRatio) != null) base.peg = round(rawOf(ks.pegRatio), 2);
        if (base.pb == null && rawOf(ks.priceToBook) != null) base.pb = round(rawOf(ks.priceToBook), 2);
        if (base.pe == null && rawOf(sd.trailingPE) != null) base.pe = round(rawOf(sd.trailingPE), 2);
        if (base.marketCap == null && rawOf(sd.marketCap) != null) base.marketCap = rawOf(sd.marketCap);
        if (!base.currency && pr.currency) base.currency = pr.currency;
        if (base.earningsDate == null && ce.earnings && Array.isArray(ce.earnings.earningsDate) && ce.earnings.earningsDate.length) {
          const ets = rawOf(ce.earnings.earningsDate[0]);
          if (typeof ets === 'number' && isFinite(ets)) {
            base.earningsDate = new Date(ets * 1000).toISOString().slice(0, 10);
            base.earningsInDays = Math.round((ets * 1000 - Date.now()) / 86400000);
          }
        }
      } catch (e) { /* on garde la base */ }
    }));
    return out;
  } catch (e) { return out; }
}

// Actualités récentes d'un titre via le flux RSS public de Yahoo Finance
// (aucune authentification requise). Renvoie [] en cas d'échec.
async function fetchNews(ticker, max = 7) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(url, { headers: { 'User-Agent': YF_UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    const clean = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const pick = (block, tag) => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block); return r ? clean(r[1]) : ''; };
    let m;
    while ((m = re.exec(xml)) && items.length < max) {
      const block = m[1];
      const title = pick(block, 'title'), link = pick(block, 'link'), pub = pick(block, 'pubDate');
      let date = null;
      if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10); }
      if (title) items.push({ title, link, date });
    }
    return items;
  } catch (e) { return []; }
}

// Actualités pour plusieurs symboles, en parallèle.
async function fetchNewsMap(tickers) {
  const out = {};
  await Promise.all(tickers.map(async (t) => { out[t.toUpperCase()] = await fetchNews(t); }));
  return out;
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
const EVENT_TXT = {
  fr: {
    golden: 'Golden cross tout récent : la moyenne 50 j vient de repasser au-dessus de la 200 j.',
    death: 'Death cross tout récent : la moyenne 50 j vient de repasser sous la 200 j.',
    newHigh: 'Nouveau plus-haut de 52 semaines.', newLow: 'Nouveau plus-bas de 52 semaines.',
    breakUp: 'Cassure à la hausse : le cours dépasse le sommet des 20 dernières séances.',
    breakDown: 'Cassure à la baisse : le cours enfonce le creux des 20 dernières séances.',
  },
  en: {
    golden: 'Fresh golden cross: the 50-day average has just crossed back above the 200-day.',
    death: 'Fresh death cross: the 50-day average has just crossed back below the 200-day.',
    newHigh: 'New 52-week high.', newLow: 'New 52-week low.',
    breakUp: 'Upside breakout: price clears the high of the last 20 sessions.',
    breakDown: 'Downside breakdown: price breaks the low of the last 20 sessions.',
  },
};
function detectEvents(barsArr, lang = 'fr') {
  const T = EVENT_TXT[lang] || EVENT_TXT.fr;
  const closes = barsArr.map(b => b.close), n = closes.length, price = closes[n - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200), ev = [], seen = new Set();
  const add = (s, text) => { if (!seen.has(text)) { seen.add(text); ev.push({ s, text }); } };
  for (let i = Math.max(1, n - 7); i < n; i++) {
    if (s50[i] != null && s200[i] != null && s50[i - 1] != null && s200[i - 1] != null) {
      if (s50[i - 1] <= s200[i - 1] && s50[i] > s200[i]) add('bull', T.golden);
      if (s50[i - 1] >= s200[i - 1] && s50[i] < s200[i]) add('bear', T.death);
    }
  }
  const win = closes.slice(-252);
  if (price >= Math.max(...win) * 0.999) add('bull', T.newHigh);
  if (price <= Math.min(...win) * 1.001) add('bear', T.newLow);
  const prev20 = closes.slice(-21, -1);
  if (prev20.length) {
    if (price > Math.max(...prev20)) add('bull', T.breakUp);
    if (price < Math.min(...prev20)) add('bear', T.breakDown);
  }
  return ev;
}

// ── Indice de confiance : les facteurs sont-ils d'accord entre eux ? ──────────
const CONF_LABEL = { fr: ['faible', 'moyenne', 'élevée'], en: ['low', 'medium', 'high'] };
function signalConfidence(contribs, adxVal, lang = 'fr') {
  const lab = CONF_LABEL[lang] || CONF_LABEL.fr;
  const vals = Object.values(contribs);
  if (!vals.length) return { value: 0, label: lab[0] };
  const net = vals.reduce((a, b) => a + b, 0);
  const totAbs = vals.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const agree = vals.filter(v => (net >= 0 ? v >= 0 : v < 0)).reduce((a, b) => a + Math.abs(b), 0);
  let conf = agree / totAbs;
  if (adxVal != null) conf = conf * 0.85 + clamp((adxVal - 15) / 30, 0, 1) * 0.15;
  const value = Math.round(conf * 100);
  return { value, label: value >= 70 ? lab[2] : (value >= 50 ? lab[1] : lab[0]) };
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

function analyze(series, lang = 'fr') {
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
  const events = detectEvents(series.bars, lang);
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
  const { label, reco } = labelFor(value, lang);
  const confidence = signalConfidence(contrib, adxData ? adxData.adx : null, lang);

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

const RECO = {
  fr: { STRONG_BUY: 'Achat marqué — signaux techniques largement haussiers', BUY: 'Achat — tendance et momentum favorables', HOLD: 'Neutre — pas de signal directionnel clair', SELL: 'Prudence — signaux majoritairement baissiers', STRONG_SELL: 'Vente marquée — configuration technique dégradée' },
  en: { STRONG_BUY: 'Strong buy — technical signals broadly bullish', BUY: 'Buy — favourable trend and momentum', HOLD: 'Neutral — no clear directional signal', SELL: 'Caution — mostly bearish signals', STRONG_SELL: 'Strong sell — deteriorated technical setup' },
};
function labelFor(v, lang = 'fr') {
  const label = v >= 72 ? 'STRONG_BUY' : v >= 58 ? 'BUY' : v >= 42 ? 'HOLD' : v >= 28 ? 'SELL' : 'STRONG_SELL';
  return { label, reco: (RECO[lang] || RECO.fr)[label] };
}

// ── Explications (français / anglais) ────────────────────────────────────────

const EXP = {
  fr: {
    topics: { trend: 'Tendance', ma: 'Croisement MM', rsi: 'RSI', macd: 'MACD', mom: 'Momentum', adx: 'Force de tendance', vol: 'Volume', stoch: 'Stochastique', div: 'Divergence', mtf: 'Multi-horizon', ev: 'Événement', lvl: 'Niveau', mfi: 'Flux (MFI)', sar: 'SAR', rvol: 'Volume relatif', sqz: 'Compression' },
    dir: { bull: 'haussière', bear: 'baissière', neutral: 'hésitante' },
    intro: { STRONG_BUY: t => `${t} affiche une configuration technique nettement favorable`, BUY: t => `${t} présente une configuration technique plutôt favorable`, HOLD: t => `${t} est dans une zone neutre, sans signal directionnel clair`, SELL: t => `${t} montre une configuration technique plutôt défavorable`, STRONG_SELL: t => `${t} présente une configuration technique nettement dégradée` },
    headline: (intro, v) => `${intro} (score ${v}/100).`,
    trendUp: p => `Le cours (${p}) est au-dessus de ses moyennes 50 et 200 jours : tendance de fond haussière.`,
    trendDown: p => `Le cours (${p}) est sous ses moyennes 50 et 200 jours : tendance de fond baissière, prudence.`,
    trendMixed: `Le cours est entre ses moyennes 50 et 200 jours : tendance hésitante.`,
    maGolden: 'Moyenne 50 j au-dessus de la 200 j (« golden cross ») : moyen terme favorable.',
    maDeath: 'Moyenne 50 j sous la 200 j (« death cross ») : moyen terme défavorable.',
    rsiOver: v => `RSI à ${v} : suracheté, une correction est possible.`, rsiOverVig: 'RSI en surachat (>70).',
    rsiUnder: v => `RSI à ${v} : survendu, un rebond est possible.`, rsiNeutral: v => `RSI à ${v} : zone neutre.`,
    macdPos: 'Histogramme MACD positif : momentum de court terme haussier.', macdNeg: 'Histogramme MACD négatif : momentum de court terme baissier.',
    momUp: v => `Sur 60 séances, +${v} % : dynamique porteuse.`, momDown: v => `Sur 60 séances, ${v} % : dynamique négative.`, momFlat: v => `Sur 60 séances, ${v} % : quasi stable.`,
    adxStrong: (d, v) => `Tendance ${d} nette et installée (ADX ${v}) : le mouvement est directionnel.`,
    adxWeak: v => `Pas de tendance marquée (ADX ${v}) : le marché avance sans direction claire, les signaux de tendance sont à prendre avec prudence.`,
    adxWeakVig: v => `Tendance faible (ADX ${v}) : signaux directionnels peu fiables.`, adxMod: v => `Tendance modérée (ADX ${v}).`,
    volUp: 'Les volumes accompagnent la hausse (accumulation) : mouvement plus crédible.', volDown: 'Les volumes accompagnent la baisse (distribution) : pression vendeuse réelle.', volNeutral: 'Le volume ne confirme pas franchement le mouvement : mouvement peu soutenu, à surveiller.',
    stochOver: v => `Stochastique à ${v} : haut de son couloir récent (suracheté à court terme).`, stochUnder: v => `Stochastique à ${v} : bas de son couloir récent (survendu à court terme, rebond possible).`,
    divBear: `Divergence baissière : le cours fait un nouveau sommet mais l'élan (RSI) faiblit — essoufflement possible.`, divBearVig: 'Divergence baissière prix / RSI : la hausse s\'essouffle.', divBull: `Divergence haussière : le cours fait un nouveau creux mais l'élan (RSI) se redresse — rebond possible.`,
    mtfAligned: d => `Court terme et tendance de fond (hebdomadaire) sont alignés en ${d} : configuration cohérente, signal plus fiable.`,
    mtfDisagree: (d1, d2) => `Désaccord d'horizons : court terme ${d1} mais fond ${d2} (hebdomadaire) — signal à confirmer, prudence.`, mtfDisagreeVig: 'Court terme et tendance de fond ne vont pas dans le même sens.', mtfNeutral: d => `Tendance de fond (hebdomadaire) : ${d}.`,
    resistance: (lvl, d) => `Résistance proche vers ${lvl} (+${d} %) : zone où le cours a déjà buté.`, support: (lvl, d) => `Support proche vers ${lvl} (${d} %) : zone qui a déjà soutenu le cours.`,
    mfiOver: v => `MFI à ${v} : suracheté volumes inclus, prudence à court terme.`, mfiOverVig: 'MFI en surachat (>80) : afflux d\'achats déjà important.', mfiUnder: v => `MFI à ${v} : survendu volumes inclus, rebond possible.`, mfiNeutral: (v, b) => `MFI à ${v} : flux d'argent ${b ? 'plutôt acheteur' : 'équilibré'}.`,
    sarUp: v => `Parabolic SAR sous le cours (${v}) : tendance haussière ; ce niveau sert de stop suiveur (bascule si le cours passe dessous).`, sarDown: v => `Parabolic SAR au-dessus du cours (${v}) : tendance baissière ; se retournerait si le cours repasse au-dessus.`,
    rvol: v => `Volume ${v}× la moyenne : forte activité, le mouvement récent est appuyé par les échanges.`,
    sqz: `Compression de volatilité (« squeeze ») : les bandes se resserrent, un mouvement ample peut suivre — sans en indiquer le sens.`, sqzVig: 'Compression de volatilité : un mouvement important peut se déclencher.',
    volLow: v => `volatilité faible (${v} %/an)`, volMod: v => `volatilité modérée (${v} %/an)`, volHigh: v => `volatilité élevée (${v} %/an)`, volHighVig: v => `Volatilité élevée (${v} %/an).`,
    ddPart: v => `pire baisse ${v} %`, ddVig: v => `Le titre a déjà perdu ${v} % depuis un sommet.`,
    shSolid: v => `Sharpe solide (${v})`, shModest: v => `Sharpe modeste (${v})`, shNeg: v => `Sharpe négatif (${v})`,
    atrPart: v => `mouvement quotidien typique ±${v} %`,
    riskLead: p => `Profil de risque : ${p}.`, projLine: (lo, hi) => ` Fourchette probable à 1 mois (≈ 2 chances sur 3) : ${lo} – ${hi}.`,
    confLine: (lab, v) => ` Confiance du signal : ${lab} (${v}/100 — accord entre les facteurs).`,
  },
  en: {
    topics: { trend: 'Trend', ma: 'MA cross', rsi: 'RSI', macd: 'MACD', mom: 'Momentum', adx: 'Trend strength', vol: 'Volume', stoch: 'Stochastic', div: 'Divergence', mtf: 'Multi-timeframe', ev: 'Event', lvl: 'Level', mfi: 'Money flow (MFI)', sar: 'SAR', rvol: 'Relative volume', sqz: 'Squeeze' },
    dir: { bull: 'bullish', bear: 'bearish', neutral: 'unclear' },
    intro: { STRONG_BUY: t => `${t} shows a clearly favourable technical setup`, BUY: t => `${t} shows a fairly favourable technical setup`, HOLD: t => `${t} is in a neutral zone, with no clear directional signal`, SELL: t => `${t} shows a fairly unfavourable technical setup`, STRONG_SELL: t => `${t} shows a clearly deteriorated technical setup` },
    headline: (intro, v) => `${intro} (score ${v}/100).`,
    trendUp: p => `Price (${p}) is above its 50- and 200-day averages: bullish underlying trend.`,
    trendDown: p => `Price (${p}) is below its 50- and 200-day averages: bearish underlying trend, caution.`,
    trendMixed: `Price sits between its 50- and 200-day averages: hesitant trend.`,
    maGolden: '50-day average above the 200-day ("golden cross"): favourable medium term.',
    maDeath: '50-day average below the 200-day ("death cross"): unfavourable medium term.',
    rsiOver: v => `RSI at ${v}: overbought, a pullback is possible.`, rsiOverVig: 'RSI overbought (>70).',
    rsiUnder: v => `RSI at ${v}: oversold, a rebound is possible.`, rsiNeutral: v => `RSI at ${v}: neutral zone.`,
    macdPos: 'Positive MACD histogram: bullish short-term momentum.', macdNeg: 'Negative MACD histogram: bearish short-term momentum.',
    momUp: v => `Over 60 sessions, +${v}%: supportive dynamics.`, momDown: v => `Over 60 sessions, ${v}%: negative dynamics.`, momFlat: v => `Over 60 sessions, ${v}%: roughly flat.`,
    adxStrong: (d, v) => `Clear, established ${d} trend (ADX ${v}): the move is directional.`,
    adxWeak: v => `No marked trend (ADX ${v}): the market drifts without a clear direction, trend signals should be taken with caution.`,
    adxWeakVig: v => `Weak trend (ADX ${v}): directional signals unreliable.`, adxMod: v => `Moderate trend (ADX ${v}).`,
    volUp: 'Volume backs the rise (accumulation): a more credible move.', volDown: 'Volume backs the fall (distribution): real selling pressure.', volNeutral: 'Volume does not really confirm the move: weakly supported, worth watching.',
    stochOver: v => `Stochastic at ${v}: top of its recent range (short-term overbought).`, stochUnder: v => `Stochastic at ${v}: bottom of its recent range (short-term oversold, rebound possible).`,
    divBear: `Bearish divergence: price makes a new high but momentum (RSI) weakens — possible loss of steam.`, divBearVig: 'Bearish price/RSI divergence: the rise is losing steam.', divBull: `Bullish divergence: price makes a new low but momentum (RSI) turns up — rebound possible.`,
    mtfAligned: d => `Short term and underlying (weekly) trend are aligned ${d}: a consistent setup, more reliable signal.`,
    mtfDisagree: (d1, d2) => `Timeframe disagreement: short term ${d1} but underlying ${d2} (weekly) — signal to confirm, caution.`, mtfDisagreeVig: 'Short term and underlying trend point different ways.', mtfNeutral: d => `Underlying (weekly) trend: ${d}.`,
    resistance: (lvl, d) => `Nearby resistance around ${lvl} (+${d}%): a zone where price has stalled before.`, support: (lvl, d) => `Nearby support around ${lvl} (${d}%): a zone that has held price before.`,
    mfiOver: v => `MFI at ${v}: overbought (volume included), short-term caution.`, mfiOverVig: 'MFI overbought (>80): buying inflow already large.', mfiUnder: v => `MFI at ${v}: oversold (volume included), rebound possible.`, mfiNeutral: (v, b) => `MFI at ${v}: money flow ${b ? 'leaning buy' : 'balanced'}.`,
    sarUp: v => `Parabolic SAR below price (${v}): bullish trend; this level acts as a trailing stop (flips if price drops below).`, sarDown: v => `Parabolic SAR above price (${v}): bearish trend; would flip if price moves back above.`,
    rvol: v => `Volume ${v}× the average: strong activity, the recent move is backed by trading.`,
    sqz: `Volatility squeeze: the bands are tightening, a wide move may follow — without indicating the direction.`, sqzVig: 'Volatility squeeze: a large move may be building.',
    volLow: v => `low volatility (${v}%/yr)`, volMod: v => `moderate volatility (${v}%/yr)`, volHigh: v => `high volatility (${v}%/yr)`, volHighVig: v => `High volatility (${v}%/yr).`,
    ddPart: v => `worst drop ${v}%`, ddVig: v => `The stock has already lost ${v}% from a peak.`,
    shSolid: v => `solid Sharpe (${v})`, shModest: v => `modest Sharpe (${v})`, shNeg: v => `negative Sharpe (${v})`,
    atrPart: v => `typical daily move ±${v}%`,
    riskLead: p => `Risk profile: ${p}.`, projLine: (lo, hi) => ` Likely 1-month range (≈ 2 chances in 3): ${lo} – ${hi}.`,
    confLine: (lab, v) => ` Signal confidence: ${lab} (${v}/100 — agreement between factors).`,
  },
};

function explain(a, rk, ticker, lang = 'fr') {
  const P = EXP[lang] || EXP.fr, T = P.topics;
  const m = a.metrics, price = a.price, pts = [], vig = [];
  const headline = P.headline(P.intro[a.label](ticker), Math.round(a.value));

  if (m.sma50 && m.sma200) {
    if (price > m.sma50 && price > m.sma200) pts.push({ s: 'bull', topic: T.trend, text: P.trendUp(m.price) });
    else if (price < m.sma50 && price < m.sma200) pts.push({ s: 'bear', topic: T.trend, text: P.trendDown(m.price) });
    else pts.push({ s: 'neutral', topic: T.trend, text: P.trendMixed });
    pts.push(m.sma50 > m.sma200 ? { s: 'bull', topic: T.ma, text: P.maGolden } : { s: 'bear', topic: T.ma, text: P.maDeath });
  }
  if (m.rsi14 != null) {
    if (m.rsi14 >= 70) { pts.push({ s: 'warn', topic: T.rsi, text: P.rsiOver(m.rsi14) }); vig.push(P.rsiOverVig); }
    else if (m.rsi14 <= 30) pts.push({ s: 'bull', topic: T.rsi, text: P.rsiUnder(m.rsi14) });
    else pts.push({ s: m.rsi14 >= 50 ? 'bull' : 'neutral', topic: T.rsi, text: P.rsiNeutral(m.rsi14) });
  }
  if (m.macd_hist != null)
    pts.push(m.macd_hist > 0 ? { s: 'bull', topic: T.macd, text: P.macdPos } : { s: 'bear', topic: T.macd, text: P.macdNeg });
  if (m.momentum_60 != null) {
    if (m.momentum_60 > 8) pts.push({ s: 'bull', topic: T.mom, text: P.momUp(m.momentum_60) });
    else if (m.momentum_60 < -8) pts.push({ s: 'bear', topic: T.mom, text: P.momDown(m.momentum_60) });
    else pts.push({ s: 'neutral', topic: T.mom, text: P.momFlat(m.momentum_60) });
  }
  if (m.adx != null) {
    const up = m.plus_di != null && m.minus_di != null && m.plus_di >= m.minus_di;
    if (m.adx >= 25) pts.push({ s: up ? 'bull' : 'bear', topic: T.adx, text: P.adxStrong(P.dir[up ? 'bull' : 'bear'], m.adx) });
    else if (m.adx < 18) { pts.push({ s: 'neutral', topic: T.adx, text: P.adxWeak(m.adx) }); vig.push(P.adxWeakVig(m.adx)); }
    else pts.push({ s: 'neutral', topic: T.adx, text: P.adxMod(m.adx) });
  }
  if (m.obv_trend != null) {
    if (m.obv_trend > 0.3) pts.push({ s: 'bull', topic: T.vol, text: P.volUp });
    else if (m.obv_trend < -0.3) pts.push({ s: 'bear', topic: T.vol, text: P.volDown });
    else pts.push({ s: 'neutral', topic: T.vol, text: P.volNeutral });
  }
  if (m.stoch != null) {
    if (m.stoch >= 80) pts.push({ s: 'warn', topic: T.stoch, text: P.stochOver(m.stoch) });
    else if (m.stoch <= 20) pts.push({ s: 'bull', topic: T.stoch, text: P.stochUnder(m.stoch) });
  }
  if (m.divergence === 'bear') { pts.push({ s: 'warn', topic: T.div, text: P.divBear }); vig.push(P.divBearVig); }
  else if (m.divergence === 'bull') pts.push({ s: 'bull', topic: T.div, text: P.divBull });

  if (m.weekly_trend) {
    const st = (price > m.sma50 && price > m.sma200) ? 'bull' : ((price < m.sma50 && price < m.sma200) ? 'bear' : 'neutral');
    if (m.weekly_trend === st && st !== 'neutral') pts.push({ s: st, topic: T.mtf, text: P.mtfAligned(P.dir[st]) });
    else if (st !== 'neutral' && m.weekly_trend !== 'neutral' && m.weekly_trend !== st) {
      pts.push({ s: 'warn', topic: T.mtf, text: P.mtfDisagree(P.dir[st], P.dir[m.weekly_trend]) });
      vig.push(P.mtfDisagreeVig);
    } else pts.push({ s: 'neutral', topic: T.mtf, text: P.mtfNeutral(P.dir[m.weekly_trend]) });
  }
  (m.events || []).forEach(e => pts.push({ s: e.s, topic: T.ev, text: e.text }));
  if (m.resistance != null && m.resistance_dist_pct != null && m.resistance_dist_pct <= 4)
    pts.push({ s: 'warn', topic: T.lvl, text: P.resistance(m.resistance, m.resistance_dist_pct) });
  if (m.support != null && m.support_dist_pct != null && m.support_dist_pct >= -4)
    pts.push({ s: 'bull', topic: T.lvl, text: P.support(m.support, m.support_dist_pct) });
  if (m.mfi != null) {
    if (m.mfi >= 80) { pts.push({ s: 'warn', topic: T.mfi, text: P.mfiOver(m.mfi) }); vig.push(P.mfiOverVig); }
    else if (m.mfi <= 20) pts.push({ s: 'bull', topic: T.mfi, text: P.mfiUnder(m.mfi) });
    else pts.push({ s: m.mfi >= 50 ? 'bull' : 'neutral', topic: T.mfi, text: P.mfiNeutral(m.mfi, m.mfi >= 50) });
  }
  if (m.psar != null && m.psar_dir) {
    if (m.psar_dir === 'up') pts.push({ s: 'bull', topic: T.sar, text: P.sarUp(m.psar) });
    else pts.push({ s: 'bear', topic: T.sar, text: P.sarDown(m.psar) });
  }
  if (m.rel_volume != null && m.rel_volume >= 1.5) pts.push({ s: 'warn', topic: T.rvol, text: P.rvol(m.rel_volume) });
  if (m.squeeze) { pts.push({ s: 'warn', topic: T.sqz, text: P.sqz }); vig.push(P.sqzVig); }

  const parts = [];
  if (rk.annual_vol_pct != null) {
    if (rk.annual_vol_pct < 15) parts.push(P.volLow(rk.annual_vol_pct));
    else if (rk.annual_vol_pct < 30) parts.push(P.volMod(rk.annual_vol_pct));
    else { parts.push(P.volHigh(rk.annual_vol_pct)); vig.push(P.volHighVig(rk.annual_vol_pct)); }
  }
  if (rk.max_drawdown_pct != null) { parts.push(P.ddPart(rk.max_drawdown_pct)); if (rk.max_drawdown_pct < -35) vig.push(P.ddVig(Math.abs(rk.max_drawdown_pct))); }
  if (rk.sharpe != null) parts.push(rk.sharpe >= 1 ? P.shSolid(rk.sharpe) : (rk.sharpe >= 0 ? P.shModest(rk.sharpe) : P.shNeg(rk.sharpe)));
  if (m.atr_pct != null) parts.push(P.atrPart(m.atr_pct));
  let risk_summary = parts.length ? P.riskLead(parts.join(', ')) : '';
  if (m.proj_low_1m != null) risk_summary += P.projLine(m.proj_low_1m, m.proj_high_1m);
  if (m.confidence != null) risk_summary += P.confLine(m.confidence_label, m.confidence);

  return { headline, points: pts, risk_summary, vigilance: vig };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = (url.searchParams.get('tickers') || 'AAPL,MSFT,NVDA').trim();
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'fr';
  const tickers = raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 12);

  // Indice de marché (S&P 500) récupéré une seule fois, pour le bêta / la corrélation.
  const MARKET = 'SPY';
  const needMarket = tickers.some(t => t.toUpperCase() !== MARKET);
  let market = null;
  if (needMarket) { try { market = await fetchSeries(MARKET); } catch (e) { market = null; } }

  // Repères fondamentaux et actualités (optionnels) — récupérés en parallèle.
  let funds = {}, newsMap = {};
  await Promise.all([
    fetchFundamentals(tickers).then(x => { funds = x || {}; }).catch(() => { funds = {}; }),
    fetchNewsMap(tickers).then(x => { newsMap = x || {}; }).catch(() => { newsMap = {}; }),
  ]);

  const results = [];
  for (const ticker of tickers) {
    try {
      const series = await fetchSeries(ticker);
      const closes = series.bars.map(b => b.close);
      const a = analyze(series, lang);
      const rk = riskMetrics(closes);
      const ex = explain(a, rk, series.ticker, lang);
      let bc = null;
      if (market && series.ticker !== MARKET) {
        bc = betaCorr(series.bars, market.bars);
        if (bc && bc.beta != null) {
          a.metrics.beta = bc.beta; a.metrics.market_corr = bc.corr;
          const en = lang === 'en';
          const amp = bc.beta >= 1.15 ? (en ? `amplifies market moves (×${bc.beta})` : `amplifie les mouvements du marché (×${bc.beta})`)
            : (bc.beta <= 0.85 ? (en ? `calmer than the market (×${bc.beta})` : `plus calme que le marché (×${bc.beta})`)
              : (en ? `moves roughly like the market (×${bc.beta})` : `bouge à peu près comme le marché (×${bc.beta})`));
          const txt = en ? `Beta ${bc.beta}: the stock ${amp}. Correlation ${bc.corr} to the S&P 500.`
            : `Bêta ${bc.beta} : le titre ${amp}. Corrélation ${bc.corr} au S&P 500.`;
          ex.points.push({ s: 'neutral', topic: en ? 'Market' : 'Marché', text: txt });
        }
      }
      // Fondamentaux : rappel « résultats proches » (le point faible de l'analyse
      // purement technique — un résultat surprise pèse plus que tout signal).
      const fund = funds[series.ticker.toUpperCase()] || null;
      if (fund && fund.earningsInDays != null && fund.earningsInDays >= 0 && fund.earningsInDays <= 7) {
        const en = lang === 'en';
        const d = fund.earningsInDays;
        const whenFr = d === 0 ? "aujourd'hui" : `dans ${d} jour${d > 1 ? 's' : ''}`;
        const whenEn = d === 0 ? 'today' : `in ${d} day${d > 1 ? 's' : ''}`;
        ex.vigilance.push(en
          ? `Earnings due ${whenEn} (${fund.earningsDate}): a surprise can move the price far more than any technical signal — stay cautious before that date.`
          : `Résultats attendus ${whenFr} (le ${fund.earningsDate}) : une surprise peut faire bouger le cours bien plus que n'importe quel signal technique — prudence avant cette date.`);
      }
      results.push({
        ticker: series.ticker, name: series.name || null, currency: series.currency || null, source: series.source, day: series.bars[series.bars.length - 1].day,
        price: a.metrics.price, score: a.value, label: a.label, reco: a.reco,
        metrics: a.metrics, risk: rk, contributions: a.contributions, fund,
        news: newsMap[series.ticker.toUpperCase()] || [],
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
module.exports._internal = { analyze, riskMetrics, explain, sma, ema, rsi, macd, momentum, maxDrawdown, obv, trendCorr, atr, adx, stochastic, rsiDivergence, toWeekly, weeklyTrend, findLevels, detectEvents, signalConfidence, projRange, betaCorr, mfi, psar, squeeze, relVolume, fetchFundamentals, fetchNews };
