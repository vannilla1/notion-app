const logger = require('../utils/logger');

/**
 * In-memory data cache for workspace data (contacts, tasks).
 * Reduces repetitive DB queries on Atlas M0 free tier.
 *
 * Key: `${workspaceId}:${dataType}`, Value: { data, cachedAt }
 * TTL: 30 seconds — fresh enough for CRM, huge perf win on slow DB.
 *
 * Invalidation: call invalidateWorkspaceData() after any mutation (create/update/delete).
 */

const dataCache = new Map();
const CACHE_TTL = 120000; // 2 minutes — safe for CRM, huge perf win on Atlas M0

const getCachedData = (workspaceId, dataType) => {
  const key = `${workspaceId}:${dataType}`;
  const entry = dataCache.get(key);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) {
    return entry.data;
  }
  dataCache.delete(key);
  return null;
};

const setCachedData = (workspaceId, dataType, data) => {
  const key = `${workspaceId}:${dataType}`;
  dataCache.set(key, { data, cachedAt: Date.now() });

  // Limit total cache size (prevent memory leak)
  if (dataCache.size > 500) {
    // Remove oldest entries
    const keys = Array.from(dataCache.keys());
    for (let i = 0; i < 100; i++) {
      dataCache.delete(keys[i]);
    }
  }
};

const invalidateWorkspaceData = (workspaceId, dataType) => {
  if (dataType) {
    dataCache.delete(`${workspaceId}:${dataType}`);
  } else {
    // Invalidate all data for this workspace
    for (const key of dataCache.keys()) {
      if (key.startsWith(`${workspaceId}:`)) {
        dataCache.delete(key);
      }
    }
  }
};

module.exports = {
  getCachedData,
  setCachedData,
  invalidateWorkspaceData
};
