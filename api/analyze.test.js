// Tests des calculs de l'analyse — sans dépendance externe.
// Lancement :  node api/analyze.test.js
//
// Vérifie les fonctions internes exposées par analyze.js (indicateurs, score,
// métriques de risque, explications). Sort avec le code 1 si un test échoue,
// pour pouvoir être branché sur une intégration continue plus tard.

const { analyze, riskMetrics, explain, sma, ema, rsi, macd, momentum, maxDrawdown } =
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

// ── analyze() : score et cohérence ───────────────────────────────────────────
{
  const a = analyze(bars(ramp(100, 200, 260)));
  ok('analyze score dans [0,100]', a.value >= 0 && a.value <= 100);
  ok('analyze label valide', ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(a.label));
  ok('analyze tendance haussière → score > 50', a.value > 50);
  ok('analyze golden cross (sma50 > sma200)', a.metrics.sma50 > a.metrics.sma200);
  ok('analyze prix = dernier cours', Math.abs(a.price - 200) < 0.001);
  ok('analyze contributions présentes', a.contributions && Object.keys(a.contributions).length > 0);

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
