# Google Play Zero-Tap Sign-In (Block Store) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Android appka Prpl CRM obnoví prihlásenie po reinštalácii / na novom telefóne cez Block Store (Google Play požiadavka, v produkcii do 30. 9. 2026).

**Architecture:** Server vydáva 180-dňové jednorazové „restore tokeny" (v DB len SHA-256 hash, atomické Mongo operácie, rotácia pri použití). Android appka si ich natívne spravuje sama: po logine vydá a uloží do Block Store, pri cold starte bez platného JWT obnoví session ešte pred načítaním webu, pri logoute zruší. Web klient sa nemení.

**Tech Stack:** Express + Mongoose 9 (jest + supertest + mongodb-memory-server), Kotlin/Android (OkHttp 4.12, `play-services-auth-blockstore:16.4.0`, JUnit 4), Gradle 8.11.1, JDK temurin-17.

Spec: `docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md`

---

## File structure

**Server (`server/`)**
- Modify `models/User.js` — pole `restoreTokens[]` (`select: false`) + index.
- Create `utils/restoreTokens.js` — generovanie/hash, atomické vydanie, spotrebovanie (rotácia), revokácia.
- Modify `middleware/rateLimiter.js` — `restoreLimiter`, `restoreTokenLimiter`.
- Modify `routes/auth.js` — 3 endpointy + revokácia pri zmene/resete hesla.
- Create `__tests__/utils/restoreTokens.test.js`, `__tests__/routes/auth.restore.test.js`.

**Android (`android-native/app/`)**
- Modify `build.gradle.kts` — závislosť Block Store, verzia 208 / 1.0.7.
- Create `src/main/java/eu/prplcrm/app/JwtUtils.kt` + `src/test/java/eu/prplcrm/app/JwtUtilsTest.kt`.
- Create `src/main/java/eu/prplcrm/app/RestoreCredentialStore.kt` — Block Store vrstva.
- Create `src/main/java/eu/prplcrm/app/RestoreSession.kt` — HTTP orchestrácia.
- Modify `src/main/java/eu/prplcrm/app/WebAppInterface.kt` — hooky login/workspace/logout.
- Modify `src/main/java/eu/prplcrm/app/MainActivity.kt` — obnova pri cold starte.

Všetky príkazy pre server sa spúšťajú z `server/`, pre Android z `android-native/`.

---

### Task 1: User model — `restoreTokens`

**Files:**
- Modify: `server/models/User.js` (pred `}, {` s `timestamps: true`, t. j. za blok `googleTasks`)

- [ ] **Step 1: Pridať pole do schémy**

Nájdi koniec bloku `googleTasks: { ... }` (riadok so `syncToken: { type: String, default: null }` a zatvárajúcou `}`) a hneď za neho, stále vnútri hlavného objektu schémy, vlož:

```js
  ,
  // Google Play zero-tap sign-in (Block Store) — obnovovacie tokeny Android
  // appky. V DB len SHA-256 hash; plaintext má iba zariadenie (Block Store).
  // `select: false` = nikdy sa nevracia v bežných dopytoch (/me, /profile,
  // admin zoznamy) — routes, ktoré ich potrebujú, si vyžiadajú '+restoreTokens'.
  // Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
  restoreTokens: {
    type: [{
      tokenHash: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date, default: null },
      deviceLabel: { type: String, default: '', maxlength: 120 }
    }],
    default: [],
    select: false
  }
```

(Ak je za `googleTasks` blokom čiarka už prítomná, prispôsob — výsledok musí byť validný objekt.)

- [ ] **Step 2: Index na lookup podľa hashu**

Za definíciu `ENCRYPTED_TOKEN_PATHS` (pred `userSchema.pre('save', ...)`) pridaj:

```js
// Lookup obnovovacieho tokenu (POST /api/auth/restore) — multikey index.
userSchema.index({ 'restoreTokens.tokenHash': 1 }, { sparse: true });
```

- [ ] **Step 3: Overiť, že existujúce testy prechádzajú**

Run: `cd server && npx jest __tests__/routes/auth.test.js 2>&1 | tail -5`
Expected: všetky testy PASS.

- [ ] **Step 4: Commit**

```bash
git add server/models/User.js
git commit -m "feat(auth): User.restoreTokens pre Block Store obnovu prihlásenia"
```

---

### Task 2: Rate limitery

**Files:**
- Modify: `server/middleware/rateLimiter.js` (pred `module.exports`)

- [ ] **Step 1: Pridať limitery**

Pred `module.exports = {` vlož:

```js
// Obnova prihlásenia z Block Store (Android zero-tap sign-in). Verejné
// endpointy chránené len tokenom → 10 pokusov / 15 min / IP.
const restoreLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    message: 'Príliš veľa pokusov o obnovu prihlásenia. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: restore', { ip: req.ip });
    logSecurityEvent('security.rate_limited', req, { limiter: 'restore' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Vydanie obnovovacieho tokenu (autentifikované) — 20 / hod / IP.
const restoreTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: {
    message: 'Príliš veľa požiadaviek. Skúste znova o hodinu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: restore token issue', { ip: req.ip });
    logSecurityEvent('security.rate_limited', req, { limiter: 'restore_token' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});
```

a do `module.exports` doplň `restoreLimiter, restoreTokenLimiter`.

- [ ] **Step 2: Commit**

```bash
git add server/middleware/rateLimiter.js
git commit -m "feat(auth): rate limitery pre obnovu prihlásenia"
```

---

### Task 3: `utils/restoreTokens.js` (TDD)

**Files:**
- Create: `server/utils/restoreTokens.js`
- Test: `server/__tests__/utils/restoreTokens.test.js`

- [ ] **Step 1: Napísať zlyhávajúci test**

