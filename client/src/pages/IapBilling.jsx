import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import HeaderLogo from '../components/HeaderLogo';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import NotificationBell from '../components/NotificationBell';
import UserMenu from '../components/UserMenu';
import { iapAvailable, fetchIapProducts, purchaseIap, restoreIap } from '../utils/iapBridge';

/**
 * IapBilling — upgrade stránka pre iOS native appku (Apple In-App Purchase).
 *
 * Web + Android používajú BillingPage (Stripe). Táto stránka sa zobrazí IBA
 * v iOS native shell-e a používa StoreKit cez iapBridge. Apple-compliant:
 * žiadne external payment linky, žiadne Stripe/promo zmienky, ceny priamo
 * z App Store (StoreKit displayPrice).
 *
 * LAYOUT: používa .crm-container > .crm-header > .crm-content > .crm-main
 * štruktúru ako ostatné sekcie (Tasks, CRM) — to zabezpečí konzistentný
 * header AJ funkčný scroll (v iOS je body position:fixed, scroll prebieha
 * vnútri .crm-main, nie na body). Bez tohto wrappera stránka nescrollovala.
 *
 * productId konvencia: prplcrm.<plan>.<period> (zhoduje sa s
 * server/config/appleProducts.js + StoreKitManager.swift).
 */
