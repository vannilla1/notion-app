import { useEffect, useState } from 'react';
import {
  GA_MEASUREMENT_ID,
  COOKIE_SETTINGS_EVENT,
  openCookieSettings,
  getConsent,
  setConsent,
  loadAnalytics,
  disableAnalytics,
} from '@/utils/analytics';
import { isNativeApp } from '@/utils/platform';

// Consent je aktívny len keď má zmysel: GA je nakonfigurované a nie sme
// v natívnom shelli (tam analytika nikdy nebeží → banner by len mätol).
const consentActive = () => !!GA_MEASUREMENT_ID && !isNativeApp();

/**
 * Cookie/analytika consent banner — zobrazuje sa LEN na landing page,
 * LEN mimo natívnych appiek a LEN kým používateľ nerozhodol.
 *
 * Basic consent mode: GA sa načíta až PO kliknutí na Súhlasím. Rozhodnutie
 * sa pamätá; znovu otvoriť sa dá cez footer link "Nastavenia cookies"
 * (GDPR čl. 7(3) — odvolanie súhlasu musí byť rovnako ľahké ako udelenie).
 * Kým je GA_MEASUREMENT_ID prázdne, komponent nerenderuje nič.
 */
export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!consentActive()) return;

    const consent = getConsent();
    if (consent === 'granted') {
      loadAnalytics();
    } else if (consent === null) {
      setVisible(true);
    }
    // consent === 'denied' → nič: nenačítať, neukazovať

    const reopen = () => setVisible(true);
    window.addEventListener(COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(COOKIE_SETTINGS_EVENT, reopen);
  }, []);

  if (!visible) return null;

  const accept = () => {
    setVisible(false);
    setConsent('granted');
    loadAnalytics();
  };

  const decline = () => {
    setVisible(false);
    disableAnalytics(); // uloží denied + vypne bežiace meranie + zmaže _ga* cookies
  };

  return (
    <div className="lp-cookie-banner" role="region" aria-live="polite" aria-label="Súhlas s analytikou">
      <p className="lp-cookie-text">
        Používame Google Analytics na anonymizované štatistiky návštevnosti —
        žiadne reklamy, žiadny predaj údajov. Meranie beží len s vaším súhlasom.{' '}
        <a href="/ochrana-udajov/">Viac o ochrane údajov</a>
      </p>
      <div className="lp-cookie-actions">
        <button type="button" className="lp-cookie-btn lp-cookie-accept" onClick={accept}>
          Súhlasím
        </button>
        <button type="button" className="lp-cookie-btn lp-cookie-decline" onClick={decline}>
          Odmietnuť
        </button>
      </div>
    </div>
  );
}

/**
 * Footer link "Nastavenia cookies" — znovu otvorí consent banner, aby sa dal
 * súhlas kedykoľvek zmeniť/odvolať. Renderuje sa len keď je consent aktívny.
 */
export function CookieSettingsLink() {
  if (!consentActive()) return null;
  return (
    <button type="button" className="lp-cookie-settings-link" onClick={openCookieSettings}>
      Nastavenia cookies
    </button>
  );
}
