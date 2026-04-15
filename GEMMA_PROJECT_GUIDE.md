# Purple CRM — Kompletný projektový sprievodca pre Gemma

> **Tento dokument je primárny kontext pre lokálny LLM (Google Gemma-4-26B-a4b).**
> Gemma pôsobí ako **skúsený senior programátor**, ktorý projekt kontroluje, debuguje,
> refaktoruje a navrhuje opravy. Súbor pokrýva každú architektonickú vrstvu projektu,
> jeho doménový model, konvencie, technický dlh a pravidlá správania sa pri review.
>
> **Posledná aktualizácia:** 2026-04-15
> **Autor:** Martin Koščo (vlastník) + Claude (assistant)
> **Branch:** `main`, posledný commit pred vytvorením tohto súboru: `3e2da23` (like/dislike reakcie na komentáre)

---

## 0. Rola a pravidlá pre Gemmu

### 0.1 Čo od Gemmy očakávame

Gemma vystupuje ako **top senior full-stack developer** na úrovni staff engineer. Jej hlavné úlohy:

1. **Code review** — kontrolovať nové alebo zmenené súbory, detekovať chyby, bezpečnostné problémy,
   race conditions, pamäťové leaky, N+1 dotazy, chýbajúce workspace scoping a podobne.
2. **Debug** — pri hlásenom probléme identifikovať root cause a lokalizovať súbor + riadok.
3. **Refaktoring** — navrhovať čistejšie, jednoduchšie, výkonnejšie riešenia tam, kde to dáva zmysel
   **za predpokladu, že sa NEZMENÍ pozorovateľné správanie produktu.**
4. **Automatizované testovanie** — hľadať regresie, edge-cases, missing null checks, nekonzistencie
   medzi klientom a serverom.
5. **Návrh opráv** — pri identifikovanom probléme poskytnúť konkrétny patch s diffom (nie len popis).

### 0.2 Absolútne pravidlá — NESMIE sa porušiť

**P1 — Zachovanie funkčnosti.** Gemma **NESMIE navrhovať zmeny, ktoré menia funkčnosť projektu
alebo jeho častí**. Všetky návrhy musia zachovať existujúce user-facing správanie. Ak Gemma nájde
očividne nefunkčné správanie, musí to explicitne označiť ako bug report, nie ako refactor.

**P2 — Workspace scoping.** Každý Mongoose dotaz nad entitami, ktoré patria workspacu
(`Contact`, `Task`, `Message`, `Notification`, `ContactFile`, `Page`, `AuditLog`), **musí filtrovať
podľa `workspaceId`**. Návrh, ktorý tento invariant porušuje, je okamžite zamietnutý.

**P3 — Slovenský UI.** Všetky user-facing stringy (labels, tooltips, error messages) sú v slovenčine.
Gemma nemá prekladať ani prepisovať do angličtiny.

**P4 — Žiadna migrácia na S3.** Súbory sú uložené ako Base64 v MongoDB (limit 10 MB/file). Toto je
vedomé rozhodnutie — Gemma nenavrhuje presun na S3 ani žiadne iné objektové úložisko, pokým o to
vlastník explicitne nepožiada.

**P5 — Žiadna zmena JWT flow ani autentifikácie bez explicitnej požiadavky.** Token sa ukladá
v localStorage na webe a v iOS Keychain. Zmena tohto flow by rozbila prihlásenie naprieč
platformami. Security vylepšenia tohto systému sa navrhujú len ako samostatný návrh s explicitným
upozornením na dopad.

**P6 — Žiadna deštruktívna zmena bez dôvodu.** Gemma nenavrhuje odstraňovať dead code, ktorý
vyzerá nevyužívaný — môže byť volaný cez dynamický import, iOS bridge alebo service worker.
Vždy si najprv overí cez grep.

**P7 — Komentáre v kóde zostávajú.** Komentáre v súboroch (najmä tie začínajúce `// PERF:`,
`// NOTE:`, `// WORKAROUND:`, `// iOS:`) obsahujú kontext o minulých problémoch. Gemma ich
**nikdy neodstraňuje** pri refactoringu.

**P8 — Minimalizmus zmien.** Gemma uprednostňuje najmenšiu možnú zmenu, ktorá rieši problém.
Veľké prepisy sú povolené len ak to explicitne žiadame.

**P9 — Terminológia projektu je zdroj pravdy, nie testy.** Keď Gemma rieši failujúci test
a zistí, že text v teste **nezodpovedá terminológii projektu**, *nesmie* len tak zmeniť
produkčný kód, aby test prešiel. Musí najprv:
1. Overiť cez `read_file` aktuálny UI jazyk (viď §1.3 Terminológia)
2. Porovnať s tým, čo test očakáva
3. Ak sa líšia → test je zastaraný, upraví **test**, nie kód
4. Explicitne to používateľovi oznámiť v výstupe ako „konflikt terminológie"

Testy reflektujú **historický** stav. GEMMA_PROJECT_GUIDE.md reflektuje **aktuálny** stav.
Pri konflikte víťazí guide.

### 0.3 Čo Gemma SMIE robiť bez dopytu

- Opraviť zjavné typo v komentároch, logovacích správach a error messages.
- Opraviť missing null-check, keď by inak nastala `TypeError: Cannot read properties of undefined`.
- Navrhnúť prídavný Mongoose index, ak je query evidentne bez indexu a vidno to z `explain()`.
- Označiť missing `await`, floating promise, unhandled rejection.
- Zachytiť XSS vektor (napr. unsafe HTML injection s user inputom) alebo NoSQL injection.

### 0.4 Výstupný formát review

Keď Gemma robí review, píše výstup takto (v slovenčine):

```
### Zistenie <N>: <krátky názov>
**Súbor:** `path/to/file.js` (riadky 120–145)
**Závažnosť:** critical | high | medium | low | info
**Kategória:** bug | security | performance | a11y | code-smell | tech-debt
**Popis:** <čo je zle a prečo>
**Návrh opravy:**
```diff
- stará verzia
+ nová verzia
```
**Dopad na funkčnosť:** žiadny (refactor) | malý (edge-case bug) | viditeľný pre usera (BUG opraviť)
```

---

## 1. Rýchly prehľad projektu

**Purple CRM** (interne "Perun CRM", doménovo `prplcrm.eu`) je **viac-workspace Slovak-jazykový
team kolaboračný a CRM systém** pre malé tímy (2–20 ľudí). Kombinuje:

- **Kontakty (CRM)** — správa zákazníkov/leadov so status flow
- **Projekty a úlohy** — hierarchia Tasks (→ UI "projekty") s nested Subtasks (→ UI "úlohy"),
  drag-and-drop radenie cez @dnd-kit
- **Odkazy (Messages)** — interný tím messaging systém s approval flow, poľami, komentármi
  a like/dislike reakciami
- **Notifikácie** — real-time socket + push (APNs pre iOS, Web Push pre web/Android)
- **Billing** — Stripe freemium plány (Free / Team / Pro)
- **iOS native app** — tenký SwiftUI wrapper nad WKWebView

**Deployment:** Render.com (frontend ako static site, backend ako Node web service), MongoDB Atlas.
**iOS:** Xcode projekt v `ios/PrplCRM.xcodeproj`, distribuované cez TestFlight → App Store.

### 1.1 Tech stack

| Vrstva | Technológia |
|--------|-------------|
| Frontend | React 18, Vite 5, React Router 6, Axios, Socket.io-client, Chart.js, @dnd-kit |
| Backend | Node.js, Express 4, Socket.IO 4, Mongoose 9, JWT, Winston, Helmet, bcryptjs |
| Databáza | MongoDB Atlas (shared cluster, pool size 10) |
| Cache | ioredis (optional, fallback na in-process Map) |
| Real-time | Socket.IO (user rooms: `user-${userId}`) |
| Push | Custom APNs HTTP/2 (Apple), web-push (VAPID) pre browser |
| iOS | Swift + SwiftUI, WKWebView, Keychain pre JWT, APNs |
| Billing | Stripe Checkout + Billing Portal + Webhooks |
| Integrácie | Google Calendar + Google Tasks (bidirectional sync) |
| Error tracking | Sentry (plánované nahradenie in-house riešením) |
| Deploy | Render.com (auto-deploy z main branch) |
| Testing | Jest + supertest + mongodb-memory-server (server), Vitest + Testing Library (client) |

### 1.2 Adresárová štruktúra (root)

```
notion-app/
├── server/              # Node.js + Express API, Socket.IO, všetka business logika
├── client/              # React 18 + Vite SPA
├── ios/                 # Natívny Xcode projekt PrplCRM (SwiftUI + WKWebView)
├── render.yaml          # Render deployment config (2 web services)
├── package.json         # Root-level, len googleapis + sharp (dev)
├── README.md            # Slovak inštalačné docs
└── GEMMA_PROJECT_GUIDE.md   # TENTO SÚBOR
```

### 1.3 Terminológia projektu (TECHNICKÉ MENO ↔ UI SLOVENSKY)

**Kritické:** Modely v kóde majú iné názvy než ich UI reprezentácia. Pri písaní
user-facing textov (notifikácie, push, error messages, tooltipy) **VŽDY použi UI
terminológiu**. Testy, ktoré tieto texty overujú, musia byť v zhode s touto mapou.

