jest.mock('../../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../../services/serverErrorService', () => ({ recordError: jest.fn(() => Promise.resolve()) }));

const { EventEmitter } = require('events');
const auditService = require('../../services/auditService');
const { recordError } = require('../../services/serverErrorService');
const {
  trackUploadAbort,
  handleUploadError,
  rejectMissingFilePart
} = require('../../utils/uploadTracking');

/**
 * uploadTracking — počítanie bajtov prerušeného prenosu a spoločné
 * ošetrenie chýb multer/busboy pre prílohy.
 */
const makeReqRes = (headers = {}) => {
  const req = new EventEmitter();
  req.headers = { ...headers };
  req.get = (h) => req.headers[String(h).toLowerCase()];
  req.originalUrl = '/api/tasks/x/files';
  req.user = { id: 'u1' };
  const res = new EventEmitter();
  res.writableFinished = false;
  res.statusCode = 200;
  res.status = jest.fn((s) => { res.statusCode = s; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  req.res = res;
  return { req, res };
};

beforeEach(() => {
  auditService.logAction.mockClear();
  recordError.mockClear();
});

describe('trackUploadAbort', () => {
  it('počíta bajty TELA tohto requestu, nie kumulatívny socket.bytesRead (keep-alive)', () => {
    const { req, res } = makeReqRes({ 'content-length': '1000000' });
    // Spojenie už prenieslo 3 predošlé uploady — bytesRead je kumulatívny
    req.socket = { bytesRead: 3700000 };
    trackUploadAbort(req, { target: 'príloha úlohy' });
    req.emit('data', Buffer.alloc(60000));
    req.emit('data', Buffer.alloc(40000));
    res.emit('close');

    expect(auditService.logAction).toHaveBeenCalledTimes(1);
    const details = auditService.logAction.mock.calls[0][0].details;
    expect(details.receivedBytes).toBe(100000);
    expect(details.percent).toBe(10);
    expect(req.uploadBodyBytes()).toBe(100000);
  });

  it('percent je zhora ohraničené na 100', () => {
    const { req, res } = makeReqRes({ 'content-length': '100' });
    trackUploadAbort(req);
    req.emit('data', Buffer.alloc(150));
    res.emit('close');
    expect(auditService.logAction.mock.calls[0][0].details.percent).toBe(100);
  });

  it('dokončená odpoveď (writableFinished) sa do auditu nezapisuje', () => {
    const { req, res } = makeReqRes({ 'content-length': '10' });
    trackUploadAbort(req);
    res.writableFinished = true;
    res.emit('close');
    expect(auditService.logAction).not.toHaveBeenCalled();
  });
});

describe('handleUploadError', () => {
  it('LIMIT_FILE_SIZE → FILE_TOO_LARGE, bez Diagnostiky', () => {
    const { req, res } = makeReqRes({ 'content-length': '999' });
    handleUploadError(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' }), req, res, 'task');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'FILE_TOO_LARGE', message: 'Súbor je príliš veľký. Maximum je 50 MB.' });
    expect(recordError).not.toHaveBeenCalled();
  });

  it('BLOCKED_EXTENSION → pôvodná slovenská správa, bez Diagnostiky', () => {
    const { req, res } = makeReqRes({ 'content-length': '999' });
    const err = Object.assign(new Error('Tento typ súboru nie je povolený.'), { code: 'BLOCKED_EXTENSION' });
    handleUploadError(err, req, res, 'contact');
    expect(res.body).toEqual({ code: 'BLOCKED_EXTENSION', message: 'Tento typ súboru nie je povolený.' });
    expect(recordError).not.toHaveBeenCalled();
  });

  it.each([
    'Unexpected end of form',
    'Unexpected end of multipart data',
    'Malformed part header',
    'Multipart: Boundary not found'
  ])('busboy „%s" → UPLOAD_BODY_INCOMPLETE + Diagnostika', (msg) => {
    const { req, res } = makeReqRes({
      'content-length': '512',
      'content-type': 'multipart/form-data; boundary=----X',
      'user-agent': 'Mozilla/5.0 PrplCRM-Android/1.0.7'
    });
    handleUploadError(new Error(msg), req, res, 'task');
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
    expect(res.body.message).toBe('Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.');
    expect(recordError).toHaveBeenCalledTimes(1);
    const [recorded, recReq, ctx] = recordError.mock.calls[0];
    expect(recorded.name).toBe('TaskUploadRejected');
    expect(recorded.status).toBe(400);
    expect(recorded.message).toBe(`UPLOAD_BODY_INCOMPLETE: ${msg}`);
    expect(recReq).toBe(req);
    expect(ctx.upload).toEqual({
      multerCode: null,
      contentLength: 512,
      bodyBytes: null,
      contentType: 'multipart/form-data',
      hasBoundary: true,
      shell: 'PrplCRM-Android/1.0.7'
    });
  });

  it('Content-Length 0 → UPLOAD_BODY_INCOMPLETE aj pri inej správe', () => {
    const { req, res } = makeReqRes({ 'content-length': '0', 'content-type': 'multipart/form-data' });
    handleUploadError(new Error('something odd'), req, res, 'contact');
    expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
    const [recorded, , ctx] = recordError.mock.calls[0];
    expect(recorded.name).toBe('ContactUploadRejected');
    expect(ctx.upload.hasBoundary).toBe(false);
    expect(ctx.upload.shell).toBe('web');
  });

  it('iná MulterError (LIMIT_UNEXPECTED_FILE) → UPLOAD_REJECTED + Diagnostika s multerCode', () => {
    const { req, res } = makeReqRes({ 'content-length': '512' });
    const err = Object.assign(new Error('Unexpected field'), { name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' });
    handleUploadError(err, req, res, 'task');
    expect(res.body).toEqual({ code: 'UPLOAD_REJECTED', message: 'Súbor sa nepodarilo prijať.' });
    expect(recordError.mock.calls[0][2].upload.multerCode).toBe('LIMIT_UNEXPECTED_FILE');
  });

  it('zlyhanie zápisu do Diagnostiky neblokuje ani nezhodí odpoveď', () => {
    recordError.mockImplementationOnce(() => Promise.reject(new Error('mongo down')));
    const { req, res } = makeReqRes({ 'content-length': '0' });
    expect(() => handleUploadError(new Error('Unexpected end of form'), req, res, 'task')).not.toThrow();
    expect(res.statusCode).toBe(400);
  });
});

describe('rejectMissingFilePart', () => {
  it('→ 400 NO_FILE_PART „Žiadny súbor" + Diagnostika', () => {
    const { req, res } = makeReqRes({ 'content-length': '120', 'content-type': 'multipart/form-data; boundary=x' });
    rejectMissingFilePart(req, res, 'contact');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'NO_FILE_PART', message: 'Žiadny súbor' });
    const [recorded, , ctx] = recordError.mock.calls[0];
    expect(recorded.name).toBe('ContactUploadRejected');
    expect(recorded.message).toBe('NO_FILE_PART: No file part in multipart body');
    expect(ctx.upload.multerCode).toBe('NO_FILE_PART');
  });
});
