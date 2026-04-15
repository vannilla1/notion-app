const { createTestApp, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');

/**
 * /api/google-calendar route testy — OAuth-integrated Google Calendar sync.
 *
 * googleapis je plne mockované — žiadne reálne API volania neurobíme.
 * Testujeme:
 *   - auth-url generuje správny OAuth URL s user.id v state
 *   - callback bez code/state → redirect na error page
 *   - status vracia connected boolean z user.googleCalendar.enabled
 *   - disconnect vyčistí googleCalendar subdocument
 *   - auth gates na všetkých autentikovaných endpointoch
 */

// Globálne mocky OAuth2 klienta a google.calendar/tasks APIs
const mockGenerateAuthUrl = jest.fn().mockReturnValue('https://accounts.google.com/oauth/authorize?mock=true');
const mockRevokeToken = jest.fn().mockResolvedValue({});
const mockGetToken = jest.fn().mockResolvedValue({
  tokens: {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expiry_date: Date.now() + 3600000
  }
});
const mockSetCredentials = jest.fn();
const mockRefreshAccessToken = jest.fn().mockResolvedValue({
  credentials: { access_token: 'new-token', expiry_date: Date.now() + 3600000 }
});

const mockEventsWatch = jest.fn().mockResolvedValue({
  data: { resourceId: 'resource-id', expiration: String(Date.now() + 86400000) }
});
const mockChannelsStop = jest.fn().mockResolvedValue({});

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: mockGenerateAuthUrl,
        setCredentials: mockSetCredentials,
        revokeToken: mockRevokeToken,
        getToken: mockGetToken,
        refreshAccessToken: mockRefreshAccessToken
      }))
    },
    calendar: jest.fn().mockReturnValue({
      events: { watch: mockEventsWatch },
      channels: { stop: mockChannelsStop }
    }),
    tasks: jest.fn().mockReturnValue({
      tasklists: {
        list: jest.fn().mockResolvedValue({ data: { items: [] } }),
        insert: jest.fn().mockResolvedValue({ data: { id: 'list-id', title: 'Prpl CRM' } })
      }
    })
  }
}));

describe('/api/google-calendar route', () => {
  let app;
  let user;
  let token;

  beforeAll(() => {
    // Musíme nastaviť OAuth config PRED requireom routera — inak oauth2Client
    // ostane bez konfigurácie
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/api/google-calendar/callback';
    process.env.CLIENT_URL = 'http://localhost:3000';

    const gcalRouter = require('../../routes/googleCalendar');
    ({ app } = createTestApp('/api/google-calendar', gcalRouter));
  });

  beforeEach(async () => {
    await User.deleteMany({});
    user = await User.create({
      username: 'gcaluser',
      email: 'gcal@test.com',
      password: 'hashed'
    });
    token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // Reset mocks between tests
    mockGenerateAuthUrl.mockClear();
    mockGetToken.mockClear();
    mockRevokeToken.mockClear();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('GET /auth-url', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/google-calendar/auth-url');
      expect(res.status).toBe(401);
    });

    it('vráti authUrl pre autentikovaného usera', async () => {
      const res = await request(app)
        .get('/api/google-calendar/auth-url')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.authUrl).toContain('accounts.google.com');
      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          access_type: 'offline',
          prompt: 'consent',
          state: user._id.toString(),
          scope: expect.arrayContaining(['https://www.googleapis.com/auth/calendar.events'])
        })
      );
    });
  });

  describe('GET /callback', () => {
    it('redirect na error ak chýba code', async () => {
      const res = await request(app)
        .get(`/api/google-calendar/callback?state=${user._id}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google_calendar=error');
      expect(res.headers.location).toContain('missing_params');
    });

    it('redirect na error ak chýba state', async () => {
      const res = await request(app)
        .get('/api/google-calendar/callback?code=abc');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('missing_params');
    });

    it('redirect na error ak user neexistuje', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/google-calendar/callback?code=abc&state=${fake}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('user_not_found');
    });

    it('úspešný callback uloží tokens + redirect na connected', async () => {
      const res = await request(app)
        .get(`/api/google-calendar/callback?code=valid-code&state=${user._id}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google_calendar=connected');

      const updated = await User.findById(user._id);
      expect(updated.googleCalendar.enabled).toBe(true);
      expect(updated.googleCalendar.accessToken).toBe('mock-access-token');
      expect(updated.googleCalendar.refreshToken).toBe('mock-refresh-token');
      expect(updated.googleCalendar.calendarId).toBe('primary');
    });

    it('zachytí exception z getToken a redirect na error', async () => {
      mockGetToken.mockRejectedValueOnce(new Error('Token exchange failed'));

      const res = await request(app)
        .get(`/api/google-calendar/callback?code=bad-code&state=${user._id}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error');
      expect(res.headers.location).toContain('Token%20exchange%20failed');
    });
  });

  describe('GET /status', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/google-calendar/status');
      expect(res.status).toBe(401);
    });

    it('connected=false pre usera bez integrácie', async () => {
      const res = await request(app)
        .get('/api/google-calendar/status')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.connectedAt).toBeNull();
    });

    it('connected=true pre integrovaného usera', async () => {
      user.googleCalendar = {
        enabled: true,
        connectedAt: new Date(),
        accessToken: 'x',
        refreshToken: 'y'
      };
      await user.save();

      const res = await request(app)
        .get('/api/google-calendar/status')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.connectedAt).toBeDefined();
    });
  });

  describe('POST /disconnect', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).post('/api/google-calendar/disconnect');
      expect(res.status).toBe(401);
    });

    it('vyčistí googleCalendar credentials + revoke token', async () => {
      user.googleCalendar = {
        enabled: true,
        accessToken: 'active-token',
        refreshToken: 'refresh',
        connectedAt: new Date()
      };
      await user.save();

      const res = await request(app)
        .post('/api/google-calendar/disconnect')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRevokeToken).toHaveBeenCalledWith('active-token');

      const updated = await User.findById(user._id);
      expect(updated.googleCalendar.enabled).toBe(false);
      expect(updated.googleCalendar.accessToken).toBeNull();
      expect(updated.googleCalendar.refreshToken).toBeNull();
    });

    it('toleruje chybu pri revoke (token už zrušený)', async () => {
      mockRevokeToken.mockRejectedValueOnce(new Error('already revoked'));

      user.googleCalendar = {
        enabled: true,
        accessToken: 'stale-token',
        refreshToken: 'refresh'
      };
      await user.save();

      const res = await request(app)
        .post('/api/google-calendar/disconnect')
        .set(authHeader(token));
      // Aj pri revoke fail sa disconnect musí dokončiť
      expect(res.status).toBe(200);
    });
  });
});
