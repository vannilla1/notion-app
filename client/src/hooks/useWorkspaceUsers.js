import { useState, useEffect, useCallback } from 'react';
import api from '../api/api';

/**
 * Načíta zoznam users v aktuálnom workspace (cez GET /api/auth/users).
 * Response obsahuje workspace-scoped rolu ('owner' | 'manager' | 'member').
 *
 * @param {object} [options]
 * @param {string} [options.excludeUserId] — ak je poskytnuté, tohoto usera
 *   vyfiltruje (typicky self, napr. v pickeri príjemcov správy).
 * @returns {{ users: Array, refetch: () => Promise<void> }}
 */
export function useWorkspaceUsers({ excludeUserId } = {}) {
  const [users, setUsers] = useState([]);

  const refetch = useCallback(async () => {
    try {
      const res = await api.get('/api/auth/users');
      // String-coerce on both sides — ObjectId vs string mismatch by JSON
      // serialization edge cases by would silently filter the whole list.
      const exclude = excludeUserId != null ? String(excludeUserId) : null;
      const data = exclude
        ? res.data.filter((u) => String(u.id) !== exclude)
        : res.data;
      setUsers(data);
    } catch (err) {
      // Log to console so we can diagnose silent failures (workspace fetch
      // 401/500, network drop, etc.). Picker stays empty — empty-state UI
      // in the consumer should explain it.
      // eslint-disable-next-line no-console
      console.warn('[useWorkspaceUsers] failed to fetch workspace users:', err?.message || err);
    }
  }, [excludeUserId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { users, refetch };
}
