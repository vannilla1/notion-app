# Google Play „Zero-Tap Sign-In" — Block Store integrácia (Prpl CRM Android)

Dátum: 2026-09-02 · Stav: schválený dizajn · Termín: v produkcii na Google Play **do 30. 9. 2026** (cieľ upload ≤ 20. 9. 2026)

## 1. Prečo

Google Play zaviedol požiadavku (Play Console Help, odpoveď 17492799): od apríla 2027 musia appky s prihlásením podporovať obnovu prihlásenia na novom zariadení (Zero-Tap Sign-In, primárne cez Restore Credentials API). Verbatim výnimka: *„an integration with Block Store may be considered compliant but only if the integration was completed and in production on or before September 30, 2026."* Nesplnenie ovplyvní viditeľnosť a publikovanie appky.

Prpl CRM Android (`eu.prplcrm.app`, versionCode 207 / 1.0.6) má vlastný e-mail+heslo login (JWT 7 dní) + Google/Apple OAuth, takže sa požiadavka týka. Restore Credentials vyžaduje WebAuthn/passkey relying-party server, ktorý neexistuje — preto rozhodnutie používateľa: **(A) Block Store teraz, (B) Restore Credentials neskôr ako samostatný projekt.** Tento dokument rieši len (A).

Známe riziká: Google píše „may be considered compliant" (nie garancia); Block Store je v Android dokumentácii označený ako deprecated v prospech Credential Manager. (B) ostáva plánované.

## 2. Rozsah

**V rozsahu:** server (restore tokeny + 3 endpointy + revokácia + testy), Android appka (Block Store + obnova pri cold starte + vydanie/revokácia tokenu), verzia 1.0.7 (208), AAB pre Play Production.

**Mimo rozsahu:** web klient (žiadna zmena), iOS (netýka sa), Restore Credentials / passkeys (projekt B), zmena dĺžky JWT.

## 3. Prístup: natívne riadený tok

Android appka si restore token spravuje sama, web klient o ňom nevie:

1. **Login:** web zavolá existujúci bridge `NativeBridge.setAuthToken(jwt)` → Android natívne (OkHttp, vzor `FcmRegistrar`) zavolá `POST /api/auth/restore-token` s Bearer JWT → dostane plaintext restore token → uloží ho + aktuálne workspace id do Block Store.
2. **Cold start:** ak v `TokenStore` chýba JWT **alebo je expirovaný** (lokálne dekódovanie `exp`), appka pred načítaním webu prečíta Block Store → `POST /api/auth/restore` → dostane nový JWT + rotovaný restore token + user → uloží JWT/workspace do `TokenStore`, nový restore token do Block Store → až potom `webView.loadUrl(...)`. Splash ostáva zobrazený počas obnovy. Strop 3 s; pri zlyhaní/timeoute sa načíta bežná login obrazovka.
3. **Logout:** web zavolá existujúci `NativeBridge.clearAll()` → Android prečíta restore token z Block Store, best-effort `DELETE /api/auth/restore-token` (dôkaz vlastníctvom tokenu, bez JWT — funguje aj po expirácii JWT), zmaže Block Store kľúče, potom `TokenStore.clearAll()`.
4. **Zmena workspace:** existujúci `setCurrentWorkspaceId` navyše aktualizuje workspace kľúč v Block Store, aby obnova otvorila správne workspace.

Zdôvodnenie oproti alternatíve (web klient volá server a posiela token cez nový bridge): zdieľaný web kód pre iOS/web sa nemení, token nikdy neprejde cez JavaScript/localStorage, nasadenie viaže len server + appku.

## 4. Server

### Dátový model (`server/models/User.js`)
```
restoreTokens: [{
  tokenHash: String (SHA-256 hex, index),
  expiresAt: Date,
  createdAt: Date,
  lastUsedAt: Date | null,
  deviceLabel: String (max 120 znakov, voliteľné)
}]
```
Max 5 záznamov na používateľa (pri vydaní nového sa expirované odstránia a najstarší podľa `createdAt` vypadne). Pole sa nikdy nevracia v API odpovediach (doplniť medzi citlivé polia odstraňované v `toJSON`/serializácii používateľa).

