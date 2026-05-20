# Google OAuth Verification — Submission Package

> **Status:** Pripravený na podanie | **Aplikácia:** Prpl CRM | **Web:** https://prplcrm.eu
> **Typ:** RE-verifikácia (verifikácia bola dokončená v minulosti, ale 23.4.2026 sa pridal nový sensitive scope)

Tento dokument obsahuje všetko, čo musíš pripraviť pred kliknutím na **Submit for verification** v Google Cloud Console. Po podaní Google odpovie do 2-6 týždňov (sensitive scopes, bez CASA auditu).

---

## 🔄 Kontext: prečo treba re-verifikáciu

Aplikácia bola pravdepodobne **už úspešne verifikovaná** pre staršie scope-y. Dňa **23.4.2026** sa však scope-ový set zmenil:

| Stará verzia (verifikovaná) | Nová verzia (po commit `683888e`) |
|---|---|
| `calendar.events` (✅ overený) | `calendar.events` (✅ overený) |
| `calendar.app.created` (✅ overený) | **`calendar` (⚠️ NOVÝ, NEoverený)** |
| `tasks` (✅ overený) | `tasks` (✅ overený) |

**Dôvod zmeny:** `calendar.app.created` bol nestabilný (Google Workspace admin politiky ho blokovali, `calendarList.list()` nedovidel app-created kalendáre). Switch na plný `calendar` scope všetko vyriešil — ale zaviedol povinnosť re-verifikovať.

**Google OAuth verifikácia nepokrýva neskôr pridané scopes** — preto tester vidí varovanie pre nový `calendar` scope, aj keď zvyšok aplikácie je formálne verifikovaný.

### Najprv overenie aktuálneho stavu (3 min)

Pred submitnutím urob tento quick-check v Google Cloud Console:

