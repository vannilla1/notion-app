import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api, { API_BASE_URL } from '../api/api';
import { useAuth } from '../context/AuthContext';
import HeaderLogo from '../components/HeaderLogo';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import NotificationBell from '../components/NotificationBell';
import UserMenu from '../components/UserMenu';
import { useWorkspace } from '../context/WorkspaceContext';
import { formatFileSize } from '../utils/constants';
import { alertUnlessPlanGate } from '../utils/planGate';

/**
 * Prílohy — prehľad všetkých príloh workspace-u a ich hromadné stiahnutie
 * ako ZIP naprieč kontaktmi aj projektami.
 *
 * Sťahovanie ide dvojkrokovo: POST /export overí výber a vráti jednorazový
 * odkaz, ktorý sa otvorí navigáciou. Zámerne NIE cez axios blob — 60 s
 * timeout by veľký ZIP zabil a blob by zbytočne tiekol cez pamäť prehliadača.
 */
export default function Attachments() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [limits, setLimits] = useState({ maxZipBytes: 200 * 1024 * 1024, maxZipFiles: 500 });
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [contactFilter, setContactFilter] = useState(searchParams.get('contactId') || '');
  const [taskFilter, setTaskFilter] = useState('');

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/attachments');
      setItems(res.data?.items || []);
      if (res.data?.limits) setLimits(res.data.limits);
    } catch (error) {
      alertUnlessPlanGate(error, 'Nepodarilo sa načítať prílohy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems, currentWorkspace?.id]);

  // Zoznamy pre filtre — z reálnych dát, nie zo samostatných dotazov
  const contacts = useMemo(() => {
    const m = new Map();
    items.forEach(i => { if (i.contactId) m.set(i.contactId, i.contactName || 'Kontakt'); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sk'));
  }, [items]);

  const tasks = useMemo(() => {
    const m = new Map();
    items
      .filter(i => !contactFilter || i.contactId === contactFilter)
      .forEach(i => { if (i.taskId) m.set(i.taskId, i.taskTitle || 'Projekt'); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sk'));
  }, [items, contactFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (contactFilter && i.contactId !== contactFilter) return false;
      if (taskFilter && i.taskId !== taskFilter) return false;
      if (!q) return true;
      return [i.name, i.contactName, i.taskTitle, ...(i.trail || [])]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    });
  }, [items, search, contactFilter, taskFilter]);

  const selectedItems = useMemo(
    () => filtered.filter(i => selected.has(i.fileId)),
    [filtered, selected]
  );
  const selectedBytes = selectedItems.reduce((s, i) => s + (i.size || 0), 0);
  const overLimit = selectedBytes > limits.maxZipBytes || selectedItems.length > limits.maxZipFiles;
  const allFilteredSelected = filtered.length > 0 && filtered.every(i => selected.has(i.fileId));

  const toggle = (fileId) => setSelected(prev => {
    const next = new Set(prev);
    next.has(fileId) ? next.delete(fileId) : next.add(fileId);
    return next;
  });

  const toggleAllFiltered = () => setSelected(prev => {
    const next = new Set(prev);
    if (allFilteredSelected) filtered.forEach(i => next.delete(i.fileId));
    else filtered.forEach(i => next.add(i.fileId));
    return next;
  });

  const download = async () => {
    if (selectedItems.length === 0 || preparing) return;
    setPreparing(true);
    try {
      const res = await api.post('/api/attachments/export', {
        fileIds: selectedItems.map(i => i.fileId)
      });
      // Navigácia, nie axios blob — prehliadač si ZIP stiahne natívne
      // s vlastným progresom a bez 60 s stropu.
      window.location.href = `${API_BASE_URL}${res.data.downloadPath}`;
    } catch (error) {
      alertUnlessPlanGate(error, 'Sťahovanie sa nepodarilo pripraviť');
    } finally {
      setPreparing(false);
    }
  };

  const totalBytes = items.reduce((s, i) => s + (i.size || 0), 0);

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary btn-nav-contacts" onClick={() => navigate('/crm')}>Kontakty</button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>Projekty</button>
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUserUpdate={updateUser} />
        </div>
      </header>

      <main className="crm-main">
        <div className="tasks-header">
          <div className="tasks-header-top">
            <h2>Prílohy ({filtered.length}{filtered.length !== items.length ? ` z ${items.length}` : ''})</h2>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Spolu {formatFileSize(totalBytes)}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <input
              type="text"
              placeholder="Hľadať v názvoch…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: '1 1 220px', minWidth: 180 }}
            />
            <select value={contactFilter} onChange={(e) => { setContactFilter(e.target.value); setTaskFilter(''); }}>
              <option value="">Všetky kontakty</option>
              {contacts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
              <option value="">Všetky projekty</option>
              {tasks.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
            {(search || contactFilter || taskFilter) && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setSearch(''); setContactFilter(''); setTaskFilter(''); }}>
                × Zrušiť filtre
              </button>
            )}
          </div>
        </div>

        {/* Lišta výberu — sticky, nech je tlačidlo po ruke aj pri dlhom zozname */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 14px', margin: '12px 0',
          background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} disabled={filtered.length === 0} />
            <span>Vybrať všetko{filtered.length !== items.length ? ' (filtrované)' : ''}</span>
          </label>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Vybrané: <strong>{selectedItems.length}</strong> · {formatFileSize(selectedBytes)}
          </span>
          {overLimit && (
            <span style={{ color: 'var(--danger, #ef4444)', fontSize: 13 }}>
              Nad limit ({formatFileSize(limits.maxZipBytes)} / {limits.maxZipFiles} súborov) — zúžte výber.
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {selected.size > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())}>Zrušiť výber</button>
            )}
            <button
              className="btn btn-primary"
              onClick={download}
              disabled={selectedItems.length === 0 || overLimit || preparing}
            >
              {preparing ? 'Pripravujem…' : `⬇ Stiahnuť ZIP (${selectedItems.length})`}
            </button>
          </div>
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Načítavam prílohy…</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>
            {items.length === 0 ? 'Zatiaľ tu nie sú žiadne prílohy.' : 'Filtru nezodpovedá žiadna príloha.'}
          </p>
        ) : (
          <div className="table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ width: 36, padding: '8px 6px' }}></th>
                  <th style={{ padding: '8px 6px' }}>Súbor</th>
                  <th style={{ padding: '8px 6px' }}>Kontakt</th>
                  <th style={{ padding: '8px 6px' }}>Projekt / úloha</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Veľkosť</th>
                  <th style={{ padding: '8px 6px' }}>Nahraté</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(i => (
                  <tr
                    key={i.fileId}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                    onClick={() => toggle(i.fileId)}
                  >
                    <td style={{ padding: '8px 6px' }}>
                      <input
                        type="checkbox"
                        checked={selected.has(i.fileId)}
                        onChange={() => toggle(i.fileId)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td style={{ padding: '8px 6px', wordBreak: 'break-word' }}>{i.name}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-secondary)' }}>{i.contactName || '—'}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-secondary)' }}>
                      {i.taskTitle || '—'}
                      {(i.trail || []).length > 0 && (
                        <span style={{ color: 'var(--text-muted)' }}> / {i.trail.join(' / ')}</span>
                      )}
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatFileSize(i.size || 0)}</td>
                    <td style={{ padding: '8px 6px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {i.uploadedAt ? new Date(i.uploadedAt).toLocaleDateString('sk-SK') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