### Endpointy (`server/routes/auth.js`)
| Endpoint | Auth | Body | Odpoveď |
|---|---|---|---|
| `POST /api/auth/restore-token` | Bearer JWT (`authenticateToken`) + `restoreTokenLimiter` | `{ deviceLabel? }` | `200 { restoreToken, expiresAt }` |
| `POST /api/auth/restore` | verejný + `restoreLimiter` | `{ restoreToken }` | `200 { token, restoreToken, expiresAt, user }` (user v rovnakom tvare ako `/login`) · `401 { message }` pri neplatnom/expirovanom |
| `DELETE /api/auth/restore-token` | verejný (dôkaz vlastníctvom) + `restoreLimiter` | `{ restoreToken }` | `200 { ok: true }` vždy (idempotentné) |

Token: 32 náhodných bajtov (`crypto.randomBytes`) → base64url plaintext; na serveri iba SHA-256 hex hash. Platnosť **180 dní**. Obnova je **jednorazová s rotáciou**: použitý záznam sa zmaže a vydá sa nový (odpoveď obsahuje nový plaintext). Lookup `User.findOne({ 'restoreTokens.tokenHash': hash })`; expirovaný záznam sa pri neúspechu odstráni.

Rate limitery (`server/middleware/rateLimiter.js`): `restoreLimiter` 10 požiadaviek / 15 min / IP pre `/restore` a `DELETE`; `restoreTokenLimiter` 20 / hod / IP pre vydanie. Rešpektujú existujúci `SKIP_RATE_LIMIT` mechanizmus pre testy.

### Revokácia
`restoreTokens = []` v `PUT /password` (zmena hesla) a `POST /reset-password`. `DELETE /account` maže dokument používateľa (tokeny zaniknú). Super admin `support@prplcrm.eu` nemôže získať restore token (rovnaký guard ako login).

### Audit
`auth.restore` (úspech, category `auth`, details `{ deviceLabel }`), `auth.restore_failed` (details `{ reason: 'invalid' | 'expired' }`), `auth.restore_token_issued`, `auth.restore_token_revoked` — cez existujúci `auditService.logAction`, fire-and-forget. Plaintext tokenu sa nikdy neloguje.

### Testy (jest + supertest, `server/__tests__/routes/auth.restore.test.js`)
vydanie (200, tvar, hash v DB, plaintext nie v DB) · vydanie bez JWT → 401 · obnova → 200 + nový JWT platný pre `/me` + rotácia (starý token → 401, nový → 200) · expirovaný → 401 a záznam odstránený · neexistujúci → 401 · strop 5 (6. vydanie odstráni najstarší) · DELETE zruší (následná obnova → 401) a je idempotentný · zmena hesla a reset hesla vyprázdnia `restoreTokens` · `restoreTokens` nie sú v odpovedi `/me` ani `/login`.

## 5. Android (`android-native/`)

- **Závislosť:** `com.google.android.gms:play-services-auth-blockstore:16.4.0`. Verzia **versionCode 208, versionName 1.0.7**.
- **`RestoreCredentialStore.kt`** (nová): tenká vrstva nad `Blockstore.getClient(context)`. Kľúče `eu.prplcrm.app.restore_token`, `eu.prplcrm.app.workspace_id`. `save(token, workspaceId)` → `isEndToEndEncryptionAvailable()` → `setShouldBackupToCloud(true)` len ak dostupné (inak lokálne/D2D). `load(callback)` → `RetrieveBytesRequest` s oboma kľúčmi (chýbajúci kľúč = null). `saveWorkspaceId(id)`, `clear()` → `DeleteBytesRequest` s našimi kľúčmi. Každé volanie má `addOnFailureListener` → log, nikdy nepadá (zariadenia bez Google Play services).
- **`RestoreSession.kt`** (nová): orchestrácia s OkHttp na `R.string.api_base_url` (vzor `FcmRegistrar`, JSON telá, timeouty 3 s connect/read).
  - `issueAfterLogin(context, jwt)`: POST vydanie → `RestoreCredentialStore.save(token, TokenStore.getCurrentWorkspaceId())`.
  - `tryRestore(context, timeoutMs = 3000, onDone: (Boolean) -> Unit)`: load → ak token null → `onDone(false)`; inak POST obnova → pri 200 uložiť JWT + workspace do `TokenStore`, nový restore token do Block Store → `onDone(true)`; pri 401 zmazať Block Store kľúče → `onDone(false)`; iná chyba/timeout → `onDone(false)` (Block Store ponechať). `onDone` sa volá presne raz, na main threade (guard `AtomicBoolean`).
  - `revokeAndClear(context)`: load → ak token → best-effort DELETE; potom `clear()`.