```js
const { createUserWithWorkspace } = require('../helpers/testApp');
const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const {
  MAX_RESTORE_TOKENS,
  RESTORE_TOKEN_TTL_MS,
  hashRestoreToken,
  issueRestoreToken,
  consumeRestoreToken,
  revokeRestoreToken,
  revokeAllRestoreTokens
} = require('../../utils/restoreTokens');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const loadTokens = async (id) => (await User.findById(id).select('+restoreTokens')).restoreTokens;

describe('utils/restoreTokens', () => {
  let user;

  beforeAll(async () => { await User.init(); });
  beforeEach(async () => {
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});
    ({ user } = await createUserWithWorkspace({ username: 'rt', email: 'rt@test.com' }));
  });
  afterAll(async () => { await mongoose.connection.close(); });

  it('issueRestoreToken uloží len hash, vráti plaintext + expiresAt ≈ 180 dní', async () => {
    const before = Date.now();
    const issued = await issueRestoreToken(user._id, 'Pixel 8');
    expect(typeof issued.plaintext).toBe('string');
    expect(issued.plaintext.length).toBeGreaterThanOrEqual(40);
    expect(issued.expiresAt.getTime() - before).toBeGreaterThanOrEqual(RESTORE_TOKEN_TTL_MS - 5000);

    const tokens = await loadTokens(user._id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(sha256(issued.plaintext));
    expect(tokens[0].deviceLabel).toBe('Pixel 8');
    expect(JSON.stringify(tokens)).not.toContain(issued.plaintext);

    // select:false → bežný dopyt pole nevráti
    const plain = await User.findById(user._id);
    expect(plain.restoreTokens).toBeUndefined();
  });

  it('issueRestoreToken drží strop MAX_RESTORE_TOKENS (najstarší vypadne)', async () => {
    const issued = [];
    for (let i = 0; i < MAX_RESTORE_TOKENS + 1; i++) {
      issued.push(await issueRestoreToken(user._id, `d${i}`));
    }
    const tokens = await loadTokens(user._id);
    expect(tokens).toHaveLength(MAX_RESTORE_TOKENS);
    const hashes = tokens.map((t) => t.tokenHash);
    expect(hashes).not.toContain(hashRestoreToken(issued[0].plaintext));
    expect(hashes).toContain(hashRestoreToken(issued[MAX_RESTORE_TOKENS].plaintext));
  });

  it('issueRestoreToken vracia null pre neexistujúceho usera', async () => {
    expect(await issueRestoreToken(new mongoose.Types.ObjectId(), 'x')).toBeNull();
  });

  it('consumeRestoreToken je jednorazový a vráti usera + záznam', async () => {
    const issued = await issueRestoreToken(user._id, 'Pixel 8');
    const first = await consumeRestoreToken(issued.plaintext);
    expect(first.ok).toBe(true);
    expect(first.user._id.toString()).toBe(user._id.toString());
    expect(first.entry.deviceLabel).toBe('Pixel 8');
    expect(await loadTokens(user._id)).toHaveLength(0);

    const second = await consumeRestoreToken(issued.plaintext);
    expect(second).toEqual({ ok: false, reason: 'invalid' });
  });

  it('consumeRestoreToken odmietne expirovaný token a záznam uprace', async () => {
    const issued = await issueRestoreToken(user._id, 'old');
    await User.updateOne(
      { _id: user._id, 'restoreTokens.tokenHash': hashRestoreToken(issued.plaintext) },
      { $set: { 'restoreTokens.$.expiresAt': new Date(Date.now() - 1000) } }
    );
    expect(await consumeRestoreToken(issued.plaintext)).toEqual({ ok: false, reason: 'expired' });
    expect(await loadTokens(user._id)).toHaveLength(0);
  });

  it('revokeRestoreToken zmaže jeden záznam a vráti vlastníka; neznámy → null', async () => {
    const a = await issueRestoreToken(user._id, 'a');
    const b = await issueRestoreToken(user._id, 'b');
    const owner = await revokeRestoreToken(a.plaintext);
    expect(owner._id.toString()).toBe(user._id.toString());
    const tokens = await loadTokens(user._id);
    expect(tokens.map((t) => t.tokenHash)).toEqual([hashRestoreToken(b.plaintext)]);
    expect(await revokeRestoreToken('neexistuje-neexistuje-neexistuje-neexistuje')).toBeNull();
  });

  it('revokeAllRestoreTokens vyprázdni pole', async () => {
    await issueRestoreToken(user._id, 'a');
    await issueRestoreToken(user._id, 'b');
    await revokeAllRestoreTokens(user._id);
    expect(await loadTokens(user._id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Spustiť a overiť zlyhanie**

Run: `cd server && npx jest __tests__/utils/restoreTokens.test.js 2>&1 | tail -8`
Expected: FAIL — `Cannot find module '../../utils/restoreTokens'`.

- [ ] **Step 3: Implementácia**

`server/utils/restoreTokens.js`:

```js
/**
 * Obnovovacie tokeny pre Google Play zero-tap sign-in (Block Store).
 *
 * Token = 32 náhodných bajtov (base64url). V DB LEN SHA-256 hash. Platnosť
 * 180 dní, jednorazový (pri použití sa atomicky odstráni a vydá nový),
 * max 5 na používateľa (najstaršie vypadnú). Všetky zápisy sú atomické
 * Mongo update-y — bez VersionError pri paralelnom logine z dvoch zariadení
 * a bez replay race (dva súbežné POST /restore s tým istým tokenom → uspeje
 * presne jeden).
 *
 * Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
const crypto = require('crypto');
const User = require('../models/User');

const RESTORE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 dní
const MAX_RESTORE_TOKENS = 5;
const DEVICE_LABEL_MAX = 120;

const hashRestoreToken = (plaintext) =>
  crypto.createHash('sha256').update(String(plaintext)).digest('hex');

const generateRestoreToken = () => {
  const plaintext = crypto.randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashRestoreToken(plaintext) };
};

const cleanLabel = (label) => String(label || '').trim().slice(0, DEVICE_LABEL_MAX);

/**
 * Vydá nový token používateľovi. Vráti { plaintext, expiresAt } alebo null,
 * ak používateľ neexistuje. Expirované záznamy odstráni, pole oreže na
 * MAX_RESTORE_TOKENS najnovších.
 */
const issueRestoreToken = async (userId, deviceLabel = '', now = new Date()) => {
  const { plaintext, tokenHash } = generateRestoreToken();
  const expiresAt = new Date(now.getTime() + RESTORE_TOKEN_TTL_MS);
  const entry = {
    tokenHash,
    expiresAt,
    createdAt: now,
    lastUsedAt: null,
    deviceLabel: cleanLabel(deviceLabel)
  };

  await User.updateOne(
    { _id: userId },
    { $pull: { restoreTokens: { expiresAt: { $lte: now } } } }
  );
  const result = await User.updateOne(
    { _id: userId },
    {
      $push: {
        restoreTokens: {
          $each: [entry],
          $sort: { createdAt: 1 },
          $slice: -MAX_RESTORE_TOKENS
        }
      }
    }
  );
  if (result.matchedCount === 0) return null;
  return { plaintext, expiresAt };
};