| Model / kód | UI (slovensky) | Poznámka |
|-------------|----------------|----------|
| `User` | používateľ, člen tímu | — |
| `Workspace` | prostredie, tím | UI používa oba podľa kontextu |
| `WorkspaceMember` | člen | — |
| `Contact` | kontakt | — |
| `ContactFile` | príloha kontaktu | — |
| `Task` | **projekt** | Top-level hierarchia, môže mať Subtasks |
| `Subtask` (nested v Task) | **úloha** | Podradené pod Task |
| `Message` | odkaz | Nie "správa" — tento výraz je rezervovaný |
| `Comment` (nested v Message) | komentár | — |
| `Reaction` (nested v Comment) | reakcia (like/dislike) | — |
| `Notification` | notifikácia, upozornenie | — |
| `Page` | stránka | Rich-text editor obsahu |
| `AuditLog` | záznam aktivity | Len pre admin |

**Formát titulkov notifikácií** (viď `server/services/notificationService.js:getNotificationTitle`):
```
"<Actor> <sloveso> <entita>: <názov>"
```
Príklady:
- `Peter vytvoril nový kontakt: Firma ABC`
- `Maria dokončil projekt: Q4 Launch` (Task = projekt!)
- `Admin pridal úlohu: Napísať testy` (Subtask = úloha!)

Ak `relatedName` je null, vynechá sa aj dvojbodka: `Jan upravil projekt`.

Formát **message** (popisu) notifikácie je dlhší, kontextovejší, viď
`getNotificationMessage` v tom istom súbore.

---

## 2. Backend — `server/`

### 2.1 Entry point

**Súbor:** `server/index.js`

**Inicializácia (v tomto poradí):**
1. `dotenv.config()` — načíta `.env`
2. Helmet (security headers), trust proxy (Render/Heroku reverse proxy)
3. Sentry init (ak je `SENTRY_DSN`)
4. CORS s `CORS_ORIGIN` env var (default `https://prplcrm.eu`)
5. Stripe webhook s raw body parser (**MUSÍ byť pred JSON parserom**)
6. JSON/URL-encoded body parser (limit 20 MB — potrebné kvôli Base64 prílohám)
7. Rate limiter (express-rate-limit)
8. HTTP server `.listen(PORT)` — **štartuje PRED pripojením na Mongo** (non-blocking)
9. MongoDB connect na pozadí (connectDB v `config/database.js`, ~60s delay pred štartom jobov)
10. Socket.IO server s rovnakým CORS
11. Registrácia všetkých route súborov
12. Spustenie background jobov (`scheduleDueDateChecks`, `scheduleSubscriptionCleanup`,
    `initializeCalendarWebhooks`, `startGoogleTasksPolling`)

**Serve statických súborov:** `/uploads` cez Express static middleware.

### 2.2 Adresárový layout

```
server/
├── index.js                  # Entry point
├── config/                   # DB, email, Sentry config
│   └── database.js           # mongoose.connect() s pooling
├── models/                   # Mongoose schemy (14 modelov)
├── routes/                   # Express route handlers (~20 súborov)
├── middleware/               # authenticateToken, requireWorkspace, rateLimiter
├── services/                 # notificationService, pushService, emailService, Google sync
├── utils/                    # logger (Winston), Sentry wrapper, helpers
├── __tests__/                # Jest testy (setup.js s mongodb-memory-server)
├── data/                     # Perzistentné JSON state (ignored v nodemon watch)
└── logs/                     # Winston log files (prod only)
```

### 2.3 Kompletný zoznam Mongoose modelov

Všetky modely sú v `server/models/`. Každý obsahuje `workspaceId` okrem čisto užívateľských
(User, Invitation).

#### 2.3.1 `User.js`
Centrálny používateľ. Polia: `email` (unique), `password` (bcrypt hash), `username`,
`role` (user/admin), `currentWorkspaceId`, `subscription` (plan, periodEnd, stripeCustomerId,
stripeSubscriptionId, cancelAtPeriodEnd), `googleCalendar` (accessToken, refreshToken, syncToken,
syncedTaskIds map), `calendarFeedToken`, `notificationsEnabled`, `createdAt`.

#### 2.3.2 `Workspace.js`
Team kontajner. `name`, `slug` (auto-generated, diacritic-normalized), `ownerId`, `inviteCode`
(8-char hex), `inviteCodeEnabled`, `color`, `icon`, `createdAt`. Vlastník (owner) je uložený
priamo tu, ostatní členovia v `WorkspaceMember`.

#### 2.3.3 `WorkspaceMember.js`
Mapa user ↔ workspace + rola. `userId`, `workspaceId`, `role` ∈ `{owner, manager, member}`,
`joinedAt`. Inštančné metódy: `canAdmin()` (owner|manager), `isOwner()`.

#### 2.3.4 `Task.js`
Projekty a úlohy. Hlavné polia: `workspaceId`, `userId` (autor), `contactId` (optional — task
patriaci kontaktu), `title`, `description`, `priority` ∈ `{low, medium, high}`, `status`
(v UI spravidla `completed: boolean`), `dueDate`, `assignedTo: [ObjectId]`, `subtasks: [subtaskSchema]`,
`files: [fileSchema]`, `order` (pre drag-and-drop). Subtask môže rekurzívne obsahovať ďalšie
subtasks.

#### 2.3.5 `Contact.js`
CRM kontakt. `workspaceId`, `userId`, `name` (required), `email`, `phone`, `company`, `website`,
`notes`, `status` ∈ `{new, active, completed, cancelled}`, `tasks: [contactTaskSchema]`
(nested tasks), `files: [fileSchema]`.

**⚠ Pozor:** `Contact.tasks[]` je OSLOBODENÉ od globálnej kontroly `DueDateChecker` — známy
technický dlh, pozri §11.2.

#### 2.3.6 `Message.js` (Odkazy)
Interné správy. `workspaceId`, `fromUserId`/`fromUsername`, `toUserId`/`toUsername`, `type` ∈
`{approval, info, request, proposal, poll}`, `subject` (max 200), `description` (max 5000),
`attachment` (legacy single), `files[]` (viac súborov), `linkedType` ∈ `{contact, task, null}`,
`linkedId`, `linkedName`, `dueDate`, `status` ∈ `{pending, approved, rejected, commented}`,
`rejectionReason`, `pollOptions[]` s `votes[]`, `pollMultipleChoice`, `comments[]`, `readBy[]`,
`resolvedBy`, `resolvedAt`.

**Komentár schéma** (v `Message.js`):
```javascript
const commentSchema = new Schema({
  userId, username, text,
  attachment: { originalName, mimetype, size, data (Base64), uploadedAt },
  reactions: [commentReactionSchema],  // 👍/👎 reakcie
  createdAt
}, { _id: true });
```

**Reakcia schéma:**
```javascript
const commentReactionSchema = new Schema({
  userId, username, type: 'like'|'dislike', createdAt
}, { _id: false });
```

**Invariant:** Každý user môže mať max 1 aktívnu reakciu per komentár (enforcované v route
cez `$pull` → `$push`).

#### 2.3.7 `Notification.js`
Per-user per-workspace notifikácia. `userId`, `workspaceId`, `type` (enum, pozri §6.3),
`title`, `message`, `actorId`, `actorName`, `relatedType` ∈ `{contact, task, subtask, message}`,
`relatedId`, `relatedName`, `data` (Mixed — napr. `{ messageId, commentId, workspaceId }`),
`read: Boolean`, `createdAt`, `expiresAt` (default `now + 30 days`, TTL index).

**Indexy:**
- `{userId:1, read:1, createdAt:-1}` — bell dropdown
- `{userId:1, workspaceId:1, read:1, createdAt:-1}` — badge per sekciu
- `{expiresAt:1}` s `expireAfterSeconds:0` — TTL auto-delete

#### 2.3.8 `PushSubscription.js` (Web Push)
`userId`, `endpoint`, `keys` (p256dh, auth), `userAgent`, `createdAt`.

#### 2.3.9 `APNsDevice.js` (iOS Push)
`userId`, `deviceToken` (hex), `createdAt`, `lastUsedAt`.

#### 2.3.10 `PromoCode.js`
Billing promo kódy. `code`, `percentOff` alebo `amountOff`, `duration`, `stripePromotionCodeId`,
`appliesToPlan`, `expiresAt`, `usageLimit`.

#### 2.3.11 `AuditLog.js`
Audit trail pre admin. `userId`, `workspaceId`, `action` (napr. `contact.created`,
`message.approved`), `details`, `ip`, `userAgent`, `createdAt`.

#### 2.3.12 `Page.js` + `ContactFile.js` + `Invitation.js`
Notion-like pages (legacy z počiatku projektu), metadáta súborov, email/link invites.

### 2.4 Kompletný zoznam route súborov

Každý súbor je registrovaný v `server/index.js` cez `app.use('/api/...', router)`. Väčšina
endpointov vyžaduje `authenticateToken` + `requireWorkspace`.

