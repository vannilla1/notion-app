/**
 * Server-side platform detection — primárne pre Apple App Store compliance.
 *
 * iOS native shell (Swift WKWebView wrapper) injectuje do User-Agent suffix
 * `PrplCRM-iOS/<version>` cez WKWebViewConfiguration.applicationNameForUserAgent.
 * Tým môžeme na serveri rozlíšiť request z native appky vs bežný Safari/Chrome.
 *
 * Use-case 1: Plan-limit error messages — Apple Guideline 3.1.1 zakazuje v iOS
 * binary referencovať platený obsah / external payment paths. Keď user dosiahne
 * limit, na webe vrátime informatívny text "Pre viac kontaktov prejdite na
 * vyšší plán", ale na iOS vraciame platform-neutral text bez zmienky o pláne.
 *
 * Use-case 2: Audit logging zariadenia / device fingerprinting — pre admin
 * panel rozlíšenie webových vs natívnych eventov.
 *
 * Note: User-Agent je trivial spoofable, takže toto NIE JE bezpečnostný
 * mechanizmus. Slúži výhradne na content gating pre App Store compliance —
 * ak by si user spoof-oval UA, dostane neutral message namiesto plan info,
 * žiadny security impact.
 */

const isIosNativeApp = (req) => {
  if (!req || typeof req.get !== 'function') return false;
  const ua = req.get('user-agent') || '';
  return /PrplCRM-iOS\//.test(ua);
};

module.exports = { isIosNativeApp };
