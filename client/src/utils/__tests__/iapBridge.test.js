import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * iapBridge — StoreKit transakcia sa ukončí (iapFinish) až po overení na
 * backende alebo pri definitívnom zamietnutí; pri 401/5xx/sieti ostane
 * neukončená a native ju pošle na overenie znova.
 */
vi.mock('../platform', () => ({ isIosNativeApp: () => true }));
const post = vi.fn();
vi.mock('@/api/api', () => ({ default: { post: (...a) => post(...a) } }));

const nativeMessages = [];
window.webkit = { messageHandlers: { iosNative: { postMessage: (m) => nativeMessages.push(m) } } };

const { purchaseIap, initIapBridge } = await import('../iapBridge');

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const finishes = () => nativeMessages.filter((m) => m.type === 'iapFinish').map((m) => m.transactionId);
const flush = () => new Promise((r) => setTimeout(r, 0));

// Simuluje native odpoveď na posledný iapPurchase request
const answerPurchase = (result) => {
  const req = [...nativeMessages].reverse().find((m) => m.type === 'iapPurchase');
  window.__iapResult(req.requestId, result);
};

describe('iapBridge', () => {
  beforeEach(() => {
    nativeMessages.length = 0;
    post.mockReset();
  });

  it('initIapBridge oznámi native pripravenosť', () => {
    initIapBridge();
    expect(nativeMessages.some((m) => m.type === 'iapReady')).toBe(true);
  });

  it('nákup: úspešný /verify → iapFinish', async () => {
    post.mockResolvedValue({ data: { subscription: { plan: 'team' } } });
    const p = purchaseIap('prplcrm.team.monthly');
    answerPurchase({ success: true, jws: 'jws1', transactionId: '2000000000000001' });
    await expect(p).resolves.toMatchObject({ success: true });
    expect(finishes()).toEqual(['2000000000000001']);
  });

  it('nákup: /verify 503 → bez iapFinish (zopakuje sa neskôr)', async () => {
    post.mockRejectedValue(httpError(503));
    const p = purchaseIap('prplcrm.team.monthly');
    answerPurchase({ success: true, jws: 'jws2', transactionId: '2' });
    await expect(p).rejects.toThrow();
    expect(finishes()).toEqual([]);
  });

  it('nákup: /verify 409 (iný účet) → iapFinish aj tak', async () => {
    post.mockRejectedValue(httpError(409));
    const p = purchaseIap('prplcrm.team.monthly');
    answerPurchase({ success: true, jws: 'jws3', transactionId: '3' });
    await expect(p).rejects.toThrow();
    expect(finishes()).toEqual(['3']);
  });

  it('external: 401 → bez iapFinish, úspech → iapFinish', async () => {
    post.mockRejectedValueOnce(httpError(401));
    window.__iapResult('external', { success: true, jws: 'x', transactionId: '4' });
    await flush();
    expect(finishes()).toEqual([]);
    post.mockResolvedValueOnce({ data: {} });
    window.__iapResult('external', { success: true, jws: 'x', transactionId: '4' });
    await flush();
    expect(finishes()).toEqual(['4']);
  });
});
