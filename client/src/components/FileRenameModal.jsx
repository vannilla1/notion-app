import { useState, useRef, useEffect } from 'react';

/**
 * FileRenameModal — pri vkladaní prílohy umožní prepísať názov súboru.
 *
 * Hlavný dôvod: fotky odfotené priamo v appke majú generický názov
 * "image.jpg". Tento modal dá userovi prepísať názov pred nahratím.
 *
 * ⚠️ PREČO custom modal a NIE window.prompt():
 * iOS WKWebView (native shell) implementuje iba alert + confirm panel
 * handlery, NIE text-input panel (`runJavaScriptTextInputPanel...`).
 * Preto `window.prompt()` v iOS appke vráti null / zlyhá. Custom HTML
 * input s natívnou klávesnicou funguje normálne → toto je jediná cesta,
 * ktorá funguje aj na webe aj v iOS appke. Žiadny iOS rebuild netreba.
 *
 * Prípona (.jpg/.pdf/…) sa zachová automaticky — user mení iba základ
 * názvu, príponu vidí ako needitovateľný suffix.
 *
 * Props:
 *  - file: File objekt (kvôli .name) — pri nahrávaní nového súboru
 *  - fileName: string — alternatíva k `file`, pri premenovaní už nahratého súboru
 *  - title: nadpis modalu (default "Názov prílohy")
 *  - confirmLabel: text potvrdzovacieho tlačidla (default "Nahrať")
 *  - onConfirm(finalName): zavolá sa s celým názvom vrátane prípony
 *  - onCancel(): zrušenie
 */
export default function FileRenameModal({ file, fileName, title, confirmLabel, onConfirm, onCancel }) {
  const fullName = fileName || file?.name || '';
  const dotIdx = fullName.lastIndexOf('.');
  // Prípona iba ak bodka nie je na začiatku (skryté súbory) a nejaká je.
  const ext = dotIdx > 0 ? fullName.slice(dotIdx) : '';
  const baseName = dotIdx > 0 ? fullName.slice(0, dotIdx) : fullName;

  const [name, setName] = useState(baseName);
  const inputRef = useRef(null);

  useEffect(() => {
    // Auto-focus + označ celý základ názvu, nech sa dá hneď prepísať.
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);

  const submit = () => {
    const trimmed = (name || '').trim();
    // Prázdny vstup → fallback na pôvodný základ názvu.
    const finalBase = trimmed || baseName;
    onConfirm(finalBase + ext);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title || 'Názov prílohy'}</h3>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Pomenuj súbor</label>
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Názov súboru"
                style={{
                  flex: 1,
                  borderTopRightRadius: ext ? 0 : undefined,
                  borderBottomRightRadius: ext ? 0 : undefined,
                }}
              />
              {ext && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 12px',
                    background: 'var(--bg-secondary, #f3f4f6)',
                    border: '1px solid var(--border, #e5e7eb)',
                    borderLeft: 'none',
                    borderTopRightRadius: 8,
                    borderBottomRightRadius: 8,
                    color: 'var(--text-secondary, #6b7280)',
                    fontSize: 14,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ext}
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #9ca3af)', marginTop: 8, lineHeight: 1.5 }}>
              Prípona <strong>{ext || '(žiadna)'}</strong> sa zachová. Nechaj prázdne pre pôvodný názov.
            </p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>Zrušiť</button>
          <button className="btn btn-primary" onClick={submit}>{confirmLabel || 'Nahrať'}</button>
        </div>
      </div>
    </div>
  );
}