| Súbor | Base URL | Hlavné endpointy |
|-------|----------|------------------|
| `auth.js` | `/api/auth` | POST `/register`, POST `/login`, POST `/logout`, GET `/me`, POST `/change-password` |
| `contacts.js` | `/api/contacts` | CRUD + POST `/:id/tasks`, PUT/DELETE `/:id/tasks/:taskId`, CSV export |
| `tasks.js` | `/api/tasks` | CRUD + subtasks CRUD + PUT `/reorder` (drag-and-drop) |
| `messages.js` | `/api/messages` | CRUD + `/:id/approve`, `/:id/reject`, `/:id/comment`, `/:id/comment/:commentId/reaction`, `/:id/vote` |
| `notifications.js` | `/api/notifications` | GET list, PUT `/read-for-related`, GET `/unread-by-section`, GET `/unread-by-workspace` |
| `workspaces.js` | `/api/workspaces` | CRUD + `/switch/:id`, `/join`, `/leave`, `/current`, invite management |
| `push.js` | `/api/push` | POST `/subscribe` (VAPID), POST `/apns/register` (iOS token) |
| `billing.js` | `/api/billing` | POST `/checkout`, GET `/portal`, POST `/webhook` (Stripe), GET `/status` |
| `admin.js` | `/api/admin` | Admin-only endpointy (user list, workspace list, metrics) |
| `googleCalendar.js` | `/api/google-calendar` | OAuth flow, sync, webhook receive |
| `googleTasks.js` | `/api/google-tasks` | Sync, polling config |

**Middleware hierarchia:**
- `authenticateToken` — overí JWT z `Authorization: Bearer`, pripojí `req.user`
- `requireWorkspace` — overí že user má `currentWorkspaceId` a pripojí `req.workspaceId`
  (**toto je kľúčový guard pre tenancy isolation**)
- `requireAdmin` / `requireOwner` / `requireManager` — role guardy pre admin endpointy

### 2.5 Middleware

**Súbory v `server/middleware/`:**

- **`auth.js`** — `authenticateToken(req, res, next)`. Číta `Authorization: Bearer <token>`,
  overí JWT cez `jwt.verify(token, JWT_SECRET)`, načíta User z DB (alebo z Redis cache, ak je
  dostupný — pozri `userCache.js` v services), pripojí `req.user`. Ak nie je token alebo je
  neplatný → 401 a prepadne na frontend `api.js` interceptor, ktorý vyhodí token z localStorage.

- **`requireWorkspace.js`** — overí `req.user.currentWorkspaceId`, načíta WorkspaceMember
  pre aktuálneho usera a workspace, pripojí `req.workspaceId` a `req.workspaceRole`. Bez
  aktívneho workspace-u dostáva user 403 a frontend ukáže `WorkspaceSetup`.

- **`rateLimiter.js`** — express-rate-limit. V dev je skipnutý (`SKIP_RATE_LIMIT=true`).
  V prod: 100 requestov / 15 min per IP na neautentifikovaných, 1000 / 15 min na autentifikovaných.

### 2.6 Services

**Súbory v `server/services/`:**

- **`notificationService.js`** (najkritickejší). Verejné funkcie:
  - `createNotification({ userId, workspaceId, type, title, message, ... })` — vytvorí doc,
    emituje socket udalosť `notification` do room `user-${userId}`, na `setImmediate` spustí
    fire-and-forget web-push a APNs send (push môže trvať 5–15s, nesmie blokovať HTTP response).
  - `buildDeepLinkUrl(type, data)` — zostaví URL pre push click handler
    (`/messages?highlight=X&comment=Y` atď.).

- **`pushService.js`** (alebo podobný) — APNs HTTP/2 klient s exponential backoff, web-push send.

- **`dueDateChecker.js`** — cron-like scheduler, každých X minút pozerá tasky s blížiacim sa
  `dueDate` a posiela `task.dueDate`/`subtask.dueDate` notifikácie. **⚠ NEVIDÍ
  `Contact.tasks[]` — známy dlh.**

- **`subscriptionCleanup.js`** — periodicky kontroluje Stripe subscription status a updatuje
  `User.subscription`.

- **`emailService.js`** / **`adminEmailService.js`** — Nodemailer SMTP. Invite emaily,
  admin reporty.

- **`googleCalendarSync.js`** / **`googleTasksSync.js`** — OAuth2 + googleapis SDK.
  Obojsmerný sync, incremental cez `syncToken`, webhook push notifications z Google.

- **`userCache.js`** — Redis-backed cache na `User` objekty (TTL 5 min), aby `authenticateToken`
  nerobil Mongo round-trip na každý request.

### 2.7 Socket.IO

Server inštanciuje `io` v `index.js` a pripojí ho k HTTP serveru. Prístupný v route-ch cez
`req.app.get('io')`.

**Room model:**
- Pri connection klient posiela JWT → server ho overí → `socket.join(`user-${userId}`)`.
- **V súčasnosti neexistuje room per workspace** — `io.emit('contact-updated', ...)` broadcasts
  všetkým pripojeným klientom naprieč workspace-mi. Známy bezpečnostný dlh — pozri §11.4.

**Emitované udalosti (serverom):**

| Udalosť | Room / Target | Zdroj | Popis |
|---------|---------------|-------|-------|
| `notification` | `user-${userId}` | notificationService | Nová notifikácia pre usera |
| `contact-updated` / `contact-created` / `contact-deleted` | broadcast | contacts.js | CRUD kontaktu |
| `task-updated` / `task-created` / `task-deleted` | broadcast | tasks.js | CRUD tasku |
| `message-updated` | `user-${otherUserId}` | messages.js | Komentár, reakcia, approval change |

**Klient hooks:** `useSocket()` (client/src/hooks/useSocket.js) vracia `{ socket, isConnected, registerListener }`.

### 2.8 Autentifikácia a autorizácia

**JWT:**
- Payload: `{ userId, email, username, iat, exp }`
- Secret: `JWT_SECRET` env var (musí mať ≥32 znakov — enforcované pri boot).
- Expirácia: 30 dní (ak sa zmení, treba zrátať UX dopad — iOS user bude musieť zadať Face ID).
- Uloženie: `localStorage.token` (web), iOS Keychain (ContentView.swift).

**Autorizácia:**
- **Workspace role** — owner > manager > member. Guardy na úrovni route middleware.
- **Owner** môže zmazať workspace, meniť billing, regenerovať invite code.
- **Manager** môže pozývať členov a editovať obsah všetkých členov.
- **Member** môže CRUD nad svojím obsahom, čítať cudzí. Nemôže pozývať.

### 2.9 Background jobs

Spúšťané z `index.js` po ~60s delay (aby sa nehromadili spojenia počas Mongo connect):

1. `scheduleDueDateChecks()` — každých N minút
2. `scheduleSubscriptionCleanup()` — Stripe status check
3. `initializeCalendarWebhooks()` — obnovenie Google Calendar push subscribe
4. `startGoogleTasksPolling()` — každých 5 minút sync s Google Tasks (nemajú webhooks)

### 2.10 Konfiguračné env premenné

**Server** — načítava z `process.env` cez dotenv:

| Premenná | Povinné | Default | Popis |
|----------|---------|---------|-------|
| `NODE_ENV` | Nie | development | production|development|test |
| `PORT` | Nie | 5001 | HTTP listen port |
| `MONGODB_URI` | **Áno** | — | MongoDB Atlas connection string |
| `JWT_SECRET` | **Áno** | — | Min 32 znakov; 64-byte base64 ideal |
| `CORS_ORIGIN` | **Áno** | `https://prplcrm.eu` | Comma-separated origins |
| `LOG_LEVEL` | Nie | info | error|warn|info|http|verbose|debug |
| `SENTRY_DSN` | Nie | — | Ak prázdne, Sentry disabled |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Podmienečne | — | Web Push |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_KEY_PATH` | Podmienečne | — | iOS push |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Podmienečne | — | Billing (503 ak chýba) |
| `STRIPE_PRICE_TEAM_MONTHLY` atď. | Podmienečne | — | Price IDs pre plány |
| `REDIS_URL` | Nie | — | Ak chýba, fallback na Map cache |
| `SKIP_RATE_LIMIT` | Nie | — | `true` v dev pre prechod cez rate limit |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Nie | — | Calendar/Tasks OAuth |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Nie | — | Email |

**Client** — `import.meta.env.VITE_*` (public):
- `VITE_API_URL` (default `http://localhost:5001`)
- `VITE_SENTRY_DSN` (public frontend DSN)

---

## 3. Frontend — `client/`

### 3.1 Tech stack a build

- **React 18.2** (concurrent rendering), **React Router 6.20**, **Vite 5.0**
- **Axios** HTTP client s 3× retry na network/timeout/503, 401 handler vyhadzuje token
- **Socket.io-client 4.7** s reconnectom (max 5×, 1s delay)
- **@dnd-kit** (core, sortable, modifiers) pre drag-and-drop
- **Chart.js 4** + `react-chartjs-2` pre admin dashboards
- **Sentry (@sentry/react)** — disabled v iOS native app (memory)
- **vite-plugin-pwa** + workbox-window pre service worker

**Build output:**
- `dist/` → static Render service
- Manuálne chunks: `react-vendor`, `sentry`, `socket` (izolácia pre WKWebView caching)
- Per-route lazy loading cez `React.lazy()` (povinnosť kvôli iOS memory limit)

