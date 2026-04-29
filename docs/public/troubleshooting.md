# Riešenie problémov

## Prihlásenie

### „Server sa nepodarilo prebudiť. Skúste to znova o 30 sekúnd."

Server sa po dlhšej nečinnosti (najmä v noci alebo cez víkend) musí prebudiť. Stáva sa to pri prvom prihlásení po prestávke a trvá zvyčajne 20–30 sekúnd.

**Riešenie:** počkaj 30 sekúnd a klikni **Prihlásiť** znova.

### Pri prihlasovaní cez Google / Apple sa po návrate zobrazí prázdna obrazovka

1. Skontroluj, či máš v prehliadači povolené **cookies tretích strán** pre prplcrm.eu.
2. Skús **iný prehliadač** (Chrome / Firefox / Edge).
3. Ak používaš VPN alebo prísny ad-blocker, vypni ho na čas prihlasovania.

### Nefunguje resetovanie hesla — email neprišiel

1. Skontroluj **Spam** a **Promo** priečinok.
2. Email by mal prísť do 5 minút. Ak nie, požiadaj znova.
3. Ak ti účet vznikol cez Google/Apple a nikdy si si nenastavil heslo, prihlasuj sa cez **Pokračovať s Google/Apple**.
4. Ak nič nefunguje, napíš na **support@prplcrm.eu**.

### Príliš veľa pokusov o prihlásenie

Z bezpečnostných dôvodov je počet neúspešných prihlásení limitovaný (5 na účet a 10 na IP za 15 minút). Po prekročení limitu počkaj 15 minút. Ak svoje heslo nepoznáš, použi **Zabudli ste heslo?**.

## Pracovné prostredie

### Pri vytváraní kontaktu/projektu mi vyskočí „Limit prekročený"

Prekračuješ limit svojho plánu (Free 5 kontaktov, Tím 25 kontaktov atď.). Buď:
- Vymaž staré položky.
- Upgraduj plán v **Profil → Predplatné**.
- Ak si v cudzom prostredí — vlastník musí upgradnúť.

### Niektorí členovia nevidia obsah, hoci sú v rovnakom prostredí

Skontroluj v hlavičke **prepínač pracovných prostredí** — môže byť prepnutý na iné prostredie. Klikni a vyber správne.

### Pozvaný kolega nedostal email s pozvánkou

V **Správa tímu → Čakajúce pozvánky** rozbaľ pozvánku a klikni **Zobraziť odkaz na pozvánku**. Skopíruj URL a pošli ju kolegovi cez chat alebo SMS.

### Chcem opustiť prostredie, ale tlačidlo nie je dostupné

Ak si **Vlastník**, najprv musíš previesť vlastníctvo na iného Manažéra (**Správa tímu → Previesť vlastníctvo**). Až potom môžeš opustiť prostredie.

## Notifikácie a push

### Notifikácie chodia oneskorene alebo neprichádzajú vôbec

1. Skontroluj v **Profil → Nastavenia notifikácií**, že máš zapnutú príslušnú kategóriu.
2. Skontroluj, či máš povolené push v prehliadači:
   - Chrome — adresa na ľavej strane URL pruhu → **Notifikácie → Povoliť**.
   - Firefox — ikona pri URL → **Povoliť notifikácie**.
3. Na iOS Safari mimo PWA push nefunguje (pozri [FAQ](./faq.md)).
4. Na natívnej iOS appke skontroluj **Nastavenia → Prpl CRM → Notifikácie**.

### Sekčné čísla pri ikonách Kontakty/Projekty/Správy nepasujú so zvončekom

Aplikácia synchronizuje sekčné čísla so zvončekom **každých 30 sekúnd**. Ak sa rozišli, počkaj minútu alebo obnov stránku.

### Klik na notifikáciu otvorí zlé prostredie

