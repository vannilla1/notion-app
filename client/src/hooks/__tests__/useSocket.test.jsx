import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Jedno zdieľané Socket.IO spojenie pre všetky komponenty (predtým každé
// volanie useSocket() otváralo vlastné).
const sockets = [];
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const handlers = new Map();
    const socket = {
      connected: false,
      on: vi.fn((e, cb) => { handlers.set(e, [...(handlers.get(e) || []), cb]); }),
      off: vi.fn((e, cb) => { handlers.set(e, (handlers.get(e) || []).filter((h) => h !== cb)); }),
      disconnect: vi.fn(),
      emitLocal: (e) => (handlers.get(e) || []).forEach((h) => h()),
      handlers
    };
    sockets.push(socket);
    return socket;
  })
}));

let auth = { token: 't1', isAuthenticated: true };
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../api/api', () => ({ API_BASE_URL: 'http://api.test' }));

const { io } = await import('socket.io-client');
const { useSocket } = await import('../useSocket');

describe('useSocket', () => {
  beforeEach(() => {
    sockets.length = 0;
    io.mockClear();
    auth = { token: 't1', isAuthenticated: true };
  });

  it('viac komponentov zdieľa jedno spojenie; zavrie sa až po poslednom', () => {
    const a = renderHook(() => useSocket());
    const b = renderHook(() => useSocket());
    expect(io).toHaveBeenCalledTimes(1);
    expect(a.result.current.socket).toBe(b.result.current.socket);

    act(() => { sockets[0].connected = true; sockets[0].emitLocal('connect'); });
    expect(a.result.current.isConnected).toBe(true);
    expect(b.result.current.isConnected).toBe(true);

    a.unmount();
    expect(sockets[0].disconnect).not.toHaveBeenCalled();
    // Odhlásia sa len handlery odpojeného komponentu
    expect(sockets[0].handlers.get('connect')).toHaveLength(1);
    b.unmount();
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('nový komponent dostane stav už pripojeného spojenia', () => {
    const a = renderHook(() => useSocket());
    act(() => { sockets[0].connected = true; sockets[0].emitLocal('connect'); });
    const b = renderHook(() => useSocket());
    expect(b.result.current.isConnected).toBe(true);
    a.unmount();
    b.unmount();
  });

  it('zmena tokenu nahradí spojenie novým', () => {
    const a = renderHook(() => useSocket());
    auth = { token: 't2', isAuthenticated: true };
    a.rerender();
    expect(io).toHaveBeenCalledTimes(2);
    expect(sockets[0].disconnect).toHaveBeenCalled();
    expect(a.result.current.socket).toBe(sockets[1]);
    a.unmount();
    expect(sockets[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it('bez prihlásenia sa nepripája', () => {
    auth = { token: null, isAuthenticated: false };
    const a = renderHook(() => useSocket());
    expect(io).not.toHaveBeenCalled();
    expect(a.result.current.socket).toBeNull();
  });
});