**Dev:**
- Vite server port 3000, proxy `/api/*` → `http://localhost:5001`

### 3.2 Adresárový layout

```
client/src/
├── api/
│   ├── api.js              # Axios instance, 401 handler, retry
│   ├── workspaces.js       # Workspace CRUD wrapper
│   └── adminApi.js         # Admin-only endpointy
├── components/              # 27 komponentov — pozri §3.6
├── context/
│   ├── AuthContext.jsx     # user, token, login/logout/register
│   └── WorkspaceContext.jsx # workspaces, switchWorkspace, needsWorkspace
├── hooks/
│   ├── useSocket.js
│   └── useContactOperations.js
├── pages/                   # 13 lazy-loaded pages — pozri §3.4
├── services/
│   └── pushNotifications.js # VAPID subscribe, SW registration
├── styles/
│   └── index.css           # 11,000+ riadkov — CSS vars, utility classes, layout
├── utils/
│   ├── platform.js         # isIosNativeApp()
│   ├── sentry.js           # initSentry() s iOS guard
│   ├── fileDownload.js     # downloadBlob() s iOS bridge fallback
│   ├── formatters.js, constants.js, validators.js, linkify.js
└── main.jsx                 # Entry: Sentry init, AuthProvider, BrowserRouter
```

### 3.3 Routing (App.jsx)

Všetky routes sú v `client/src/App.jsx`. Route guard = existencia tokenu v `AuthContext`.

| Path | Komponent | Auth | Popis |
|------|-----------|------|-------|
| `/` | LandingPage | public | Verejná landing page |
| `/login` | Login | public | Redirect `/app` ak autentifikovaný |
| `/app` | Dashboard | yes | Home/overview |
| `/crm` | CRM | yes | Kontakty |
| `/tasks` | Tasks | yes | Projekty/úlohy |
| `/messages` | Messages | yes | Odkazy (interná komunikácia) |
| `/workspace/members` | WorkspaceMembers | yes | Tím manažment |
| `/app/billing` | BillingPage | yes | Predplatné |
| `/invite/:token` | AcceptInvite | public | Prijatie pozvánky |
| `/admin` | AdminLogin | public | Admin login |
| `/admin/dashboard` | AdminPanel | public (internal check) | Admin only |
| `/ochrana-udajov` | PrivacyPolicy | public | — |
| `/vop` | TermsOfService | public | — |

### 3.4 Pages — čo kde žije

#### Dashboard (`pages/Dashboard.jsx`)
Úvodná stránka. Súhrn kontaktov, taskov, pending správ. Debounced socket refresh (300 ms).

#### CRM (`pages/CRM.jsx`)
Zoznam + detail kontaktov. Deep-link params: `?expandContact={id}`, `?highlightTask={id}`,
`?subtask={id}`. Globálne tasky (nepriradené ku kontaktu) zobrazené sekcii. Filter podľa statusu,
CSV export, drag-and-drop, 24h "new/modified" highlight.

#### Tasks (`pages/Tasks.jsx`)
Projekty + tasky + subtasky. Drag-and-drop (dnd-kit), expand/collapse, kalendárový pohľad
(month/week/day), priority a due-date farby. Deep-link: `?highlightTask={id}&subtask={id}&contactId={id}`.

#### Messages (`pages/Messages.jsx`)
Odkazy (interné správy). 5 typov (approval/info/request/proposal/poll), 4 statusy, komentáre
s reactiami (👍/👎), prílohy. Deep-link: `?highlight={id}&comment={id}`. Pollová funkcionalita
s hlasovaním.

#### Ostatné
- **Login** — email/password form, volá `useAuth().login()`
- **LandingPage** — verejná, SEO
- **BillingPage** — plan info, upgrade CTA, Stripe checkout redirect
- **WorkspaceMembers** — list + invite + role change
- **AcceptInvite** — invite token acceptance flow
- **AdminLogin** / **AdminPanel** — admin only
- **PrivacyPolicy** / **TermsOfService** — SK legal

### 3.5 Contexts

#### AuthContext
Expose: `user`, `token`, `loading`, `isAuthenticated`, `login()`, `register()`, `logout()`, `updateUser()`.
Perzistencia: `localStorage.token`. Axios interceptor `401|403 → clear token → navigate('/login')`.

#### WorkspaceContext
Expose: `workspaces[]`, `currentWorkspace`, `currentWorkspaceId`, `loading`, `needsWorkspace`,
`createWorkspace()`, `joinWorkspace()`, `switchWorkspace()`, `updateWorkspace()`,
`regenerateInviteCode()`, `leaveWorkspace()`, `refreshCurrentWorkspace()`.

**Kľúčové:** `switchWorkspace()` dispatchuje `window.CustomEvent('workspace-switched')`. Každá
page (CRM, Tasks, Messages) na to reaguje refetchom + zatvorením otvorených modálov. Rieši
race condition pri deep-link notifikácii do iného workspace.

### 3.6 Hooks

- **`useSocket()`** — socket.io-client instance, pripojenie s tokenom, reconnect (max 5×, 1s delay).
  Export: `{ socket, isConnected, joinPage, leavePage, registerListener }`.
- **`useContactOperations()` / `useTaskOperations()`** — CRUD helpery pre kontakty a tasky
  (globálne aj kontaktové). `isGlobal` flag prepína endpoint.

### 3.7 Komponenty (vybrané)

| Komponent | Súbor | Zodpovednosť |
|-----------|-------|--------------|
| BottomNav | `BottomNav.jsx` | Mobile bottom nav, badge counts z props |
| NotificationBell | `NotificationBell.jsx` | Zvonček s dropdownom, fetch last 30, mark-as-read, navigate |
| NotificationToast | `NotificationToast.jsx` | Ephemeral toast (5s auto-dismiss), listener na socket `notification` |
| WorkspaceSwitcher | `WorkspaceSwitcher.jsx` | Dropdown prepínača, farba + unread count per workspace |
| ContactCard / ContactDetail / ContactForm | — | CRM kontakt UI |
| TaskList | `TaskList.jsx` | Tasky s drag-drop, subtasks, inline edit |
| UserMenu | `UserMenu.jsx` | Profil, settings, sync calendar, logout (55 KB — veľa settings) |
| HelpGuide | `HelpGuide.jsx` | In-app help panel s tipmi |
| FilePreviewModal / FilePreviewImage | — | Image/PDF preview, full-screen |
| WorkspaceSetup | `WorkspaceSetup.jsx` | Ak user nemá workspace — force setup |
| ErrorBoundary | `ErrorBoundary.jsx` | React error boundary s fallback UI |
| PushNotificationToggle | `PushNotificationToggle.jsx` | Enable/disable web push |

### 3.8 API klient

**`client/src/api/api.js`:**

```javascript
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5001',
  timeout: 60000  // 60s pre Render cold start
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor:
// - timeout/network/503 → retry max 3× (3s, 6s, 9s)
// - 401/403 → localStorage.removeItem('token') + redirect /login
// - blob responses skip retry
```

### 3.9 Deep link & push notification handling

Tri cesty ako prichádzajú deep linky:

1. **Cold start** (užívateľ tapne push, app je killnutá) — Swift extrahuje `url` z APNs
   payloadu, nastaví `pendingDeepLink`, ContentView direct-loaduje URL (namiesto default `/app`).
   `App.jsx` `useLayoutEffect` detekuje `?ws=` param a switchne workspace PRED child page
   effectmi — tie by inak stripli URL param.

2. **Hot start** (app bola na pozadí) — Swift dispatchuje `window.dispatchEvent(new
   CustomEvent('iosDeepLink', { detail: path }))`. `App.jsx` handler volá `navigateWithWorkspace(path)`.

3. **Web push click** — service worker posle `{ type: 'NOTIFICATION_CLICK', url, data }` do hlavného
   okna. `App.jsx` listener parsuje URL a volá `navigateWithWorkspace()`.

**`navigateWithWorkspace(rawPath)`** (App.jsx:60–84):
- Parsuje URL, extrahuje `ws=`.
- Ak `ws` ≠ current a user je člen — `await switchWorkspace(ws)` predtým ako naviguje.
- Strippne `ws=` z URL (je to transport hint, nie page param).
- `navigate(cleanPath, { replace: true })`.

**URL parametre a ich význam:**

| Param | Page | Efekt |
|-------|------|-------|
| `expandContact={id}` | `/crm` | Auto-expand kontaktu |
| `highlightTask={id}` | `/tasks` alebo `/crm` | Highlight tasku |
| `subtask={id}` | `/tasks` | Expand subtasku |
| `highlight={id}` | `/messages` | Highlight správy |
| `comment={id}` | `/messages` | Scroll na komentár + highlight |
| `ws={id}` | akákoľvek | Workspace hint (stripnuté pred nav) |
| `_t={timestamp}` | akákoľvek | Cache-bust (force re-render aj pri rovnakom path-e) |

### 3.10 Synchronizácia notifikačných counts

1. **Initial load** (App.jsx:88–93): `GET /api/notifications/unread-by-section` → `{crm, tasks, messages}`.
2. **Bottom nav** zobrazuje badge counts.
3. **Socket `notification` event** — handler v App.jsx **vždy inkrementuje** badge (aj keď je
   user na tej sekcii) — "byť na liste != mať prečítané". Mark-as-read sa deje len pri otvorení
   konkrétnej položky alebo cez bell.
