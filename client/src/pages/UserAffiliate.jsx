import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import UserMenu from '../components/UserMenu';
import HeaderLogo from '../components/HeaderLogo';
import NotificationBell from '../components/NotificationBell';

/**
 * UserAffiliate — page pre prihláseného affiliateho s prehľadom vlastných
 * provízií, kódov, a možnosťou nastaviť bank info na výplatu.
 *
 * Iba pre enrolled affiliateov — server endpoint /api/affiliate/me vráti
 * 403 AFFILIATE_NOT_ENROLLED pre ostatných. UI zobrazí upozornenie.
 */

const STATUS_META = {
  pending:  { label: '⏳ Čaká', color: '#92400e', bg: '#fef3c7' },
  eligible: { label: '✅ Pripravené', color: '#065f46', bg: '#d1fae5' },
  paid:     { label: '💳 Vyplatené', color: '#1e40af', bg: '#dbeafe' },
  revoked:  { label: '❌ Zrušené', color: '#991b1b', bg: '#fee2e2' }
};

const fmtEur = (n) => `€${(n || 0).toFixed(2)}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';

function UserAffiliate() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingPayout, setEditingPayout] = useState(false);
  const [payoutIban, setPayoutIban] = useState('');
  const [payoutBank, setPayoutBank] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [savingPayout, setSavingPayout] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/affiliate/me');
      setData(r.data);
      setPayoutIban(r.data.affiliate?.payoutIban || '');
      setPayoutBank(r.data.affiliate?.payoutBankName || '');
      setPayoutNote(r.data.affiliate?.payoutNote || '');
    } catch (err) {
      setError(err.response?.data || { message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const savePayout = async () => {
    setSavingPayout(true);
    setPayoutMessage('');
    try {
      await api.put('/api/affiliate/payout-info', {
        payoutIban: payoutIban.trim(),
        payoutBankName: payoutBank.trim(),
        payoutNote: payoutNote.trim()
      });
      setEditingPayout(false);
      setPayoutMessage('✅ Údaje uložené');
      await load();
      setTimeout(() => setPayoutMessage(''), 3000);
    } catch (err) {
      setPayoutMessage(err.response?.data?.message || 'Chyba');
    } finally {
      setSavingPayout(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Načítavam...</div>
    );
  }

  // Not enrolled — show CTA to contact admin
  if (error && error.code === 'AFFILIATE_NOT_ENROLLED') {
    return (
      <div className="crm-container">
        <header className="crm-header">
          <div className="crm-header-left"><HeaderLogo /></div>
          <div className="crm-header-right">
            <NotificationBell />
            <UserMenu user={user} onLogout={logout} onUpdateUser={updateUser} />
          </div>
        </header>
        <div style={{ maxWidth: 600, margin: '60px auto', padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🤝</div>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Affiliate program</h1>
          <p style={{ color: '#64748b', marginBottom: 24, lineHeight: 1.6 }}>
            Nie ste prihlásený v affiliate programe. Ak máte záujem získať provízie
            za priateľov ktorých privediete do Prpl CRM, napíšte nám na{' '}
            <a href="mailto:support@prplcrm.eu" style={{ color: '#6D28D9' }}>support@prplcrm.eu</a>.
          </p>
          <button onClick={() => navigate('/app')} className="btn btn-primary">← Späť do aplikácie</button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: '#dc2626' }}>
        Chyba: {error.message || 'Nepodarilo sa načítať dáta'}
        <button onClick={load} className="btn btn-secondary" style={{ marginLeft: 12 }}>Skúsiť znova</button>
      </div>
    );
  }

  if (!data) return null;

  const { affiliate, totals, counts, codes, recentCommissions } = data;

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left"><HeaderLogo /></div>
        <div className="crm-header-right">
          <button className="btn btn-secondary" onClick={() => navigate('/app')}>← Späť</button>
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUpdateUser={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <main className="crm-main" style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
          <h1 style={{ fontSize: 24, marginBottom: 4 }}>🤝 Môj affiliate program</h1>
          <p style={{ color: '#64748b', fontSize: 14, marginBottom: 24 }}>
            Prihlásený od {fmtDate(affiliate?.enrolledAt)} · Status: <strong>{affiliate?.status || 'active'}</strong>
          </p>

          {/* STAT CARDS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
            <StatCard label="Čaká (refund window)" amount={totals.pending} count={counts.pending} color="#92400e" bg="#fef3c7" />
            <StatCard label="Pripravené na výplatu" amount={totals.eligible} count={counts.eligible} color="#065f46" bg="#d1fae5" highlight />
            <StatCard label="Vyplatené (celkom)" amount={totals.paid} count={counts.paid} color="#1e40af" bg="#dbeafe" />
            {counts.revoked > 0 && (
              <StatCard label="Zrušené" amount={totals.revoked} count={counts.revoked} color="#991b1b" bg="#fee2e2" />
            )}
          </div>

          {/* PAYOUT INFO */}
          <section style={{ background: 'var(--bg-secondary, #f8fafc)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 18, margin: 0 }}>💳 Bankové údaje pre výplatu</h2>
              {!editingPayout && (
                <button onClick={() => setEditingPayout(true)} className="btn btn-secondary" style={{ fontSize: 12 }}>
                  Upraviť
                </button>
              )}
            </div>
            {editingPayout ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="text" placeholder="IBAN" value={payoutIban}
                  onChange={(e) => setPayoutIban(e.target.value)} className="form-input" />
                <input type="text" placeholder="Názov banky" value={payoutBank}
                  onChange={(e) => setPayoutBank(e.target.value)} className="form-input" />
                <input type="text" placeholder="Poznámka (DIČ, kontakt...)" value={payoutNote}
                  onChange={(e) => setPayoutNote(e.target.value)} className="form-input"
                  style={{ gridColumn: '1 / 3' }} />
                <div style={{ gridColumn: '1 / 3', display: 'flex', gap: 8 }}>
                  <button onClick={savePayout} disabled={savingPayout} className="btn btn-primary">
                    {savingPayout ? 'Ukladám...' : 'Uložiť'}
                  </button>
                  <button onClick={() => { setEditingPayout(false); load(); }} className="btn btn-secondary">Zrušiť</button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 14, lineHeight: 1.8 }}>
                <div><strong>IBAN:</strong> {affiliate?.payoutIban || <span style={{ color: '#dc2626' }}>nevyplnené</span>}</div>
                <div><strong>Banka:</strong> {affiliate?.payoutBankName || '—'}</div>
                {affiliate?.payoutNote && <div><strong>Poznámka:</strong> {affiliate.payoutNote}</div>}
              </div>
            )}
            {payoutMessage && <div style={{ marginTop: 8, fontSize: 13 }}>{payoutMessage}</div>}
          </section>

          {/* CODES */}
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>🎟️ Moje promo kódy ({codes.length})</h2>
            {codes.length === 0 ? (
              <div style={{ padding: 24, background: 'var(--bg-secondary, #f8fafc)', borderRadius: 8, textAlign: 'center', color: '#64748b' }}>
                Zatiaľ ti admin nevytvoril žiadne kódy. Napíš na <a href="mailto:support@prplcrm.eu">support@prplcrm.eu</a>.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="sa-table" style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Kód</th>
                      <th>Zľava</th>
                      <th>Tvoja provízia</th>
                      <th>Použitia</th>
                      <th>Vyprší</th>
                      <th>Aktívny</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map((c) => {
                      const discount = c.type === 'percentage' ? `${c.value}%`
                        : c.type === 'fixed' ? `€${c.value}`
                        : c.type === 'freeMonths' ? `${c.value} mes.` : `${c.value}`;
                      return (
                        <tr key={c._id}>
                          <td><code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{c.code}</code></td>
                          <td>{discount}</td>
                          <td style={{ fontWeight: 600, color: '#10b981' }}>{c.commissionPercent}%</td>
                          <td>{c.usedCount} / {c.maxUses || '∞'}</td>
                          <td>{c.expiresAt ? fmtDate(c.expiresAt) : '—'}</td>
                          <td>{c.isActive ? '✅' : '❌'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* RECENT COMMISSIONS */}
          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>💰 Posledné provízie</h2>
            {recentCommissions.length === 0 ? (
              <div style={{ padding: 24, background: 'var(--bg-secondary, #f8fafc)', borderRadius: 8, textAlign: 'center', color: '#64748b' }}>
                Zatiaľ žiadne provízie. Provízie sa generujú pri každej úspešnej platbe pod tvojimi kódmi.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="sa-table" style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Dátum</th>
                      <th>Kód</th>
                      <th>Customer</th>
                      <th>Platba</th>
                      <th>Provízia</th>
                      <th>Status</th>
                      <th>Dostupné od</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCommissions.map((c) => {
                      const meta = STATUS_META[c.status] || { label: c.status, color: '#64748b', bg: '#f3f4f6' };
                      return (
                        <tr key={c._id}>
                          <td>{fmtDate(c.paymentDate)}</td>
                          <td><code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{c.promoCodeId?.code || '—'}</code></td>
                          <td>{c.referredUserId?.username || '—'}</td>
                          <td>{fmtEur(c.paymentAmount)}</td>
                          <td style={{ fontWeight: 600, color: '#10b981' }}>{fmtEur(c.commissionAmount)}</td>
                          <td>
                            <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: meta.bg, color: meta.color }}>
                              {meta.label}
                            </span>
                          </td>
                          <td>{c.status === 'paid' ? fmtDate(c.paidAt) : fmtDate(c.eligibleAfter)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* INFO BOX */}
          <section style={{ marginTop: 24, padding: 16, background: '#f0f9ff', borderLeft: '4px solid #0284c7', borderRadius: 4, fontSize: 13, lineHeight: 1.6 }}>
            <strong>ℹ️ Ako to funguje:</strong>
            <ul style={{ margin: '8px 0 0 20px' }}>
              <li>Provízia sa generuje pri <strong>každej platbe</strong> pod tvojím kódom (recurring).</li>
              <li><strong>Čaká</strong> → 30 dní refund window (zákazník môže žiadať refund)</li>
              <li><strong>Pripravené</strong> → admin ti vyplatí bankovým prevodom</li>
              <li>Minimum payout: <strong>€20</strong> — provízie kumulujú do dosiahnutia tejto sumy</li>
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}

function StatCard({ label, amount, count, color, bg, highlight }) {
  return (
    <div style={{
      padding: 16, borderRadius: 12, background: bg, border: highlight ? `2px solid ${color}` : '1px solid #e5e7eb'
    }}>
      <div style={{ fontSize: 12, color, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{fmtEur(amount)}</div>
      <div style={{ fontSize: 11, color: '#64748b' }}>{count}× provízia</div>
    </div>
  );
}

export default UserAffiliate;
