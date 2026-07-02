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
//  - LandingPage nemá žiadnu Router závislosť (footer legal odkazy sú
//    obyčajné <a>) — žiadny StaticRouter nie je potrebný.
//
// KRITICKÉ: výstup MUSÍ byť identický s tým, čo klient hydratuje v main.jsx
// (hydrateRoot s <LandingPage/>) — pri mismatchi React spadne na client
// render = repaint = pokazený LCP. Preto obe strany renderujú holé
// <LandingPage /> bez wrapperov ovplyvňujúcich markup.
import { renderToString } from 'react-dom/server';
import LandingPage from './pages/LandingPage';

export function render() {
  return renderToString(<LandingPage />);
}