4. **Mark as read** — Messages/CRM/Tasks volajú `PUT /api/notifications/read-for-related`
   keď sa `expandedTask` / `expandedContact` / `selectedMessage` zmení na non-null.
   Dispatch `window.dispatchEvent(new Event('notifications-updated'))` → App.jsx refetchne
   unread counts.

**Custom eventy:**

| Event | Dispatcher | Listeners |
|-------|-----------|-----------|
| `notifications-updated` | Any page (mark-as-read) | App.jsx (refetch), NotificationBell |
| `workspace-switched` | WorkspaceContext.switchWorkspace() | CRM, Tasks, Messages, Dashboard |
| `app-resumed` | App.jsx visibilitychange (hidden > 3s) | Všetky pages (refetch) |
| `iosDeepLink` | Swift (hot start) | App.jsx |
| `notificationSettingChanged` | UserMenu | NotificationToast |

### 3.11 Styling

- CSS variables v `:root` (`--bg-primary`, `--accent-color: #6366f1` indigo brand, `--radius`, ...)
- Utility classes (`.btn`, `.btn-primary`, `.card`, `.modal-overlay`)
- Žiadny CSS-in-JS framework — classic CSS súbory + inline style props
- **Dark mode zatiaľ nie je implementovaný** (CSS vars to umožňujú, len chýba JS toggle)

### 3.12 Dôležité komentáre v kóde

Hľadaj a zachovaj:
- `// PERF:` — performance optimalizácie (napr. atomic $push namiesto save(), projection bez Base64)
- `// NOTE:` — kontext rozhodnutia (napr. prečo sa notifikácie markujú read len pri otvorení položky)
- `// iOS:` / `// WKWebView:` — iOS-specific workaroundy
- `// WORKAROUND:` — dočasné hacky s popisom dôvodu

Príklad z App.jsx:124-129 popisuje, prečo sme odstránili auto-mark-as-read pri tapnutí sekcie —
kedysi sa všetky notifikácie sekcie označili za prečítané aj keď user reálne ani jednu neotvoril;
teraz sa značkujú len pri otvorení konkrétnej položky alebo kliknutí vo zvončeku.

---

## 4. iOS native app — `ios/PrplCRM/`

### 4.1 Štruktúra

```
ios/
├── PrplCRM.xcodeproj/          # Xcode projekt (target: PrplCRM)
└── PrplCRM/
    ├── PrplCRMApp.swift        # @main, AppDelegate, PushNotificationManager
    ├── ContentView.swift       # SwiftUI root, WebView UIViewRepresentable, Coordinator
    ├── KeychainHelper.swift    # Secure token storage (Security framework)
    ├── Info.plist              # Capabilities, usage descriptions
    ├── PrplCRM.entitlements    # aps-environment=development
    └── Assets.xcassets/         # App icons, colors
```

**Bundle identifier:** `sk.perunelectromobility.prplcrm`
**Name:** Prpl CRM, **Version:** 1.0 (build 4)
**Development Region:** sk
**Base URL:** `https://prplcrm.eu/app`

### 4.2 Launch flow

1. `@main struct PrplCRMApp` boot cez SwiftUI `@UIApplicationDelegateAdaptor`
2. `AppDelegate.didFinishLaunchingWithOptions`:
   - `UIApplication.shared.registerForRemoteNotifications()`
   - `UNUserNotificationCenter` permission request (alert, badge, sound)
   - **Kľúčové:** extrahuje cold-start deep link z `launchOptions` a nastaví
     `pushManager.pendingDeepLink` **synchrónne** (nie na `DispatchQueue.main.async`!) — aby
     ContentView.makeUIView videl link pred prvým renderom
3. `ContentView` renderuje WebView s URL = pendingDeepLink ?? `https://prplcrm.eu/app`
4. `ContentView.onAppear` — ak Keychain má token, show Face ID lock

### 4.3 WKWebView konfigurácia (ContentView.swift:267–431)

```swift
config.allowsInlineMediaPlayback = true
config.mediaTypesRequiringUserActionForPlayback = []
config.preferences.javaScriptCanOpenWindowsAutomatically = true
webView.allowsBackForwardNavigationGestures = false   // iOS: disable edge swipe
webView.scrollView.bounces = false                    // bounce deje dnu v `.crm-main`
webView.scrollView.contentInsetAdjustmentBehavior = .never
webView.backgroundColor = UIColor(red: 99/255, green: 102/255, blue: 241/255)  // brand indigo
customUserAgent = "PrplCRM-iOS/1.0 <default UA>"
```

### 4.4 WKUserScripts

**At document start** (ContentView.swift:311–332) — **token restoration**:
```swift
if let savedToken = KeychainHelper.getToken() {
    let restoreScript = WKUserScript(
        source: "if (!localStorage.getItem('token')) { localStorage.setItem('token', '\(escapedToken)'); }",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
}
```

**⚠ Guard `if (!localStorage.getItem('token'))` je KĽÚČOVÝ.** Bez neho by sa stale Keychain
token re-injektol pri každom reload a prepísal by fresh token po login. Commit `b4fde4a` fixol
tento bug (user sa musel re-loginovať po každom workspace switchi).

**At document end** — **safe area CSS + auth bridge**:
- CSS vars `--sat`, `--sab`, `--sal`, `--sar` pre safe area insets
- Pridá class `ios-app` na `<body>`
- JS watcher na `localStorage.setItem('token', ...)` → postMessage `{ type: 'authToken', token }` do native
- JS watcher na `localStorage.removeItem('token')` → postMessage `{ type: 'logout' }` do native
- Fallback polling 3s / 30s

### 4.5 Bridge — Swift ↔ JS

**Message handlers** (registered v Coordinator.userContentController):

| Handler | Z JS do Swift | Efekt |
|---------|---------------|-------|
| `iosNative` | `{ type: 'authToken', token }` | `KeychainHelper.saveToken()` + trigger APNs register |
| `iosNative` | `{ type: 'logout' }` | `KeychainHelper.deleteToken()` + clear `pushManager.authToken` |
| `fileDownload` | `{ data: base64, fileName, mimetype }` | Share sheet cez UIActivityViewController |
| `openExternal` | URL string | Safari open (pre Stripe redirect) |

### 4.6 Push notifications (APNs)

**Flow:**
1. AppDelegate: `registerForRemoteNotifications()` → iOS volá `didRegisterForRemoteNotificationsWithDeviceToken`
2. Device token hex → uložené v UserDefaults (kľúč `deviceToken`)
3. Keď je k dispozícii aj `authToken`, POST `https://perun-crm-api.onrender.com/api/push/apns/register`
4. Retry s exponential backoff (2s, 4s, 8s, 16s, 32s) max 5×; 401 stopne registráciu

**Notification tap handler** (`userNotificationCenter(_:didReceive:)`):
- Extrahuje `url` (alebo skonštruuje z `type` + IDs) z `userInfo`
- Nastaví `pushManager.pendingDeepLink` **synchrónne**
- Reset badge na 0

**Foreground (app open):** `willPresent` ukáže banner + list + badge + sound.

### 4.7 Memory recovery (kritické pre iOS)

**Problém:** WKWebView WebContent process môže byť killnutý kvôli jetsam (memory pressure).
Výsledok: biela obrazovka alebo "scroll jumps to dashboard" bug (page reload na `/app`).

**Fixy v kóde:**
1. `webView(_:didCommit:)` — ukladá `lastURL` po každej úspešnej navigácii
2. `webViewWebContentProcessDidTerminate(_:)` — loaduje `lastURL` namiesto hardcoded `/app`
3. Memory warning observer (`UIApplication.didReceiveMemoryWarningNotification`) — len logging

**Frontend mitigácie (aplikované cez web build):**
- Sentry **DISABLED** v iOS (detekcia cez custom UA `PrplCRM-iOS/`)
- Lazy-loaded React routes
- Manuálne chunks v Vite (`react-vendor`, `sentry`, `socket`)

### 4.8 Keychain (KeychainHelper.swift)

- Service ID: `sk.perunelectromobility.prplcrm`
- Account: `authToken`
- Accessibility: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
- Metódy: `saveToken(token)`, `getToken() -> String?`, `deleteToken()`

### 4.9 App Store stav

- Aktuálne: `aps-environment=development` (dev APNs)
- Pre App Store: zmeniť na `production`, regenerovať provisioning profile ako **App Store**
- Posledný známy problém: contracts error pri upload (user session — netýka sa súčasného stavu)
- Checklist na vydanie v memory: `/Users/martinkosco/.claude/projects/.../memory/appstore_release_plan.md`

---

## 5. Deployment & infraštruktúra

### 5.1 Render.com (`render.yaml`)

Dva web services, región **frankfurt**:

**Backend `prpl-crm-api`** (web service):
- Runtime: node
- Root: `server/`
- Build: `npm ci --omit=dev`
- Start: `node index.js`
- Health check: `GET /health`
- Env vars: `NODE_ENV=production`, `JWT_SECRET` (auto-gen), `CORS_ORIGIN`, `MONGODB_URI`,
  `VAPID_*`, `SENTRY_DSN`, Stripe keys (synced z Render dashboardu).

