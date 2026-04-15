/**
 * Shared test helper pre route integračné testy.
 *
 * Účel:
 *   - Vytvoriť minimal Express app s konkrétnym routerom
 *   - Vytvoriť autentikovaných test usárov + workspace + JWT token
 *   - Setnúť JWT_SECRET PRED `require('../middleware/auth')` (auth.js volá
 *     process.exit(1) ak JWT_SECRET nie je nastavený / kratší ako 32 znakov)
 *
 * Pozor:
 *   - `require('../../middleware/auth')` v teste musí byť AŽ PO `process.env.JWT_SECRET`
 *     (preto si testy importujú tento helper prvý)
 *   - `createUserWithWorkspace` vytvára usera + workspace + WorkspaceMember
 *     vo všetkých rolách (owner | manager | member)
 */

// MUSÍ byť nastavené pred requireovaním middleware/auth.js
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters-long-xxx';
}

// Skip rate limiters v testoch (login/register/password). Viď middleware/rateLimiter.js:22
// POZOR: Jest sám setne NODE_ENV=test — musíme to prepísať na 'development' inak
// skip() v express-rate-limit neuznáva SKIP_RATE_LIMIT.
process.env.NODE_ENV = 'development';
process.env.SKIP_RATE_LIMIT = 'true';

const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * Vytvorí Express app s daným routerom namontovaným na given prefix.
 * Pripojí io mock na app.get('io') (routes emitujú na Socket.IO).
 */
const createTestApp = (mountPath, router, options = {}) => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Minimal Socket.IO mock — stačí `.to(room).emit(event, payload)` chain
  const io = options.io || {
    to: function () { return this; },
    emit: function () { return this; }
  };
  app.set('io', io);

  app.use(mountPath, router);

  // Error handler → JSON výstup miesto default HTML
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ message: err.message || 'Server error' });
  });

  return { app, io };
};

/**
 * Vytvorí User + Workspace + WorkspaceMember a vráti JWT token.
 * Užívateľ je okamžite "aktívny" v tomto workspace (currentWorkspaceId).
 */
const createUserWithWorkspace = async ({
  username = 'testuser',
  email = 'test@test.com',
  role = 'member', // owner | manager | member
  workspaceName = 'Test Workspace',
  workspaceSlug = null
} = {}) => {
  const user = await User.create({
    username,
    email,
    password: 'hashedpw-not-real-for-tests'
  });

  const workspace = await Workspace.create({
    name: workspaceName,
    slug: workspaceSlug || `${workspaceName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    ownerId: user._id
  });

  await WorkspaceMember.create({
    workspaceId: workspace._id,
    userId: user._id,
    role
  });

  // currentWorkspaceId musí existovať, inak requireWorkspace → 400 NO_WORKSPACE
  user.currentWorkspaceId = workspace._id;
  await user.save();

  const token = jwt.sign(
    { id: user._id.toString() },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  return { user, workspace, token };
};

/**
 * Vytvorí ďalšieho člena do existujúceho workspace.
 */
const addMember = async (workspaceId, { username, email, role = 'member' } = {}) => {
  const user = await User.create({
    username: username || `member-${Date.now()}`,
    email: email || `member-${Date.now()}@test.com`,
    password: 'hashedpw'
  });
  await WorkspaceMember.create({ workspaceId, userId: user._id, role });
  user.currentWorkspaceId = workspaceId;
  await user.save();

  const token = jwt.sign(
    { id: user._id.toString() },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  return { user, token };
};

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = {
  createTestApp,
  createUserWithWorkspace,
  addMember,
  authHeader
};
