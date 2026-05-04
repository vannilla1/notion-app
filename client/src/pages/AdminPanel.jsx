import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import adminApi, { API_BASE_URL } from '@/api/adminApi';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import AdminHelpToggle from '../components/AdminHelpToggle';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

const TABS = [
  { id: 'overview', label: 'Prehľad', icon: '📊' },
  { id: 'diagnostics', label: 'Diagnostika', icon: '🔬' },
  { id: 'users', label: 'Používatelia', icon: '👥' },
  { id: 'workspaces', label: 'Workspace-y', icon: '🏢' },
  { id: 'charts', label: 'Grafy', icon: '📈' },
  { id: 'activity', label: 'Aktivita', icon: '⚡' },
  { id: 'api', label: 'API', icon: '🔌' },
  { id: 'storage', label: 'Storage', icon: '💾' },
  { id: 'comparison', label: 'Porovnanie', icon: '⚖️' },
  { id: 'promo', label: 'Promo kódy', icon: '🎟️' },
  { id: 'audit', label: 'Audit log', icon: '📋' },
  { id: 'sync', label: 'Sync', icon: '🔄' }
];

// Valid tab IDs — použité na validáciu URL hash pri boot-e, aby manipulácia
// s URL (napr. ?foo=bar#fake) nenastavila neznámy tab a render nepadol.
const VALID_TAB_IDS = new Set([
  'overview', 'diagnostics', 'users', 'workspaces', 'charts', 'activity',
  'api', 'storage', 'comparison', 'promo', 'audit', 'sync'
]);

// Povolené sub-filtre pre Sync tab. Rozlišujú, ktorú Google službu chceme
// zobraziť — Calendar/Tasks majú síce spoločný backend endpoint, ale karty
// v Prehľade vedú každá na vlastný filter.
const VALID_SYNC_FILTERS = new Set(['calendar', 'tasks']);