Notifikácia obsahuje informáciu, do ktorého workspace patrí. Aplikácia by mala automaticky prepnúť — ak nie:
1. Skús kliknúť na notifikáciu znova.
2. Ak stále zle, manuálne prepni prostredie cez prepínač v hlavičke.

## Synchronizácia s Google

### Pripojil som Google Calendar, ale udalosti sa nezobrazili

1. Skontroluj v **Synchronizácia kalendára**, či **máš zaškrtnuté workspaces**, ktoré chceš sync-ovať.
2. Klikni **Synchronizovať** — to ručne nahrá existujúce úlohy.
3. V Google Calendari klikni vľavo na **„Iné kalendáre"** a skontroluj, že vidíš zaškrtnutý kalendár **„Prpl CRM — *"**.

### Vymazal som workspace z Google Calendar — kde sú moje dáta?

Tvoje dáta sú **bezpečne v Prpl CRM**. Odškrtnutie workspace z Google sync vymazáva iba **kópie udalostí v Google Calendari**, nie originálne projekty/úlohy.

### Google Tasks nezobrazuje časy úloh

Google Tasks API **nepodporuje samostatný čas**. Čas sa preto zobrazí v **poznámke** pri úlohe. Toto je obmedzenie Google API, nie chyba aplikácie.

### Označil som úlohu ako hotovú v Google Calendar a v CRM sa to neukázalo

Reverse sync funguje len keď v názve udalosti pridáš „✓ " na začiatok (alebo cez extension property). Manuálne premenovanie samotného textu bez tohto prefixu CRM neinterpretuje ako dokončenie.

## iOS / Android natívna appka

### Po dlhšom skrolovaní v zozname projektov ma to hodí na Dashboard

Tento problém sme už opravili v poslednej verzii. Aktualizuj appku v App Store / Google Play.

### Biela obrazovka po otvorení appky

1. Zavri appku zo zoznamu spustených aplikácií a otvor znova.
2. Skontroluj internetové pripojenie.
3. Aktualizuj appku na najnovšiu verziu.
4. Ako posledná možnosť — odhlás sa, prihlás znova.

### Sign in with Apple — môj email nie je správny

Ak si pri Apple ponechal voľbu **Skryť môj email**, Apple vygeneroval proxy adresu (`@privaterelay.appleid.com`). Reálny email pridáš v **Profil → Môj profil**.

## Súbory

### Pri nahratí súboru sa zobrazí chyba „Súbor je príliš veľký"

Limit je **10 MB / súbor**. Skús súbor:
- Komprimovať (PDF — zmenšiť kvalitu, obrázky — zmenšiť rozlíšenie).
- Rozdeliť na viac častí.
- Nahrať do iného úložiska a v Prpl CRM zdieľať odkaz cez správu / poznámku.

### Súbor som nahral, ale nezobrazuje sa náhľad

Náhľad funguje pre obrázky (JPG, PNG) a PDF. Ostatné formáty (Word, Excel, ZIP) treba **stiahnuť**.

## Predplatné a platby

### Po platbe mi plán neprešiel na Tím / Pro

Synchronizácia s platobnou bránou trvá zvyčajne pár sekúnd. Ak po **5 minútach** plán stále nie je aktualizovaný:
1. Obnov stránku **Profil → Predplatné**.
2. Skontroluj v emaili potvrdenie z platobnej brány.
3. Ak nič — napíš na **support@prplcrm.eu** s číslom transakcie.

### Chcem zrušiť predplatné

V **Profil → Predplatné** klikni **Zrušiť predplatné**. Plán bude aktívny do konca aktuálne zaplateného obdobia, potom prejde späť na **Free**. Tvoje dáta zostávajú nedotknuté.

## Stále nefunguje?

Napíš na **support@prplcrm.eu** s týmito informáciami:
- Email, na ktorý je registrovaný účet.
- Čo si robil, keď sa problém objavil.
- Screenshot chyby, ak je to možné.
- Prehliadač / verzia mobilnej appky / model telefónu.
