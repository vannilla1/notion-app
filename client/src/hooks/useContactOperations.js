import { useState, useCallback } from 'react';
import api from '../api/api';

/**
 * useContactOperations - Custom hook for contact CRUD operations
 * Centralizes contact-related API calls and state management
 */
export const useContactOperations = (onContactsChange) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetches all contacts from the API
   */
  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/api/contacts');
      if (onContactsChange) {
        onContactsChange(res.data);
      }
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri načítaní kontaktov';
      setError(message);
      console.error('Failed to fetch contacts:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [onContactsChange]);

  /**
   * Creates a new contact
   */
  const createContact = useCallback(async (contactData) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/api/contacts', contactData);
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri vytváraní kontaktu';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Updates an existing contact
   */
  const updateContact = useCallback(async (contactId, updateData) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.put(`/api/contacts/${contactId}`, updateData);
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri ukladaní kontaktu';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Deletes a contact
   */
  const deleteContact = useCallback(async (contactId) => {
    setLoading(true);
    setError(null);
    try {
      await api.delete(`/api/contacts/${contactId}`);
      return true;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri mazaní kontaktu';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Clears the current error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    fetchContacts,
    createContact,
    updateContact,
    deleteContact,
    clearError
  };
};

/**
 * useTaskOperations - Custom hook for task CRUD operations
 */
export const useTaskOperations = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetches all global tasks
   */
  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/api/tasks');
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri načítaní úloh';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Creates a new task for a contact
   */
  const createContactTask = useCallback(async (contactId, taskData) => {
    setError(null);
    try {
      const res = await api.post(`/api/contacts/${contactId}/tasks`, taskData);
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri vytváraní úlohy';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Updates a task
   */
  const updateTask = useCallback(async (contactId, taskId, updateData, isGlobal = false) => {
    setError(null);
    try {
      const url = isGlobal
        ? `/api/tasks/${taskId}`
        : `/api/contacts/${contactId}/tasks/${taskId}`;
      const res = await api.put(url, updateData);
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri ukladaní úlohy';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Toggles task completion
   */
  const toggleTask = useCallback(async (contactId, taskId, currentCompleted, isGlobal = false) => {
    return updateTask(contactId, taskId, { completed: !currentCompleted }, isGlobal);
  }, [updateTask]);

  /**
   * Deletes a task
   */
  const deleteTask = useCallback(async (contactId, taskId, isGlobal = false) => {
    setError(null);
    try {
      const url = isGlobal
        ? `/api/tasks/${taskId}`
        : `/api/contacts/${contactId}/tasks/${taskId}`;
      await api.delete(url);
      return true;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri mazaní úlohy';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Creates a subtask
   */
  const createSubtask = useCallback(async (contactId, taskId, subtaskData, isGlobal = false) => {
    setError(null);
    try {
      const url = isGlobal
        ? `/api/tasks/${taskId}/subtasks`
        : `/api/contacts/${contactId}/tasks/${taskId}/subtasks`;
      const res = await api.post(url, subtaskData);
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri vytváraní podúlohy';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Toggles subtask completion
   */
  const toggleSubtask = useCallback(async (contactId, taskId, subtaskId, currentCompleted, isGlobal = false) => {
    setError(null);
    try {
      const url = isGlobal
        ? `/api/tasks/${taskId}/subtasks/${subtaskId}`
        : `/api/contacts/${contactId}/tasks/${taskId}/subtasks/${subtaskId}`;
      const res = await api.put(url, { completed: !currentCompleted });
      return res.data;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri aktualizácii podúlohy';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Deletes a subtask
   */
  const deleteSubtask = useCallback(async (contactId, taskId, subtaskId, isGlobal = false) => {
    setError(null);
    try {
      const url = isGlobal
        ? `/api/tasks/${taskId}/subtasks/${subtaskId}`
        : `/api/contacts/${contactId}/tasks/${taskId}/subtasks/${subtaskId}`;
      await api.delete(url);
      return true;
    } catch (err) {
      const message = err.response?.data?.message || 'Chyba pri mazaní podúlohy';
      setError(message);
      throw err;
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    fetchTasks,
    createContactTask,
    updateTask,
    toggleTask,
    deleteTask,
    createSubtask,
    toggleSubtask,
    deleteSubtask,
    clearError
  };
};

export default useContactOperations;
