const { createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const { authenticateToken } = require('../../middleware/auth');

/**
 * authenticateToken — 401 smie znamenať LEN neplatnú session.
 *
 * Klient pri 401 maže token (a Android appka ruší aj Block Store obnovovací
 * token). Do 9/2026 jeden spoločný try/catch vracal 401 aj pri zlyhaní DB /
 * Redis → krátky výpadok Mongo odhlásil všetkých aktívnych používateľov.
 */
describe('middleware/authenticateToken — prechodné chyby nie sú 401', () => {
  let app;

  beforeAll(async () => {
    await User.init();
    app = express();
    app.get('/probe', authenticateToken, (req, res) => res.json({ ok: true, email: req.user.email }));
    app.get('/boom', authenticateToken, () => { throw new Error('handler bug'); });
    app.use((err, req, res, _next) => res.status(500).json({ message: err.message }));
  });
  beforeEach(async () => {
    await WorkspaceMember.deleteMany({}); await Workspace.deleteMany({}); await User.deleteMany({});
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { await mongoose.connection.close(); });

  it('platný token → 200', async () => {
    const { token } = await createUserWithWorkspace({ username: 'ok1', email: 'ok1@test.com' });
    const res = await request(app).get('/probe').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('ok1@test.com');
  });

  it('chýbajúci / neplatný / expirovaný JWT → 401', async () => {
    expect((await request(app).get('/probe')).status).toBe(401);
    expect((await request(app).get('/probe').set(authHeader('nie.je.jwt'))).status).toBe(401);
    const expired = jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -10 });
    expect((await request(app).get('/probe').set(authHeader(expired))).status).toBe(401);
  });

  it('platný podpis, ale používateľ neexistuje (zmazaný účet) → 401', async () => {
    const ghost = jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    expect((await request(app).get('/probe').set(authHeader(ghost))).status).toBe(401);
  });

  it('zlyhanie DB pri načítaní usera → 503 retryable, NIE 401', async () => {
    const { token } = await createUserWithWorkspace({ username: 'db1', email: 'db1@test.com' });
    jest.spyOn(User, 'findById').mockImplementation(() => ({
      select: () => ({ lean: () => Promise.reject(new Error('MongoServerSelectionError: connection timed out')) })
    }));
    const res = await request(app).get('/probe').set(authHeader(token));
    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
  });

  it('výnimka z ďalšieho handlera sa nemení na 401/503 z auth middleware', async () => {
    const { token } = await createUserWithWorkspace({ username: 'boom1', email: 'boom1@test.com' });
    const res = await request(app).get('/boom').set(authHeader(token));
    expect(res.status).toBe(500);
  });
});
