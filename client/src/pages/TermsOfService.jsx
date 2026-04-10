import { useNavigate, Link } from 'react-router-dom';

export default function TermsOfService() {
  const navigate = useNavigate();

  const s = { section: { marginBottom: '24px' }, h2: { fontSize: '20px', marginBottom: '8px' }, ul: { paddingLeft: '20px' }, a: { color: '#6366f1' } };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 20px', fontFamily: 'Inter, sans-serif', color: '#1e293b', lineHeight: '1.7' }}>
      <h1 style={{ fontSize: '28px', marginBottom: '8px' }}>Všeobecné obchodné podmienky</h1>
      <p style={{ color: '#64748b', marginBottom: '32px' }}>Posledná aktualizácia: 31. marca 2026</p>

      {/* 1 */}
      <section style={s.section}>
        <h2 style={s.h2}>1. Úvodné ustanovenia a vymedzenie pojmov</h2>
        <p>
          1.1. Tieto Všeobecné obchodné podmienky (ďalej len „VOP") upravujú práva a povinnosti medzi poskytovateľom služby <strong>Prpl CRM</strong> (ďalej len „Poskytovateľ") a každou fyzickou alebo právnickou osobou, ktorá službu používa (ďalej len „Používateľ").
        </p>
        <p>
          1.2. Služba Prpl CRM (ďalej len „Služba") je cloudová (SaaS) aplikácia na správu kontaktov, projektov, úloh a tímovej spolupráce, dostupná na adrese{' '}
          <a href="https://prplcrm.eu" style={s.a}>prplcrm.eu</a> a prostredníctvom mobilnej aplikácie.
        </p>
        <p>1.3. Registráciou alebo používaním Služby Používateľ vyjadruje súhlas s týmito VOP. Ak s VOP nesúhlasíte, Službu nepoužívajte.</p>
        <p>1.4. VOP sú vydané v súlade so zákonom č. 513/1991 Zb. (Obchodný zákonník), zákonom č. 40/1964 Zb. (Občiansky zákonník), zákonom č. 22/2004 Z.z. (o elektronickom obchode), zákonom č. 250/2007 Z.z. (o ochrane spotrebiteľa), zákonom č. 102/2014 Z.z. (o ochrane spotrebiteľa pri predaji na diaľku) a nariadením Európskeho parlamentu a Rady (EÚ) 2016/679 (GDPR).</p>
      </section>

      {/* 2 */}
      <section style={s.section}>
        <h2 style={s.h2}>2. Identifikácia Poskytovateľa</h2>
        <p>
          Poskytovateľom Služby je prevádzkovateľ aplikácie Prpl CRM dostupnej na adrese{' '}
          <a href="https://prplcrm.eu" style={s.a}>prplcrm.eu</a>.
        </p>
        <p>Kontaktný email: <a href="mailto:support@prplcrm.eu" style={s.a}>support@prplcrm.eu</a></p>
      </section>

      {/* 3 */}
      <section style={s.section}>
        <h2 style={s.h2}>3. Predmet zmluvy</h2>
        <p>3.1. Predmetom zmluvy je poskytovanie Služby Prpl CRM v rozsahu podľa zvoleného tarifu (plánu).</p>
        <p>3.2. Služba umožňuje najmä:</p>
        <ul style={s.ul}>
          <li>Správu kontaktov a ich kategorizáciu</li>
          <li>Vytváranie a správu projektov a úloh</li>
          <li>Tímovú spoluprácu v rámci pracovných prostredí</li>
          <li>Synchronizáciu s Google Calendar a Google Tasks</li>
          <li>Odosielanie a prijímanie interných správ</li>
          <li>Push notifikácie a upozornenia</li>
        </ul>
      </section>

      {/* 4 */}
      <section style={s.section}>
        <h2 style={s.h2}>4. Uzavretie zmluvy a registrácia</h2>
        <p>4.1. Zmluva medzi Poskytovateľom a Používateľom sa uzatvára momentom úspešnej registrácie Používateľa v Službe a potvrdením súhlasu s týmito VOP.</p>
        <p>4.2. Používateľ je povinný poskytnúť pravdivé a úplné registračné údaje.</p>
        <p>4.3. Každý Používateľ smie mať iba jeden účet. Poskytovateľ si vyhradzuje právo zrušiť duplicitné účty.</p>
        <p>4.4. Používateľ je zodpovedný za zabezpečenie svojich prihlasovacích údajov. O akomkoľvek neoprávnenom prístupe k účtu je povinný bezodkladne informovať Poskytovateľa.</p>
        <p>4.5. Služba je určená pre osoby staršie ako 16 rokov. Registráciou Používateľ potvrdzuje, že spĺňa túto vekovú podmienku.</p>
      </section>

      {/* 5 */}
      <section style={s.section}>
        <h2 style={s.h2}>5. Tarify a rozsah Služby</h2>
        <p>5.1. Služba je dostupná v niekoľkých tarifoch (plánoch) vrátane bezplatného tarifu (Free). Aktuálny rozsah a ceny sú uvedené na stránke{' '}
          <a href="https://prplcrm.eu" style={s.a}>prplcrm.eu</a> v sekcii Cenník.
        </p>
        <p>5.2. Bezplatný tarif je časovo neobmedzený a nevyžaduje zadanie platobných údajov.</p>
        <p>5.3. Poskytovateľ si vyhradzuje právo zmeniť rozsah funkcionalít jednotlivých tarifov. O takejto zmene bude Používateľ informovaný minimálne 30 dní vopred.</p>
      </section>

      {/* 6 */}
      <section style={s.section}>
        <h2 style={s.h2}>6. Cenové podmienky a platby</h2>
        <p>6.1. Ceny platených tarifov sú uvedené vrátane DPH (ak sa uplatňuje) na stránke Cenníka.</p>
        <p>6.2. Platené predplatné sa účtuje mesačne alebo ročne podľa zvoleného fakturačného cyklu, a to vopred na dané obdobie.</p>
        <p>6.3. Predplatné sa automaticky obnovuje na konci každého fakturačného obdobia, pokiaľ Používateľ predplatné nezruší pred jeho uplynutím.</p>
        <p>6.4. Poskytovateľ si vyhradzuje právo zmeniť ceny. O zmene cien bude Používateľ informovaný minimálne 30 dní pred začiatkom nového fakturačného obdobia.</p>
        <p>6.5. V prípade nesúhlasu so zmenou ceny má Používateľ právo predplatné zrušiť pred začiatkom nového fakturačného obdobia.</p>
      </section>

      {/* 7 */}
      <section style={s.section}>
        <h2 style={s.h2}>7. Práva a povinnosti Používateľa</h2>
        <p>7.1. Používateľ má právo:</p>
        <ul style={s.ul}>
          <li>Používať Službu v rozsahu zvoleného tarifu</li>
          <li>Kedykoľvek zmeniť tarif (upgrade alebo downgrade)</li>
          <li>Kedykoľvek zrušiť svoj účet</li>
          <li>Exportovať svoje údaje v štandardnom formáte (CSV)</li>
          <li>Požiadať o vymazanie všetkých osobných údajov</li>
        </ul>
        <p>7.2. Používateľ je povinný:</p>
        <ul style={s.ul}>
          <li>Dodržiavať tieto VOP a platnú legislatívu SR a EÚ</li>
          <li>Nepoužívať Službu na nezákonné účely</li>
          <li>Nenahrávať škodlivý obsah (malware, vírusy, spam)</li>
          <li>Nezneužívať Službu na hromadné odosielanie nevyžiadaných správ</li>
          <li>Neoprávnene nepristupovať k účtom iných Používateľov</li>
          <li>Nepokúšať sa o narušenie bezpečnosti alebo infraštruktúry Služby</li>
        </ul>
        <p>7.3. V prípade porušenia VOP má Poskytovateľ právo okamžite obmedziť alebo zrušiť prístup Používateľa k Službe.</p>
      </section>

      {/* 8 */}
      <section style={s.section}>
        <h2 style={s.h2}>8. Práva a povinnosti Poskytovateľa</h2>
        <p>8.1. Poskytovateľ sa zaväzuje:</p>
        <ul style={s.ul}>
          <li>Zabezpečiť dostupnosť Služby v rozumnom rozsahu (cieľ: 99,5 % dostupnosť)</li>
          <li>Chrániť údaje Používateľa v súlade s GDPR a platnými zákonmi</li>
          <li>Informovať Používateľov o plánovaných odstávkach vopred</li>
          <li>Odpovedať na požiadavky podpory do 24 hodín v pracovných dňoch</li>
        </ul>
        <p>8.2. Poskytovateľ má právo:</p>
        <ul style={s.ul}>
          <li>Vykonávať plánovanú údržbu a aktualizácie Služby</li>
          <li>Obmedziť alebo pozastaviť prístup Používateľa v prípade porušenia VOP</li>
          <li>Zmeniť rozsah Služby s predchádzajúcim upozornením</li>
        </ul>
      </section>

      {/* 9 */}
      <section style={s.section}>
        <h2 style={s.h2}>9. Dostupnosť Služby</h2>
        <p>9.1. Poskytovateľ sa snaží zabezpečiť nepretržitú dostupnosť Služby. Služba však môže byť dočasne nedostupná z dôvodu údržby, aktualizácií alebo technických problémov.</p>
        <p>9.2. O plánovaných odstávkach bude Poskytovateľ informovať Používateľov vopred prostredníctvom emailu alebo notifikácie v aplikácii.</p>
        <p>9.3. Poskytovateľ nenesie zodpovednosť za nedostupnosť spôsobenú vyššou mocou, poruchami tretích strán (hosting, internet) alebo neoprávneným zásahom do infraštruktúry.</p>
      </section>

      {/* 10 */}
      <section style={s.section}>
        <h2 style={s.h2}>10. Ochrana osobných údajov</h2>
        <p>10.1. Poskytovateľ spracúva osobné údaje Používateľov v súlade s nariadením (EÚ) 2016/679 (GDPR) a zákonom č. 18/2018 Z.z. o ochrane osobných údajov.</p>
        <p>10.2. Podrobné informácie o spracúvaní osobných údajov sú uvedené v samostatnom dokumente{' '}
          <Link to="/ochrana-udajov" style={s.a}>Zásady ochrany osobných údajov</Link>.
        </p>
        <p>10.3. Používateľ berie na vedomie, že ako prevádzkovateľ osobných údajov svojich kontaktov a klientov uložených v Službe je zodpovedný za súlad s GDPR voči týmto osobám.</p>
        <p>10.4. Poskytovateľ vystupuje vo vzťahu k osobným údajom uloženým Používateľom v Službe ako sprostredkovateľ v zmysle čl. 28 GDPR.</p>
      </section>

      {/* 11 */}
      <section style={s.section}>
        <h2 style={s.h2}>11. Duševné vlastníctvo</h2>
        <p>11.1. Služba, jej zdrojový kód, dizajn, grafika, logá a dokumentácia sú chránené autorským právom a inými právami duševného vlastníctva Poskytovateľa.</p>
        <p>11.2. Používateľ získava nevýhradnú, neprenosnú licenciu na používanie Služby v rozsahu zvoleného tarifu.</p>
        <p>11.3. Používateľ nesmie kopírovať, modifikovať, distribuovať ani spätne analyzovať (reverse engineering) akúkoľvek časť Služby.</p>
      </section>

      {/* 12 */}
      <section style={s.section}>
        <h2 style={s.h2}>12. Vlastníctvo údajov a prenositeľnosť</h2>
        <p>12.1. Všetky údaje, ktoré Používateľ do Služby vloží (kontakty, projekty, úlohy, prílohy, správy), zostávajú vlastníctvom Používateľa.</p>
        <p>12.2. Poskytovateľ nezískava žiadne vlastnícke práva k údajom Používateľa.</p>
        <p>12.3. Používateľ má právo kedykoľvek exportovať svoje údaje v štandardnom formáte (CSV).</p>
        <p>12.4. Po zrušení účtu budú údaje Používateľa uchovávané maximálne 30 dní a následne nenávratne vymazané.</p>
      </section>

      {/* 13 */}
      <section style={s.section}>
        <h2 style={s.h2}>13. Zodpovednosť a obmedzenie zodpovednosti</h2>
        <p>13.1. Služba je poskytovaná „tak ako je" (as is). Bezplatný tarif je poskytovaný bez akýchkoľvek záruk.</p>
        <p>13.2. Poskytovateľ nenesie zodpovednosť za:</p>
        <ul style={s.ul}>
          <li>Stratu údajov spôsobenú používateľom alebo tretími stranami</li>
          <li>Nepriame, následné alebo špeciálne škody</li>
          <li>Ušlý zisk alebo stratu príležitostí</li>
          <li>Nedostupnosť Služby z dôvodu vyššej moci</li>
          <li>Obsah, ktorý Používateľ do Služby vloží</li>
        </ul>
        <p>13.3. V prípade platených tarifov je celková zodpovednosť Poskytovateľa za škodu obmedzená na sumu, ktorú Používateľ zaplatil za Službu za posledných 12 mesiacov.</p>
        <p>13.4. Toto obmedzenie zodpovednosti sa neuplatňuje v rozsahu, v akom to zakazuje platná legislatíva SR alebo EÚ.</p>
      </section>

      {/* 14 */}
      <section style={s.section}>
        <h2 style={s.h2}>14. Trvanie a ukončenie zmluvy</h2>
        <p>14.1. Zmluva sa uzatvára na dobu neurčitú.</p>
        <p>14.2. Používateľ môže zmluvu kedykoľvek ukončiť zrušením svojho účtu v nastaveniach Služby.</p>
        <p>14.3. Pri zrušení plateného predplatného zostáva prístup k platenému tarifu aktívny do konca aktuálneho fakturačného obdobia.</p>
        <p>14.4. Poskytovateľ môže zmluvu ukončiť:</p>
        <ul style={s.ul}>
          <li>Okamžite, v prípade závažného porušenia VOP Používateľom</li>
          <li>S 30-dňovou výpovednou lehotou, z akéhokoľvek dôvodu</li>
        </ul>
        <p>14.5. Po ukončení zmluvy Poskytovateľ uchová údaje Používateľa 30 dní, počas ktorých ich Používateľ môže exportovať.</p>
      </section>

      {/* 15 */}
      <section style={s.section}>
        <h2 style={s.h2}>15. Právo na odstúpenie od zmluvy</h2>
        <p>15.1. Používateľ, ktorý je spotrebiteľ v zmysle zákona č. 102/2014 Z.z., má právo odstúpiť od zmluvy uzavretej na diaľku bez uvedenia dôvodu v lehote 14 dní odo dňa uzavretia zmluvy.</p>
        <p>15.2. Odstúpenie od zmluvy Používateľ uplatní písomným oznámením na email <a href="mailto:support@prplcrm.eu" style={s.a}>support@prplcrm.eu</a>.</p>
        <p>15.3. V prípade odstúpenia od zmluvy Poskytovateľ vráti Používateľovi všetky platby prijaté od Používateľa, a to do 14 dní odo dňa doručenia oznámenia o odstúpení.</p>
        <p>15.4. Používateľ súhlasí s tým, že ak začne Službu používať pred uplynutím lehoty na odstúpenie, stráca právo na odstúpenie od zmluvy v rozsahu už poskytnutého plnenia v súlade s § 7 ods. 6 písm. l) zákona č. 102/2014 Z.z.</p>
      </section>

      {/* 16 */}
      <section style={s.section}>
        <h2 style={s.h2}>16. Reklamačný poriadok</h2>
        <p>16.1. Používateľ má právo reklamovať vady Služby.</p>
        <p>16.2. Reklamáciu je potrebné uplatniť písomne na email <a href="mailto:support@prplcrm.eu" style={s.a}>support@prplcrm.eu</a> s popisom vady.</p>
        <p>16.3. Poskytovateľ potvrdí prijatie reklamácie do 3 pracovných dní a vybaví ju do 30 dní odo dňa uplatnenia.</p>
        <p>16.4. O výsledku reklamácie bude Používateľ informovaný emailom.</p>
      </section>

      {/* 17 */}
      <section style={s.section}>
        <h2 style={s.h2}>17. Zmeny VOP</h2>
        <p>17.1. Poskytovateľ si vyhradzuje právo kedykoľvek zmeniť tieto VOP.</p>
        <p>17.2. O zmene VOP bude Používateľ informovaný minimálne 30 dní pred účinnosťou zmeny, a to emailom alebo notifikáciou v Službe.</p>
        <p>17.3. Ak Používateľ so zmenami nesúhlasí, má právo zrušiť svoj účet pred dátumom účinnosti nových VOP.</p>
        <p>17.4. Pokračovaním v používaní Služby po nadobudnutí účinnosti nových VOP Používateľ vyjadruje súhlas s ich novým znením.</p>
      </section>

      {/* 18 */}
      <section style={s.section}>
        <h2 style={s.h2}>18. Rozhodné právo a riešenie sporov</h2>
        <p>18.1. Tieto VOP sa riadia právnym poriadkom Slovenskej republiky.</p>
        <p>18.2. Prípadné spory budú riešené prednostne dohodou. Ak nedôjde k dohode, spory sa budú riešiť pred príslušnými súdmi Slovenskej republiky.</p>
        <p>18.3. Spotrebiteľ má právo obrátiť sa na platformu alternatívneho riešenia sporov EÚ na adrese:{' '}
          <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noopener noreferrer" style={s.a}>
            https://ec.europa.eu/consumers/odr/
          </a>
        </p>
        <p>18.4. Spotrebiteľ sa tiež môže obrátiť na Slovenskú obchodnú inšpekciu (SOI) ako orgán alternatívneho riešenia sporov.</p>
      </section>

      {/* 19 */}
      <section style={s.section}>
        <h2 style={s.h2}>19. Záverečné ustanovenia</h2>
        <p>19.1. Ak sa akékoľvek ustanovenie týchto VOP stane neplatným alebo nevymáhateľným, ostatné ustanovenia zostávajú v platnosti.</p>
        <p>19.2. Tieto VOP nadobúdajú platnosť a účinnosť dňa 31. marca 2026.</p>
        <p>19.3. Otázky neupravené týmito VOP sa riadia príslušnými právnymi predpismi Slovenskej republiky a Európskej únie.</p>
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
          to="/ochrana-udajov"
          style={{
            background: '#f1f5f9', color: '#1e293b', border: 'none', padding: '10px 24px',
            borderRadius: '8px', fontSize: '14px', cursor: 'pointer', textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center'
          }}
        >
          Zásady ochrany osobných údajov
        </Link>
      </div>
    </div>
  );
}
