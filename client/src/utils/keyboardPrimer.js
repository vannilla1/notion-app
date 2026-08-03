/**
 * keyboardPrimer — otvorenie mobilnej klávesnice pre modaly s inputom.
 *
 * iOS WKWebView aj Android WebView otvoria soft klávesnicu LEN pri fokuse,
 * ktorý vznikol priamo v gete používateľa (klik/výber súboru). Autofocus
 * v modáli, ktorý sa vyrenderuje až o chvíľu (React setState → render),
 * už gestom nie je — input dostane fokus, ale klávesnica sa neukáže.
 *
 * Trik: v handleri gesta (onChange file inputu, onClick ✏️) sa SYNCHRÓNNE
 * fokusne dočasný neviditeľný input → klávesnica sa otvorí. Modal potom
 * fokus len PRENESIE na skutočné pole (prenos fokusu medzi inputmi
 * klávesnicu nezatvára) a primer odstráni cez removeKeyboardPrimers().
 *
 * Poistka: keby modal fokus neprebral (unmount, chyba), primer sa sám
 * odstráni po 3 s — neostane visieť neviditeľný fokusnutý input.
 */
const PRIMER_ATTR = 'data-kb-primer';

export const primeMobileKeyboard = () => {
  try {
    const tmp = document.createElement('input');
    tmp.type = 'text';
    tmp.setAttribute(PRIMER_ATTR, '1');
    tmp.setAttribute('aria-hidden', 'true');
    tmp.style.position = 'fixed';
    tmp.style.top = '0';
    tmp.style.left = '0';
    tmp.style.width = '1px';
    tmp.style.height = '1px';
    tmp.style.opacity = '0';
    tmp.style.border = 'none';
    tmp.style.padding = '0';
    // iOS zoomuje viewport pri fokuse inputu s font-size < 16px
    tmp.style.fontSize = '16px';
    document.body.appendChild(tmp);
    tmp.focus({ preventScroll: true });
    setTimeout(() => { if (tmp.parentNode) tmp.remove(); }, 3000);
  } catch { /* klávesnica je bonus — nikdy nesmie zhodiť upload flow */ }
};

export const removeKeyboardPrimers = () => {
  document.querySelectorAll(`[${PRIMER_ATTR}]`).forEach(el => el.remove());
};
