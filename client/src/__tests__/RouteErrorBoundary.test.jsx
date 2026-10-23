import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RouteErrorBoundary } from '../App';
import { __resetChunkRecovery } from '../utils/reportError';
import { getBreadcrumbs } from '../utils/breadcrumbs';

/**
 * Zlyhanie lazy chunku v RouteErrorBoundary (Diagnostika 23. 10. 2026):
 * počas automatickej obnovy „Načítavam…“ (nie bliknutie červeného okna),
 * po vyčerpaní pokusov červené okno + jedno hlásenie s kontextom.
 */
const Thrower = ({ message }) => { throw new Error(message); };

let reload;
let originalLocation;
let fetchMock;

beforeEach(() => {
  sessionStorage.clear();
  __resetChunkRecovery();
  reload = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, pathname: '/admin/dashboard', reload, assign: vi.fn() },
  });
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('RouteErrorBoundary', () => {
  it('chunk chyba: „Načítavam…“, reload, žiadne hlásenie', () => {
    render(<RouteErrorBoundary><Thrower message="Importing a module script failed." /></RouteErrorBoundary>);
    expect(screen.getByText('Načítavam…')).toBeInTheDocument();
    expect(screen.queryByText('Chyba pri načítaní stránky')).not.toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ak sa stránka do 25 s neobnoví (reload zrušený), ukáže okno s tlačidlom späť do appky', () => {
    vi.useFakeTimers();
    render(<RouteErrorBoundary><Thrower message="Importing a module script failed." /></RouteErrorBoundary>);
    expect(screen.getByText('Načítavam…')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(24000); });
    expect(screen.getByText('Načítavam…')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
    act(() => { screen.getByText('Späť do aplikácie').click(); });
    expect(window.location.assign).toHaveBeenCalledWith('/app');
  });

  it('prechod na inú stránku zruší chybové okno', () => {
    let fail = true;
    const Maybe = () => { if (fail) throw new Error('Neočakávaná chyba v stránke'); return <p>Stránka OK</p>; };
    const { rerender } = render(<RouteErrorBoundary resetKey="/crm"><Maybe /></RouteErrorBoundary>);
    expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
    fail = false;
    rerender(<RouteErrorBoundary resetKey="/tasks"><Maybe /></RouteErrorBoundary>);
    expect(screen.getByText('Stránka OK')).toBeInTheDocument();
  });

  it('vyčerpané pokusy: červené okno a jedno hlásenie s kontextom obnovy', () => {
    sessionStorage.setItem('__prpl_chunk_recovery', JSON.stringify({ first: Date.now() - 2000, n: 2 }));
    render(<RouteErrorBoundary><Thrower message="Importing a module script failed." /></RouteErrorBoundary>);
    expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message).toBe('Importing a module script failed.');
    expect(body.name).toBe('ChunkRecoveryExhausted');
    const crumb = getBreadcrumbs().find(b => b.message.startsWith('chunk recovery exhausted'));
    expect(crumb?.message).toMatch(/attempts=2 online=1 sw=0 ago=\d+ms route=\/admin\/dashboard/);
    expect(screen.getByText('Obnoviť stránku')).toBeInTheDocument();
  });

  it('bez siete: červené okno, hlásenie ako ChunkLoadOffline bez „exhausted“ breadcrumbu', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      // Iná správa než v predošlom teste — reportError deduplikuje 30 s.
      render(<RouteErrorBoundary><Thrower message="Failed to fetch dynamically imported module: https://prplcrm.eu/assets/Offline-x.js" /></RouteErrorBoundary>);
      expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).name).toBe('ChunkLoadOffline');
      expect(getBreadcrumbs().some(b => b.message.startsWith('chunk recovery exhausted') && b.message.includes('Offline'))).toBe(false);
    } finally {
      delete navigator.onLine;
    }
  });

  it('chyba, ktorú hodí práve nová route, sa zachytí len raz', () => {
    let fail = false;
    const Maybe = () => { if (fail) throw new Error('Neočakávaná chyba v stránke'); return <p>Stránka OK</p>; };
    const { rerender } = render(<RouteErrorBoundary resetKey="/crm"><Maybe /></RouteErrorBoundary>);
    fail = true;
    rerender(<RouteErrorBoundary resetKey="/tasks"><Maybe /></RouteErrorBoundary>);
    expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
    const caught = console.error.mock.calls.filter(c => String(c[0]).includes('[RouteErrorBoundary] caught'));
    expect(caught).toHaveLength(1);
  });

  it('bežná chyba ide rovno do červeného okna bez reloadu', () => {
    render(<RouteErrorBoundary><Thrower message="Neočakávaná chyba v stránke" /></RouteErrorBoundary>);
    expect(screen.getByText('Chyba pri načítaní stránky')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
