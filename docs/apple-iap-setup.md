# Apple In-App Purchase — Setup Guide

> **Cieľ:** Sprevádzkovať Apple IAP pre iOS appku (guideline 3.1.1). Backend + iOS + web kód je hotový (commity d851761 → 6a22d3d). Tento dokument je **manuálny setup** v App Store Connect + Render, ktorý kód oživí.

## ⚠️ Predpoklad

**Paid Apps Agreement musí byť „Active"** (App Store Connect → Business). Práve si dokončil tax form ktorý to blokoval — počkaj kým je agreement Active, inak nemôžeš dať produkty „Cleared for Sale".

---

## 📋 Prehľad krokov

- [ ] 1. Vytvoriť subscription group + 4 produkty
- [ ] 2. Vygenerovať In-App Purchase API kľúč (.p8)
- [ ] 3. Získať Issuer ID, Key ID, App Apple ID
- [ ] 4. Nastaviť App Store Server Notifications V2 URL
- [ ] 5. Nastaviť Render env vars
- [ ] 6. Sandbox tester + test nákupu
- [ ] 7. Rebuild iOS appky v Xcode

---

## 1️⃣ Subscription group + 4 produkty (~20 min)

App Store Connect → tvoja appka → **Subscriptions** (v ľavom menu pod „Monetization").

### 1.1 Vytvor subscription group
- Klik **Create** pri Subscription Groups
- **Reference Name:** `Prpl CRM Plans` (interné, user to nevidí)
- Jedna skupina pre všetky 4 → user môže upgradovať/downgradovať medzi nimi (Apple to rieši proráciou)

### 1.2 Vytvor 4 auto-renewable subscriptions

V skupine klik **Create** (4×). Pre každý:

| Product ID (PRESNE) | Reference Name | Duration | Cena |
|---|---|---|---|
| `prplcrm.team.monthly` | Tím mesačne | 1 Month | €4.99 |
| `prplcrm.team.yearly` | Tím ročne | 1 Year | €49.00 |
| `prplcrm.pro.monthly` | Pro mesačne | 1 Month | €9.99 |
| `prplcrm.pro.yearly` | Pro ročne | 1 Year | €99.00 |

> ⚠️ **Product ID sa MUSÍ zhodovať PRESNE** — kód ich má natvrdo v `server/config/appleProducts.js` + `ios/PrplCRM/StoreKitManager.swift`. Žiadne preklepy.

> 💡 Cena: vyber najbližší Apple price tier (€4.99/€9.99/€49/€99 sú štandardné tier-y, mapujú čisto).

Pre KAŽDÝ produkt vyplň:
- **Subscription Display Name:** napr. „Tím (mesačne)" — user to vidí
- **Description:** krátky popis (napr. „25 kontaktov, Google sync, prílohy 1 GB")
- **Localization:** aspoň Slovak + English
- **Review Information → Screenshot:** screenshot upgrade obrazovky (stačí jeden, recykluj)

Stav každého produktu bude **„Ready to Submit"** → to je OK, reviewnú sa s prvým app submitom. **Sandbox testing funguje hneď, bez review.**

---

## 2️⃣ In-App Purchase API kľúč (.p8) (~5 min)

App Store Connect → **Users and Access** → záložka **Integrations** → **In-App Purchase** (v ľavom zozname kľúčov).

1. Klik **Generate In-App Purchase Key** (alebo **+**)
2. **Name:** `prplcrm-iap-backend`
3. Klik **Generate**
4. **Stiahni .p8 súbor** (ikona Download) — **IBA RAZ sa dá stiahnuť!** Ulož bezpečne.
5. Poznač si **Key ID** (10 znakov, vedľa kľúča)

---

## 3️⃣ Issuer ID, Key ID, App Apple ID

| Hodnota | Kde nájdeš |
|---|---|
| **Key ID** | Users and Access → Integrations → In-App Purchase → vedľa kľúča (krok 2) |
| **Issuer ID** | Users and Access → Integrations → **hore na stránke** („Issuer ID", UUID formát) |
| **App Apple ID** | Tvoja appka → **App Information** → General Information → **Apple ID** (numerické, napr. 6740123456) |
| **.p8 obsah** | Otvor stiahnutý súbor v texteditore — celý obsah vrátane `-----BEGIN PRIVATE KEY-----` a `-----END PRIVATE KEY-----` |

---

## 4️⃣ App Store Server Notifications V2 (~3 min)

Toto je webhook ktorým Apple posiela renewals / cancel / refund na náš backend.

Tvoja appka → **App Information** → scrollni na **App Store Server Notifications**.

- **Version:** vyber **Version 2** (NIE Version 1)
- **Production Server URL:**
  ```
  https://perun-crm-api.onrender.com/api/billing/apple/notifications
  ```
- **Sandbox Server URL:** (rovnaká)
  ```
  https://perun-crm-api.onrender.com/api/billing/apple/notifications
  ```
- Save

---

## 5️⃣ Render env vars (~3 min)

[Render dashboard](https://dashboard.render.com) → `prpl-crm-api` service → **Environment** → Add:

| Key | Value |
|---|---|
| `APPLE_IAP_KEY_ID` | (Key ID z kroku 2) |
| `APPLE_IAP_ISSUER_ID` | (Issuer ID z kroku 3) |
| `APPLE_IAP_PRIVATE_KEY` | (celý obsah .p8 súboru — multi-line, vrátane BEGIN/END) |
| `APPLE_IAP_BUNDLE_ID` | `sk.perunelectromobility.prplcrm` |
| `APPLE_IAP_APP_APPLE_ID` | (numerické App Apple ID z kroku 3) |

> 💡 `APPLE_IAP_PRIVATE_KEY` — Render podporuje multi-line hodnoty. Skopíruj celý .p8 obsah vrátane `-----BEGIN PRIVATE KEY-----` riadku.

Save → Render redeployne (~3 min). V logoch over:
```
[AppleIAP] Configured { bundleId: 'sk.perunelectromobility.prplcrm', rootCerts: 3 }
```
Ak vidíš `[AppleIAP] NOT configured` → niektorá env var chýba.

---

## 6️⃣ Sandbox tester + test (~10 min)

### 6.1 Vytvor sandbox testera
App Store Connect → **Users and Access** → **Sandbox** → **Testers** → **+**
- Vymysli email (NEMUSÍ byť reálny, ale nesmie byť existujúce Apple ID), heslo
- Tento účet použiješ na iPhone v sandbox móde

### 6.2 Na iPhone
- **Settings → App Store → Sandbox Account** → prihlás sandbox testerom
- (alebo pri prvom IAP nákupe v appke ťa to vyzve)

### 6.3 Test nákupu (po rebuilde appky — krok 7)
1. Otvor appku → profil menu → **Predplatné**
2. Vyber plán → **Vybrať Pro**
3. StoreKit sheet → potvrď (sandbox = neúčtuje sa reálne)
4. Po nákupe sa plán aktivuje, v Render logoch vidíš:
   ```
   [AppleIAP] Applied transaction { plan: 'pro', environment: 'Sandbox', ... }
   ```

---

## 7️⃣ Rebuild iOS appky v Xcode ⚠️

Backend + web idú cez Render auto-deploy, **ale iOS appka NIE** — treba manuálny rebuild:

1. Otvor `ios/PrplCRM.xcodeproj` v Xcode
2. `StoreKitManager.swift` už je zaregistrovaný v projekte (commit e50e2bd) — over že je v project navigatore
3. **Product → Clean Build Folder** (⌘⇧K)
4. Build na zariadenie / archive
5. Pre TestFlight: Archive → Distribute → TestFlight

> 💡 StoreKit nepotrebuje žiadnu novú capability v Xcode — IAP sa zapína cez produkty v App Store Connect (krok 1) + aktívnu Paid Apps Agreement.

---

## ✅ Po dokončení

Keď máš všetkých 7 krokov:
- Sandbox nákup funguje → plán sa aktivuje
- Renewals/cancel/refund chodia cez notification webhook
- Pri submission appky do App Store: produkty sa reviewnú spolu s appkou

**Apple guideline 3.1.1 splnená** — iOS appka ponúka Apple IAP, žiadne external payment linky. To bol dôvod tých 6 rejection-ov → teraz vyriešené.

---

## 🚨 Troubleshooting

| Symptóm | Riešenie |
|---|---|
| `[AppleIAP] NOT configured` | Chýba env var na Render. Skontroluj všetkých 5. |
| `Produkt nenájdený` v appke | Product ID nesedí, alebo produkt nie je „Cleared for Sale" / Paid Apps Agreement nie je Active |
| `Transaction verification failed` | Bundle ID nesedí (`APPLE_IAP_BUNDLE_ID` vs appka), alebo sandbox/prod mismatch (kód skúša oba) |
| Nákup OK ale plán sa neaktivuje | Pozri Render logy — `/verify` error. Skontroluj APPLE_IAP_* env vars. |
| Notifikácie nechodia | Skontroluj notification URL v App Store Connect (krok 4), Version 2 |
| StoreKit sheet sa neotvorí | Appka nie je rebuildnutá s novým kódom (krok 7), alebo nie si v sandbox účte |

---

## 📚 Mapovanie kód ↔ App Store Connect

| Kód | App Store Connect |
|---|---|
| `server/config/appleProducts.js` | Product IDs (krok 1.2) |
| `server/services/appleIap.js` | API kľúč + bundle ID (kroky 2,5) |
| `server/routes/billingApple.js` | `/verify` + `/notifications` (krok 4) |
| `ios/PrplCRM/StoreKitManager.swift` | Product IDs (krok 1.2) |
| `client/src/pages/IapBilling.jsx` | Upgrade UI (user-facing) |