**Frontend `prpl-crm`** (static site):
- Runtime: static
- Root: `client/`
- Build: `npm install && npm run build`
- Publish: `dist/`
- SPA rewrite: všetky routes → `/index.html`
- Cache: `Cache-Control: no-cache` pre `/*`

**Auto-deploy:** Render spúšťa build na každý push do `main`.

### 5.2 Scripts

**Server (`server/package.json`):**
- `npm start` → `node index.js`
- `npm run dev` → `nodemon --ignore data/ index.js`
- `npm test` / `test:watch` / `test:coverage` — Jest

**Client (`client/package.json`):**
- `npm run dev` → vite na porte 3000, proxy `/api/*`
- `npm run build` → `vite build` → `dist/`
- `npm run preview` → `vite preview`
- `npm test` / `test:ui` / `test:coverage` — Vitest

**Root (`package.json`):**
- Len deps `googleapis`, `sharp` (dev) — bez scriptov.

### 5.3 Testing

**Server** — Jest + supertest + mongodb-memory-server (`__tests__/` priečinok, setup v `__tests__/setup.js`).

**Client** — Vitest + @testing-library/react, jsdom env, setup v `src/test/setup.js`.

**Coverage** — generované cez `--coverage` flagy, neexistuje CI gate.

### 5.4 CI/CD

- **Žiadne GitHub Actions.**
- Deploy flow: `git push origin main` → Render auto-deploy oboch services.
- Žiadne husky/lint-staged hooky.
- Žiadne ESLint/Prettier configy (skontrolovať pri review — dôvod pre code style drift).

### 5.5 Logging a monitoring

**Winston (`server/utils/logger.js`):**
- Levels: error, warn, info (default), http, verbose, debug
- Dev: colorized console
- Prod: JSON console + súbory (`logs/error.log`, `logs/combined.log`, rotácia 5MB × 5)
- Helpers: `logger.http()`, `logger.auth()`, `logger.socket()`

**Sentry:**
- Server: `SENTRY_DSN`, sample rate 0.1 v prod, 1.0 v dev, `beforeSend` filtruje heslá
- Client: `VITE_SENTRY_DSN`, replay v prod 0.1, **vypnuté v iOS native**

**Plán na vlastný error tracker** (v AdminPanel) — čaká na potvrdenie iOS stability. Referencia
v `/Users/martinkosco/.claude/projects/.../memory/inhouse_error_tracking_plan.md`.

---

## 6. Doménový model a business logika

### 6.1 Workspace a tenancy

**Multi-tenancy:** Každý user môže byť v 0..N workspace-och. Aktuálny workspace je v
`user.currentWorkspaceId`. **Každý dotaz, ktorý číta/zapisuje workspace-scoped entitu, musí
filtrovať `workspaceId`**. Toto je najčastejší zdroj security chýb.

**Role:** owner (1 per workspace, vlastník) > manager > member.

**Invite flow:** owner/manager generuje 8-char hex `inviteCode`, pošle link
`/invite/{inviteCode}`. AcceptInvite page overí kód, user joinne s rolou `member`.

**Workspace switching:**
- UI: `WorkspaceSwitcher` dropdown
- API: `POST /api/workspaces/switch/:id` → update `user.currentWorkspaceId`
- Frontend: `WorkspaceContext.switchWorkspace()` → dispatch `workspace-switched` event
- Všetky pages listen → refetch + close otvorené modály

### 6.2 Plány a limity

| Plán | Cena/mes | Cena/rok | Kontakty | Projekty/kontakt | Členovia | Workspaces |
|------|----------|----------|----------|------------------|----------|------------|
| Free | 0 € | 0 € | 5 | 10 | 2 | 1 |
| Team | 4.99 € | 49 € | 25 | 25 | 10 | 2 |
| Pro | 9.99 € | 99 € | ∞ | ∞ | ∞ | ∞ |

- Free je **permanentný**, nie trial.
- **Read-only enforcement:** pri downgrade, ak workspace presahuje limit členov → read-only
  režim (view bez edit).
- Promo kódy: `PromoCode` model, aplikované pri Stripe checkout.

### 6.3 Typy notifikácií a ich deep-link

Enum v `Notification.js`:

| Type | Zdroj | Notifikovaný | Push? |
|------|-------|--------------|-------|
| `contact.created` | contacts.js | Ostatní členovia workspace-u | — |
| `contact.updated` | contacts.js | Ostatní členovia | — |
| `contact.deleted` | contacts.js | Ostatní členovia | — |
| `task.created` | tasks.js | Assigned users | — |
| `task.updated` | tasks.js | Assigned users | — |
| `task.completed` | tasks.js | Autor + assigned | — |
| `task.deleted` | tasks.js | Assigned | — |
| `task.assigned` | tasks.js | Nový assignee | **Áno** |
| `subtask.*` | tasks.js | Analogicky | niektoré |
| `task.dueDate` | dueDateChecker | Assigned | **Áno** |
| `subtask.dueDate` | dueDateChecker | Assigned | **Áno** |
| `message.created` | messages.js | Recipient | **Áno** |
| `message.approved` | messages.js | Sender | — |
| `message.rejected` | messages.js | Sender | **Áno** |
| `message.commented` | messages.js | Druhá strana | **Áno** |
| `message.comment.reacted` | messages.js | Autor komentára | — |

**Deep-link rezolver** v `notificationService.js:generateNotificationUrl`:
- `type.startsWith('message')` + `data.messageId` → `/messages?highlight=X&comment=Y&ws=Z`
- `type.startsWith('task')` → `/tasks?highlightTask=X&ws=W`
- `type.startsWith('subtask')` → `/tasks?highlightTask=X&subtask=Y&ws=W`
- `type.startsWith('contact')` → `/crm?expandContact=X&ws=Y`

**⚠️ Invariant — task/subtask URL nesmie obsahovať `contactId`:**
Tasks.jsx má useEffect, ktorý pri detekcii `?contactId=...` v URL zavolá
`setContactFilter(...)` + `navigate('/tasks', { replace: true })`. Ten navigate
**zmaže všetky query params vrátane `highlightTask` a `ws`**, takže notifikácia
by skončila vo filtrovanom zozname bez zvýraznenia konkrétneho tasku.

Pokrýva to regresný test `generateNotificationUrl — deep-link resolver >
task.* deep-link nesmie obsahovať contactId v query (regression)` v
`notificationService.test.js`. Defense-in-depth fix v Tasks.jsx kontroluje
prítomnosť `highlightTask` pred aplikáciou contactFilter.

**Filter podľa kontaktu je legitímna operácia** cez tlačidlo „Zobraziť projekty"
v CRM (`navigate('/tasks?contactId=X')`). Rozdiel: tam chýba `highlightTask`,
takže contactFilter sa aplikuje.

### 6.4 Integrácie

**Google Calendar** — OAuth2, bidirectional sync, webhook push, syncToken incremental.
`user.googleCalendar` = `{ accessToken, refreshToken, syncToken, syncedTaskIds: Map }`.

**Google Tasks** — OAuth2, polling (nie webhooks — Google Tasks ich nemá), 5 min interval.

**iCal feed export** — per-user endpoint s `user.calendarFeedToken`, ReadOnly.

**Žiadne iné externé integrácie** (žiadny Slack/Jira/GitHub).

### 6.5 Zvláštnosti a neobvyklé rozhodnutia (ktoré má Gemma rešpektovať)

1. **Súbory ako Base64 v MongoDB, limit 10 MB** — vedomé rozhodnutie pre jednoduchosť.
   Migrácia na S3 je mimo scope bez explicitného schválenia.

2. **Message linking** — správa môže byť linknutá na kontakt alebo task (nie oboje), cez
   `linkedType` + `linkedId` + `linkedName`. Objaví sa v oboch miestach.

3. **Cascading auto-complete** — označenie projektu/tasku ako `completed` cascaduje na všetky
   nested subtasky. Implementované vo frontende, server ho neverifikuje. **Toto je dizajn, nie bug.**

4. **Comment reactions (like/dislike)** — max 1 reakcia per user per komentár. Enforcované cez
   `$pull` → `$push` na route.

5. **Notification auto-expiry 30 dní** — MongoDB TTL index. História notifikácií je efemérna,
   audit trail žije v `AuditLog`.

6. **Socket broadcast bez workspace filtrovania** — známy security debt (§11.4).

7. **Slovak-only UI** — žiadne i18n, stringy sú hardcoded v JSX (EN varnames / SK strings).

---

## 7. Bezpečnostný model

### 7.1 Autentifikácia

- JWT v `Authorization: Bearer`, secret z `JWT_SECRET` (min 32 chars, enforcované pri boot)
- Heslá: bcrypt (cost 10)
- JWT expirácia 30d → user dostane 401 a musí sa re-loginovať
- iOS Keychain stores token, Face ID lock pri app restart

### 7.2 Autorizácia

- Middleware `authenticateToken` → `req.user`
- Middleware `requireWorkspace` → `req.workspaceId` + `req.workspaceRole`
- Per-route role check (`requireAdmin`, `requireOwner`, `requireManager`)

### 7.3 Workspace isolation

