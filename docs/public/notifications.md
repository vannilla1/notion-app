# Notifikácie

Prpl CRM má dva komplementárne kanály:

1. **Zvonček v aplikácii** (vždy zaznamenáva všetko)
2. **Push notifikácie** (na telefón / prehliadač — selektívne)

## Zvonček notifikácií

Fialový zvonček 🔔 vpravo hore. Červené číslo = počet **neprečítaných** notifikácií.

Klikni na zvonček — otvorí sa panel:
- Posledných **30 notifikácií**.
- Neprečítané majú **fialový okraj**, **tučný text** a **fialovú bodku**.
- Prečítané sú vyblednuté.
- **„Označiť všetky"** — označí všetky ako prečítané naraz.

Klik na konkrétnu notifikáciu otvorí súvisiaci kontakt / projekt / správu (vrátane konkrétnej úlohy či komentára, ak sa zmena týkala ich).

> História notifikácií je obmedzená na **150 najnovších** záznamov — staršie sa automaticky odstraňujú.

![Screenshot: zvonček s otvoreným panelom notifikácií](#)

## Sekčné indikátory

V dolnej navigácii (mobil) a v hornej hlavičke (web) sú malé čísla pri ikonách Kontakty / Projekty / Správy. Ukazujú počet neprečítaných notifikácií v danej sekcii.

> Sekcia sa **neoznačí** ako prečítaná, keď do nej len prejdeš. Notifikácia sa označí ako prečítaná až keď otvoríš konkrétnu položku, ktorej sa týka, alebo na ňu klikneš v zvončeku.

## Push notifikácie

Push doručuje notifikáciu, aj keď máš aplikáciu zatvorenú.

| Platforma | Mechanizmus | Funguje |
|---|---|---|
| **Web — Chrome, Firefox, Edge** | Web Push (VAPID) | Áno, treba povoliť |
| **Web — Safari (desktop / iOS)** | — | **Nie, mimo PWA** |
| **PWA pridaná na plochu (iOS Safari)** | Web Push | Áno (iOS 16.4+) |
| **iOS natívna appka** | APNs | Áno |
| **Android natívna appka** | FCM | Áno |

### Prvé povolenie

Pri prvom otvorení po prihlásení (mimo iOS natívnej appky) sa zobrazí baner s otázkou na povolenie push notifikácií. Klikni **Povoliť**.

V iOS natívnej appke ťa systém požiada o povolenie automaticky pri prvom spustení.

### Manuálne zapnutie / vypnutie

Klikni na profil → **Synchronizácia kalendára** → sekcia **🔔 Push notifikácie** (na desktope). Toggle zapne alebo vypne push prihlásenie tohto zariadenia.

## Nastavenia notifikácií (čo má chodiť push)

Klikni na profil → **Nastavenia notifikácií**.

Notifikácie sa delia na dve kategórie:

### Priradené mne (vždy push, **nedá sa vypnúť**)

Sú to udalosti vyžadujúce tvoju pozornosť:
- Niekto ti **priradil** projekt / úlohu / podúlohu.
- Tvoju priradenú úlohu **dokončil iný kolega**.
- Niekto ti poslal **správu**.

### Všeobecné notifikácie (default vypnuté)

Per-toggle prepínače:

| Toggle | Čo zapne |
|---|---|
| **Aktivita tímu** | Push, keď kolegovia upravujú/vytvárajú/dokončujú projekty, úlohy a kontakty, ktoré sa ťa priamo netýkajú. |
| **Pripomienky termínov** | Push 7 / 3 dni / v deň termínu pre tvoje projekty a úlohy. |
| **Po termíne** | Push, keď úloha s termínom prebehla bez dokončenia. |
| **Nový člen workspace** | Push, keď do tvojho prostredia pribudne nový kolega. |

> Aj keď je kategória vypnutá, notifikácia sa **stále zaznamená v zvončeku**. Push len neprichádza na telefón.

![Screenshot: nastavenia notifikácií s 4 prepínačmi](#)

## Časové pripomienky

Pre projekty/úlohy s presným časom (HH:MM) si môžeš nastaviť časové pripomienky (15 min / 30 min / 1 hod / 2 hod / 1 deň pred). Tieto chodia **vždy push**, lebo ich označuješ explicitne. Detaily v [Projekty a úlohy → Pripomienky](./tasks.md#pripomienky).
