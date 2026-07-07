/**
 * ConfirmModal — všeobecné potvrdzovacie okno (áno/nie s vlastnými popiskami).
 *
 * Prečo custom modal a nie window.confirm(): jasné, pomenované tlačidlá
 * ("Uzavrieť projekt" / "Nechať otvorený") namiesto generického OK/Zrušiť,
 * konzistentný vzhľad s appkou, a funguje spoľahlivo aj v iOS WKWebView.
 *
 * Props:
 *  - title: nadpis okna
 *  - message: text otázky (string alebo node)
 *  - confirmLabel: popis potvrdzovacieho tlačidla (default "Potvrdiť")
 *  - cancelLabel: popis zrušovacieho tlačidla (default "Zrušiť")
 *  - onConfirm(): klik na potvrdenie
 *  - onCancel(): klik na zrušenie / zatvorenie (overlay, ×, Escape)
 */
import { useEffect, useRef } from 'react';

export default function ConfirmModal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  // onCancel cez ref — call-sites posielajú inline arrow (nová identita každý
  // render), takže by efekt inak re-runoval pri každom pozadovom re-renderi
  // (socket → fetchTasks) a kradol focus späť na Zrušiť. Efekt tak beží LEN raz.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    // Zámerne zaostríme ZRUŠIŤ (nie potvrdiť) a Enter neviažeme na potvrdenie —
    // rozhodnutie (napr. uzavretie projektu) musí byť vedomý klik, nie náhodný
    // Enter. Escape = bezpečná voľba (zrušiť / nechať tak).
    const t = setTimeout(() => cancelRef.current?.focus(), 50);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancelRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: 440 }} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title || 'Potvrdenie'}</h3>
          <button className="modal-close" onClick={onCancel} aria-label="Zavrieť">×</button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, lineHeight: 1.6 }}>{message}</p>
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} className="btn btn-secondary" onClick={onCancel}>{cancelLabel || 'Zrušiť'}</button>
          <button className="btn btn-primary" onClick={onConfirm}>{confirmLabel || 'Potvrdiť'}</button>
        </div>
      </div>
    </div>
  );
}
