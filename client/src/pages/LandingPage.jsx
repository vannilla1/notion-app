import { useState, useEffect } from 'react';
import api from '@/api/api';
import { isIosNativeApp } from '@/utils/platform';
import { trackEvent } from '@/utils/analytics';
import CookieConsent, { CookieSettingsLink } from '@/components/CookieConsent';
import './LandingPage.css';

export default function LandingPage() {
  const [isYearly, setIsYearly] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [contactForm, setContactForm] = useState({ name: '', email: '', message: '' });
  const [contactStatus, setContactStatus] = useState(null); // 'sending' | 'success' | 'error'
  const [contactError, setContactError] = useState('');

  const handleContactSubmit = async (e) => {
    e.preventDefault();
    setContactStatus('sending');
    setContactError('');
    try {
      await api.post('/api/contact-form', contactForm);
      setContactStatus('success');
      setContactForm({ name: '', email: '', message: '' });
    } catch (err) {
      setContactStatus('error');
      setContactError(err.response?.data?.message || 'Nepodarilo sa odoslať správu.');
    }
  };

  // SEO: Set page-specific meta tags
  useEffect(() => {
    document.title = 'Prpl CRM — Jednoduchý CRM systém pre správu kontaktov, projektov a tímov';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute('content', 'Prpl CRM je moderný a jednoduchý CRM systém pre správu kontaktov, projektov a tímovej spolupráce. Zadarmo na vyskúšanie, s mobilnou aplikáciou pre iOS a Android. Synchronizácia s Google Tasks.');
    }
    // Restore on unmount (when navigating to app)
    return () => {
      document.title = 'Prpl CRM';
    };
  }, []);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollTo = (id) => {
    setMobileMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="lp-page" itemScope itemType="https://schema.org/WebPage">
      {/* Navbar */}
      <nav className={`lp-navbar ${scrolled ? 'scrolled' : ''}`}>
        <div className="lp-navbar-inner">
          <a href="#" className="lp-logo" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <img src="/icons/icon-96x96.png" alt="Prpl CRM — jednoduchý CRM pre malé firmy" width="32" height="32" style={{ borderRadius: '8px' }} />
            Prpl CRM
          </a>

          <ul className="lp-nav-links">
            <li><a href="#funkcie" onClick={(e) => { e.preventDefault(); scrollTo('funkcie'); }}>Funkcie</a></li>
            <li><a href="#cennik" onClick={(e) => { e.preventDefault(); scrollTo('cennik'); }}>Cenník</a></li>
            <li><a href="#faq" onClick={(e) => { e.preventDefault(); scrollTo('faq'); }}>Časté otázky</a></li>
            <li><a href="#stiahnut" onClick={(e) => { e.preventDefault(); scrollTo('stiahnut'); }}>Stiahnuť</a></li>
            {!isIosNativeApp() && (
              <li><a href="#affiliate" onClick={(e) => { e.preventDefault(); scrollTo('affiliate'); }}>Affiliate</a></li>
            )}
            <li><a href="#kontakt" onClick={(e) => { e.preventDefault(); scrollTo('kontakt'); }}>Kontakt</a></li>
          </ul>

          <a href="/login" target="_blank" rel="noopener noreferrer" className="lp-nav-cta desktop-only">Prihlásiť sa</a>

          <button className="lp-hamburger" onClick={() => setMobileMenuOpen(true)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      <div className={`lp-mobile-menu ${mobileMenuOpen ? 'open' : ''}`} onClick={() => setMobileMenuOpen(false)}>
        <div className="lp-mobile-menu-content" onClick={(e) => e.stopPropagation()}>
          <button className="lp-mobile-close" onClick={() => setMobileMenuOpen(false)}>&times;</button>
          <a href="#funkcie" onClick={(e) => { e.preventDefault(); scrollTo('funkcie'); }}>Funkcie</a>
          <a href="#cennik" onClick={(e) => { e.preventDefault(); scrollTo('cennik'); }}>Cenník</a>
          <a href="#faq" onClick={(e) => { e.preventDefault(); scrollTo('faq'); }}>Časté otázky</a>
          <a href="#stiahnut" onClick={(e) => { e.preventDefault(); scrollTo('stiahnut'); }}>Stiahnuť</a>
          {!isIosNativeApp() && (
            <a href="#affiliate" onClick={(e) => { e.preventDefault(); scrollTo('affiliate'); }}>Affiliate</a>
          )}
          <a href="#kontakt" onClick={(e) => { e.preventDefault(); scrollTo('kontakt'); }}>Kontakt</a>
          <a href="/login" target="_blank" rel="noopener noreferrer" className="lp-mobile-cta" onClick={() => setMobileMenuOpen(false)}>Prihlásiť sa</a>
        </div>
      </div>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-bg-shape" />
        <div className="lp-hero-bg-shape" />
        <div className="lp-hero-bg-shape" />

        <div className="lp-hero-content">
          <div className="lp-hero-badge">
            <span>&#10024;</span> Zadarmo, navždy — bez platobnej karty
          </div>
          <h1 className="lp-hero-title">
            Jednoduchý CRM pre malé firmy<br />a živnostníkov
          </h1>
          <p className="lp-hero-subtitle">
            Spravujte kontakty, projekty a úlohy na jednom mieste — celý v slovenčine.
            Moderný CRM systém pre malé tímy: jednoduchý, rýchly a vždy po ruke.
          </p>
          <div className="lp-hero-buttons">
            <a href="/login?register=true" target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-white" onClick={() => trackEvent('cta_register', { location: 'hero' })}>Vyskúšajte zadarmo</a>
            <a href="/login" target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-outline" onClick={() => trackEvent('cta_login', { location: 'hero' })}>Prihlásiť sa</a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="lp-features" id="funkcie">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Všetko čo potrebujete</h2>
            <p className="lp-section-subtitle">
              Prpl CRM — jednoduchý CRM pre malé firmy, živnostníkov a tímy — vám pomôže
              organizovať kontakty, projekty a úlohy na jednom mieste, celý v slovenčine
            </p>
          </div>

          <div className="lp-features-grid">
            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-contacts">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Správa kontaktov</h3>
              <p className="lp-feature-desc">
                Prehľadná evidencia všetkých kontaktov s možnosťou kategorizácie, poznámok a rýchleho vyhľadávania.
              </p>
            </div>

            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-tasks">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Projekty a úlohy</h3>
              <p className="lp-feature-desc">
                Vytvárajte projekty, pridávajte úlohy, nastavujte termíny a sledujte priebeh plnenia.
              </p>
            </div>

            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-sync">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6" /><path d="M2.5 22v-6h6" /><path d="M2 11.5a10 10 0 0 1 18.8-4.3" /><path d="M22 12.5a10 10 0 0 1-18.8 4.2" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Google Tasks sync</h3>
              <p className="lp-feature-desc">
                Prepojte svoje Google projekty a majte všetko synchronizované na jednom mieste v reálnom čase.
              </p>
            </div>

            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-notifications">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Push notifikácie</h3>
              <p className="lp-feature-desc">
                Dostanete upozornenie na zmeny, termíny a aktivity v reálnom čase priamo do zariadenia.
              </p>
            </div>

            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-team">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Tímová spolupráca</h3>
              <p className="lp-feature-desc">
                Pracujte spoločne v zdieľaných pracovných priestoroch s okamžitou synchronizáciou dát.
              </p>
            </div>

            <div className="lp-feature-card">
              <div className="lp-feature-icon lp-feature-icon-mobile">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" />
                </svg>
              </div>
              <h3 className="lp-feature-title">Mobilná aplikácia</h3>
              <p className="lp-feature-desc">
                {isIosNativeApp()
                  ? 'Pristupujte k CRM odkiaľkoľvek — natívna iOS aplikácia vždy po ruke.'
                  : 'Pristupujte k CRM odkiaľkoľvek — natívna aplikácia pre Android aj iOS vždy po ruke.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pre koho — keyword-rich sekcia s personami (SEO: "CRM pre malé firmy",
          "CRM pre živnostníkov", "slovenský CRM"). Bez cien → zobrazené aj v iOS. */}
      <section className="lp-features" id="pre-koho">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Pre koho je Prpl CRM</h2>
            <p className="lp-section-subtitle">
              Navrhnutý pre malé firmy, živnostníkov a tímy, ktorí chcú mať klientov,
              projekty a úlohy pod kontrolou — bez zložitého nastavovania
            </p>
          </div>

          <div className="lp-features-grid">
            <div className="lp-feature-card">
              <h3 className="lp-feature-title">Živnostníci a freelanceri</h3>
              <p className="lp-feature-desc">
                CRM pre živnostníka: majte klientov, zákazky a úlohy prehľadne na jednom
                mieste — v mobile aj na webe, celý v slovenčine.
              </p>
            </div>

            <div className="lp-feature-card">
              <h3 className="lp-feature-title">Malé firmy a tímy</h3>
              <p className="lp-feature-desc">
                CRM pre malé firmy: zdieľané pracovné prostredie, tímová spolupráca
                a spoločná správa kontaktov, projektov a úloh.
              </p>
            </div>

            <div className="lp-feature-card">
              <h3 className="lp-feature-title">Obchod a služby</h3>
              <p className="lp-feature-desc">
                Sledujte kontakty, pripomienky a rozpracované projekty na jednom mieste.
                Jednoduchý slovenský CRM systém, ktorý zvládnete za pár minút.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — skryté v iOS native shell-e (Apple Guideline 3.1.1).
          Web verzia ho ďalej zobrazuje normálne. Po skrytí v iOS appke nie
          je odkaz "cennik" v navigácii dosiahnuteľný, čo je OK — Apple si
          nepraje žiadne references na external payment / pricing pre
          digital subscriptions konzumované v iOS appke. */}
      {!isIosNativeApp() && (
      <section className="lp-pricing" id="cennik">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Jednoduchý cenník</h2>
            <p className="lp-section-subtitle">
              Začnite zadarmo, upgradujte kedykoľvek
            </p>
          </div>

          <div className="lp-pricing-toggle">
            <button
              className={`lp-pricing-toggle-btn ${!isYearly ? 'active' : ''}`}
              onClick={() => setIsYearly(false)}
            >
              Mesačne
            </button>
            <button
              className={`lp-pricing-toggle-btn ${isYearly ? 'active' : ''}`}
              onClick={() => setIsYearly(true)}
            >
              Ročne
              <span className="lp-pricing-save">-17%</span>
            </button>
          </div>

          {/* Helper SVG components — extracting do mini funkcií zníži duplicitu
              z ~70 SVG inline výskytov v 3 kartách na 3 spoločné helpre. */}
          {(() => null)()}

          <div className="lp-pricing-cards">
            {/* Free */}
            <div className="lp-pricing-card">
              <h3 className="lp-pricing-name">Free</h3>
              <p className="lp-pricing-desc">Pre solo testovanie a osobné použitie</p>

              <div className="lp-pricing-price">
                <span className="lp-pricing-amount">0 €</span>
              </div>
              <p className="lp-pricing-yearly-note" style={{ color: '#64748b' }}>Zadarmo navždy. Bez platobnej karty.</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 5 kontaktov</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 5 projektov / kontakt</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 10 podúloh / projekt</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>2 používatelia</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>1 pracovné prostredie</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Push notifikácie</li>
                <li style={{ color: '#94a3b8' }}><span className="lp-pricing-check" style={{ background: '#f1f5f9', color: '#94a3b8' }}><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></span>Bez Google Calendar / Tasks sync</li>
                <li style={{ color: '#94a3b8' }}><span className="lp-pricing-check" style={{ background: '#f1f5f9', color: '#94a3b8' }}><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></span>Bez exportu do CSV</li>
                <li style={{ color: '#94a3b8' }}><span className="lp-pricing-check" style={{ background: '#f1f5f9', color: '#94a3b8' }}><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></span>Bez príloh súborov</li>
              </ul>

              <a href="/login?register=true" target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-secondary lp-pricing-cta" onClick={() => trackEvent('cta_register', { location: 'pricing_free' })}>
                Začať zadarmo
              </a>
            </div>

            {/* Tím */}
            <div className="lp-pricing-card">
              <h3 className="lp-pricing-name">Tím</h3>
              <p className="lp-pricing-desc">Pre malé tímy a firmy</p>

              <div className="lp-pricing-price">
                <span className="lp-pricing-amount">{isYearly ? '49 €' : '4,99 €'}</span>
                <span className="lp-pricing-period">/ {isYearly ? 'rok' : 'mesiac'}</span>
              </div>
              {isYearly && (
                <p className="lp-pricing-yearly-note">tj. 4,08 € / mesiac</p>
              )}
              {!isYearly && (
                <p className="lp-pricing-yearly-note" style={{ color: '#64748b' }}>alebo <strong style={{ color: '#6366f1', fontWeight: 700 }}>49 € ročne</strong> (<strong style={{ color: '#10B981', fontWeight: 700 }}>ušetríte 18%</strong>)</p>
              )}
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>Cena za celý plán — obsahuje až 10 členov bez doplatku.</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Všetko z Free,</strong> plus:</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 25 kontaktov</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 25 projektov / kontakt</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Max. 25 podúloh / projekt</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Až 10 členov tímu</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>2 pracovné prostredia</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Google Calendar synchronizácia</strong></li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Google Tasks synchronizácia</strong></li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Export do CSV</strong></li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Prílohy súborov (1&nbsp;GB)</strong></li>
              </ul>

              <a href="/login?register=true" target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-secondary lp-pricing-cta" onClick={() => trackEvent('cta_register', { location: 'pricing_tim' })}>
                Začať s Tímom
              </a>
            </div>

            {/* Pro */}
            <div className="lp-pricing-card featured">
              <span className="lp-pricing-badge">Odporúčané</span>
              <h3 className="lp-pricing-name">Pro</h3>
              <p className="lp-pricing-desc">Pre profesionálov a veľké tímy</p>

              <div className="lp-pricing-price">
                <span className="lp-pricing-amount">{isYearly ? '99 €' : '9,99 €'}</span>
                <span className="lp-pricing-period">/ {isYearly ? 'rok' : 'mesiac'}</span>
              </div>
              {isYearly && (
                <p className="lp-pricing-yearly-note">tj. 8,25 € / mesiac</p>
              )}
              {!isYearly && (
                <p className="lp-pricing-yearly-note" style={{ color: '#64748b' }}>alebo <strong style={{ color: '#6366f1', fontWeight: 700 }}>99 € ročne</strong> (<strong style={{ color: '#10B981', fontWeight: 700 }}>ušetríte 17%</strong>)</p>
              )}
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>Cena za celý plán — bez obmedzenia členov.</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Všetko z Tímu,</strong> plus:</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Neobmedzený počet kontaktov</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Neobmedzené projekty a podúlohy</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Neobmedzený počet členov tímu</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Neobmedzené pracovné prostredia</li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Prílohy súborov (10&nbsp;GB)</strong></li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><strong>Prioritná podpora (24h&nbsp;SLA)</strong></li>
                <li><span className="lp-pricing-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Skorý prístup k novým funkciám</li>
              </ul>

              <a href="/login?register=true" target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-primary lp-pricing-cta" onClick={() => trackEvent('cta_register', { location: 'pricing_pro' })}>
                Začať s Pro
              </a>
            </div>
          </div>

          <p style={{ textAlign: 'center', fontSize: '13px', color: '#94a3b8', marginTop: '24px' }}>
            Všetky ceny sú vrátane DPH.
          </p>
        </div>
      </section>
      )}

      {/* FAQ — skryté v iOS shell-e (FAQ obsahuje detailný popis všetkých
          plánov, cien a upgrade/downgrade flow → Apple Guideline 3.1.1). */}
      {!isIosNativeApp() && (
      <section className="lp-faq" id="faq">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Časté otázky</h2>
            <p className="lp-section-subtitle">
              Všetko, čo potrebujete vedieť o Prpl CRM
            </p>
          </div>

          <div className="lp-faq-list">
            <details className="lp-faq-item">
              <summary>Čo je Prpl CRM?</summary>
              <p>Prpl CRM je moderný slovenský CRM systém pre správu kontaktov, projektov a tímovej spolupráce. Ponúka bezplatný plán, mobilnú aplikáciu pre iOS a Android, synchronizáciu s Google Calendar a Tasks a push notifikácie.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Aký CRM systém je najlepší pre malé firmy a živnostníkov na Slovensku?</summary>
              <p>Prpl CRM je jednoduchý slovenský CRM systém navrhnutý pre malé firmy a živnostníkov. Ponúka bezplatný plán, správu kontaktov, projektov a úloh, tímovú spoluprácu, Google sync a mobilné aplikácie — bez zložitej konfigurácie a celý v slovenčine.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Má Prpl CRM mobilnú aplikáciu?</summary>
              <p>Áno, Prpl CRM má natívnu mobilnú aplikáciu pre iOS (s podporou Face ID) aj pre Android. Všetky dáta sa synchronizujú v reálnom čase medzi zariadeniami.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Koľko stojí Prpl CRM?</summary>
              <p>Prpl CRM má 3 plány: <strong>Free</strong> (0 € navždy), <strong>Tím</strong> (4,99 €/mesiac alebo 49 €/rok) a <strong>Pro</strong> (9,99 €/mesiac alebo 99 €/rok). Všetky ceny sú vrátane DPH. Free plán je bez časového obmedzenia a bez platobnej karty.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Čo je pracovné prostredie (workspace)?</summary>
              <p>Pracovné prostredie je zdieľaný priestor, kde tím spolupracuje na kontaktoch, projektoch a úlohách. Každé prostredie má vlastné dáta, členov a nastavenia. Zakladateľ prostredia určuje jeho limity podľa svojho plánu.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Ako fungujú limity používateľov v pracovnom prostredí?</summary>
              <p>Limity sa riadia podľa plánu <strong>zakladateľa</strong> (vlastníka) pracovného prostredia:</p>
              <ul>
                <li><strong>Free:</strong> max. 2 používatelia</li>
                <li><strong>Tím:</strong> max. 10 používateľov</li>
                <li><strong>Pro:</strong> neobmedzený počet používateľov</li>
              </ul>
              <p>Plán členov, ktorí sa pripájajú, neovplyvňuje kapacitu — rozhoduje vždy plán vlastníka.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Môžem sa pripojiť do workspace s vyšším plánom, ak mám Free účet?</summary>
              <p>Áno. Ak vás vlastník s plánom Tím alebo Pro pozve do svojho prostredia, pripojíte sa bez obmedzení. Váš Free plán ovplyvňuje len prostredia, ktoré <strong>vy</strong> vytvoríte.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Čo sa stane, ak vlastník downgraduje svoj plán?</summary>
              <p>Ak vlastník prejde na nižší plán a počet členov prekračuje nový limit, pracovné prostredie sa prepne do <strong>režimu len na čítanie</strong>. Existujúce dáta zostanú zachované, ale vytváranie nových kontaktov, projektov a úloh bude zablokované, kým vlastník neupgraduje späť alebo neodstráni členov pod limit.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Koľko pracovných prostredí môžem vytvoriť?</summary>
              <p>Závisí od vášho plánu:</p>
              <ul>
                <li><strong>Free:</strong> 1 pracovné prostredie</li>
                <li><strong>Tím:</strong> 2 pracovné prostredia</li>
                <li><strong>Pro:</strong> neobmedzený počet</li>
              </ul>
            </details>

            <details className="lp-faq-item">
              <summary>Je Free plán naozaj zadarmo navždy?</summary>
              <p>Áno. Free plán je trvalý, bez časového obmedzenia a bez nutnosti zadávať platobnú kartu. Môžete ho používať tak dlho, ako chcete.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Môžem kedykoľvek upgradovať alebo downgradovať?</summary>
              <p>Áno. Plán môžete zmeniť kedykoľvek. Pri upgrade sa nové limity prejavia okamžite. Pri downgrade sa existujúce dáta zachovajú, ale ak prekročíte limity nového plánu, vytváranie nového obsahu bude obmedzené.</p>
            </details>

            <details className="lp-faq-item">
              <summary>Funguje synchronizácia s Google Calendar a Google Tasks?</summary>
              <p>Áno, vo všetkých plánoch vrátane Free. Synchronizácia je obojsmerná a v reálnom čase — zmeny v Prpl CRM sa prejavia v Google a naopak.</p>
            </details>
          </div>
        </div>
      </section>
      )}

      {/* Download */}
      <section className="lp-download" id="stiahnut">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Stiahnite si Prpl CRM</h2>
            <p className="lp-section-subtitle">
              Natívna aplikácia pre váš telefón — vždy po ruke
            </p>
          </div>

          <div className="lp-download-badges">
            {/* App Store — appka je LIVE (1.0.8+). Aktívny odkaz na App Store
                stránku. Zobrazujeme všade (App Store nie je konkurenčná
                platforma voči iOS binárke, takže Guideline 2.3.10 sa netýka). */}
            <a
              href="https://apps.apple.com/app/prpl-crm/id6761299370"
              className="lp-badge"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent('app_store_click', { location: 'download' })}
              aria-label="Stiahnuť Prpl CRM v App Store"
            >
              <span className="lp-badge-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 21.99 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 21.99C7.79 22.03 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.28 4.83C10.56 4.81 11.78 5.7 12.57 5.7C13.36 5.7 14.85 4.62 16.4 4.8C17.05 4.83 18.89 5.08 20.07 6.8C19.96 6.87 17.62 8.23 17.65 11.1C17.68 14.53 20.55 15.69 20.58 15.7C20.56 15.77 20.12 17.35 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" />
                </svg>
              </span>
              <span className="lp-badge-text">
                <span className="lp-badge-label">Dostupné na</span>
                <span className="lp-badge-store">App Store</span>
              </span>
            </a>

            {/* Google Play badge skrytý v iOS native shell-e — Apple
                Guideline 2.3.10 zakazuje references na konkurenčné platformy
                v iOS binary. Web verzia (Safari, Chrome desktop, Android web)
                ho ďalej zobrazuje. */}
            {!isIosNativeApp() && (
              <a
                href="https://play.google.com/store/apps/details?id=eu.prplcrm.app"
                className="lp-badge"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackEvent('google_play_click', { location: 'download' })}
                aria-label="Stiahnuť Prpl CRM na Google Play"
              >
                <span className="lp-badge-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                    <path d="M3.18 23.68C2.76 23.48 2.5 23.05 2.5 22.5V1.5C2.5 0.95 2.76 0.52 3.18 0.32L13.04 11.5L3.18 23.68ZM16.68 15.32L5.4 22.34L14.14 12.78L16.68 15.32ZM20.4 10.36C20.82 10.64 21.1 11.06 21.1 11.5C21.1 11.94 20.82 12.36 20.48 12.58L18.1 13.94L15.3 11.5L18.1 9.06L20.4 10.36ZM5.4 0.66L16.68 7.68L14.14 10.22L5.4 0.66Z" />
                  </svg>
                </span>
                <span className="lp-badge-text">
                  <span className="lp-badge-label">Dostupné na</span>
                  <span className="lp-badge-store">Google Play</span>
                </span>
              </a>
            )}
          </div>
        </div>
      </section>

      {/* Affiliate program — skryté v iOS native shell-e (sekcia hovorí
          o províziach a externom payout-e na IBAN, čo môže byť pre Apple
          review citlivé). Web verzia ho ďalej zobrazuje. */}
      {!isIosNativeApp() && (
      <section className="lp-affiliate" id="affiliate">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Zarábajte s Prpl CRM &mdash; affiliate program</h2>
            <p className="lp-section-subtitle">
              Odporučte Prpl CRM ďalším firmám a dostávajte recurring proviziu z každej ich platby
            </p>
          </div>

          <div className="lp-affiliate-grid">
            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#EEF2FF' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">Recurring provízia</h3>
              <p className="lp-affiliate-desc">
                Dostávate <strong>10&nbsp;%</strong> (alebo dohodnuté %) z <em>každej</em> platby
                používateľa, ktorý sa zaregistroval pod vaším kódom. Mesiac za mesiacom, rok za rokom.
              </p>
            </div>

            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#F0FDF4' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">Výplata na IBAN</h3>
              <p className="lp-affiliate-desc">
                Bez zbytočnej byrokracie. Stačí nám zadať IBAN a banku. Vyplácame mesačne &mdash;
                minimálna suma na výplatu je <strong>20&nbsp;€</strong>.
              </p>
            </div>

            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#FEF3C7' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">30-dňová ochranná doba</h3>
              <p className="lp-affiliate-desc">
                Provízia sa stáva nárokovateľnou až po 30&nbsp;dňoch od platby (pre prípad refundu).
                Potom je vaša, navždy.
              </p>
            </div>

            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#FEE2E2' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">Bez zmluvy a záväzku</h3>
              <p className="lp-affiliate-desc">
                Nepotrebujete živnosť ani zmluvu. Stačí dohoda emailom. Účet v&nbsp;Prpl&nbsp;CRM
                tiež nie je podmienkou &mdash; affiliate môže byť ktokoľvek.
              </p>
            </div>

            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#E0E7FF' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">Vlastný unikátny kód</h3>
              <p className="lp-affiliate-desc">
                Každý affiliate dostane vlastný zľavový kód (napr. <code>JANKO20</code>),
                ktorý zároveň dáva vašim odporúčaniam <strong>zľavu</strong> pri registrácii.
              </p>
            </div>

            <div className="lp-affiliate-card">
              <div className="lp-affiliate-icon" style={{ background: '#F3E8FF' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
                </svg>
              </div>
              <h3 className="lp-affiliate-title">Affiliate dashboard</h3>
              <p className="lp-affiliate-desc">
                Ak máte účet v Prpl CRM, vidíte v aplikácii prehľad zarobených provízií,
                históriu výplat a stav každej platby pod vaším kódom.
              </p>
            </div>
          </div>

          {/* Ako sa prihlásiť — 3 kroky */}
          <div className="lp-affiliate-howto">
            <h3 className="lp-affiliate-howto-title">Ako sa prihlásiť do programu</h3>
            <div className="lp-affiliate-steps">
              <div className="lp-affiliate-step">
                <div className="lp-affiliate-step-num">1</div>
                <h4>Napíšte nám email</h4>
                <p>
                  Pošlite správu na <a href="mailto:support@prplcrm.eu?subject=Affiliate%20program%20%E2%80%94%20mám%20záujem" className="lp-affiliate-link"><strong>support@prplcrm.eu</strong></a> s&nbsp;predmetom
                  &bdquo;Affiliate program&ldquo;. Stačí krátka veta o&nbsp;tom, kto ste
                  a&nbsp;komu by ste Prpl&nbsp;CRM odporúčali.
                </p>
              </div>
              <div className="lp-affiliate-step">
                <div className="lp-affiliate-step-num">2</div>
                <h4>Dohodneme detaily</h4>
                <p>
                  Odpovieme do <strong>24&nbsp;hodín</strong>. Dohodneme proviznú sadzbu
                  (štandardne 10&nbsp;%) a&nbsp;tvar vášho zľavového kódu. Pošlete nám IBAN
                  pre výplaty.
                </p>
              </div>
              <div className="lp-affiliate-step">
                <div className="lp-affiliate-step-num">3</div>
                <h4>Začnete zarábať</h4>
                <p>
                  Aktivujeme vám kód, dáme vám propagačné materiály a&nbsp;každá platba pod
                  vaším kódom vám generuje <strong>recurring proviziu</strong> &mdash;
                  automaticky, navždy.
                </p>
              </div>
            </div>

            <div className="lp-affiliate-cta">
              <a
                href="mailto:support@prplcrm.eu?subject=Affiliate%20program%20%E2%80%94%20mám%20záujem&body=Dobrý%20deň%2C%0A%0Amám%20záujem%20o%20zapojenie%20do%20affiliate%20programu%20Prpl%20CRM.%0A%0AKto%20som%3A%20%0AKomu%20by%20som%20rád%20odporúčal%3A%20%0A%0AĎakujem!"
                className="lp-btn lp-btn-primary"
                style={{ fontSize: '15px', padding: '14px 32px' }}
              >
                Chcem sa pridať &rarr;
              </a>
              <p className="lp-affiliate-cta-note">
                Alebo nám napíšte cez <a href="#kontakt" onClick={(e) => { e.preventDefault(); scrollTo('kontakt'); }}>kontaktný formulár</a> nižšie.
              </p>
            </div>
          </div>
        </div>
      </section>
      )}

      {/* Contact */}
      <section className="lp-contact" id="kontakt">
        <div className="lp-section">
          <div className="lp-section-header">
            <span className="lp-section-accent" />
            <h2 className="lp-section-title">Kontaktujte nás</h2>
            <p className="lp-section-subtitle">
              Máte otázku alebo návrh? Napíšte nám.
            </p>
          </div>

          <div className="lp-contact-grid">
            <div className="lp-contact-info">
              <div className="lp-contact-card">
                <div className="lp-contact-icon">&#9993;</div>
                <h3>Email</h3>
                <a href="mailto:support@prplcrm.eu" className="lp-contact-link">support@prplcrm.eu</a>
              </div>
              <div className="lp-contact-card">
                <div className="lp-contact-icon">&#128172;</div>
                <h3>Podpora</h3>
                <p>Odpovieme do 24 hodín v pracovných dňoch.</p>
              </div>
            </div>

            <form className="lp-contact-form" onSubmit={handleContactSubmit}>
              <div className="lp-form-group">
                <label htmlFor="contact-name">Meno</label>
                <input
                  id="contact-name"
                  type="text"
                  required
                  maxLength={100}
                  value={contactForm.name}
                  onChange={(e) => setContactForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Vaše meno"
                />
              </div>
              <div className="lp-form-group">
                <label htmlFor="contact-email">Email</label>
                <input
                  id="contact-email"
                  type="email"
                  required
                  maxLength={200}
                  value={contactForm.email}
                  onChange={(e) => setContactForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="vas@email.com"
                />
              </div>
              <div className="lp-form-group">
                <label htmlFor="contact-message">Správa</label>
                <textarea
                  id="contact-message"
                  required
                  maxLength={5000}
                  rows={5}
                  value={contactForm.message}
                  onChange={(e) => setContactForm(f => ({ ...f, message: e.target.value }))}
                  placeholder="Napíšte nám vašu otázku alebo návrh..."
                />
              </div>
              {contactStatus === 'success' && (
                <div className="lp-form-success">Správa bola úspešne odoslaná. Ďakujeme!</div>
              )}
              {contactStatus === 'error' && (
                <div className="lp-form-error">{contactError}</div>
              )}
              <button type="submit" className="lp-btn lp-btn-primary" disabled={contactStatus === 'sending'} style={{ width: '100%' }}>
                {contactStatus === 'sending' ? 'Odosielam...' : 'Odoslať správu'}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-left">
            <img src="/icons/icon-96x96.png" alt="Prpl CRM — slovenský CRM systém" width="24" height="24" style={{ borderRadius: '6px' }} />
            <p className="lp-footer-text">&copy; 2026 Prpl CRM. Všetky práva vyhradené.</p>
          </div>
          <div className="lp-footer-links">
            {/* Obyčajné <a>, nie <Link>: legal stránky sú pre-rendrované statické
                HTML (full page load je správny) a LandingPage tak nepotrebuje
                Router context — nutné pre samostatnú hydratáciu (main.jsx). */}
            <a href="/vop/">Obchodné podmienky</a>
            <a href="/ochrana-udajov/">Ochrana osobných údajov</a>
            <CookieSettingsLink />
          </div>
        </div>
        <p className="lp-footer-credit">Created by <a href="https://vaicode.xyz" target="_blank" rel="noopener noreferrer">vaicode studio</a>.</p>
      </footer>

      <CookieConsent />
    </div>
  );
}
