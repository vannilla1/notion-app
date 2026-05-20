# Google OAuth Verification — Submission Package

> **Status:** Pripravený na podanie | **Aplikácia:** Prpl CRM | **Web:** https://prplcrm.eu

Tento dokument obsahuje všetko, čo musíš pripraviť pred kliknutím na **Submit for verification** v Google Cloud Console. Po podaní Google odpovie do 2-6 týždňov (sensitive scopes, bez CASA auditu).

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

#### Justification text pre `auth/calendar`

```
Prpl CRM is a B2B CRM system that lets teams manage contacts, projects,
and tasks. We use the full calendar scope (not calendar.events alone)
because we create dedicated secondary calendars per user workspace —
"Prpl CRM — {workspace name}" — so the user's task events are visually
isolated from their personal events in the Google Calendar UI. The
calendar.app.created scope was insufficient because (a) calendarList.list
cannot see app-created calendars without the reader scope, and (b) some
Google Workspace accounts block calendar.app.created by admin policy. We
do NOT read events created by other apps; we only operate on calendars we
created and events with our private extended property (source=prplcrm).
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

1. **OAuth consent flow** — užívateľ klikne „Connect Google Calendar" v Prpl CRM, prejde Google consent screenom (vidno scope-y), schváli
2. **Actual usage** — vidno ako sa CRM tasky reálne objavujú v Google Calendari (jeden create-update-delete cyklus)
3. **Each scope shown in use:**
   - `calendar` — ukázať, že CRM vytvorí samostatný kalendár (v Google Calendar UI v ľavom paneli)
   - `calendar.events` — ukázať vytvorenie udalosti z CRM tasky
   - `tasks` — to isté pre Google Tasks (mobile app alebo Gmail bočný panel)

**Praktický postup:**

1. Otvor **QuickTime Player** na Macu → **File → New Screen Recording**
2. Nahraj cca 60-90 sekundové video s nasledovným scenárom:
   - [00:00-00:15] Otvor prplcrm.eu, prihlás sa
   - [00:15-00:30] Klikni "Pripojiť Google Calendar" → vidno Google consent screen → schvál
   - [00:30-00:50] Vráť sa do CRM, vytvor task s termínom → otvor druhý tab s Google Calendar → vidno udalosť pribudla
   - [00:50-01:10] Zmeň dátum tasky v CRM → vidno že sa v Google Calendar presunula
   - [01:10-01:30] Otvor Google Tasks panel v Gmail → vidno tú istú tasku

3. Upload na YouTube ako **Unlisted** (neviditeľné cez search, ale dostupné cez link)
4. Skopíruj link, vlož ho do Google verifikácie formu

> 💡 Tip: Video môže byť bez voiceoveru, ale potom dopíš krátky text-overlay popisujúci čo sa deje (Final Cut, iMovie, alebo aj OnLine canva).

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
