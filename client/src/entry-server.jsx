// Build-time SSG entry — renderuje LandingPage do statického HTML stringu.
//
// Prečo: landing je inak 100% client-rendered (v index.html je len prázdny
// div#root) — crawleri bez JS (GPTBot, ClaudeBot, PerplexityBot, starší boti)
// nevidia ŽIADNY obsah. Tento render sa spúšťa v scripts/prerender.mjs po
// `vite build` a výsledok sa vloží do dist/index.html.
//
// Zámerne renderujeme LandingPage PRIAMO (nie celý App):
//  - App používa React.lazy pre všetky routes a renderToString by pre
//    nerozbehnutý lazy chunk vyrenderoval len Suspense fallback (spinner).
//  - LandingPage žiadne lazy deti nemá, potrebuje len Router context
//    kvôli <Link> — ten dodá StaticRouter.
//
// Na klientovi potom main.jsx spraví createRoot().render() — React 18 pri
// render() obsah root-u NAHRADÍ (nejde o hydratáciu, mismatch nehrozí).
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import LandingPage from './pages/LandingPage';

export function render() {
  return renderToString(
    <StaticRouter location="/">
      <LandingPage />
    </StaticRouter>
  );
}
