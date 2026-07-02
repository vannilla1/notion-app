// GA4 analytika — LEN pre verejný marketingový web (landing page "/").
//
// Zámerné obmedzenia (nemeniť bez rozmyslu):
//  - NENAČÍTAVA sa v natívnych shelloch (iOS/Android) — App Store privacy
//    labels a Google Play data-safety deklarácie tracking neuvádzajú.
//  - NENAČÍTAVA sa v prihlásenej appke (/app, /crm, ...) — meriame marketing,
//    nie používateľov produktu.
//  - "Basic consent mode": gtag.js sa NESTIAHNE, kým používateľ neklikne
//    Súhlasím (žiadne cookieless pingy pred súhlasom — najčistejšie voči GDPR).
//  - Reklamné signály sú zakázané KÓDOM (consent default denied + signals off),
//    nie len nastavením GA4 property — text banneru tak platí garantovane.
//
// Zapnutie: doplniť GA_MEASUREMENT_ID (z GA4 property → Data Streams → Web).
// Measurement ID nie je tajomstvo (je v zdrojáku každej stránky s GA), preto
// je hardcoded — Render env vars pre static site sa spravujú len v dashboarde.
import { isNativeApp } from '@/utils/platform';

export const GA_MEASUREMENT_ID = ''; // prázdne = analytika úplne vypnutá

const CONSENT_KEY = 'prpl_analytics_consent'; // 'granted' | 'denied' | null (nerozhodnuté)
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';

export const getConsent = () => {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
};

export const setConsent = (value) => {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Safari private mode — banner sa zobrazí nabudúce znova, nič nespadne
  }
};

let loaded = false;

export function loadAnalytics() {
  try {
    if (loaded || !GA_MEASUREMENT_ID || typeof document === 'undefined') return;
    // Defense-in-depth: invariant nesmie závisieť od disciplíny volajúcich
    if (isNativeApp()) return;
    // Idempotencia aj voči Vite HMR re-evaluácii modulu (loaded flag sa resetne)
    if (document.querySelector(`script[src^="${GTAG_SRC}"]`)) return;
    loaded = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };
    window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;
    window.gtag('js', new Date());
    // Reklamné úložiská natvrdo denied — garantuje "žiadne reklamy" z banneru
    window.gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    window.gtag('config', GA_MEASUREMENT_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = `${GTAG_SRC}?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
    document.head.appendChild(script);
  } catch {
    // analytika nikdy nesmie zhodiť UI
  }
}

// Odvolanie súhlasu (GDPR čl. 7(3)) — vypne meranie aj v bežiacej session
// a best-effort zmaže _ga* cookies.
export function disableAnalytics() {
  setConsent('denied');
  try {
    if (GA_MEASUREMENT_ID) {
      window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
    }
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
    }
    const cookies = (document.cookie || '').split(';');
    for (const c of cookies) {
      const name = c.split('=')[0].trim();
      if (name === '_ga' || name.startsWith('_ga_')) {
        // expirovať na oboch variantoch domény
        document.cookie = `${name}=; Max-Age=0; path=/`;
        document.cookie = `${name}=; Max-Age=0; path=/; domain=.${location.hostname}`;
      }
    }
  } catch {
    // best-effort — voľba je už uložená, meranie sa nenačíta nabudúce
  }
}

// Znovuotvorenie consent banneru (footer "Nastavenia cookies").
const SETTINGS_EVENT = 'prpl-cookie-settings';
export const openCookieSettings = () => {
  try {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  } catch {
    /* no-op */
  }
};
export const COOKIE_SETTINGS_EVENT = SETTINGS_EVENT;

// Bezpečný event tracker — no-op keď GA nebeží (bez súhlasu / native app).
export function trackEvent(name, params = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', name, params);
    }
  } catch {
    // analytika nikdy nesmie zhodiť UI
  }
}
