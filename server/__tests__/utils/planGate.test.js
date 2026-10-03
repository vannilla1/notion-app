const User = require('../../models/User');
const { getWorkspacePlan } = require('../../utils/planGate');

/**
 * Limity obsahu workspace = vyšší z plánov vlastníka a volajúceho člena.
 * Pred auditom platil len plán člena (Free člen v Tím workspace narážal na
 * Free limity), audit prepol na plán vlastníka (platiaci člen vo Free
 * workspace by stratil prílohy a limity) — vyšší z oboch nikomu nič nezoberie.
 */
describe('planGate.getWorkspacePlan', () => {
  beforeAll(async () => { await User.init(); });

  const mk = (username, plan) => User.create({
    username, email: `${username}@test.com`, password: 'hashedpw', subscription: { plan }
  });
  const req = (owner, caller) => ({ workspace: owner ? { ownerId: owner._id } : undefined, user: { id: String(caller._id) } });

  it('Free člen v Tím workspace dostane limity tímu', async () => {
    const owner = await mk('owner', 'team');
    const member = await mk('member', 'free');
    expect(await getWorkspacePlan(req(owner, member))).toBe('team');
  });

  it('Pro člen vo Free workspace si nechá svoj Pro plán', async () => {
    const owner = await mk('owner', 'free');
    const member = await mk('member', 'pro');
    expect(await getWorkspacePlan(req(owner, member))).toBe('pro');
  });

  it('obaja Free → free; zmazaný vlastník → plán člena', async () => {
    const owner = await mk('owner', 'free');
    const member = await mk('member', 'free');
    expect(await getWorkspacePlan(req(owner, member))).toBe('free');
    const ghost = { _id: new (require('mongoose').Types.ObjectId)() };
    const teamMember = await mk('teammember', 'team');
    expect(await getWorkspacePlan(req(ghost, teamMember))).toBe('team');
  });

  it('bez workspace kontextu rozhoduje plán používateľa', async () => {
    const solo = await mk('solo', 'pro');
    expect(await getWorkspacePlan(req(null, solo))).toBe('pro');
  });
});
