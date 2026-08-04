/**
 * planGate.js — klientske spracovanie plánových limitov (upsell momenty).
 *
 * Server pri narazení na limit plánu vracia 403/400 s `code`:
 *   FEATURE_NOT_IN_PLAN — funkcia nie je vo free pláne (prílohy, CSV, sync)
 *   PLAN_LIMIT          — číselný strop (kontakty, projekty, podúlohy, členovia)
 *   STORAGE_LIMIT       — plná storage kvóta plánu
 *
 * Axios interceptor (api.js) na tieto kódy vystrelí event 'plan-gate' —
 * UpgradeModal (mount v App.jsx) ho zobrazí ako jedno miesto s cestou
 * na /app/billing (web → Stripe BillingPage, iOS → IapBilling).
 *
 * alertUnlessPlanGate() nahrádza vzor `alert(error.response?.data?.message)`
 * v catch blokoch — keď modal chybu už zobrazil, alert by bol duplicitný.
 * Pre všetky ostatné chyby sa správa IDENTICKY ako pôvodný alert.
 */
export const PLAN_GATE_CODES = new Set(['FEATURE_NOT_IN_PLAN', 'PLAN_LIMIT', 'STORAGE_LIMIT']);

/** Vystrelí event pre UpgradeModal. detail = { code, message } */
export const dispatchPlanGate = (detail) => {
  try {
    window.dispatchEvent(new CustomEvent('plan-gate', { detail }));
  } catch { /* modal je bonus — chybu stále vidí catch volajúceho */ }
};

/** True + event, ak axios error je plánový limit (volá interceptor). */
export const handlePlanGateError = (error) => {
  const data = error?.response?.data;
  if (!data || !PLAN_GATE_CODES.has(data.code)) return false;
  dispatchPlanGate({ code: data.code, message: data.message });
  error.planGateShown = true;
  return true;
};

/** Drop-in náhrada za alert(error.response?.data?.message || fallback). */
export const alertUnlessPlanGate = (error, fallback) => {
  if (error?.planGateShown) return;
  alert(error?.response?.data?.message || fallback);
};