- **`WebAppInterface.kt`:** `setAuthToken` — po uložení, ak token neprázdny a zmenený → `RestoreSession.issueAfterLogin`. `setCurrentWorkspaceId` — navyše `RestoreCredentialStore.saveWorkspaceId`. `clearAll` — najprv `RestoreSession.revokeAndClear`, potom `TokenStore.clearAll`.
- **`MainActivity.kt`:** nová `proceedToWeb(startUrl)` = `webView.loadUrl(startUrl)` + `maybeRequestNotificationPermission()` + `ensureFcmTokenRegistered()`. V `onCreate`: `needsRestore = token == null || JwtUtils.isExpired(token)`; ak áno → `splash.setKeepOnScreenCondition { restoring }` + `RestoreSession.tryRestore(...) { proceedToWeb(startUrl) }`, inak `proceedToWeb(startUrl)` hneď. `onNewIntent` sa nemení.
- **`JwtUtils.kt`** (nová, čistý Kotlin, bez Androidu): `isExpired(jwt, skewSeconds = 60)`: base64url dekódovanie payloadu, `exp` v sekundách; neparsovateľný token = expirovaný. Jednotkové testy (JUnit) ak `app/src/test` existuje, inak vytvoriť.
- **Manifest:** bez zmien (`allowBackup=false` a `data_extraction_rules` ostávajú — Block Store žije v Google Play services, nie v dátach appky).

## 6. Bezpečnosť

Restore token je 180-dňová prihlasovacia poverenka. Zmiernenia: 256-bit náhodnosť, iba hash v DB, jednorazovosť s rotáciou, revokácia pri logoute a zmene/resete hesla, strop 5 zariadení, rate limit, audit. V Block Store sa do cloudu zálohuje len pri end-to-end šifrovaní (Google podmienka: Android 9+ a nastavený zámok obrazovky). Token neprechádza cez WebView ani JS. Logy servera aj appky nikdy neobsahujú plaintext.

## 7. Chybové stavy

| Situácia | Správanie |
|---|---|
| Bez Google Play services / Block Store zlyhá | ticho preskočiť, appka funguje ako doteraz |
| Server nedostupný pri obnove | timeout 3 s → login obrazovka, Block Store ostáva (ďalší štart skúsi znova) |
| Token expirovaný/zrušený (401) | Block Store vymazať → login obrazovka |
| Vydanie tokenu po logine zlyhá | tichý log, používateľ ostáva prihlásený; bez obnovy na novom zariadení do ďalšieho loginu |
| Logout s expirovaným JWT | DELETE je verejný (dôkaz tokenom) → revokácia prebehne |
| Rotácia: server uložil nový, appka nestihla | ďalší štart → 401 → login (prijateľné) |

## 8. Testovanie na zariadení (bez emulátora)

1. Login v appke → `adb logcat` ukazuje uloženie do Block Store (bez tokenu v logu).
2. Odinštalovať → nainštalovať → očakávanie: appka nabootuje rovno prihlásená (Block Store prežije reinštaláciu na tom istom zariadení, vyžaduje zapnutú zálohu v Nastavenia › Google › Záloha).
3. Logout → odinštalovať → nainštalovať → login obrazovka.
4. Zmena hesla na webe → reinštalácia → login obrazovka.
Pre D2D/cloud obnovu na novom telefóne platia Google podmienky (cieľ Android 9+/12+, appka z Play) — overí sa po vydaní.

## 9. Poradie nasadenia

1. Server: commit + push `main` → Render auto deploy `prpl-crm-api` → overiť `/api/version`.
2. Android: `./gradlew bundleRelease` → AAB na `~/Desktop` → používateľ nahrá do Play Console › Production (release notes SK/EN pripravím) → **live do 30. 9. 2026**.
3. Po vydaní: overiť v Play Console, či Google eviduje splnenie (sekcia App quality requirements).

## 10. Zdroje
- https://support.google.com/googleplay/android-developer/answer/17492799
- https://developer.android.com/identity/block-store
- https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html
- https://developer.android.com/identity/sign-in/restore-credentials-implementation (projekt B)
