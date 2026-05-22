# Cloudflare R2 Migration — Setup Guide

> **Cieľ:** Presunúť 432 MB binárnych súborov z MongoDB Atlas (91% využitý) do Cloudflare R2 (10 GB grátis, $0 egress).

## 📋 Pre-flight checklist

- [x] Backend kód pripravený (commit s touto migráciou)
- [x] Migration script vytvorený (`server/scripts/migrate-files-to-r2.js`)
- [ ] Cloudflare účet (free)
- [ ] R2 bucket vytvorený
- [ ] R2 API token vygenerovaný
- [ ] Env vars nastavené na Render
- [ ] Migration script spustený
- [ ] Atlas storage uvoľnené

---

## 1️⃣ Cloudflare R2 — registrácia a bucket setup (5 min)

### 1.1 Registruj sa
1. Otvor [cloudflare.com](https://www.cloudflare.com) → **Sign Up** (ak ešte nemáš účet)
2. Verify email

### 1.2 Aktivuj R2 (zadarmo)
1. V Cloudflare dashboard → ľavé menu → **R2 Object Storage**
2. Klik **Purchase R2** (názov mätie — je to **free tier**, 10 GB grátis)
3. Zadaj credit card pre verifikáciu (NEBUDE účtovaná pokiaľ neprekročíš free tier)
   - **Free tier:** 10 GB storage, 1M class A operations, 10M class B operations / mes
   - Naša spotreba: ~432 MB storage, ~100 op/deň → **bezpečne pod free**

### 1.3 Vytvor bucket
1. R2 dashboard → klik **Create bucket**
2. **Bucket name:** `prplcrm-files`
3. **Location:** Automatic (Cloudflare vyberie najbližší PoP)
4. **Default storage class:** Standard
5. Klik **Create bucket** → hotové

> 💡 Bucket je **private by default** — files NIE sú verejne dostupné. Backend ich serveruje cez authentifikovaný endpoint.

---

## 2️⃣ R2 API Token (3 min)

### 2.1 Cloudflare API Tokens
1. Dashboard → klik na svoj profil vpravo hore → **API Tokens**
   - alebo priamo: https://dash.cloudflare.com/profile/api-tokens
2. Klik **Create Token**
3. Scroll dole, vedľa "Custom token" klik **Get started**

### 2.2 Token nastavenia

| Pole | Hodnota |
|---|---|
| **Token name** | `prplcrm-r2-backend` |
| **Permissions** | `R2` → `Edit` (write + read) |
| **Account Resources** | Include → All accounts |
| **Specific bucket** | (voliteľné) `prplcrm-files` ak chceš zúžiť scope |
| **Client IP Address Filtering** | nechaj prázdne (Render má dynamic IPs) |
| **TTL** | nechaj prázdne (forever) |

3. Klik **Continue to summary** → **Create Token**

### 2.3 Uložiť credentials

Token UI ti ukáže (LEN RAZ — uloř si):
- **Access Key ID** (32 znakov)
- **Secret Access Key** (64 znakov)

Plus z R2 bucket detailu si zoberieš:
- **Account ID** — vidno hore v R2 dashboarde, alebo v URL: `dash.cloudflare.com/<ACCOUNT_ID>/r2`

> ⚠️ Secret Key sa ti zobrazí **iba raz** — ak ho stratíš, treba vytvoriť nový token. Skopíruj ho **TERAZ** do password manager-a.

---

## 3️⃣ Render env vars (2 min)

### 3.1 Pridať na Render
1. Otvor [Render dashboard](https://dashboard.render.com) → tvoj `prpl-crm-api` service
2. **Environment** tab → klik **Add Environment Variable**
3. Pridaj **4 premenné**:

| Key | Value |
|---|---|
| `R2_ACCOUNT_ID` | (z R2 dashboard / URL) |
| `R2_ACCESS_KEY_ID` | (z API token-u) |
| `R2_SECRET_ACCESS_KEY` | (z API token-u) |
| `R2_BUCKET` | `prplcrm-files` |

4. Klik **Save Changes** — Render automaticky redeployuje (~3 min)

### 3.2 Overiť že R2 je k dispozícii
Po deployi pozri logs:
```
[FileStorage] R2 configured { bucket: 'prplcrm-files' }
```
Ak vidíš toto, R2 funguje. Ak vidíš `R2 NOT configured`, niektorá env var chýba.

---

## 4️⃣ Spustenie migration script-u (~5 min)

> ⚠️ **PRED migráciou si urob Atlas snapshot** (Atlas dashboard → tvoj cluster → Backup → Take Snapshot Now). V prípade problému máš rollback bod.

### 4.1 Dry-run najprv (žiadne zmeny)

Lokálne (alebo cez Render Shell):
```bash
# Nastaviť env vars lokálne (alebo cez .env file)
export MONGODB_URI="..."
export R2_ACCOUNT_ID="..."
export R2_ACCESS_KEY_ID="..."
export R2_SECRET_ACCESS_KEY="..."
export R2_BUCKET="prplcrm-files"

# Dry-run — len zistí koľko files by sa migrovalo
node server/scripts/migrate-files-to-r2.js --dry-run
```

Očakávaný výstup:
```
Stav contactfiles kolekcie:
   Celkom records:           83
   Už migrované (r2Key set): 0
   Potrebujú migráciu:       83
   Broken (žiadne dáta):     0

[DRY RUN] Migrovalo by sa 83 files. Spusti bez --dry-run flag-u.
```

### 4.2 Live migration

Ak dry-run vyzerá OK:
```bash
node server/scripts/migrate-files-to-r2.js
```

Script po každom file vypíše stav. Pri 83 files trvá ~2-5 minút (~5 MB priemer = max 30 sek per file).

Výstup po dokončení:
```
═══════════════════════════════════════════════════════════════
  Migration complete
═══════════════════════════════════════════════════════════════
   Processed: 83
   ✓ Succeeded: 83
   ✗ Failed:    0
   Bytes migrated to R2: 432.14 MB
   ~ Estimated MongoDB space freed: 574.65 MB (base64 overhead)
```

### 4.3 Ak nejaké files zlyhajú
Script je **idempotentný** — pri opakovanom spustení preskočí už migrované files (ktoré majú r2Key set) a pokúsi sa znova len o failed ones.

```bash
node server/scripts/migrate-files-to-r2.js  # opakovane bez --dry-run
```

---

## 5️⃣ Verification po migrácii

### 5.1 Test download v aplikácii
1. Otvor CRM → niektorý projekt → klik na nahraný file
2. Mal by sa stiahnuť normálne ako predtým
3. V Render logs vidíš:
   ```
   Contact file download: from R2 { fileId: '...', r2Key: 'contactfiles/...', size: ... }
   ```

### 5.2 Test upload nového file-u
1. Nahraj nový file v UI
2. V Render logs vidíš:
   ```
   [Contact upload] Stored in R2 { fileId: '...', r2Key: '...', size: ... }
   ```
3. V Atlas UI sa **nepridá** nová base64 data — len metadata row v `contactfiles` (~100 bytes)

### 5.3 Atlas storage release
- **Data size** klesne okamžite (refreshneš dashboard)
- **Storage size** klesne **do hodín** (Atlas interná kompakcia)
- Po 24h by si mal mať `peruncrm` na ~30-50 MB namiesto 466 MB

---

## 🚨 Troubleshooting

| Symptóm | Riešenie |
|---|---|
| `R2 NOT configured` v logoch | Chýba niektorá env var na Render. Skontroluj 4 premenné. |
| `Access Denied` pri uploade | API token nemá Edit permission alebo Account Resources zle nastavené. |
| `Bucket not found` | `R2_BUCKET` nesedí s názvom v Cloudflare (rozlišuje case). |
| Download 500 error | Pozri logs — pravdepodobne sieťový blip, R2 výpadok. Retry. |
| MongoDB storage neklesá | Atlas potrebuje hodiny na kompakciu. Daj tomu 24h. |

---

## 💰 Cost estimate

Aktuálne (~432 MB v 83 files):
- **R2 storage:** $0.015/GB/mes × 0.432 GB = **$0.0065/mes** (≈ 0 €)
- **R2 operations:** 100 ops/deň × 30 dní × $0 (free tier) = **$0**
- **Egress:** $0 (R2 výhoda — zero egress fees navždy)

Pri 10× raste (~10 GB v ~800 files):
- **R2 storage:** **stále $0** (free tier 10 GB)
- Operations: stále v free tier (1M class A ops/mes)

Pri 100× raste (~100 GB):
- **R2 storage:** 100 GB × $0.015 = **$1.50/mes**
- Stále radikálne lacnejšie ako MongoDB upgrade (M10 = $57/mes pre 10 GB)

---

## 📚 Reference

- R2 docs: https://developers.cloudflare.com/r2/
- AWS SDK v3: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/
- R2 + S3 SDK compat: https://developers.cloudflare.com/r2/api/s3/