/**
 * Atomicky spotrebuje token (odstráni záznam). Vráti
 *   { ok: true, user, entry }  — hydrated User (bez avatarData) + použitý záznam
 *   { ok: false, reason: 'expired' | 'invalid' }
 */
const consumeRestoreToken = async (plaintext, now = new Date()) => {
  const tokenHash = hashRestoreToken(plaintext);
  const user = await User.findOneAndUpdate(
    { restoreTokens: { $elemMatch: { tokenHash, expiresAt: { $gt: now } } } },
    { $pull: { restoreTokens: { tokenHash } } },
    { new: false }
  ).select('+restoreTokens -avatarData');

  if (!user) {
    // Expirovaný záznam upraceme, aby pole nerástlo (a rozlíšime dôvod pre audit).
    const stale = await User.updateOne(
      { 'restoreTokens.tokenHash': tokenHash },
      { $pull: { restoreTokens: { tokenHash } } }
    );
    return { ok: false, reason: stale.matchedCount > 0 ? 'expired' : 'invalid' };
  }

  const entry = user.restoreTokens.find((t) => t.tokenHash === tokenHash) || null;
  return { ok: true, user, entry };
};

/** Zruší jeden token. Vráti vlastníka ({ _id, username, email }) alebo null. */
const revokeRestoreToken = async (plaintext) => {
  const tokenHash = hashRestoreToken(plaintext);
  return User.findOneAndUpdate(
    { 'restoreTokens.tokenHash': tokenHash },
    { $pull: { restoreTokens: { tokenHash } } },
    { new: false }
  ).select('_id username email');
};

/** Zruší všetky tokeny používateľa (zmena/reset hesla). */
const revokeAllRestoreTokens = (userId) =>
  User.updateOne({ _id: userId }, { $set: { restoreTokens: [] } });

module.exports = {
  RESTORE_TOKEN_TTL_MS,
  MAX_RESTORE_TOKENS,
  hashRestoreToken,
  generateRestoreToken,
  issueRestoreToken,
  consumeRestoreToken,
  revokeRestoreToken,
  revokeAllRestoreTokens
};
```

- [ ] **Step 4: Spustiť testy**

Run: `cd server && npx jest __tests__/utils/restoreTokens.test.js 2>&1 | tail -12`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/utils/restoreTokens.js server/__tests__/utils/restoreTokens.test.js
git commit -m "feat(auth): utils/restoreTokens — atomické vydanie, spotrebovanie a revokácia"
```

---

### Task 4: Endpointy `/restore-token`, `/restore`, `DELETE /restore-token` (TDD)

**Files:**
- Modify: `server/routes/auth.js` (importy + nový blok za `router.get('/me', ...)`)
- Test: `server/__tests__/routes/auth.restore.test.js`

- [ ] **Step 1: Napísať zlyhávajúce testy**

