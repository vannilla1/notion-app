import { useNavigate, Link } from 'react-router-dom';

export default function PrivacyPolicy() {
  const navigate = useNavigate();

  return (
    <div style={{
      maxWidth: '800px',
      margin: '0 auto',
      padding: '40px 20px',
      fontFamily: 'Inter, sans-serif',
      color: '#1e293b',
      lineHeight: '1.7'
    }}>
      <h1 style={{ fontSize: '28px', marginBottom: '8px' }}>Zásady ochrany osobných údajov</h1>
      <p style={{ color: '#64748b', marginBottom: '32px' }}>Posledná aktualizácia: 16. apríla 2026</p>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>1. Prevádzkovateľ</h2>
        <p>
          Prevádzkovateľom aplikácie <strong>Prpl CRM</strong> (ďalej len "aplikácia") dostupnej na adrese{' '}
          <a href="https://prplcrm.eu" style={{ color: '#6366f1' }}>prplcrm.eu</a>.
        </p>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>2. Aké údaje zbierame</h2>
        <ul style={{ paddingLeft: '20px' }}>
          <li><strong>Registračné údaje</strong> — email, používateľské meno, heslo (uložené v hashovanej forme)</li>
          <li><strong>Kontaktné údaje</strong> — mená, telefónne čísla, emaily a poznámky kontaktov, ktoré si sám vytvoríte</li>
          <li><strong>Projekty a úlohy</strong> — názvy, termíny, popisy a stavy projektov a úloh</li>
          <li><strong>Google účet (voliteľné)</strong> — pri pripojení Google Calendar alebo Google Tasks ukladáme OAuth prístupové a obnovovacie tokeny nevyhnutné pre synchronizáciu. <strong>Neukladáme vaše heslo ku Google účtu</strong> — autentifikácia prebieha cez oficiálny Google OAuth 2.0 flow.</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>3. Ako údaje používame</h2>
        <p>Vaše údaje používame výlučne na:</p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Poskytovanie funkcií aplikácie (správa kontaktov, projektov, synchronizácia)</li>
          <li>Autentifikáciu a zabezpečenie vášho účtu</li>
          <li>Odosielanie push notifikácií (ak ich povolíte)</li>
          <li>Obojsmernú synchronizáciu projektov s Google Calendar a Google Tasks (ak túto funkciu povolíte)</li>
        </ul>
        <p>Vaše údaje <strong>nepredávame</strong> tretím stranám, <strong>nepoužívame na reklamu</strong> a <strong>neprenášame žiadnym ľuďom</strong> okrem nevyhnutných prípadov definovaných v sekcii 4.</p>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>4. Google API — Limited Use a narábanie s Google dátami</h2>
        <p>
          Aplikácia využíva Google API na obojsmernú synchronizáciu úloh a projektov. Pri pripojení Google účtu
          požadujeme nasledujúce OAuth 2.0 scopes:
        </p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>
            <code>https://www.googleapis.com/auth/calendar.events</code> — čítanie a zápis <strong>iba udalostí</strong> vo vašom
            primárnom Google Calendar. Pri synchronizácii vytvárame/aktualizujeme/mažeme udalosti
            zodpovedajúce projektom v CRM (s termínom, názvom a popisom). <strong>Nemáme prístup k nastaveniam kalendára, zdieľaným kalendárom ani udalostiam iných používateľov.</strong>
          </li>
          <li>
            <code>https://www.googleapis.com/auth/tasks</code> — čítanie a zápis úloh v Google Tasks na synchronizáciu s projektmi v aplikácii.
          </li>
        </ul>
        <p>
          <strong>Aplikácia nežiada prístup k vašim emailom, kontaktom, dokumentom, fotografiám ani iným Google dátam.</strong>
        </p>

        <h3 style={{ fontSize: '16px', marginTop: '16px', marginBottom: '8px' }}>Záväzok Limited Use (Google API Services User Data Policy)</h3>
        <p>
          Použitie informácií získaných z Google API aplikáciou Prpl CRM prísne dodržiava{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes" target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1' }}>
            Google API Services User Data Policy
          </a>, vrátane požiadaviek na Limited Use. Konkrétne:
        </p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Dáta z Google Calendar/Tasks <strong>používame výlučne na poskytovanie alebo zlepšenie vami viditeľných funkcií synchronizácie</strong> v Prpl CRM.</li>
          <li>Dáta <strong>neprenášame</strong> tretím stranám, okrem prípadov keď je to nevyhnutné na poskytnutie služby (napr. cloud hosting), pri dodržaní právnych predpisov alebo s vaším výslovným súhlasom.</li>
          <li>Dáta <strong>nepoužívame na reklamu</strong> — žiadnu, ani personalizovanú.</li>
          <li>Dáta <strong>nepredávame</strong> — ani tretím stranám, ani data brokerom, ani pre iné informačné účely.</li>
          <li>Dáta <strong>nečítajú ľudia</strong>, okrem prípadov vášho výslovného súhlasu, na účely bezpečnosti (vyšetrovanie útoku), alebo keď to vyžaduje zákon.</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>5. Ukladanie a bezpečnosť údajov</h2>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Údaje sú uložené v databáze MongoDB Atlas s encryption-at-rest</li>
          <li>Heslá sú hashované algoritmom bcrypt</li>
          <li>Komunikácia prebieha výhradne cez HTTPS (TLS 1.2+)</li>
          <li>Prístupové a obnovovacie OAuth tokeny ku Google sú uložené v chránenej databáze s obmedzeným prístupom a prenášané výhradne cez HTTPS. Pri odpojení sú tokeny vymazané a zároveň revokované priamo v Google účte cez OAuth2 <code>revokeToken</code> endpoint.</li>
          <li>Prístup k produkčnej databáze majú výhradne oprávnení administrátori cez autentifikované pripojenie</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>6. Vaše práva</h2>
        <p>Máte právo:</p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Požiadať o vymazanie vášho účtu a všetkých súvisiacich údajov</li>
          <li>Odpojiť <strong>Google Calendar</strong> kedykoľvek v nastaveniach aplikácie (menu profilu → Synchronizácia kalendára → Odpojiť Google Calendar). Tým sa tokeny vymažú z nášho servera a zároveň revokujú v Google účte.</li>
          <li>Odpojiť <strong>Google Tasks</strong> kedykoľvek v nastaveniach aplikácie rovnakým spôsobom</li>
          <li>Odvolať prístup aplikácie k vášmu Google účtu kedykoľvek priamo v{' '}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1' }}>
              nastaveniach Google účtu
            </a>
          </li>
          <li>Požiadať o prístup k vašim údajom alebo ich opravu</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>7. Uchovávanie dát</h2>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Vaše údaje uchovávame po dobu aktivity účtu. Po jeho zmazaní odstránime všetky osobné údaje do 30 dní.</li>
          <li>Google OAuth tokeny sú vymazané okamžite po odpojení Google integrácie alebo zmazaní účtu.</li>
          <li>Synchronizačné dáta (mapovanie CRM úlohy ↔ Google event/task ID) sú vymazané spolu s tokenmi.</li>
        </ul>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>8. Kontakt</h2>
        <p>
          V prípade otázok ohľadom ochrany osobných údajov nás kontaktujte na adrese uvedenej v aplikácii alebo cez{' '}
          <a href="https://prplcrm.eu" style={{ color: '#6366f1' }}>prplcrm.eu</a>.
        </p>
      </section>

      <div style={{ display: 'flex', gap: '12px', marginTop: '32px' }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: '#6366f1', color: 'white', border: 'none', padding: '10px 24px',
            borderRadius: '8px', fontSize: '14px', cursor: 'pointer'
          }}
        >
          Späť na hlavnú stránku
        </button>
        <Link
          to="/vop"
          style={{
            background: '#f1f5f9', color: '#1e293b', border: 'none', padding: '10px 24px',
            borderRadius: '8px', fontSize: '14px', cursor: 'pointer', textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center'
          }}
        >
          Všeobecné obchodné podmienky
        </Link>
      </div>
    </div>
  );
}
