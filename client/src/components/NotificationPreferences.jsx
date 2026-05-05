import { useEffect, useState, useCallback } from 'react';
import api from '../api/api';

/**
 * Modal pre nastavenie push notifikácií.
 *
 * Direct notifikácie (priradenia, dokončenie mojej priradenej úlohy
 * niekým iným, správa pre mňa) sa nedajú vypnúť — vždy idú push.
 * General notifikácie (cudzie zmeny, termíny, po termíne, nový člen)
 * majú per-toggle opt-in. Default je všade OFF — anti-spam.
 */
const PREF_LABELS = {
  pushTeamActivity: {
    title: 'Aktivita tímu',
    desc: 'Push, keď kolegovia upravujú/vytvárajú/dokončujú projekty, úlohy a kontakty, ktoré sa ťa priamo netýkajú.'
  },
  pushDeadlines: {
    title: 'Pripomienky termínov',
    desc: 'Push 7 / 3 dni / v deň termínu pre tvoje projekty a úlohy.'
  },
  pushOverdue: {
    title: 'Po termíne',
    desc: 'Push, keď úloha s termínom prebehla bez dokončenia.'
  },
  pushNewMember: {
    title: 'Nový člen workspace',
    desc: 'Push, keď do tvojho workspace pribudne nový kolega.'
  }
};

const DEFAULT_PREFS = {
  pushTeamActivity: false,
  pushDeadlines: false,
  pushOverdue: false,
  pushNewMember: false,
  // Email-channel opt-out for marketing reminders (T-7, T-1, winback).
  // Default true = opt-in by default; user may disable here or via the
  // 1-click unsubscribe link in any reminder email footer. Transactional
  // emails (plan changes, password reset) ignore this flag.
  marketingEmails: true
};

export default function NotificationPreferences({ onClose }) {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/api/auth/notification-preferences')
      .then(res => { if (alive) setPrefs({ ...DEFAULT_PREFS, ...res.data }); })
      .catch(() => { if (alive) setError('Nepodarilo sa načítať nastavenia'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const toggle = useCallback(async (key) => {
    const next = !prefs[key];
    setSaving(key);
    setError(null);
    // Optimistic update
    setPrefs(prev => ({ ...prev, [key]: next }));
    try {
      const res = await api.put('/api/auth/notification-preferences', { [key]: next });
      setPrefs({ ...DEFAULT_PREFS, ...res.data });
    } catch {
      // rollback
      setPrefs(prev => ({ ...prev, [key]: !next }));
      setError('Nepodarilo sa uložiť. Skús znova.');
    } finally {
      setSaving(null);
    }
  }, [prefs]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content notif-prefs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🔔 Nastavenia notifikácií</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="notif-prefs-body">
          {/* Direct sekcia — informačná, nedá sa vypnúť */}
          <div className="notif-prefs-section">
            <h3>📌 Priradené mne</h3>
            <p className="notif-prefs-section-desc">
              Notifikácie, ktoré si pýtajú tvoju pozornosť — priradenie projektu/úlohy/podúlohy,
              dokončenie tvojej priradenej úlohy iným kolegom, správa pre teba.
              <strong> Tieto sa vždy ukladajú a vždy chodia push.</strong> Nedajú sa vypnúť.
            </p>
          </div>

          {/* General sekcia — per-toggle opt-in */}
          <div className="notif-prefs-section">
            <h3>⚪ Všeobecné notifikácie</h3>
            <p className="notif-prefs-section-desc">
              Default sú vypnuté. Notifikácie sa stále zaznamenávajú v zvončeku — push na telefón
              príde len pre kategórie, ktoré si zapneš nižšie.
            </p>

            {loading ? (
              <div className="notif-prefs-loading">Načítavam...</div>
            ) : (
              <div className="notif-prefs-toggles">
                {Object.keys(PREF_LABELS).map(key => {
                  const meta = PREF_LABELS[key];
                  const checked = !!prefs[key];
                  const isSaving = saving === key;
                  return (
                    <label key={key} className={`notif-prefs-toggle ${isSaving ? 'saving' : ''}`}>
                      <div className="notif-prefs-toggle-text">
                        <div className="notif-prefs-toggle-title">{meta.title}</div>
                        <div className="notif-prefs-toggle-desc">{meta.desc}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSaving}
                        onChange={() => toggle(key)}
                      />
                    </label>
                  );
                })}
              </div>
            )}

            {error && <div className="notif-prefs-error">{error}</div>}
          </div>

          {/* Email channel — marketing pripomienky o predplatnom */}
          <div className="notif-prefs-section">
            <h3>📧 Emaily o predplatnom</h3>
            <p className="notif-prefs-section-desc">
              Pripomienky pred expiráciou plánu (7 dní vopred, 1 deň vopred), špeciálne ponuky a marketingové novinky.
              <strong> Transakčné emaily</strong> (zmena plánu, zľava, obnova hesla) chodia vždy bez ohľadu na toto nastavenie.
            </p>
            {!loading && (
              <div className="notif-prefs-toggles">
                <label className={`notif-prefs-toggle ${saving === 'marketingEmails' ? 'saving' : ''}`}>
                  <div className="notif-prefs-toggle-text">
                    <div className="notif-prefs-toggle-title">Pripomienky a marketingové ponuky</div>
                    <div className="notif-prefs-toggle-desc">
                      Zľavy pred expiráciou, winback ponuky, novinky.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!prefs.marketingEmails}
                    disabled={saving === 'marketingEmails'}
                    onChange={() => toggle('marketingEmails')}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="notif-prefs-footer-note">
            História notifikácií je obmedzená na 150 najnovších záznamov — staršie sa
            automaticky odstraňujú.
          </div>
        </div>
      </div>
    </div>
  );
}
