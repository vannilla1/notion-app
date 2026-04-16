/**
 * In-memory registry pripojených (online) používateľov cez Socket.IO.
 *
 * Jeden user môže mať viac socketov naraz (tabs, multi-device), preto
 * používame Map<userId, Map<socketId, { since, workspaceId, userAgent }>>.
 *
 * Toto je len pre SuperAdmin dashboard — nie je to žiadny canonical state.
 * Pri reštarte servera sa vyprázdni (a to je OK — klienti sa aj tak
 * reconnectnú a znovu sa zaregistrujú).
 */

const registry = new Map(); // userId -> Map<socketId, connectionInfo>
const socketIndex = new Map(); // socketId -> userId (pre rýchle remove bez traverse)

function addConnection(userId, socketId, info = {}) {
  if (!userId || !socketId) return;
  const key = String(userId);
  let sockets = registry.get(key);
  if (!sockets) {
    sockets = new Map();
    registry.set(key, sockets);
  }
  sockets.set(socketId, {
    since: new Date(),
    workspaceId: info.workspaceId || null,
    username: info.username || null,
    email: info.email || null,
    userAgent: info.userAgent ? info.userAgent.slice(0, 200) : null
  });
  socketIndex.set(socketId, key);
}

function removeConnection(socketId) {
  if (!socketId) return;
  const userId = socketIndex.get(socketId);
  if (!userId) return;
  socketIndex.delete(socketId);
  const sockets = registry.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    registry.delete(userId);
  }
}

/**
 * Vráti zoznam online používateľov. Najnovšie pripojenie ako `since`
 * (keby mal user 3 sockety, vezmeme najstaršie since = kedy prvá tab prišla).
 */
function getOnlineUsers() {
  const result = [];
  for (const [userId, sockets] of registry.entries()) {
    let oldestSince = null;
    let latestInfo = null;
    for (const info of sockets.values()) {
      if (!oldestSince || info.since < oldestSince) oldestSince = info.since;
      latestInfo = info; // stačí posledný pre username/email
    }
    result.push({
      userId,
      username: latestInfo?.username || null,
      email: latestInfo?.email || null,
      since: oldestSince,
      socketCount: sockets.size,
      workspaceId: latestInfo?.workspaceId || null
    });
  }
  // Najnovší prv (posledný prihlásený je hore)
  result.sort((a, b) => (b.since?.getTime() || 0) - (a.since?.getTime() || 0));
  return result;
}

function getOnlineCount() {
  return registry.size;
}

function getSocketCount() {
  return socketIndex.size;
}

/**
 * Len pre testy — vyčistí registry.
 */
function _reset() {
  registry.clear();
  socketIndex.clear();
}

module.exports = {
  addConnection,
  removeConnection,
  getOnlineUsers,
  getOnlineCount,
  getSocketCount,
  _reset
};
