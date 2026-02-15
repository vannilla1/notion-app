import { useEffect, useCallback, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL } from '../api/api';

export const useSocket = () => {
  const { token, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  // Track registered listeners to prevent memory leaks
  const listenersRef = useRef(new Map());

  useEffect(() => {
    if (!isAuthenticated || !token) {
      return;
    }

    const newSocket = io(API_BASE_URL, {
      auth: { token },
      // Reconnection settings
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error.message);
    });

    setSocket(newSocket);

    return () => {
      // Clean up all registered listeners
      listenersRef.current.forEach((callback, event) => {
        newSocket.off(event, callback);
      });
      listenersRef.current.clear();
      newSocket.disconnect();
      setSocket(null);
      setIsConnected(false);
    };
  }, [isAuthenticated, token]);

  const joinPage = useCallback((pageId) => {
    if (socket) {
      socket.emit('join-page', pageId);
    }
  }, [socket]);

  const leavePage = useCallback((pageId) => {
    if (socket) {
      socket.emit('leave-page', pageId);
    }
  }, [socket]);

  const emitPageUpdate = useCallback((pageId, content, title) => {
    if (socket) {
      socket.emit('page-update', { pageId, content, title });
    }
  }, [socket]);

  const emitBlockUpdate = useCallback((pageId, blockId, content, type) => {
    if (socket) {
      socket.emit('block-update', { pageId, blockId, content, type });
    }
  }, [socket]);

  const emitCursorMove = useCallback((pageId, position) => {
    if (socket) {
      socket.emit('cursor-move', { pageId, position });
    }
  }, [socket]);

  // Helper to safely register event listeners with cleanup tracking
  const registerListener = useCallback((event, callback) => {
    if (!socket) return () => {};

    // Remove existing listener for this event to prevent duplicates
    const existingCallback = listenersRef.current.get(event);
    if (existingCallback) {
      socket.off(event, existingCallback);
    }

    // Register new listener
    socket.on(event, callback);
    listenersRef.current.set(event, callback);

    // Return cleanup function
    return () => {
      socket.off(event, callback);
      listenersRef.current.delete(event);
    };
  }, [socket]);

  const onPageUpdated = useCallback((callback) => {
    return registerListener('page-updated', callback);
  }, [registerListener]);

  const onBlockUpdated = useCallback((callback) => {
    return registerListener('block-updated', callback);
  }, [registerListener]);

  const onCursorMoved = useCallback((callback) => {
    return registerListener('cursor-moved', callback);
  }, [registerListener]);

  const onPageCreated = useCallback((callback) => {
    return registerListener('page-created', callback);
  }, [registerListener]);

  const onPageDeleted = useCallback((callback) => {
    return registerListener('page-deleted', callback);
  }, [registerListener]);

  return {
    socket,
    isConnected,
    joinPage,
    leavePage,
    emitPageUpdate,
    emitBlockUpdate,
    emitCursorMove,
    onPageUpdated,
    onBlockUpdated,
    onCursorMoved,
    onPageCreated,
    onPageDeleted
  };
};
