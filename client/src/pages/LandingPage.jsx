import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '@/api/api';
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
    <div className="lp-page">
      {/* Navbar */}
      <nav className={`lp-navbar ${scrolled ? 'scrolled' : ''}`}>
        <div className="lp-navbar-inner">
          <a href="#" className="lp-logo" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <img src="/icons/icon-96x96.png" alt="Prpl CRM" width="32" height="32" style={{ borderRadius: '8px' }} />
            Prpl CRM
          </a>

          <ul className="lp-nav-links">
            <li><a href="#funkcie" onClick={(e) => { e.preventDefault(); scrollTo('funkcie'); }}>Funkcie</a></li>
            <li><a href="#cennik" onClick={(e) => { e.preventDefault(); scrollTo('cennik'); }}>Cenník</a></li>
            <li><a href="#faq" onClick={(e) => { e.preventDefault(); scrollTo('faq'); }}>Časté otázky</a></li>
            <li><a href="#stiahnut" onClick={(e) => { e.preventDefault(); scrollTo('stiahnut'); }}>Stiahnuť</a></li>
            <li><a href="#kontakt" onClick={(e) => { e.preventDefault(); scrollTo('kontakt'); }}>Kontakt</a></li>
          </ul>

          <Link to="/login" className="lp-nav-cta desktop-only">Prihlásiť sa</Link>

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
          <a href="#kontakt" onClick={(e) => { e.preventDefault(); scrollTo('kontakt'); }}>Kontakt</a>
          <Link to="/login" className="lp-mobile-cta" onClick={() => setMobileMenuOpen(false)}>Prihlásiť sa</Link>
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
            Spravujte kontakty a projekty<br />na jednom mieste
          </h1>
          <p className="lp-hero-subtitle">
            Moderný CRM systém pre správu kontaktov, projektov a tímovej spolupráce.
            Jednoduchý, rýchly a vždy po ruke.
          </p>
          <div className="lp-hero-buttons">
            <Link to="/login?register=true" className="lp-btn lp-btn-white">Vyskúšajte zadarmo</Link>
            <Link to="/login" className="lp-btn lp-btn-outline">Prihlásiť sa</Link>
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
              Prpl CRM vám pomôže organizovať prácu a zefektívniť tímovú spoluprácu
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
                Pristupujte k CRM odkiaľkoľvek — natívna aplikácia pre Android aj iOS vždy po ruke.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
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

          <div className="lp-pricing-cards">
            {/* Free */}
            <div className="lp-pricing-card">
              <h3 className="lp-pricing-name">Free</h3>
              <p className="lp-pricing-desc">Zadarmo, navždy</p>

              <div className="lp-pricing-price">
                <span className="lp-pricing-amount">0 €</span>
              </div>
              <p className="lp-pricing-yearly-note" style={{ color: '#64748b' }}>Bez platobnej karty</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 5 kontaktov
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 10 projektov a úloh na kontakt
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Google Tasks synchronizácia
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Push notifikácie
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 2 používatelia
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  1 pracovné prostredie
                </li>
              </ul>

              <Link to="/login?register=true" className="lp-btn lp-btn-secondary lp-pricing-cta">
                Začať zadarmo
              </Link>
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
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>Pre 1 používateľa. Každý ďalší: {isYearly ? '49 €/rok' : '4,99 €/mesiac'}.</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 25 kontaktov
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 25 projektov a úloh na kontakt
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Max. 10 používateľov
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  2 pracovné prostredia
                </li>
              </ul>

              <Link to="/login?register=true" className="lp-btn lp-btn-secondary lp-pricing-cta">
                Začať s Tímom
              </Link>
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
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>Pre 1 používateľa. Každý ďalší: {isYearly ? '99 €/rok' : '9,99 €/mesiac'}.</p>

              <div className="lp-pricing-divider" />

              <ul className="lp-pricing-features">
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Neobmedzený počet kontaktov
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Neobmedzené projekty a úlohy
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Neobmedzený počet používateľov
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Neobmedzený počet pracovných prostredí
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Prioritná podpora
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Pravidelné aktualizácie
                </li>
                <li>
                  <span className="lp-pricing-check">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Pokročilé funkcie
                </li>
              </ul>

              <Link to="/login?register=true" className="lp-btn lp-btn-primary lp-pricing-cta">
                Začať s Pro
              </Link>
            </div>
          </div>

          <p style={{ textAlign: 'center', fontSize: '13px', color: '#94a3b8', marginTop: '24px' }}>
            Všetky ceny sú vrátane DPH.
          </p>
        </div>
      </section>

      {/* FAQ */}
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
            <a href="#" className="lp-badge" onClick={(e) => e.preventDefault()}>
              <span className="lp-badge-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 21.99 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 21.99C7.79 22.03 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.28 4.83C10.56 4.81 11.78 5.7 12.57 5.7C13.36 5.7 14.85 4.62 16.4 4.8C17.05 4.83 18.89 5.08 20.07 6.8C19.96 6.87 17.62 8.23 17.65 11.1C17.68 14.53 20.55 15.69 20.58 15.7C20.56 15.77 20.12 17.35 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" />
                </svg>
              </span>
              <span className="lp-badge-text">
                <span className="lp-badge-label">Stiahnuť na</span>
                <span className="lp-badge-store">App Store</span>
              </span>
            </a>

            <a href="#" className="lp-badge" onClick={(e) => e.preventDefault()}>
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
          </div>
        </div>
      </section>

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
              <button type="submit" className="lp-cta-primary" disabled={contactStatus === 'sending'}>
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
            <img src="/icons/icon-96x96.png" alt="Prpl CRM" width="24" height="24" style={{ borderRadius: '6px' }} />
            <p className="lp-footer-text">&copy; 2026 Prpl CRM. Všetky práva vyhradené.</p>
          </div>
          <div className="lp-footer-links">
            <a href="mailto:support@prplcrm.eu">support@prplcrm.eu</a>
            <Link to="/privacy">Zásady ochrany osobných údajov</Link>
          </div>
        </div>
        <p className="lp-footer-credit">Created by <a href="https://vaicode.xyz" target="_blank" rel="noopener noreferrer">vannilla</a></p>
      </footer>
    </div>
  );
}
