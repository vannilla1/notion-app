const ServerError = require('../../models/ServerError');
const {
  recordError,
  _normalizePath: normalizePath,
  _computeFingerprint: computeFingerprint
} = require('../../services/serverErrorService');

/**
 * serverErrorService — normalizácia ciest (fingerprint) a voliteľný
 * extraContext v recordError.
 *
 * Bug (audit 2026-09): normalizePath nepoznal UUID. Číselné pravidlo zjedlo
 * len úvodné číslice („/3f1c…" → „/:idf1c…"), UUID začínajúce písmenom
 * ostalo celé → každá úloha v kontakte (a každý fileId) mala v Diagnostike
 * vlastný riadok s count 1.
 */
describe('serverErrorService', () => {
  describe('normalizePath', () => {
    it('UUID začínajúce číslicou → /:id (nie „/:idf1c…")', () => {
      expect(normalizePath('/3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files')).toBe('/:id/files');
    });

    it('UUID začínajúce písmenom → /:id', () => {
      expect(normalizePath('/a91c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files')).toBe('/:id/files');
    });

    it('úloha + fileId (oba UUID) v download ceste', () => {
      expect(normalizePath('/3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files/A91C2A9E-8B7D-4C21-9E0F-1A2B3C4D5E6F/download'))
        .toBe('/:id/files/:id/download');
    });

    it('ObjectId, číselné ID a query ostávajú ako doteraz (žiadna vlna „nových" fingerprintov)', () => {
      expect(normalizePath('/6412af0123456789abcdef01/files')).toBe('/:id/files');
      expect(normalizePath('/users/42')).toBe('/users/:id');
      expect(normalizePath('/x/files?subtaskId=1')).toBe('/x/files');
    });

    it('rovnaká chyba na dvoch rôznych úlohách → jeden fingerprint', () => {
      const err = Object.assign(new Error('Unexpected end of form'), { name: 'TaskUploadRejected', stack: 'TaskUploadRejected: x\n    at a (/app/x.js:1:1)' });
      const fp1 = computeFingerprint(err, { method: 'POST', path: '/3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files' });
      const fp2 = computeFingerprint(err, { method: 'POST', path: '/b00c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files' });
      expect(fp1).toBe(fp2);
    });
  });

  describe('recordError', () => {
    beforeAll(async () => {
      await ServerError.init();
    });

    const fakeReq = (body) => ({
      method: 'POST',
      path: '/3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files',
      query: {},
      params: { taskId: '3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f' },
      body,
      get: () => 'UA',
      ip: '127.0.0.1'
    });

    it('bez tretieho parametra funguje ako doteraz (spätná kompatibilita)', async () => {
      await recordError(Object.assign(new Error('boom-legacy'), { name: 'LegacyCallErr' }), fakeReq({}));
      const row = await ServerError.findOne({ name: 'LegacyCallErr' }).lean();
      expect(row).toBeTruthy();
      expect(row.statusCode).toBe(500);
      expect(row.context.upload).toBeUndefined();
    });

    it('extraContext sa uloží do context; customName/originalName sa scrubnú', async () => {
      const err = Object.assign(new Error('UPLOAD_BODY_INCOMPLETE: Unexpected end of form'), { name: 'CtxErr', status: 400 });
      await recordError(err, fakeReq({ customName: 'Faktúra Novák.pdf', originalName: 'x', uploadId: 'u1' }), {
        upload: { multerCode: null, contentLength: 0, hasBoundary: true, shell: 'web' }
      });
      const row = await ServerError.findOne({ name: 'CtxErr' }).lean();
      expect(row.statusCode).toBe(400);
      expect(row.context.upload).toEqual({ multerCode: null, contentLength: 0, hasBoundary: true, shell: 'web' });
      expect(row.context.body.customName).toBe('[FILTERED]');
      expect(row.context.body.originalName).toBe('[FILTERED]');
      expect(row.context.body.uploadId).toBe('u1');
      expect(row.context.params.taskId).toBe('3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f');
    });

    it('opakovanie tej istej chyby na inej úlohe len zvýši count', async () => {
      const mk = () => Object.assign(new Error('same'), { name: 'DedupErr', stack: 'DedupErr: same\n    at f (/app/y.js:2:2)' });
      await recordError(mk(), fakeReq({}));
      await recordError(mk(), { ...fakeReq({}), path: '/c00c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f/files' });
      const rows = await ServerError.find({ name: 'DedupErr' }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(2);
    });
  });
});
