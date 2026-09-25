import { useEffect, useState } from 'react';
import {
  subscribeUploads, onUploadFailed, processUploadQueue,
  retryFailedUploads, discardFailedUploads
} from '../utils/uploadQueue';
import { PLAN_GATE_CODES, dispatchPlanGate } from '../utils/planGate';

const MAX_NOTICES = 3;

// Slovenský tvar podľa počtu: 1 príloha · 2–4 prílohy · 0 a 5+ príloh
const byCount = (n, one, few, many) => (n === 1 ? one : (n >= 2 && n <= 4 ? few : many));

/**
 * UploadQueueIndicator — plávajúci ukazovateľ stavu nahrávania príloh.
 *
 * Bez neho používateľ nevidel, či sa niečo deje (len text „Nahrávam…"),
 * takže nemal dôvod počkať a appku pokojne zavrel uprostred prenosu.
 * Teraz vidí percentá aj to, že má počkať; a keď niečo ostane vo fronte,
 * vie, že sa to odošle a môže to skúsiť znova.
 *
 * Je to aj JEDINÉ miesto, kde sa ukazujú zlyhania nahrávania. Doteraz ich
 * hlásili len stránky Tasks/CRM cez alert — keď používateľ medzitým odišiel
 * inam (alebo fronta dobiehala po štarte appky), súbor sa zmazal a hláška
 * neprišla nikomu. Indikátor je v App.jsx pripojený na každej stránke.
 * Plánové limity (FEATURE_NOT_IN_PLAN / STORAGE_LIMIT…) idú do UpgradeModal
 * — ten má na iOS neutrálny text (Apple 3.1.1), preto nie vlastný alert.
 */
export default function UploadQueueIndicator() {
  const [s, setS] = useState({ pending: 0, active: null, progress: 0, failed: 0, retrying: 0, lastError: null });
  const [notices, setNotices] = useState([]); // [{ id, fileName, message }]

  useEffect(() => subscribeUploads(setS), []);

  useEffect(() => onUploadFailed(({ item, message, code }) => {
    if (code && PLAN_GATE_CODES.has(code)) {
      dispatchPlanGate({ code, message });
      return;
    }
    const id = item?.uploadId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setNotices(prev => [
      ...prev.filter(n => n.id !== id),
      { id, fileName: item?.fileName || 'súbor', message: message || 'Neznáma chyba servera.' }
    ].slice(-MAX_NOTICES));
  }), []);

  const dismiss = (id) => setNotices(prev => prev.filter(n => n.id !== id));

  const showStatus = !!s.active || s.pending > 0;
  if (!showStatus && notices.length === 0) return null;

  // Vyčerpané položky (5 neúspešných pokusov) sa samé neodošlú — rozhoduje
  // používateľ. Ostatné (autoPending) fronta ešte skúsi automaticky.
  const failed = Math.min(s.failed || 0, s.pending);
  const autoPending = Math.max(0, s.pending - failed);
  const waiting = Math.max(0, autoPending - (s.active ? 1 : 0));
  const allFailed = !s.active && failed > 0 && autoPending === 0;
  // Tlačidlá pri vyčerpaných položkách MUSIA byť aj vtedy, keď popri nich
  // čaká iná príloha. Doteraz sa ukázali len pri allFailed — video, ktoré
  // zlyhalo 5×, a fotka za ním dali „2 príloh čaká na odoslanie…" bez
  // jediného tlačidla, takže video nešlo ani zopakovať, ani zahodiť.
  const someFailed = !s.active && failed > 0 && autoPending > 0;
  // Čaká na automatické opakovanie po dočasnej chybe (backoff) — ukážeme
  // prečo a dáme možnosť skúsiť hneď, nie len „čaká na odoslanie…".
  const retryingAfterError = !s.active && !allFailed && s.retrying > 0 && !!s.lastError;

  return (
    <div
      style={{
        position: 'fixed', left: 16, bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
        zIndex: 900, maxWidth: 'min(340px, calc(100vw - 32px))',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
        // Medzery medzi kartami nesmú blokovať kliky na stránku pod nimi
        pointerEvents: 'none'
      }}
    >
      {notices.map(n => (
        <div
          key={n.id}
          role="alert"
          style={{
            pointerEvents: 'auto',
            background: 'var(--bg-card)', border: '1px solid var(--border-color)',
            borderLeft: '4px solid var(--danger, #ef4444)',
            borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: '10px 12px 10px 14px',
            display: 'flex', gap: 8, alignItems: 'flex-start'
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>
              Prílohu „{n.fileName}“ sa nepodarilo nahrať
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, overflowWrap: 'anywhere' }}>
              {n.message}
            </div>
          </div>
          <button
            type="button"
            onClick={() => dismiss(n.id)}
            aria-label="Zavrieť"
            title="Zavrieť"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px',
              fontSize: 20, lineHeight: 1, color: 'var(--text-muted)'
            }}
          >
            ×
          </button>
        </div>
      ))}

      {showStatus && (
        <div
          style={{
            pointerEvents: 'auto',
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
                {failed} {byCount(failed, 'príloha sa neodoslala', 'prílohy sa neodoslali', 'príloh sa neodoslalo')}
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
            <>
              <div style={{ fontSize: 13 }}>
                <strong>{autoPending}</strong> {byCount(autoPending, 'príloha čaká', 'prílohy čakajú', 'príloh čaká')} na odoslanie…
              </div>
              {retryingAfterError && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, overflowWrap: 'anywhere' }}>
                    Posledný pokus zlyhal: {s.lastError}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Skúsim to znova automaticky.
                  </div>
                </>
              )}
              {someFailed && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>
                    {failed} {byCount(failed, 'príloha sa neodoslala', 'prílohy sa neodoslali', 'príloh sa neodoslalo')} ani po opakovaných pokusoch
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Súbory sú uložené v zariadení — môžete to skúsiť znova.
                  </div>
                </>
              )}
              {someFailed ? (
                // „Skúsiť znova" vráti pokusy vyčerpaným a hneď spustí frontu —
                // tá zároveň skúsi aj prílohy čakajúce na backoff.
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={retryFailedUploads}>Skúsiť znova</button>
                  <button className="btn btn-secondary btn-sm" onClick={discardFailedUploads}>Zahodiť neodoslané</button>
                </div>
              ) : retryingAfterError ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => { processUploadQueue(); }}>Skúsiť teraz</button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
