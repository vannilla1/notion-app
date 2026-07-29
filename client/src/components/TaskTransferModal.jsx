import { useState, useRef, useMemo } from 'react';
import api from '../api/api';

// Strop hromadného kopírovania — drží batch bezpečne pod rate limitom
// (100 req/min aj s background refetchmi) a ohraničuje objem duplikovaných
// príloh na jeden klik.
const MAX_TARGETS = 25;

// Slovenské skloňovanie: 1 kontakt / 2–4 kontakty / 5+ kontaktov
const kontaktSklon = (n) => (n === 1 ? 'kontakt' : n < 5 ? 'kontakty' : 'kontaktov');

/**
 * Modal na kopírovanie / presun projektu alebo úlohy do projektových stromov
 * iných kontaktov v rámci aktuálneho prostredia. Dvojkrokový výber:
 * 1) cieľové kontakty (viacero naraz, max MAX_TARGETS) → 2) cieľový projekt,
 * potom akcia Kopírovať / Presunúť.
 *
 * Viacero cieľov má zmysel len pri KOPÍROVANÍ (vznikne N nezávislých kópií).
 * Presun položku premiestňuje, takže má práve jeden cieľ.
 *
 * Cieľ pre ÚLOHU/PODÚLOHU je defaultne „ako v origináli" ('SOURCE'):
 * v cieľovom kontakte pristane pod projektom zodpovedajúcim zdrojovému
 * projektu (server ho nájde cez copiedFrom alebo vytvorí obal) — replikuje
 * sa štruktúra kontakt → projekt → úloha. Celé PROJEKTY idú pri viacerých
 * cieľoch ako nový projekt.
 *
 * Čiastočné zlyhanie NEZAVRIE modál — výber sa zúži na neúspešné kontakty,
 * aby sa dali zopakovať bez rizika duplikovania už úspešných kópií.
 *
 * item = { contactId, taskId, subtaskId?, title, sourceTaskTitle? }
 */
