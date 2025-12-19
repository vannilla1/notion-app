import { useEffect, useCallback, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL } from '../api/api';

export const useSocket = () => {
  const { token, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      return;
    }

    const newSocket = io(API_BASE_URL, {
      auth: { token }
    });

    newSocket.on('connect', () => {
      console.log('Socket connected');
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected');
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });

    setSocket(newSocket);

    return () => {
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

  const onPageUpdated = useCallback((callback) => {
    if (socket) {
      socket.on('page-updated', callback);
      return () => socket.off('page-updated', callback);
    }
  }, [socket]);

  const onBlockUpdated = useCallback((callback) => {
    if (socket) {
      socket.on('block-updated', callback);
      return () => socket.off('block-updated', callback);
    }
  }, [socket]);

  const onCursorMoved = useCallback((callback) => {
    if (socket) {
      socket.on('cursor-moved', callback);
      return () => socket.off('cursor-moved', callback);
    }
  }, [socket]);

  const onPageCreated = useCallback((callback) => {
    if (socket) {
      socket.on('page-created', callback);
      return () => socket.off('page-created', callback);
    }
  }, [socket]);

  const onPageDeleted = useCallback((callback) => {
    if (socket) {
      socket.on('page-deleted', callback);
      return () => socket.off('page-deleted', callback);
    }
  }, [socket]);

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
