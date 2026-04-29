# Mobilné aplikácie

Prpl CRM má **natívnu aplikáciu pre iOS a Android**, ktorá poskytuje plnohodnotný prístup k tvojim kontaktom, projektom a správam.

## Stiahnutie

- **iOS** — Apple App Store, hľadaj **Prpl CRM**.
- **Android** — Google Play, hľadaj **Prpl CRM**.

> Odkazy na obchody nájdeš aj na hlavnej stránke [prplcrm.eu](https://prplcrm.eu) v sekcii **Stiahnuť**.

## Prvé prihlásenie

1. Otvor appku.
2. Klikni **Prihlásiť** (ak máš účet) alebo **Zaregistrujte sa**.
3. Vyber spôsob prihlásenia:
   - **Email a heslo**
   - **Pokračovať s Google**
   - **Pokračovať s Apple** (iba iOS, využíva systémový Sign in with Apple)
4. Pri prvom otvorení appka požiada o **povolenie push notifikácií**. Klikni **Povoliť**.

## Spodná navigácia

Mobilná verzia má **spodnú navigáciu** s ikonami:
- Dashboard
- Kontakty
- Projekty
- Správy

Číslo pri ikone = počet neprečítaných notifikácií v danej sekcii.

## Profil a workspace switcher

Klikni na ikonu profilu vpravo hore. V menu je:
- Tvoj profil a osobné nastavenia (rovnaké ako web).
- Sekcia **Pracovné prostredia** so zoznamom — kliknutím prepínaš.
- **+ Nové prostredie** (ak ti to dovoľuje plán).

## Push notifikácie

| Platforma | Mechanizmus |
|---|---|
| iOS | APNs (cez Apple Push Notification service) |
| Android | FCM (Firebase Cloud Messaging) |

Push má rovnaké pravidlá ako na webe — pozri [Notifikácie](./notifications.md). „Direct" notifikácie (priradenia, správy) sú vždy zapnuté, „General" má per-toggle nastavenie v Profil → **Nastavenia notifikácií**.

### Klik na notifikáciu

Klik otvorí appku priamo na danej položke (deep-link), aj keď bola appka úplne zatvorená. Ak je notifikácia z iného workspace ako máš aktuálne otvoreného, appka prostredie automaticky prepne.

## Sign in with Apple (iOS)

Na iOS môžeš okrem emailu a Google použiť aj **Sign in with Apple**:
- Pri registrácii môžeš zvoliť **Skryť môj email** — Apple vygeneruje proxy email, ktorý preposiela na tvoj reálny.
- Funguje aj cez **Face ID / Touch ID**.

Sign in with Apple nájdeš aj v **Pripojené účty**, kde ho môžeš pridať k existujúcemu email/heslo účtu.

## Rozdiely oproti webu

- **Spodná navigácia** miesto hornej hlavičky.
- **Bočný panel so štatistikami** sa otvorí cez **☰** (hamburger) vľavo hore.
- **Drag & drop projektov** — drž prst na ikone ⠿ a potiahni.
- **Kalendárny pohľad** — listovanie posunom doľava/doprava.
- **Pripomienky push** — v iOS appke chodia cez systémový panel notifikácií, v Androide cez FCM.

## Prepnutie medzi natívnou appkou a webom

Aplikácia a web zdieľajú **tie isté dáta** — môžeš začať na telefóne, pokračovať na počítači a naopak. Notifikácie sa medzi zariadeniami rešpektujú: keď si správu prečítaš na webe, červené číslo zmizne aj na telefóne (zvyčajne do niekoľkých sekúnd).

## Obnovenie aplikácie

Ak appka spadne alebo sa zobrazí biela obrazovka:
- **iOS** — potiahni gestom hore z dolnej hrany (alebo dvojklik Home), potiahni appku hore a otvor znova.
- **Android** — otvor zoznam aktívnych aplikácií a zatvor Prpl CRM, potom otvor znova.

Ak problém pretrváva, pozri [Riešenie problémov](./troubleshooting.md).
