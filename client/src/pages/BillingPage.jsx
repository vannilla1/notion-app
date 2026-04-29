import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import UserMenu from '../components/UserMenu';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';
import NotificationBell from '../components/NotificationBell';
import { isIosNativeApp } from '../utils/platform';

function BillingPage() {
  // iOS guard — Apple Guideline 3.1.1: žiadne external payment mechanisms (Stripe
  // Checkout/Portal, promo kódy) pre digital subscriptions v iOS appke. Aj keď je
  // tento komponent normálne nedosiahnuteľný cez App.jsx route guard, túto
  // poistku držíme pre prípad deep-link / direct navigation. Redirect na /app
  // (defaultný authenticated landing).
  if (isIosNativeApp()) {
    return <Navigate to="/app" replace />;
  }
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [billingStatus, setBillingStatus] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(null); // 'team-monthly', 'pro-yearly', etc.
  const [portalLoading, setPortalLoading] = useState(false);
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  const [successMessage, setSuccessMessage] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoValidating, setPromoValidating] = useState(false);
  const [promoResult, setPromoResult] = useState(null); // validated promo data
  const [promoError, setPromoError] = useState('');

  const currentPlan = billingStatus?.plan || user?.subscription?.plan || 'free';

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, plansRes] = await Promise.all([
        api.get('/api/billing/status'),
        api.get('/api/billing/plans')
      ]);
      setBillingStatus(statusRes.data);
      setPlans(plansRes.data.plans || []);
    } catch {
      // Silently fail — billing UI shows loading/empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Handle success/cancel redirect from Stripe
  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      const sessionId = searchParams.get('session_id');
      setSuccessMessage('Platba bola úspešná! Váš plán sa aktivuje.');

      // Verify session and refresh status
      if (sessionId) {
        api.get(`/api/billing/verify-session/${sessionId}`)
          .then(() => fetchData())
          .catch(() => {});
      }

      // Refresh user data to get updated plan
      setTimeout(() => {
        api.get('/api/auth/me').then(res => {
          if (res.data) updateUser(res.data);
        }).catch(() => {});
      }, 2000);

      // Clear URL params
      setSearchParams({});
      setTimeout(() => setSuccessMessage(null), 8000);
    }
    if (searchParams.get('canceled') === 'true') {
      setSearchParams({});
    }
  }, [searchParams]); // eslint-disable-line

  // Open URL externally — uses native bridge on iOS, window.open on web
  const openExternal = (url) => {
    if (window.webkit?.messageHandlers?.openExternal) {
      window.webkit.messageHandlers.openExternal.postMessage(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const handleValidatePromo = async () => {
    if (!promoCode.trim()) return;
    setPromoValidating(true);
    setPromoError('');
    setPromoResult(null);
    try {
      const res = await api.post('/api/billing/validate-promo', { code: promoCode.trim() });
      setPromoResult(res.data);
    } catch (error) {
      setPromoError(error.response?.data?.message || 'Neplatný kód');
    } finally {
      setPromoValidating(false);
    }
  };

  const clearPromo = () => {
    setPromoCode('');
    setPromoResult(null);
    setPromoError('');
  };

  const handleCheckout = async (planId, period) => {
    const key = `${planId}-${period}`;
    setCheckoutLoading(key);
    try {
      const body = { plan: planId, period };
      if (promoResult?.valid) {
        body.promoCode = promoResult.code;
      }
      const res = await api.post('/api/billing/checkout', body);
      if (res.data.url) {
        openExternal(res.data.url);
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní platby');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.post('/api/billing/portal');
      if (res.data.url) {
        openExternal(res.data.url);
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba servera');
    } finally {
      setPortalLoading(false);
    }
  };

  const formatDate = (date) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('sk-SK', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  const planLabels = { free: 'Free', team: 'Tím', pro: 'Pro' };
  const periodLabels = { monthly: 'mesačne', yearly: 'ročne' };

  if (loading) {
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
          <main className="crm-main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Načítavam...
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary" onClick={() => navigate('/crm')}>
            Kontakty
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>
            Projekty
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/messages')}>
            Správy
          </button>
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUserUpdate={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <main className="crm-main">
          <div className="billing-page">

            <div className="billing-header">
              <h2>Predplatné a fakturácia</h2>
              <button
                className="help-toggle-btn"
                onClick={() => setShowHelp(!showHelp)}
                title="Pomoc"
              >
                ?
              </button>
            </div>

            {showHelp && (
              <div className="help-tips">
                <h4>Pomoc — Fakturácia</h4>
                <ul>
                  <li><strong>Free plán</strong> — trvalý, žiadna kreditná karta. 5 kontaktov, 2 členovia.</li>
                  <li><strong>Tím plán</strong> — 25 kontaktov, 10 členov, 2 prostredia. Ideálne pre malé tímy.</li>
                  <li><strong>Pro plán</strong> — neobmedzené kontakty, členovia a prostredia.</li>
                  <li><strong>Ročné predplatné</strong> — ušetríte ~17 % oproti mesačnému.</li>
                  <li><strong>Správa predplatného</strong> — cez portál môžete zmeniť kartu, stiahnuť faktúry, alebo zrušiť predplatné.</li>
                  <li><strong>Downgrade</strong> — po skončení predplatného sa plán zmení na Free. Existujúce dáta ostanú, ale vytváranie nového obsahu môže byť obmedzené.</li>
                </ul>
                <button className="help-close-btn" onClick={() => setShowHelp(false)}>Zavrieť</button>
              </div>
            )}

            {successMessage && (
              <div className="billing-success-banner">
                {successMessage}
              </div>
            )}

            {/* Current plan status */}
            <div className="billing-current-plan">
              <div className="billing-plan-badge-row">
                <span className={`billing-plan-badge plan-${currentPlan}`}>
                  {planLabels[currentPlan] || currentPlan}
                </span>
                {billingStatus?.billingPeriod && (
                  <span className="billing-period-label">
                    ({periodLabels[billingStatus.billingPeriod]})
                  </span>
                )}
              </div>

              {billingStatus?.paidUntil && currentPlan !== 'free' && (
                <p className="billing-paid-until">
                  {billingStatus.cancelAtPeriodEnd
                    ? `Plán aktívny do: ${formatDate(billingStatus.paidUntil)} (nebude sa obnovovať)`
                    : `Ďalšie obnovenie: ${formatDate(billingStatus.currentPeriodEnd || billingStatus.paidUntil)}`
                  }
                </p>
              )}

              {billingStatus?.hasSubscription && (
                <button
                  className="billing-manage-btn"
                  onClick={handlePortal}
                  disabled={portalLoading}
                >
                  {portalLoading ? 'Načítavam...' : 'Spravovať predplatné'}
                </button>
              )}
            </div>

            {/* Period toggle */}
            <div className="billing-period-toggle">
              <button
                className={`period-btn ${billingPeriod === 'monthly' ? 'active' : ''}`}
                onClick={() => setBillingPeriod('monthly')}
              >
                Mesačne
              </button>
              <button
                className={`period-btn ${billingPeriod === 'yearly' ? 'active' : ''}`}
                onClick={() => setBillingPeriod('yearly')}
              >
                Ročne
                <span className="period-save-badge">-17%</span>
              </button>
            </div>

            {/* Promo code input */}
            <div className="billing-promo-section">
              {promoResult?.valid ? (
                <div className="promo-applied">
                  <span className="promo-applied-icon">🎟️</span>
                  <span className="promo-applied-text">
                    <strong>{promoResult.code}</strong> — {promoResult.name}
                    {promoResult.type === 'percentage' && ` (${promoResult.value}% zľava)`}
                    {promoResult.type === 'fixed' && ` (${promoResult.value}€ zľava)`}
                    {promoResult.type === 'freeMonths' && ` (${promoResult.value} mesiacov zadarmo)`}
                  </span>
                  <button className="promo-clear-btn" onClick={clearPromo} title="Odstrániť kód">✕</button>
                </div>
              ) : (
                <div className="promo-input-row">
                  <input
                    type="text"
                    className="promo-input"
                    placeholder="Zadajte promo kód"
                    value={promoCode}
                    onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleValidatePromo()}
                    disabled={promoValidating}
                    style={{ textTransform: 'uppercase', fontFamily: 'monospace' }}
                  />
                  <button
                    className="btn btn-secondary promo-apply-btn"
                    onClick={handleValidatePromo}
                    disabled={promoValidating || !promoCode.trim()}
                  >
                    {promoValidating ? 'Overujem...' : 'Použiť'}
                  </button>
                </div>
              )}
              {promoError && <div className="promo-error">{promoError}</div>}
            </div>

            {/* Plan cards */}
            <div className="billing-plans-grid">
              {plans.map(plan => {
                const isCurrent = plan.id === currentPlan;
                const isDowngrade = (currentPlan === 'pro' && plan.id !== 'pro') ||
                                    (currentPlan === 'team' && plan.id === 'free');
                const price = billingPeriod === 'yearly' ? plan.price.yearly : plan.price.monthly;
                const checkoutKey = `${plan.id}-${billingPeriod}`;

                // Calculate discounted price if promo code is applied
                const promoDiscount = promoResult?.valid && promoResult.discountPreview?.[plan.id]?.[billingPeriod];
                const finalPrice = promoDiscount ? promoDiscount.finalPrice : price;

                return (
                  <div key={plan.id} className={`billing-plan-card ${isCurrent ? 'current' : ''} ${plan.id === 'pro' ? 'featured' : ''}`}>
                    {plan.id === 'pro' && <div className="plan-featured-label">Najpopulárnejší</div>}

                    <h3 className="plan-name">{plan.name}</h3>

                    <div className="plan-price">
                      {price === 0 ? (
                        <span className="plan-price-amount">Zadarmo</span>
                      ) : billingPeriod === 'yearly' ? (
                        <>
                          {promoDiscount && promoDiscount.finalPrice !== price ? (
                            <>
                              <span className="plan-price-original">{price.toFixed(0)} €</span>
                              <span className="plan-price-amount plan-price-discounted">{finalPrice.toFixed(0)} €</span>
                            </>
                          ) : (
                            <span className="plan-price-amount">{price.toFixed(0)} €</span>
                          )}
                          <span className="plan-price-period"> / rok</span>
                          {promoDiscount && promoDiscount.freeMonths ? (
                            <span className="plan-price-yearly-detail promo-free-months">+ {promoDiscount.freeMonths} mesiacov zadarmo</span>
                          ) : (
                            <span className="plan-price-yearly-detail">tj. {(finalPrice / 12).toFixed(2).replace('.', ',')} € / mesiac</span>
                          )}
                        </>
                      ) : (
                        <>
                          {promoDiscount && promoDiscount.finalPrice !== price ? (
                            <>
                              <span className="plan-price-original">{price.toFixed(2).replace('.', ',')} €</span>
                              <span className="plan-price-amount plan-price-discounted">{finalPrice.toFixed(2).replace('.', ',')} €</span>
                            </>
                          ) : (
                            <span className="plan-price-amount">{price.toFixed(2).replace('.', ',')} €</span>
                          )}
                          <span className="plan-price-period"> / mesiac</span>
                          {promoDiscount?.freeMonths && (
                            <span className="plan-price-yearly-detail promo-free-months">+ {promoDiscount.freeMonths} mesiacov zadarmo</span>
                          )}
                        </>
                      )}
                    </div>

                    <ul className="plan-features">
                      <li>{plan.limits.contacts === -1 ? 'Neobmedzené kontakty' : `${plan.limits.contacts} kontaktov`}</li>
                      <li>{plan.limits.projectsPerContact === -1 ? 'Neobmedzené projekty' : `${plan.limits.projectsPerContact} projektov/kontakt`}</li>
                      <li>{plan.limits.members === -1 ? 'Neobmedzení členovia' : `${plan.limits.members} členov`}</li>
                      <li>{plan.limits.workspaces === -1 ? 'Neobmedzené prostredia' : `${plan.limits.workspaces === 1 ? '1 prostredie' : `${plan.limits.workspaces} prostredia`}`}</li>
                      {plan.id !== 'free' && <li>Prioritná podpora</li>}
                      {plan.id === 'pro' && <li>Export dát (CSV/Excel)</li>}
                    </ul>

                    <div className="plan-action">
                      {isCurrent ? (
                        <button className="plan-btn current" disabled>
                          Aktuálny plán
                        </button>
                      ) : plan.id === 'free' ? (
                        <button className="plan-btn free" disabled>
                          Základný plán
                        </button>
                      ) : (
                        <button
                          className={`plan-btn upgrade ${plan.id === 'pro' ? 'pro' : ''}`}
                          onClick={() => handleCheckout(plan.id, billingPeriod)}
                          disabled={checkoutLoading === checkoutKey}
                        >
                          {checkoutLoading === checkoutKey
                            ? 'Presmerovávam...'
                            : isDowngrade
                              ? 'Zmeniť plán'
                              : 'Upgradovať'
                          }
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="billing-vat-note">Všetky ceny sú uvedené s DPH.</p>

            {/* FAQ */}
            <div className="billing-faq">
              <h3>Časté otázky</h3>
              <details>
                <summary>Ako funguje platba?</summary>
                <p>Platba prebieha bezpečne cez Stripe. Akceptujeme platobné karty (Visa, Mastercard a ďalšie). Po úspešnej platbe sa váš plán okamžite aktivuje.</p>
              </details>
              <details>
                <summary>Môžem kedykoľvek zrušiť predplatné?</summary>
                <p>Áno, predplatné môžete zrušiť kedykoľvek cez „Spravovať predplatné". Váš plán zostane aktívny do konca fakturačného obdobia.</p>
              </details>
              <details>
                <summary>Čo sa stane po zrušení predplatného?</summary>
                <p>Po skončení aktívneho obdobia sa váš plán zmení na Free. Vaše dáta ostanú zachované, ale vytváranie nového obsahu môže byť obmedzené podľa limitov Free plánu.</p>
              </details>
              <details>
                <summary>Môžem zmeniť plán alebo fakturačné obdobie?</summary>
                <p>Áno, cez „Spravovať predplatné" môžete zmeniť plán, prejsť z mesačného na ročné predplatné, alebo aktualizovať platobnú metódu.</p>
              </details>
              <details>
                <summary>Kde nájdem faktúry?</summary>
                <p>Všetky faktúry sú dostupné v sekcii „Spravovať predplatné" → Fakturačná história.</p>
              </details>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default BillingPage;