**KĽÚČOVÉ PRAVIDLO:** Každý dotaz nad workspace-scoped entitou MUSÍ obsahovať
`workspaceId: req.workspaceId` vo filtri. Nikdy nesmie byť dotaz typu
`Contact.findById(req.params.id)` bez workspace filtra.

Správny vzor:
```javascript
await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
```

### 7.4 Ďalšie bezpečnostné mechanizmy

- Helmet (XSS protection, HSTS, CSP, etc.)
- CORS whitelist (`CORS_ORIGIN`)
- Rate limiter (100 req/15min neauth, 1000 req/15min auth)
- Password complexity nie je explicitne vynútená (zvážiť)
- CSV export sanitizácia proti CSV injection (riešené)
- Sentry `beforeSend` filtruje `password`, `currentPassword`, `newPassword` z chybových dát
- Stripe webhook signature verification (`STRIPE_WEBHOOK_SECRET`)

---

## 8. Realtime a push notifikácie

### 8.1 Socket.IO

Server:
- Connection → JWT verify → `socket.join('user-'+userId)`
- `req.app.get('io')` → emit z route handlerov

Klient:
- `useSocket()` → auto-connect s tokenom, reconnect max 5×/1s
- Listeners: `notification`, `message-updated`, `contact-*`, `task-*`

### 8.2 Web Push (VAPID)

- Backend: `web-push` lib, VAPID keys v env, `PushSubscription` model per user+endpoint
- Frontend: service worker `public/sw-push.js`, `navigator.serviceWorker.register()` +
  `pushManager.subscribe()`
- Push click handler v SW → postMessage `NOTIFICATION_CLICK` → App.jsx listener

### 8.3 iOS APNs

- Custom HTTP/2 klient v `server/services/pushService.js` (**nie** knižnica `apn` —
  neudržiavaná, replaced)
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY_PATH` env vars
- `APNsDevice` model per user+deviceToken
- iOS Swift registruje token po login cez `/api/push/apns/register`

---

## 9. Konvencie kódu

### 9.1 JS/React štýl

- ES modules, async/await (nie callbacks)
- `const` > `let`, `var` nepoužívať
- Funkcionálne komponenty + hooks (žiadne class componenty)
- `useEffect` cleanup funkcie pre listeners
- `useMemo` / `useCallback` pre drahé computed values a stable refs
- Pages sú ploché (väčšina logiky v pages, minimum prop drillingu v stromoch)
- Inline styles s CSS vars tam, kde komponent nemá zmysel vytŕkať von (napr. komponenty
  správ v Messages.jsx)

### 9.2 Mongoose štýl

- **Atomic updates** preferované pred `.save()`:
  - `$push` namiesto `arr.push() + save()`
  - `$pull` namiesto `filter() + save()`
  - `$set` na matched subdoc (`{ 'arr.$.field': value }`)
- **Projekcia bez Base64** cez `NO_BASE64_PROJECTION` object — pozri messages.js:17
- `.lean()` pre read-only dotazy (performance)
- Workspace filter na **každom** dotaze

### 9.3 Error handling

- Routes vždy try/catch, logger.error s kontextom, return 500 JSON `{ message: 'Chyba servera' }`
- User-facing správy v slovenčine
- Frontend zachytáva cez `err.response?.data?.message || 'Chyba'`

### 9.4 Logovanie

- `logger.info/warn/error(...)` nie `console.log` v novom kóde
- **Poznámka:** v existujúcom frontende je ~40 console.log — dlh, ale niektoré sú user-facing
  mobile debug (rozhodnúť individuálne)

### 9.5 Komentáre

Použi prefix podľa typu:
- `// PERF:` — optimalizácia
- `// NOTE:` — dôvod rozhodnutia
- `// WORKAROUND:` — dočasný hack
- `// iOS:` / `// WKWebView:` — iOS-specific
- `// TODO:` — plánované zlepšenie (krátke)
- `// FIXME:` — známy bug

---

## 10. Commit a git workflow

- Branch **`main`** je single source of truth (Render auto-deployuje).
- Commit messages v slovenčine s prefixom `feat(<scope>):`, `fix(<scope>):`, `refactor(...)`,
  `perf(...)`, `security(...)`, `cleanup(...)`
- Viac-riadkový body s vysvetlením "prečo", nielen "čo"
- Co-author signoff (`Co-Authored-By: Claude Opus 4.6 ...`)
- Bez `--amend` po push-e (by default)
- Bez force push na main

**Príklad dobrej správy** (commit `3e2da23`):
```
feat(messages): pridať like/dislike reakcie ku komentárom s notifikáciami

Komentáre v odkazoch teraz podporujú 👍/👎 reakcie:
- Každý user môže mať max 1 aktívnu reakciu na komentár (toggle/swap/off)
- Autor komentára dostane notifikáciu pri pridaní alebo zmene reakcie
- Push + socket + deep-link fungujú automaticky
```

---

## 11. Známy technický dlh (vedomé kompromisy)

Gemma by mala tieto body poznať, ale **nenavrhovať opravu, pokým ju explicitne nepoviem**.

### 11.1 Console.log v produkcii (~40 výskytov vo frontende)
Niektoré sú užitočné pre mobile debug (iOS log nie je vždy dostupný). Rozhodnutie o tom, čo
odstrániť, musí byť manuálne.

### 11.2 DueDateChecker nespracúva `Contact.tasks[]`
`dueDateChecker.js` scanuje len globálny `Task` model, nie vnorené tasky v `Contact.tasks[]`.
Reminder pre task patriaci kontaktu sa nepošle. Architektúrna zmena.

### 11.3 `apn` + `node-forge` CVE (riešené)
Pôvodne sa použila knižnica `apn` — neudržiavaná, node-forge mal moderate/high CVE.
Nahradené custom HTTP/2 klientom v `pushService.js`.

### 11.4 Socket.IO bez workspace filtering
`io.emit('contact-updated')` ide všetkým klientom, nie len tým z daného workspace-u. Fix:
`io.to('workspace-'+workspaceId).emit(...)` + `socket.join('workspace-'+wsId)` pri switchi.
**Bezpečnostný dlh.**

### 11.5 Sentry odstrániť a nahradiť in-house
Sentry je vypnutý v iOS (memory). Plán: vlastné error tracking UI v AdminPanel. Čaká na
potvrdenie iOS stability.

### 11.6 Chýba ESLint/Prettier
Žiaden lint/format setup. Style drift je možný pri väčších zmenách.

### 11.7 Žiadny CI gate
Render auto-deploy nečaká na testy. Povolí deploy aj keď `npm test` failuje lokálne.

---

## 12. Review checklist pre Gemmu

Pri kontrole PR/zmeny má Gemma prejsť tento checklist:

### 12.1 Bezpečnosť
- [ ] Každý Mongoose dotaz nad workspace-scoped entitou má `workspaceId: req.workspaceId` filter?
- [ ] Route používa `authenticateToken` a (ak treba) `requireWorkspace`?
- [ ] Sú user inputy validované (dĺžka, typ, whitelisty) pred zápisom?
- [ ] Nevypisujeme sensitive údaje do logov (heslá, tokeny, API keys)?
- [ ] Chýba niekde escape HTML pri rendering-u user contentu?

### 12.2 Funkčnosť
- [ ] Nezmenila sa pozorovateľná funkcionalita oproti pôvodnej? (Ak áno → bug report, nie refactor.)
- [ ] UI stringy zostali slovenčine?
- [ ] Error messages zostali slovenčine?

### 12.3 Výkon
- [ ] Používa sa atomic update (`$push`/`$pull`/`$set` na matched subdoc) namiesto `.save()`?
- [ ] Dotaz na dokumenty so zoznamom Base64 príloh používa `NO_BASE64_PROJECTION`?
- [ ] Veľké listy sú lean-uté (`.lean()`)?
- [ ] Sú pre nové queries indexy v modeli?
- [ ] Socket handler neemituje úplný dokument, len nevyhnutné polia?

### 12.4 Realtime/notifikácie
- [ ] Nová akcia, ktorá ovplyvňuje druhú stranu, emituje socket event?
- [ ] Nová akcia, o ktorej má byť user informovaný, vytvára `Notification`?
- [ ] Nový notification type je pridaný aj do `Notification.js` enumu?
- [ ] Deep-link resolver v `notificationService.js` vie typ spracovať?
- [ ] Task/subtask notifikačná URL NEobsahuje `&contactId=` (Tasks.jsx by ho
  interpretoval ako filter a zmazal highlightTask — viď §6.3 invariant)?

### 12.5 iOS špecifiká
- [ ] Nová page je lazy-loaded (`React.lazy`)?
- [ ] Ak upravujeme `ContentView.swift` alebo bridge → upozorniť že treba Xcode rebuild + TestFlight?
- [ ] Neinštalujeme ťažké knižnice (zvýšenie WKWebView bundle size)?
- [ ] Používa sa `window.webkit.messageHandlers.iosNative` správne (guard `window.webkit?` check)?

### 12.6 Frontend
- [ ] Je cleanup v `useEffect` (listenery, intervaly)?
- [ ] Nie sú stale closures nad state v `useEffect` dependencies?
- [ ] Je 401 handler netknutý (redirect na /login)?
- [ ] Nové URL params sa čítajú v page-i a správne manipulujú state?

