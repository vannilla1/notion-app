import { useEffect, useRef } from 'react';
import { APP_EVENTS } from '../utils/constants';

/**
 * Spustí `handler` keď sa appka vráti z pozadia (iOS viewDidAppear,
 * visibility change) — pages refetchnú dáta pre fresh stav.
 *
 * Ref-based pattern: listener sa binduje LEN raz, handler nemusí byť
 * stable (volá sa vždy najnovšia verzia).
 *
 * @param {() => void} handler
 */
export function useAppResume(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = () => handlerRef.current();
    window.addEventListener(APP_EVENTS.APP_RESUMED, listener);
    return () => window.removeEventListener(APP_EVENTS.APP_RESUMED, listener);
  }, []);
}