// Persistencia aktívneho tabu cez URL hash (#users, #diagnostics,
// #sync, #sync/calendar, #sync/tasks).
// Hash preferujeme pred localStorage: je bookmarkovateľný, zdieľateľný
// a prežije refresh bez ďalšieho state managementu.
function parseHash() {
  if (typeof window === 'undefined') return { tab: 'overview', filter: null };
  const raw = (window.location.hash || '').replace(/^#/, '');
  const [tab, sub] = raw.split('/');
  if (!VALID_TAB_IDS.has(tab)) return { tab: 'overview', filter: null };
  const filter = tab === 'sync' && VALID_SYNC_FILTERS.has(sub) ? sub : null;
  return { tab, filter };
}

function AdminPanel() {
  const navigate = useNavigate();
  const initial = parseHash();
  const [activeTab, setActiveTab] = useState(initial.tab);
  const [syncFilter, setSyncFilter] = useState(initial.filter);

  // Helper — navigácia z kariet v Prehľade. Prijíma (tab, filter?) — filter
  // je relevantný iba pre 'sync'. Overview card pre Google Calendar volá
  // ('sync', 'calendar'), pre Google Tasks ('sync', 'tasks').
  const handleNavigate = useCallback((tab, filter = null) => {
    setActiveTab(tab);
    setSyncFilter(tab === 'sync' ? filter : null);
  }, []);

  // Refresh / initial load → čítaj z hash; zmena tabu používateľom → zapíš
  // do hash. Tiež reagujeme na back/forward button (popstate) aby sa
  // history navigácia správala prirodzene.
  useEffect(() => {
    // Syncni hash pri zmene activeTab / syncFilter. replaceState = nevytvárame
    // novú history položku pri každom kliknutí, inak by back button bol nepoužiteľný.
    let desired = `#${activeTab}`;
    if (activeTab === 'sync' && syncFilter) desired += `/${syncFilter}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + desired);
    }
  }, [activeTab, syncFilter]);

  useEffect(() => {
    // Reaguje na manuálnu zmenu URL alebo back/forward tlačidlo.
    const onHashChange = () => {
      const next = parseHash();
      setActiveTab(prev => (prev === next.tab ? prev : next.tab));
      setSyncFilter(prev => (prev === next.filter ? prev : next.filter));
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  useEffect(() => {
    // Admin token v sessionStorage (XSS hardening) — viď adminApi.js
    const token = sessionStorage.getItem('adminToken');
    if (!token) {
      navigate('/admin');
    }
  }, [navigate]);

  const handleLogout = () => {
    sessionStorage.removeItem('adminToken');
    navigate('/admin');
  };

  if (!sessionStorage.getItem('adminToken')) {
    return null;
  }

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <h1 className="header-title-link">
            <img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />
            Super Admin
          </h1>
        </div>
        <div className="crm-header-right">
          <button className="btn btn-secondary" onClick={handleLogout}>
            Odhlásiť sa
          </button>
        </div>
      </header>

      <div className="sa-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`sa-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="sa-tab-icon">{tab.icon}</span>
            <span className="sa-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="sa-content">
        {activeTab === 'overview' && <OverviewTab onNavigate={handleNavigate} />}
        {activeTab === 'diagnostics' && <DiagnosticsTab />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'workspaces' && <WorkspacesTab />}
        {activeTab === 'charts' && <ChartsTab />}
        {activeTab === 'activity' && <ActivityFeedTab />}
        {activeTab === 'api' && <ApiMetricsTab />}
        {activeTab === 'storage' && <StorageTab />}
        {activeTab === 'comparison' && <WorkspaceComparisonTab />}
        {activeTab === 'promo' && <PromoCodesTab />}
        {activeTab === 'audit' && <AuditLogTab />}
        {activeTab === 'sync' && <SyncTab filter={syncFilter} onFilterChange={setSyncFilter} />}
      </div>
    </div>
  );
}

// ─── OVERVIEW TAB ───────────────────────────────────────────────
function OverviewTab({ onNavigate }) {
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminApi.get('/api/admin/stats').then(res => res.data).catch(() => null),
      adminApi.get('/api/admin/health').then(res => res.data).catch(() => null)
    ]).then(([s, h]) => {
      setStats(s);
      setHealth(h);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam štatistiky...</div>;
  if (!stats) return <div className="sa-error">Nepodarilo sa načítať štatistiky</div>;

  const planLabels = { free: 'Free', team: 'Tím', pro: 'Pro' };

  const formatUptime = (seconds) => {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const formatMB = (bytes) => bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '—';

  return (
    <div className="sa-overview">
      {/* System Health */}
      {health && (
        <div className="sa-health-card" style={{ marginBottom: '20px', padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: health.database?.status === 'connected' ? '#22C55E' : '#EF4444' }}></span>
              Stav systému
            </h3>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(health.timestamp).toLocaleString('sk-SK')}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Uptime</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatUptime(health.uptime)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>RAM (heap)</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatMB(health.memory?.heapUsed)} / {formatMB(health.memory?.heapTotal)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>RAM (RSS)</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatMB(health.memory?.rss)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>MongoDB</div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: health.database?.status === 'connected' ? '#22C55E' : '#EF4444' }}>{health.database?.status === 'connected' ? 'OK' : 'Offline'}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Node.js</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{health.nodeVersion || '—'}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Prostredie</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{health.environment || '—'}</div>
            </div>
          </div>
        </div>
      )}

      <div className="sa-stats-grid">
        <StatCard icon="👥" label="Používatelia" value={stats.totalUsers} sub={`+${stats.recentRegistrations} za 30 dní`} onClick={() => onNavigate?.('users')} />
        <StatCard icon="🏢" label="Workspace-y" value={stats.totalWorkspaces} sub={`${stats.activeWorkspaces} aktívnych`} onClick={() => onNavigate?.('workspaces')} />
        <StatCard icon="📋" label="Projekty" value={stats.totalTasks} onClick={() => onNavigate?.('comparison')} />
        <StatCard icon="👤" label="Kontakty" value={stats.totalContacts} onClick={() => onNavigate?.('comparison')} />
        <StatCard icon="📅" label="Google Calendar" value={stats.usersWithGoogleCalendar} sub="pripojených" onClick={() => onNavigate?.('sync', 'calendar')} />
        <StatCard icon="✅" label="Google Tasks" value={stats.usersWithGoogleTasks} sub="pripojených" onClick={() => onNavigate?.('sync', 'tasks')} />
      </div>

      <div className="sa-breakdowns">
        <div className="sa-breakdown-card">
          <h3>Plány</h3>
          <div className="sa-breakdown-list">
            {Object.entries(stats.planBreakdown).map(([plan, count]) => (
              <div key={plan} className="sa-breakdown-item">
                <span className={`sa-plan-badge plan-${plan}`}>{planLabels[plan] || plan}</span>
                <span className="sa-breakdown-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="sa-breakdown-card">
          <h3>Role</h3>
          <div className="sa-breakdown-list">
            {Object.entries(stats.roleBreakdown).map(([role, count]) => (
              <div key={role} className="sa-breakdown-item">
                <span className={`role-badge role-${role}`}>{role === 'admin' ? 'Admin' : role === 'manager' ? 'Manažér' : 'Používateľ'}</span>
                <span className="sa-breakdown-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AdminHelpToggle title="Prehľad">
        <p><strong>Čo tu vidíš:</strong> rýchly snímok celej aplikácie — stav servera, agregované počty a rozdelenie užívateľov. Toto je tvoj denný štartovací bod — keď ti niečo nesedí v reálnom svete (sťažnosť usera, padajúce featury, neskoré notifikácie), sem pozri prvé.</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>🩺 Stav systému (sekcia hore)</h4>
        <ul>
          <li><strong>Bodka vľavo (zelená/červená)</strong> — top-level health indikátor. Zelená = MongoDB connected, server obsluhuje requesty normálne. Červená = MongoDB výpadok → <em>P1 incident</em>, server síce beží ale nedostáva ani neukladá dáta. Skontroluj Render dashboard / MongoDB Atlas hneď.</li>
          <li><strong>Uptime</strong> — doba od posledného reštartu Node procesu. <br/>
            ⚠️ <strong>Krátky (&lt;5 min) bez nedávneho deploy-a</strong> = server crashol a Render ho reštartol. Choď do <em>Diagnostika → Chyby</em> a hľadaj 5xx errory s timestampom okolo reštartu.<br/>
            ⚠️ <strong>Veľmi dlhý (&gt;30 dní)</strong> = možná postupná RAM akumulácia (memory leak). Zvážiť plánovaný reštart pre čistý štart.<br/>
            ✅ Healthy: niekoľko hodín až desiatky dní bez záhadných reštartov.
          </li>
          <li><strong>RAM (heap)</strong> — pamäť alokovaná V8 enginom pre JS objekty (heapUsed / heapTotal). Render Starter má cca 512 MB RAM celkovo.<br/>
            ✅ Healthy: heapUsed &lt; 70 % heapTotal.<br/>
            ⚠️ Watch: 70–85 % → GC pressure, response časy môžu rásť.<br/>
            🚨 Critical: &gt; 85 % alebo heapUsed &gt; 400 MB → naplánuj reštart, hľadaj memory leak (najčastejšie: nezavretý socket, akumulujúci cache, infinite event listener).
          </li>
          <li><strong>RAM (RSS)</strong> — Resident Set Size, celá pamäť, ktorú process zaberá v OS (heap + buffers + native code). Toto je hodnota, ktorú meria Render pre OOM kill.<br/>
            ✅ Healthy: &lt; 350 MB.<br/>
            ⚠️ Watch: 350–450 MB.<br/>
            🚨 Critical: &gt; 450 MB → riziko OOM kill (Render zabije proces). Reštart hneď.
          </li>
          <li><strong>MongoDB</strong> — status DB konektivity. <strong>OK</strong> = connected, <strong>Offline</strong> = výpadok. Offline znamená, že žiadny user nedokáže nič načítať ani uložiť. Skontroluj DB provider (Render / Atlas), connection string v env vars, network connectivity.</li>
          <li><strong>Node.js</strong> — verzia runtime. Sleduj keď sa zmení po deploy-e (mohol byť zmenený engine). LTS verzie (18.x, 20.x, 22.x) sú stabilné, vyhýbať odd-number major (19, 21) v produkcii.</li>
          <li><strong>Prostredie</strong> — <code>production</code> / <code>staging</code> / <code>development</code>. Ak v admin paneli vidíš development, niečo je zle s deploy-om — hodnoty by si nemal brať vážne.</li>
          <li><strong>Timestamp vpravo</strong> — kedy bol health check vykonaný. Stránka neauto-refreshuje, pre aktuálne hodnoty refresni browser.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>📊 Karty štatistík (klikateľné)</h4>
        <ul>
          <li><strong>👥 Používatelia</strong> — celkový počet registrovaných users. <em>Sub-text "+N za 30 dní"</em> = nové registrácie za posledný mesiac (rýchlosť rastu).<br/>
            ⚠️ Pokles tempa registrácií &gt; 50 % medzi mesiacmi → spýtaj sa marketingu / SEO čo sa zmenilo.<br/>
            📈 Trend sleduj v <em>Grafy → Registrácie podľa dní</em>.<br/>
            Klik → otvorí <em>Používatelia</em> tab so zoznamom.
          </li>
          <li><strong>🏢 Workspace-y</strong> — total počet workspace-ov + počet aktívnych. <em>Aktívny workspace</em> = má dáta (kontakty/úlohy/správy) za posledné obdobie.<br/>
            ⚠️ Veľký rozdiel total vs. aktívne (napr. 100 total / 12 aktívnych) = veľa "mŕtvych" workspace-ov. Užívatelia sa zaregistrovali, vytvorili workspace a opustili.<br/>
            💡 Akcia: pošli reactivačný email, alebo cez <em>Storage</em> tab identifikuj prázdne workspace-y na cleanup.<br/>
            Klik → <em>Workspace-y</em> tab.
          </li>
          <li><strong>📋 Projekty</strong> — počet Task dokumentov v DB (top-level projekty, nie úlohy v nich). Pre rozpis úloh aj projektov per workspace pozri <em>Porovnanie</em>.<br/>
            ⚠️ Stagnujúci alebo klesajúci počet týždeň-na-týždeň pri raste user base = engagement problém.<br/>
            Klik → <em>Porovnanie</em> tab.
          </li>
          <li><strong>👤 Kontakty</strong> — počet Contact dokumentov. Pri B2B CRM by malo byť v hrubom 3-10× viac kontaktov ako workspace-ov (každý tím má pár klientov).<br/>
            ⚠️ Pomer kontakty/workspace &lt; 1 = užívatelia sa zaregistrujú, ale nezačnú reálne používať produkt.<br/>
            Klik → <em>Porovnanie</em> tab.
          </li>
          <li><strong>📅 Google Calendar</strong> — počet užívateľov, ktorí si pripojili Google Calendar sync. Toto je dobrý <em>power-user signal</em>.<br/>
            ⚠️ Ak číslo dlho stagnuje pri raste users = feature je málo objavená alebo má UX bariéru.<br/>
            Klik → <em>Sync</em> tab s filtrom calendar.
          </li>
          <li><strong>✅ Google Tasks</strong> — počet užívateľov so sync na Google Tasks. Typicky menej ako Calendar (Tasks API obmedzenia).<br/>
            Klik → <em>Sync</em> tab s filtrom tasks.
          </li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>💳 Plány (sekcia dole vľavo)</h4>
        <ul>
          <li>Rozdelenie users podľa plánu: <strong>Free</strong>, <strong>Tím</strong> (4,99 €/mes), <strong>Pro</strong> (9,99 €/mes).</li>
          <li><strong>Konverzný pomer</strong> = (Tím + Pro) / Total. Cieľ pre B2B SaaS je 5–15 %, world-class produkty &gt; 20 %.<br/>
            ✅ Healthy: ≥ 8 %.<br/>
            ⚠️ Watch: 3–8 % → onboarding alebo pricing môže odpudzovať.<br/>
            🚨 Problem: &lt; 3 % → vážna pricing/value mismatch.
          </li>
          <li><strong>Skoková zmena</strong> v breakdownu (napr. Pro počet zrazu klesol o 5):<br/>
            → Skontroluj <em>Audit log</em> filtrovaný na <code>billing</code> kategóriu — uvidíš či to bol auto-expire (<code>user.plan_auto_expired</code>) alebo manuálny downgrade (<code>user.subscription_updated</code>).<br/>
            → Ak hromadný auto-expire → niekomu vypršal trial / paid period. <em>Diagnostika → Príjmy</em> ti ukáže detail MRR.
          </li>
          <li><strong>Pre detailné MRR/ARR</strong> choď do <em>Diagnostika → Príjmy</em>. Ak chceš vidieť kto presne je na ktorom pláne, použi <em>Používatelia</em> tab a filter podľa plánu.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>🔑 Role (sekcia dole vpravo)</h4>
        <ul>
          <li>Globálne aplikačné role (nie workspace role, tie sú samostatné).</li>
          <li><strong>Admin</strong> — has access do super-admin panelu (toho v ktorom si). Mali by byť 1–2 ľudia max (ty + možno backup).<br/>
            🚨 Critical: ak vidíš počet adminov &gt; 2 a nepoznáš všetkých → niekto získal admin práva neoprávnene. Skontroluj <em>Audit log → user.role_changed</em>.
          </li>
          <li><strong>Manažér</strong> — global manager role (zriedkavá; väčšina manager práv beží na workspace úrovni). V praxi by mal byť počet 0 alebo veľmi nízky.</li>
          <li><strong>Používateľ</strong> — bežný user (default po registrácii). Najväčšie číslo, by-design.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>🚦 Daily check rituál (odporúčaný workflow)</h4>
        <ol>
          <li>Otvor Prehľad → over že bodka stavu systému je <strong>zelená</strong>.</li>
          <li>RAM heap a RSS pod &lt; 70 % / &lt; 350 MB? Ak nie, naplánuj reštart.</li>
          <li>Uptime sedí (žiadny záhadný recent reštart)?</li>
          <li>Skontroluj kartu Používatelia — denný/týždenný rast ide podľa očakávaní?</li>
          <li>Plány — pomer Free:Paid sa nepohol negatívne?</li>
          <li>Ak čokoľvek vyzerá zle → choď do <em>Diagnostika</em> tabu (Chyby, Výkon, Zdravie) na drill-down.</li>
        </ol>

        <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Niektoré hodnoty (napr. recentRegistrations, activeWorkspaces) sa počítajú server-side z agregátnych Mongo queries. Pre real-time monitoring (každých 5 min) máme samostatný health monitor v <code>jobs/healthMonitor.js</code>, ktorý pri 3× zlyhaní pošle email na support@prplcrm.eu.
        </p>
      </AdminHelpToggle>
    </div>
  );
}

function StatCard({ icon, label, value, sub, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className={`sa-stat-card${clickable ? ' sa-stat-card-clickable' : ''}`}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Otvoriť ${label}` : undefined}
    >
      <div className="sa-stat-icon">{icon}</div>
      <div className="sa-stat-info">
        <div className="sa-stat-value">{value}</div>
        <div className="sa-stat-label">{label}</div>
        {sub && <div className="sa-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ─── USERS TAB ──────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [updating, setUpdating] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetail, setUserDetail] = useState(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const openUserDetail = (userId) => {
    setSelectedUser(userId);
    setUserDetailLoading(true);
    adminApi.get(`/api/admin/users/${userId}`)
      .then(res => setUserDetail(res.data))
      .catch(() => {})
      .finally(() => setUserDetailLoading(false));
  };

  const fetchUsers = () => {
    adminApi.get('/api/admin/users')
      .then(res => setUsers(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleWorkspaceRoleChange = async (userId, workspaceId, newRole) => {
    setUpdating(userId);
    try {
      await adminApi.put(`/api/admin/users/${userId}/workspace-role`, { workspaceId, role: newRole });
      setUsers(prev => prev.map(u => {
        if (u.id !== userId) return u;
        return {
          ...u,
          workspaces: u.workspaces.map(w =>
            w.workspaceId === workspaceId ? { ...w, role: newRole } : w
          )
        };
      }));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene workspace role');
    } finally {
      setUpdating(null);
    }
  };

  const handlePlanChange = async (userId, newPlan) => {
    setUpdating(userId);
    try {
      await adminApi.put(`/api/admin/users/${userId}/plan`, { plan: newPlan });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, plan: newPlan } : u));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene plánu');
    } finally {
      setUpdating(null);
    }
  };

  const handleDeleteUser = async (targetUser) => {
    if (!window.confirm(`Naozaj vymazať "${targetUser.username}"? Táto akcia je nevratná.`)) return;
    try {
      await adminApi.delete(`/api/admin/users/${targetUser.id}`);
      setUsers(prev => prev.filter(u => u.id !== targetUser.id));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní');
    }
  };

  const toggleCheck = (id, e) => {
    e.stopPropagation();
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const selectableIds = filtered.filter(u => u.email !== 'support@prplcrm.eu').map(u => u.id);
    setCheckedIds(prev => prev.size === selectableIds.length ? new Set() : new Set(selectableIds));
  };

  const handleBulkApply = async () => {
    if (!bulkAction || !bulkValue || checkedIds.size === 0) return;
    const label = bulkAction === 'plan' ? 'plán' : 'rolu';
    if (!window.confirm(`Zmeniť ${label} pre ${checkedIds.size} používateľov na "${bulkValue}"?`)) return;
    setBulkLoading(true);
    try {
      await adminApi.put('/api/admin/users/bulk', {
        userIds: [...checkedIds],
        action: bulkAction,
        value: bulkValue
      });
      setUsers(prev => prev.map(u => checkedIds.has(u.id) ? { ...u, [bulkAction]: bulkValue } : u));
      setCheckedIds(new Set());
      setBulkAction('');
      setBulkValue('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri hromadnej akcii');
    } finally {
      setBulkLoading(false);
    }
  };

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="sa-loading">Načítavam používateľov...</div>;

  return (
    <div className="sa-users">
      <div className="sa-toolbar">
        <input
          type="text"
          placeholder="Hľadať používateľov..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="form-input sa-search"
        />
        <span className="sa-count">{filtered.length} z {users.length}</span>
        <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px', marginLeft: 'auto' }}
          onClick={() => adminApi.get('/api/admin/export/users', { responseType: 'blob' }).then(res => {
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a'); a.href = url; a.download = 'users-export.csv'; a.click(); URL.revokeObjectURL(url);
          })}>
          📥 Export CSV
        </button>
      </div>

      {/* Bulk action bar */}
      {checkedIds.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', marginBottom: '12px', background: 'var(--primary-light, #EDE9FE)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--primary, #8B5CF6)' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{checkedIds.size} vybraných</span>
          <select value={bulkAction} onChange={e => { setBulkAction(e.target.value); setBulkValue(''); }}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
            <option value="">Hromadná akcia...</option>
            <option value="plan">Zmeniť plán</option>
            <option value="role">Zmeniť rolu</option>
          </select>
          {bulkAction === 'plan' && (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
              <option value="">Vybrať plán...</option>
              <option value="free">Free</option>
              <option value="team">Tím</option>
              <option value="pro">Pro</option>
            </select>
          )}
          {bulkAction === 'role' && (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
              <option value="">Vybrať rolu...</option>
              <option value="admin">Admin</option>
              <option value="manager">Manažér</option>
              <option value="user">Používateľ</option>
            </select>
          )}
          <button className="btn btn-primary" style={{ fontSize: '12px', padding: '4px 12px' }}
            disabled={!bulkAction || !bulkValue || bulkLoading}
            onClick={handleBulkApply}>
            {bulkLoading ? 'Aplikujem...' : 'Aplikovať'}
          </button>
          <button style={{ background: 'none', border: 'none', fontSize: '13px', cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 'auto' }}
            onClick={() => { setCheckedIds(new Set()); setBulkAction(''); setBulkValue(''); }}>
            Zrušiť výber
          </button>
        </div>
      )}

      <div className="users-table-wrapper">
        <table className="users-table">
          <thead>
            <tr>
              <th style={{ width: '36px' }}>
                <input type="checkbox" onChange={toggleAll}
                  checked={filtered.filter(u => u.email !== 'support@prplcrm.eu').length > 0 && filtered.filter(u => u.email !== 'support@prplcrm.eu').every(u => checkedIds.has(u.id))} />
              </th>
              <th>Používateľ</th>
              <th>Email</th>
              <th>Plán</th>
              <th>Sync</th>
              <th>Workspace-y a role</th>
              <th>Registrácia</th>
              <th>Akcie</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.id} className={u.email === 'support@prplcrm.eu' ? 'current-user' : ''} onClick={() => openUserDetail(u.id)} style={{ cursor: 'pointer' }}>
                <td onClick={e => e.stopPropagation()}>
                  {u.email !== 'support@prplcrm.eu' && (
                    <input type="checkbox" checked={checkedIds.has(u.id)} onChange={e => toggleCheck(u.id, e)} />
                  )}
                </td>
                <td>
                  <div className="user-cell">
                    {u.avatar ? (
                      <img
                        src={`${API_BASE_URL}/api/auth/avatar/${u.id}`}
                        alt={u.username}
                        className="table-avatar-img"
                      />
                    ) : (
                      <span className="table-avatar" style={{ backgroundColor: u.color }}>
                        {u.username.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="user-name-cell">
                      {u.username}
                      {u.email === 'support@prplcrm.eu' && <span className="you-badge">(vy)</span>}
                    </span>
                  </div>
                </td>
                <td className="sa-email-cell">{u.email}</td>
                <td>
                  <select
                    value={u.plan}
                    onChange={e => handlePlanChange(u.id, e.target.value)}
                    disabled={updating === u.id}
                    className="sa-select"
                  >
                    <option value="free">Free</option>
                    <option value="team">Tím</option>
                    <option value="pro">Pro</option>
                  </select>
                  {u.discount && (
                    <span title={u.discount.type === 'percentage' ? `${u.discount.value}%` : u.discount.type === 'fixed' ? `−${u.discount.value}€` : u.discount.type === 'freeMonths' ? `${u.discount.value} mes.` : `→${u.discount.targetPlan?.toUpperCase()}`}
                      style={{ display: 'inline-block', marginLeft: '4px', fontSize: '10px', padding: '1px 5px', borderRadius: '8px', background: '#FEF3C7', color: '#92400E', fontWeight: 600 }}>
                      🏷️
                    </span>
                  )}
                </td>
                <td>
                  <div className="sa-sync-badges">
                    {u.googleCalendar && <span className="sa-sync-badge cal" title="Google Calendar">📅</span>}
                    {u.googleTasks && <span className="sa-sync-badge tasks" title="Google Tasks">✅</span>}
                    {!u.googleCalendar && !u.googleTasks && <span className="sa-sync-none">—</span>}
                  </div>
                </td>
                <td onClick={e => e.stopPropagation()}>
                  <div className="sa-workspace-list">
                    {u.workspaces.length === 0 && <span className="sa-sync-none">—</span>}
                    {u.workspaces.map((w, i) => (
                      <div key={i} className="sa-ws-role-row">
                        <span className="sa-ws-chip">{w.name}</span>
                        <select
                          className="sa-select sa-select-sm"
                          value={w.role}
                          onChange={e => handleWorkspaceRoleChange(u.id, w.workspaceId, e.target.value)}
                          disabled={updating === u.id}
                        >
                          <option value="owner">Owner</option>
                          <option value="manager">Manager</option>
                          <option value="member">Member</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </td>
                <td className="sa-date-cell">
                  {u.createdAt ? new Date(u.createdAt).toLocaleDateString('sk-SK') : '—'}
                </td>
                <td>
                  {u.email !== 'support@prplcrm.eu' && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteUser(u)}
                      title="Vymazať"
                    >
                      Vymazať
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* User Detail Modal */}
      {selectedUser && (
        <div className="modal-overlay" onClick={() => { setSelectedUser(null); setUserDetail(null); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px', maxHeight: '90vh', overflow: 'auto', padding: '0' }}>
            {userDetailLoading ? <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div> : userDetail ? (
              <>
                {/* Header with user info */}
                <div style={{ padding: '24px 28px 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: userDetail.user.color || '#8B5CF6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: '22px', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                        {(userDetail.user.username || '?')[0].toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '20px', marginBottom: '2px' }}>{userDetail.user.username}</div>
                        <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{userDetail.user.email}</div>
                        <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '10px', background: userDetail.user.role === 'admin' ? '#EF4444' : '#6B7280', color: 'white', fontWeight: 600 }}>{userDetail.user.role}</span>
                          <span style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '10px', background: (userDetail.user.subscription?.plan || 'free') === 'pro' ? '#8B5CF6' : (userDetail.user.subscription?.plan || 'free') === 'team' ? '#F59E0B' : '#6B7280', color: 'white', fontWeight: 600 }}>{userDetail.user.subscription?.plan || 'free'}</span>
                          <span style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '10px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>od {new Date(userDetail.user.createdAt).toLocaleDateString('sk-SK')}</span>
                        </div>
                      </div>
                    </div>
                    <button onClick={() => { setSelectedUser(null); setUserDetail(null); }} style={{ background: 'none', border: 'none', fontSize: '22px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px', lineHeight: 1 }}>✕</button>
                  </div>

                  {/* Stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginTop: '16px' }}>
                    {[
                      { label: 'Kontakty', value: userDetail.stats.contactCount, icon: '👤' },
                      { label: 'Projekty', value: userDetail.stats.taskCount, icon: '📋' },
                      { label: 'Odoslané', value: userDetail.stats.messagesSent, icon: '📤' },
                      { label: 'Prijaté', value: userDetail.stats.messagesReceived, icon: '📥' },
                    ].map(s => (
                      <div key={s.label} style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: '10px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700 }}>{s.value}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{s.icon} {s.label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Body */}
                <div style={{ padding: '20px 28px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

                  {/* Two-column layout for Workspaces + Devices */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    {/* Workspaces */}
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                      <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Workspace-y ({userDetail.memberships.length})</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {userDetail.memberships.map(m => (
                          <div key={m._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: m.workspace?.color || '#6B7280', flexShrink: 0 }}></span>
                              <span style={{ fontWeight: 500 }}>{m.workspace?.name || '—'}</span>
                            </div>
                            <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: m.role === 'owner' ? '#8B5CF6' : m.role === 'manager' ? '#F59E0B' : '#6B7280', color: 'white', fontWeight: 500 }}>{m.role}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Devices — grouped and collapsible */}
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                      <DevicesSummary devices={userDetail.devices} />
                    </div>
                  </div>

                  {/* Google integrations */}
                  {(userDetail.user.googleCalendar?.enabled || userDetail.user.googleTasks?.enabled) && (
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                      <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Integrácie</h4>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '13px' }}>
                        {userDetail.user.googleCalendar?.enabled && <span style={{ padding: '6px 12px', background: '#DBEAFE', borderRadius: 'var(--radius-sm)', fontWeight: 500 }}>📅 Google Calendar · od {new Date(userDetail.user.googleCalendar.connectedAt).toLocaleDateString('sk-SK')}</span>}
                        {userDetail.user.googleTasks?.enabled && <span style={{ padding: '6px 12px', background: '#D1FAE5', borderRadius: 'var(--radius-sm)', fontWeight: 500 }}>✅ Google Tasks · od {new Date(userDetail.user.googleTasks.connectedAt).toLocaleDateString('sk-SK')}</span>}
                      </div>
                    </div>
                  )}

                  {/* Recent activity */}
                  {userDetail.recentActivity?.length > 0 && (
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                      <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Posledná aktivita</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '180px', overflow: 'auto' }}>
                        {userDetail.recentActivity.map((a, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }}>{ACTION_LABELS[a.action] || a.action} {a.targetName ? `— ${a.targetName}` : ''}</span>
                            <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{new Date(a.createdAt).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Subscription management */}
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                    <SubscriptionEditor user={userDetail.user} onUpdate={(sub) => {
                      setUserDetail(prev => ({ ...prev, user: { ...prev.user, subscription: sub } }));
                      setUsers(prev => prev.map(u => u.id === userDetail.user._id ? { ...u, plan: sub.plan } : u));
                    }} />
                  </div>

                  {/* Discount management */}
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '14px' }}>
                    <DiscountEditor user={userDetail.user} onUpdate={(sub) => {
                      setUserDetail(prev => ({ ...prev, user: { ...prev.user, subscription: sub } }));
                      setUsers(prev => prev.map(u => u.id === userDetail.user._id ? {
                        ...u,
                        plan: sub.plan,
                        discount: sub.discount?.type ? { type: sub.discount.type, value: sub.discount.value, targetPlan: sub.discount.targetPlan, expiresAt: sub.discount.expiresAt } : null
                      } : u));
                    }} />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      <AdminHelpToggle title="Používatelia">
        <p><strong>Čo tu vidíš:</strong> kompletný zoznam všetkých registrovaných užívateľov + nástroje na úpravu ich účtu, plánu a zliav.</p>
        <ul>
          <li><strong>Vyhľadávanie a filtre</strong> hore — hľadanie podľa mena/emailu, filter podľa plánu, role, registrácie atď.</li>
          <li><strong>Hromadné akcie</strong> — zaškrtni viacerých → hromadne zmeň plán alebo rolu (super admin je vždy vynechaný).</li>
          <li><strong>Klik na riadok</strong> → otvorí detail panel vpravo so:
            <ul>
              <li><strong>Profil</strong> — meno, email, role, registračný dátum, posledné prihlásenie.</li>
              <li><strong>Workspaces</strong> — kde je členom a v akej role.</li>
              <li><strong>Zariadenia</strong> — zaregistrované iOS/Android/web push tokeny.</li>
              <li><strong>Posledná aktivita</strong> — výňatok z Audit logu pre tohto usera.</li>
              <li><strong>Predplatné — úprava</strong> — zmena plánu (Free/Tím/Pro) a "Platené do" dátumu. Po vypršaní paidUntil a bez Stripe sub sa plán automaticky vráti na Free (cez auto-expiry službu).</li>
              <li><strong>Zľava</strong> — pridanie discount metadata: percentuálna, fixná, voľné mesiace, plán-upgrade zadarmo. <em>Pozor:</em> "voľné mesiace" predĺži paidUntil ale nezmení plán — pre "mesiac Pro zdarma" radšej použi "Predplatné — úprava" (plán Pro + dátum o mesiac).</li>
            </ul>
          </li>
        </ul>
        <p><strong>Tipy:</strong> mazanie usera je permanentné (DELETE z DB + GDPR cleanup). Pred zmenou role/plánu vždy skontroluj kontext — všetky zmeny sa logujú do Audit logu so záznamom kto/kedy/čo.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── DEVICES SUMMARY ────────────────────────────────────────────
function DevicesSummary({ devices }) {
  const [expanded, setExpanded] = useState(false);
  const apns = devices?.apnsDevices || [];
  const web = devices?.pushSubscriptions || [];
  const total = apns.length + web.length;

  if (total === 0) {
    return (
      <>
        <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Zariadenia (0)</h4>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Žiadne registrované zariadenia</div>
      </>
    );
  }

  // Group web push by browser type
  const webByBrowser = {};
  web.forEach(d => {
    const browser = d.endpoint?.includes('apple.com') ? 'Safari' : d.endpoint?.includes('google') ? 'Chrome' : d.endpoint?.includes('mozilla') ? 'Firefox' : 'Browser';
    if (!webByBrowser[browser]) webByBrowser[browser] = [];
    webByBrowser[browser].push(d);
  });

  return (
    <>
      <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Zariadenia ({total})
      </h4>

      {/* Summary badges */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: expanded ? '10px' : 0 }}>
        {apns.length > 0 && (
          <span style={{ fontSize: '12px', padding: '4px 10px', background: '#DBEAFE', borderRadius: 'var(--radius-sm)', fontWeight: 500 }}>
            📱 {apns.length}× iOS
          </span>
        )}
        {Object.entries(webByBrowser).map(([browser, subs]) => (
          <span key={browser} style={{ fontSize: '12px', padding: '4px 10px', background: '#E0E7FF', borderRadius: 'var(--radius-sm)', fontWeight: 500 }}>
            🌐 {subs.length}× {browser}
          </span>
        ))}
        <button onClick={() => setExpanded(!expanded)}
          style={{ fontSize: '11px', padding: '4px 10px', background: 'none', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--accent-color)', fontWeight: 500 }}>
          {expanded ? '▲ Skryť' : '▼ Detail'}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', maxHeight: '180px', overflow: 'auto' }}>
          {apns.map((d, i) => (
            <div key={`apns-${i}`} style={{ padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>📱 iOS <span style={{ color: d.apnsEnvironment === 'production' ? '#10B981' : '#F59E0B', fontWeight: 500 }}>({d.apnsEnvironment || '?'})</span> · ...{d.deviceToken?.slice(-8)}</span>
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.lastUsed ? new Date(d.lastUsed).toLocaleDateString('sk-SK') : '—'}</span>
            </div>
          ))}
          {web.map((d, i) => {
            const browser = d.endpoint?.includes('apple.com') ? 'Safari' : d.endpoint?.includes('google') ? 'Chrome' : d.endpoint?.includes('mozilla') ? 'Firefox' : 'Browser';
            return (
              <div key={`web-${i}`} style={{ padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <span>🌐 {browser}</span>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.lastUsed ? new Date(d.lastUsed).toLocaleDateString('sk-SK') : '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── WORKSPACES TAB ─────────────────────────────────────────────
function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedWs, setSelectedWs] = useState(null);
  const [wsDetail, setWsDetail] = useState(null);
  const [wsDetailLoading, setWsDetailLoading] = useState(false);

  useEffect(() => {
    adminApi.get('/api/admin/workspaces')
      .then(res => setWorkspaces(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const openWsDetail = (wsId) => {
    setSelectedWs(wsId);
    setWsDetailLoading(true);
    adminApi.get(`/api/admin/workspaces/${wsId}`)
      .then(res => setWsDetail(res.data))
      .catch(() => {})
      .finally(() => setWsDetailLoading(false));
  };

  const handleDeleteWorkspace = async () => {
    if (!wsDetail) return;
    const name = wsDetail.workspace.name;
    if (!window.confirm(`Naozaj vymazať workspace "${name}"?\n\nToto vymaže VŠETKY kontakty, úlohy, správy a členstvá v tomto workspace. Táto akcia je NEVRATNÁ.`)) return;
    try {
      await adminApi.delete(`/api/admin/workspaces/${selectedWs}`);
      setWorkspaces(prev => prev.filter(w => w.id !== selectedWs));
      setSelectedWs(null);
      setWsDetail(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní workspace');
    }
  };

  if (loading) return <div className="sa-loading">Načítavam workspace-y...</div>;

  return (
    <div className="sa-workspaces">
      <div className="sa-toolbar">
        <span className="sa-count">{workspaces.length} workspace-ov</span>
        <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px', marginLeft: 'auto' }}
          onClick={() => adminApi.get('/api/admin/export/workspaces', { responseType: 'blob' }).then(res => {
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a'); a.href = url; a.download = 'workspaces-export.csv'; a.click(); URL.revokeObjectURL(url);
          })}>
          📥 Export CSV
        </button>
      </div>

      <div className="users-table-wrapper">
        <table className="users-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Vlastník</th>
              <th>Členovia</th>
              <th>Kontakty</th>
              <th>Projekty</th>
              <th>Platené miesta</th>
              <th>Vytvorený</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(w => (
              <tr key={w.id} onClick={() => openWsDetail(w.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <div className="sa-ws-name">
                    <span className="sa-ws-color" style={{ backgroundColor: w.color }}></span>
                    <div>
                      <div className="sa-ws-title">{w.name}</div>
                      <div className="sa-ws-slug">/{w.slug}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="sa-owner-cell">
                    <div>{w.owner.username}</div>
                    <div className="sa-sub-text">{w.owner.email}</div>
                  </div>
                </td>
                <td className="sa-center">{w.memberCount}</td>
                <td className="sa-center">{w.contactCount}</td>
                <td className="sa-center">{w.taskCount}</td>
                <td className="sa-center">{w.paidSeats || 0}</td>
                <td className="sa-date-cell">
                  {new Date(w.createdAt).toLocaleDateString('sk-SK')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Workspace Detail Modal */}
      {selectedWs && (
        <div className="modal-overlay" onClick={() => { setSelectedWs(null); setWsDetail(null); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '85vh', overflow: 'auto', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Detail workspace</h3>
              <button onClick={() => { setSelectedWs(null); setWsDetail(null); }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>✕</button>
            </div>
            {wsDetailLoading ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div> : wsDetail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Workspace info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ width: '14px', height: '14px', borderRadius: '50%', background: wsDetail.workspace.color || '#8B5CF6', flexShrink: 0 }}></span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '16px' }}>{wsDetail.workspace.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>/{wsDetail.workspace.slug} · Vytvorený {new Date(wsDetail.workspace.createdAt).toLocaleDateString('sk-SK')}</div>
                  </div>
                </div>

                {/* Stats grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {[
                    { label: 'Kontakty', value: wsDetail.stats.contactCount },
                    { label: 'Úlohy', value: `${wsDetail.stats.completedTasks}/${wsDetail.stats.taskCount}` },
                    { label: 'Správy', value: wsDetail.stats.messageCount },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', fontWeight: 700 }}>{s.value}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {/* Members */}
                <div>
                  <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Členovia ({wsDetail.members.length})</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {wsDetail.members.map(m => (
                      <div key={m._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                        <div>
                          <span style={{ fontWeight: 500 }}>{m.user?.username || '—'}</span>
                          <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>{m.user?.email || ''}</span>
                        </div>
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: m.role === 'owner' ? '#8B5CF6' : m.role === 'manager' ? '#F59E0B' : '#6B7280', color: 'white' }}>{m.role}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent contacts */}
                {wsDetail.recentContacts?.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Posledné kontakty</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {wsDetail.recentContacts.slice(0, 10).map(c => (
                        <div key={c._id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                          <span>{c.name || '—'} {c.company ? `(${c.company})` : ''}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{new Date(c.createdAt).toLocaleDateString('sk-SK')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Delete workspace */}
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '8px' }}>
                  <button className="btn btn-danger" style={{ fontSize: '13px', width: '100%' }} onClick={handleDeleteWorkspace}>
                    Vymazať workspace a všetky dáta
                  </button>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '6px' }}>
                    Táto akcia je nevratná. Vymaže kontakty, úlohy, správy a členstvá.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <AdminHelpToggle title="Workspace-y">
        <p><strong>Čo tu vidíš:</strong> všetky workspace-y v systéme — vlastníci, počet členov, dáta vo vnútri.</p>
        <ul>
          <li><strong>Vyhľadávanie</strong> hore — podľa názvu alebo emailu vlastníka.</li>
          <li><strong>Riadok workspace-u</strong> — ukazuje názov, vlastníka, počet členov, počet kontaktov a projektov.</li>
          <li><strong>Klik na workspace</strong> → otvorí detail panel:
            <ul>
              <li><strong>Členovia</strong> — kto je v workspace-u + ich rola (owner / manager / member).</li>
              <li><strong>Posledné kontakty</strong> — výpis 10 najnovších pridaných kontaktov.</li>
              <li><strong>Vymazať workspace</strong> — destructive akcia, kompletne odstráni workspace + všetky kontakty, úlohy, správy, členstvá.</li>
            </ul>
          </li>
        </ul>
        <p><strong>Tipy:</strong> Workspace môže existovať aj keď vlastník už nemá aktívne predplatné — limity sa kontrolujú podľa plánu majiteľa workspace-u (workspace owner). Pri vymazaní user-a sa jeho workspaces neodstránia automaticky — treba ich vymazať ručne tu.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── SUBSCRIPTION EDITOR ─────────────────────────────────────────
function SubscriptionEditor({ user, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(user.subscription?.plan || 'free');
  const [paidUntil, setPaidUntil] = useState(user.subscription?.paidUntil ? new Date(user.subscription.paidUntil).toISOString().split('T')[0] : '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await adminApi.put(`/api/admin/users/${user._id}/subscription`, {
        plan,
        paidUntil: paidUntil || null
      });
      onUpdate(res.data.subscription);
      setEditing(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní');
    } finally {
      setSaving(false);
    }
  };

  const sub = user.subscription || {};
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';

  if (!editing) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600 }}>Predplatné</h4>
          <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: 'var(--primary, #8B5CF6)', fontWeight: 500 }}>Upraviť</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px' }}>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Plán</div>
            <div style={{ fontWeight: 600 }}>{(sub.plan || 'free').toUpperCase()}</div>
          </div>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Platené do</div>
            <div style={{ fontWeight: 600 }}>{formatDate(sub.paidUntil)}</div>
          </div>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Stripe</div>
            <div style={{ fontWeight: 600 }}>{sub.stripeSubscriptionId ? 'Aktívne' : '—'}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Predplatné — úprava</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', width: '80px', color: 'var(--text-muted)' }}>Plán</label>
          <select value={plan} onChange={e => setPlan(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }}>
            <option value="free">Free</option>
            <option value="team">Tím</option>
            <option value="pro">Pro</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', width: '80px', color: 'var(--text-muted)' }}>Platené do</label>
          <input type="date" value={paidUntil} onChange={e => setPaidUntil(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 12px' }} onClick={() => setEditing(false)}>Zrušiť</button>
          <button className="btn btn-primary" style={{ fontSize: '12px', padding: '4px 12px' }} disabled={saving} onClick={handleSave}>
            {saving ? 'Ukladám...' : 'Uložiť'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DISCOUNT EDITOR ──────────────────────────────────────────
const DISCOUNT_TYPES = {
  percentage: { label: 'Percentuálna zľava', unit: '%', icon: '🏷️' },
  fixed: { label: 'Fixná zľava', unit: '€/mes', icon: '💶' },
  freeMonths: { label: 'Voľné mesiace', unit: 'mes.', icon: '🎁' },
  planUpgrade: { label: 'Upgrade zadarmo', unit: '', icon: '⬆️' }
};

function DiscountEditor({ user, onUpdate }) {
  const [showForm, setShowForm] = useState(false);
  const [discType, setDiscType] = useState('percentage');
  const [discValue, setDiscValue] = useState('');
  const [targetPlan, setTargetPlan] = useState('pro');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  const activeDiscount = user.subscription?.discount?.type ? user.subscription.discount : null;

  const handleApply = async () => {
    setSaving(true);
    try {
      const body = { type: discType, reason, expiresAt: expiresAt || null };
      if (discType === 'planUpgrade') {
        body.targetPlan = targetPlan;
      } else {
        body.value = parseFloat(discValue);
        if (isNaN(body.value) || body.value <= 0) {
          alert('Zadajte platnú hodnotu');
          setSaving(false);
          return;
        }
      }
      const res = await adminApi.put(`/api/admin/users/${user._id}/discount`, body);
      onUpdate(res.data.subscription);
      setShowForm(false);
      setDiscValue('');
      setReason('');
      setExpiresAt('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri aplikovaní zľavy');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm('Naozaj odstrániť zľavu?')) return;
    setSaving(true);
    try {
      const res = await adminApi.delete(`/api/admin/users/${user._id}/discount`);
      onUpdate(res.data.subscription);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri odstránení zľavy');
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (type, value, tPlan) => {
    setDiscType(type);
    setDiscValue(value?.toString() || '');
    setTargetPlan(tPlan || 'pro');
    setShowForm(true);
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';
  const isExpired = activeDiscount?.expiresAt && new Date(activeDiscount.expiresAt) < new Date();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <h4 style={{ fontSize: '14px', fontWeight: 600 }}>Zľavy</h4>
        {!showForm && !activeDiscount && (
          <button onClick={() => setShowForm(true)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: 'var(--primary, #8B5CF6)', fontWeight: 500 }}>+ Pridať zľavu</button>
        )}
      </div>

      {/* Active discount display */}
      {activeDiscount && (
        <div style={{ padding: '10px 14px', background: isExpired ? 'var(--bg-secondary)' : '#FEF3C7', borderRadius: 'var(--radius-sm)', border: `1px solid ${isExpired ? 'var(--border-color)' : '#F59E0B'}`, marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '14px', marginRight: '6px' }}>{DISCOUNT_TYPES[activeDiscount.type]?.icon}</span>
              <strong style={{ fontSize: '13px' }}>
                {activeDiscount.type === 'percentage' && `${activeDiscount.value}% zľava`}
                {activeDiscount.type === 'fixed' && `−${activeDiscount.value}€/mes`}
                {activeDiscount.type === 'freeMonths' && `${activeDiscount.value} voľných mesiacov`}
                {activeDiscount.type === 'planUpgrade' && `Upgrade na ${activeDiscount.targetPlan?.toUpperCase()}`}
              </strong>
              {isExpired && <span style={{ color: '#EF4444', fontSize: '11px', marginLeft: '6px' }}>EXPIROVANÁ</span>}
            </div>
            <button onClick={handleRemove} disabled={saving}
              style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: '#EF4444' }}>
              Odstrániť
            </button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {activeDiscount.reason && <span>Dôvod: {activeDiscount.reason} · </span>}
            {activeDiscount.expiresAt && <span>Platí do: {formatDate(activeDiscount.expiresAt)} · </span>}
            <span>Pridal: {activeDiscount.createdBy} ({formatDate(activeDiscount.createdAt)})</span>
          </div>
        </div>
      )}

      {/* Quick presets */}
      {!showForm && !activeDiscount && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
          {[
            { label: '10%', type: 'percentage', value: 10 },
            { label: '20%', type: 'percentage', value: 20 },
            { label: '50%', type: 'percentage', value: 50 },
            { label: '1 mes. free', type: 'freeMonths', value: 1 },
            { label: '3 mes. free', type: 'freeMonths', value: 3 },
            { label: 'Pro zadarmo', type: 'planUpgrade', value: null, targetPlan: 'pro' },
          ].map(p => (
            <button key={p.label} onClick={() => applyPreset(p.type, p.value, p.targetPlan)}
              style={{ padding: '4px 10px', fontSize: '11px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer' }}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Custom form */}
      {showForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', width: '70px', color: 'var(--text-muted)', flexShrink: 0 }}>Typ</label>
            <select value={discType} onChange={e => setDiscType(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }}>
              {Object.entries(DISCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </div>

          {discType !== 'planUpgrade' && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', width: '70px', color: 'var(--text-muted)', flexShrink: 0 }}>Hodnota</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                <input type="number" value={discValue} onChange={e => setDiscValue(e.target.value)}
                  placeholder={discType === 'percentage' ? '20' : discType === 'fixed' ? '2.50' : '3'}
                  style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{DISCOUNT_TYPES[discType].unit}</span>
              </div>
            </div>
          )}

          {discType === 'planUpgrade' && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', width: '70px', color: 'var(--text-muted)', flexShrink: 0 }}>Plán</label>
              <select value={targetPlan} onChange={e => setTargetPlan(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }}>
                <option value="team">Tím (4,99€/mes)</option>
                <option value="pro">Pro (9,99€/mes)</option>
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', width: '70px', color: 'var(--text-muted)', flexShrink: 0 }}>Dôvod</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Napr. verný zákazník, beta tester..."
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', width: '70px', color: 'var(--text-muted)', flexShrink: 0 }}>Platí do</label>
            <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>prázdne = bez limitu</span>
          </div>

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 12px' }} onClick={() => setShowForm(false)}>Zrušiť</button>
            <button className="btn btn-primary" style={{ fontSize: '12px', padding: '4px 12px' }} disabled={saving} onClick={handleApply}>
              {saving ? 'Aplikujem...' : 'Aplikovať zľavu'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SYNC DIAGNOSTICS TAB ───────────────────────────────────────
// Prepínač Všetko / Calendar / Tasks. Mení filter v URL hash cez
// onFilterChange prop, takže state je persistentný cez refresh.
function SyncFilterBar({ filter, onFilterChange }) {
  const btn = (value, label) => {
    const active = filter === value;
    return (
      <button
        key={label}
        onClick={() => onFilterChange?.(value)}
        className={`btn ${active ? 'btn-primary' : 'btn-secondary'}`}
        style={{ fontSize: '13px', padding: '6px 14px' }}
      >
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
      {btn(null, 'Všetko')}
      {btn('calendar', '📅 Google Calendar')}
      {btn('tasks', '✅ Google Tasks')}
    </div>
  );
}

function SyncTab({ filter, onFilterChange }) {
  const [diagnostics, setDiagnostics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/sync-diagnostics')
      .then(res => setDiagnostics(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam diagnostiku...</div>;

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // Aplikuj filter z URL hash. `calendar` → zobraz iba usera s enabled Calendar
  // a skryj Tasks sekciu. `tasks` → zrkadlovo. `null` → všetko ako doteraz.
  const showCalendar = filter === null || filter === 'calendar';
  const showTasks = filter === null || filter === 'tasks';

  const filtered = diagnostics.filter(d => {
    if (filter === 'calendar') return d.calendar.enabled;
    if (filter === 'tasks') return d.tasks.enabled;
    return true;
  });

  if (filtered.length === 0) {
    const msg = filter === 'calendar'
      ? 'Žiadny používateľ nemá prepojený Google Calendar.'
      : filter === 'tasks'
      ? 'Žiadny používateľ nemá prepojené Google Tasks.'
      : 'Žiadny používateľ nemá prepojenú Google synchronizáciu.';
    return (
      <div className="sa-sync-diag">
        <SyncFilterBar filter={filter} onFilterChange={onFilterChange} />
        <div className="sa-empty">{msg}</div>
      </div>
    );
  }

  return (
    <div className="sa-sync-diag">
      <SyncFilterBar filter={filter} onFilterChange={onFilterChange} />
      <div className="sa-toolbar">
        <span className="sa-count">
          {filtered.length} {filter === 'calendar' ? 'používateľov s Google Calendar' : filter === 'tasks' ? 'používateľov s Google Tasks' : 'používateľov so synchronizáciou'}
        </span>
      </div>

      <div className="sa-sync-cards">
        {filtered.map(d => (
          <div key={d.id} className="sa-sync-card">
            <div className="sa-sync-card-header">
              <strong>{d.username}</strong>
              <span className="sa-sub-text">{d.email}</span>
            </div>

            <div className="sa-sync-sections">
              {showCalendar && d.calendar.enabled && (
                <div className="sa-sync-section">
                  <div className="sa-sync-section-title">📅 Google Calendar</div>
                  <div className="sa-sync-detail">
                    <span>Pripojené:</span>
                    <span>{formatDate(d.calendar.connectedAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Synchronizovaných celkom:</span>
                    <span>{d.calendar.syncedCount} udalostí</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Watch:</span>
                    <span className={d.calendar.watchActive ? 'sa-status-ok' : 'sa-status-warn'}>
                      {d.calendar.watchActive ? 'Aktívny' : 'Neaktívny'}
                    </span>
                  </div>
                  {d.calendar.watchExpiry && (
                    <div className="sa-sync-detail">
                      <span>Watch expiry:</span>
                      <span>{formatDate(d.calendar.watchExpiry)}</span>
                    </div>
                  )}
                  {/* PR2: per-workspace breakdown */}
                  {d.calendar.workspaces && d.calendar.workspaces.length > 0 && (
                    <div style={{ marginTop: '8px', borderTop: '1px solid var(--sa-border, #e5e7eb)', paddingTop: '8px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: 'var(--sa-muted, #6b7280)' }}>
                        Workspace kalendáre ({d.calendar.workspaces.length})
                      </div>
                      {d.calendar.workspaces.map(ws => (
                        <div key={ws.workspaceId} className="sa-sync-detail" style={{ fontSize: '12px' }}>
                          <span title={ws.calendarId}>📁 {ws.workspaceName}</span>
                          <span>{ws.syncedCount} udalostí</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {d.calendar.unattributedCount > 0 && (
                    <div className="sa-sync-detail" style={{ marginTop: '4px', color: '#d97706' }}>
                      <span>⚠️ Nemigrovaných:</span>
                      <span>{d.calendar.unattributedCount} udalostí (v pôvodnom kalendári)</span>
                    </div>
                  )}
                </div>
              )}

              {showTasks && d.tasks.enabled && (
                <div className="sa-sync-section">
                  <div className="sa-sync-section-title">✅ Google Tasks</div>
                  <div className="sa-sync-detail">
                    <span>Pripojené:</span>
                    <span>{formatDate(d.tasks.connectedAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Synchronizovaných celkom:</span>
                    <span>{d.tasks.syncedCount} úloh</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Posledný sync:</span>
                    <span>{formatDate(d.tasks.lastSyncAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Kvóta dnes:</span>
                    <span>{d.tasks.quotaUsedToday}/100</span>
                  </div>
                  {d.tasks.workspaces && d.tasks.workspaces.length > 0 && (
                    <div style={{ marginTop: '8px', borderTop: '1px solid var(--sa-border, #e5e7eb)', paddingTop: '8px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: 'var(--sa-muted, #6b7280)' }}>
                        Workspace task listy ({d.tasks.workspaces.length})
                      </div>
                      {d.tasks.workspaces.map(ws => (
                        <div key={ws.workspaceId} className="sa-sync-detail" style={{ fontSize: '12px' }}>
                          <span title={ws.taskListId}>📋 {ws.workspaceName}</span>
                          <span>{ws.syncedCount} úloh</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {d.tasks.unattributedCount > 0 && (
                    <div className="sa-sync-detail" style={{ marginTop: '4px', color: '#d97706' }}>
                      <span>⚠️ Nemigrovaných:</span>
                      <span>{d.tasks.unattributedCount} úloh (v pôvodnom liste)</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <AdminHelpToggle title="Sync (Google Calendar / Tasks)">
        <p><strong>Čo tu vidíš:</strong> stav synchronizácie Google Calendar a Google Tasks pre každého používateľa, ktorý si pripojil Google účet.</p>
        <ul>
          <li><strong>Filter</strong> hore — prepínač Calendar / Tasks; URL hash <code>#sync/calendar</code> alebo <code>#sync/tasks</code> pamätá výber pri refreshi.</li>
          <li><strong>Riadok usera</strong> — meno, email, počet sync-ovaných eventov / úloh, posledný sync timestamp.</li>
          <li><strong>Workspace task listy</strong> — Google Tasks robí osobitný task list pre každý workspace (názov "Prpl CRM — &lt;workspace&gt;"). Tu vidíš koľko úloh je v ktorom liste.</li>
          <li><strong>Unattributed</strong> — úlohy/eventy, ktoré nemajú priradený workspace (legacy alebo manuálne pridané do Google).</li>
        </ul>
        <p><strong>Tipy:</strong> Pripojenie/odpojenie Google účtu robí user sám v UserMenu → Synchronizácia kalendára. Tu len monitoruješ stav. Ak je sync zaseknutý → skontroluj Diagnostika → Errors, či OAuth token nevyexspiroval.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── AUDIT LOG TAB ──────────────────────────────────────────────
const ACTION_LABELS = {
  'user.role_changed': '🔑 Zmena role', 'user.plan_changed': '💳 Zmena plánu', 'user.deleted': '🗑️ Vymazaný užívateľ',
  'user.discount_applied': '🏷️ Zľava pridaná', 'user.discount_removed': '🏷️ Zľava odobratá', 'user.subscription_updated': '💳 Predplatné upravené',
  'user.plan_auto_expired': '⏰ Plán automaticky expiroval (vrátený na Free)',
  'auth.login': '🔓 Prihlásenie', 'auth.register': '📝 Registrácia',
  'contact.created': '➕ Nový kontakt', 'contact.updated': '✏️ Úprava kontaktu', 'contact.deleted': '🗑️ Vymazaný kontakt',
  'task.created': '➕ Nová úloha', 'task.completed': '✅ Dokončená úloha', 'task.deleted': '🗑️ Vymazaná úloha',
  'message.created': '📨 Nová správa', 'message.approved': '✅ Schválená správa', 'message.rejected': '❌ Zamietnutá správa',
};

const CATEGORY_LABELS = {
  user: '👤 Používateľ', workspace: '🏢 Workspace', contact: '📇 Kontakt',
  task: '📋 Úloha', message: '✉️ Správa', auth: '🔐 Auth', billing: '💳 Fakturácia', system: '⚙️ Systém'
};

function AuditLogTab() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ category: '', search: '', from: '', to: '' });

  const fetchLogs = () => {
    setLoading(true);
    const params = { page, limit: 30 };
    if (filters.category) params.category = filters.category;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;

    adminApi.get('/api/admin/audit-log', { params })
      .then(res => {
        setLogs(res.data.logs || []);
        setTotalPages(res.data.pages || 1);
        setTotal(res.data.total || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchLogs(); }, [page, filters.category]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  };

  const formatDateTime = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const renderDetails = (log) => {
    if (!log.details) return null;
    const d = log.details;
    const parts = [];
    if (d.oldRole && d.newRole) parts.push(`${d.oldRole} → ${d.newRole}`);
    if (d.oldPlan && d.newPlan) parts.push(`${d.oldPlan} → ${d.newPlan}`);
    if (d.subject) parts.push(`"${d.subject}"`);
    if (d.recipient) parts.push(`→ ${d.recipient}`);
    if (d.reason) parts.push(`Dôvod: ${d.reason}`);
    if (d.changedFields) parts.push(`Polia: ${d.changedFields.join(', ')}`);
    if (d.email && !d.oldRole && !d.oldPlan) parts.push(d.email);
    return parts.length > 0 ? <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{parts.join(' · ')}</span> : null;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Audit Log <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '14px' }}>({total} záznamov)</span></h2>
      </div>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select value={filters.category} onChange={e => { setFilters(f => ({ ...f, category: e.target.value })); setPage(1); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', background: 'var(--bg-primary)' }}>
          <option value="">Všetky kategórie</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
          placeholder="Od" />
        <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
          placeholder="Do" />
        <input type="text" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Hľadať meno, email, akciu..."
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1, minWidth: '150px' }} />
        <button type="submit" className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 14px' }}>Hľadať</button>
      </form>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Načítavam...</div>
      ) : logs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Žiadne záznamy</div>
      ) : (
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Dátum</th>
                <th>Používateľ</th>
                <th>Akcia</th>
                <th>Cieľ</th>
                <th>Detaily</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id || log._id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '12px' }}>{formatDateTime(log.createdAt)}</td>
                  <td>
                    <div style={{ fontSize: '13px', fontWeight: 500 }}>{log.username || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{log.email || ''}</div>
                  </td>
                  <td>
                    <span style={{ fontSize: '13px' }}>{ACTION_LABELS[log.action] || log.action}</span>
                  </td>
                  <td>
                    <div style={{ fontSize: '13px' }}>{log.targetName || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{log.targetType || ''}</div>
                  </td>
                  <td>{renderDetails(log)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ fontSize: '13px', padding: '4px 12px' }}>←</button>
          <span style={{ fontSize: '13px', padding: '4px 8px', color: 'var(--text-secondary)' }}>{page} / {totalPages}</span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ fontSize: '13px', padding: '4px 12px' }}>→</button>
        </div>
      )}

      <AdminHelpToggle title="Audit log">
        <p><strong>Čo tu vidíš:</strong> kompletnú históriu zmien v aplikácii — kto, kedy, čo zmenil. Slúži na forenznú analýzu a compliance.</p>
        <ul>
          <li><strong>Filtre</strong> hore — kategória (Používateľ, Workspace, Kontakt, Úloha, Správa, Auth, Fakturácia, Systém), dátumový rozsah, vyhľadávanie podľa user-a alebo cieľa.</li>
          <li><strong>Riadok záznamu</strong>:
            <ul>
              <li>🕐 timestamp + IP adresa (ak je k dispozícii)</li>
              <li>👤 kto akciu vykonal (username + email; "system" ak išlo o cron / automatizáciu)</li>
              <li>📋 akcia + cieľ (napr. "💳 Zmena plánu — Marek Novák")</li>
              <li>kategória ako badge vpravo</li>
            </ul>
          </li>
          <li><strong>Detaily záznamu</strong> — klik rozbalí JSON s pred/po hodnotami (napr. <code>oldPlan: free, plan: pro</code>).</li>
          <li><strong>Stránkovanie</strong> — typicky 50 záznamov na stranu.</li>
        </ul>
        <p><strong>Tipy:</strong> Najčastejšie audit akcie:</p>
        <ul>
          <li><strong>user.plan_auto_expired</strong> — automatický downgrade na Free po vypršaní paidUntil</li>
          <li><strong>user.discount_applied/removed</strong> — admin pridal/odstránil zľavu</li>
          <li><strong>user.subscription_updated</strong> — admin manuálne zmenil plán/paidUntil</li>
          <li><strong>auth.login</strong> — prihlásenie (failed pokusy sa logujú v Diagnostika → Active)</li>
        </ul>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: CHARTS TAB ────────────────────────────────────────────
const chartColors = {
  primary: '#8B5CF6',
  primaryLight: 'rgba(139, 92, 246, 0.1)',
  green: '#22C55E',
  greenLight: 'rgba(34, 197, 94, 0.1)',
  blue: '#3B82F6',
  orange: '#F59E0B',
  red: '#EF4444',
  gray: '#6B7280'
};

function ChartsTab() {
  const [userGrowth, setUserGrowth] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminApi.get(`/api/admin/charts/user-growth?days=${days}`).then(r => r.data).catch(() => []),
      adminApi.get(`/api/admin/charts/activity?days=${days}`).then(r => r.data).catch(() => [])
    ]).then(([ug, act]) => {
      setUserGrowth(ug);
      setActivity(act);
    }).finally(() => setLoading(false));
  }, [days]);

  if (loading) return <div className="sa-loading">Načítavam grafy...</div>;

  const formatLabel = (d) => {
    const date = new Date(d);
    return `${date.getDate()}.${date.getMonth() + 1}.`;
  };

  const growthData = userGrowth && {
    labels: userGrowth.map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Celkovo používateľov',
        data: userGrowth.map(d => d.cumulative),
        borderColor: chartColors.primary,
        backgroundColor: chartColors.primaryLight,
        fill: true,
        tension: 0.3,
        yAxisID: 'y'
      },
      {
        label: 'Nové registrácie',
        data: userGrowth.map(d => d.daily),
        borderColor: chartColors.green,
        backgroundColor: chartColors.greenLight,
        fill: true,
        tension: 0.3,
        yAxisID: 'y1'
      }
    ]
  };

  const activityData = activity && {
    labels: activity.map(d => formatLabel(d.date)),
    datasets: [
      { label: 'Kontakty', data: activity.map(d => d.contact || 0), backgroundColor: chartColors.blue, stack: 'a' },
      { label: 'Úlohy', data: activity.map(d => d.task || 0), backgroundColor: chartColors.green, stack: 'a' },
      { label: 'Správy', data: activity.map(d => d.message || 0), backgroundColor: chartColors.orange, stack: 'a' },
      { label: 'Auth', data: activity.map(d => d.auth || 0), backgroundColor: chartColors.gray, stack: 'a' }
    ]
  };

  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 12 } } } },
    scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 15, font: { size: 11 } } } }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Grafy a analytika</h2>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
          <option value={7}>7 dní</option>
          <option value={30}>30 dní</option>
          <option value={90}>90 dní</option>
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '24px' }}>
        {growthData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>Rast používateľov</h3>
            <div style={{ height: '300px' }}>
              <Line data={growthData} options={{
                ...chartOpts,
                scales: {
                  ...chartOpts.scales,
                  y: { position: 'left', title: { display: true, text: 'Celkovo', font: { size: 11 } } },
                  y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Denne', font: { size: 11 } } }
                }
              }} />
            </div>
          </div>
        )}

        {activityData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>Aktivita podľa kategórie</h3>
            <div style={{ height: '300px' }}>
              <Bar data={activityData} options={{
                ...chartOpts,
                scales: { ...chartOpts.scales, x: { ...chartOpts.scales.x, stacked: true }, y: { stacked: true } }
              }} />
            </div>
          </div>
        )}
      </div>

      <AdminHelpToggle title="Grafy">
        <p><strong>Čo tu vidíš:</strong> vizuálne trendy rastu aplikácie — registrácie, aktivita, plány v čase.</p>
        <ul>
          <li><strong>Registrácie podľa dní</strong> — line chart, koľko nových userov pribudlo za posledných N dní.</li>
          <li><strong>Plány v čase</strong> — stacked bar chart, distribúcia Free/Tím/Pro užívateľov v jednotlivých dňoch.</li>
          <li><strong>Aktivita</strong> — počet vytvorených kontaktov / projektov / správ za obdobie.</li>
          <li><strong>Doughnut</strong> — aktuálny snapshot rozdelenia plánov / rolí.</li>
        </ul>
        <p><strong>Tipy:</strong> Grafy fetchujú agregované dáta zo servera (žiadny per-user lookup), preto sú rýchle aj pri tisícoch userov. Hover na bod ukáže presnú hodnotu pre daný deň. Toto je read-only pohľad — pre úpravy choď do tabu Používatelia.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: ACTIVITY FEED TAB ─────────────────────────────────────
function ActivityFeedTab() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timerRef = useRef(null);

  const fetchEvents = useCallback((after) => {
    const params = after ? `?after=${after}&limit=20` : '?limit=50';
    return adminApi.get(`/api/admin/activity-feed${params}`).then(r => r.data).catch(() => []);
  }, []);

  useEffect(() => {
    fetchEvents().then(data => { setEvents(data); setLoading(false); });
  }, [fetchEvents]);

  // Auto-refresh every 10s
  useEffect(() => {
    if (!autoRefresh) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(async () => {
      if (events.length === 0) return;
      const latest = events[0]?.createdAt;
      if (!latest) return;
      const newEvents = await fetchEvents(latest);
      if (newEvents.length > 0) {
        setEvents(prev => [...newEvents, ...prev].slice(0, 200));
      }
    }, 10000);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, events, fetchEvents]);

  const formatTime = (d) => {
    const date = new Date(d);
    const now = new Date();
    const diffMs = now - date;
    if (diffMs < 60000) return 'práve teraz';
    if (diffMs < 3600000) return `pred ${Math.floor(diffMs / 60000)} min`;
    if (diffMs < 86400000) return `pred ${Math.floor(diffMs / 3600000)} h`;
    return date.toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const actionIcons = {
    'auth.login': '🔓', 'auth.register': '📝',
    'contact.created': '➕', 'contact.updated': '✏️', 'contact.deleted': '🗑️',
    'task.created': '📋', 'task.completed': '✅', 'task.deleted': '🗑️',
    'message.created': '📨', 'message.approved': '✅', 'message.rejected': '❌',
    'user.role_changed': '🔑', 'user.plan_changed': '💳', 'user.deleted': '🗑️',
    'workspace.deleted': '🏢'
  };

  if (loading) return <div className="sa-loading">Načítavam aktivitu...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>
          Live aktivita
          {autoRefresh && <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#22C55E', marginLeft: '8px', animation: 'pulse 2s infinite' }}></span>}
        </h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto-refresh (10s)
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '70vh', overflow: 'auto' }}>
        {events.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Žiadna aktivita</div>}
        {events.map((e, i) => (
          <div key={e.id || i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 12px', background: i === 0 && events.length > 1 ? 'var(--primary-light, #EDE9FE)' : 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px', transition: 'background 0.3s' }}>
            <span style={{ fontSize: '16px', flexShrink: 0 }}>{actionIcons[e.action] || '📌'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <strong>{e.username || '—'}</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: '4px' }}>{ACTION_LABELS[e.action] || e.action}</span>
                {e.targetName && <span style={{ marginLeft: '4px' }}>— {e.targetName}</span>}
              </div>
              {e.details && (e.details.oldRole || e.details.oldPlan || e.details.subject) && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {e.details.oldRole && e.details.newRole && `${e.details.oldRole} → ${e.details.newRole}`}
                  {e.details.oldPlan && e.details.newPlan && `${e.details.oldPlan} → ${e.details.newPlan}`}
                  {e.details.subject && `"${e.details.subject}"`}
                </div>
              )}
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{formatTime(e.createdAt)}</span>
          </div>
        ))}
      </div>

      <AdminHelpToggle title="Aktivita">
        <p><strong>Čo tu vidíš:</strong> live feed posledných akcií v aplikácii (auth.login, contact.created, task.completed atď.) — krátkejšia verzia Audit logu, určená na rýchly prehľad.</p>
        <ul>
          <li><strong>Real-time aktivita</strong> — zoznam najnovších akcií z AuditLog s timestampom a meno user-a.</li>
          <li><strong>Detaily zmien</strong> — pri zmene plánu/role vidíš pred/po hodnoty (napr. <code>free → pro</code>).</li>
          <li><strong>Subject</strong> — pri správach zobrazí predmet (subject) v úvodzovkách.</li>
        </ul>
        <p><strong>Tipy:</strong> Pre detailnejšie filtrovanie a stránkovanie použi tab <strong>Audit log</strong>. Tento tab je skôr "kuchynský" pohľad — vidíš tu dianie v aplikácii za uplynulé minúty/hodiny.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: API METRICS TAB ───────────────────────────────────────
function ApiMetricsTab() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/api-metrics')
      .then(r => setMetrics(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam API metriky...</div>;
  if (!metrics) return <div className="sa-error">Nepodarilo sa načítať metriky</div>;

  const hourlyData = {
    labels: metrics.hourlyData.map(h => h.hour.slice(11) + ':00'),
    datasets: [{
      label: 'Requesty/hod',
      data: metrics.hourlyData.map(h => h.count),
      backgroundColor: chartColors.primaryLight,
      borderColor: chartColors.primary,
      fill: true,
      tension: 0.3
    }]
  };

  const statusData = {
    labels: Object.keys(metrics.statusCodes).map(c => `${c} ${parseInt(c) < 400 ? 'OK' : parseInt(c) < 500 ? 'Client Err' : 'Server Err'}`),
    datasets: [{
      data: Object.values(metrics.statusCodes),
      backgroundColor: Object.keys(metrics.statusCodes).map(c => parseInt(c) < 400 ? chartColors.green : parseInt(c) < 500 ? chartColors.orange : chartColors.red)
    }]
  };

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>API Metriky</h2>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {[
          { label: 'Celkom requestov', value: metrics.totalRequests.toLocaleString() },
          { label: 'Req/min (avg)', value: metrics.requestsPerMinute },
          { label: 'Error rate', value: `${metrics.errorRate}%` },
          { label: 'Tracking od', value: new Date(metrics.trackingSince).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '12px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: '20px', fontWeight: 700 }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Hourly chart */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Requesty za posledných 24h</h3>
          <div style={{ height: '250px' }}>
            <Line data={hourlyData} options={{
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 10 } } } }
            }} />
          </div>
        </div>

        {/* Status codes */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Status kódy</h3>
          <div style={{ height: '250px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {Object.keys(metrics.statusCodes).length > 0 ? (
              <Doughnut data={statusData} options={{
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
              }} />
            ) : <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Žiadne dáta</span>}
          </div>
        </div>
      </div>

      {/* Top routes */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Top endpointy</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '400px', overflow: 'auto' }}>
          {metrics.topRoutes.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: '12px', fontFamily: 'monospace' }}>
              <span style={{ flex: 1 }}>{r.route}</span>
              <div style={{ display: 'flex', gap: '16px', flexShrink: 0 }}>
                <span style={{ color: 'var(--text-muted)' }}>{Object.entries(r.methods || {}).map(([m, c]) => `${m}:${c}`).join(' ')}</span>
                <span style={{ fontWeight: 600, minWidth: '50px', textAlign: 'right' }}>{r.total}x</span>
                <span style={{ color: 'var(--text-muted)', minWidth: '60px', textAlign: 'right' }}>{r.avgDuration}ms</span>
              </div>
            </div>
          ))}
          {metrics.topRoutes.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Žiadne dáta — metriky sa začnú zbierať po reštarte servera</div>}
        </div>
      </div>

      <AdminHelpToggle title="API metriky">
        <p><strong>Čo tu vidíš:</strong> štatistiky výkonu serverového API — koľko requestov sa volá, ktoré endpointy sú najťažšie, error rate.</p>
        <ul>
          <li><strong>Total requests</strong> — kumulatívny počet HTTP requestov za uplynulé obdobie.</li>
          <li><strong>Error rate</strong> — % requestov s 4xx/5xx odpoveďou. Zdravé je &lt; 1%.</li>
          <li><strong>Avg duration</strong> — priemerný čas odpovede v ms. Endpointy nad 500 ms sú kandidáti na optimalizáciu.</li>
          <li><strong>Top routes</strong> — endpointy s najvyšším počtom volaní; ukazuje aj per-route avgDuration.</li>
        </ul>
        <p><strong>Tipy:</strong> Metriky sa zbierajú in-memory v server procese (apiMetrics service) — pri reštarte servera sa vynulujú. Ak vidíš dlhý avg duration na konkrétnom endpointe → preplauj queries (Mongo indexy), pridaj caching, alebo presuni výpočet do background.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: STORAGE TAB ───────────────────────────────────────────
function StorageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/storage')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam storage metriky...</div>;
  if (!data) return <div className="sa-error">Nepodarilo sa načítať storage</div>;

  const fmtSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  };

  const collLabels = { users: 'Používatelia', contacts: 'Kontakty', tasks: 'Úlohy', messages: 'Správy', notifications: 'Notifikácie', auditlogs: 'Audit log', pages: 'Stránky', workspaces: 'Workspace-y', workspacemembers: 'Členstvá', pushsubscriptions: 'Push subs', apnsdevices: 'APNs zariadenia' };

  const collectionData = {
    labels: data.collections.map(c => collLabels[c.name] || c.name),
    datasets: [{
      data: data.collections.map(c => c.size),
      backgroundColor: [chartColors.primary, chartColors.blue, chartColors.green, chartColors.orange, chartColors.red, chartColors.gray, '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1']
    }]
  };

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>Storage metriky</h2>

      {/* DB overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {[
          { label: 'Dáta', value: fmtSize(data.database.dataSize) },
          { label: 'Storage', value: fmtSize(data.database.storageSize) },
          { label: 'Indexy', value: fmtSize(data.database.indexSize) },
          { label: 'Kolekcie', value: data.database.collections }
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '12px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: '20px', fontWeight: 700 }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Collection breakdown chart */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Veľkosť kolekcií</h3>
          <div style={{ height: '280px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Doughnut data={collectionData} options={{
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } } }
            }} />
          </div>
        </div>

        {/* Collection table */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Detaily kolekcií</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px' }}>
            {data.collections.map(c => (
              <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ fontWeight: 500 }}>{collLabels[c.name] || c.name}</span>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: '50px', textAlign: 'right' }}>{c.count.toLocaleString()} dok.</span>
                  <span style={{ fontWeight: 600, minWidth: '70px', textAlign: 'right' }}>{fmtSize(c.size)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Per workspace */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Storage per workspace</h3>
        <div className="sa-table-wrap" style={{ width: '100%' }}>
          {/* width: 100% — bez tohto sa table autosizuje na šírku obsahu
              (default <table> behavior) a pri 6 úzkych stĺpcoch zaberá len
              ~40% šírky karty. Comparison tab to nemá lebo má 11 stĺpcov
              ktoré sami zaplnia šírku. */}
          <table className="sa-table" style={{ fontSize: '12px', width: '100%' }}>
            <thead>
              <tr>
                <th>Workspace</th>
                <th style={{ textAlign: 'right' }}>Kontakty</th>
                <th style={{ textAlign: 'right' }}>Úlohy</th>
                <th style={{ textAlign: 'right' }}>Správy</th>
                <th style={{ textAlign: 'right' }}>Celkom dok.</th>
                <th style={{ textAlign: 'right' }}>Odhad veľkosti</th>
              </tr>
            </thead>
            <tbody>
              {data.perWorkspace.map(w => (
                <tr key={w.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: w.color, flexShrink: 0 }}></span>
                      {w.name}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>{w.contacts}</td>
                  <td style={{ textAlign: 'right' }}>{w.tasks}</td>
                  <td style={{ textAlign: 'right' }}>{w.messages}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{w.totalDocs}</td>
                  <td style={{ textAlign: 'right' }}>{fmtSize(w.estimatedSize)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AdminHelpToggle title="Storage">
        <p><strong>Čo tu vidíš:</strong> využitie databázy MongoDB — koľko miesta zaberajú jednotlivé kolekcie a ktoré workspace-y ich najviac napĺňajú.</p>
        <ul>
          <li><strong>Kolekcie</strong> — zoznam všetkých Mongo kolekcií (users, contacts, tasks, messages, notifications, auditlogs, pages, workspaces, workspacemembers, pushsubscriptions, apnsdevices) s počtom dokumentov a estimated size.</li>
          <li><strong>Top workspace-y</strong> — kto produkuje najviac dát (kontakty + úlohy + správy spolu).</li>
        </ul>
        <p><strong>Tipy:</strong> Render Mongo (alebo váš poskytovateľ) má fixné limity — keď sa blížiš k stropu, treba buď pricovať vyšší tier, alebo cleanovať staré dáta. <strong>auditlogs</strong> kolekcia rastie najrýchlejšie — zvážiť TTL index na dokumenty staršie ako 1 rok ak treba šetriť priestor.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: WORKSPACE COMPARISON TAB ──────────────────────────────
function WorkspaceComparisonTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('activityScore');

  useEffect(() => {
    adminApi.get('/api/admin/workspace-comparison')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam porovnanie...</div>;
  if (!data || data.length === 0) return <div className="sa-empty">Žiadne workspace-y</div>;

  const sorted = [...data].sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
  const maxScore = Math.max(...data.map(d => d.activityScore || 1));

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';

  // Chart agreguje "real work units" — kontakty, projekty + úlohy v nich,
  // a správy. Pred fixom rátal len projekty (top-level Task docs), takže
  // workspace s 1 projektom + 100 úlohami vyzeral rovnako "veľký" ako
  // workspace s 1 prázdnym projektom.
  const comparisonChart = {
    labels: sorted.slice(0, 10).map(w => w.name),
    datasets: [
      { label: 'Kontakty', data: sorted.slice(0, 10).map(w => w.contacts), backgroundColor: chartColors.blue },
      { label: 'Projekty', data: sorted.slice(0, 10).map(w => w.projects ?? w.tasks), backgroundColor: chartColors.green },
      { label: 'Úlohy', data: sorted.slice(0, 10).map(w => w.subtasks ?? 0), backgroundColor: chartColors.purple || '#a78bfa' },
      { label: 'Správy', data: sorted.slice(0, 10).map(w => w.messages), backgroundColor: chartColors.orange }
    ]
  };

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>Porovnanie workspace-ov</h2>

      {/* Chart */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)', marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Top 10 workspace-ov podľa aktivity</h3>
        <div style={{ height: '280px' }}>
          <Bar data={comparisonChart} options={{
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
            scales: { x: { stacked: true }, y: { stacked: true, ticks: { font: { size: 11 } } } }
          }} />
        </div>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600 }}>Detailné porovnanie</h3>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '12px' }}>
            <option value="activityScore">Podľa aktivity</option>
            <option value="contacts">Podľa kontaktov</option>
            <option value="projects">Podľa projektov</option>
            <option value="subtasks">Podľa úloh</option>
            <option value="messages">Podľa správ</option>
            <option value="members">Podľa členov</option>
            <option value="completionRate">Podľa dokončenia</option>
          </select>
        </div>
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ fontSize: '12px' }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Workspace</th>
                <th>Vlastník</th>
                <th style={{ textAlign: 'right' }}>Členovia</th>
                <th style={{ textAlign: 'right' }}>Kontakty</th>
                <th style={{ textAlign: 'right' }} title="Top-level projekty (Task dokumenty)">Projekty</th>
                <th style={{ textAlign: 'right' }} title="Úlohy (subtasky) vrátane všetkých zanorených úrovní">Úlohy</th>
                <th style={{ textAlign: 'right' }} title="% dokončených úloh (alebo projektov, ak workspace nemá úlohy)">Dokončené</th>
                <th style={{ textAlign: 'right' }}>Správy</th>
                <th>Posledná aktivita</th>
                <th>Skóre</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((w, i) => {
                // Backward-compat: staré API verzie nemali projects/subtasks polia
                // (vracali len `tasks` = projekty); zachováme rendering aj v tom
                // prípade, len úlohy ukáže "—".
                const projects = w.projects ?? w.tasks ?? 0;
                const subtasks = w.subtasks ?? null;
                const subtasksCompleted = w.subtasksCompleted ?? null;
                return (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{i + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: w.color, flexShrink: 0 }}></span>
                      <span style={{ fontWeight: 500 }}>{w.name}</span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{w.owner}</td>
                  <td style={{ textAlign: 'right' }}>{w.members}</td>
                  <td style={{ textAlign: 'right' }}>{w.contacts}</td>
                  <td style={{ textAlign: 'right' }}>{projects}</td>
                  <td style={{ textAlign: 'right' }}>
                    {subtasks !== null
                      ? (subtasksCompleted !== null && subtasks > 0
                          ? <span title={`${subtasksCompleted} dokončených z ${subtasks}`}>{subtasksCompleted}/{subtasks}</span>
                          : subtasks)
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: w.completionRate > 50 ? chartColors.green : w.completionRate > 20 ? chartColors.orange : chartColors.red }}>{w.completionRate}%</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{w.messages}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatDate(w.lastActivity)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ flex: 1, height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${(w.activityScore / maxScore) * 100}%`, height: '100%', background: chartColors.primary, borderRadius: '3px' }}></div>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '30px' }}>{w.activityScore}</span>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AdminHelpToggle title="Porovnanie">
        <p><strong>Čo tu vidíš:</strong> tabuľkové porovnanie všetkých workspace-ov — koľko kontaktov, projektov, úloh, správ a členov má každý.</p>
        <ul>
          <li><strong>Stĺpce</strong>:
            <ul>
              <li><strong>Projekty</strong> — top-level Task dokumenty v DB (UI ich volá "Projekty").</li>
              <li><strong>Úlohy</strong> — počet úloh (subtasks) vrátane všetkých zanorených úrovní. Zobrazené ako <code>{'<dokončené>'}/{'<celkom>'}</code> ak existuje aspoň jedna úloha.</li>
              <li><strong>Dokončené</strong> — % dokončenosti počítané z úrovne úloh (ak workspace má aspoň jednu úlohu); inak fallback na úroveň projektov.</li>
            </ul>
          </li>
          <li><strong>Sortovanie</strong> — selectbox vpravo, prepínač medzi metrikami (aktivita, kontakty, projekty, úlohy, správy, členovia, % dokončenia).</li>
          <li><strong>Skóre aktivity</strong> — vážený metric: kontakty × 2 + projekty × 3 + úlohy × 1 + správy × 1. Po fixe reaguje aj na pridávanie úloh do existujúcich projektov (predtým rátalo len projekty).</li>
        </ul>
        <p><strong>Pred fixom (do tohto deployu)</strong>: stĺpec "Úlohy" rátal len projekty (top-level Task dokumenty). Workspace s 1 projektom označeným ako dokončený a 50 nedokončenými úlohami vnútri ukazoval "Dokončené: 100%". Po fixe sa % počíta z úloh, takže reálne reflektuje koľko práce je hotovej.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── PROMO CODES TAB ──────────────────────────────────────────
const PROMO_TYPES = {
  percentage: { label: 'Percentuálna zľava', unit: '%', icon: '🏷️' },
  fixed: { label: 'Fixná zľava', unit: '€', icon: '💶' },
  freeMonths: { label: 'Voľné mesiace', unit: 'mes.', icon: '🎁' }
};

function PromoCodesTab() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedCode, setSelectedCode] = useState(null);
  const [stats, setStats] = useState(null);

  // Form state
  const [form, setForm] = useState({
    code: '', name: '', type: 'percentage', value: '',
    duration: 'once', durationInMonths: '3',
    validForPlans: [], validForPeriods: [],
    maxUses: '', maxUsesPerUser: '1', expiresAt: ''
  });

  const fetchCodes = useCallback(async () => {
    try {
      const res = await adminApi.get('/api/admin/promo-codes');
      setCodes(res.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const resetForm = () => {
    setForm({ code: '', name: '', type: 'percentage', value: '', duration: 'once', durationInMonths: '3', validForPlans: [], validForPeriods: [], maxUses: '', maxUsesPerUser: '1', expiresAt: '' });
    setShowForm(false);
  };

  const generateCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'PRPL-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    setForm(f => ({ ...f, code }));
  };

  const handleCreate = async () => {
    if (!form.code || !form.name || !form.value) {
      alert('Vyplňte kód, názov a hodnotu');
      return;
    }
    setSaving(true);
    try {
      await adminApi.post('/api/admin/promo-codes', {
        ...form,
        value: parseFloat(form.value),
        // Pre freeMonths server ignoruje duration a nastaví si 'repeating' sám.
        // Pre ostatné typy posielame zvolenú hodnotu + mesiace keď ide o 'repeating'.
        duration: form.type === 'freeMonths' ? 'repeating' : form.duration,
        durationInMonths: form.duration === 'repeating' && form.type !== 'freeMonths'
          ? parseInt(form.durationInMonths, 10) || null
          : null,
        maxUses: form.maxUses ? parseInt(form.maxUses) : 0,
        maxUsesPerUser: form.maxUsesPerUser ? parseInt(form.maxUsesPerUser) : 1,
        expiresAt: form.expiresAt || null
      });
      resetForm();
      fetchCodes();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní kódu');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id, isActive) => {
    try {
      await adminApi.put(`/api/admin/promo-codes/${id}`, { isActive: !isActive });
      fetchCodes();
    } catch {
      alert('Chyba pri aktualizácii');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Naozaj vymazať tento promo kód?')) return;
    try {
      await adminApi.delete(`/api/admin/promo-codes/${id}`);
      fetchCodes();
      if (selectedCode?._id === id) { setSelectedCode(null); setStats(null); }
    } catch {
      alert('Chyba pri mazaní');
    }
  };

  const viewStats = async (code) => {
    setSelectedCode(code);
    try {
      const res = await adminApi.get(`/api/admin/promo-codes/${code._id}/stats`);
      setStats(res.data);
    } catch {
      setStats(null);
    }
  };

  const togglePlan = (plan) => {
    setForm(f => ({
      ...f,
      validForPlans: f.validForPlans.includes(plan)
        ? f.validForPlans.filter(p => p !== plan)
        : [...f.validForPlans, plan]
    }));
  };

  const togglePeriod = (period) => {
    setForm(f => ({
      ...f,
      validForPeriods: f.validForPeriods.includes(period)
        ? f.validForPeriods.filter(p => p !== period)
        : [...f.validForPeriods, period]
    }));
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';
  const isExpired = (d) => d && new Date(d) < new Date();

  const cardStyle = { padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', marginBottom: '12px' };
  const labelStyle = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' };
  const inputStyle = { padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', width: '100%', boxSizing: 'border-box' };
  const chipStyle = (active) => ({ padding: '4px 10px', borderRadius: '12px', fontSize: '11px', cursor: 'pointer', border: `1px solid ${active ? 'var(--primary, #8B5CF6)' : 'var(--border-color)'}`, background: active ? 'var(--primary, #8B5CF6)' : 'transparent', color: active ? '#fff' : 'var(--text-secondary)', fontWeight: 500 });

  if (loading) return <div className="sa-loading">Načítavam promo kódy...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 600 }}>Promo kódy ({codes.length})</h3>
        {!showForm && (
          <button className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 16px' }} onClick={() => setShowForm(true)}>
            + Nový kód
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <div style={{ ...cardStyle, border: '1px solid var(--primary, #8B5CF6)' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Nový promo kód</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>Kód *</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input style={{ ...inputStyle, flex: 1, textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 600 }}
                  value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="PRPL-AKCIA50" />
                <button onClick={generateCode} style={{ padding: '4px 10px', fontSize: '11px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', cursor: 'pointer', background: 'var(--bg-primary)', whiteSpace: 'nowrap' }}>
                  Generovať
                </button>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Názov (interný) *</label>
              <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Jarná akcia 2026" />
            </div>
            <div>
              <label style={labelStyle}>Typ zľavy *</label>
              <select style={inputStyle} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                {Object.entries(PROMO_TYPES).map(([key, t]) => (
                  <option key={key} value={key}>{t.icon} {t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Hodnota * ({PROMO_TYPES[form.type]?.unit})</label>
              <input style={inputStyle} type="number" min="1" value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder={form.type === 'percentage' ? '20' : form.type === 'fixed' ? '5.00' : '3'} />
            </div>

            {/* Platnosť zľavy — iba pre percentage a fixed. freeMonths má implicitne 'repeating' = X mesiacov,
                ten počet zadáva používateľ v poli "Hodnota". */}
            {form.type !== 'freeMonths' && (
              <>
                <div>
                  <label style={labelStyle}>Platnosť zľavy *</label>
                  <select
                    style={inputStyle}
                    value={form.duration}
                    onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                  >
                    <option value="once">Len prvá platba</option>
                    <option value="repeating">Opakovane X mesiacov</option>
                    <option value="forever">Navždy (celý život predplatného)</option>
                  </select>
                </div>
                {form.duration === 'repeating' ? (
                  <div>
                    <label style={labelStyle}>Počet mesiacov so zľavou *</label>
                    <input
                      style={inputStyle}
                      type="number"
                      min="1"
                      max="36"
                      value={form.durationInMonths}
                      onChange={e => setForm(f => ({ ...f, durationInMonths: e.target.value }))}
                      placeholder="3"
                    />
                  </div>
                ) : (
                  <div /> /* placeholder aby grid zachoval 2-stĺpcový layout */
                )}
              </>
            )}

            <div>
              <label style={labelStyle}>Platné pre plány (prázdne = všetky)</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <span style={chipStyle(form.validForPlans.includes('team'))} onClick={() => togglePlan('team')}>Tím</span>
                <span style={chipStyle(form.validForPlans.includes('pro'))} onClick={() => togglePlan('pro')}>Pro</span>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Platné pre obdobie (prázdne = obe)</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <span style={chipStyle(form.validForPeriods.includes('monthly'))} onClick={() => togglePeriod('monthly')}>Mesačne</span>
                <span style={chipStyle(form.validForPeriods.includes('yearly'))} onClick={() => togglePeriod('yearly')}>Ročne</span>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Max. použití (0 = neobmedzené)</label>
              <input style={inputStyle} type="number" min="0" value={form.maxUses}
                onChange={e => setForm(f => ({ ...f, maxUses: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <label style={labelStyle}>Max. na používateľa</label>
              <input style={inputStyle} type="number" min="0" value={form.maxUsesPerUser}
                onChange={e => setForm(f => ({ ...f, maxUsesPerUser: e.target.value }))} placeholder="1" />
            </div>
            <div>
              <label style={labelStyle}>Platnosť do</label>
              <input style={inputStyle} type="datetime-local" value={form.expiresAt}
                onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 14px' }} onClick={resetForm}>Zrušiť</button>
            <button className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 14px' }} disabled={saving} onClick={handleCreate}>
              {saving ? 'Vytváram...' : 'Vytvoriť kód'}
            </button>
          </div>
        </div>
      )}

      {/* Code list */}
      {codes.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎟️</div>
          <p>Žiadne promo kódy</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {codes.map(c => {
            const expired = isExpired(c.expiresAt);
            const exhausted = c.maxUses > 0 && c.usedCount >= c.maxUses;
            const inactive = !c.isActive || expired || exhausted;
            return (
              <div key={c._id} style={{ ...cardStyle, opacity: inactive ? 0.6 : 1, marginBottom: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <code style={{ fontSize: '15px', fontWeight: 700, color: 'var(--primary, #8B5CF6)', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                        {c.code}
                      </code>
                      {!c.isActive && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#FEE2E2', color: '#DC2626', fontWeight: 600 }}>NEAKTÍVNY</span>}
                      {expired && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#FEF3C7', color: '#D97706', fontWeight: 600 }}>EXPIROVANÝ</span>}
                      {exhausted && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#FEE2E2', color: '#DC2626', fontWeight: 600 }}>VYČERPANÝ</span>}
                      {c.stripeCouponId && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#DBEAFE', color: '#2563EB', fontWeight: 600 }}>STRIPE</span>}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{c.name}</div>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                      <span>{PROMO_TYPES[c.type]?.icon} {c.value}{PROMO_TYPES[c.type]?.unit}</span>
                      <span>
                        {/* Ľudsky zrozumiteľná platnosť zľavy. freeMonths má duration
                            vždy 'repeating' — vtedy je počet totožný s hodnotou. */}
                        ⏱️ {
                          c.type === 'freeMonths'
                            ? `${c.value} mes. zdarma`
                            : c.duration === 'once'
                              ? 'Len 1. platba'
                              : c.duration === 'forever'
                                ? 'Navždy'
                                : c.duration === 'repeating' && c.durationInMonths
                                  ? `${c.durationInMonths} mes. opakovane`
                                  : 'Len 1. platba'
                        }
                      </span>
                      <span>Použití: {c.usedCount}{c.maxUses > 0 ? `/${c.maxUses}` : '/∞'}</span>
                      {c.expiresAt && <span>Do: {formatDate(c.expiresAt)}</span>}
                      {c.validForPlans?.length > 0 && <span>Plány: {c.validForPlans.join(', ')}</span>}
                      {c.validForPeriods?.length > 0 && <span>Obdobie: {c.validForPeriods.map(p => p === 'monthly' ? 'mes.' : 'ročne').join(', ')}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button onClick={() => viewStats(c)} title="Štatistiky"
                      style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', padding: '4px' }}>📊</button>
                    <button onClick={() => handleToggle(c._id, c.isActive)} title={c.isActive ? 'Deaktivovať' : 'Aktivovať'}
                      style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', padding: '4px' }}>
                      {c.isActive ? '⏸️' : '▶️'}
                    </button>
                    <button onClick={() => handleDelete(c._id)} title="Vymazať"
                      style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', padding: '4px' }}>🗑️</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Stats modal */}
      {selectedCode && stats && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => { setSelectedCode(null); setStats(null); }}>
          <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)', padding: '24px', maxWidth: '500px', width: '90%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600 }}>
                📊 {stats.code} — {stats.name}
              </h3>
              <button onClick={() => { setSelectedCode(null); setStats(null); }}
                style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
              <div style={{ ...cardStyle, flex: 1, textAlign: 'center', marginBottom: 0 }}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--primary, #8B5CF6)' }}>{stats.usedCount}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Použití</div>
              </div>
              <div style={{ ...cardStyle, flex: 1, textAlign: 'center', marginBottom: 0 }}>
                <div style={{ fontSize: '24px', fontWeight: 700 }}>{stats.maxUses || '∞'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Max. limit</div>
              </div>
              <div style={{ ...cardStyle, flex: 1, textAlign: 'center', marginBottom: 0 }}>
                <div style={{ fontSize: '24px' }}>{stats.isValid ? '✅' : '❌'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Stav</div>
              </div>
            </div>
            {stats.redemptions?.length > 0 ? (
              <div>
                <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Použitia</h4>
                {stats.redemptions.map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: '12px' }}>
                    <span>{r.user?.username || 'Neznámy'} ({r.user?.email})</span>
                    <span style={{ color: 'var(--text-muted)' }}>{r.plan} / {r.period} — {formatDate(r.redeemedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Zatiaľ žiadne použitia</p>
            )}
          </div>
        </div>
      )}

      <AdminHelpToggle title="Promo kódy">
        <p><strong>Čo tu vidíš:</strong> správa promo kódov, ktoré užívatelia môžu uplatniť pri checkoute v Stripe (alebo zobraziť v aplikácii).</p>
        <ul>
          <li><strong>Vytvorenie kódu</strong> — názov (napr. "WELCOME20"), typ:
            <ul>
              <li><strong>Percentuálna zľava</strong> (napr. 20% zľava na prvý mesiac)</li>
              <li><strong>Fixná zľava</strong> (napr. −5 € z faktúry)</li>
              <li><strong>Voľné mesiace</strong> (napr. 2 mesiace zdarma)</li>
            </ul>
          </li>
          <li><strong>Limit použití</strong> — maximálny počet užívateľov, ktorí môžu kód uplatniť (napr. prvých 100).</li>
          <li><strong>Platnosť</strong> — od/do dátumy.</li>
          <li><strong>Stripe sync</strong> — pri vytvorení sa kód propaguje aj do Stripe ako Promotion Code (aby fungoval v ich checkoute). Ak Stripe sync zlyhá, kód existuje len lokálne.</li>
          <li><strong>História použití</strong> — pri každom kóde vidíš zoznam užívateľov, ktorí ho uplatnili + kedy.</li>
        </ul>
        <p><strong>Tipy:</strong> Promo kódy sa od admin-applied zliav (DiscountEditor v Používateľoch) líšia tým, že ich uplatňuje user sám pri checkoute. Discount editor je ručný "darček od admina".</p>
      </AdminHelpToggle>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ─── DIAGNOSTICS TAB ────────────────────────────────────────────────
// SuperAdmin diagnostické centrum. Sub-nav (local state) prepína
// medzi šiestimi sekciami:
//   - Chyby (default) — zoznam 5xx server errorov z našej DB
//   - Výkon — top 10 najpomalších routes + 4xx/5xx rate
//   - Zdravie — Mongo/SMTP/APNs/Google/Memory status
//   - Aktívni — online users + failed logins
//   - Využitie — agregované feature usage z AuditLog
//   - Príjmy — MRR + plans breakdown
// ═══════════════════════════════════════════════════════════════════
function DiagnosticsTab() {
  const [section, setSection] = useState('errors');

  const subTabs = [
    { id: 'errors', label: 'Chyby', icon: '🔴' },
    { id: 'performance', label: 'Výkon', icon: '🟡' },
    { id: 'health', label: 'Zdravie', icon: '🟢' },
    { id: 'active', label: 'Aktívni', icon: '🔵' },
    { id: 'usage', label: 'Využitie', icon: '🟣' },
    { id: 'revenue', label: 'Príjmy', icon: '💰' }
  ];

  return (
    <div className="sa-diagnostics">
      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', flexWrap: 'wrap' }}>
        {subTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setSection(t.id)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: section === t.id ? 'var(--accent-color, #6366f1)' : 'transparent',
              color: section === t.id ? 'white' : 'var(--text-primary)',
              fontSize: '13px',
              cursor: 'pointer',
              fontWeight: section === t.id ? 600 : 400
            }}
          >
            <span style={{ marginRight: '6px' }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {section === 'errors' && <DiagErrorsSection />}
      {section === 'performance' && <DiagPerformanceSection />}
      {section === 'health' && <DiagHealthSection />}
      {section === 'active' && <DiagActiveSection />}
      {section === 'usage' && <DiagUsageSection />}
      {section === 'revenue' && <DiagRevenueSection />}

      <AdminHelpToggle title="Diagnostika">
        <p><strong>Čo tu vidíš:</strong> diagnostické centrum servera — chyby, výkon, zdravie subsystémov, aktívni užívatelia, využitie funkcionalít a príjmy. Každá sekcia má vlastný sub-tab hore.</p>
        <ul>
          <li><strong>🐛 Chyby</strong> — zoznam zachytených 5xx server errorov (z DB cez serverErrorService). Auto-refresh každých 30s. Pri každej chybe vidíš stack trace, request URL, user-a (ak bol prihlásený), timestamp. Klik na riadok → expanded view s plným contextom.</li>
          <li><strong>⚡ Výkon</strong> — top 10 najpomalších endpointov + 4xx/5xx error rate. Slúži na detekciu performance regresií.</li>
          <li><strong>💚 Zdravie</strong> — stav externých subsystémov: MongoDB, SMTP (mailer), APNs (Apple Push), Google OAuth, Memory utilization. Health monitor každých 5 min skontroluje a pri 3× zlyhaní pošle email na support@prplcrm.eu.</li>
          <li><strong>🟢 Aktívni</strong> — práve online používatelia (cez Socket.IO heartbeat) + posledné failed login pokusy (na detekciu brute-force útokov).</li>
          <li><strong>📊 Využitie</strong> — agregované feature usage z AuditLogu — ktoré akcie sú najčastejšie (creating contacts, completing tasks atď.). Pomáha pri prioritizácii feature work.</li>
          <li><strong>💰 Príjmy</strong> — MRR (Monthly Recurring Revenue) + breakdown po plánoch (počet active Tím / Pro user-ov, ich príspevok do MRR). Yearly subscriptions sa rátajú s 0.83× faktorom (12-mesačná zľava).</li>
        </ul>
        <p><strong>Tipy:</strong> Ak vidíš nárast chýb v <strong>Chyby</strong> → najprv pozri timestamp koreláciu s nedávnym deployom v <strong>Audit log</strong>. Pre persistnutie chýb mimo nášho UI máme aj Sentry-like in-house tracking — všetko je v Mongo kolekcii <code>servererrors</code>.</p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── DIAG: ERRORS ───────────────────────────────────────────────────
const ERRORS_POLL_INTERVAL_MS = 30000; // auto-refresh každých 30s

function DiagErrorsSection() {
  const [stats, setStats] = useState(null);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filter, setFilter] = useState({ resolved: 'false', search: '', source: 'all' });
  const [selected, setSelected] = useState(null);

  // `silent` = true pri polling refresh — neukazuje full-page loading overlay,
  // len malý indicator. Bez neho by sa zoznam pri každom 30s tick mihal prázdnym.
  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const params = { page, limit: 30 };
      if (filter.resolved !== 'all') params.resolved = filter.resolved;
      if (filter.source !== 'all') params.source = filter.source;
      if (filter.search) params.search = filter.search;
      const [listRes, statsRes] = await Promise.all([
        adminApi.get('/api/admin/errors', { params }),
        adminApi.get('/api/admin/errors/stats')
      ]);
      setErrors(listRes.data.errors);
      setTotalPages(listRes.data.pages);
      setStats(statsRes.data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Errors load failed', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, filter.resolved, filter.source, filter.search]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh — pozastaví sa keď:
  //  a) používateľ má otvorený detail modal (selected !== null) — nechceme
  //     mu meniť data pod rukami pokiaľ sa na niečo pozerá
  //  b) browser tab nie je viditeľný (šetríme CPU + API calls)
  useEffect(() => {
    if (selected) return;
    const tick = () => {
      if (document.hidden) return;
      load(true);
    };
    const id = setInterval(tick, ERRORS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selected, load]);

  const handleSendToClaude = (err) => {
    const prompt = `Prosím oprav túto chybu v Prpl CRM.

Error: ${err.message}
Status: ${err.statusCode}
Route: ${err.method} ${err.path}
Count: ${err.count}× (prvý výskyt ${new Date(err.firstSeen).toLocaleString('sk-SK')})

Stack:
${err.stack || '(bez stacku)'}

Kontext:
${JSON.stringify(err.context || {}, null, 2)}

User: ${err.userId?.email || 'nezalogovaný'}
Workspace: ${err.workspaceId || 'N/A'}
`;
    navigator.clipboard.writeText(prompt).then(() => {
      alert('Skopírované do schránky. Vlož do Claude Code.');
    }).catch(() => alert('Kopírovanie zlyhalo'));
  };

  const handleResolve = async (err, resolved) => {
    const notes = resolved ? (prompt('Poznámka k opraveniu (voliteľné):') || '') : '';
    try {
      await adminApi.put(`/api/admin/errors/${err._id}/resolve`, { resolved, notes });
      await load();
      setSelected(null);
    } catch (e) {
      alert('Nepodarilo sa zmeniť stav');
    }
  };

  const handleDelete = async (err) => {
    if (!confirm(`Zmazať záznam "${err.message.slice(0, 50)}..."?`)) return;
    try {
      await adminApi.delete(`/api/admin/errors/${err._id}`);
      await load();
      setSelected(null);
    } catch (e) {
      alert('Nepodarilo sa zmazať');
    }
  };

  return (
    <div>
      {/* Stat karty */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
          <DiagStat label="Chyby za 24h" value={stats.count24h} color="#ef4444" />
          <DiagStat label="Chyby za 7d" value={stats.count7d} color="#f59e0b" />
          <DiagStat label="Chyby za 30d" value={stats.count30d} color="#6366f1" />
          <DiagStat label="Neopravené" value={stats.unresolved} color="#ef4444" />
        </div>
      )}

      {/* Filtre */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select
          value={filter.resolved}
          onChange={(e) => { setFilter({ ...filter, resolved: e.target.value }); setPage(1); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px' }}
        >
          <option value="false">Len neopravené</option>
          <option value="true">Len opravené</option>
          <option value="all">Všetky</option>
        </select>
        <select
          value={filter.source}
          onChange={(e) => { setFilter({ ...filter, source: e.target.value }); setPage(1); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px' }}
          title="Zdroj chyby"
        >
          <option value="all">Všetky zdroje</option>
          <option value="server">🖥️ Server</option>
          <option value="client">🌐 Klient (prehliadač/PWA)</option>
        </select>
        <input
          type="text"
          placeholder="Hľadať v message / path..."
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load(); } }}
          style={{ flex: 1, minWidth: '200px', padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px' }}
        />
        <button onClick={() => { setPage(1); load(); }} className="btn btn-secondary" style={{ fontSize: '13px' }}>Hľadať</button>
        <button
          onClick={() => load(true)}
          className="btn btn-secondary"
          style={{ fontSize: '13px' }}
          disabled={refreshing}
          title="Auto-refresh beží každých 30s. Tlačidlom vynútiš okamžitú obnovu."
        >
          {refreshing ? '⟳…' : '⟳'} Obnoviť
        </button>
      </div>

      {/* Stav auto-refresh — indikuje že dáta nie sú statický snapshot */}
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        {selected
          ? '⏸ Auto-refresh pozastavený (otvorený detail)'
          : `Auto-refresh: každých 30 s${lastUpdated ? ` · naposledy ${lastUpdated.toLocaleTimeString('sk-SK')}` : ''}`}
      </div>

      {loading ? <div className="sa-loading">Načítavam...</div> : (
        <>
          {errors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Žiadne chyby 🎉</div>
          ) : (
            <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left' }}>
                    <th style={{ padding: '10px' }}>Posledný výskyt</th>
                    <th style={{ padding: '10px', textAlign: 'center' }}>Zdroj</th>
                    <th style={{ padding: '10px' }}>Route</th>
                    <th style={{ padding: '10px' }}>Message</th>
                    <th style={{ padding: '10px', textAlign: 'center' }}>Count</th>
                    <th style={{ padding: '10px' }}>User</th>
                    <th style={{ padding: '10px', textAlign: 'center' }}>Stav</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map(err => (
                    <tr key={err._id} onClick={() => setSelected(err)} style={{ cursor: 'pointer', borderTop: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(err.lastSeen).toLocaleString('sk-SK')}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontSize: '14px' }} title={err.source === 'client' ? 'Klient (prehliadač)' : 'Server'}>
                        {err.source === 'client' ? '🌐' : '🖥️'}
                      </td>
                      <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: '12px' }}>
                        <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: '3px', background: 'var(--bg-secondary)', marginRight: '6px' }}>{err.method}</span>
                        {err.path}
                      </td>
                      <td style={{ padding: '10px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.message}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 600 }}>{err.count}</td>
                      <td style={{ padding: '10px', fontSize: '12px' }}>{err.userId?.email || '—'}</td>
                      <td style={{ padding: '10px', textAlign: 'center' }}>{err.resolved ? '✅' : '🔴'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn btn-secondary" style={{ fontSize: '13px' }}>◀</button>
              <span style={{ padding: '6px 12px' }}>{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="btn btn-secondary" style={{ fontSize: '13px' }}>▶</button>
            </div>
          )}
        </>
      )}

      {/* Detail modal */}
      {selected && (
        <div
          onClick={() => setSelected(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', padding: '24px', maxWidth: '900px', width: '92%', maxHeight: '85vh', overflow: 'auto' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>Detail chyby</h3>
              <button onClick={() => setSelected(null)} className="btn btn-secondary" style={{ fontSize: '13px' }}>Zavrieť</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '16px', fontSize: '13px' }}>
              <div><strong>Zdroj:</strong> {selected.source === 'client' ? '🌐 Klient (prehliadač/PWA)' : '🖥️ Server'}</div>
              <div><strong>Status:</strong> {selected.statusCode}</div>
              <div><strong>Count:</strong> {selected.count}×</div>
              <div><strong>Route:</strong> <code>{selected.method} {selected.path}</code></div>
              <div><strong>Name:</strong> {selected.name}</div>
              <div><strong>Prvý výskyt:</strong> {new Date(selected.firstSeen).toLocaleString('sk-SK')}</div>
              <div><strong>Posledný:</strong> {new Date(selected.lastSeen).toLocaleString('sk-SK')}</div>
              <div><strong>User:</strong> {selected.userId?.email || 'nezalogovaný'}</div>
              <div><strong>IP:</strong> {selected.ipAddress || '—'}</div>
              {selected.url && <div style={{ gridColumn: 'span 2' }}><strong>URL:</strong> <code style={{ wordBreak: 'break-all' }}>{selected.url}</code></div>}
              {selected.userAgent && <div style={{ gridColumn: 'span 2', fontSize: '11px', color: 'var(--text-muted)' }}><strong>UA:</strong> {selected.userAgent}</div>}
            </div>

            {selected.componentStack && (
              <div style={{ marginBottom: '16px' }}>
                <strong>Component stack (React):</strong>
                <pre style={{ padding: '10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '4px', fontSize: '11px', overflow: 'auto', maxHeight: '200px' }}>{selected.componentStack}</pre>
              </div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <strong>Message:</strong>
              <div style={{ padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '4px', fontFamily: 'monospace', fontSize: '13px' }}>{selected.message}</div>
            </div>

            {selected.stack && (
              <div style={{ marginBottom: '16px' }}>
                <strong>Stack trace:</strong>
                <pre style={{ padding: '10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '4px', fontSize: '11px', overflow: 'auto', maxHeight: '300px' }}>{selected.stack}</pre>
              </div>
            )}

            {selected.context && Object.keys(selected.context).length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <strong>Kontext:</strong>
                <pre style={{ padding: '10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '4px', fontSize: '11px', overflow: 'auto', maxHeight: '200px' }}>{JSON.stringify(selected.context, null, 2)}</pre>
              </div>
            )}

            {selected.notes && (
              <div style={{ marginBottom: '16px' }}>
                <strong>Poznámky:</strong>
                <div style={{ padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '4px', fontSize: '13px' }}>{selected.notes}</div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '20px' }}>
              <button onClick={() => handleSendToClaude(selected)} className="btn btn-primary" style={{ fontSize: '13px' }}>
                🤖 Skopírovať pre Claude
              </button>
              {!selected.resolved ? (
                <button onClick={() => handleResolve(selected, true)} className="btn btn-secondary" style={{ fontSize: '13px' }}>
                  ✅ Označiť opravené
                </button>
              ) : (
                <button onClick={() => handleResolve(selected, false)} className="btn btn-secondary" style={{ fontSize: '13px' }}>
                  🔄 Znova otvoriť
                </button>
              )}
              <button onClick={() => handleDelete(selected)} style={{ fontSize: '13px', padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', marginLeft: 'auto' }}>
                🗑️ Zmazať
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DIAG: PERFORMANCE ──────────────────────────────────────────────
function DiagPerformanceSection() {
  const [slowData, setSlowData] = useState(null);
  const [errData, setErrData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminApi.get('/api/admin/performance/slow'),
      adminApi.get('/api/admin/performance/errors-by-route')
    ])
      .then(([s, e]) => { setSlowData(s.data); setErrData(e.data); })
      .catch(err => console.error('Performance load', err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam...</div>;

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Najpomalšie endpointy</h3>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)', marginBottom: '24px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left' }}>
              <th style={{ padding: '10px' }}>Route</th>
              <th style={{ padding: '10px', textAlign: 'right' }}>Avg (ms)</th>
              <th style={{ padding: '10px', textAlign: 'right' }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {(slowData?.routes || []).map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: '12px' }}>{r.route || r.path || '—'}</td>
                <td style={{ padding: '10px', textAlign: 'right', fontWeight: 600, color: (r.avgDuration > 1000 ? '#ef4444' : r.avgDuration > 500 ? '#f59e0b' : 'inherit') }}>{Math.round(r.avgDuration)}</td>
                <td style={{ padding: '10px', textAlign: 'right' }}>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(slowData?.routes || []).length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Nie sú dáta (apiMetrics je in-memory, reštart ho vymaže)</div>}
      </div>

      {errData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
          {Object.entries(errData.statusCodes || {}).map(([code, count]) => (
            <DiagStat key={code} label={`Status ${code}`} value={count} color={code.startsWith('5') ? '#ef4444' : code.startsWith('4') ? '#f59e0b' : '#10b981'} />
          ))}
        </div>
      )}
      <div style={{ marginTop: '16px', fontSize: '13px', color: 'var(--text-muted)' }}>
        Celkom requestov: {slowData?.totalRequests || 0} • Error rate: {slowData?.errorRate || '0'}%
      </div>
    </div>
  );
}

// ─── DIAG: HEALTH ───────────────────────────────────────────────────
function DiagHealthSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get('/api/admin/health/full');
      setData(res.data);
    } catch (err) {
      console.error('Health load', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await adminApi.post('/api/admin/health/refresh');
      setData(res.data);
    } catch (err) {
      alert('Refresh zlyhal');
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) return <div className="sa-loading">Načítavam...</div>;
  if (!data?.checks) return <div className="sa-error">Žiadne dáta</div>;

  const statusColor = (s) => s === 'ok' ? '#10b981' : s === 'warn' ? '#f59e0b' : '#ef4444';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Posledná kontrola: {data.checkedAt ? new Date(data.checkedAt).toLocaleString('sk-SK') : '—'}
        </div>
        <button onClick={refresh} disabled={refreshing} className="btn btn-secondary" style={{ fontSize: '13px' }}>
          {refreshing ? 'Kontrolujem...' : '🔄 Re-check'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
        {Object.entries(data.checks).map(([name, check]) => (
          <div key={name} style={{ padding: '16px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: statusColor(check.status) }} />
              <strong style={{ textTransform: 'capitalize' }}>{name}</strong>
              <span style={{ marginLeft: 'auto', fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: statusColor(check.status), color: 'white', textTransform: 'uppercase' }}>
                {check.status}
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{check.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DIAG: ACTIVE USERS ─────────────────────────────────────────────
function DiagActiveSection() {
  const [online, setOnline] = useState(null);
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [o, a] = await Promise.all([
        adminApi.get('/api/admin/online-users'),
        adminApi.get('/api/admin/auth-events')
      ]);
      setOnline(o.data);
      setAuth(a.data);
    } catch (err) {
      console.error('Active load', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // auto-refresh každých 15s
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <div className="sa-loading">Načítavam...</div>;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        <DiagStat label="Online používatelia" value={online?.count || 0} color="#10b981" />
        <DiagStat label="Aktívne sockety" value={online?.socketCount || 0} color="#6366f1" />
        <DiagStat label="Failed logins (24h)" value={(auth?.events || []).filter(e => e.action === 'auth.login_failed').length} color="#ef4444" />
        <DiagStat label="Registrácie (24h)" value={(auth?.events || []).filter(e => e.action === 'auth.register').length} color="#f59e0b" />
      </div>

      <h3 style={{ marginTop: 0 }}>Online teraz</h3>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)', marginBottom: '24px' }}>
        {(online?.users || []).length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Nikto nie je online</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left' }}>
                <th style={{ padding: '10px' }}>Používateľ</th>
                <th style={{ padding: '10px' }}>Email</th>
                <th style={{ padding: '10px' }}>Od</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>Sockety</th>
              </tr>
            </thead>
            <tbody>
              {online.users.map(u => (
                <tr key={u.userId} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '10px' }}>{u.username || '—'}</td>
                  <td style={{ padding: '10px' }}>{u.email || '—'}</td>
                  <td style={{ padding: '10px', color: 'var(--text-muted)' }}>{u.since ? new Date(u.since).toLocaleTimeString('sk-SK') : '—'}</td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>{u.socketCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3>Podozrivé IP adresy (neúspešné logins)</h3>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        {(auth?.topFailingIPs || []).length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Žiadne podozrivé IP</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left' }}>
                <th style={{ padding: '10px' }}>IP</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Pokusy</th>
                <th style={{ padding: '10px' }}>Email(y)</th>
                <th style={{ padding: '10px' }}>Dôvody</th>
              </tr>
            </thead>
            <tbody>
              {auth.topFailingIPs.map((ip, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '10px', fontFamily: 'monospace' }}>{ip.ip}</td>
                  <td style={{ padding: '10px', textAlign: 'right', fontWeight: 600, color: ip.count > 5 ? '#ef4444' : 'inherit' }}>{ip.count}</td>
                  <td style={{ padding: '10px', fontSize: '12px' }}>{ip.emails.join(', ')}</td>
                  <td style={{ padding: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>{Object.entries(ip.reasons).map(([r, c]) => `${r}(${c})`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── DIAG: USAGE ────────────────────────────────────────────────────
function DiagUsageSection() {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminApi.get('/api/admin/usage', { params: { period } })
      .then(res => setData(res.data))
      .catch(err => console.error('Usage load', err))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) return <div className="sa-loading">Načítavam...</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        {['24h', '7d', '30d'].map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: '6px 14px',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              background: period === p ? 'var(--accent-color, #6366f1)' : 'var(--bg-primary)',
              color: period === p ? 'white' : 'var(--text-primary)',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            {p}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        {(data?.actions || []).map(a => (
          <DiagStat key={a.action} label={a.action} value={a.count} color="#6366f1" />
        ))}
      </div>

      {(data?.dailyTrend || []).length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <h3>Denný trend (7 dní)</h3>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '16px' }}>
            <Line
              data={{
                labels: data.dailyTrend.map(d => d.day),
                datasets: [{
                  label: 'Aktivita',
                  data: data.dailyTrend.map(d => d.count),
                  borderColor: '#6366f1',
                  backgroundColor: 'rgba(99, 102, 241, 0.1)',
                  fill: true,
                  tension: 0.3
                }]
              }}
              options={{ responsive: true, plugins: { legend: { display: false } } }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DIAG: REVENUE ──────────────────────────────────────────────────
function DiagRevenueSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/revenue')
      .then(res => setData(res.data))
      .catch(err => console.error('Revenue load', err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam...</div>;
  if (!data) return <div className="sa-error">Žiadne dáta</div>;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        <div style={{ padding: '24px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', borderRadius: 'var(--radius-md)', color: 'white' }}>
          <div style={{ fontSize: '13px', opacity: 0.9 }}>MRR (mesačný príjem)</div>
          <div style={{ fontSize: '32px', fontWeight: 700, marginTop: '8px' }}>{data.mrr.toFixed(2)} €</div>
        </div>
        <DiagStat label="Platení používatelia" value={data.activePaidCount} color="#10b981" />
        <DiagStat label="Nové subs (30d)" value={data.newSubs30d} color="#f59e0b" />
      </div>

      <h3>Rozdelenie plánov</h3>
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '16px', marginBottom: '24px' }}>
        {data.plansBreakdown && Object.keys(data.plansBreakdown).length > 0 ? (
          <div style={{ maxWidth: '300px', margin: '0 auto' }}>
            <Doughnut
              data={{
                labels: Object.keys(data.plansBreakdown),
                datasets: [{
                  data: Object.values(data.plansBreakdown),
                  backgroundColor: ['#94a3b8', '#6366f1', '#8b5cf6', '#f59e0b']
                }]
              }}
              options={{ responsive: true }}
            />
          </div>
        ) : <div style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Žiadne dáta</div>}
      </div>

      {data.endingSoon && data.endingSoon.length > 0 && (
        <>
          <h3>Predplatné končiace v nasledujúcich 7 dňoch</h3>
          <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left' }}>
                  <th style={{ padding: '10px' }}>Používateľ</th>
                  <th style={{ padding: '10px' }}>Email</th>
                  <th style={{ padding: '10px' }}>Plán</th>
                  <th style={{ padding: '10px' }}>Končí</th>
                </tr>
              </thead>
              <tbody>
                {data.endingSoon.map((u, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px' }}>{u.username}</td>
                    <td style={{ padding: '10px' }}>{u.email}</td>
                    <td style={{ padding: '10px', textTransform: 'uppercase', fontWeight: 600 }}>{u.plan}</td>
                    <td style={{ padding: '10px', color: '#ef4444' }}>{new Date(u.paidUntil).toLocaleDateString('sk-SK')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// Helper komponent pre stat karty (reused across diagnostics sections)
function DiagStat({ label, value, color }) {
  return (
    <div style={{ padding: '16px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '24px', fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

export default AdminPanel;
