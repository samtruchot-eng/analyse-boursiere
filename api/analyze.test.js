// Tests des calculs de l'analyse — sans dépendance externe.
// Lancement :  node api/analyze.test.js
//
// Vérifie les fonctions internes exposées par analyze.js (indicateurs, score,
// métriques de risque, explications). Sort avec le code 1 si un test échoue,
// pour pouvoir être branché sur une intégration continue plus tard.

const { analyze, riskMetrics, explain, sma, ema, rsi, macd, momentum, maxDrawdown,
  obv, trendCorr, atr, adx, stochastic, rsiDivergence } =
  require('./analyze.js')._internal;

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); }
}
function approx(name, got, exp, tol = 0.01) {
  const good = got != null && Math.abs(got - exp) <= tol;
  ok(`${name} (attendu ≈ ${exp}, obtenu ${got})`, good);
}

// Fabrique des barres {close} à partir d'une liste de cours.
const bars = (closes) => ({ bars: closes.map((c) => ({ close: c })), ticker: 'TEST' });
// Série croissante linéaire de `a` à `b` en `n` points.
function ramp(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + (b - a) * (i / (n - 1)));
  return out;
}

// ── Moyennes mobiles ─────────────────────────────────────────────────────────
{
  const s = sma([1, 2, 3, 4], 2);
  ok('sma longueur', s.length === 4);
  ok('sma amorçage null', s[0] === null);
  approx('sma[1]', s[1], 1.5);
  approx('sma[3]', s[3], 3.5);

  const e = ema([1, 2, 3, 4, 5, 6], 3);
  ok('ema longueur', e.length === 6);
  ok('ema amorçage null', e[0] === null && e[1] === null);
  ok('ema dernière valeur numérique', typeof e[5] === 'number' && isFinite(e[5]));
  ok('ema croissante suit la hausse', e[5] > e[2]);
}

// ── RSI ──────────────────────────────────────────────────────────────────────
{
  const up = ramp(100, 200, 40);         // strictement croissante
  const down = ramp(200, 100, 40);       // strictement décroissante
  approx('rsi série haussière = 100', rsi(up, 14).at(-1), 100, 0.001);
  approx('rsi série baissière = 0', rsi(down, 14).at(-1), 0, 0.001);

  const flatish = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const r = rsi(flatish, 14).at(-1);
  ok('rsi série oscillante ~50', r != null && r > 30 && r < 70);
}

// ── MACD ─────────────────────────────────────────────────────────────────────
{
  const m = macd(ramp(100, 200, 80));
  ok('macd renvoie line/signal/hist', m.line && m.signal && m.hist);
  ok('macd longueurs cohérentes', m.line.length === 80 && m.hist.length === 80);
  ok('macd histogramme final numérique', typeof m.hist.at(-1) === 'number');
  ok('macd ligne > 0 en tendance haussière', m.line.at(-1) > 0);
}

// ── Momentum ─────────────────────────────────────────────────────────────────
{
  approx('momentum (5/3-1)*100', momentum([1, 2, 3, 4, 5], 2), 66.6667, 0.01);
  ok('momentum insuffisant = null', momentum([1, 2], 5) === null);
}

// ── Max drawdown ─────────────────────────────────────────────────────────────
{
  approx('drawdown 120→90 = -25%', maxDrawdown([100, 120, 90, 130]), -25, 0.001);
  approx('drawdown série croissante = 0%', maxDrawdown(ramp(100, 200, 50)), 0, 0.001);
}

// ── Volume : OBV + corrélation de tendance ───────────────────────────────────
{
  const closes = [10, 11, 12, 11, 13, 14];
  const vols = [0, 100, 100, 50, 100, 100];
  const o = obv(closes, vols);
  ok('obv longueur', o.length === closes.length);
  approx('obv[1] hausse ajoute volume', o[1], 100);
  approx('obv[3] baisse retranche volume', o[3], 200 - 50);
  ok('trendCorr série croissante ≈ +1', Math.abs(trendCorr(ramp(1, 10, 30), 30) - 1) < 0.001);
  ok('trendCorr série décroissante ≈ -1', Math.abs(trendCorr(ramp(10, 1, 30), 30) + 1) < 0.001);
  ok('trendCorr trop court = 0', trendCorr([1, 2], 40) === 0);
}

