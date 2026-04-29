# Začíname s Prpl CRM

## Registrácia

1. Otvor [prplcrm.eu](https://prplcrm.eu) a klikni na **Zaregistrujte sa**, alebo prejdi priamo na `/login?register=true`.
2. Vyplň **Používateľské meno**, **Email** a **Heslo**. Potvrď, že súhlasíš s Obchodnými podmienkami a Zásadami ochrany osobných údajov.
3. Klikni **Registrovať**.

![Screenshot: registračný formulár s tromi poľami](#)

Alternatívne sa môžeš zaregistrovať cez **Google** alebo **Apple** kliknutím na príslušné tlačidlo pod formulárom — účet sa vytvorí automaticky z údajov poskytovateľa a netreba zadávať heslo.

## Prihlásenie

Na hlavnej stránke `/login`:
- Zadaj email a heslo a klikni **Prihlásiť**, alebo
- Klikni **Pokračovať s Google** / **Pokračovať s Apple**.

### Zabudnuté heslo

1. Na prihlasovacej obrazovke klikni **Zabudli ste heslo?**.
2. Zadaj svoj email a klikni odoslať.
3. Skontroluj schránku (aj **Spam** a **Promo** priečinok). Príde ti email s odkazom na nastavenie nového hesla.
4. Klikni na odkaz, zadaj nové heslo a potvrď. Odkaz je platný obmedzený čas.

> Poznámka: ak si vytvoril účet len cez Google alebo Apple a nikdy si si nenastavil heslo, prihlasuj sa cez **Pokračovať s Google/Apple**. Heslo si môžeš dodatočne nastaviť v **Profil → Pripojené účty**.

## Prvé prihlásenie — pracovné prostredie

Po registrácii sa zobrazí obrazovka **Vitajte v Prpl CRM** s dvomi voľbami:

### Vytvoriť nové prostredie

1. Klikni **Vytvoriť nové**.
2. Zadaj názov prostredia (napríklad „Moja firma s.r.o.").
3. Klikni **Vytvoriť**.

Stávaš sa Vlastníkom tohto prostredia.

### Pripojiť sa k existujúcemu

1. Klikni **Pripojiť sa**.
2. Zadaj kód pozvánky, ktorý ti poslal správca prostredia.
3. Klikni **Pripojiť sa**.

> Ak ti prišla pozvánka emailom s odkazom (`/invite/{token}`), klikni priamo na odkaz — pozvánka sa prijme automaticky po prihlásení.

## Dashboard prehľad

Po prihlásení sa otvorí **Dashboard** (`/app`). Je rozdelený na sekcie:

- **Vrchná hlavička** — logo Prpl CRM, prepínač pracovných prostredí, tlačidlá Kontakty / Projekty / Správy, zvonček notifikácií, tvoj profil.
- **Bočný panel (vľavo na počítači, mobilné menu po kliknutí na ☰)** — štatistiky:
  - Celkom kontaktov, Aktívnych
  - Globálne projekty, Nesplnené, Splnené
  - Projekty podľa priority (Vysoká, Stredná, Nízka)
  - Kontakty podľa stavu (Nový, Aktívny, Dokončený, Zrušený)
  - Správy podľa stavu (Čaká, Schválené, Zamietnuté, Komentované, Ankety)
  - **Rýchle akcie** — odkazy na vytvorenie kontaktu, projektu a správy.
- **Hlavná plocha** — karty Kontakty, Projekty a Správy s ukážkou posledných 5 položiek a sekcia **Kontakty s projektami**.

Kliknutím na ktorúkoľvek štatistiku v bočnom paneli sa otvorí filtrovaný zoznam.

![Screenshot: dashboard rozdelený na bočný panel a tri karty](#)

> Ak potrebuješ návod priamo v aplikácii, klikni na fialové tlačidlo **„?"** v pravom dolnom rohu — otvorí sa interaktívny pomocník s tipmi pre danú stránku.

## Pracovné prostredia

Pracovné prostredie (workspace) je samostatný priestor s vlastnými kontaktmi, projektmi, správami a členmi. Jeden účet môže byť členom viacerých prostredí.

### Prepnutie prostredia

- **Na počítači** — klikni na **prepínač pracovných prostredí** v hornej hlavičke (vedľa loga).
- **Na mobile** — klikni na ikonu profilu vpravo hore a v menu vyber **prostredie zo zoznamu**.

### Vytvorenie ďalšieho prostredia

1. Otvor profil (vpravo hore) → na mobile je v sekcii **Pracovné prostredia** tlačidlo **+ Nové prostredie**.
2. Zadaj názov a klikni **Vytvoriť**.

> Limit prostredí závisí od tvojho plánu (Free 1, Tím 2, Pro neobmedzene).

### Roly v prostredí

| Rola | Pozvať členov | Meniť roly | Vymazať obsah iných | Vlastniť prostredie |
|---|---|---|---|---|
| **Vlastník** | áno | áno | áno (vrátane správ) | áno |
| **Manažér** | áno | iba členov | áno (vrátane správ) | nie |
| **Člen** | nie | nie | iba svoj obsah | nie |

### Pozvanie člena

1. Klikni na profil → **Správa tímu**, alebo prejdi priamo na `/workspace/members`.
2. V sekcii **Pozvať nového člena** zadaj email a vyber rolu (**Člen** alebo **Manažér**).
3. Klikni **Pozvať**.
4. Pozvánka sa odošle emailom. Pozvánka platí **7 dní**.
5. Ak email nedorazil, rozbaľ **Zobraziť odkaz na pozvánku** a pošli odkaz manuálne (napríklad cez chat alebo SMS).

![Screenshot: zoznam členov a formulár pre pozvanie](#)

### Zmena role člena

V zozname členov klikni na rozbaľovací zoznam vedľa mena a vyber novú rolu. Túto akciu môže urobiť **iba Vlastník**.

### Prevod vlastníctva

1. Vlastník môže prevod spraviť iba na **Manažéra**.
2. V zozname členov pri Manažérovi klikni **Previesť vlastníctvo**.
3. Potvrď v dialógu — Vlastník sa stane Členom a vybraný používateľ sa stane Vlastníkom.

### Opustenie prostredia

V profil-menu v sekcii Pracovné prostredia klikni **Opustiť prostredie**. Vlastník nemôže opustiť prostredie, kým neprevedie vlastníctvo na iného Manažéra.

## Profil a osobné nastavenia

Klikni na ikonu profilu vpravo hore. Otvorí sa menu:

- **Môj profil** — zmena používateľského mena, emailu, fotky a farby profilu.
- **Zmeniť heslo** — vyžaduje zadanie aktuálneho hesla.
- **Pripojené účty** — pridanie alebo odpojenie Google a Apple prihlasovania.
- **Synchronizácia kalendára** — Google Calendar, Google Tasks, iCal feed.
- **Nastavenia notifikácií** — ktoré typy push notifikácií chceš dostávať.
- **Správa tímu** — členovia aktuálneho prostredia.
- **Predplatné** — aktuálny plán a možnosť upgrade.
- **Odhlásiť sa**.

### Pripojené účty

V **Pripojené účty** vidíš, ktoré prihlasovacie metódy máš aktívne (Heslo, Google, Apple). Môžeš:
- **Pridať** chýbajúcu metódu (napríklad k email/heslo účtu pridať Google).
- **Odpojiť** metódu, **ak ti zostane minimálne jedna** prihlasovacia možnosť.

> Ak nemáš nastavené heslo a odpojíš si jediný OAuth účet, stratil by si prístup — preto ti aplikácia poslednú metódu nedovolí odpojiť.
