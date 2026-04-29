# Časté otázky (FAQ)

## Účet a prihlásenie

### Môžem mať jeden účet a prihlasovať sa cez heslo aj cez Google?

Áno. V **Profil → Pripojené účty** môžeš ku svojmu účtu prepojiť **heslo, Google a Apple** súčasne. Stačí mať aspoň jednu metódu aktívnu.

### Zabudol som heslo, čo teraz?

Na prihlasovacej obrazovke klikni **Zabudli ste heslo?**, zadaj email a sleduj odkaz, ktorý ti príde mailom. Postup je v [Začíname → Zabudnuté heslo](./getting-started.md#zabudnute-heslo).

### Vytvoril som si účet cez Google. Ako si nastavím heslo?

V **Profil → Zmeniť heslo** zadaj nové heslo (pole „Aktuálne heslo" nech zostane prázdne, ak žiadne nemáš). Po uložení sa budeš môcť prihlasovať aj cez email + heslo.

### Aké požiadavky má heslo?

Heslo musí mať **minimálne 8 znakov**, obsahovať aspoň **jedno písmeno** a aspoň **jedno číslo alebo špeciálny znak**. Aplikácia tiež blokuje hesla z verejných únikov (overené cez Have I Been Pwned).

## Pracovné prostredia

### Čo je pracovné prostredie (workspace)?

Zdieľaný priestor s vlastnými kontaktmi, projektmi, úlohami, správami a členmi. Každý účet môže byť členom viacerých prostredí a prepínať medzi nimi.

### Ako fungujú limity v prostredí?

Limity sa riadia podľa plánu **vlastníka** prostredia:
- **Free** — max. 2 členovia
- **Tím** — max. 10 členov
- **Pro** — neobmedzene

Plán pozvaných členov je nepodstatný — počíta sa iba plán vlastníka.

### Môžem byť vo workspace s vyšším plánom, ak mám Free?

Áno. Tvoj Free plán ovplyvňuje iba prostredia, ktoré **vytváraš ty**. Ak ťa pozve vlastník s plánom Tím alebo Pro, fungujú jeho limity.

### Čo sa stane, keď vlastník downgrade-ne plán pod aktuálny počet členov?

Prostredie prejde do **režimu len na čítanie**. Existujúce dáta zostanú, ale vytváranie nového obsahu je zablokované, kým vlastník neupgraduje späť alebo neodstráni členov.

### Koľko prostredí môžem vytvoriť?

- Free — 1
- Tím — 2
- Pro — neobmedzene

## Plán a platby

### Je Free plán naozaj zadarmo navždy?

Áno. Bez časového obmedzenia, bez nutnosti zadávať platobnú kartu.

### Môžem kedykoľvek upgradovať / downgradovať?

Áno. Upgrade je okamžitý (nové limity platia hneď). Downgrade zachová tvoje dáta, ale ak prekračuješ limity nového plánu, vytváranie nového obsahu sa zablokuje, kým sa pod limit nedostaneš.

### Aký je rozdiel medzi mesačným a ročným predplatným?

Cena pri ročnom je **výhodnejšia** (Tím 49 € / rok vs. ~60 € pri mesačnom; Pro 99 € / rok vs. ~120 € pri mesačnom).

### Môžem zaplatiť promokódom?

Áno. Na obrazovke **Predplatné** zadaj kód do poľa **Promokód**. Niektoré kódy poskytujú zľavu, iné mesiace zadarmo navyše.

## Funkcie

### Aký je rozdiel medzi „projektom" a „úlohou"?

V Prpl CRM platí terminológia:
- **Projekt** = hlavná položka.
- **Úloha** = podúloha vnútri projektu (môže byť ľubovoľne hlboko zanorená).

### Môže byť projekt priradený k viacerým kontaktom?

Áno. Pri vytváraní alebo úprave projektu môžeš vybrať **viacero kontaktov**.

### Funguje synchronizácia s Google Calendar a Tasks aj na Free pláne?

Áno. Synchronizácia je dostupná **vo všetkých plánoch**, je obojsmerná a v reálnom čase.

### Môžem si exportovať dáta?

Áno, **export do CSV/Excelu** je v zoznamoch Kontaktov a Projektov tlačidlom **📥 CSV**.

### Aký je limit veľkosti súboru?

**10 MB** na jeden súbor (kontakt, projekt aj komentár).

## Notifikácie

### Prečo nedostávam push notifikácie v Safari?

Apple Safari **nepodporuje** Web Push v normálnom režime. Riešenia:
- Na iPhone: pridaj prplcrm.eu na **plochu (Add to Home Screen)** — vznikne PWA, ktorá Web Push podporuje.
- Alebo si nainštaluj **natívnu iOS aplikáciu**, ktorá používa APNs.
- V Chrome / Firefox / Edge web push funguje normálne.

### Dostávam veľa push, ako to obmedzím?

V **Profil → Nastavenia notifikácií** vypni kategórie, ktoré nepotrebuješ (Aktivita tímu, Po termíne, Nový člen workspace). Notifikácie sa stále budú zaznamenávať v zvončeku — len neprídu push.

### Niektoré notifikácie sa nedajú vypnúť. Prečo?

„Direct" notifikácie — priradenie projektu/úlohy ti, dokončenie tvojej úlohy iným kolegom, nová správa pre teba — sú vždy zapnuté, lebo sa ťa priamo týkajú.

## Ostatné

### V akom jazyku je aplikácia?

V **slovenčine**.

### Ako kontaktujem podporu?

**support@prplcrm.eu**.

### Kde sú podmienky a zásady ochrany?

- [Obchodné podmienky](https://prplcrm.eu/vop)
- [Zásady ochrany osobných údajov](https://prplcrm.eu/privacy-policy)
