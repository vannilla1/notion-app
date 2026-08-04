import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { isIosNativeApp } from '../utils/platform';

/**
 * UpgradeModal — jedno centrálne okno pre všetky plánové limity.
 *
 * Počúva event 'plan-gate' (vystrelí ho axios interceptor cez
 * utils/planGate pri 403/400 s kódom FEATURE_NOT_IN_PLAN / PLAN_LIMIT /
 * STORAGE_LIMIT). Namiesto slepého alertu ukáže, čo je za limitom,
 * a vedie rovno na /app/billing (web/Android → Stripe BillingPage,
 * iOS → IapBilling s Apple in-app nákupom).
 *
 * Apple 3.1.1: v iOS shelli sa NESMÚ zobrazovať ceny ani zmienky
 * o Stripe — iOS variant je neutrálny (server aj tak posiela neutrálne
 * hlášky) a CTA vedie na IapBilling, čo je Apple-ovi vyhovujúca cesta.
 *
 * Dedupe: kým je modal otvorený, ďalšie eventy sa ignorujú (batch
 * operácie ako hromadné kopírovanie by inak strieľali okno opakovane).
 */
const TITLES = {
  FEATURE_NOT_IN_PLAN: 'Funkcia vyšších plánov',
  PLAN_LIMIT: 'Dosiahli ste limit plánu',
  STORAGE_LIMIT: 'Úložisko je plné'
};

export default function UpgradeModal() {
  const [gate, setGate] = useState(null); // { code, message } | null
  const navigate = useNavigate();
  const location = useLocation();
  const ios = isIosNativeApp();

  useEffect(() => {
    const onGate = (e) => {
      // Dedupe + na billing stránke nemá upsell okno zmysel
      setGate(prev => prev || (window.location.pathname.startsWith('/app/billing') ? null : e.detail));
    };
    window.addEventListener('plan-gate', onGate);
    return () => window.removeEventListener('plan-gate', onGate);
  }, []);

  // Navigácia kamkoľvek modal zavrie (napr. klik na notifikáciu)
  useEffect(() => { setGate(null); }, [location.pathname]);

  const close = useCallback(() => setGate(null), []);

  if (!gate) return null;

  const goBilling = () => {
    setGate(null);
    navigate('/app/billing');
  };

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-content" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{ios ? 'Funkcia nie je dostupná' : (TITLES[gate.code] || 'Limit plánu')}</h3>
          <button className="modal-close" onClick={close}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>{gate.message}</p>
          {!ios && (
            <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <strong>Tím</strong>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  4,99 € / mes <span style={{ color: 'var(--text-muted)' }}>· ročne 49 € (2 mesiace zadarmo)</span>
                </span>
              </div>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <strong>Pro</strong>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  9,99 € / mes <span style={{ color: 'var(--text-muted)' }}>· ročne 99 € (2 mesiace zadarmo)</span>
                </span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                Vyšší plán odomkne prílohy, väčšie limity, viac členov tímu aj Google synchronizáciu.
              </p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={close}>Teraz nie</button>
          <button className="btn btn-primary" onClick={goBilling}>
            {ios ? 'Zobraziť možnosti' : 'Zobraziť plány'}
          </button>
        </div>
      </div>
    </div>
  );
}