```js
const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const authRouter = require('../../routes/auth');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const { MAX_RESTORE_TOKENS, hashRestoreToken } = require('../../utils/restoreTokens');

/**
 * Google Play zero-tap sign-in (Block Store) — obnovovacie tokeny.
 * Invarianty:
 *   - plaintext tokenu nikdy nie je v DB ani v /me, /login
 *   - token je jednorazový, pri použití sa rotuje
 *   - zmena aj reset hesla zrušia všetky tokeny
 */
describe('/api/auth restore tokeny (Block Store)', () => {
  let app;
  const loadTokens = async (id) => (await User.findById(id).select('+restoreTokens')).restoreTokens;

  beforeAll(async () => {
    await User.init(); await Workspace.init(); await WorkspaceMember.init();
    ({ app } = createTestApp('/api/auth', authRouter));
  });
  beforeEach(async () => {
    await WorkspaceMember.deleteMany({}); await Workspace.deleteMany({}); await User.deleteMany({});
  });
  afterAll(async () => { await mongoose.connection.close(); });

  const issue = async (token, deviceLabel = 'Pixel 8') =>
    request(app).post('/api/auth/restore-token').set(authHeader(token)).send({ deviceLabel });

  describe('POST /restore-token', () => {
    it('vydá token (200), v DB je len hash, expiresAt ≈ 180 dní', async () => {
      const { user, token } = await createUserWithWorkspace();
      const res = await issue(token);
      expect(res.status).toBe(200);
      expect(typeof res.body.restoreToken).toBe('string');
      expect(res.body.restoreToken.length).toBeGreaterThanOrEqual(40);
      const days = (new Date(res.body.expiresAt) - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(179);
      expect(days).toBeLessThanOrEqual(180);

      const tokens = await loadTokens(user._id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].tokenHash).toBe(hashRestoreToken(res.body.restoreToken));
      expect(tokens[0].deviceLabel).toBe('Pixel 8');
    });

    it('401 bez JWT', async () => {
      const res = await request(app).post('/api/auth/restore-token').send({});
      expect(res.status).toBe(401);
    });

    it('403 pre super admina', async () => {
      const { token } = await createUserWithWorkspace({ username: 'sa', email: 'support@prplcrm.eu' });
      expect((await issue(token)).status).toBe(403);
    });

    it('drží strop MAX_RESTORE_TOKENS', async () => {
      const { user, token } = await createUserWithWorkspace();
      for (let i = 0; i <= MAX_RESTORE_TOKENS; i++) await issue(token, `d${i}`);
      expect(await loadTokens(user._id)).toHaveLength(MAX_RESTORE_TOKENS);
    });
  });

  describe('POST /restore', () => {
    it('vráti nový JWT (funguje na /me) + rotovaný token; starý token už neplatí', async () => {
      const { user, token } = await createUserWithWorkspace({ email: 'r@test.com' });
      const first = (await issue(token)).body.restoreToken;

      const res = await request(app).post('/api/auth/restore').send({ restoreToken: first });
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual(expect.objectContaining({ email: 'r@test.com', username: 'testuser' }));
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.restoreTokens).toBeUndefined();
      expect(res.body.restoreToken).not.toBe(first);

      const me = await request(app).get('/api/auth/me').set(authHeader(res.body.token));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe('r@test.com');
      expect(me.body.restoreTokens).toBeUndefined();

      expect((await request(app).post('/api/auth/restore').send({ restoreToken: first })).status).toBe(401);
      const again = await request(app).post('/api/auth/restore').send({ restoreToken: res.body.restoreToken });
      expect(again.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(1);
    });

    it('401 pre expirovaný token a záznam sa odstráni', async () => {
      const { user, token } = await createUserWithWorkspace();
      const plain = (await issue(token)).body.restoreToken;
      await User.updateOne(
        { _id: user._id, 'restoreTokens.tokenHash': hashRestoreToken(plain) },
        { $set: { 'restoreTokens.$.expiresAt': new Date(Date.now() - 1000) } }
      );
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: plain })).status).toBe(401);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });

    it('401 pre neznámy token, 400 pre chýbajúci', async () => {
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: 'x'.repeat(43) })).status).toBe(401);
      expect((await request(app).post('/api/auth/restore').send({})).status).toBe(400);
    });

    it('token zrušený cez DELETE /restore-token už neobnoví; DELETE je idempotentný', async () => {
      const { user, token } = await createUserWithWorkspace();
      const plain = (await issue(token)).body.restoreToken;
      const del = await request(app).delete('/api/auth/restore-token').send({ restoreToken: plain });
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ ok: true });
      expect(await loadTokens(user._id)).toHaveLength(0);
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: plain })).status).toBe(401);
      expect((await request(app).delete('/api/auth/restore-token').send({ restoreToken: plain })).status).toBe(200);
      expect((await request(app).delete('/api/auth/restore-token').send({})).status).toBe(200);
    });
  });

  describe('revokácia pri zmene / resete hesla', () => {
    it('PUT /password vyprázdni restoreTokens', async () => {
      const { user, token } = await createUserWithWorkspace();
      await User.updateOne({ _id: user._id }, { password: await bcrypt.hash('Kr4sn0hOrsk3!x', 12) });
      await issue(token);
      const res = await request(app).put('/api/auth/password').set(authHeader(token))
        .send({ currentPassword: 'Kr4sn0hOrsk3!x', newPassword: 'N0veHesl0Silne!x' });
      expect(res.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });

    it('POST /reset-password vyprázdni restoreTokens', async () => {
      const { user, token } = await createUserWithWorkspace();
      await issue(token);
      const raw = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ _id: user._id }, {
        resetPasswordTokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        resetPasswordExpires: new Date(Date.now() + 3600000)
      });
      const res = await request(app).post('/api/auth/reset-password').send({ token: raw, newPassword: 'N0veHesl0Silne!x' });
      expect(res.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Spustiť a overiť zlyhanie**

Run: `cd server && npx jest __tests__/routes/auth.restore.test.js 2>&1 | grep -E "✓|✕|Tests:"`
Expected: všetky testy FAIL (404 namiesto 200/401; revokačné testy zlyhajú na dĺžke poľa).

- [ ] **Step 3: Importy v `routes/auth.js`**

Do destructuringu z `../middleware/rateLimiter` doplň `restoreLimiter, restoreTokenLimiter`. Za `const { validatePassword } = require('../utils/passwordPolicy');` pridaj:

```js
const {
  issueRestoreToken,
  consumeRestoreToken,
  revokeRestoreToken,
  revokeAllRestoreTokens
} = require('../utils/restoreTokens');
```

- [ ] **Step 4: Endpointy** — vlož za handler `router.get('/me', ...)`:

```js
// ─────────────────────────────────────────────────────────────────────
// Google Play zero-tap sign-in (Block Store) — obnovovacie tokeny Android
// appky. Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
//   POST   /restore-token  (JWT)      → vydá 180-dňový jednorazový token
//   POST   /restore        (verejný)  → token → nový JWT + rotovaný token
//   DELETE /restore-token  (verejný)  → zruší token (dôkaz vlastníctvom,
//                                      funguje aj po expirácii JWT pri logoute)
// Plaintext tokenu sa nikdy neloguje ani neukladá.
// ─────────────────────────────────────────────────────────────────────

const RESTORE_TOKEN_MIN = 32;
const RESTORE_TOKEN_MAX = 128;
const isRestoreTokenShape = (t) =>
  typeof t === 'string' && t.length >= RESTORE_TOKEN_MIN && t.length <= RESTORE_TOKEN_MAX;

const publicUser = (user) => ({
  id: user._id,
  username: user.username,
  email: user.email,
  color: user.color,
  avatar: user.avatar,
  role: user.role
});

