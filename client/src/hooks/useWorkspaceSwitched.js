import { useEffect, useRef } from 'react';
import { APP_EVENTS } from '../utils/constants';

/**
 * Spustí `handler` vždy keď WorkspaceContext dispatchne `workspace-switched`
 * event (user prepol pracovné prostredie — stránka potrebuje refetchnúť dáta
 * a resetnúť expanded/modal state).
 *
 * Ref-based pattern: listener sa binduje LEN raz, ale vždy volá aktuálnu
 * verziu handlera — volajúci nemusí obaliť handler do `useCallback`.
 *
 * @param {(e: CustomEvent) => void} handler
 */
export function useWorkspaceSwitched(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (e) => handlerRef.current(e);
    window.addEventListener(APP_EVENTS.WORKSPACE_SWITCHED, listener);
    return () => window.removeEventListener(APP_EVENTS.WORKSPACE_SWITCHED, listener);
  }, []);
}