1. Otvor [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Pozri sekciu **App information** → hľadaj badge **„Verified"**:
   - ✅ Ak vidíš zelený badge **„Verified"** → potvrdená predchádzajúca verifikácia; submit pôjde ako **„Update verification request"**
   - ⚠️ Ak NIE je badge alebo vidíš **„Verification in progress"** / **„Issues needed"** → verifikácia nebola dokončená / je rozpracovaná
   - ❌ Ak vidíš **„Not verified"** → submit pôjde ako úplne nová verifikácia
3. Otvor sekciu **Scopes** → skontroluj, ktoré scopes sú formálne overené (zelený štítok pri každom):
   - Predpokladané overené: `email`, `profile`, `openid`, `calendar.events`, `tasks`
   - Predpokladané NEoverené (nový od 23.4): `calendar`

> 💡 Skríns sekcie **Verification status** mi pošli — môžem ti pomôcť interpretovať aký submit Google očakáva.

---

## ⚠️ Prečo to robíme

Aplikácia používa **3 sensitive scopes**, ktoré Google klasifikuje ako citlivé:

| Scope | Účel v Prpl CRM |
|---|---|
| `https://www.googleapis.com/auth/calendar` | Vytváranie samostatných workspace kalendárov ("Prpl CRM — {workspace}") + listovanie kalendárov používateľa |
| `https://www.googleapis.com/auth/calendar.events` | Vytváranie/čítanie/úprava udalostí (CRM úlohy s termínom) |
| `https://www.googleapis.com/auth/tasks` | Synchronizácia CRM úloh s Google Tasks |

Bez verifikácie každý nový používateľ vidí varovanie **„Google hasn't verified this app"** a musí klikať cez „Advanced → Continue (unsafe)". To je obrovská UX bariéra.

Po úspešnej verifikácii varovanie zmizne pre všetkých používateľov.

---

## ✅ Pre-flight checklist (urob TERAZ, pred submitnutím)

### 1. OAuth Consent Screen — branding sekcia

Otvor: **[Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)**

Skontroluj/doplň:

- [ ] **App name:** `Prpl CRM`
- [ ] **User support email:** `support@prplcrm.eu`
- [ ] **App logo:** nahraj 120×120 PNG (použiť `client/public/icons/icon-192x192.png` — orež na štvorec)
- [ ] **Application home page:** `https://prplcrm.eu`
- [ ] **Application privacy policy link:** `https://prplcrm.eu/ochrana-udajov`
- [ ] **Application terms of service link:** `https://prplcrm.eu/vop`
- [ ] **Authorized domains:** `prplcrm.eu` (jeden riadok)
- [ ] **Developer contact information:** `pethobby.sk@gmail.com`

> 💡 Tip: Logo musí byť PNG, štvorec, max 1 MB, žiadny transparentný background (Google to nemá rád).

### 2. Publishing status

Otvor sekciu **Audience** v OAuth consent screen:

- [ ] **Publishing status musí byť `In production`** (NIE `Testing`)
- [ ] **User type:** `External`

Ak je teraz `Testing`, klikni **PUBLISH APP** → potvrď. (Toto NEspustí verifikáciu, len ti dovolí podať žiadosť.)

### 3. Scopes — pridať s justifikáciou

Otvor sekciu **Scopes** v OAuth consent screen:

- [ ] Pridať tieto scopes (klikni `ADD OR REMOVE SCOPES`):
  - `https://www.googleapis.com/auth/calendar`
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/tasks`
  - + ponechaj existujúce: `openid`, `email`, `profile`

Po pridaní každého sensitive scope sa zobrazí pole pre **justification** — vyplň ho takto (pripravený text nižšie 👇):

#### Justification text pre `auth/calendar` (NOVÝ — re-verifikácia)

```
Prpl CRM is a B2B CRM system that lets teams manage contacts, projects,
and tasks. We previously used calendar.app.created for our per-workspace
calendar feature, but switched to the full calendar scope on 2026-04-23
(commit 683888e) because:

1. calendar.app.created is unreliable across Google Workspace accounts —
   many enterprise admin policies block it.
2. calendarList.list cannot enumerate app-created calendars without an
   additional reader scope, so users could not see their workspace
   calendars in our UI.
3. The result was that calendars.insert() succeeded silently-nowhere
   for affected users and events fell back to the user's primary
   calendar — surfacing as a critical "tasks landing in wrong calendar"
   bug that we could not fix without the broader scope.

What we actually do with the calendar scope:
- Create dedicated secondary calendars per user workspace named
  "Prpl CRM — {workspace name}".
- Read calendarList to display these calendars to the user and let
  them choose which workspace syncs to which calendar.
- Set the calendar's color to match the workspace's brand color
  (a UX nicety that calendar.app.created allows but only inconsistently).
- We do NOT modify or read calendars/events that were not created by
  our application. Every event we create carries
  extendedProperties.private.source=prplcrm; we filter on that marker
  in every read operation.
```

#### Justification text pre `auth/calendar.events`

```
Prpl CRM creates calendar events that correspond to CRM tasks with due
dates. When a user creates or updates a task in our CRM, we sync it as a
calendar event so the user can see their tasks in Google Calendar
alongside their meetings. Bidirectional sync: marking a task complete in
Google Calendar reflects back to the CRM. We only read/modify events
created by our app (tagged with extendedProperties.private.source=prplcrm).
```

#### Justification text pre `auth/tasks`

```
Prpl CRM integrates with Google Tasks as an additional sync target. When
a user enables Google Tasks integration, every CRM task with a due date
is mirrored as a Google Task in a dedicated task list named after the
workspace. This lets users see their CRM tasks in the Google Tasks panel
of Gmail/Calendar and check them off from any Google client. We only
manage tasks in task lists we created.
```

### 4. Test users (PREČ DO PRODUCTION)

Ak používaš ešte test users (sekcia **Test users**), môžeš ich nechať tam — po prejdení verifikácie sa stanú nepotrební.

---

## 🎬 Demo video (POVINNÉ pre sensitive scopes)

Toto je najťažšia časť — Google vyžaduje **YouTube video (unlisted)**, ktoré ukáže:

1. **OAuth consent flow** — užívateľ klikne „Connect Google Calendar" v Prpl CRM, prejde Google consent screenom (vidno všetky 3 calendar/tasks scope-y), schváli
2. **Actual usage** — vidno ako sa CRM tasky reálne objavujú v Google Calendari (jeden create-update-delete cyklus)
3. **Each scope shown in use:**
   - `calendar` (NOVÝ — toto je dôležité pre re-verifikáciu) — ukázať, že CRM vytvorí samostatný kalendár ("Prpl CRM — Workspace1") v ľavom paneli Google Calendar UI **+ zmení mu farbu** podľa workspace brand color (toto demonštruje že potrebujeme aj write access na calendar metadata, nie iba app.created)
   - `calendar.events` — ukázať vytvorenie udalosti z CRM tasky (event sa objaví v tom novom kalendári)
   - `tasks` — to isté pre Google Tasks (Gmail bočný panel, vidno task-list "Prpl CRM — Workspace1" + tasky v ňom)

**Praktický postup (90-120s scenár, pre re-verifikáciu zdôraznený nový scope):**

1. Otvor **QuickTime Player** na Macu → **File → New Screen Recording**
2. Nahraj video s nasledovným scenárom:
   - [00:00-00:10] Otvor prplcrm.eu, prihlás sa
   - [00:10-00:25] **Otvor Google Calendar v druhom tabe — ukáž že je ľavý panel "Other calendars" PRÁZDNY** (zatiaľ žiadne workspace cal)
   - [00:25-00:40] V Prpl CRM klikni "Pripojiť Google Calendar" → vidno Google consent screen — **na krátku chvíľu zoom-ni na zoznam scope-ov aby bolo jasne vidno všetky tri** → schvál
   - [00:40-00:55] **Vráť sa do Google Calendar tabu, refresh → vidno že pribudol nový kalendár "Prpl CRM — Workspace1" s farbou** (toto je dôkaz že potrebujeme plný calendar scope)
   - [00:55-01:15] Vráť sa do CRM, vytvor task s termínom → refresh Google Calendar → vidno udalosť v workspace kalendári
   - [01:15-01:35] Zmeň dátum tasky v CRM → refresh Google Calendar → vidno že sa udalosť presunula (a stará zmizla — pekná ukážka že nesvinime kalendár duplicity)
   - [01:35-01:50] Otvor Google Tasks bočný panel v Gmail → vidno task-list "Prpl CRM — Workspace1" + tú istú tasku

3. Upload na YouTube ako **Unlisted** (neviditeľné cez search, ale dostupné cez link)
4. Skopíruj link, vlož ho do Google verifikácie formu

> 💡 **Re-verification špecifické tipy:**
> - V description videa napíš: *"This video demonstrates the newly added `https://www.googleapis.com/auth/calendar` scope (added 2026-04-23) which replaces the previously verified `calendar.app.created` scope. The reason for the change is documented in commit 683888e."*
> - Demo musí jasne odlíšiť **čo nový scope robí**, čo by `calendar.events` sám nedokázal: konkrétne **vytvorenie nového kalendára + zmena jeho farby**.
> - Pre Google reviewerov: tieto schopnosti sú nemožné s iba `calendar.events`, ktorý môže iba modifikovať existujúce kalendáre/eventy.

---

## 📝 Submit verification

Otvor: **OAuth consent screen → Submit for verification** (tlačidlo hore vpravo)

Vyplň formulár:

- **App name:** Prpl CRM
- **Brand verification:** zaškrtni "I've completed the requirements"
- **Sensitive scope usage:** odkazy na justifikácie vyššie
- **Demo video URL:** YouTube unlisted link
- **Description of what the app does:**

```
Prpl CRM is a B2B SaaS CRM system used by small and medium businesses
to manage contacts, projects, tasks, and team collaboration. The Google
Calendar and Google Tasks integrations are optional add-ons that let
users mirror their CRM tasks into their Google productivity stack, so
they don't have to switch between apps to see their pending work.

This submission is a re-verification request following commit 683888e
(2026-04-23) which switched our calendar scope from
calendar.app.created (previously verified) to the broader calendar
scope. The change was necessary because calendar.app.created proved
unreliable across Google Workspace environments — many enterprise
admin policies block it, and calendarList.list cannot enumerate
app-created calendars without an additional reader scope. The result
was production users reporting that their dedicated workspace
calendars never appeared and events fell back into the user's
primary calendar. The broader scope allows us to create the workspace
calendars reliably (including setting their colors), while we maintain
strict Limited Use compliance: every event we create is marked with
extendedProperties.private.source=prplcrm, and we filter on that
marker in every read operation. We never read or modify calendars
or events that we did not create.
```

- **Verification contact email:** `pethobby.sk@gmail.com`

Submit → dostaneš email ID prípadu (napr. `Case ID: 12345678`).

---

## ⏱️ Čo nasleduje

1. **Initial response: 2-3 pracovné dni** — Google ti pošle prvý email (často s otázkami alebo žiadosťou o doplnenie).
2. **Iterations: 1-3 cykly** — odpovedaj rýchlo, do 24h. Každá odpoveď ich resetuje na ďalšie 2-3 dni.
3. **Final approval: 2-6 týždňov** spolu.

Po schválení:

- ✅ Varovanie „Google hasn't verified" zmizne pre VŠETKÝCH používateľov
- ✅ V OAuth consent screene sa zobrazí zelený checkmark „Verified"
- ✅ Tester nemusí robiť nič špeciálne — automaticky uvidí čistý consent screen

---

## 🚨 Časté dôvody zamietnutia (pripravte odpoveď)

| Dôvod | Riešenie |
|---|---|
| **Privacy policy nespomína Google data** | Otvor `client/src/pages/PrivacyPolicy.jsx` — pridaj sekciu "Google API Services User Data Policy compliance" |
| **Demo video nezachytáva všetky scopes** | Prerob video s každým scope-om jasne viditeľným |
| **Logo má transparentný background** | Použiť plný farebný/biely background |
| **Authorized domain nesedí s home page URL** | `prplcrm.eu` musí byť v Authorized domains AJ v Home page URL |

---

## 📎 Pripravené súbory (committed v repe)

- Privacy policy: `client/src/pages/PrivacyPolicy.jsx` → live na https://prplcrm.eu/ochrana-udajov
- Terms: `client/src/pages/TermsOfService.jsx` → live na https://prplcrm.eu/vop
- App logo: `client/public/icons/icon-192x192.png` (downscaluj na 120×120 pred uploadom)

---

## ✋ Pred kliknutím na "Submit"

Spusti tento finálny check:

```bash
# Otestuj že privacy policy a TOS sú dostupné na produkcii
curl -sI https://prplcrm.eu/ochrana-udajov | head -1
curl -sI https://prplcrm.eu/vop | head -1
# Obe by mali vrátiť: HTTP/2 200
```

Ak tieto vracajú 200 → si pripravený **submitnúť**.
