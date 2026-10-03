/**
 * socketRooms.js — zmena členstva vo workspace počas relácie → miestnosti
 * Socket.IO.
 *
 * Klient má jedno zdieľané Socket.IO spojenie pre celú appku (useSocket) a
 * server ho do miestností `workspace-<id>` pripája len pri connecte
 * (index.js). Keď si používateľ vytvorí workspace, pripojí sa kódom alebo
 * prijme pozvánku bez reloadu stránky, jeho spojenie by v novej miestnosti
 * nebolo — žiadne živé zmeny úloh, kontaktov ani správ až do reconnectu.
 * Opačne po odchode / odstránení by mu ďalej chodili udalosti workspace.
 *
 * Best-effort: chyba tu nikdy nezhodí request (REST overuje členstvo vždy).
 */
const logger = require('./logger');

const updateRoom = (req, userId, workspaceId, join) => {
  try {
    const io = req?.app?.get?.('io');
    if (!io || !userId || !workspaceId) return;
    const wsId = String(workspaceId);
    const target = io.in(`user-${userId}`);
    if (join) target.socketsJoin(`workspace-${wsId}`);
    else target.socketsLeave(`workspace-${wsId}`);
    // In-memory zoznam workspace na sokete (kontrola prístupu k stránkam
    // v index.js canAccessPage) — aby sedel s miestnosťami.
    Promise.resolve(target.fetchSockets())
      .then((sockets) => {
        for (const s of sockets) {
          const set = s.data?.userWorkspaceIds;
          if (set && typeof set.add === 'function') {
            if (join) set.add(wsId); else set.delete(wsId);
          }
        }
      })
      .catch(() => {});
  } catch (err) {
    logger.warn('[socketRooms] Room update failed', { error: err.message, workspaceId: String(workspaceId) });
  }
};

const joinWorkspaceRoom = (req, userId, workspaceId) => updateRoom(req, userId, workspaceId, true);
const leaveWorkspaceRoom = (req, userId, workspaceId) => updateRoom(req, userId, workspaceId, false);

// Zmazaný workspace — všetky spojenia opustia jeho miestnosť.
const closeWorkspaceRoom = (req, workspaceId) => {
  try {
    const io = req?.app?.get?.('io');
    if (!io || !workspaceId) return;
    const room = `workspace-${String(workspaceId)}`;
    Promise.resolve(io.in(room).fetchSockets())
      .then((sockets) => {
        for (const s of sockets) s.data?.userWorkspaceIds?.delete?.(String(workspaceId));
        io.in(room).socketsLeave(room);
      })
      .catch(() => {});
  } catch (err) {
    logger.warn('[socketRooms] Room close failed', { error: err.message });
  }
};

module.exports = { joinWorkspaceRoom, leaveWorkspaceRoom, closeWorkspaceRoom };
