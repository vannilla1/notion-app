import { useEffect, useCallback, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL } from '../api/api';

// Jedno Socket.IO spojenie pre celú aplikáciu. Predtým každé volanie
// useSocket() (App, zvonček, toast, aktuálna stránka…) otváralo vlastné
// autentifikované spojenie — 3–4 naraz a pri každom prepnutí sekcie nové
// (JWT overenie + join do miestností na serveri pri každom). Konzumenti
// odhlasujú len vlastné handlery (socket.off(event, handler)), takže zdieľanie
// je bezpečné. Spojenie sa zavrie, keď ho neužíva žiadny komponent, a pri
// zmene tokenu sa nahradí novým.
const shared = { socket: null, token: null, refs: 0 };

const acquireSocket = (token) => {
  if (shared.socket && shared.token !== token) {
    shared.socket.disconnect();
    shared.socket = null;
    shared.refs = 0;
  }
  if (!shared.socket) {
    shared.socket = io(API_BASE_URL, {
      auth: { token },
      // Reconnection settings — bez limitu pokusov (predvolené Infinity,
      // exponenciálny backoff 1 s → 5 s). Pôvodných 5 pokusov sa vyčerpalo
      // po ~20 s výpadku (mobil v pozadí, slabý signál) a socket.io už nikdy
      // znova nepripojil → notifikácie, task/message eventy mŕtve do reloadu.
      reconnection: true,
      reconnectionDelay: 1000
    });
    shared.socket.on('connect_error', () => {});
    shared.token = token;
  }
  shared.refs += 1;
  return shared.socket;
};

const releaseSocket = (socket) => {
  // Spojenie už medzičasom nahradilo nové (iný token) — staré je odpojené.
  if (shared.socket !== socket) return;
  shared.refs -= 1;
  if (shared.refs <= 0) {
    socket.disconnect();
    shared.socket = null;
    shared.token = null;
    shared.refs = 0;
  }
};

export const useSocket = () => {
  const { token, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const listenersRef = useRef(new Map());

  useEffect(() => {
    if (!isAuthenticated || !token) {
      return;
    }

    const sharedSocket = acquireSocket(token);
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    sharedSocket.on('connect', handleConnect);
    sharedSocket.on('disconnect', handleDisconnect);

    setSocket(sharedSocket);
    // Spojenie mohlo byť pripojené už pred týmto komponentom.
    setIsConnected(sharedSocket.connected);

    return () => {
      listenersRef.current.forEach((callback, event) => {
        sharedSocket.off(event, callback);
      });
      listenersRef.current.clear();
      sharedSocket.off('connect', handleConnect);
      sharedSocket.off('disconnect', handleDisconnect);
      releaseSocket(sharedSocket);
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

  const registerListener = useCallback((event, callback) => {
    if (!socket) return () => {};

    const existingCallback = listenersRef.current.get(event);
    if (existingCallback) {
      socket.off(event, existingCallback);
    }

    socket.on(event, callback);
    listenersRef.current.set(event, callback);

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
