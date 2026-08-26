import { useEffect, useState } from 'react';
import { subscribeUploads, retryFailedUploads, discardFailedUploads } from '../utils/uploadQueue';

/**
 * UploadQueueIndicator — plávajúci ukazovateľ stavu nahrávania príloh.
 *
 * Bez neho používateľ nevidel, či sa niečo deje (len text „Nahrávam…"),
 * takže nemal dôvod počkať a appku pokojne zavrel uprostred prenosu.
 * Teraz vidí percentá aj to, že má počkať; a keď niečo ostane vo fronte,
 * vie, že sa to odošle a môže to skúsiť znova.
 */
export default function UploadQueueIndicator() {
  const [s, setS] = useState({ pending: 0, active: null, progress: 0, failed: 0 });

  useEffect(() => subscribeUploads(setS), []);

  if (!s.active && s.pending === 0) return null;

  const waiting = Math.max(0, s.pending - (s.active ? 1 : 0));
  const allFailed = !s.active && s.failed > 0 && s.failed >= s.pending;

  return (
    <div
      style={{
        position: 'fixed', left: 16, bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
        zIndex: 900, maxWidth: 340,
        background: 'var(--bg-card)', border: '1px solid var(--border-color)',
        borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: '10px 14px'
      }}
      role="status"
      aria-live="polite"
    >
      {s.active ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Nahrávam prílohu… {s.progress}%
          </div>
          <div style={{ height: 6, background: 'var(--bg-secondary)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{
              width: `${s.progress}%`, height: '100%',
              background: 'var(--accent-color, #6366f1)', transition: 'width .2s'
            }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            {s.active.fileName}
            {waiting > 0 && ` · ďalšie čakajú: ${waiting}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Nechajte aplikáciu otvorenú, kým sa nahrávanie dokončí.
          </div>
        </>
      ) : allFailed ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {s.pending} {s.pending === 1 ? 'príloha sa neodoslala' : 'príloh sa neodoslalo'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Súbory sú uložené v zariadení — môžete to skúsiť znova.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={retryFailedUploads}>Skúsiť znova</button>
            <button className="btn btn-secondary btn-sm" onClick={discardFailedUploads}>Zahodiť</button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13 }}>
          <strong>{s.pending}</strong> {s.pending === 1 ? 'príloha čaká' : 'príloh čaká'} na odoslanie…
        </div>
      )}
    </div>
  );
}
