# prpl CRM — kontext pre Claude Code

Repozitár `notion-app` = živý SaaS **prpl CRM** (https://prplcrm.eu). Pôvodne Notion klon, potom „purple-crm / Perun CRM“ — staré názvy v kóde sú zámerne (premenovanie zatiaľ NIE, zoznam výskytov je v `REPORT.md` kap. 6). `README.md` je zastaraný (Notion klon), neriaď sa ním.

Komunikácia s vlastníkom: **po slovensky**, vždy `súbor:riadok`, vysvetľuj PREČO, bezpečné inkrementálne zmeny, produkcia je živá.

## Platformy

| Platforma | Kde | Ako beží |
|---|---|---|
| Web + PWA | `client/` (React 18, Vite, vite-plugin-pwa) | Render static site `prpl-crm` (`render.yaml`), manifest `client/public/manifest.json` (`start_url` `/app`) |
| API + Socket.IO | `server/` (Node/Express, Mongoose 9, Socket.io, Stripe) | Render web service — živý host `perun-crm-api.onrender.com` (NEMENIŤ, zapečený v appkách a u tretích strán) |
| iOS appka | `ios/PrplCRM/` (SwiftUI + WKWebView shell nad `https://prplcrm.eu/app`) | bundle `sk.perunelectromobility.prplcrm`, iOS ≥ 16, verzia 1.0.19 (79) |
| Android appka | `android-native/` (Kotlin WebView shell) | `eu.prplcrm.app`, minSdk 24 / targetSdk 36, 1.0.11 (212) |
| Legacy Android TWA | `android/` (Bubblewrap) | nahradené `android-native/`, rovnaké `applicationId`; meniť len ak sa ešte vydáva |

DB: MongoDB Atlas (shared tier blízko limitu — šetri indexy a veľké dokumenty). Súbory: Cloudflare R2 (`server/services/fileStorage.js`). Cache/joby: Redis ak je `REDIS_URL`, inak pamäť.

## Natívne shelly — kontrakty s webom (meniť iba spätne kompatibilne)

**iOS** (`ios/PrplCRM/ContentView.swift`, `PrplCRMApp.swift`, `OAuthController.swift`, `StoreKitManager.swift`):
- Web → native: `window.webkit.messageHandlers.iosNative.postMessage({type})` — `authToken`, `logout`, `startGoogleSignIn`, `startAppleSignIn`, `iapGetProducts`, `iapPurchase`, `iapRestore`, `iapReady`, `iapFinish`; ďalšie handlery `fileDownload`, `openExternal` (len http/https/mailto/tel).
- Native → web: `window.__nativeAuthLogin(token, opts?)` (AuthContext), `window.__iapProducts`, `window.__iapResult`.
- Token v Keychaine; restore WKUserScript zapíše token do localStorage **len na `prplcrm.eu`** a po odhlásení sa prebalí (`reinstallUserScripts`).
- Navigácie: len `prplcrm.eu` / `*.prplcrm.eu` vo WebView, cudzí host → Safari (výnimka API `/api/auth/`, `/api/attachments/`). Správy z iného originu sa zahadzujú.
- OAuth: natívne SDK (Google/Apple) → `/api/auth/{provider}/native`. Flow dokončený v Safari sa vracia `prplcrm://auth?token&cnonce&returnUrl` → token sa odovzdá webu s `cnonce` a web ho prijme len pri zhode s nonce z `client/src/utils/oauthNonce.js`.
- IAP (StoreKit 2): transakcia sa `finish()`-ne až po `iapFinish` z webu (po úspešnom `/api/billing/apple/verify` alebo definitívnej 4xx).

**Android** (`android-native/app/src/main/java/eu/prplcrm/app/`):
- `window.NativeBridge` (`WebAppInterface.kt`): `setAuthToken`, `getAuthToken`, `setCurrentWorkspaceId`, `getCurrentWorkspaceId`, `clearAll`, `saveFile`, `showKeyboard`, `isNativeApp`, `getPlatform`, `getAppVersion`, `getLastFcmStatus`, `forceFcmRegister`. Metódy odmietnu volanie z cudzej stránky (`MainActivity.pageOnOurHost`).
- Token v EncryptedSharedPreferences (`TokenStore.kt`, jedna inštancia), injekcia do localStorage v `onPageStarted` cez `JSONObject.quote`.
- Cudzí host sa vo WebView nikdy nenačíta (`shouldOverrideUrlLoading`), OAuth beží v systémovom prehliadači a vracia sa App Linkom `/auth/callback`.
- Push: FCM (`PrplFcmService.kt`, `FcmRegistrar.kt`), pri odhlásení `unregisterOnLogout`. Zero-tap obnova cez Google Block Store (`RestoreSession.kt`).

Natívny kód sa v cloudovom prostredí **nedá skompilovať** (bez Xcode / Android SDK) — každú zmenu označ ako neoverenú a vyžaduje nové vydanie v App Store / Google Play.

## Kľúčové serverové časti

- Auth: `server/middleware/auth.js` (JWT HS256 s claimom `tv` ↔ `User.tokenVersion`; zmena/reset hesla zneplatní relácie; `signAuthToken`), OAuth `server/services/oauthService.js` + `routes/auth-google.js`, `auth-apple.js`, prepojenie účtov `routes/auth-connections.js` (`POST /complete` s JWT).
- Platby: Stripe `routes/billing.js` (lazy klient `services/stripeClient.js`, webhook 500 pri prechodnej chybe), Apple IAP `routes/billingApple.js` (+ ASSN), plány a limity `utils/planLimits.js`, `utils/planGate.js` (limity podľa plánu **vlastníka** workspace).
- Workspace/tenant izolácia: `middleware/workspace.js`, `X-Workspace-Id`.
- Google Calendar/Tasks sync: `routes/googleCalendar.js`, `routes/googleTasks.js` (podpísaný state, `/sync?async=1` → `utils/backgroundJobs.js` + `GET /api/jobs/:id`).
- Plánovače: `services/dueDateChecker.js` (cielené zápisy cez `utils/nestedTaskUpdate.js`), `planExpiration`, `subscriptionReminders`, `subscriptionCleanup`, `jobs/*` — všetky majú `stop()` v graceful shutdowne (`server/index.js`).
- Diagnostika (náhrada Sentry): `services/serverErrorService.js`, `POST /api/errors/client`, `POST /api/errors/csp`.
- Jednorazové migrácie pri štarte: `runOnceMigration` v `server/index.js` (kolekcia `app_migrations`).

## Pravidlá pre zmeny

- **Žiadne nové npm balíčky ani zmeny verzií** v `package.json` bez výslovného súhlasu vlastníka; zmeny DB schémy/indexov len so súhlasom a s jednorazovou migráciou.
- Nikdy nevypisuj tajomstvá (env hodnoty, kľúče, heslá) — ani do commitov, ani do reportov. Skripty s heslami čítajú len z env (`SEED_ADMIN_PASSWORD`); deštruktívne skripty potrebujú `--confirm` + `ALLOW_DESTRUCTIVE_SCRIPTS=true`.
- Web musí ostať spätne kompatibilný so staršími buildmi appiek (názvy bridge metód, localStorage kľúčov, socket udalostí).
- Commity: slovenský konvenčný predmet, telo `ČO (súbor:riadok): …`, `PREČO: …`, `Nálezy: <id>`.
- Nikdy nepushuj na `main` bez pokynu; PR len na požiadanie.

## Kontroly

- Klient: `cd client && npx vitest run` a `npm run build` (výstup `dist/` nie je v gite).
- Server: `cd server && npm test` (Jest + mongodb-memory-server — v cloude sa binárka MongoDB nestiahne, testy s DB sú tam neoverené; čisté unit testy: `npx jest <súbor> --setupFilesAfterEnv <prázdny setup>`). Lint v projekte nie je.

## Hlavné env premenné servera (len názvy)

Jadro `MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGIN`, `CLIENT_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, `API_PUBLIC_HOST` · Stripe `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` · Apple `APPLE_IAP_*`, `APPLE_TEAM_ID`, `APPLE_SERVICE_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_SANDBOX_POLICY` · Google `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_WEBHOOK_SECRET` · Push `VAPID_*`, `APNS_*`, `FIREBASE_SERVICE_ACCOUNT_*` · E-mail `SMTP_*`, `CONTACT_SMTP_*` · R2 `R2_*` · Ostatné `PRO_EMAILS`, `CLIENT_ERROR_NEW_FP_PER_IP`, `ERROR_ALERT_THRESHOLD`, `ATLAS_TIER_LIMIT_MB`.

## Stav (október 2026)

- Vetva `claude/audit-fixes` (= `claude/happy-clarke-vk520b`) obsahuje kompletný audit a opravy: 505 z 518 nálezov, dve vlny (do `a0c9fbe` bezpečné opravy, potom všetky vrátane auth, platieb, DB, nasadenia a natívnych appiek). Ešte **nie je zlúčená do `main`**.
- `REPORT.md`: zvyšky s dôvodmi (kap. 3), čo je neoverené (kap. 5), **akcie pre prevádzku pred/po nasadení** (kap. 7 — duplicity `appleOriginalTransactionId`, `PRO_EMAILS`, `GOOGLE_WEBHOOK_SECRET` + obnova kanálov, CSP report-only → enforce, zmena hesiel, nové natívne vydania) a plán zlúčenia (kap. 8).
