// Set OAuth env vars BEFORE any require() touches googleTasks.js — the module
// reads them at load time and caches. If left to beforeAll, jest's describe-
// body evaluation (e.g. the `_createGoogleTaskData` unit-test block below)
// can trigger the require first and snapshot undefined → createOAuth2Client
// returns null forever for the whole test suite.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_TASKS_REDIRECT_URI = process.env.GOOGLE_TASKS_REDIRECT_URI || 'http://localhost:3001/api/google-tasks/callback';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Task = require('../../models/Task');
const Contact = require('../../models/Contact');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/google-tasks route testy — OAuth Google Tasks sync.
 *
 * Paralelné testy k googleCalendar.test.js — rovnaký pattern, iný scope.
 *
 * Doplnkovo testujeme:
 *   - OAuth not configured → 503 na auth-url
 *   - invalid ObjectId v state → redirect na invalid_state (anti-injection)
 *   - /status: daily quota tracking (50000 queries/day), pending task count
 *   - /sync: 400 ak Google Tasks nie je pripojený
 *   - /sync: 429 ak quota prekročená
 */

const mockGenerateAuthUrl = jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/mock-tasks-url');
const mockRevokeToken = jest.fn().mockResolvedValue({});
const mockGetToken = jest.fn().mockResolvedValue({
  tokens: {
    access_token: 'tasks-access-token',
    refresh_token: 'tasks-refresh-token',
    expiry_date: Date.now() + 3600000
  }
});
const mockSetCredentials = jest.fn();
const mockTasklistsList = jest.fn().mockResolvedValue({
  data: { items: [{ id: 'existing-list', title: 'Prpl CRM' }] }
});
const mockTasklistsInsert = jest.fn().mockResolvedValue({
  data: { id: 'new-list-id', title: 'Prpl CRM' }
});
const mockTasklistsDelete = jest.fn().mockResolvedValue({});
const mockTasksList = jest.fn().mockResolvedValue({ data: { items: [] } });
const mockTasksDelete = jest.fn().mockResolvedValue({});

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: mockGenerateAuthUrl,
        setCredentials: mockSetCredentials,
        revokeToken: mockRevokeToken,
        getToken: mockGetToken,
        refreshAccessToken: jest.fn().mockResolvedValue({
          credentials: { access_token: 'refreshed', expiry_date: Date.now() + 3600000 }
        })
      }))
    },
    tasks: jest.fn().mockReturnValue({
      tasklists: {
        list: mockTasklistsList,
        insert: mockTasklistsInsert,
        delete: mockTasklistsDelete,
        get: jest.fn().mockResolvedValue({ data: { id: 'list-id' } })
      },
      tasks: {
        list: mockTasksList,
        insert: jest.fn().mockResolvedValue({ data: { id: 'new-task-id' } }),
        update: jest.fn().mockResolvedValue({ data: {} }),
        delete: mockTasksDelete,
        patch: jest.fn().mockResolvedValue({ data: {} })
      }
    }),
    calendar: jest.fn().mockReturnValue({
      events: { watch: jest.fn() },
      channels: { stop: jest.fn() }
    })
  }
}));

