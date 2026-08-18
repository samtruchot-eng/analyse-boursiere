// Barrière d'accès du site (Edge Middleware Vercel).
// Tant que le bon code n'a pas été saisi, aucune page ni l'API ne sont servies :
// on renvoie une page de connexion. Le code est lu dans la variable
// d'environnement ACCESS_CODE (à définir dans les réglages Vercel). Un cookie
// signé (empreinte SHA-256 du code) mémorise l'accès pendant 30 jours.
import { next } from '@vercel/edge';

export const config = { matcher: '/:path*' };

const SALT = 'bfly-gate-v1';
const COOKIE = 'bfly_auth';
const MAXAGE = 60 * 60 * 24 * 30; // 30 jours

async function tokenFor(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code + SALT));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loginPage(error) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>butterfly — accès</title>
<link rel="icon" href="data:,">
<style>
  :root { --accent:#6C4A9C; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:'Helvetica Neue',Arial,sans-serif; color:#1f2430;
    background:linear-gradient(135deg,#efe7f5 0%,#f7f3fb 45%,#fbeef4 100%); }
  .card { width:min(92vw,360px); background:#fff; border-radius:16px; padding:34px 30px 28px;
    box-shadow:0 18px 50px rgba(108,74,156,.18); text-align:center; }
  .brand { font-family:Georgia,serif; color:var(--accent); font-size:30px; font-weight:700; margin:0; }
  .slogan { font-family:Georgia,serif; font-style:italic; color:#888; font-size:13px; margin:2px 0 22px; }
  label { display:block; text-align:left; font-size:12.5px; color:#555; margin:0 0 6px; }
  input { width:100%; padding:12px 14px; font-size:15px; border:1px solid #d9cde8; border-radius:10px;
    outline:none; transition:border-color .15s; }
  input:focus { border-color:var(--accent); }
  button { width:100%; margin-top:14px; padding:12px; font-size:15px; font-weight:650; color:#fff;
    background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
  button:hover { background:#5a3d84; }
  .err { color:#b3261b; font-size:12.5px; margin:12px 0 0; ${error ? '' : 'display:none;'} }
  .foot { color:#aaa; font-size:11px; margin-top:18px; }
</style></head><body>
  <form class="card" action="/__auth" method="post" autocomplete="off">
    <p class="brand">butterfly</p>
    <p class="slogan">La bourse, en toute clarté.</p>
    <label for="code">Code d'accès</label>
    <input id="code" name="code" type="password" autofocus required placeholder="Entrez le code">
    <button type="submit">Entrer</button>
    <p class="err">Code incorrect. Réessayez.</p>
    <p class="foot">Accès réservé</p>
  </form>
</body></html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const CODE = (typeof process !== 'undefined' && process.env && process.env.ACCESS_CODE) || 'butterfly';
  const good = await tokenFor(CODE);

  // Soumission du formulaire de connexion.
  if (request.method === 'POST' && url.pathname === '/__auth') {
    let code = '';
    try { const f = await request.formData(); code = String(f.get('code') || ''); } catch (e) { /* ignore */ }
    if (code === CODE) {
      const headers = new Headers();
      headers.set('Location', '/');
      headers.append('Set-Cookie', `${COOKIE}=${good}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${MAXAGE}`);
      return new Response(null, { status: 302, headers });
    }
    return new Response(loginPage(true), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // Déjà authentifié ? (cookie = empreinte du code)
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]+)'));
  if (m && m[1] === good) return next();

  // Sinon : page de connexion.
  return new Response(loginPage(false), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
