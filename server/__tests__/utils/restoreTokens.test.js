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

/**
 * Obnovovacie tokeny pre Google Play zero-tap sign-in (Block Store).
 * Invarianty: v DB len SHA-256 hash, jednorazovosť, strop 5, expirácia.
 */
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
