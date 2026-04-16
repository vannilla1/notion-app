/**
 * Vráti true ak URL obsahuje `ws=` query parameter — v takom prípade má
 * stránka odložiť vlastný fetch (App.jsx ešte rieši workspace switch,
 * inak by sme fetchli dáta starého workspacu a potom ich znovu po switche).
 *
 * @param {Location} location — `useLocation()` z react-router-dom
 * @returns {boolean}
 */
export function isDeepLinkPending(location) {
  return new URLSearchParams(location.search).has('ws');
}
