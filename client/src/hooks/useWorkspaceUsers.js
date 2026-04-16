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
      const data = excludeUserId
        ? res.data.filter((u) => u.id !== excludeUserId)
        : res.data;
      setUsers(data);
    } catch {
      /* silently ignore — picker ostane prázdny */
    }
  }, [excludeUserId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { users, refetch };
}