// ── ATR / ADX / Stochastique ─────────────────────────────────────────────────
{
  const rising = ramp(100, 200, 60).map((c) => ({ high: c, low: c, close: c }));
  const falling = ramp(200, 100, 60).map((c) => ({ high: c, low: c, close: c }));
  ok('atr numérique ≥ 0', atr(rising, 14) >= 0);
  ok('atr série trop courte = null', atr([{ close: 1 }], 14) === null);

  const au = adx(rising, 14), ad = adx(falling, 14);
  ok('adx hausse : +DI > -DI', au && au.plusDI > au.minusDI);
  ok('adx baisse : -DI > +DI', ad && ad.minusDI > ad.plusDI);
  ok('adx force numérique', au && au.adx != null && au.adx >= 0);
  ok('adx trop court = null', adx(rising.slice(0, 10), 14) === null);

  ok('stoch série haussière proche de 100', stochastic(rising, 14) > 90);
  ok('stoch série baissière proche de 0', stochastic(falling, 14) < 10);
  ok('stoch trop court = null', stochastic([{ close: 1 }], 14) === null);
}

// ── Divergence prix / RSI ────────────────────────────────────────────────────
{
  // Prix : creux plus bas en 2e moitié, mais amorti (RSI se redresse) → haussière.
  const n = 60, closes = [];
  for (let i = 0; i < n; i++) closes.push(i < 30 ? 100 - i : 70 + (i - 30) * 0.2);
  const d = rsiDivergence(closes, rsi(closes, 14), 40);
  ok('divergence renvoie bull/bear/null', d === 'bull' || d === 'bear' || d === null);
  ok('divergence série trop courte = null', rsiDivergence([1, 2, 3], rsi([1, 2, 3], 14), 40) === null);
}

// ── analyze() : score et cohérence ───────────────────────────────────────────
{
  const a = analyze(bars(ramp(100, 200, 260)));
  ok('analyze score dans [0,100]', a.value >= 0 && a.value <= 100);
  ok('analyze label valide', ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(a.label));
  ok('analyze tendance haussière → score > 50', a.value > 50);
  ok('analyze golden cross (sma50 > sma200)', a.metrics.sma50 > a.metrics.sma200);
  ok('analyze prix = dernier cours', Math.abs(a.price - 200) < 0.001);
  ok('analyze contributions présentes', a.contributions && Object.keys(a.contributions).length > 0);
  ok('analyze ADX exposé dans metrics', a.metrics.adx != null);
  ok('analyze Stochastique exposé dans metrics', a.metrics.stoch != null);
  ok('analyze ATR exposé dans metrics', a.metrics.atr_pct != null);
  ok('analyze champ divergence présent', 'divergence' in a.metrics);

  const b = analyze(bars(ramp(200, 100, 260)));
  ok('analyze tendance baissière → score < 50', b.value < 50);
  ok('analyze death cross (sma50 < sma200)', b.metrics.sma50 < b.metrics.sma200);
}

// ── riskMetrics() ────────────────────────────────────────────────────────────
{
  const rk = riskMetrics(ramp(100, 200, 260));
  approx('risk total_return ≈ 100%', rk.total_return_pct, 100, 1);
  ok('risk volatilité définie ≥ 0', rk.annual_vol_pct != null && rk.annual_vol_pct >= 0);
  ok('risk sharpe positif en hausse', rk.sharpe > 0);
  approx('risk drawdown croissant = 0', rk.max_drawdown_pct, 0, 0.001);
  ok('risk perf 1 an présente', rk.ret_1y_pct != null);
}

// ── explain() : phrases françaises ───────────────────────────────────────────
{
  const series = bars(ramp(100, 200, 260));
  const a = analyze(series);
  const rk = riskMetrics(series.bars.map((x) => x.close));
  const ex = explain(a, rk, 'TEST');
  ok('explain headline non vide', typeof ex.headline === 'string' && ex.headline.length > 0);
  ok('explain points est un tableau non vide', Array.isArray(ex.points) && ex.points.length > 0);
  ok('explain chaque point a un ton valide', ex.points.every((p) => ['bull', 'bear', 'warn', 'neutral'].includes(p.s)));
  ok('explain résumé de risque présent', typeof ex.risk_summary === 'string');
  ok('explain vigilance est un tableau', Array.isArray(ex.vigilance));
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n${pass} test(s) réussi(s), ${fail} échec(s).`);
if (fail) {
  console.log('\nÉchecs :');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ Tous les tests passent.');
