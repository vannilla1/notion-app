import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import UserMenu from '../components/UserMenu';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';

function BillingPage() {
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

  const currentPlan = billingStatus?.plan || user?.subscription?.plan || 'free';

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, plansRes] = await Promise.all([
        api.get('/api/billing/status'),
        api.get('/api/billing/plans')
      ]);
      setBillingStatus(statusRes.data);
      setPlans(plansRes.data.plans || []);
    } catch (error) {
      console.error('Failed to fetch billing data:', error);
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
      setSuccessMessage('Platba bola uspesna! Vas plan sa aktivuje.');

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

  const handleCheckout = async (planId, period) => {
    const key = `${planId}-${period}`;
    setCheckoutLoading(key);
    try {
      const res = await api.post('/api/billing/checkout', { plan: planId, period });
      if (res.data.url) {
        window.location.href = res.data.url;
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytvarani platby');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.post('/api/billing/portal');
      if (res.data.url) {
        window.location.href = res.data.url;
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

  const planLabels = { free: 'Free', team: 'Tim', pro: 'Pro' };
  const periodLabels = { monthly: 'mesacne', yearly: 'rocne' };

  if (loading) {
    return (
      <div className="crm-container">
        <header className="crm-header">
          <HeaderLogo />
          <div className="header-actions">
            <WorkspaceSwitcher />
            <UserMenu user={user} onLogout={logout} />
          </div>
        </header>
        <div className="crm-content">
          <main className="crm-main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Nacitavam...
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="crm-container">
      <header className="crm-header">
        <HeaderLogo />
        <div className="header-actions">
          <WorkspaceSwitcher />
          <UserMenu user={user} onLogout={logout} />
        </div>
      </header>

      <div className="crm-content">
        <main className="crm-main">
          <div className="billing-page">

            <div className="billing-header">
              <h2>Predplatne a fakturacia</h2>
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
                <h4>Pomoc — Fakturacia</h4>
                <ul>
                  <li><strong>Free plan</strong> — trvaly, ziadna kreditna karta. 5 kontaktov, 2 clenovia.</li>
                  <li><strong>Tim plan</strong> — 25 kontaktov, 10 clenov, 2 prostredia. Idealne pre male timy.</li>
                  <li><strong>Pro plan</strong> — neobmedzene kontakty, clenovia a prostredia.</li>
                  <li><strong>Rocne predplatne</strong> — usetrite ~17 % oproti mesacnemu.</li>
                  <li><strong>Sprava predplatneho</strong> — cez portal mozete zmenit kartu, stiahnut faktury, alebo zrusit predplatne.</li>
                  <li><strong>Downgrade</strong> — po skonceni predplatneho sa plan zmeni na Free. Existujuce data ostanu, ale vytvaranie noveho obsahu moze byt obmedzene.</li>
                </ul>
                <button className="help-close-btn" onClick={() => setShowHelp(false)}>Zavriet</button>
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
                    ? `Plan aktivny do: ${formatDate(billingStatus.paidUntil)} (nebude sa obnovovat)`
                    : `Dalsie obnovenie: ${formatDate(billingStatus.currentPeriodEnd || billingStatus.paidUntil)}`
                  }
                </p>
              )}

              {billingStatus?.hasSubscription && (
                <button
                  className="billing-manage-btn"
                  onClick={handlePortal}
                  disabled={portalLoading}
                >
                  {portalLoading ? 'Nacitavam...' : 'Spravovat predplatne'}
                </button>
              )}
            </div>

            {/* Period toggle */}
            <div className="billing-period-toggle">
              <button
                className={`period-btn ${billingPeriod === 'monthly' ? 'active' : ''}`}
                onClick={() => setBillingPeriod('monthly')}
              >
                Mesacne
              </button>
              <button
                className={`period-btn ${billingPeriod === 'yearly' ? 'active' : ''}`}
                onClick={() => setBillingPeriod('yearly')}
              >
                Rocne
                <span className="period-save-badge">-17%</span>
              </button>
            </div>

            {/* Plan cards */}
            <div className="billing-plans-grid">
              {plans.map(plan => {
                const isCurrent = plan.id === currentPlan;
                const isDowngrade = (currentPlan === 'pro' && plan.id !== 'pro') ||
                                    (currentPlan === 'team' && plan.id === 'free');
                const price = billingPeriod === 'yearly' ? plan.price.yearly : plan.price.monthly;
                const checkoutKey = `${plan.id}-${billingPeriod}`;

                return (
                  <div key={plan.id} className={`billing-plan-card ${isCurrent ? 'current' : ''} ${plan.id === 'pro' ? 'featured' : ''}`}>
                    {plan.id === 'pro' && <div className="plan-featured-label">Najpopularnejsi</div>}

                    <h3 className="plan-name">{plan.name}</h3>

                    <div className="plan-price">
                      <span className="plan-price-amount">
                        {price === 0 ? 'Zadarmo' : `${billingPeriod === 'yearly' ? (price / 12).toFixed(2) : price.toFixed(2)} \u20AC`}
                      </span>
                      {price > 0 && (
                        <span className="plan-price-period">
                          / mesiac
                          {billingPeriod === 'yearly' && (
                            <span className="plan-price-yearly-total"> ({price.toFixed(0)} \u20AC/rok)</span>
                          )}
                        </span>
                      )}
                    </div>

                    <ul className="plan-features">
                      <li>{plan.limits.contacts === -1 ? 'Neobmedzene kontakty' : `${plan.limits.contacts} kontaktov`}</li>
                      <li>{plan.limits.projectsPerContact === -1 ? 'Neobmedzene projekty' : `${plan.limits.projectsPerContact} projektov/kontakt`}</li>
                      <li>{plan.limits.members === -1 ? 'Neobmedzeni clenovia' : `${plan.limits.members} clenov`}</li>
                      <li>{plan.limits.workspaces === -1 ? 'Neobmedzene prostredia' : `${plan.limits.workspaces === 1 ? '1 prostredie' : `${plan.limits.workspaces} prostredia`}`}</li>
                      {plan.id !== 'free' && <li>Prioritna podpora</li>}
                      {plan.id === 'pro' && <li>Export dat (CSV/Excel)</li>}
                    </ul>

                    <div className="plan-action">
                      {isCurrent ? (
                        <button className="plan-btn current" disabled>
                          Aktualny plan
                        </button>
                      ) : plan.id === 'free' ? (
                        <button className="plan-btn free" disabled>
                          Zakladny plan
                        </button>
                      ) : (
                        <button
                          className={`plan-btn upgrade ${plan.id === 'pro' ? 'pro' : ''}`}
                          onClick={() => handleCheckout(plan.id, billingPeriod)}
                          disabled={checkoutLoading === checkoutKey}
                        >
                          {checkoutLoading === checkoutKey
                            ? 'Presmerovavam...'
                            : isDowngrade
                              ? 'Zmenit plan'
                              : 'Upgradovat'
                          }
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* FAQ */}
            <div className="billing-faq">
              <h3>Caste otazky</h3>
              <details>
                <summary>Ako funguje platba?</summary>
                <p>Platba prebieha bezpecne cez Stripe. Akceptujeme platobne karty (Visa, Mastercard, a dalsie). Po uspesnej platbe sa vas plan okamzite aktivuje.</p>
              </details>
              <details>
                <summary>Mozem kedykolvek zrusit predplatne?</summary>
                <p>Ano, predplatne mozete zrusit kedykolvek cez "Spravovat predplatne". Vas plan zostane aktivny do konca fakturacneho obdobia.</p>
              </details>
              <details>
                <summary>Co sa stane po zruseni predplatneho?</summary>
                <p>Po skonceni aktivneho obdobia sa vas plan zmeni na Free. Vase data ostanu zachovane, ale vytvaranie noveho obsahu moze byt obmedzene podla limitov Free planu.</p>
              </details>
              <details>
                <summary>Mozem zmenit plan alebo fakturacne obdobie?</summary>
                <p>Ano, cez "Spravovat predplatne" mozete zmenit plan, prejst z mesacneho na rocne predplatne, alebo aktualizovat platobnu metodu.</p>
              </details>
              <details>
                <summary>Kde najdem faktury?</summary>
                <p>Vsetky faktury su dostupne v sekcii "Spravovat predplatne" → Fakturacna historia.</p>
              </details>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default BillingPage;
