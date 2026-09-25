import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Automatické opakovanie requestov v axios interceptore.
 *
 * Invariant: multipart upload (FormData) sa po timeoute ani po výpadku siete
 * NEopakuje. Nevieme, či telo na server dorazilo — opakovanie vytváralo
 * duplicitné správy/prílohy a na slabom signáli každý pokus nahrával od nuly
 * (4 × 60 s, potom aj tak chyba). 503 (DB sa spúšťa, nič sa nezapísalo) sa
 * opakuje aj pre upload; bežné JSON requesty sa opakujú ako doteraz.
 */
vi.mock('../../utils/authStorage', () => ({
  getStoredToken: () => 'jwt-test',
  removeStoredToken: vi.fn(),
  isNativeIOSApp: () => false,
}));
vi.mock('../../utils/workspaceStorage', () => ({
  getStoredWorkspaceId: () => null,
  removeStoredWorkspaceId: vi.fn(),
}));

const ok = (config) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config });

const timeoutError = (config) => {
  const err = new Error('timeout of 60000ms exceeded');
  err.code = 'ECONNABORTED';
  err.config = config;
  return err;
};

const networkError = (config) => {
  const err = new Error('Network Error');
  err.code = 'ERR_NETWORK';
  err.config = config;
  return err;
};

const status503 = (config) => {
  const err = new Error('Request failed with status code 503');
  err.config = config;
  err.response = { status: 503, data: { message: 'Databáza sa pripája' }, headers: {}, config };
  return err;
};

// Adapter, ktorý prvý pokus zhodí zadanou chybou a ďalšie pustí. Pamätá si,
// či dostal FormData (overuje, že test naozaj testuje multipart cestu).
const failOnceAdapter = (makeError) => {
  const calls = [];
  const adapter = vi.fn(async (config) => {
    calls.push(config);
    if (calls.length === 1) throw makeError(config);
    return ok(config);
  });
  return { adapter, calls };
};

const formData = () => {
  const fd = new FormData();
  fd.append('file', new Blob(['abc'], { type: 'image/jpeg' }), 'foto.jpg');
  return fd;
};

describe('api interceptor — opakovanie uploadov', () => {
  let api;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ default: api } = await import('../api'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('FormData + timeout → žiadne opakovanie, chyba ide hneď volajúcemu', async () => {
    const { adapter, calls } = failOnceAdapter(timeoutError);
    api.defaults.adapter = adapter;

    const promise = api.post('/api/messages/abc/files', formData());
    const assertion = expect(promise).rejects.toMatchObject({ code: 'ECONNABORTED' });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(calls[0].data).toBeInstanceOf(FormData);
  });

  it('FormData + výpadok siete → žiadne opakovanie', async () => {
    const { adapter } = failOnceAdapter(networkError);
    api.defaults.adapter = adapter;

    const promise = api.post('/api/messages', formData());
    const assertion = expect(promise).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('FormData + 503 → zopakuje (server nič nezapísal)', async () => {
    const { adapter } = failOnceAdapter(status503);
    api.defaults.adapter = adapter;

    const promise = api.post('/api/messages/abc/files', formData());
    await vi.advanceTimersByTimeAsync(3000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('JSON request + timeout → opakuje ako doteraz (Render cold start)', async () => {
    const { adapter } = failOnceAdapter(timeoutError);
    api.defaults.adapter = adapter;

    const promise = api.get('/api/messages');
    await vi.advanceTimersByTimeAsync(3000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
