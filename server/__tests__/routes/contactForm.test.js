const { createTestApp } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');

/**
 * /api/contact-form testy — verejný endpoint pre kontaktný formulár.
 *
 * Mockujeme nodemailer transporter.sendMail() aby sme netočili SMTP spojenie
 * na realný server (smtp.hostcreators.sk) počas testov.
 *
 * Bezpečnosť:
 *   - HTML escape <>/&lt; &gt; aby sa zabránilo HTML injection v emaily
 *   - Max 5000 znakov (anti-spam + rozumný email limit)
 *   - Email regex validácia
 *   - Rate limiter skipnutý cez SKIP_RATE_LIMIT (helper/testApp.js)
 */
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' })
  }))
}));

// Contact-form má vlastný rate limiter (5 req / 15 min), bez env skip() —
// pri testoch (7+ requestov z rovnakej IP) by sa trafil na 429.
// Mockujeme express-rate-limit na pass-through middleware.
jest.mock('express-rate-limit', () => {
  return jest.fn(() => (req, res, next) => next());
});

describe('/api/contact-form route', () => {
  let app;
  let nodemailer;
  let mockTransport;

  beforeAll(() => {
    nodemailer = require('nodemailer');
    // Fresh mock reference
    mockTransport = nodemailer.createTransport();
    // Re-mock so createTestApp require cesty dostane náš mock
    const contactFormRouter = require('../../routes/contact-form');
    ({ app } = createTestApp('/api/contact-form', contactFormRouter));
  });

  beforeEach(() => {
    mockTransport.sendMail.mockClear();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('POST /', () => {
    it('odošle email s validnými dátami', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({
          name: 'Ján Novák',
          email: 'jan@example.com',
          message: 'Mám otázku ohľadom plánu Pro.'
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/úspešne/i);
    });

    it('400 ak chýba name', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({ email: 'j@test.com', message: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/povinné/);
    });

    it('400 ak chýba email', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({ name: 'Jan', message: 'hi' });
      expect(res.status).toBe(400);
    });

    it('400 ak chýba message', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({ name: 'Jan', email: 'j@test.com' });
      expect(res.status).toBe(400);
    });

    it('400 pri invalid email formáte', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({
          name: 'Jan',
          email: 'not-an-email',
          message: 'hi'
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email/i);
    });

    it('400 ak message > 5000 znakov (anti-spam)', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({
          name: 'Jan',
          email: 'j@test.com',
          message: 'A'.repeat(5001)
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/dlhá/);
    });

    it('akceptuje message presne 5000 znakov (edge case)', async () => {
      const res = await request(app)
        .post('/api/contact-form')
        .send({
          name: 'Jan',
          email: 'j@test.com',
          message: 'A'.repeat(5000)
        });
      expect(res.status).toBe(200);
    });
  });
});
