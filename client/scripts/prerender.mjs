// Build-time prerender landing page → dist/index.html.
//
// Beží po `vite build` (viď package.json "build"). Postup:
//   1. vite build --ssr (programaticky, vlastný minimálny config) →
//      dist-server/entry-server.mjs
//   2. import render() → HTML string LandingPage
//   3. inject do <div id="root"> v dist/index.html + ROUTE GUARDY (nižšie)
//   4. overí, že landing štýly sú dostupné (eager import = v hlavnom CSS;
//      keby sa LandingPage niekedy vrátil na lazy, linkne jeho CSS chunk)
//   5. prepočíta workbox revision pre index.html v dist/sw.js
//
// ROUTE GUARDY — dist/index.html je zároveň SPA fallback pre VŠETKY routy
// (/login, /app, ... aj iOS shell štartujúci na /app). Prerendrovaný landing
// tam nesmie ani bliknúť, ani zaberať pamäť (iOS WKWebView jetsam rozpočet):
//   - <head> guard: mimo '/' skryje #root CSS-om EŠTE POČAS streamovania
//     HTML (inak môže prehliadač stihnúť vykresliť časť obsahu pred tým,
//     než parser dôjde k čistiacemu skriptu za </div>)
//   - post-root guard: mimo '/' obsah #root ZMAŽE (uvoľní DOM) a odskryje
//     root pre React → správanie identické s pôvodným prázdnym shellom
//
// FAIL-SAFE: akákoľvek chyba => exit 0 + dist/index.html ostáva nedotknutý
// (SPA shell = doterajšie správanie). Render deploy sa NIKDY nerozbije
// kvôli prerenderingu. Grep token v logoch: [prerender] OK / [prerender] ZLYHAL.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(clientDir, 'dist');
const ssrOutDir = path.join(clientDir, 'dist-server');

const HEAD_GUARD =
  '<script>window.__PRERENDER__=location.pathname===\'/\';' +
  'if(!window.__PRERENDER__)document.documentElement.classList.add(\'pr-np\')</script>' +
  '<style>html.pr-np #root{display:none}</style>';

const POST_ROOT_GUARD =
  '<script>if(!window.__PRERENDER__){var __r=document.getElementById(\'root\');' +
  '__r&&(__r.textContent=\'\');document.documentElement.classList.remove(\'pr-np\')}</script>';

try {
  // 1) SSR build (výstup .mjs — package.json nemá type:module, .js by node bral ako CJS).
  // configFile:false — hlavný vite.config.js NEdedíme: jeho manualChunks
  // koliduje s SSR externalizáciou reactu a VitePWA plugin do SSR nepatrí.
  await build({
    root: clientDir,
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias: { '@': path.join(clientDir, 'src') } },
    build: {
      ssr: 'src/entry-server.jsx',
      outDir: 'dist-server',
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'entry-server.mjs' } },
    },
  });

  // 2) render
  const { render } = await import(pathToFileURL(path.join(ssrOutDir, 'entry-server.mjs')).href);
  const appHtml = render();

  // sanity — štrukturálne markery (nie marketingová copy, tá sa smie meniť)
  if (typeof appHtml !== 'string' || appHtml.length < 5000) {
    throw new Error(`prerender output podozrivo krátky (${appHtml?.length} znakov)`);
  }
  if (!appHtml.includes('class="lp-') || !appHtml.includes('<h1')) {
    throw new Error('prerender output nemá očakávanú štruktúru (lp- triedy / h1)');
  }

  // 3) styling: LandingPage je eager import → jeho CSS je v hlavnom index-*.css
  // (linknutý v <head> pred obsahom). Keby sa vrátil na lazy, linkneme chunk.
  const assets = readdirSync(path.join(distDir, 'assets'));
  const lpCss = assets.find((f) => /^LandingPage-.*\.css$/.test(f));
  const lpJs = assets.find((f) => /^LandingPage-.*\.js$/.test(f));
  let extraLinks = '';
  if (lpCss) {
    extraLinks += `    <link rel="stylesheet" crossorigin href="/assets/${lpCss}">\n`;
    if (lpJs) extraLinks += `    <link rel="modulepreload" crossorigin href="/assets/${lpJs}">\n`;
  } else {
    // eager scenár — over že .lp- štýly reálne existujú v niektorom CSS,
    // inak by sme shipli 30 kB neštýlovaného textu (horšie než SPA shell)
    const hasLpStyles = assets
      .filter((f) => f.endsWith('.css'))
      .some((f) => readFileSync(path.join(distDir, 'assets', f), 'utf8').includes('.lp-navbar'));
    if (!hasLpStyles) {
      throw new Error('landing štýly (.lp-navbar) nenájdené v žiadnom CSS — prerender by bol neštýlovaný');
    }
  }

  // 4) inject (replace s funkciou — string replacement by interpretoval $ vzory v HTML)
  const indexPath = path.join(distDir, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  const marker = '<div id="root"></div>';
  if (!html.includes(marker)) {
    throw new Error('dist/index.html neobsahuje prázdny <div id="root"></div>');
  }
  html = html.replace(marker, () => `<div id="root">${appHtml}</div>${POST_ROOT_GUARD}`);
  html = html.replace('</head>', () => `${extraLinks}${HEAD_GUARD}</head>`);

  // atomický zápis — polovičný index.html by bol horší než akékoľvek zlyhanie
  writeFileSync(indexPath + '.tmp', html);
  renameSync(indexPath + '.tmp', indexPath);

  // 5) sw.js: workbox revision pre index.html sa počíta z PRED-injektovej verzie.
  // Pri deployi, ktorý zmení len prerender výstup, by PWA klienti neaktualizovali
  // → prepočítame revision z finálneho súboru. sw.js sám nie je precachovaný
  // a servíruje sa no-cache, takže post-build úprava je bezpečná.
  try {
    const swPath = path.join(distDir, 'sw.js');
    let sw = readFileSync(swPath, 'utf8');
    const rev = createHash('md5').update(html).digest('hex');
    const re = /(\{url:"index\.html",revision:")[0-9a-f]{32}("\})/;
    if (re.test(sw)) {
      sw = sw.replace(re, `$1${rev}$2`);
      writeFileSync(swPath, sw);
    }
  } catch {
    // sw update je optimalizácia, nie podmienka
  }

  console.log(
    `[prerender] OK — landing v dist/index.html (${appHtml.length} zn. obsahu` +
      `${lpCss ? ', +css ' + lpCss : ', štýly v hlavnom CSS'}, guardy aktívne)`
  );
} catch (err) {
  console.warn('[prerender] ZLYHAL — dist/index.html ostáva ako SPA shell (deploy pokračuje):', err?.message || err);
} finally {
  try {
    rmSync(ssrOutDir, { recursive: true, force: true });
  } catch {
    /* no-op */
  }
}