export default function IapBilling() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();

  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState([]);
  const [priceMap, setPriceMap] = useState({}); // productId → { price (displayPrice), priceValue }
  const [loading, setLoading] = useState(true);
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  const [purchasing, setPurchasing] = useState(null); // productId práve prebiehajúceho nákupu
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'success'|'error'|'info', text }

  const productIdFor = (planId, period) => `prplcrm.${planId}.${period}`;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, plansRes] = await Promise.all([
        api.get('/api/billing/status').catch(() => ({ data: null })),
        api.get('/api/billing/plans').catch(() => ({ data: { plans: [] } }))
      ]);
      setStatus(statusRes.data);
      setPlans(plansRes.data.plans || []);

      // StoreKit ceny (lokalizované podľa App Store regiónu)
      if (iapAvailable()) {
        try {
          const products = await fetchIapProducts();
          const map = {};
          (products || []).forEach((p) => { map[p.productId] = p; });
          setPriceMap(map);
        } catch {
          // Fallback na ceny z /plans ak StoreKit fetch zlyhá
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Refresh keď príde external transakcia (renewal/restore cez native listener)
  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener('iap-external-update', handler);
    return () => window.removeEventListener('iap-external-update', handler);
  }, [loadData]);

  const currentPlan = status?.plan || user?.subscription?.plan || 'free';
  const appleManaged = status?.appleManaged || status?.source === 'apple';

  const handleBuy = async (planId) => {
    const productId = productIdFor(planId, billingPeriod);
    setPurchasing(productId);
    setMessage(null);
    try {
      const result = await purchaseIap(productId);
      if (result.cancelled) {
        setMessage(null); // ticho — user zrušil
      } else if (result.pending) {
        setMessage({ type: 'info', text: 'Nákup čaká na schválenie (Ask to Buy). Po schválení sa plán aktivuje automaticky.' });
      } else if (result.success) {
        setMessage({ type: 'success', text: `Hotovo! Tvoj plán je teraz ${result.subscription?.plan === 'pro' ? 'Pro' : 'Tím'}.` });
        await loadData();
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Nákup zlyhal. Skús to znova.' });
    } finally {
      setPurchasing(null);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const result = await restoreIap();
      if (result.success) {
        setMessage({ type: 'success', text: 'Predplatné bolo obnovené.' });
        await loadData();
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Nič na obnovenie.' });
    } finally {
      setRestoring(false);
    }
  };

  // Iba team + pro sú kúpiteľné (free je default).
  const buyablePlans = plans.filter((p) => p.id === 'team' || p.id === 'pro');

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUserUpdate={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <main className="crm-main">
          <div className="billing-page">
            {/* Nadpis + späť */}
            <div className="billing-header">
              <button className="btn btn-secondary" style={{ fontSize: 13 }} onClick={() => navigate('/app')}>← Späť</button>
              <h2>Predplatné</h2>
            </div>

            {loading ? (
              <div className="loading" style={{ textAlign: 'center', padding: 40 }}>Načítavam…</div>
            ) : (
              <>
                {/* Aktuálny plán */}
                <div style={{ textAlign: 'center', marginBottom: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
                  Aktuálny plán: <strong style={{ color: 'var(--text-primary)' }}>
                    {currentPlan === 'pro' ? 'Pro' : currentPlan === 'team' ? 'Tím' : 'Free'}
                  </strong>
                  {status?.paidUntil && currentPlan !== 'free' && (
                    <span> · platné do {new Date(status.paidUntil).toLocaleDateString('sk-SK')}</span>
                  )}
                </div>

                {/* Apple-managed info */}
                {appleManaged && (
                  <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 10, marginBottom: 16, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    ℹ️ Tvoje predplatné je spravované cez App Store. Zmeniť alebo zrušiť ho môžeš
                    v <strong>Nastavenia → [tvoje meno] → Predplatné</strong> na tomto zariadení.
                  </div>
                )}

                {/* Mesačne / ročne toggle */}
                <div className="billing-period-toggle" style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
                  <button
                    className={`btn btn-sm ${billingPeriod === 'monthly' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBillingPeriod('monthly')}
                  >Mesačne</button>
                  <button
                    className={`btn btn-sm ${billingPeriod === 'yearly' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBillingPeriod('yearly')}
                  >Ročne <span style={{ fontSize: 11, opacity: 0.85 }}>(ušetríš)</span></button>
                </div>

                {message && (
                  <div style={{
                    padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 14, textAlign: 'center',
                    background: message.type === 'success' ? '#d1fae5' : message.type === 'error' ? '#fee2e2' : '#dbeafe',
                    color: message.type === 'success' ? '#065f46' : message.type === 'error' ? '#991b1b' : '#1e40af'
                  }}>
                    {message.text}
                  </div>
                )}

                {/* Plán karty */}
                <div className="billing-plans-grid">
                  {buyablePlans.map((plan) => {
                    const isCurrent = plan.id === currentPlan;
                    const productId = productIdFor(plan.id, billingPeriod);
                    const storeKitPrice = priceMap[productId]?.price; // lokalizovaná, napr. "9,99 €"
                    const fallbackPrice = billingPeriod === 'yearly' ? plan.price.yearly : plan.price.monthly;
                    const isPurchasingThis = purchasing === productId;

                    return (
                      <div key={plan.id} className={`billing-plan-card ${isCurrent ? 'current' : ''} ${plan.id === 'pro' ? 'featured' : ''}`}>
                        {plan.id === 'pro' && <div className="plan-featured-label">Najpopulárnejší</div>}
                        <h3 className="plan-name">{plan.name}</h3>

                        <div className="plan-price">
                          <span className="plan-price-amount">
                            {storeKitPrice || `${billingPeriod === 'yearly' ? fallbackPrice.toFixed(0) : fallbackPrice.toFixed(2).replace('.', ',')} €`}
                          </span>
                          <span className="plan-price-period"> / {billingPeriod === 'yearly' ? 'rok' : 'mesiac'}</span>
                        </div>

                        <ul className="plan-features">
                          <li>{plan.limits.contacts === -1 ? 'Neobmedzené kontakty' : `${plan.limits.contacts} kontaktov`}</li>
                          <li>{plan.limits.projectsPerContact === -1 ? 'Neobmedzené projekty' : `${plan.limits.projectsPerContact} projektov/kontakt`}</li>
                          <li>{plan.limits.members === -1 ? 'Neobmedzení členovia' : `${plan.limits.members} členov`}</li>
                          {plan.features?.googleCalendarSync && <li>Google Calendar synchronizácia</li>}
                          {plan.features?.googleTasksSync && <li>Google Tasks synchronizácia</li>}
                          {plan.features?.csvExport && <li>Export do CSV</li>}
                          {plan.features?.fileAttachments && (
                            <li>Prílohy súborov ({plan.limits?.fileStorageMb >= 1024 ? `${(plan.limits.fileStorageMb / 1024).toFixed(0)} GB` : `${plan.limits?.fileStorageMb || 0} MB`})</li>
                          )}
                          {plan.features?.prioritySupport && <li>Prioritná podpora (24h SLA)</li>}
                        </ul>

                        <div className="plan-action">
                          {isCurrent ? (
                            <button className="plan-btn current" disabled>Aktuálny plán</button>
                          ) : (
                            <button
                              className={`plan-btn upgrade ${plan.id === 'pro' ? 'pro' : ''}`}
                              onClick={() => handleBuy(plan.id)}
                              disabled={!!purchasing}
                            >
                              {isPurchasingThis ? 'Spracúvam…' : `Vybrať ${plan.name}`}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Restore + legal */}
                <div style={{ textAlign: 'center', marginTop: 24 }}>
                  <button className="btn btn-secondary" style={{ fontSize: 13 }} onClick={handleRestore} disabled={restoring}>
                    {restoring ? 'Obnovujem…' : 'Obnoviť nákupy'}
                  </button>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 480, margin: '16px auto 0' }}>
                    Predplatné sa automaticky obnovuje, kým ho nezrušíš aspoň 24 hodín pred koncom obdobia.
                    Spravovať ho môžeš v Nastaveniach zariadenia. Platba sa účtuje cez tvoj Apple účet.
                  </p>
                  <div style={{ marginTop: 12, fontSize: 11 }}>
                    <a href="/vop" style={{ color: 'var(--text-muted)', marginRight: 16 }}>Obchodné podmienky</a>
                    <a href="/ochrana-udajov" style={{ color: 'var(--text-muted)' }}>Ochrana údajov</a>
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
