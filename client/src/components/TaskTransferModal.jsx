import { useState } from 'react';
import api from '../api/api';

/**
 * Modal na kopírovanie / presun projektu alebo úlohy do projektového stromu
 * iného kontaktu v rámci aktuálneho prostredia. Dvojkrokový výber:
 * 1) cieľový kontakt → 2) cieľový projekt (alebo „ako nový projekt"),
 * potom voľba akcie Kopírovať / Presunúť.
 *
 * item = { contactId, taskId, subtaskId?, title }
 *  - subtaskId chýba → prenáša sa celý projekt (taskId)
 *  - subtaskId zadané → prenáša sa úloha/podúloha (nájde sa rekurzívne)
 */
function TaskTransferModal({ item, contacts, onClose, onDone }) {
  const [targetContactId, setTargetContactId] = useState(null);
  const [targetTaskId, setTargetTaskId] = useState(null); // 'NEW' = nový projekt
  const [busy, setBusy] = useState(false);

  const targetContact = contacts.find(c => (c.id || c._id) === targetContactId) || null;

  const submit = async (mode) => {
    if (!targetContactId || !targetTaskId || busy) return;
    const isNew = targetTaskId === 'NEW';
    // No-op: presun projektu "ako nový projekt" toho istého kontaktu
    if (mode === 'move' && isNew && !item.subtaskId && targetContactId === item.contactId) {
      alert('Projekt už patrí tomuto kontaktu.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post(`/api/contacts/${item.contactId}/tasks/${item.taskId}/transfer`, {
        subtaskId: item.subtaskId || undefined,
        targetContactId,
        targetTaskId: isNew ? undefined : targetTaskId,
        mode
      });
      if (res.data?.skippedFiles > 0) {
        alert(`Hotovo, ale ${res.data.skippedFiles} príloh sa nepodarilo skopírovať.`);
      }
      onDone();
    } catch (error) {
      alert(error.response?.data?.message || 'Operácia zlyhala');
      setBusy(false);
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

          {!targetContact ? (
            <div className="form-group">
              <label>Krok 1/2 — vyber cieľový kontakt</label>
              <div className="multi-select-contacts">
                {contacts.map(c => {
                  const cid = c.id || c._id;
                  return (
                    <button
                      key={cid}
                      type="button"
                      className="btn btn-secondary"
                      style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }}
                      onClick={() => { setTargetContactId(cid); setTargetTaskId(null); }}
                    >
                      {c.name || '(bez mena)'} {c.company ? `(${c.company})` : ''}
                      {cid === item.contactId ? ' — aktuálny kontakt' : ''}
                    </button>
                  );
                })}
                {contacts.length === 0 && (
                  <span className="no-contacts">Žiadne kontakty</span>
                )}
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="btn-icon-sm"
                  onClick={() => { setTargetContactId(null); setTargetTaskId(null); }}
                  disabled={busy}
                  title="Späť na výber kontaktu"
                >
                  ←
                </button>
                Krok 2/2 — kam v kontakte „{targetContact.name}"?
              </label>
              <div className="multi-select-contacts">
                <label className="contact-checkbox">
                  <input
                    type="radio"
                    name="transfer-target"
                    checked={targetTaskId === 'NEW'}
                    onChange={() => setTargetTaskId('NEW')}
                  />
                  <span>➕ Ako nový projekt</span>
                </label>
                {(targetContact.tasks || [])
                  // Projekt nemožno vložiť do seba samého
                  .filter(t => !(targetContactId === item.contactId && !item.subtaskId && t.id === item.taskId))
                  .map(t => (
                    <label key={t.id} className="contact-checkbox">
                      <input
                        type="radio"
                        name="transfer-target"
                        checked={targetTaskId === t.id}
                        onChange={() => setTargetTaskId(t.id)}
                      />
                      <span>{t.completed ? '✅ ' : ''}{t.title}</span>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Zrušiť</button>
          <button
            className="btn btn-secondary"
            onClick={() => submit('move')}
            disabled={busy || !targetTaskId}
            title="Položka sa premiestni — u pôvodného kontaktu zmizne"
          >
            {busy ? '⏳' : '➡️'} Presunúť
          </button>
          <button
            className="btn btn-primary"
            onClick={() => submit('copy')}
            disabled={busy || !targetTaskId}
            title="Vytvorí sa nezávislá kópia vrátane príloh"
          >
            {busy ? '⏳' : '📋'} Kopírovať
          </button>
        </div>
      </div>
    </div>
  );
}

export default TaskTransferModal;
