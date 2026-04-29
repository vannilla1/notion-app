# Synchronizácia kalendára

Prpl CRM ponúka tri spôsoby, ako mať tvoje termíny v externom kalendári. Najsilnejšie je **Google Calendar** (obojsmerná synchronizácia v reálnom čase). Pre Apple Calendar / Outlook / iné slúži **iCal feed**.

Klikni na profil → **Synchronizácia kalendára**.

## Google Calendar

Priame prepojenie s Google Calendar. Zmeny sa prejavia **okamžite**.

### Pripojenie

1. V modálnom okne klikni **Pripojiť Google Calendar**.
2. Prihlás sa do Google a povoľ prístup ku kalendáru.
3. Vrátiš sa do aplikácie — uvidíš zelený indikátor a dátum pripojenia.

### Výber pracovných prostredí

Pre **každé pracovné prostredie** sa dá synchronizácia zapnúť alebo vypnúť samostatne. Pri každom prostredí je checkbox:

- **Zaškrtnutie** — workspace sa zapne na sync. Pre toto prostredie vznikne v Google Calendari samostatný kalendár **„Prpl CRM — názov workspace"** s farbou prostredia. Nové zmeny sa odosielajú do Google **automaticky v reálnom čase**. Existujúce úlohy, ktoré ešte v Google nie sú, jednorazovo nahráš tlačidlom **Synchronizovať**.
- **Odškrtnutie** — všetky udalosti tohto workspace sa **okamžite vymažú z Google Calendara**. **Dáta v Prpl CRM zostanú.**

> ⚠️ **Pozor:** Odškrtnutie alebo „Odpojiť" vymaže udalosti **z Google**. Tvoje projekty a úlohy v Prpl CRM zostávajú nedotknuté.

### Čo sa synchronizuje

Do Google Calendar idú:
- Projekty s termínom — ako celodenné udalosti alebo časové, ak je vyplnený **čas (HH:MM)**.
- Podúlohy s termínom — rovnako.

### Bidirectional dokončenie úloh

Synchronizácia je **obojsmerná aj pre dokončenie**:
- Označenie projektu/úlohy ako **hotovej v CRM** sa premietne do Google Calendara — udalosť dostane prefix „✓ " v názve.
- Označenie udalosti ako **dokončenej v Google Calendar** (úprava názvu na „✓ ...") sa premietne do CRM ako dokončenie projektu/úlohy.

### Odpojenie

V sekcii Google Calendar klikni **Odpojiť Google Calendar**. Kalendáre **„Prpl CRM — *"** sa z Google odstránia. Pripojiť späť môžeš kedykoľvek.

## Google Tasks

Otvorí sa pri tej istej obrazovke ako Google Calendar (sekcia Google Tasks).

### Pripojenie

Klikni **Pripojiť Google Tasks** a povoľ prístup. Logika checkboxov pri prostrediach je identická ako pri Google Calendar.

### Špecifiká

- Úlohy z Prpl CRM sa zobrazia v Google Tasks (panel **Úlohy** vedľa Google Calendara).
- Pred názvom úlohy je prefix **`[Workspace]`**, aby si vedel, z ktorého prostredia je.
- **Google Tasks API nepodporuje samostatný čas** — ak má úloha čas (HH:MM), zobrazí sa **v poznámke** pri úlohe, nie ako oddelené pole.

## iCal feed (Apple Calendar, Outlook, ostatné)

Pre kalendáre, ktoré nepodporujú Google API (Apple Calendar, Outlook, iné), je dostupný **verejný iCal feed**.

### Aktivácia

V obrazovke **Synchronizácia kalendára** v sekcii **iCal feed**:
1. Klikni **Aktivovať**.
2. Skopíruj URL adresu feedu (vyzerá ako `https://prplcrm.eu/api/tasks/calendar/feed/{token}`).
3. V Apple Calendar / Outlook vlož ako **predplatený kalendár** (napríklad v macOS Kalendár → **Súbor → Nový predplatený kalendár**).

### Bezpečnosť

URL adresa obsahuje **tajný token** — komukoľvek, kto ju má, sa zobrazia tvoje termíny.

- Ak token unikol, klikni **Vygenerovať nový token** — pôvodná URL prestane fungovať a vrátiš si ju do svojho kalendára.
- Ak chceš feed úplne vypnúť, klikni **Deaktivovať**.

### Obmedzenia

- iCal feed je **read-only** (z aplikácie do kalendára, nie naopak).
- Apple Calendar / Outlook sa s týmito feedmi obyčajne **nesynchronizujú v reálnom čase** — interval závisí od kalendára (zvyčajne každých 15 min – 1 hod).