router.post('/restore-token', authenticateToken, restoreTokenLimiter, async (req, res) => {
  try {
    if (String(req.user.email || '').toLowerCase() === 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Nedostupné pre tento účet' });
    }
    const deviceLabel = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : '';
    const issued = await issueRestoreToken(req.user.id, deviceLabel);
    if (!issued) {
      return res.status(401).json({ message: 'Neplatný token' });
    }

    auditService.logAction({
      userId: req.user.id.toString(),
      username: req.user.username,
      email: req.user.email,
      action: 'auth.restore_token_issued',
      category: 'auth',
      targetType: 'user',
      targetId: req.user.id.toString(),
      details: { deviceLabel: deviceLabel.slice(0, 120) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json({ restoreToken: issued.plaintext, expiresAt: issued.expiresAt });
  } catch (error) {
    logger.error('Restore token issue error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.post('/restore', restoreLimiter, async (req, res) => {
  try {
    const { restoreToken } = req.body || {};
    if (!isRestoreTokenShape(restoreToken)) {
      return res.status(400).json({ message: 'Obnovovací token je povinný' });
    }

    const consumed = await consumeRestoreToken(restoreToken);
    if (!consumed.ok) {
      auditService.logAction({
        action: 'auth.restore_failed',
        category: 'auth',
        details: { reason: consumed.reason },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(401).json({ message: 'Neplatný alebo expirovaný obnovovací token' });
    }

    const { user, entry } = consumed;
    if (String(user.email || '').toLowerCase() === 'support@prplcrm.eu') {
      return res.status(401).json({ message: 'Neplatný alebo expirovaný obnovovací token' });
    }

    const deviceLabel = entry?.deviceLabel || '';
    const rotated = await issueRestoreToken(user._id, deviceLabel);
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

    logger.auth('restore', user._id, user.username, true, req.ip);
    auditService.logAction({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.restore',
      category: 'auth',
      targetType: 'user',
      targetId: user._id.toString(),
      targetName: user.username,
      details: { deviceLabel },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    res.json({
      token,
      restoreToken: rotated ? rotated.plaintext : null,
      expiresAt: rotated ? rotated.expiresAt : null,
      user: publicUser(user)
    });
  } catch (error) {
    logger.error('Restore error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.delete('/restore-token', restoreLimiter, async (req, res) => {
  try {
    const { restoreToken } = req.body || {};
    if (isRestoreTokenShape(restoreToken)) {
      const owner = await revokeRestoreToken(restoreToken);
      if (owner) {
        auditService.logAction({
          userId: owner._id.toString(),
          username: owner.username,
          email: owner.email,
          action: 'auth.restore_token_revoked',
          category: 'auth',
          targetType: 'user',
          targetId: owner._id.toString(),
          details: {},
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        });
      }
    }
    // Idempotentné — klient (logout) nepotrebuje rozlišovať.
    res.json({ ok: true });
  } catch (error) {
    logger.error('Restore token revoke error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});
```

- [ ] **Step 5: Revokácia pri zmene hesla** — v `router.put('/password', ...)` hneď za riadok `await User.findByIdAndUpdate(userId, { password: hashedPassword });` pridaj:

```js
    // Zmena hesla = zneplatniť všetky Block Store obnovovacie tokeny (Android).
    await revokeAllRestoreTokens(userId);
```

- [ ] **Step 6: Revokácia pri resete hesla** — v `router.post('/reset-password', ...)` za blok
```js
    user.password = hashedPassword;
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpires = null;
    await user.save();
```
pridaj:
```js
    // Reset hesla = zneplatniť všetky Block Store obnovovacie tokeny (Android).
    await revokeAllRestoreTokens(user._id);
```

- [ ] **Step 7: Spustiť testy**

Run: `cd server && npx jest __tests__/routes/auth.restore.test.js 2>&1 | grep -E "✓|✕|Tests:"`
Expected: 10 passed.

- [ ] **Step 8: Celá sada**

Run: `cd server && npx jest 2>&1 | tail -6`
Expected: všetky suites PASS (686 + 17 nových).

- [ ] **Step 9: Commit**

```bash
git add server/routes/auth.js server/__tests__/routes/auth.restore.test.js
git commit -m "feat(auth): Block Store obnova prihlásenia — /restore-token, /restore, revokácia"
```

---

### Task 5: Server nasadenie

- [ ] **Step 1: Push** — `git push origin main` (Render auto-deploy `prpl-crm-api`).
- [ ] **Step 2: Overiť** po ~3 min: `curl -s https://perun-crm-api.onrender.com/api/version` obsahuje nový commit hash; `curl -s -X POST https://perun-crm-api.onrender.com/api/auth/restore -H 'Content-Type: application/json' -d '{}'` → `400 {"message":"Obnovovací token je povinný"}`.

---

### Task 6: Android — Gradle závislosť + verzia

**Files:**
- Modify: `android-native/app/build.gradle.kts`

- [ ] **Step 1: Verzia**

```kotlin
        versionCode = 208      // production.9 — Google Play zero-tap sign-in (Block Store obnova prihlásenia)
        versionName = "1.0.7"
```

- [ ] **Step 2: Závislosť** — za OkHttp riadok:

```kotlin
    // Block Store (Google Play services) — obnova prihlásenia po reinštalácii /
    // na novom telefóne. Google Play požiadavka „zero-tap sign-in" (v produkcii
    // do 30. 9. 2026). Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
    implementation("com.google.android.gms:play-services-auth-blockstore:16.4.0")
```

- [ ] **Step 3: Overiť resolve**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:dependencies --configuration debugRuntimeClasspath 2>&1 | grep -c blockstore`
Expected: číslo ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add android-native/app/build.gradle.kts
git commit -m "build(android): Block Store závislosť, verzia 1.0.7 (208)"
```

---

### Task 7: `JwtUtils.kt` (TDD, čistý Kotlin)

**Files:**
- Create: `android-native/app/src/test/java/eu/prplcrm/app/JwtUtilsTest.kt`
- Create: `android-native/app/src/main/java/eu/prplcrm/app/JwtUtils.kt`

- [ ] **Step 1: Test**

```kotlin
package eu.prplcrm.app

import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JwtUtilsTest {

    private fun jwt(payloadJson: String): String {
        val header = """{"alg":"HS256","typ":"JWT"}""".encodeUtf8().base64Url().trimEnd('=')
        val payload = payloadJson.encodeUtf8().base64Url().trimEnd('=')
        return "$header.$payload.podpis"
    }

    private val now = 1_800_000_000L

    @Test
    fun `expiresAtSeconds precita exp`() {
        assertEquals(1_800_000_600L, JwtUtils.expiresAtSeconds(jwt("""{"id":"abc","exp":1800000600,"iat":1}""")))
    }

    @Test
    fun `platny token nie je expirovany`() {
        assertFalse(JwtUtils.isExpired(jwt("""{"exp":${now + 3600}}"""), nowSeconds = now))
    }

    @Test
    fun `token po exp je expirovany`() {
        assertTrue(JwtUtils.isExpired(jwt("""{"exp":${now - 1}}"""), nowSeconds = now))
    }

    @Test
    fun `token tesne pred exp (v ramci skew) je expirovany`() {
        assertTrue(JwtUtils.isExpired(jwt("""{"exp":${now + 30}}"""), nowSeconds = now, skewSeconds = 60))
    }

    @Test
    fun `null, prazdny, poskodeny a bez exp = expirovany`() {
        assertTrue(JwtUtils.isExpired(null, nowSeconds = now))
        assertTrue(JwtUtils.isExpired("", nowSeconds = now))
        assertTrue(JwtUtils.isExpired("nie.je.jwt", nowSeconds = now))
        assertTrue(JwtUtils.isExpired("abc", nowSeconds = now))
        assertTrue(JwtUtils.isExpired(jwt("""{"id":"abc"}"""), nowSeconds = now))
        assertNull(JwtUtils.expiresAtSeconds("nie.je.jwt"))
    }
}
```

- [ ] **Step 2: Spustiť a overiť zlyhanie**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:testDebugUnitTest --tests 'eu.prplcrm.app.JwtUtilsTest' 2>&1 | tail -15`
Expected: kompilácia zlyhá — `Unresolved reference: JwtUtils`.

- [ ] **Step 3: Implementácia**

```kotlin
package eu.prplcrm.app

import okio.ByteString.Companion.decodeBase64

/**
 * Lokálne (bez overenia podpisu) čítanie `exp` z JWT.
 *
 * Slúži LEN na rozhodnutie pri cold starte, či má zmysel uložený token
 * injectnúť do webu, alebo rovno skúsiť obnovu z Block Store. Server token
 * vždy overuje sám — toto nie je bezpečnostné rozhodnutie. Čistý Kotlin
 * (okio + regex, bez android.* tried), aby bol testovateľný v JVM unit testoch.
 */
object JwtUtils {

    private val EXP_REGEX = Regex("\"exp\"\\s*:\\s*(\\d+)")

    /** Sekundy od epochy z claimu `exp`, alebo null ak sa nedá prečítať. */
    fun expiresAtSeconds(jwt: String?): Long? {
        if (jwt.isNullOrBlank()) return null
        val parts = jwt.split('.')
        if (parts.size < 2) return null
        val payload = parts[1].decodeBase64()?.utf8() ?: return null
        return EXP_REGEX.find(payload)?.groupValues?.get(1)?.toLongOrNull()
    }

    /** true = expirovaný, poškodený alebo chýbajúci token (vždy radšej obnova). */
    fun isExpired(
        jwt: String?,
        nowSeconds: Long = System.currentTimeMillis() / 1000,
        skewSeconds: Long = 60
    ): Boolean {
        val exp = expiresAtSeconds(jwt) ?: return true
        return exp - skewSeconds <= nowSeconds
    }
}
```

- [ ] **Step 4: Spustiť testy**

Run: rovnaký príkaz ako v kroku 2.
Expected: `BUILD SUCCESSFUL`, 5 testov prešlo (report `app/build/reports/tests/testDebugUnitTest/index.html`).

- [ ] **Step 5: Commit**

```bash
git add android-native/app/src/main/java/eu/prplcrm/app/JwtUtils.kt android-native/app/src/test/java/eu/prplcrm/app/JwtUtilsTest.kt
git commit -m "feat(android): JwtUtils — lokálna detekcia expirovaného JWT (+ unit testy)"
```

---

### Task 8: `RestoreCredentialStore.kt` (Block Store vrstva)

**Files:**
- Create: `android-native/app/src/main/java/eu/prplcrm/app/RestoreCredentialStore.kt`

- [ ] **Step 1: Implementácia**

```kotlin
package eu.prplcrm.app

import android.content.Context
import android.util.Log
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData

/**
 * Block Store (Google Play services) — úložisko, ktoré prežije reinštaláciu
 * aj prenos na nový telefón (device-to-device / cloud restore).
 *
 * Ukladáme LEN obnovovací token (nie JWT) a workspace id. Do cloudu sa
 * zálohuje iba pri dostupnom end-to-end šifrovaní (podmienka Google:
 * Android 9+ a nastavený zámok obrazovky); inak ostáva lokálne/D2D.
 * POZOR: podľa dokumentácie zápis bez setShouldBackupToCloud(true) zmaže
 * predchádzajúcu cloud zálohu — preto flag nastavujeme konzistentne pri
 * každom zápise podľa aktuálnej dostupnosti E2EE.
 *
 * Každé volanie je best-effort: bez Google Play services (Huawei) len
 * zaloguje a nikdy nepadá. Callbacky Tasks API bežia na main threade.
 *
 * Google Play požiadavka „zero-tap sign-in" — dizajn:
 * docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
object RestoreCredentialStore {

    private const val TAG = "RestoreCredentialStore"
    const val KEY_RESTORE_TOKEN = "eu.prplcrm.app.restore_token"
    const val KEY_WORKSPACE_ID = "eu.prplcrm.app.workspace_id"

    data class Snapshot(val restoreToken: String?, val workspaceId: String?)

    private fun client(context: Context): BlockstoreClient =
        Blockstore.getClient(context.applicationContext)

    /** Uloží token + (voliteľne) workspace id. */
    fun save(context: Context, restoreToken: String, workspaceId: String?) {
        withE2ee(context) { e2ee ->
            store(context, KEY_RESTORE_TOKEN, restoreToken, e2ee)
            if (!workspaceId.isNullOrBlank()) store(context, KEY_WORKSPACE_ID, workspaceId, e2ee)
        }
    }

    /** Aktualizuje len workspace id (pri prepnutí prostredia). */
    fun saveWorkspaceId(context: Context, workspaceId: String) {
        withE2ee(context) { e2ee -> store(context, KEY_WORKSPACE_ID, workspaceId, e2ee) }
    }

    /** Prečíta oba kľúče; chýbajúci kľúč = null. Pri chybe GMS vráti null. */
    fun load(context: Context, onResult: (Snapshot?) -> Unit) {
        val request = try {
            RetrieveBytesRequest.Builder()
                .setKeys(listOf(KEY_RESTORE_TOKEN, KEY_WORKSPACE_ID))
                .build()
        } catch (e: Exception) {
            Log.w(TAG, "retrieve request build failed", e); onResult(null); return
        }
        try {
            client(context).retrieveBytes(request)
                .addOnSuccessListener { result ->
                    val map = result.blockstoreDataMap
                    val token = map[KEY_RESTORE_TOKEN]?.bytes?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                    val ws = map[KEY_WORKSPACE_ID]?.bytes?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                    Log.i(TAG, "load: token=${token != null} workspace=${ws != null}")
                    onResult(Snapshot(token, ws))
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "retrieveBytes failed (GMS?)", e)
                    onResult(null)
                }
        } catch (e: Exception) {
            Log.w(TAG, "retrieveBytes threw", e); onResult(null)
        }
    }

    /** Zmaže naše kľúče (logout / zrušený token). */
    fun clear(context: Context) {
        try {
            val request = DeleteBytesRequest.Builder()
                .setKeys(listOf(KEY_RESTORE_TOKEN, KEY_WORKSPACE_ID))
                .build()
            client(context).deleteBytes(request)
                .addOnSuccessListener { Log.i(TAG, "cleared") }
                .addOnFailureListener { e -> Log.w(TAG, "deleteBytes failed", e) }
        } catch (e: Exception) {
            Log.w(TAG, "deleteBytes threw", e)
        }
    }

    private fun withE2ee(context: Context, block: (Boolean) -> Unit) {
        try {
            client(context).isEndToEndEncryptionAvailable
                .addOnSuccessListener { available -> block(available) }
                .addOnFailureListener { e ->
                    Log.w(TAG, "E2EE check failed → local only", e)
                    block(false)
                }
        } catch (e: Exception) {
            Log.w(TAG, "E2EE check threw → local only", e); block(false)
        }
    }

    private fun store(context: Context, key: String, value: String, cloud: Boolean) {
        try {
            val data = StoreBytesData.Builder()
                .setBytes(value.toByteArray(Charsets.UTF_8))
                .setKeys(listOf(key))
                .setShouldBackupToCloud(cloud)
                .build()
            client(context).storeBytes(data)
                .addOnSuccessListener { n -> Log.i(TAG, "stored $key ($n B, cloud=$cloud)") }
                .addOnFailureListener { e -> Log.w(TAG, "storeBytes $key failed", e) }
        } catch (e: Exception) {
            Log.w(TAG, "storeBytes $key threw", e)
        }
    }
}
```

Poznámka: ak Kotlin nahlási, že `isEndToEndEncryptionAvailable` je metóda (nie property), použi `client(context).isEndToEndEncryptionAvailable()`.

- [ ] **Step 2: Kompilácia**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android-native/app/src/main/java/eu/prplcrm/app/RestoreCredentialStore.kt
git commit -m "feat(android): RestoreCredentialStore — Block Store vrstva pre obnovu prihlásenia"
```

---

### Task 9: `RestoreSession.kt` (HTTP orchestrácia)

**Files:**
- Create: `android-native/app/src/main/java/eu/prplcrm/app/RestoreSession.kt`

- [ ] **Step 1: Implementácia**

```kotlin
package eu.prplcrm.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Orchestrácia obnovy prihlásenia (Google Play zero-tap sign-in):
 *
 *   login  → issueAfterLogin(): POST /api/auth/restore-token → Block Store
 *   start  → tryRestore(): Block Store → POST /api/auth/restore → TokenStore
 *   logout → revokeAndClear(): DELETE /api/auth/restore-token + Block Store clear
 *
 * Vzor HTTP volania = FcmRegistrar (OkHttp, api_base_url). Plaintext tokenu
 * sa nikdy neloguje. Všetky callbacky sa vracajú na main thread.
 * Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
object RestoreSession {

    private const val TAG = "RestoreSession"
    private val JSON = "application/json".toMediaType()
    private val mainHandler = Handler(Looper.getMainLooper())

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS)
            .writeTimeout(3, TimeUnit.SECONDS)
            .build()
    }

    private fun apiUrl(context: Context, path: String): String =
        context.getString(R.string.api_base_url).removeSuffix("/") + path

    private fun jsonBody(vararg pairs: Pair<String, String>) =
        JSONObject().apply { pairs.forEach { (k, v) -> put(k, v) } }.toString().toRequestBody(JSON)

    /** Po každom novom logine: vydaj obnovovací token a ulož ho do Block Store. */
    fun issueAfterLogin(context: Context, jwt: String) {
        val app = context.applicationContext
        val label = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120)
        val request = Request.Builder()
            .url(apiUrl(app, "/api/auth/restore-token"))
            .post(jsonBody("deviceLabel" to label))
            .addHeader("Authorization", "Bearer $jwt")
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "issue failed: ${e.javaClass.simpleName}")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string() ?: ""
                    if (!it.isSuccessful) { Log.w(TAG, "issue HTTP ${it.code}"); return }
                    val token = try { JSONObject(text).optString("restoreToken") } catch (e: Exception) { "" }
                    if (token.isBlank()) { Log.w(TAG, "issue: empty token"); return }
                    mainHandler.post {
                        RestoreCredentialStore.save(app, token, TokenStore.getCurrentWorkspaceId(app))
                    }
                }
            }
        })
    }

    /**
     * Pokus o obnovu pri cold starte. `onDone(true)` = TokenStore má nový JWT.
     * Volá sa presne raz (aj pri timeoute) na main threade. Ak server odpovie
     * až po timeoute, ale úspešne, JWT sa uloží a zavolá sa `onLateSuccess`.
     */
    fun tryRestore(
        context: Context,
        timeoutMs: Long = 3000,
        onLateSuccess: (() -> Unit)? = null,
        onDone: (Boolean) -> Unit
    ) {
        val app = context.applicationContext
        val finished = AtomicBoolean(false)
        fun finish(ok: Boolean) {
            if (finished.compareAndSet(false, true)) mainHandler.post { onDone(ok) }
            else if (ok) mainHandler.post { onLateSuccess?.invoke() }
        }
        mainHandler.postDelayed({ if (!finished.get()) Log.i(TAG, "restore timeout"); finish(false) }, timeoutMs)

        RestoreCredentialStore.load(app) { snapshot ->
            val restoreToken = snapshot?.restoreToken
            if (restoreToken.isNullOrBlank()) { finish(false); return@load }

            val request = Request.Builder()
                .url(apiUrl(app, "/api/auth/restore"))
                .post(jsonBody("restoreToken" to restoreToken))
                .build()
            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    Log.w(TAG, "restore failed: ${e.javaClass.simpleName}")
                    finish(false)
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val text = it.body?.string() ?: ""
                        if (it.code == 401) {
                            Log.i(TAG, "restore token rejected → clearing Block Store")
                            mainHandler.post { RestoreCredentialStore.clear(app) }
                            finish(false); return
                        }
                        if (!it.isSuccessful) { Log.w(TAG, "restore HTTP ${it.code}"); finish(false); return }
                        val json = try { JSONObject(text) } catch (e: Exception) { finish(false); return }
                        val jwt = json.optString("token")
                        val rotated = json.optString("restoreToken")
                        if (jwt.isBlank()) { finish(false); return }

                        TokenStore.setAuthToken(app, jwt)
                        snapshot.workspaceId?.let { ws -> TokenStore.setCurrentWorkspaceId(app, ws) }
                        if (rotated.isNotBlank()) {
                            mainHandler.post { RestoreCredentialStore.save(app, rotated, snapshot.workspaceId) }
                        }
                        Log.i(TAG, "restore OK")
                        finish(true)
                    }
                }
            })
        }
    }

    /** Logout: zruš token na serveri (best-effort) a zmaž Block Store. */
    fun revokeAndClear(context: Context) {
        val app = context.applicationContext
        RestoreCredentialStore.load(app) { snapshot ->
            val token = snapshot?.restoreToken
            if (!token.isNullOrBlank()) {
                val request = Request.Builder()
                    .url(apiUrl(app, "/api/auth/restore-token"))
                    .delete(jsonBody("restoreToken" to token))
                    .build()
                client.newCall(request).enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        Log.w(TAG, "revoke failed: ${e.javaClass.simpleName}")
                    }
                    override fun onResponse(call: Call, response: Response) {
                        response.use { Log.i(TAG, "revoke HTTP ${it.code}") }
                    }
                })
            }
            RestoreCredentialStore.clear(app)
        }
    }
}
```

- [ ] **Step 2: Kompilácia**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:compileDebugKotlin 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android-native/app/src/main/java/eu/prplcrm/app/RestoreSession.kt
git commit -m "feat(android): RestoreSession — vydanie, obnova a revokácia obnovovacieho tokenu"
```

---

### Task 10: Hooky vo `WebAppInterface.kt`

**Files:**
- Modify: `android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt`

- [ ] **Step 1: `setAuthToken`** — vnútri `if (!token.isNullOrEmpty() && token != previous) { ... }` za FCM blok pridaj:

```kotlin
            // Google Play zero-tap sign-in: po každom novom logine vydaj obnovovací
            // token a ulož ho do Block Store (prežije reinštaláciu / nový telefón).
            RestoreSession.issueAfterLogin(context, token)
```

- [ ] **Step 2: `setCurrentWorkspaceId`** — nahraď telo:

```kotlin
    @JavascriptInterface
    fun setCurrentWorkspaceId(workspaceId: String?) {
        val previous = TokenStore.getCurrentWorkspaceId(context)
        TokenStore.setCurrentWorkspaceId(context, workspaceId)
        // Block Store drží aj workspace, aby obnova otvorila správne prostredie.
        if (!workspaceId.isNullOrEmpty() && workspaceId != previous) {
            RestoreCredentialStore.saveWorkspaceId(context, workspaceId)
        }
    }
```

- [ ] **Step 3: `clearAll`** — nahraď telo:

```kotlin
    /** Na logout zmažeme všetko — JS zavolá clearAll() pri removeStoredToken(). */
    @JavascriptInterface
    fun clearAll() {
        // Web volá clearAll() aj pri VYNÚTENOM odhlásení po expirácii 7-dňového
        // JWT (401 → prpl:force-logout). Vtedy Block Store token NECHÁVAME —
        // je to jediná cesta, ako sa pri ďalšom štarte prihlásiť bez hesla
        // (zero-tap). Skutočný logout (platný JWT) token zruší aj na serveri.
        val jwt = TokenStore.getAuthToken(context)
        if (!JwtUtils.isExpired(jwt)) {
            RestoreSession.revokeAndClear(context)
        } else {
            android.util.Log.i("WebAppInterface", "clearAll: expirovaná session → Block Store ponechaný")
        }
        TokenStore.clearAll(context)
    }
```

- [ ] **Step 4: Kompilácia** — rovnaký príkaz ako v Task 9, Expected `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt
git commit -m "feat(android): bridge — vydanie/revokácia obnovovacieho tokenu pri logine, logoute a zmene workspace"
```

---

### Task 11: Obnova pri cold starte v `MainActivity.kt`

**Files:**
- Modify: `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt` (`onCreate`)

- [ ] **Step 1: Splash handle** — nahraď `installSplashScreen()` na začiatku `onCreate` za:

```kotlin
        val splash = installSplashScreen()
```

- [ ] **Step 2: Štart webu** — nahraď blok

```kotlin
        val startUrl = resolveStartUrl(intent) ?: getString(R.string.webapp_url)
        webView.loadUrl(startUrl)

        maybeRequestNotificationPermission()
        ensureFcmTokenRegistered()
    }
```

za:

```kotlin
        val startUrl = resolveStartUrl(intent) ?: getString(R.string.webapp_url)

        // Google Play zero-tap sign-in: bez platného JWT (nový telefón,
        // reinštalácia, expirovaný 7-dňový token) skús obnovu z Block Store
        // EŠTE PRED načítaním webu — user nabootuje rovno prihlásený, bez
        // login obrazovky. Splash ostáva, kým sa nerozhodne (max 3 s).
        // Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
        if (JwtUtils.isExpired(TokenStore.getAuthToken(this))) {
            var restoring = true
            splash.setKeepOnScreenCondition { restoring }
            RestoreSession.tryRestore(
                this,
                onLateSuccess = { if (!isFinishing && !isDestroyed) webView.reload() }
            ) { _ ->
                restoring = false
                proceedToWeb(startUrl)
            }
        } else {
            proceedToWeb(startUrl)
        }
    }

    /** Načíta web appku a spustí veci, ktoré potrebujú (prípadne obnovený) auth token. */
    private fun proceedToWeb(startUrl: String) {
        webView.loadUrl(startUrl)
        maybeRequestNotificationPermission()
        ensureFcmTokenRegistered()
    }
```

- [ ] **Step 3: Kompilácia + unit testy + debug APK**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:testDebugUnitTest :app:assembleDebug 2>&1 | tail -5; echo "exit=$?"`
Expected: `BUILD SUCCESSFUL`, exit=0.

- [ ] **Step 4: Commit**

```bash
git add android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt
git commit -m "feat(android): obnova prihlásenia z Block Store pri cold starte (zero-tap sign-in)"
```

---

### Task 12: Release AAB + release notes + push

- [ ] **Step 1: Release build**

Run: `cd android-native && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew bundleRelease 2>&1 | tail -5; echo "exit=$?"`
Expected: `BUILD SUCCESSFUL`, exit=0, súbor `app/build/outputs/bundle/release/app-release.aab`.

- [ ] **Step 2: Overiť podpis a verziu**

Run: `cd android-native && keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab | grep SHA1` → `4C:8D:11:1B:7A:C5:CC:00:6F:DB:42:2B:A2:58:28:BB:92:D6:07:91`; `unzip -p app/build/outputs/bundle/release/app-release.aab base/manifest/AndroidManifest.xml | strings | grep -E "1\.0\.7"` (alebo `bundletool` ak je k dispozícii).

- [ ] **Step 3: Kopírovať na Desktop**

Run: `cp android-native/app/build/outputs/bundle/release/app-release.aab ~/Desktop/prplcrm-1.0.7-208.aab`

- [ ] **Step 4: Release notes (Play Console › Production)**

SK:
```
• Automatické prihlásenie po preinštalovaní alebo prenose na nový telefón (Google Play zero-tap sign-in)
• Po vypršaní prihlásenia sa appka prihlási sama, bez zadávania hesla
• Drobné opravy a vylepšenia stability
```
EN:
```
• Automatic sign-in after reinstalling or moving to a new phone (Google Play zero-tap sign-in)
• When your session expires, the app signs you back in without re-entering your password
• Minor fixes and stability improvements
```

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Overenie na zariadení (používateľ)** — podľa spec §8: login → odinštalovať → nainštalovať → automaticky prihlásený; logout → reinštalácia → login obrazovka.
