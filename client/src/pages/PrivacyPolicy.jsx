import { useNavigate } from 'react-router-dom';

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
      <p style={{ color: '#64748b', marginBottom: '32px' }}>Posledná aktualizácia: 4. marca 2026</p>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>1. Prevádzkovateľ</h2>
        <p>
          Prevádzkovateľom aplikácie <strong>Prpl CRM</strong> (ďalej len "aplikácia") dostupnej na adrese{' '}
          <a href="https://prpl-crm.onrender.com" style={{ color: '#6366f1' }}>prpl-crm.onrender.com</a>.
        </p>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>2. Aké údaje zbierame</h2>
        <ul style={{ paddingLeft: '20px' }}>
          <li><strong>Registračné údaje</strong> — email, používateľské meno, heslo (uložené v hashovanej forme)</li>
          <li><strong>Kontaktné údaje</strong> — mená, telefónne čísla, emaily a poznámky kontaktov, ktoré si sám vytvoríte</li>
          <li><strong>Úlohy</strong> — názvy, termíny, popisy a stavy úloh a podúloh</li>
          <li><strong>Google účet</strong> — pri pripojení Google Tasks ukladáme prístupové tokeny na synchronizáciu úloh. Neukladáme vaše heslo ku Google účtu.</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>3. Ako údaje používame</h2>
        <p>Vaše údaje používame výlučne na:</p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Poskytovanie funkcií aplikácie (správa kontaktov, úloh, synchronizácia)</li>
          <li>Autentifikáciu a zabezpečenie vášho účtu</li>
          <li>Odosielanie push notifikácií (ak ich povolíte)</li>
          <li>Synchronizáciu úloh s Google Tasks (ak túto funkciu povolíte)</li>
        </ul>
        <p>Vaše údaje <strong>nepredávame</strong> tretím stranám a nepoužívame ich na reklamu.</p>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>4. Google API</h2>
        <p>
          Aplikácia využíva Google Tasks API na synchronizáciu úloh. Pri pripojení Google účtu
          požadujeme prístup len k vašim úlohám v Google Tasks (scope: <code>tasks</code>).
          Nemáme prístup k vašim emailom, kontaktom, kalendáru ani iným dátam Google účtu.
        </p>
        <p>
          Používanie údajov z Google API je v súlade s{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1' }}>
            Google API Services User Data Policy
          </a>, vrátane požiadaviek na Limited Use.
        </p>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>5. Ukladanie a bezpečnosť údajov</h2>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Údaje sú uložené v databáze MongoDB s šifrovaným pripojením</li>
          <li>Heslá sú hashované algoritmom bcrypt</li>
          <li>Komunikácia prebieha cez HTTPS</li>
          <li>Prístupové tokeny ku Google sú uložené šifrovane na serveri</li>
        </ul>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>6. Vaše práva</h2>
        <p>Máte právo:</p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Požiadať o vymazanie vášho účtu a všetkých súvisiacich údajov</li>
          <li>Odpojiť Google Tasks kedykoľvek v nastaveniach aplikácie</li>
          <li>Odvolať prístup aplikácie k vášmu Google účtu cez{' '}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1' }}>
              nastavenia Google účtu
            </a>
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>7. Kontakt</h2>
        <p>
          V prípade otázok ohľadom ochrany osobných údajov nás kontaktujte na adrese uvedenej v aplikácii.
        </p>
      </section>

      <button
        onClick={() => navigate('/login')}
        style={{
          background: '#6366f1',
          color: 'white',
          border: 'none',
          padding: '10px 24px',
          borderRadius: '8px',
          fontSize: '14px',
          cursor: 'pointer'
        }}
      >
        Späť do aplikácie
      </button>
    </div>
  );
}
