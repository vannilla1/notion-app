process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-plan-expiration-0123456789';
const User = require('../../models/User');
const { isExpired, expireUserIfNeeded } = require('../../services/planExpiration');

/**
 * Apple IAP predplatné expiruje cez App Store notifikácie; ak notifikácia
 * nedorazí, poistka ho zruší až 60 dní po paidUntil (koniec Apple billing
 * retry). Bežné (admin/promo) plány expirujú hneď po paidUntil.
 */
describe('planExpiration — Apple poistka', () => {
  beforeAll(async () => { await User.init(); });

  const DAY = 24 * 60 * 60 * 1000;
  const mk = (username, subscription) => User.create({
    username, email: `${username}@test.com`, password: 'hashedpw', subscription
  });

  it('Apple predplatné tesne po paidUntil (billing retry) neexpiruje', async () => {
    const u = await mk('apple1', { plan: 'pro', source: 'apple', appleOriginalTransactionId: '2000000001', paidUntil: new Date(Date.now() - 10 * DAY) });
    expect(isExpired(u)).toBe(false);
    expect(await expireUserIfNeeded(u._id)).toBeNull();
    expect((await User.findById(u._id)).subscription.plan).toBe('pro');
  });

  it('Apple predplatné 60+ dní po paidUntil expiruje (chýbajúca notifikácia)', async () => {
    const u = await mk('apple2', { plan: 'team', source: 'apple', appleOriginalTransactionId: '2000000002', paidUntil: new Date(Date.now() - 61 * DAY) });
    expect(isExpired(u)).toBe(true);
    expect(await expireUserIfNeeded(u._id)).not.toBeNull();
    expect((await User.findById(u._id)).subscription.plan).toBe('free');
  });

  it('plán bez Stripe/Apple expiruje hneď po paidUntil, Stripe nikdy', async () => {
    const promo = await mk('promo', { plan: 'pro', paidUntil: new Date(Date.now() - DAY) });
    const stripe = await mk('stripe', { plan: 'pro', stripeSubscriptionId: 'sub_x', paidUntil: new Date(Date.now() - 90 * DAY) });
    expect(isExpired(promo)).toBe(true);
    expect(isExpired(stripe)).toBe(false);
    expect(await expireUserIfNeeded(stripe._id)).toBeNull();
  });
});