describe('/api/google-tasks route', () => {
  let app;
  let ctx;

  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_TASKS_REDIRECT_URI = 'http://localhost:3001/api/google-tasks/callback';
    process.env.CLIENT_URL = 'http://localhost:3000';

    const gtasksRouter = require('../../routes/googleTasks');
    ({ app } = createTestApp('/api/google-tasks', gtasksRouter));
  });

  beforeEach(async () => {
    await Task.deleteMany({});
    await Contact.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ctx = await createUserWithWorkspace({
      username: 'gtasksuser',
      email: 'gtasks@test.com',
      role: 'owner',
      workspaceName: 'GT WS'
    });

    mockGenerateAuthUrl.mockClear();
    mockGetToken.mockClear();
    mockRevokeToken.mockClear();
    mockTasklistsList.mockClear();
    mockTasklistsInsert.mockClear();
    mockTasklistsDelete.mockClear();
    mockTasksList.mockClear();
    mockTasksDelete.mockClear();
    // Restore default mock implementations (tests may override via mockResolvedValueOnce)
    mockTasklistsList.mockResolvedValue({ data: { items: [{ id: 'existing-list', title: 'Prpl CRM' }] } });
    mockTasksList.mockResolvedValue({ data: { items: [] } });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('GET /auth-url', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/google-tasks/auth-url');
      expect(res.status).toBe(401);
    });

    it('vráti authUrl', async () => {
      const res = await request(app)
        .get('/api/google-tasks/auth-url')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.authUrl).toContain('accounts.google.com');
      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.arrayContaining(['https://www.googleapis.com/auth/tasks']),
          state: ctx.user._id.toString()
        })
      );
    });
  });

  describe('GET /callback', () => {
    it('redirect na error ak chýba code', async () => {
      const res = await request(app)
        .get(`/api/google-tasks/callback?state=${ctx.user._id}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google_tasks=error');
      expect(res.headers.location).toContain('missing_params');
    });

    it('redirect na error pri invalid ObjectId v state (anti-injection)', async () => {
      const res = await request(app)
        .get('/api/google-tasks/callback?code=abc&state=not-a-valid-objectid');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('invalid_state');
    });

    it('redirect na error ak user neexistuje', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/google-tasks/callback?code=abc&state=${fake}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('user_not_found');
    });

    it('úspešný callback nájde existujúci Prpl CRM zoznam', async () => {
      const res = await request(app)
        .get(`/api/google-tasks/callback?code=valid&state=${ctx.user._id}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google_tasks=connected');

      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.enabled).toBe(true);
      expect(updated.googleTasks.taskListId).toBe('existing-list');
      // insert sa nevolal (list existuje)
      expect(mockTasklistsInsert).not.toHaveBeenCalled();
    });

    it('callback vytvorí nový zoznam ak Prpl CRM neexistuje', async () => {
      mockTasklistsList.mockResolvedValueOnce({ data: { items: [] } });

      const res = await request(app)
        .get(`/api/google-tasks/callback?code=valid&state=${ctx.user._id}`);

      expect(res.status).toBe(302);
      expect(mockTasklistsInsert).toHaveBeenCalledWith({
        resource: { title: 'Prpl CRM' }
      });

      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.taskListId).toBe('new-list-id');
    });

    it('rozpozná aj starý názov "Perun CRM" a použije ho', async () => {
      mockTasklistsList.mockResolvedValueOnce({
        data: { items: [{ id: 'legacy-list', title: 'Perun CRM' }] }
      });

      const res = await request(app)
        .get(`/api/google-tasks/callback?code=valid&state=${ctx.user._id}`);

      expect(res.status).toBe(302);
      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.taskListId).toBe('legacy-list');
    });
  });

  describe('GET /status', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/google-tasks/status');
      expect(res.status).toBe(401);
    });

    it('connected=false + quota info pre disconnected usera', async () => {
      const res = await request(app)
        .get('/api/google-tasks/status')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.quota).toBeDefined();
      expect(res.body.quota.limit).toBe(50000);
      expect(res.body.quota.used).toBe(0);
      expect(res.body.pendingTasks.total).toBe(0);
    });

    it('connected=true + spočíta pending tasks', async () => {
      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'x',
        refreshToken: 'y',
        taskListId: 'my-list',
        connectedAt: new Date(),
        syncedTaskIds: new Map()
      };
      await ctx.user.save();

      const due = new Date(Date.now() + 86400000);
      await Task.create([
        { workspaceId: ctx.workspace._id, userId: ctx.user._id, title: 'T1', dueDate: due, completed: false },
        { workspaceId: ctx.workspace._id, userId: ctx.user._id, title: 'T2', dueDate: due, completed: false },
        // No dueDate → nespočíta sa
        { workspaceId: ctx.workspace._id, userId: ctx.user._id, title: 'T3', completed: false }
      ]);

      const res = await request(app)
        .get('/api/google-tasks/status')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.pendingTasks.total).toBe(2);
      expect(res.body.pendingTasks.synced).toBe(0);
      expect(res.body.pendingTasks.pending).toBe(2);
    });

    it('quota countdown zobrazuje correct percentage', async () => {
      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'x',
        refreshToken: 'y',
        quotaUsedToday: 25000,
        quotaResetDate: new Date()
      };
      await ctx.user.save();

      const res = await request(app)
        .get('/api/google-tasks/status')
        .set(authHeader(ctx.token));

      expect(res.body.quota.used).toBe(25000);
      expect(res.body.quota.remaining).toBe(25000);
      expect(res.body.quota.percentUsed).toBe(50);
    });
  });

  describe('POST /disconnect', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).post('/api/google-tasks/disconnect');
      expect(res.status).toBe(401);
    });

    it('vyčistí googleTasks credentials + revoke token', async () => {
      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'active-token',
        refreshToken: 'refresh',
        taskListId: 'list-123',
        connectedAt: new Date()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Post-PR2 cleanup flow calls getTasksClient() first, which may refresh
      // the token before we hand it off to revokeToken. Just assert revoke
      // was invoked — the specific token value is an implementation detail.
      expect(mockRevokeToken).toHaveBeenCalled();

      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.enabled).toBe(false);
      expect(updated.googleTasks.accessToken).toBeNull();
      expect(updated.googleTasks.taskListId).toBeNull();
    });

    it('toleruje revoke error (token už neplatný)', async () => {
      mockRevokeToken.mockRejectedValueOnce(new Error('invalid_token'));

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'stale',
        refreshToken: 'refresh'
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);

      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.enabled).toBe(false);
    });

    // --- PR2 cleanup tests — verify exhaustive list/task cleanup on disconnect ---

    it('zmaže všetky Prpl CRM zoznamy (legacy + per-workspace)', async () => {
      // Scenario: user had legacy single list + per-workspace list from PR2.
      // Both should be deleted via tasklists.delete on disconnect.
      mockTasklistsList.mockResolvedValueOnce({
        data: {
          items: [
            { id: 'legacy-list-id', title: 'Prpl CRM' },
            { id: 'ws-list-id', title: 'Prpl CRM — GT WS' },
            { id: 'user-list-id', title: 'My Tasks' } // should NOT be deleted
          ]
        }
      });

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'active',
        refreshToken: 'refresh',
        taskListId: 'legacy-list-id',
        workspaceTaskLists: new Map([
          [ctx.workspace._id.toString(), { taskListId: 'ws-list-id', createdAt: new Date() }]
        ]),
        syncedTaskIds: new Map(),
        syncedTaskLists: new Map()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      // Prpl CRM-named lists should both be deleted; user's personal list untouched.
      const deletedIds = mockTasklistsDelete.mock.calls.map(c => c[0].tasklist);
      expect(deletedIds).toEqual(expect.arrayContaining(['legacy-list-id', 'ws-list-id']));
      expect(deletedIds).not.toContain('user-list-id');
    });

    it('zmaže naše osirotené úlohy aj z user-owned zoznamov (scan podľa syncedTaskIds)', async () => {
      // Scenario: a stale task from an earlier sync somehow ended up in the
      // user's default "My Tasks" list (wrong-workspace bug before PR2).
      // Disconnect should hunt it down and delete it WITHOUT touching the
      // user's own tasks in the same list.
      mockTasklistsList.mockResolvedValueOnce({
        data: {
          items: [
            { id: 'user-list-id', title: 'My Tasks' }
          ]
        }
      });
      mockTasksList.mockResolvedValueOnce({
        data: {
          items: [
            { id: 'our-stray-google-id', title: 'CRM task gone rogue' },
            { id: 'user-own-task-id', title: 'User private task' }
          ]
        }
      });

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'active',
        refreshToken: 'refresh',
        taskListId: null,
        syncedTaskIds: new Map([['crm-task-id', 'our-stray-google-id']]),
        syncedTaskLists: new Map()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      // Exactly our orphan task should be deleted; user's own task untouched.
      const deletedTasks = mockTasksDelete.mock.calls.map(c => c[0]);
      expect(deletedTasks).toEqual([{ tasklist: 'user-list-id', task: 'our-stray-google-id' }]);
      // User's personal list never gets deleted wholesale.
      const deletedLists = mockTasklistsDelete.mock.calls.map(c => c[0].tasklist);
      expect(deletedLists).not.toContain('user-list-id');
    });

    it('správa hovorí o počte zmazaných zoznamov + úloh', async () => {
      mockTasklistsList.mockResolvedValueOnce({
        data: { items: [{ id: 'prpl-list', title: 'Prpl CRM — GT WS' }] }
      });

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'active',
        refreshToken: 'refresh',
        syncedTaskIds: new Map()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/odstránených.*1 task listov/);
    });

    // REGRESSION: pre-fix getTasksClient silently cleared accessToken on
    // invalid_grant refresh failure, so the outer cleanup try/catch had no
    // token left to work with and skipped cleanup + revoke entirely. Users'
    // Google Tasks lists then survived disconnect and kept stacking on
    // reconnect. This test locks in the fix: a disposable client is built
    // from a snapshot of the tokens BEFORE the refresh side-effect path, so
    // cleanup always fires even when the refresh round-trip fails.
    it('regression: cleanup beží aj keď token refresh padne s invalid_grant', async () => {
      const mockRefreshAccessToken = require('googleapis').google.auth.OAuth2.mock.results[0].value.refreshAccessToken;
      mockRefreshAccessToken.mockRejectedValueOnce(Object.assign(new Error('invalid_grant'), { code: 400 }));
      mockTasklistsList.mockResolvedValueOnce({
        data: { items: [{ id: 'ghost-list', title: 'Prpl CRM — GT WS' }] }
      });

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'expired-but-still-delete-ok',
        refreshToken: 'revoked',
        tokenExpiry: new Date(Date.now() - 3600000), // already expired
        syncedTaskIds: new Map()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      // Refresh failed — but the stale token was still handed to tasklists.delete,
      // and the cleanup logic proceeded. Ghost list got nuked.
      const deletedIds = mockTasklistsDelete.mock.calls.map(c => c[0].tasklist);
      expect(deletedIds).toContain('ghost-list');
    });

    it('stále dokončí disconnect aj keď cleanup zlyhá', async () => {
      // If Google API is down during cleanup, user must still end up in a
      // disconnected state — otherwise they're stuck reconnecting forever.
      mockTasklistsList.mockRejectedValueOnce(new Error('Google is down'));

      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'active',
        refreshToken: 'refresh',
        syncedTaskIds: new Map()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/disconnect')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      const updated = await User.findById(ctx.user._id);
      expect(updated.googleTasks.enabled).toBe(false);
      expect(updated.googleTasks.accessToken).toBeNull();
    });
  });

  describe('createGoogleTaskData (workspace prefix)', () => {
    // Unit test the exported title-prefix behavior directly. Google Calendar
    // aggregates every Prpl CRM task list into one "Úlohy" sidebar view, so
    // without a [Workspace] prefix in the title users with 2+ workspaces
    // can't tell which task belongs where. These tests lock the contract.
    const { _createGoogleTaskData } = require('../../routes/googleTasks');

    it('pridá [Workspace] prefix do titulu', () => {
      const result = _createGoogleTaskData({ title: 'Zavolať klienta' }, 'Perun Electromobility');
      expect(result.title).toBe('[Perun Electromobility] Zavolať klienta');
    });

    it('nepridá prefix druhýkrát (re-sync idempotencia)', () => {
      const result = _createGoogleTaskData(
        { title: '[Perun Electromobility] Zavolať klienta' },
        'Perun Electromobility'
      );
      expect(result.title).toBe('[Perun Electromobility] Zavolať klienta');
    });

    it('bez workspaceName nechá title nedotknutý', () => {
      const result = _createGoogleTaskData({ title: 'Bez prefixu' });
      expect(result.title).toBe('Bez prefixu');
    });

    it('orezáva dlhý workspaceName na 40 znakov v prefixe', () => {
      const veryLong = 'Veľmi dlhý názov workspacu ktorý má ďaleko viac ako 40 znakov'; // > 40
      const result = _createGoogleTaskData({ title: 'Tá úloha' }, veryLong);
      const prefix = result.title.match(/^\[([^\]]+)\]/)[1];
      expect(prefix.length).toBeLessThanOrEqual(40);
    });
  });

  describe('POST /sync', () => {
    it('400 ak Google Tasks nie je enabled', async () => {
      const res = await request(app)
        .post('/api/google-tasks/sync')
        .set(authHeader(ctx.token))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/nie je pripojený/i);
    });

    it('429 ak quota prekročená', async () => {
      ctx.user.googleTasks = {
        enabled: true,
        accessToken: 'x',
        refreshToken: 'y',
        taskListId: 'list',
        quotaUsedToday: 49995,
        quotaResetDate: new Date()
      };
      await ctx.user.save();

      const res = await request(app)
        .post('/api/google-tasks/sync')
        .set(authHeader(ctx.token))
        .send({});

      expect(res.status).toBe(429);
      expect(res.body.quotaExceeded).toBe(true);
    });
  });
});
