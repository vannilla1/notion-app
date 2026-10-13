const { joinWorkspaceRoom, leaveWorkspaceRoom, closeWorkspaceRoom } = require('../../utils/socketRooms');

/**
 * Zdieľané spojenie klienta sa do miestností workspace pripája len pri
 * connecte — zmena členstva počas relácie ich musí upraviť na serveri.
 */
const fakeIo = () => {
  const calls = [];
  const sockets = [{ data: { userWorkspaceIds: new Set(['old']) } }];
  const io = {
    in: (room) => ({
      socketsJoin: (r) => calls.push(['join', room, r]),
      socketsLeave: (r) => calls.push(['leave', room, r]),
      fetchSockets: async () => sockets,
    }),
  };
  return { io, calls, sockets, req: { app: { get: (k) => (k === 'io' ? io : undefined) } } };
};
const flush = () => new Promise((r) => setImmediate(r));

describe('socketRooms', () => {
  it('pripojenie a odchod menia miestnosti používateľových spojení aj zoznam workspace', async () => {
    const { req, calls, sockets } = fakeIo();
    joinWorkspaceRoom(req, 'u1', 'ws-new');
    await flush();
    expect(calls).toContainEqual(['join', 'user-u1', 'workspace-ws-new']);
    expect(sockets[0].data.userWorkspaceIds.has('ws-new')).toBe(true);

    leaveWorkspaceRoom(req, 'u1', 'old');
    await flush();
    expect(calls).toContainEqual(['leave', 'user-u1', 'workspace-old']);
    expect(sockets[0].data.userWorkspaceIds.has('old')).toBe(false);
  });

  it('zmazaný workspace — všetci opustia jeho miestnosť', async () => {
    const { req, calls, sockets } = fakeIo();
    sockets[0].data.userWorkspaceIds.add('ws-del');
    closeWorkspaceRoom(req, 'ws-del');
    await flush();
    expect(calls).toContainEqual(['leave', 'workspace-ws-del', 'workspace-ws-del']);
    expect(sockets[0].data.userWorkspaceIds.has('ws-del')).toBe(false);
  });

  it('bez io (testy, skripty) nič nespadne', () => {
    expect(() => joinWorkspaceRoom({ app: { get: () => undefined } }, 'u1', 'w')).not.toThrow();
    expect(() => leaveWorkspaceRoom(undefined, 'u1', 'w')).not.toThrow();
  });
});