### 12.7 Konvencie
- [ ] Commit message v slovenčine s prefixom?
- [ ] Komentáre `PERF:/NOTE:/WORKAROUND:` zachované?
- [ ] Prihlásenie pre `Co-Authored-By` pridané?

---

## 13. Testovací postup (manual checklist)

Keď Gemma navrhuje fix, mala by odporučiť konkrétne smoke testy:

### 13.1 Auth flow
1. Register → prihlásenie → refresh → ostáva prihlásený
2. Logout → token zmizne z localStorage a Keychain
3. Expired token → auto-redirect na /login

### 13.2 Workspace switch
1. User v 2+ workspace-och
2. Prepnutie → všetky pages refetchnú dáta
3. Deep-link z notifikácie s `ws=` → prepne + zobrazí správne dáta (nie data z predchádzajúceho ws)

### 13.3 Notifikácie
1. User A vytvorí task a priradí ho userovi B
2. User B vidí badge, zvonček má nový záznam
3. Klik na zvonček → scroll na task, badge sa zníži
4. Push (iOS): notifikácia sa zobrazí aj pri zamknutej obrazovke, tap otvorí konkrétny task

### 13.4 Komentáre a reakcie (najnovšia feature)
1. Odkaz s komentárom, userA reaguje 👍 → count = 1, zvýraznené
2. UserA klikne 👎 → preprne sa na 1 dislike
3. UserA znova 👎 → odstrání reakciu (count = 0)
4. UserB reaguje 👍 → autor komentára (ak je iný) dostane notifikáciu
5. Vizuál: priehľadné pill tlačidlá s fialovým nádychom (brand `#6366f1`),
   SVG thumbs-up/thumbs-down ikony (Lucide štýl), filled stav pri aktívnej
   reakcii, glassmorphism hover (backdrop-filter blur)

### 13.5 iOS-specific
1. Cold start z notifikácie — workspace switch + deep-link ide cez APNs launchOptions
2. Hot start z notifikácie — iosDeepLink event
3. App rebuild po stálom scroll → WebContent crash → reload na poslednú URL (nie /app)
4. Login → Keychain save → force quit → reopen → Face ID → localStorage má správny token

### 13.6 Automatizované testy — quick index

Existujúce Jest test suites v `server/__tests__/` (**32 testov, všetky prechádzajú**):
- `notificationService.test.js` — notifikačný service (getNotificationTitle s actor-first
  formátom, notifyContactChange, notifyTaskChange s workspace scopingom, notifyTaskAssignment,
  notifySubtaskChange, Socket.IO integrácia, createNotification, tenancy guard)
- `models/User.test.js` — User model, **calendarFeedToken sparse unique index** (6 testov,
  vrátane regresného testu na pôvodný bug s non-sparse indexom a E11000)
- `setup.js` — shared `mongodb-memory-server` setup (afterEach vyčistí collections)

Spúšťanie: `cd server && npm test` (všetky) alebo `npx jest <path>` (jeden file).

Pravidlá písania nových testov:
- AAA pattern (Arrange / Act / Assert) s prázdnym riadkom medzi
- Slovenské `describe`/`it` popisy (konzistentné s UI jazykom)
- Pri modeloch s indexmi volaj `await Model.init()` v `beforeAll` — Mongoose vytvára
  indexy lazily, inak test môže nevidieť unique/sparse constraint
- Žiadne `.only()` / `.skip()` v committnutom kóde

---

## 14. Na čo sa Gemma nepýta (vedela by to sama zistiť)

- **Existujúci endpoint pre X?** → grep `router.(get|post|put|delete)` v `server/routes/`
- **Je pole X indexované?** → pozri model súbor, `schema.index(...)`
- **Kde sa zisťuje current workspace?** → `req.workspaceId` po `requireWorkspace` middleware
- **Ako sa posiela notifikácia?** → `notificationService.createNotification({...})`
- **Ako sa pridáva socket event?** → `req.app.get('io')` + `io.to('user-'+userId).emit(...)`
- **Ako sa loguje?** → `const logger = require('../utils/logger'); logger.info('...', {...})`
- **Ako sa detekuje iOS?** → frontend: `utils/platform.js::isIosNativeApp()`; backend: User-Agent `PrplCRM-iOS/`

---

## 15. Na čo sa Gemma pýta pred návrhom

Keď niečo nevie, spýta sa **najprv**, potom navrhne:

1. "Má zmena dopad na iOS binary? (Swift súbor, bridge API, WKUserScript)" → ak áno, upozorniť
   že treba Xcode rebuild.
2. "Je tento endpoint volaný aj z niečoho iného ako z tejto page?" → grep pred zmenou signature.
3. "Je tento socket event emitovaný aj z iného route?" → grep `io.emit`.
4. "Je tento model používaný v ďalších agregáciách alebo exportoch?" → grep model name.

---

## 16. Zoznam najdôležitejších súborov (quick index)

### Backend
- `server/index.js` — entry, middleware stack, route register, background jobs
- `server/models/Message.js` — Message + komentáre + reakcie schémy
- `server/models/Notification.js` — Notification enum (tu sa pridávajú nové typy)
- `server/models/User.js`, `Workspace.js`, `WorkspaceMember.js` — tenancy core
- `server/routes/messages.js` — Messages CRUD + komentáre + reakcie
- `server/routes/tasks.js` — Tasks CRUD + reorder
- `server/routes/contacts.js` — Contacts CRUD + nested tasks
- `server/routes/notifications.js` — read-for-related, unread-by-section
- `server/services/notificationService.js` — createNotification + deep-link URL resolver
- `server/middleware/auth.js` + `requireWorkspace.js` — tenancy guards
- `server/utils/logger.js` — Winston

### Frontend
- `client/src/App.jsx` — routing + deep-link handling + workspace switch logic
- `client/src/pages/Messages.jsx` — Odkazy UI (aktuálne aj s reakciami)
- `client/src/pages/Tasks.jsx` — Projekty/tasky s drag-drop
- `client/src/pages/CRM.jsx` — Kontakty
- `client/src/context/AuthContext.jsx` — Auth state + login/logout
- `client/src/context/WorkspaceContext.jsx` — Workspace state + switchWorkspace
- `client/src/api/api.js` — Axios + 401 handler
- `client/src/hooks/useSocket.js` — Socket.io manager
- `client/src/components/NotificationBell.jsx` + `NotificationToast.jsx`
- `client/src/utils/platform.js` — iOS detekcia
- `client/vite.config.js` — build + chunks + test config

### iOS
- `ios/PrplCRM/PrplCRMApp.swift` — @main, AppDelegate, PushNotificationManager
- `ios/PrplCRM/ContentView.swift` — WebView, Coordinator, bridge, memory recovery
- `ios/PrplCRM/KeychainHelper.swift` — token persistence

### Konfigurácia
- `render.yaml` — deployment config
- `server/.env.example`, `client/.env.example` — env var templates
- `client/vite.config.js` — build config

---

## 17. Rýchla referenčná tabuľka (cheat sheet)

### Pridanie nového notifikačného typu
1. Pridať string do `server/models/Notification.js` `type` enumu
2. Volať `notificationService.createNotification({ type: 'new.type', ... })` v route
3. Ak má deep-link → pridať logiku v `notificationService.js:buildDeepLinkUrl`
4. Ak má zvláštny icon v bell/toast → upraviť `getIcon()` v
   `NotificationBell.jsx:148` a `NotificationToast.jsx:81`
5. Pridať `data.messageId`/`data.taskId`/`data.contactId` podľa potreby

### Pridanie nového socket eventu
1. V route: `req.app.get('io').to('user-'+userId).emit('event-name', { id, ... })`
2. V klient page: `useEffect(() => { socket.on('event-name', handler); return () => socket.off(...) }, [socket])`

### Pridanie nového workspace-scoped Mongoose modelu
1. Model: `workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true }`
2. Compound index `{ workspaceId: 1, createdAt: -1 }` (alebo podľa query vzoru)
3. Route: `requireWorkspace` middleware, všetky queries majú `{ workspaceId: req.workspaceId }`
4. Toggle filter v delete/update: `await Model.deleteOne({ _id, workspaceId: req.workspaceId })`

### Pridanie novej stránky do frontendu
1. Vytvoriť `client/src/pages/NewPage.jsx`
2. V `App.jsx` pridať `const NewPage = lazy(() => import('./pages/NewPage'))` (**lazy je povinné**)
3. Pridať `<Route path="/newpath" element={isAuthenticated ? <NewPage /> : <Navigate to="/login" />} />`
4. Ak je v bottom nav → upraviť `BottomNav.jsx`

---

## 18. Kontakty a odkazy

- **Vlastník projektu:** Martin Koščo
- **Frontend doména:** https://prplcrm.eu
- **Backend API:** https://perun-crm-api.onrender.com
- **Repo:** https://github.com/vannilla1/notion-app
- **Brand farba:** Indigo `#6366f1`
- **Development region:** Slovakia (`sk`)

---

**Koniec súboru.** Pri každej zmene v štruktúre projektu tento dokument aktualizuj (commit
message: `docs(gemma): update project guide — <čo sa zmenilo>`).