function TaskTransferModal({ item, contacts, onClose, onDone, onRefresh }) {
  const [targetContactIds, setTargetContactIds] = useState([]);
  const [step, setStep] = useState(1);
  // 'NEW' = nový projekt, 'SOURCE' = ako v origináli (default pre úlohy)
  const defaultTarget = item.subtaskId ? 'SOURCE' : null;
  const [targetTaskId, setTargetTaskId] = useState(defaultTarget);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } počas batchu
  // Synchrónny guard proti dvojkliku — busy state sa prejaví až po re-renderi
  const submitRef = useRef(false);
  // Zastavenie batchu medzi iteráciami (tlačidlo „Zastaviť")
  const cancelRef = useRef(false);

  const contactId = (c) => c.id || c._id;
  const contactName = (cid) => contacts.find(c => contactId(c) === cid)?.name || 'kontakt';

  // Kontakty, ktoré UŽ majú kópiu tejto položky — každá kópia nesie
  // copiedFrom odkaz na zdroj (taskId + subtaskId), takže ich vieme nájsť
  // bez akéhokoľvek ďalšieho ukladania. V zozname sa označia „už má kópiu"
  // a nedajú sa zaškrtnúť — žiadne duplicitné kópie a user si nemusí
  // pamätať, kam už kopíroval. Kópia môže byť projekt aj vnorená úloha
  // (rekurzívny prechod); po zmazaní kópie sa kontakt sám sprístupní.
  const alreadyCopiedSet = useMemo(() => {
    const srcTaskId = item.taskId;
    const srcSubtaskId = item.subtaskId || null;
    const matches = (n) => n?.copiedFrom
      && n.copiedFrom.taskId === srcTaskId
      && (n.copiedFrom.subtaskId || null) === srcSubtaskId;
    const walk = (nodes) => (nodes || []).some(n => matches(n) || walk(n.subtasks));
    const set = new Set();
    for (const c of contacts) {
      if (walk(c.tasks)) set.add(contactId(c));
    }
    return set;
  }, [contacts, item.taskId, item.subtaskId]);
  const multi = targetContactIds.length > 1;
  const overLimit = targetContactIds.length > MAX_TARGETS;
  // Pri jednom cieli vieme ponúknuť aj konkrétny projekt daného kontaktu
  const singleContact = targetContactIds.length === 1
    ? contacts.find(c => contactId(c) === targetContactIds[0]) || null
    : null;
  // Pri viacerých cieľoch: úlohy „ako v origináli", projekty ako nový projekt
  const effectiveTargetTaskId = multi ? (item.subtaskId ? 'SOURCE' : 'NEW') : targetTaskId;

  const toggleContact = (cid) => {
    setTargetContactIds(prev =>
      prev.includes(cid) ? prev.filter(id => id !== cid) : [...prev, cid]
    );
    setTargetTaskId(defaultTarget); // zmena výberu kontaktov ruší voľbu projektu
  };

  const submit = async (mode) => {
    if (targetContactIds.length === 0 || overLimit || !effectiveTargetTaskId || busy || submitRef.current) return;
    if (mode === 'move' && multi) return; // presun = práve jeden cieľ
    const isNew = effectiveTargetTaskId === 'NEW';
    const isSource = effectiveTargetTaskId === 'SOURCE';
    // No-op: presun projektu „ako nový projekt" toho istého kontaktu
    if (mode === 'move' && isNew && !item.subtaskId && targetContactIds[0] === item.contactId) {
      alert('Projekt už patrí tomuto kontaktu.');
      return;
    }
    submitRef.current = true;
    cancelRef.current = false;
    setBusy(true);

    // Sekvenčne (nie paralelne) — limity plánu aj storage kvóta sa
    // vyhodnocujú per request a paralelný beh by ich vedel obísť.
    const targets = [...targetContactIds];
    const failedIds = [];       // definitívne zlyhania → dajú sa bezpečne zopakovať
    const failureMsgs = [];
    const unknownMsgs = [];     // timeout/409 → kópia MOŽNO vznikla, neopakovať naslepo
    let skippedFiles = 0;
    let ok = 0;
    let cancelled = 0;

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) { cancelled = targets.length - i; break; }
      setProgress({ done: i, total: targets.length });
      const cid = targets[i];
      try {
        const res = await api.post(`/api/contacts/${item.contactId}/tasks/${item.taskId}/transfer`, {
          subtaskId: item.subtaskId || undefined,
          targetContactId: cid,
          targetTaskId: (isNew || isSource) ? undefined : effectiveTargetTaskId,
          // „Ako v origináli" — server nájde/vytvorí kópiu zdrojového projektu
          preserveProject: isSource || undefined,
          mode
        });
        ok++;
        skippedFiles += res.data?.skippedFiles || 0;
      } catch (error) {
        // Bez odpovede (timeout/sieť) alebo 409 (idempotencia) = server mohol
        // kópiu dokončiť aj tak — NEZARADIŤ do retry výberu, inak duplikát.
        if (!error.response || error.response.status === 409) {
          unknownMsgs.push(`${contactName(cid)}: neznámy výsledok — skontrolujte kontakt pred opakovaním`);
        } else {
          failedIds.push(cid);
          failureMsgs.push(`${contactName(cid)}: ${error.response?.data?.message || 'zlyhalo'}`);
        }
      }
    }

    setProgress(null);
    submitRef.current = false;

    // Súhrn — časti sa SČÍTAVAJÚ (skippedFiles nesmie zaniknúť pri zlyhaní)
    const parts = [];
    if (ok > 0 && (multi || failureMsgs.length > 0 || unknownMsgs.length > 0 || cancelled > 0)) {
      parts.push(`Hotovo pre ${ok} ${kontaktSklon(ok)}.`);
    }
    if (skippedFiles > 0) {
      parts.push(`⚠️ ${skippedFiles} príloh sa nepodarilo skopírovať.`);
    }
    if (failureMsgs.length > 0) {
      parts.push(`Nepodarilo sa:\n${failureMsgs.join('\n')}`);
    }
    if (unknownMsgs.length > 0) {
      parts.push(`⚠️ ${unknownMsgs.join('\n')}`);
    }
    if (cancelled > 0) {
      parts.push(`Zastavené — ${cancelled} ${kontaktSklon(cancelled)} sa nespracovalo (ostávajú vybrané).`);
    }
    if (parts.length > 0) alert(parts.join('\n\n'));

    const remaining = [
      ...failedIds,
      ...(cancelled > 0 ? targets.slice(targets.length - cancelled) : [])
    ];
    if (remaining.length === 0) {
      // Čisto (prípadne s unknown, ktoré sa opakovať nemajú) → zavri + refresh
      onDone();
    } else {
      // Zúž výber na neúspešné/nespracované ciele — dajú sa zopakovať bez
      // duplikovania úspešných; parent listy medzitým obnovíme bez zavretia.
      setTargetContactIds(remaining);
      setStep(1);
      setBusy(false);
      if (ok > 0) onRefresh?.();
    }
  };

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal-content" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{item.subtaskId ? 'Kopírovať / presunúť úlohu' : 'Kopírovať / presunúť projekt'}</h3>
          <button className="modal-close" onClick={onClose} disabled={busy}>×</button>
        </div>
        <div className="modal-body">
          <p className="duplicate-info">
            <strong>{item.title}</strong>
          </p>

          {busy && progress && (
            <p style={{ fontSize: 13, color: 'var(--accent-color, #6366f1)', margin: '0 0 8px' }}>
              ⏳ Kopírujem… ({progress.done + 1}/{progress.total})
            </p>
          )}

          {step === 1 ? (
            <div className="form-group">
              <label>Krok 1/2 — vyber cieľové kontakty (max {MAX_TARGETS} naraz)</label>
              <div className="multi-select-contacts">
                {contacts.map(c => {
                  const cid = contactId(c);
                  const alreadyCopied = alreadyCopiedSet.has(cid);
                  return (
                    <label
                      key={cid}
                      className="contact-checkbox"
                      style={alreadyCopied ? { opacity: 0.55, cursor: 'default' } : undefined}
                      title={alreadyCopied ? 'Tento kontakt už má kópiu tejto položky' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={alreadyCopied || targetContactIds.includes(cid)}
                        onChange={() => toggleContact(cid)}
                        disabled={busy || alreadyCopied}
                      />
                      <span>
                        {c.name || '(bez mena)'} {c.company ? `(${c.company})` : ''}
                        {cid === item.contactId ? ' — aktuálny kontakt' : ''}
                        {alreadyCopied ? ' — ✓ už má kópiu' : ''}
                      </span>
                    </label>
                  );
                })}
                {contacts.length === 0 && (
                  <span className="no-contacts">Žiadne kontakty</span>
                )}
              </div>
              {overLimit && (
                <p style={{ fontSize: 12, color: 'var(--danger, #ef4444)', margin: '6px 0 0' }}>
                  Naraz sa dá kopírovať najviac do {MAX_TARGETS} kontaktov — odznačte {targetContactIds.length - MAX_TARGETS}.
                </p>
              )}
            </div>
          ) : (
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="btn-icon-sm"
                  onClick={() => { setStep(1); setTargetTaskId(defaultTarget); }}
                  disabled={busy}
                  title="Späť na výber kontaktov"
                >
                  ←
                </button>
                {multi
                  ? `Krok 2/2 — ${targetContactIds.length} vybraných ${kontaktSklon(targetContactIds.length)}`
                  : `Krok 2/2 — kam v kontakte „${singleContact?.name || ''}"?`}
              </label>

              {multi ? (
                item.subtaskId ? (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                    Vloží sa <strong>ako v origináli</strong> — v každom vybranom
                    kontakte pod projekt „{item.sourceTaskTitle || 'zdrojový projekt'}"
                    (ak tam jeho kópia ešte nie je, vytvorí sa).
                  </p>
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                    Vloží sa ako <strong>nový projekt</strong> do každého z vybraných
                    kontaktov (každý má vlastné projekty, spoločný cieľ neexistuje).
                  </p>
                )
              ) : (
                <div className="multi-select-contacts">
                  {item.subtaskId && (
                    <label className="contact-checkbox">
                      <input
                        type="radio"
                        name="transfer-target"
                        checked={targetTaskId === 'SOURCE'}
                        onChange={() => setTargetTaskId('SOURCE')}
                        disabled={busy}
                      />
                      <span>🗂️ Ako v origináli — pod projekt „{item.sourceTaskTitle || 'zdrojový projekt'}"</span>
                    </label>
                  )}
                  <label className="contact-checkbox">
                    <input
                      type="radio"
                      name="transfer-target"
                      checked={targetTaskId === 'NEW'}
                      onChange={() => setTargetTaskId('NEW')}
                      disabled={busy}
                    />
                    <span>➕ Ako nový projekt</span>
                  </label>
                  {(singleContact?.tasks || [])
                    // Projekt nemožno vložiť do seba samého
                    .filter(t => !(targetContactIds[0] === item.contactId && !item.subtaskId && t.id === item.taskId))
                    .map(t => (
                      <label key={t.id} className="contact-checkbox">
                        <input
                          type="radio"
                          name="transfer-target"
                          checked={targetTaskId === t.id}
                          onChange={() => setTargetTaskId(t.id)}
                          disabled={busy}
                        />
                        <span>{t.completed ? '✅ ' : ''}{t.title}</span>
                      </label>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {busy ? (
            <button
              className="btn btn-secondary"
              onClick={() => { cancelRef.current = true; }}
              title="Dokončí prebiehajúci kontakt a zastaví zvyšok"
            >
              ⏹ Zastaviť
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={onClose}>Zrušiť</button>
          )}
          {step === 1 ? (
            <button
              className="btn btn-primary"
              onClick={() => setStep(2)}
              disabled={busy || targetContactIds.length === 0 || overLimit}
            >
              Pokračovať →
            </button>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => submit('move')}
                disabled={busy || !effectiveTargetTaskId || multi}
                title={multi
                  ? 'Presunúť sa dá len do jedného kontaktu — položka sa premiestňuje, nekopíruje'
                  : 'Položka sa premiestni — u pôvodného kontaktu zmizne'}
              >
                {busy ? '⏳' : '➡️'} Presunúť
              </button>
              <button
                className="btn btn-primary"
                onClick={() => submit('copy')}
                disabled={busy || !effectiveTargetTaskId}
                title="Vytvorí sa nezávislá kópia vrátane príloh"
              >
                {busy ? '⏳' : '📋'} Kopírovať{multi ? ` (${targetContactIds.length}×)` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default TaskTransferModal;
