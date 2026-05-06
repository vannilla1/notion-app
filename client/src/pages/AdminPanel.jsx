import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
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
  { id: 'emails', label: 'Emaily', icon: '📧' },
  { id: 'sync', label: 'Sync', icon: '🔄' }
];

// Valid tab IDs — použité na validáciu URL hash pri boot-e, aby manipulácia
// s URL (napr. ?foo=bar#fake) nenastavila neznámy tab a render nepadol.
const VALID_TAB_IDS = new Set([
  'overview', 'diagnostics', 'users', 'workspaces', 'charts', 'activity',
  'api', 'storage', 'comparison', 'promo', 'audit', 'emails', 'sync'
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
        {activeTab === 'emails' && <EmailsTab />}
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
  const [lastHealthRefresh, setLastHealthRefresh] = useState(null);

  // Initial load — stats + health súčasne. Health má vlastný auto-refresh
  // cyklus, stats sa načíta raz (bez auto-refresh, lebo pri každom načítaní
  // robí ~12 DB queries — nadbytočné pre admin Prehľad).
  useEffect(() => {
    Promise.all([
      adminApi.get('/api/admin/stats').then(res => res.data).catch(() => null),
      adminApi.get('/api/admin/health').then(res => res.data).catch(() => null)
    ]).then(([s, h]) => {
      setStats(s);
      setHealth(h);
      setLastHealthRefresh(new Date());
    }).finally(() => setLoading(false));
  }, []);

  // Auto-refresh health každých 30s. Pause keď je tab schovaný (Page
  // Visibility API) — žiadny network traffic ak admin neaktívne pozerá.
  // Po návrate na tab refresh okamžite pre čerstvé hodnoty.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;

    const refreshHealth = async () => {
      if (cancelled || document.hidden) return;
      try {
        const res = await adminApi.get('/api/admin/health');
        if (!cancelled) {
          setHealth(res.data);
          setLastHealthRefresh(new Date());
        }
      } catch { /* network glitch — try again next tick */ }
    };

    const startInterval = () => {
      if (intervalId) return;
      intervalId = setInterval(refreshHealth, 30000);
    };
    const stopInterval = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopInterval();
      } else {
        // okamžitý refresh + reštart interval
        refreshHealth();
        startInterval();
      }
    };

    if (!document.hidden) startInterval();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      stopInterval();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
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
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} title="Health sa auto-refreshuje každých 30s (pauza pri schovanom tabe)">
              {new Date(health.timestamp).toLocaleString('sk-SK')} <span style={{ color: '#10b981', marginLeft: 4 }}>● live</span>
            </span>
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

          {/* External services strip — SMTP, APNs, Google. FCM nemá vlastný
              check (firebase-admin sa loaduje pri push send-e on-demand).
              Hodnoty pochádzajú z healthMonitor cache (5 min TTL). */}
          {health.externalServices && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.3 }}>EXTERNÉ SLUŽBY</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }} title="Posledná kontrola health monitorom">
                  {health.externalServices.checkedAt ? `posledná kontrola: ${new Date(health.externalServices.checkedAt).toLocaleTimeString('sk-SK')}` : ''}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                {[
                  { key: 'smtp', label: 'SMTP', emoji: '📧' },
                  { key: 'apns', label: 'APNs (iOS push)', emoji: '🍎' },
                  { key: 'google', label: 'Google API', emoji: '🔑' }
                ].map(({ key, label, emoji }) => {
                  const svc = health.externalServices[key] || { status: 'unknown' };
                  const color = svc.status === 'ok' ? '#10b981'
                    : svc.status === 'warn' ? '#f59e0b'
                    : svc.status === 'error' ? '#ef4444'
                    : '#94a3b8';
                  const label2 = svc.status === 'ok' ? 'OK'
                    : svc.status === 'warn' ? 'Watch'
                    : svc.status === 'error' ? 'Error'
                    : 'Unknown';
                  return (
                    <div key={key} style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }} title={svc.message || ''}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{emoji} {label}</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }}></span>
                        {label2}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sa-stats-grid">
        <StatCard icon="👥" label="Používatelia" value={stats.totalUsers} sub={`+${stats.recentRegistrations} za 30 dní`} onClick={() => onNavigate?.('users')} />
        <StatCard icon="🏢" label="Workspace-y" value={stats.totalWorkspaces} sub={`${stats.activeWorkspaces} aktívnych`} onClick={() => onNavigate?.('workspaces')} />
        <StatCard
          icon="📋"
          label="Projekty"
          value={stats.totalTasks}
          sub={typeof stats.totalSubtasks === 'number' ? `+ ${stats.totalSubtasks} podúloh` : undefined}
          onClick={() => onNavigate?.('comparison')}
        />
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
          <li><strong>Timestamp vpravo + „● live" indikátor</strong> — kedy bol health check vykonaný. Stránka <strong>auto-refreshuje každých 30 sekúnd</strong>, pauza aktivovaná pri schovanom tabe (Page Visibility API → žiadny network traffic ak admin pozerá inde). Po návrate na tab sa health hneď refreshne.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px', color: 'var(--text-primary)' }}>🔌 Externé služby (sekcia pod system metrikami)</h4>
        <ul>
          <li>Status badge-y pre <strong>SMTP</strong> (hostcreators.sk, posiela welcome / reminder / broadcast emaily), <strong>APNs</strong> (Apple Push Notification service pre iOS), <strong>Google API</strong> (Calendar + Tasks token health).</li>
          <li>Hodnoty pochádzajú z <code>healthMonitor.js</code> cron-u (každých 5 min na pozadí). NIE live ping pri každom otvorení Prehľadu — to by každé otvorenie tabu robilo I/O latency.</li>
          <li>Badge stavy:<br/>
            ✅ <strong>OK</strong> — služba odpovedá normálne.<br/>
            ⚠️ <strong>Watch</strong> — degradovaný stav, niečo pomalšie alebo blízko limitu (napr. RAM watch threshold).<br/>
            🚨 <strong>Error</strong> — služba zlyháva. Pri 3 erroroch po sebe pošle health monitor automatický email na support@prplcrm.eu (anti-flapping).<br/>
            <em>Unknown</em> — health monitor ešte nestihol prvý check (server-restart &lt; 5 min) alebo cache expired.
          </li>
          <li><strong>Hover na badge</strong> ti ukáže detailnú správu (napr. SMTP "Connection accepted in 145ms").</li>
          <li><strong>FCM (Android push)</strong> sa tu zámerne nezobrazuje — firebase-admin SDK sa loaduje on-demand pri push send-e a nemá samostatný health endpoint. Ak push nedoručí, vidno to v Audit log → push.failed.</li>
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
          <li><strong>📋 Projekty</strong> — počet Task dokumentov v DB (top-level projekty, nie úlohy v nich). <em>Sub-text "+ N podúloh"</em> ti dopĺňa kontext: rekurzívny súčet všetkých nested subtask-ov naprieč všetkými projektmi (subtasks sú embedded array v rámci Task docu, nie samostatné dokumenty).<br/>
            ✅ Healthy: pomer podúloh / projektov &gt; 2 → ľudia rozdrobujú projekty na zmysluplne kroky.<br/>
            ⚠️ Pomer ≤ 1 = užívatelia iba zakladajú projekty bez delenia na úlohy.<br/>
            ⚠️ Stagnujúci alebo klesajúci počet týždeň-na-týždeň pri raste user base = engagement problém.<br/>
            Pre rozpis úloh per workspace pozri <em>Porovnanie</em>. Klik → <em>Porovnanie</em> tab.
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
          <em>Pozn. č. 1 (exclusion super admina):</em> Všetky čísla v Prehľade <strong>vylučujú dáta super admina</strong> (tvoj účet + workspaces ktoré vlastníš). Tým získavaš čistý pohľad na produkčné metriky bez tvojich testovacích dát. Filter je založený na <code>Workspace.ownerId</code> lookup — Tasks/Contacts vo workspaces ktoré vlastníš sa nepočítajú do totálov.
        </p>
        <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Pozn. č. 2 (background monitoring):</em> Niektoré hodnoty (napr. recentRegistrations, activeWorkspaces) sa počítajú server-side z agregátnych Mongo queries. Pre real-time external services monitoring (každých 5 min) máme samostatný <code>jobs/healthMonitor.js</code> cron, ktorý pri 3× zlyhaní za sebou pošle alert email na support@prplcrm.eu (anti-flapping). Recovery email tiež príde keď sa služba vráti.
        </p>
        <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Pozn. č. 3 (auto-refresh stratégia):</em> Stats karty (Používatelia, Workspace-y, Projekty…) sa <strong>nečinia auto-refresh</strong> lebo ich load vyžaduje ~12 DB queries — zbytočné pri každom otvorení Prehľadu. Health card auto-refreshuje každých 30s lebo je lacná (in-memory readout). Pre čerstvé stats refresh celej stránky.
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
// Super admin email — single source of truth, používaný v UsersTab guard logike
// (nedá sa selectnúť, mazať, hromadne meniť plán/role samému sebe).
// Sync s `SUPER_ADMIN_EMAIL` v server/routes/admin.js.
const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';

// Doby ktoré sa rátajú ako "aktívny user" (login za posledných X dní).
// Konzistentné s backend `ACTIVE_THRESHOLD_MS` v /admin/users endpointe.
const ACTIVE_THRESHOLD_DAYS = 30;

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [breakdown, setBreakdown] = useState({});
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetail, setUserDetail] = useState(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState(null); // typed-confirmation delete

  // Filter + sort state
  const [search, setSearch] = useState('');
  const [filterPlan, setFilterPlan] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterActive, setFilterActive] = useState(''); // '' | 'true' | 'false'
  const [filterStripe, setFilterStripe] = useState(''); // '' | 'true' | 'false'
  const [filterDiscount, setFilterDiscount] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');

  const fetchUsers = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const params = { page, limit, sort: sortBy, order: sortOrder };
      if (search.trim()) params.search = search.trim();
      if (filterPlan) params.plan = filterPlan;
      if (filterRole) params.role = filterRole;
      if (filterActive) params.active = filterActive;
      if (filterStripe) params.hasStripe = filterStripe;
      if (filterDiscount) params.hasDiscount = filterDiscount;
      const res = await adminApi.get('/api/admin/users', { params });
      setUsers(res.data.users || []);
      setTotal(res.data.total || 0);
      setBreakdown(res.data.breakdown || {});
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, sortBy, sortOrder, search, filterPlan, filterRole, filterActive, filterStripe, filterDiscount]);

  // Initial + filter-driven reload
  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // Auto-refresh každých 60s. Slabší cyklus ako Diagnostika lebo users sa
  // nezmenia tak často — Page Visibility pause aplikujeme rovnako.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) fetchUsers(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchUsers]);

  // Reset page na 1 keď sa zmení akýkoľvek filter / sort (inak by sme mohli
  // skončiť na empty page po filter narrowingu).
  useEffect(() => {
    setPage(1);
  }, [search, filterPlan, filterRole, filterActive, filterStripe, filterDiscount, sortBy, sortOrder]);

  const openUserDetail = (userId) => {
    setSelectedUser(userId);
    setUserDetailLoading(true);
    adminApi.get(`/api/admin/users/${userId}`)
      .then(res => setUserDetail(res.data))
      .catch(() => {})
      .finally(() => setUserDetailLoading(false));
  };

  const handleSort = (column) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
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

  // Typed-confirmation delete — user musí napísať username pre potvrdenie.
  // Predtým bol len `confirm()` ktorý sa dá kliknúť omylom (Enter na alert).
  // Pre destrukčnú akciu potrebujeme silnejšiu safeguard.
  const handleDeleteUser = (targetUser) => {
    setDeleteCandidate(targetUser);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    try {
      await adminApi.delete(`/api/admin/users/${deleteCandidate.id}`);
      setUsers(prev => prev.filter(u => u.id !== deleteCandidate.id));
      setDeleteCandidate(null);
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
    const selectableIds = users.filter(u => u.email !== SUPER_ADMIN_EMAIL).map(u => u.id);
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

  // Filtrovanie aj sortovanie sa robí na serveri (efektívnejšie pri rastúcej
  // DB) — `users` zo state je už hotový server-side filtered+sorted output.
  const filtered = users;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (loading) return <div className="sa-loading">Načítavam používateľov...</div>;

  return (
    <div className="sa-users">
      {/* Stat header — breakdown podľa plánu / role / aktivity. Ukazuje
          celkový obraz produkcie (vylučuje super admina cez backend filter). */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
          Celkom: <strong>{total}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#f3f4f6', color: '#374151' }}>
          Free: <strong>{breakdown.free || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Tím: <strong>{breakdown.team || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', color: '#6D28D9' }}>
          Pro: <strong>{breakdown.pro || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
          Adminov: <strong>{breakdown.admin || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#d1fae5', color: '#065f46' }}>
          Aktívnych ({ACTIVE_THRESHOLD_DAYS}d): <strong>{breakdown.active || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#f3f4f6', color: '#6b7280' }}>
          Inaktívnych: <strong>{breakdown.inactive || 0}</strong>
        </span>
        {refreshing && <span style={{ padding: '4px 10px', color: '#10b981' }}>● auto-refresh</span>}
      </div>

      <div className="sa-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input
          type="text"
          placeholder="🔍 Hľadať username / email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="form-input sa-search"
          style={{ flex: '1 1 200px', minWidth: 180 }}
        />
        <select value={filterPlan} onChange={(e) => setFilterPlan(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Všetky plány</option>
          <option value="free">Free</option>
          <option value="team">Tím</option>
          <option value="pro">Pro</option>
        </select>
        <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Všetky role</option>
          <option value="admin">Admin</option>
          <option value="manager">Manažér</option>
          <option value="user">Používateľ</option>
        </select>
        <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Všetci</option>
          <option value="true">Aktívni (login {ACTIVE_THRESHOLD_DAYS}d)</option>
          <option value="false">Inaktívni</option>
        </select>
        <select value={filterStripe} onChange={(e) => setFilterStripe(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Stripe ?</option>
          <option value="true">💳 Má Stripe</option>
          <option value="false">Bez Stripe</option>
        </select>
        <select value={filterDiscount} onChange={(e) => setFilterDiscount(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Zľava ?</option>
          <option value="true">🏷️ Má zľavu</option>
        </select>
        {(search || filterPlan || filterRole || filterActive || filterStripe || filterDiscount) && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => {
              setSearch(''); setFilterPlan(''); setFilterRole('');
              setFilterActive(''); setFilterStripe(''); setFilterDiscount('');
            }}
          >
            ✕ Vymazať filtre
          </button>
        )}
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
                  checked={filtered.filter(u => u.email !== SUPER_ADMIN_EMAIL).length > 0 && filtered.filter(u => u.email !== SUPER_ADMIN_EMAIL).every(u => checkedIds.has(u.id))} />
              </th>
              <th onClick={() => handleSort('username')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Používateľ {sortBy === 'username' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('email')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Email {sortBy === 'email' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('plan')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Plán {sortBy === 'plan' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th>Sync</th>
              <th>Workspace-y a role</th>
              <th onClick={() => handleSort('lastLogin')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Posledný login {sortBy === 'lastLogin' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('createdAt')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Registrácia {sortBy === 'createdAt' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th>Akcie</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.id} className={u.email === SUPER_ADMIN_EMAIL ? 'current-user' : ''} onClick={() => openUserDetail(u.id)} style={{ cursor: 'pointer' }}>
                <td onClick={e => e.stopPropagation()}>
                  {u.email !== SUPER_ADMIN_EMAIL && (
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
                      {u.email === SUPER_ADMIN_EMAIL && <span className="you-badge">(vy)</span>}
                      {/* Aktivity indicator — bodka vedľa username pre rýchly scan */}
                      {u.email !== SUPER_ADMIN_EMAIL && (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8, height: 8,
                            borderRadius: '50%',
                            marginLeft: 6,
                            background: u.isActive ? '#10b981' : '#94a3b8'
                          }}
                          title={u.isActive ? `Aktívny — login za posledných ${ACTIVE_THRESHOLD_DAYS} dní` : 'Inaktívny'}
                        />
                      )}
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
                  {u.stripePaying && (
                    <span title="Stripe-managed (reálna platba)"
                      style={{ display: 'inline-block', marginLeft: 4, fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                      💳
                    </span>
                  )}
                  {u.discount && (
                    <span
                      title={
                        (u.discount.isExpired ? 'VYPRŠANÁ — ' : '') +
                        (u.discount.type === 'percentage' ? `${u.discount.value}%` :
                         u.discount.type === 'fixed' ? `−${u.discount.value}€` :
                         u.discount.type === 'freeMonths' ? `${u.discount.value} mes.` :
                         `→${u.discount.targetPlan?.toUpperCase()}`)
                      }
                      style={{
                        display: 'inline-block', marginLeft: '4px', fontSize: '10px',
                        padding: '1px 5px', borderRadius: '8px',
                        background: u.discount.isExpired ? '#f3f4f6' : '#FEF3C7',
                        color: u.discount.isExpired ? '#9ca3af' : '#92400E',
                        fontWeight: 600,
                        textDecoration: u.discount.isExpired ? 'line-through' : 'none'
                      }}>
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
                <td className="sa-date-cell" title={u.lastLogin ? `Posledný login ${new Date(u.lastLogin).toLocaleString('sk-SK')}` : 'Bez záznamu'}>
                  {u.lastLogin
                    ? <span style={{ color: u.isActive ? 'inherit' : 'var(--text-muted)' }}>
                        {new Date(u.lastLogin).toLocaleDateString('sk-SK')}
                      </span>
                    : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>nikdy</span>
                  }
                </td>
                <td className="sa-date-cell">
                  {u.createdAt ? new Date(u.createdAt).toLocaleDateString('sk-SK') : '—'}
                </td>
                <td onClick={e => e.stopPropagation()}>
                  {u.email !== SUPER_ADMIN_EMAIL && (
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
        {/* Pagination — server-side, kontroluje totalPages aj page state */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderTop: '1px solid var(--border-color)' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Strana {page} z {totalPages} ({total} užívateľov)
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ fontSize: 12 }}
              >
                ← Predch.
              </button>
              <button
                className="btn btn-secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                style={{ fontSize: 12 }}
              >
                Ďalšia →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Typed-confirmation delete modal */}
      {deleteCandidate && (
        <DeleteUserConfirmModal
          user={deleteCandidate}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={confirmDelete}
        />
      )}

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
        <p><strong>Čo tu vidíš:</strong> kompletný zoznam všetkých registrovaných užívateľov + nástroje na úpravu ich účtu, plánu a zliav. Tabuľka je <strong>server-side filtrovaná, sortovaná a stránkovaná</strong> — pri raste DB sa neslime načítaním tisíc užívateľov naraz.</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>📊 Stat header (hore)</h4>
        <ul>
          <li><strong>Celkom / Free / Tím / Pro / Adminov</strong> — agregovaný breakdown produkčných užívateľov (super admin vylúčený).</li>
          <li><strong>Aktívnych / Inaktívnych</strong> — aktívny = login za posledných {ACTIVE_THRESHOLD_DAYS} dní (z audit log <code>auth.login</code> eventov). Pomer aktívni/celkom je tvoj DAU/MAU proxy.</li>
          <li>Stránka <strong>auto-refresh každých 60s</strong> (s pause pri schovanom tabe) — nové registrácie vidíš bez manuálneho refreshu.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Search</strong> — substring v username / email (case-insensitive, escape regex).</li>
          <li><strong>Plán</strong> — Free / Tím / Pro</li>
          <li><strong>Rola</strong> — Admin / Manažér / Používateľ</li>
          <li><strong>Aktivita</strong> — Aktívni (login {ACTIVE_THRESHOLD_DAYS}d) / Inaktívni</li>
          <li><strong>💳 Stripe</strong> — má/nemá reálne Stripe predplatné (na rozdiel od admin-granted)</li>
          <li><strong>🏷️ Zľava</strong> — má aktívnu discount metadata</li>
          <li><strong>✕ Vymazať filtre</strong> — quick reset všetkých filtrov</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>↕️ Sort</h4>
        <p>Klik na header column toggle-uje ascending/descending sort. Sortujú sa: Používateľ, Email, Plán, Posledný login, Registrácia. Defaultne najnovší prvý (createdAt DESC).</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>📋 Stĺpce v tabuľke</h4>
        <ul>
          <li><strong>Používateľ</strong> — avatar + meno. Vedľa mena <strong>zelená/šedá bodka</strong> indicator: zelená = aktívny ({ACTIVE_THRESHOLD_DAYS}d), šedá = inaktívny.</li>
          <li><strong>Plán</strong> — dropdown na rýchlu zmenu. Vedľa: <strong>💳</strong> badge ak má Stripe sub, <strong>🏷️</strong> badge ak má discount (prečiarknutý ak vypršaná).</li>
          <li><strong>Sync</strong> — emoji indikátory pre Google Calendar / Tasks pripojené.</li>
          <li><strong>Workspace-y a role</strong> — všetky workspace memberships per user. Owner role je <strong>chránená</strong> — ak je to jediný owner, demotion sa odmietne s message "Najprv povýšte iného člena".</li>
          <li><strong>Posledný login</strong> — kedy sa user posledný raz prihlásil (z audit log). "nikdy" = žiadny záznam.</li>
          <li><strong>Registrácia</strong> — createdAt timestamp.</li>
          <li><strong>Akcie → Vymazať</strong> — destrukčná akcia. Otvorí <strong>typed-confirmation modal</strong> kde musíš napísať username pre potvrdenie.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>☑️ Hromadné akcie</h4>
        <p>Zaškrtni viacerých → bulk action bar sa objaví → zmeň plán alebo rolu hromadne. Super admin je vždy vynechaný (jeho checkbox sa nezobrazí).</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>👤 Detail modal (klik na riadok)</h4>
        <p>Otvorí sa <strong>centered modal</strong> (nie panel vpravo) s plnými dátami:</p>
        <ul>
          <li><strong>Hlavička</strong> — avatar, meno, email, role badge, plán badge, registračný dátum.</li>
          <li><strong>Stats</strong> — počet kontaktov, projektov, odoslaných/prijatých správ.</li>
          <li><strong>Workspaces</strong> — kde je členom a v akej role (s farebným indikátorom workspace-u).</li>
          <li><strong>Zariadenia</strong> — registrované APNs (iOS) + web push tokeny per browser. Klik "Detail" rozbalí konkrétne tokeny.</li>
          <li><strong>Integrácie</strong> — Google Calendar / Tasks status badges.</li>
          <li><strong>Posledná aktivita</strong> — výňatok z Audit logu (10 najnovších akcií).</li>
          <li><strong>Predplatné — úprava</strong> — zmena plánu (Free/Tím/Pro) a "Platené do" dátumu. Po vypršaní paidUntil a bez Stripe sub sa plán automaticky vráti na Free (cez auto-expiry službu).</li>
          <li><strong>Zľava</strong> — pridanie discount metadata: percentuálna, fixná, voľné mesiace, plán-upgrade zadarmo. <em>Pozor:</em> "voľné mesiace" predĺži paidUntil ale nezmení plán — pre "mesiac Pro zdarma" radšej použi "Predplatné — úprava" (plán Pro + dátum o mesiac).</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🛡️ Bezpečnostné guard-y</h4>
        <ul>
          <li><strong>Owner demotion</strong> — backend blokuje demote z owner ak by workspace zostal bez ownera. Najprv povýš iného člena, potom môžeš pôvodného demotnúť.</li>
          <li><strong>Self-demotion admin role</strong> — admin nemôže odstrániť svoju vlastnú admin rolu (Inak by sa mohol uzamknúť von z panelu).</li>
          <li><strong>Typed-confirmation delete</strong> — pri DELETE musíš napísať username. Ochrana pred mis-clickom.</li>
          <li><strong>Super admin (support@prplcrm.eu)</strong> — nezobrazuje sa v zozname, nemá checkbox, nedá sa vymazať.</li>
        </ul>

        <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Audit:</em> Všetky zmeny role / plánu / zliav / mazania sa logujú do Audit logu so záznamom kto/kedy/čo. Súbor zápisov je <code>auditService.logAction</code>.
        </p>
      </AdminHelpToggle>
    </div>
  );
}

// Typed-confirmation delete modal — pre destrukčnú akciu user musí
// vlastnoručne napísať username. Predtým bol len `confirm()` ktorý sa
// dal kliknúť omylom (Enter na alert dialog). Pri delete usera sa zmaže
// celý profil, jeho workspaces (ak je sole owner), všetky dáta — typed
// confirmation je obvyklá best practice (GitHub, Stripe, AWS).
function DeleteUserConfirmModal({ user, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const matches = typed === user.username;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 480, padding: 24 }}>
        <h3 style={{ marginTop: 0, color: '#dc2626' }}>⚠️ Vymazať používateľa</h3>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          Toto je <strong>nevratná destrukčná akcia</strong>. Vymaže sa:
        </p>
        <ul style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, margin: '8px 0 16px' }}>
          <li>Profil užívateľa <strong>{user.username}</strong> ({user.email})</li>
          <li>Sole-owned workspaces (kde je user jediný vlastník)</li>
          <li>Všetky kontakty, projekty, úlohy, správy v tých workspaces</li>
          <li>Push subscriptions, FCM/APNs zariadenia, audit history</li>
        </ul>
        <p style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
          Pre potvrdenie napíš username <code style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>{user.username}</code>:
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={user.username}
          autoFocus
          className="form-input"
          style={{ width: '100%', marginBottom: 16, fontSize: 14 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Zrušiť</button>
          <button
            className="btn btn-danger"
            disabled={!matches}
            onClick={onConfirm}
            style={{ opacity: matches ? 1 : 0.5 }}
          >
            Natrvalo vymazať
          </button>
        </div>
      </div>
    </div>
  );
}

// Typed-confirmation pre delete workspace — analogicky ako pri usere.
// Workspace delete vymaže VŠETKY kontakty/úlohy/správy/členstvá v ňom,
// preto silnejšia ochrana pred mis-clickom je nevyhnutná.
function DeleteWorkspaceConfirmModal({ workspace, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const matches = typed === workspace.name;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 480, padding: 24 }}>
        <h3 style={{ marginTop: 0, color: '#dc2626' }}>⚠️ Vymazať workspace</h3>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          <strong>Nevratná destrukčná akcia.</strong> Vymaže sa:
        </p>
        <ul style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, margin: '8px 0 16px' }}>
          <li>Workspace <strong>{workspace.name}</strong> (/{workspace.slug})</li>
          <li>Všetky kontakty, projekty (vrátane podúloh), správy</li>
          <li>Všetky workspace memberships (členov)</li>
          <li>Súvisiaca audit history a notifikácie</li>
        </ul>
        <p style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
          Pre potvrdenie napíš názov workspace-u <code style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>{workspace.name}</code>:
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={workspace.name}
          autoFocus
          className="form-input"
          style={{ width: '100%', marginBottom: 16, fontSize: 14 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Zrušiť</button>
          <button
            className="btn btn-danger"
            disabled={!matches}
            onClick={onConfirm}
            style={{ opacity: matches ? 1 : 0.5 }}
          >
            Natrvalo vymazať
          </button>
        </div>
      </div>
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
const WS_STATUS_LABELS = {
  active: { label: 'Aktívny', color: '#10b981', bg: '#d1fae5' },
  inactive: { label: 'Inaktívny', color: '#92400e', bg: '#fef3c7' },
  empty: { label: 'Prázdny', color: '#6b7280', bg: '#f3f4f6' }
};

function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [total, setTotal] = useState(0);
  const [breakdown, setBreakdown] = useState({});
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedWs, setSelectedWs] = useState(null);
  const [wsDetail, setWsDetail] = useState(null);
  const [wsDetailLoading, setWsDetailLoading] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState(null);

  // Filter + sort
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterOwnerPlan, setFilterOwnerPlan] = useState('');
  const [filterStripe, setFilterStripe] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');

  const fetchWorkspaces = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const params = { page, limit, sort: sortBy, order: sortOrder };
      if (search.trim()) params.search = search.trim();
      if (filterStatus) params.status = filterStatus;
      if (filterOwnerPlan) params.ownerPlan = filterOwnerPlan;
      if (filterStripe) params.hasStripe = filterStripe;
      const res = await adminApi.get('/api/admin/workspaces', { params });
      setWorkspaces(res.data.workspaces || []);
      setTotal(res.data.total || 0);
      setBreakdown(res.data.breakdown || {});
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, sortBy, sortOrder, search, filterStatus, filterOwnerPlan, filterStripe]);

  useEffect(() => { fetchWorkspaces(); }, [fetchWorkspaces]);

  // Auto-refresh 60s s Page Visibility pause
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) fetchWorkspaces(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchWorkspaces]);

  // Reset page pri zmene filtra/sortu
  useEffect(() => { setPage(1); }, [search, filterStatus, filterOwnerPlan, filterStripe, sortBy, sortOrder]);

  const handleSort = (column) => {
    if (sortBy === column) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else { setSortBy(column); setSortOrder('desc'); }
  };

  const openWsDetail = (wsId) => {
    setSelectedWs(wsId);
    setWsDetailLoading(true);
    adminApi.get(`/api/admin/workspaces/${wsId}`)
      .then(res => setWsDetail(res.data))
      .catch(() => {})
      .finally(() => setWsDetailLoading(false));
  };

  const handleDeleteWorkspace = () => {
    if (!wsDetail) return;
    setDeleteCandidate(wsDetail.workspace);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    try {
      await adminApi.delete(`/api/admin/workspaces/${selectedWs}`);
      setWorkspaces(prev => prev.filter(w => w.id !== selectedWs));
      setSelectedWs(null);
      setWsDetail(null);
      setDeleteCandidate(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní workspace');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (loading) return <div className="sa-loading">Načítavam workspace-y...</div>;

  return (
    <div className="sa-workspaces">
      {/* Stat header */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
          Celkom: <strong>{breakdown.total ?? total}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#d1fae5', color: '#065f46' }}>
          Aktívnych: <strong>{breakdown.active || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Inaktívnych: <strong>{breakdown.inactive || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#f3f4f6', color: '#6b7280' }}>
          Prázdnych: <strong>{breakdown.empty || 0}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', color: '#6D28D9' }}>
          💳 So Stripe ownerom: <strong>{breakdown.withStripeOwner || 0}</strong>
        </span>
        {refreshing && <span style={{ padding: '4px 10px', color: '#10b981' }}>● auto-refresh</span>}
      </div>

      <div className="sa-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input
          type="text"
          placeholder="🔍 Hľadať workspace podľa názvu..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input sa-search"
          style={{ flex: '1 1 220px', minWidth: 200 }}
        />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Všetky stavy</option>
          <option value="active">Aktívne ({'<'}30d)</option>
          <option value="inactive">Inaktívne ({'>'}30d)</option>
          <option value="empty">Prázdne</option>
        </select>
        <select value={filterOwnerPlan} onChange={(e) => setFilterOwnerPlan(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Plán ownera</option>
          <option value="free">Free</option>
          <option value="team">Tím</option>
          <option value="pro">Pro</option>
        </select>
        <select value={filterStripe} onChange={(e) => setFilterStripe(e.target.value)} className="sa-select" style={{ fontSize: 13 }}>
          <option value="">Stripe owner ?</option>
          <option value="true">💳 Má Stripe</option>
          <option value="false">Bez Stripe</option>
        </select>
        {(search || filterStatus || filterOwnerPlan || filterStripe) && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => { setSearch(''); setFilterStatus(''); setFilterOwnerPlan(''); setFilterStripe(''); }}
          >
            ✕ Vymazať filtre
          </button>
        )}
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
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Workspace {sortBy === 'name' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th>Stav</th>
              <th>Vlastník</th>
              <th onClick={() => handleSort('memberCount')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Členovia {sortBy === 'memberCount' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th>Dáta</th>
              <th onClick={() => handleSort('lastActivity')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Posledná aktivita {sortBy === 'lastActivity' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('createdAt')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Vytvorený {sortBy === 'createdAt' && (sortOrder === 'asc' ? '▲' : '▼')}
              </th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(w => {
              const statusMeta = WS_STATUS_LABELS[w.status] || WS_STATUS_LABELS.empty;
              return (
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
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 999,
                      background: statusMeta.bg, color: statusMeta.color, fontWeight: 600
                    }}>
                      {statusMeta.label}
                    </span>
                  </td>
                  <td>
                    <div className="sa-owner-cell">
                      <div>
                        {w.owner.username}
                        {w.owner.hasStripe && (
                          <span title="Owner má aktívny Stripe sub" style={{ marginLeft: 4, fontSize: 10 }}>💳</span>
                        )}
                        <span style={{
                          marginLeft: 4, fontSize: 10, padding: '1px 5px', borderRadius: 4,
                          background: w.owner.plan === 'pro' ? '#ede9fe' : w.owner.plan === 'team' ? '#fef3c7' : '#f3f4f6',
                          color: w.owner.plan === 'pro' ? '#6D28D9' : w.owner.plan === 'team' ? '#92400e' : '#6b7280',
                          textTransform: 'uppercase', fontWeight: 600
                        }}>
                          {w.owner.plan}
                        </span>
                      </div>
                      <div className="sa-sub-text">{w.owner.email}</div>
                    </div>
                  </td>
                  <td className="sa-center" title={`${w.memberRoles?.owner || 0} ownerov · ${w.memberRoles?.manager || 0} manažérov · ${w.memberRoles?.member || 0} členov`}>
                    {w.memberCount}
                    {w.memberRoles && (w.memberRoles.manager > 0 || w.memberRoles.member > 0) && (
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        👑{w.memberRoles.owner || 0} · 👨‍💼{w.memberRoles.manager || 0} · 👤{w.memberRoles.member || 0}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    📋 {w.taskCount} · 👤 {w.contactCount}
                    {w.messageCount > 0 && <span> · ✉️ {w.messageCount}</span>}
                  </td>
                  <td className="sa-date-cell" style={{ fontSize: 12 }}>
                    {w.lastActivity
                      ? <span style={{ color: w.status === 'active' ? 'inherit' : 'var(--text-muted)' }}>
                          {new Date(w.lastActivity).toLocaleDateString('sk-SK')}
                        </span>
                      : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>žiadna</span>
                    }
                  </td>
                  <td className="sa-date-cell">
                    {new Date(w.createdAt).toLocaleDateString('sk-SK')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderTop: '1px solid var(--border-color)' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Strana {page} z {totalPages} ({total} workspace-ov)
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ fontSize: 12 }}>
                ← Predch.
              </button>
              <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 12 }}>
                Ďalšia →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Typed-confirmation delete modal */}
      {deleteCandidate && (
        <DeleteWorkspaceConfirmModal
          workspace={deleteCandidate}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={confirmDelete}
        />
      )}

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

                {/* Stats grid + last activity timestamp */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700 }}>{wsDetail.stats.contactCount}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>👤 Kontakty</div>
                  </div>
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700 }}>{wsDetail.stats.completedTasks}/{wsDetail.stats.taskCount}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>📋 Úlohy (✓/celkom)</div>
                  </div>
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700 }}>
                      {wsDetail.stats.messageCount}
                      {wsDetail.stats.pendingMessages > 0 && (
                        <span style={{ fontSize: 12, color: '#f59e0b', marginLeft: 4 }}>({wsDetail.stats.pendingMessages} pending)</span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>✉️ Správy</div>
                  </div>
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>
                      {wsDetail.lastActivity
                        ? new Date(wsDetail.lastActivity).toLocaleDateString('sk-SK')
                        : 'žiadna'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>📅 Posledná aktivita</div>
                  </div>
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

                {/* Recent contacts / tasks / messages — 3-column layout pre kompaktnosť */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {/* Recent contacts */}
                  <div>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>👤 Posledné kontakty</h4>
                    {wsDetail.recentContacts?.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: 220, overflow: 'auto' }}>
                        {wsDetail.recentContacts.slice(0, 10).map(c => (
                          <div key={c._id} style={{ fontSize: 12, padding: '5px 8px', background: 'var(--bg-secondary)', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || '—'}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(c.createdAt).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit' })}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>žiadne</div>
                    )}
                  </div>

                  {/* Recent tasks */}
                  <div>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>📋 Posledné projekty</h4>
                    {wsDetail.recentTasks?.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: 220, overflow: 'auto' }}>
                        {wsDetail.recentTasks.slice(0, 10).map(t => (
                          <div key={t._id} style={{ fontSize: 12, padding: '5px 8px', background: 'var(--bg-secondary)', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--text-muted)' : 'inherit' }}>
                              {t.completed ? '✓ ' : ''}{t.title || '—'}
                            </span>
                            {t.priority && (
                              <span style={{
                                fontSize: 9, padding: '0 4px', borderRadius: 3,
                                background: t.priority === 'high' ? '#fee2e2' : t.priority === 'medium' ? '#fef3c7' : '#f3f4f6',
                                color: t.priority === 'high' ? '#991b1b' : t.priority === 'medium' ? '#92400e' : '#6b7280',
                                whiteSpace: 'nowrap'
                              }}>
                                {t.priority === 'high' ? 'V' : t.priority === 'medium' ? 'S' : 'N'}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>žiadne</div>
                    )}
                  </div>

                  {/* Recent messages */}
                  <div>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>✉️ Posledné správy</h4>
                    {wsDetail.recentMessages?.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: 220, overflow: 'auto' }}>
                        {wsDetail.recentMessages.slice(0, 10).map(m => (
                          <div key={m._id} style={{ fontSize: 12, padding: '5px 8px', background: 'var(--bg-secondary)', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject || '(bez predmetu)'}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(m.createdAt).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit' })}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>žiadne</div>
                    )}
                  </div>
                </div>

                {/* Activity timeline z audit logu */}
                {wsDetail.recentActivity?.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>⏱️ Posledná aktivita workspace-u</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: 200, overflow: 'auto' }}>
                      {wsDetail.recentActivity.map((a, i) => (
                        <div key={i} style={{ fontSize: 12, padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <strong>{a.username || 'systém'}</strong>{' · '}
                            {ACTION_LABELS[a.action] || a.action}
                            {a.targetName ? ` — ${a.targetName}` : ''}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                            {new Date(a.createdAt).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </span>
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
        <p><strong>Čo tu vidíš:</strong> všetky produkčné workspace-y v systéme (super admin testovacie sú vylúčené) — vlastníci, počty členov, status aktivity, dáta vo vnútri. Tabuľka je <strong>server-side filtrovaná, sortovaná a stránkovaná</strong>.</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>📊 Stat header (hore)</h4>
        <ul>
          <li><strong>Celkom / Aktívnych / Inaktívnych / Prázdnych</strong> — agregovaný breakdown podľa status detection.</li>
          <li><strong>Aktívny</strong> = lastActivity (max z contact/task/message updatedAt) za posledných 30 dní.</li>
          <li><strong>Inaktívny</strong> = má dáta ale lastActivity je staršia ako 30 dní → kandidát na cleanup, alebo nudge owner-a.</li>
          <li><strong>Prázdny</strong> = workspace bez akýchkoľvek kontaktov/úloh/správ. Môže byť čerstvo vytvorený alebo opustený hneď po registrácii — sledovať trendy onboarding-u.</li>
          <li><strong>💳 So Stripe ownerom</strong> — počet workspace-ov ktorých vlastník platí cez Stripe (priame revenue prínosné workspaces).</li>
          <li>Auto-refresh 60s s Page Visibility pause.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Search</strong> — substring v názve workspace-u (case-insensitive).</li>
          <li><strong>Stav</strong> — Aktívne ({'<'} 30d) / Inaktívne ({'>'} 30d) / Prázdne</li>
          <li><strong>Plán ownera</strong> — Free / Tím / Pro</li>
          <li><strong>Stripe owner</strong> — má/nemá reálne Stripe predplatné</li>
          <li><strong>✕ Vymazať filtre</strong> — quick reset</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>↕️ Sort</h4>
        <p>Klik na header column toggle-uje sort: <em>Workspace</em> (podľa názvu), <em>Členovia</em> (počet), <em>Posledná aktivita</em>, <em>Vytvorený</em>. Defaultne najnovší prvý.</p>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>📋 Stĺpce v tabuľke</h4>
        <ul>
          <li><strong>Workspace</strong> — farebná bodka + meno + slug (URL part).</li>
          <li><strong>Stav</strong> — farebný badge (Aktívny / Inaktívny / Prázdny) podľa lastActivity.</li>
          <li><strong>Vlastník</strong> — username, email + plan badge (Free/Tím/Pro) + 💳 Stripe ikonka ak má reálne predplatné.</li>
          <li><strong>Členovia</strong> — count + breakdown 👑 ownerov / 👨‍💼 manažérov / 👤 členov pod číslom.</li>
          <li><strong>Dáta</strong> — 📋 počet projektov · 👤 kontaktov · ✉️ správ (ak sú).</li>
          <li><strong>Posledná aktivita</strong> — kedy sa naposledy zmenil ľubovoľný objekt (contact / task / message updatedAt).</li>
          <li><strong>Vytvorený</strong> — createdAt.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>👤 Detail modal (klik na riadok)</h4>
        <ul>
          <li><strong>Stats grid</strong> — kontakty, úlohy (completed/celkom), správy (s pending counter), posledná aktivita.</li>
          <li><strong>Členovia</strong> — všetci s rolou badge (owner/manager/member), email + username.</li>
          <li><strong>3-stĺpcové výpisy</strong> — posledné kontakty (10), posledné projekty (10) s priority badge V/S/N a strike-through pre completed, posledné správy (10).</li>
          <li><strong>⏱️ Posledná aktivita workspace-u</strong> — audit log timeline (20 najnovších akcií filtrovaných na <code>workspaceId</code>) — kto/čo/kedy.</li>
          <li><strong>Vymazať workspace</strong> — typed-confirmation modal (musíš napísať názov workspace-u). Vymaže VŠETKY kontakty / úlohy / správy / členstvá / audit history.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>💡 Daily check rituál</h4>
        <ol>
          <li>Stat header — koľko prázdnych workspace-ov si pribudlo? (signál onboarding-u)</li>
          <li>Filter "Inaktívne {'>'} 30d" → kandidáti na re-engagement email kampaň.</li>
          <li>Filter "Stripe owner: Áno" → tu je tvoj real revenue base — sleduj health týchto workspace-ov osobitne.</li>
          <li>Klik na workspace s veľa članmi (top sortom Členovia DESC) → over že tam nie je niečo divné (admin-vytvorený workspace-y atď.)</li>
        </ol>

        <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Workspace môže existovať aj keď vlastník už nemá aktívne predplatné — limity sa kontrolujú podľa plánu majiteľa workspace-u. Pri vymazaní usera sa jeho workspaces (kde je sole owner) odstránia automaticky cez user delete cleanup. Manuálne mazanie tu je pre prípady keď admin chce odstrániť opustené alebo testovacie workspaces bez mazania samotného usera.
        </p>
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
        <UserEmailLogsMini userId={user._id} />
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
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('username'); // username | syncedCount | lastActivity

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const res = await adminApi.get('/api/admin/sync-diagnostics');
      // Backward-compatible: handle both new {summary, users} shape and legacy array
      if (Array.isArray(res.data)) {
        setDiagnostics(res.data);
        setSummary(null);
      } else {
        setDiagnostics(res.data.users || []);
        setSummary(res.data.summary || null);
      }
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh každých 60s (sync data sa nemení často) s Page Visibility pause
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  if (loading) return <div className="sa-loading">Načítavam diagnostiku...</div>;

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const watchStatus = (expiry) => {
    if (!expiry) return { label: 'Nemá watch', color: '#dc2626', bg: '#fee2e2' };
    const exp = new Date(expiry);
    const now = new Date();
    const days = Math.floor((exp - now) / (24 * 60 * 60 * 1000));
    if (days < 0) return { label: `Expirovaný (${Math.abs(days)}d)`, color: '#dc2626', bg: '#fee2e2' };
    if (days < 7) return { label: `Čoskoro expiruje (${days}d)`, color: '#92400e', bg: '#fef3c7' };
    return { label: `Aktívny (${days}d)`, color: '#10b981', bg: '#d1fae5' };
  };

  // Aplikuj filter z URL hash. `calendar` → zobraz iba usera s enabled Calendar
  // a skryj Tasks sekciu. `tasks` → zrkadlovo. `null` → všetko ako doteraz.
  const showCalendar = filter === null || filter === 'calendar';
  const showTasks = filter === null || filter === 'tasks';

  let filtered = diagnostics.filter(d => {
    if (filter === 'calendar') return d.calendar.enabled;
    if (filter === 'tasks') return d.tasks.enabled;
    return true;
  });

  // Search filter
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(d =>
      d.username?.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q)
    );
  }

  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'syncedCount') {
      const aTotal = (a.calendar.syncedCount || 0) + (a.tasks.syncedCount || 0);
      const bTotal = (b.calendar.syncedCount || 0) + (b.tasks.syncedCount || 0);
      return bTotal - aTotal;
    }
    if (sortBy === 'lastActivity') {
      const aLast = a.tasks.lastSyncAt ? new Date(a.tasks.lastSyncAt).getTime() : 0;
      const bLast = b.tasks.lastSyncAt ? new Date(b.tasks.lastSyncAt).getTime() : 0;
      return bLast - aLast;
    }
    return (a.username || '').localeCompare(b.username || '');
  });

  if (filtered.length === 0 && !search.trim()) {
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Sync diagnostika
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981', fontWeight: 400 }}>● auto-refresh</span>}
        </h2>
      </div>

      {/* SUMMARY STAT HEADER */}
      {summary && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, fontSize: 12 }}>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', color: '#6D28D9' }}>
            📅 Calendar: <strong>{summary.calendarUsers}</strong> userov · {summary.totalCalendarEvents} eventov
          </span>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: '#dbeafe', color: '#1e40af' }}>
            ✅ Tasks: <strong>{summary.tasksUsers}</strong> userov · {summary.totalTaskItems} úloh
          </span>
          {summary.bothUsers > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
              Obe: <strong>{summary.bothUsers}</strong>
            </span>
          )}
          {summary.watchSoonExpiring > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }} title="Watch expiruje do 7 dní — Google prestane posielať push notifikácie">
              ⏰ Čoskoro expiruje: <strong>{summary.watchSoonExpiring}</strong>
            </span>
          )}
          {summary.watchExpired > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }} title="Watch už expiroval — okamžite refreshnúť">
              ❌ Expirovaný watch: <strong>{summary.watchExpired}</strong>
            </span>
          )}
          {summary.quotaNearLimit > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }} title="> 80/100 quota dnes">
              📊 Quota >80: <strong>{summary.quotaNearLimit}</strong>
            </span>
          )}
          {summary.quotaExceeded > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }} title="100/100 quota — sync zablokovaný do polnoci">
              🚫 Quota 100/100: <strong>{summary.quotaExceeded}</strong>
            </span>
          )}
          {(summary.legacyCalendarUsers > 0 || summary.legacyTasksUsers > 0) && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)', color: 'var(--text-muted)' }} title="Legacy (pred-PR2) eventy v pôvodnom kalendári/liste">
              🗂️ Legacy: {summary.legacyCalendarUsers} cal / {summary.legacyTasksUsers} tasks
            </span>
          )}
        </div>
      )}

      <SyncFilterBar filter={filter} onFilterChange={onFilterChange} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Hľadať používateľa..."
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13, flex: 1, minWidth: 180 }}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13, background: 'var(--bg-primary)' }}
        >
          <option value="username">Zoradiť: meno</option>
          <option value="syncedCount">Zoradiť: počet sync</option>
          <option value="lastActivity">Zoradiť: posledná aktivita</option>
        </select>
        {search && (
          <button onClick={() => setSearch('')} className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}>
            ✕ Vymazať
          </button>
        )}
      </div>

      <div className="sa-toolbar">
        <span className="sa-count">
          {filtered.length} {filter === 'calendar' ? 'používateľov s Google Calendar' : filter === 'tasks' ? 'používateľov s Google Tasks' : 'používateľov so synchronizáciou'}
          {search && ` · vyhľadávanie: "${search}"`}
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
                    <span><strong>{d.calendar.syncedCount}</strong> udalostí</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Watch stav:</span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      background: watchStatus(d.calendar.watchExpiry).bg,
                      color: watchStatus(d.calendar.watchExpiry).color
                    }}>
                      {watchStatus(d.calendar.watchExpiry).label}
                    </span>
                  </div>
                  {d.calendar.watchExpiry && (
                    <div className="sa-sync-detail" style={{ fontSize: 11, color: 'var(--text-muted, #6b7280)' }}>
                      <span>Expiry:</span>
                      <span>{formatDate(d.calendar.watchExpiry)}</span>
                    </div>
                  )}
                  {d.calendar.legacyCount > 0 && (
                    <div className="sa-sync-detail" style={{ fontSize: 11 }}>
                      <span style={{ color: '#92400e' }}>🗂️ Legacy kalendár:</span>
                      <span style={{ color: '#92400e' }}>{d.calendar.legacyCount} eventov v pôvodnom</span>
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
                    <span><strong>{d.tasks.syncedCount}</strong> úloh</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Posledný sync:</span>
                    <span>{formatDate(d.tasks.lastSyncAt)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span>Kvóta dnes:</span>
                      <span style={{
                        fontWeight: 600,
                        color: d.tasks.quotaUsedToday >= 100 ? '#dc2626' : d.tasks.quotaUsedToday > 80 ? '#92400e' : '#10b981'
                      }}>
                        {d.tasks.quotaUsedToday}/100
                      </span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-secondary, #f3f4f6)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(100, d.tasks.quotaUsedToday)}%`,
                        height: '100%',
                        background: d.tasks.quotaUsedToday >= 100 ? '#dc2626' : d.tasks.quotaUsedToday > 80 ? '#f59e0b' : '#10b981',
                        transition: 'width 0.3s'
                      }} />
                    </div>
                  </div>
                  {d.tasks.legacyCount > 0 && (
                    <div className="sa-sync-detail" style={{ fontSize: 11, marginTop: 6 }}>
                      <span style={{ color: '#92400e' }}>🗂️ Legacy task list:</span>
                      <span style={{ color: '#92400e' }}>{d.tasks.legacyCount} úloh v pôvodnom</span>
                    </div>
                  )}
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
        <p>
          <strong>Čo tu vidíš:</strong> stav Google integrácií pre každého používateľa ktorý si pripojil
          Google účet. Calendar (push notifikácie cez watch) a Tasks (polling 60s + write-throught).
          Per-user a per-workspace breakdown s legacy migration warningmi.
        </p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Stat header</h4>
        <ul>
          <li><strong>Calendar / Tasks counters</strong> — počet userov + total events/úloh.</li>
          <li><strong>Obe</strong> — počet userov ktorí majú pripojené aj Calendar aj Tasks (typicky 90%+).</li>
          <li><strong>⏰ Čoskoro expiruje (oranžový)</strong> — Google watch expiruje do 7 dní; treba refreshnúť aby push notifikácie ďalej chodili.</li>
          <li><strong>❌ Expirovaný watch (červený)</strong> — watch už neplatí, push notifikácie nechodia. Sync funguje len pri user-iniciated polling. Re-connect nutný.</li>
          <li><strong>📊 Quota >80</strong> — počet userov v 80–99/100 dnešnej Google Tasks API quoty.</li>
          <li><strong>🚫 Quota 100/100</strong> — sync zablokovaný do polnoci UTC. Po reset-e kvóty pôjde znovu.</li>
          <li><strong>🗂️ Legacy</strong> — počet userov ktorí majú eventy/úlohy v pred-PR2 single-list strukture. Migration môže prebehnúť automaticky pri ďalšom sync-u.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Calendar / Tasks toggle</strong> — URL hash <code>#sync/calendar</code> alebo <code>#sync/tasks</code> pamätá výber pri refresh-i.</li>
          <li><strong>Search</strong> — substring v username / email.</li>
          <li><strong>Sort</strong> — meno (default) / počet sync (top-loaded users) / posledná aktivita (najaktívnejší top).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📅 Karta Google Calendar</h4>
        <ul>
          <li><strong>Pripojené</strong> — kedy user OAuth-oval Calendar scope.</li>
          <li><strong>Synchronizovaných celkom</strong> — počet eventov v <code>syncedTaskIds</code> mape (Prpl-task → Google-event).</li>
          <li><strong>Watch stav</strong> — farebne kódovaný badge (zelený/oranžový/červený).</li>
          <li><strong>Workspace kalendáre</strong> — per-workspace breakdown (PR2 multi-workspace structure). Každý workspace = vlastný Google kalendár „Prpl CRM — &lt;workspace&gt;".</li>
          <li><strong>🗂️ Legacy</strong> — eventy ešte v pôvodnom single-kalendári pred PR2 migráciou.</li>
          <li><strong>⚠️ Nemigrovaných</strong> — eventy ktoré sú v <code>syncedTaskIds</code> ale nepriradené k žiadnemu workspace kalendáru.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>✅ Karta Google Tasks</h4>
        <ul>
          <li><strong>Posledný sync</strong> — kedy beh background pollu naposledy úspešne dotiahol Tasks zmeny.</li>
          <li><strong>Quota progress bar</strong> — Google Tasks API limit je 100 requestov/deň/user. Po dosiahnutí 100 sa background sync zablokuje do polnoci UTC.</li>
          <li><strong>Workspace task listy</strong> — per-workspace Google Tasks list (<code>workspaceTaskLists</code> map).</li>
          <li><strong>🗂️ Legacy</strong> — úlohy ešte v pôvodnom single-task-liste pred PR2 migráciou.</li>
          <li><strong>⚠️ Nemigrovaných</strong> — úlohy v <code>syncedTaskIds</code> ale nepriradené k žiadnemu workspace listu.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔄 Auto-refresh</h4>
        <p>Diagnostika sa obnovuje každých 60s. Pause keď je tab v pozadí (Page Visibility).</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Best practice</h4>
        <ul>
          <li>Pripojenie/odpojenie Google účtu robí user sám v UserMenu → Synchronizácia. Admin tu len monitoruje.</li>
          <li>Ak má user 🚫 Quota 100/100 a chce okamžite sync-ovať — počkať do polnoci UTC alebo manuálne pridať/odstrániť úlohy v Google Tasks.</li>
          <li>Ak je watch expirovaný a user nedostáva push events → user musí re-connectnúť Google v UserMenu.</li>
          <li>Ak sync zaseknutý dlhšie ako pár hodín → skontroluj <strong>Diagnostika → Errors</strong> tab pre OAuth token expiry alebo iné chyby.</li>
        </ul>
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
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ category: '', action: '', search: '', from: '', to: '' });
  const [includeSuperAdmin, setIncludeSuperAdmin] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [userDetailId, setUserDetailId] = useState(null);
  const [userDetail, setUserDetail] = useState(null);

  const fetchLogs = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    const params = { page, limit: 30 };
    if (filters.category) params.category = filters.category;
    if (filters.action) params.action = filters.action;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (includeSuperAdmin) params.includeSuperAdmin = 'true';

    try {
      const res = await adminApi.get('/api/admin/audit-log', { params });
      setLogs(res.data.logs || []);
      setTotalPages(res.data.pages || 1);
      setTotal(res.data.total || 0);
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, filters.category, filters.action, filters.search, filters.from, filters.to, includeSuperAdmin]);

  // Initial + filter-triggered reload
  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Stats fetch — single load + refresh každých 60s
  useEffect(() => {
    let cancelled = false;
    const loadStats = async () => {
      try {
        const r = await adminApi.get('/api/admin/audit-log/stats');
        if (!cancelled) setStats(r.data);
      } catch { /* ignore */ }
    };
    loadStats();
    const id = setInterval(() => { if (!document.hidden) loadStats(); }, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Auto-refresh logs 30s s pause keď je rozbalený detail (user číta JSON)
  useEffect(() => {
    if (expandedLogId) return;
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) fetchLogs(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 30000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchLogs, expandedLogId]);

  // Reset page pri zmene filtrov
  useEffect(() => { setPage(1); }, [filters.category, filters.action, filters.search, filters.from, filters.to, includeSuperAdmin]);

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
    if (d.oldPriority && d.newPriority) parts.push(`priorita ${d.oldPriority} → ${d.newPriority}`);
    if (d.subject) parts.push(`"${d.subject}"`);
    if (d.recipient) parts.push(`→ ${d.recipient}`);
    if (d.reason) parts.push(`Dôvod: ${d.reason}`);
    if (d.changedFields) parts.push(`Polia: ${d.changedFields.join(', ')}`);
    if (d.email && !d.oldRole && !d.oldPlan) parts.push(d.email);
    return parts.length > 0 ? <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{parts.join(' · ')}</span> : null;
  };

  const exportCsv = async () => {
    // Fetch all matching logs (bez paginácie — limit 1000 ako rozumný strop)
    const params = { page: 1, limit: 1000 };
    if (filters.category) params.category = filters.category;
    if (filters.action) params.action = filters.action;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (includeSuperAdmin) params.includeSuperAdmin = 'true';
    try {
      const res = await adminApi.get('/api/admin/audit-log', { params });
      const rows = (res.data.logs || []).map((l) => [
        new Date(l.createdAt).toISOString(),
        l.username || '',
        l.email || '',
        l.action || '',
        l.category || '',
        l.targetType || '',
        l.targetName || '',
        l.ipAddress || '',
        JSON.stringify(l.details || {})
      ]);
      const header = ['Date', 'Username', 'Email', 'Action', 'Category', 'TargetType', 'TargetName', 'IP', 'Details'];
      const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { alert('Export zlyhal'); }
  };

  const openUserDetail = (userId) => {
    if (!userId) return;
    setUserDetailId(userId);
    adminApi.get(`/api/admin/users/${userId}`)
      .then((res) => setUserDetail(res.data))
      .catch(() => setUserDetail(null));
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Audit Log <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 14 }}>({total} záznamov)</span>
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportCsv} className="btn btn-secondary" style={{ fontSize: 12 }}>
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Stat header */}
      {stats && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
            Posledných 24h: <strong>{stats.count24h}</strong>
          </span>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
            Posledných 7d: <strong>{stats.count7d}</strong>
          </span>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
            Posledných 30d: <strong>{stats.count30d}</strong>
          </span>
          {stats.topUsers7d?.length > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', color: '#6D28D9' }}>
              👤 Top user (7d): <strong>{stats.topUsers7d[0].username}</strong> ({stats.topUsers7d[0].count}×)
            </span>
          )}
          {stats.topActions7d?.length > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: 999, background: '#dbeafe', color: '#1e40af' }}>
              🎯 Top akcia (7d): <strong>{ACTION_LABELS[stats.topActions7d[0].action] || stats.topActions7d[0].action}</strong> ({stats.topActions7d[0].count}×)
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13, background: 'var(--bg-primary)' }}>
          <option value="">Všetky kategórie</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input
          type="text"
          placeholder="Action filter (napr. user.plan_changed)"
          value={filters.action}
          onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 12, fontFamily: 'monospace', width: 220 }}
        />
        <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13 }} />
        <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13 }} />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder="🔍 Hľadať meno, email, target..."
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13, flex: 1, minWidth: 150 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '0 8px', cursor: 'pointer', color: 'var(--text-muted)' }} title="Zahrnúť aj akcie super admina (default vylúčené)">
          <input
            type="checkbox"
            checked={includeSuperAdmin}
            onChange={(e) => setIncludeSuperAdmin(e.target.checked)}
          />
          Super admin
        </label>
        {(filters.category || filters.action || filters.search || filters.from || filters.to) && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setFilters({ category: '', action: '', search: '', from: '', to: '' })}
          >
            ✕ Vymazať filtre
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Načítavam...</div>
      ) : logs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Žiadne záznamy</div>
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
              {logs.map((log) => {
                const expanded = expandedLogId === (log.id || log._id);
                return (
                  <Fragment key={log.id || log._id}>
                    <tr
                      onClick={() => setExpandedLogId(expanded ? null : (log.id || log._id))}
                      style={{ cursor: 'pointer', background: expanded ? 'var(--bg-secondary)' : 'transparent' }}
                    >
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{formatDateTime(log.createdAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {log.userId ? (
                          <button
                            onClick={() => openUserDetail(log.userId)}
                            style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 500, color: 'var(--accent-color, #6366f1)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                          >
                            {log.username || '—'}
                          </button>
                        ) : (
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{log.username || 'systém'}</div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{log.email || ''}</div>
                      </td>
                      <td>
                        <span style={{ fontSize: 13 }}>{ACTION_LABELS[log.action] || log.action}</span>
                        {log.category && (
                          <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#f3f4f6', color: '#6b7280' }}>
                            {log.category}
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontSize: 13 }}>{log.targetName || '—'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{log.targetType || ''}</div>
                      </td>
                      <td>{renderDetails(log)}</td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--bg-primary)', padding: 12 }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                            Raw JSON • IP: <code>{log.ipAddress || '—'}</code> • User-Agent: <code style={{ fontSize: 10 }}>{(log.userAgent || '—').slice(0, 100)}</code>
                          </div>
                          <pre style={{ fontSize: 11, background: 'var(--bg-secondary)', padding: 10, borderRadius: 4, margin: 0, overflow: 'auto', maxHeight: 240 }}>
                            {JSON.stringify(log, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ fontSize: 13, padding: '4px 12px' }}>←</button>
          <span style={{ fontSize: 13, padding: '4px 8px', color: 'var(--text-secondary)' }}>{page} / {totalPages}</span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 13, padding: '4px 12px' }}>→</button>
        </div>
      )}

      {/* User detail mini modal */}
      {userDetailId && userDetail && (
        <div className="modal-overlay" onClick={() => { setUserDetailId(null); setUserDetail(null); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600, padding: 20 }}>
            <h3 style={{ marginTop: 0 }}>👤 {userDetail.user?.username}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{userDetail.user?.email}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 12, fontSize: 13 }}>
              <div><strong>Plán:</strong> {userDetail.user?.subscription?.plan || 'free'}</div>
              <div><strong>Rola:</strong> {userDetail.user?.role || 'user'}</div>
              <div><strong>Workspaces:</strong> {userDetail.memberships?.length || 0}</div>
              <div><strong>Kontakty:</strong> {userDetail.stats?.contactCount || 0}</div>
              <div><strong>Projekty:</strong> {userDetail.stats?.taskCount || 0}</div>
              <div><strong>Registrácia:</strong> {userDetail.user?.createdAt ? new Date(userDetail.user.createdAt).toLocaleDateString('sk-SK') : '—'}</div>
            </div>
            <button className="btn btn-secondary" onClick={() => { setUserDetailId(null); setUserDetail(null); }} style={{ marginTop: 16, fontSize: 12 }}>
              Zavrieť
            </button>
          </div>
        </div>
      )}

      <AdminHelpToggle title="Audit log">
        <p><strong>Čo tu vidíš:</strong> kompletnú históriu zmien v aplikácii — kto, kedy, čo zmenil. Slúži na forenznú analýzu a compliance. Defaultne sú vylúčené akcie super admina (toggle "Super admin" pre zobrazenie).</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Stat header</h4>
        <ul>
          <li><strong>Počty 24h / 7d / 30d</strong> — celková aktivita za rôzne obdobia.</li>
          <li><strong>👤 Top user (7d)</strong> — najaktívnejší užívateľ za posledný týždeň.</li>
          <li><strong>🎯 Top akcia (7d)</strong> — najčastejšia akcia za týždeň.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Kategória</strong> — Auth / Contact / Task / Message / Workspace / Billing / User / Security / System.</li>
          <li><strong>Action</strong> — exact match (napr. <code>user.plan_changed</code>, <code>auth.login_failed</code>).</li>
          <li><strong>Dátumový rozsah</strong> — Od / Do.</li>
          <li><strong>Search</strong> — substring v username / email / targetName / action.</li>
          <li><strong>Super admin checkbox</strong> — opt-in zobrazenie tvojich akcií (default skryté).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📋 Tabuľka záznamov</h4>
        <ul>
          <li><strong>Dátum</strong> — kedy akcia nastala.</li>
          <li><strong>Používateľ</strong> — username (klikateľný → user detail modal) + email + IP.</li>
          <li><strong>Akcia</strong> — slovenský label (cez ACTION_LABELS) + kategória badge.</li>
          <li><strong>Cieľ</strong> — targetName + targetType (napr. „Marek Novák" / „user").</li>
          <li><strong>Detaily</strong> — pred/po hodnoty (oldRole → newRole, oldPlan → newPlan, priority changes, subject, recipient, reason, changedFields).</li>
          <li><strong>Klik na riadok</strong> → rozbalí raw JSON s plným kontextom (IP, User-Agent, all details).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📥 Export CSV</h4>
        <p>Tlačidlo vpravo hore exportuje aktuálne <em>filtrovaný</em> zoznam (max 1000 záznamov). Stĺpce: Date / Username / Email / Action / Category / TargetType / TargetName / IP / Details (JSON).</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔄 Auto-refresh</h4>
        <p>Logs sa obnovujú každých 30s, stats každých 60s. Pri rozbalenom raw JSON sa pause, aby ti zápis neskrolloval pod ruky.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Najčastejšie akcie</h4>
        <ul>
          <li><strong>user.plan_auto_expired</strong> — auto-downgrade na Free po vypršaní paidUntil</li>
          <li><strong>user.discount_applied / removed</strong> — admin pridal/odstránil zľavu</li>
          <li><strong>user.subscription_updated</strong> — admin manuálne zmenil plán/paidUntil</li>
          <li><strong>auth.login / auth.oauth.login</strong> — prihlásenie</li>
          <li><strong>auth.login_failed</strong> — failed pokus (cudzia IP = potenciálny brute-force)</li>
          <li><strong>billing.checkout_completed</strong> — reálna Stripe platba</li>
        </ul>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Audit log je append-only. Neexistuje admin UI na delete (iba TTL index v MongoDB by mohol auto-cleanup-ovať staré záznamy — viď Storage tab).
        </p>
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
  const [wsGrowth, setWsGrowth] = useState(null);
  const [activity, setActivity] = useState(null);
  const [plansDist, setPlansDist] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const [ug, wg, act, pd, sum] = await Promise.all([
        adminApi.get(`/api/admin/charts/user-growth?days=${days}`).then(r => r.data).catch(() => []),
        adminApi.get(`/api/admin/charts/workspaces-growth?days=${days}`).then(r => r.data).catch(() => []),
        adminApi.get(`/api/admin/charts/activity?days=${days}`).then(r => r.data).catch(() => []),
        adminApi.get(`/api/admin/charts/plans-distribution?days=${days}`).then(r => r.data).catch(() => []),
        adminApi.get(`/api/admin/charts/summary?days=${days}`).then(r => r.data).catch(() => null)
      ]);
      setUserGrowth(ug);
      setWsGrowth(wg);
      setActivity(act);
      setPlansDist(pd);
      setSummary(sum);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh 60s s Page Visibility pause
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

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

  const wsGrowthData = wsGrowth && {
    labels: wsGrowth.map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Celkovo workspace-ov',
        data: wsGrowth.map(d => d.cumulative),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.1)',
        fill: true,
        tension: 0.3,
        yAxisID: 'y'
      },
      {
        label: 'Nové workspace-y',
        data: wsGrowth.map(d => d.daily),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        fill: true,
        tension: 0.3,
        yAxisID: 'y1'
      }
    ]
  };

  // Plans distribution — stacked area chart pre vizualizáciu zmeny pomeru
  // free/team/pro v čase. Pri PrplCRM v early stage bude graf rovný (všetko
  // free), ale po prvých Stripe plat-coch vidíme reálny shift.
  const plansDistData = plansDist && {
    labels: plansDist.map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Free',
        data: plansDist.map(d => d.free || 0),
        borderColor: '#94a3b8',
        backgroundColor: 'rgba(148, 163, 184, 0.5)',
        fill: true,
        tension: 0.2,
        stack: 'a'
      },
      {
        label: 'Tím',
        data: plansDist.map(d => d.team || 0),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.5)',
        fill: true,
        tension: 0.2,
        stack: 'a'
      },
      {
        label: 'Pro',
        data: plansDist.map(d => d.pro || 0),
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.5)',
        fill: true,
        tension: 0.2,
        stack: 'a'
      }
    ]
  };

  // Activity — rozšírené o všetky 7 audit kategórií. Bez nich graf
  // ukazoval len 4/7 events a vyzeral "chudobne".
  const activityData = activity && {
    labels: activity.map(d => formatLabel(d.date)),
    datasets: [
      { label: '👤 Kontakty', data: activity.map(d => d.contact || 0), backgroundColor: chartColors.blue, stack: 'a' },
      { label: '📋 Projekty', data: activity.map(d => d.task || 0), backgroundColor: chartColors.green, stack: 'a' },
      { label: '✉️ Správy', data: activity.map(d => d.message || 0), backgroundColor: chartColors.orange, stack: 'a' },
      { label: '🏢 Workspace', data: activity.map(d => d.workspace || 0), backgroundColor: '#06b6d4', stack: 'a' },
      { label: '💰 Billing', data: activity.map(d => d.billing || 0), backgroundColor: '#10b981', stack: 'a' },
      { label: '👥 User', data: activity.map(d => d.user || 0), backgroundColor: '#ec4899', stack: 'a' },
      { label: '🔓 Auth', data: activity.map(d => d.auth || 0), backgroundColor: chartColors.gray, stack: 'a' }
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Grafy a analytika
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h2>
        {/* Period button group — viditeľnejšie ako dropdown */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-secondary)', padding: 4, borderRadius: 'var(--radius-md)' }}>
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '6px 14px',
                background: days === d ? 'var(--accent-color, #6366f1)' : 'transparent',
                color: days === d ? 'white' : 'var(--text-primary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: days === d ? 600 : 400
              }}
            >
              {d === 365 ? '1 rok' : `${d} dní`}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards — peak day, average, total */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          <DiagStat label={`Nové registrácie (${summary.windowDays}d)`} value={summary.newUsers} color="#10b981" />
          <DiagStat label={`Nové workspace-y (${summary.windowDays}d)`} value={summary.newWorkspaces} color="#06b6d4" />
          <DiagStat label="Priemer registrácií / deň" value={summary.avgRegPerDay} color="#8b5cf6" />
          <DiagStat label="Priemer aktivity / deň" value={summary.avgActivityPerDay} color="#6366f1" />
          {summary.peakRegDay && (
            <DiagStat
              label={`Peak deň: ${new Date(summary.peakRegDay.date).toLocaleDateString('sk-SK')}`}
              value={`${summary.peakRegDay.count} reg.`}
              color="#f59e0b"
            />
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '24px' }}>
        {growthData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>📈 Rast používateľov</h3>
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

        {wsGrowthData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>🏢 Rast workspace-ov</h3>
            <div style={{ height: '280px' }}>
              <Line data={wsGrowthData} options={{
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

        {plansDistData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>💳 Rozdelenie plánov v čase (cumulative snapshot)</h3>
            <div style={{ height: '300px' }}>
              <Line data={plansDistData} options={{
                ...chartOpts,
                scales: { ...chartOpts.scales, y: { stacked: true } }
              }} />
            </div>
          </div>
        )}

        {activityData && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '20px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>⚡ Aktivita podľa kategórie</h3>
            <div style={{ height: '320px' }}>
              <Bar data={activityData} options={{
                ...chartOpts,
                scales: { ...chartOpts.scales, x: { ...chartOpts.scales.x, stacked: true }, y: { stacked: true } }
              }} />
            </div>
          </div>
        )}
      </div>

      <AdminHelpToggle title="Grafy">
        <p><strong>Čo tu vidíš:</strong> vizuálne trendy rastu aplikácie — registrácie, workspaces, plány v čase, aktivita po kategóriách. Všetky dáta sú agregované server-side a vylučujú super admin akcie aby reflektovali skutočnú produkčnú metriku.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📅 Period selector</h4>
        <p>Button group hore vpravo — <strong>7 dní / 30 dní / 90 dní / 1 rok</strong>. Všetky 5 grafov + stat cards sa prepočítajú podľa zvoleného obdobia. Auto-refresh každých 60s.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Stat cards (hore)</h4>
        <ul>
          <li><strong>Nové registrácie</strong> — total nových userov za zvolené obdobie.</li>
          <li><strong>Nové workspace-y</strong> — analogicky pre workspaces.</li>
          <li><strong>Priemer registrácií / deň</strong> — total / N dní (užitočné pre porovnanie období).</li>
          <li><strong>Priemer aktivity / deň</strong> — celkový počet audit log eventov / N dní.</li>
          <li><strong>Peak deň</strong> — deň s najviac registráciami v období + počet.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📈 Rast používateľov</h4>
        <p>Dual-axis Line chart: <em>kumulatívny total</em> (ľavá os) + <em>denné nové registrácie</em> (pravá os). Healthy growth = stúpajúca cumulatívna krivka so stabilnými alebo rastúcimi dennými spike-mi.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🏢 Rast workspace-ov</h4>
        <p>Analogický graf pre workspaces. Pomer workspace : user blízky 1:1 = každý user si vytvára vlastný workspace; pomer {'>'} 1.5 = power useri s viacerými projektmi.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💳 Rozdelenie plánov v čase</h4>
        <p>Stacked Line chart kumulatívnej distribúcie Free/Tím/Pro. Aproximácia — berie aktuálny plán userov a aplikuje ho retroaktívne podľa createdAt (nereflektuje historické plan zmeny). Pre presný revenue tracking pozri <em>Diagnostika → Príjmy</em>.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>⚡ Aktivita podľa kategórie</h4>
        <p>Stacked Bar chart denných audit log eventov rozdelených na 7 kategórií: 👤 Kontakty, 📋 Projekty, ✉️ Správy, 🏢 Workspace, 💰 Billing, 👥 User, 🔓 Auth. Zobrazuje skutočné používanie produktu — ktoré features sú najaktívnejšie.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Daily check rituál</h4>
        <ol>
          <li>Stat cards — pomer registrácií 7d vs predošlých 7d (otvor 7d a porovnaj).</li>
          <li>Rast používateľov — krivka stúpa? Plat-eau alebo pokles = problém.</li>
          <li>Plans distribution — pomer paid:free rastie? Ak rok-na-rok stagnuje, treba upgrade marketing alebo pricing tweak.</li>
          <li>Aktivita — Auth + Contact dominantné? Ak Task/Message minimálne, engagement je slabý.</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Všetky grafy fetchujú agregované dáta zo servera (žiadny per-user lookup), preto sú rýchle aj pri tisícoch userov. Hover na bod ukáže presnú hodnotu pre daný deň. Toto je read-only pohľad — pre úpravy choď do tabu Používatelia / Workspace-y.
        </p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: ACTIVITY FEED TAB ─────────────────────────────────────
// Rozšírená mapa action → emoji ikona pre activity feed. Pokrýva všetky
// existujúce audit log actions (vrátane novších task.priority_changed,
// task.assigned, push.failed atď.). Bez záznamu vyzerá feed plný "📌"
// fallback ikon.
const ACTION_ICONS = {
  // Auth
  'auth.login': '🔓', 'auth.login_failed': '🚫',
  'auth.register': '📝', 'auth.logout': '🚪',
  'auth.oauth.login': '🔐', 'auth.oauth.register': '🆕', 'auth.oauth.connect': '🔗',
  'auth.password_changed': '🔑', 'auth.password_reset_requested': '📧',
  // Contact
  'contact.created': '👤', 'contact.updated': '✏️', 'contact.deleted': '🗑️',
  // Task / project
  'task.created': '📋', 'task.updated': '✏️', 'task.completed': '✅',
  'task.deleted': '🗑️', 'task.assigned': '🎯', 'task.priority_changed': '🚩',
  'subtask.created': '📝', 'subtask.completed': '✓',
  // Message
  'message.created': '✉️', 'message.approved': '✅',
  'message.rejected': '❌', 'message.deleted': '🗑️',
  // Workspace
  'workspace.created': '🏢', 'workspace.deleted': '🗑️',
  'workspace.member_added': '👥', 'workspace.member_removed': '👋',
  // User / billing
  'user.role_changed': '🔑', 'user.plan_changed': '💳',
  'user.subscription_updated': '💳', 'user.discount_applied': '🏷️',
  'user.deleted': '🗑️', 'user.email_manual_send': '📤',
  'user.plan_auto_expired': '⏰',
  // Billing
  'billing.checkout_completed': '💰',
  'billing.subscription_created': '💳', 'billing.subscription_renewed': '🔄',
  'billing.subscription_canceled': '🛑',
  // Admin / security
  'admin.migrate_encrypt_tokens': '🔐'
};

function ActivityFeedTab() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [paused, setPaused] = useState(false); // smart pause pri user scrolli
  const [filterCategory, setFilterCategory] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [userDetailId, setUserDetailId] = useState(null);
  const [userDetail, setUserDetail] = useState(null);
  const timerRef = useRef(null);
  const scrollRef = useRef(null);

  const fetchEvents = useCallback((opts = {}) => {
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.before) params.set('before', opts.before);
    params.set('limit', opts.limit || 50);
    if (filterCategory) params.set('category', filterCategory);
    if (filterAction) params.set('action', filterAction);
    if (search.trim()) params.set('search', search.trim());
    return adminApi.get(`/api/admin/activity-feed?${params.toString()}`)
      .then((r) => r.data)
      .catch(() => []);
  }, [filterCategory, filterAction, search]);

  // Initial load + reload on filter change
  useEffect(() => {
    setLoading(true);
    fetchEvents({ limit: 50 }).then((data) => {
      setEvents(data);
      setHasMore(data.length === 50);
      setLoading(false);
    });
  }, [fetchEvents]);

  // Auto-refresh — polls new events každých 10s. Pauza pri:
  //  - autoRefresh toggle = false
  //  - admin user scrollol nadol (paused = true) — nový event by skočil pod ruky
  //  - filter aktívny (search/category/action) — nemá zmysel polling-ovať
  //    novšie eventy ktoré možno nepatria do filtra
  useEffect(() => {
    if (!autoRefresh || paused || filterCategory || filterAction || search) {
      clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(async () => {
      if (events.length === 0) return;
      const latest = events[0]?.createdAt;
      if (!latest) return;
      const newEvents = await fetchEvents({ after: latest, limit: 20 });
      if (newEvents.length > 0) {
        setEvents((prev) => [...newEvents, ...prev].slice(0, 500));
      }
    }, 10000);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, paused, events, fetchEvents, filterCategory, filterAction, search]);

  // Detect manual scroll — keď je užívateľ ďaleko od top, pauznime auto-refresh
  // aby mu nový event neskočil pod prst pri čítaní starších záznamov.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setPaused(el.scrollTop > 100);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || events.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = events[events.length - 1]?.createdAt;
      const more = await fetchEvents({ before: oldest, limit: 50 });
      if (more.length > 0) {
        setEvents((prev) => [...prev, ...more]);
        if (more.length < 50) setHasMore(false);
      } else {
        setHasMore(false);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const handleUsernameClick = (e, userId) => {
    e.stopPropagation();
    if (!userId) return;
    setUserDetailId(userId);
    adminApi.get(`/api/admin/users/${userId}`)
      .then((res) => setUserDetail(res.data))
      .catch(() => setUserDetail(null));
  };

  const formatTime = (d) => {
    const date = new Date(d);
    const now = new Date();
    const diffMs = now - date;
    if (diffMs < 60000) return 'práve teraz';
    if (diffMs < 3600000) return `pred ${Math.floor(diffMs / 60000)} min`;
    if (diffMs < 86400000) return `pred ${Math.floor(diffMs / 3600000)} h`;
    return date.toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // Day-bucket separator: 'dnes' / 'včera' / formatted date.
  // Vykresľuje sa ako sticky header pred prvým eventom daného dňa pre
  // jasnejšiu časovú orientáciu pri scrollovaní.
  const formatDayBucket = (d) => {
    const date = new Date(d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);
    if (dateOnly.getTime() === today.getTime()) return '📅 Dnes';
    if (dateOnly.getTime() === yesterday.getTime()) return '📅 Včera';
    return `📅 ${date.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  };

  // Detail formatter — rozšírená verzia pôvodnej (mala iba oldRole/oldPlan/subject).
  // Teraz pokrýva: role/plan zmeny, message subject, task title (priority,
  // assignedTo), discount type/value, mailové akcie, atď.
  const formatDetails = (e) => {
    const d = e.details || {};
    const parts = [];
    if (d.oldRole && d.newRole) parts.push(`${d.oldRole} → ${d.newRole}`);
    if (d.oldPlan && d.newPlan) parts.push(`${d.oldPlan} → ${d.newPlan}`);
    if (d.newPriority && d.oldPriority) parts.push(`${d.oldPriority} → ${d.newPriority}`);
    if (d.subject) parts.push(`„${d.subject}"`);
    if (d.type && d.value !== undefined) parts.push(`${d.type}: ${d.value}`);
    if (d.reason) parts.push(d.reason);
    if (e.ipAddress && e.action === 'auth.login_failed') parts.push(`IP ${e.ipAddress}`);
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  // Skupinové oddelovače dní — vytvoríme pole entries kde každý event je
  // buď separator alebo log entry. Sticky div sa renderuje pred prvým
  // event-om daného dňa.
  const renderEntries = () => {
    let lastDay = null;
    const out = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const day = new Date(e.createdAt).toDateString();
      if (day !== lastDay) {
        out.push({ type: 'separator', key: `sep-${day}`, label: formatDayBucket(e.createdAt) });
        lastDay = day;
      }
      out.push({ type: 'event', key: e.id || i, event: e, isFirst: i === 0 });
    }
    return out;
  };

  if (loading) return <div className="sa-loading">Načítavam aktivitu...</div>;

  const filtersActive = !!(filterCategory || filterAction || search);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Live aktivita
          {autoRefresh && !paused && !filtersActive && (
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#22C55E', marginLeft: 8, animation: 'pulse 2s infinite' }} />
          )}
          {paused && <span style={{ marginLeft: 8, fontSize: 11, color: '#f59e0b' }}>⏸ pauza (scroll)</span>}
          {filtersActive && <span style={{ marginLeft: 8, fontSize: 11, color: '#94a3b8' }}>auto-refresh vypnutý (filter aktívny)</span>}
        </h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (10s)
        </label>
      </div>

      {/* Filtre */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          type="text"
          placeholder="🔍 Hľadať username / email / target..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input"
          style={{ flex: '1 1 200px', minWidth: 180, fontSize: 13 }}
        />
        <select value={filterCategory} onChange={(e) => { setFilterCategory(e.target.value); setFilterAction(''); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13 }}>
          <option value="">Všetky kategórie</option>
          <option value="auth">🔓 Auth</option>
          <option value="contact">👤 Contact</option>
          <option value="task">📋 Task</option>
          <option value="message">✉️ Message</option>
          <option value="workspace">🏢 Workspace</option>
          <option value="billing">💰 Billing</option>
          <option value="user">👥 User</option>
          <option value="security">🔐 Security</option>
        </select>
        <input
          type="text"
          placeholder="Action (napr. task.completed)"
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="form-input"
          style={{ width: 200, fontSize: 13, fontFamily: 'monospace' }}
        />
        {filtersActive && (
          <button
            className="btn btn-secondary"
            onClick={() => { setSearch(''); setFilterCategory(''); setFilterAction(''); }}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            ✕ Vymazať filtre
          </button>
        )}
      </div>

      <div ref={scrollRef} style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '65vh', overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 8, background: 'var(--bg-primary)' }}>
        {events.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            {filtersActive ? 'Žiadne výsledky pre tento filter' : 'Žiadna aktivita'}
          </div>
        )}
        {renderEntries().map((entry) => {
          if (entry.type === 'separator') {
            return (
              <div key={entry.key} style={{
                position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 1,
                padding: '6px 8px', fontSize: 12, fontWeight: 600,
                color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)',
                marginBottom: 4
              }}>
                {entry.label}
              </div>
            );
          }
          const e = entry.event;
          const detailLine = formatDetails(e);
          return (
            <div key={entry.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px',
              background: entry.isFirst && events.length > 1 ? 'var(--primary-light, #EDE9FE)' : 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)', fontSize: 13, transition: 'background 0.3s'
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{ACTION_ICONS[e.action] || '📌'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  {e.userId ? (
                    <button
                      onClick={(ev) => handleUsernameClick(ev, e.userId)}
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        fontWeight: 600, color: 'var(--accent-color, #6366f1)',
                        cursor: 'pointer', fontSize: 13, fontFamily: 'inherit'
                      }}
                      title="Otvoriť detail užívateľa"
                    >
                      {e.username || '—'}
                    </button>
                  ) : (
                    <strong>{e.username || 'systém'}</strong>
                  )}
                  <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>{ACTION_LABELS[e.action] || e.action}</span>
                  {e.targetName && <span style={{ marginLeft: 4 }}>— {e.targetName}</span>}
                </div>
                {detailLine && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {detailLine}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatTime(e.createdAt)}
              </span>
            </div>
          );
        })}
        {/* Load-more — len keď nie je filter aktívny (pre filter ide nový query) */}
        {events.length > 0 && hasMore && !filtersActive && (
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            style={{
              padding: '10px', fontSize: 12, background: 'transparent',
              border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer', color: 'var(--text-muted)', marginTop: 8
            }}
          >
            {loadingMore ? 'Načítavam...' : '↓ Zobraziť staršie'}
          </button>
        )}
      </div>

      {/* User detail modal — dovedie ho z events feed-u (klik na username) */}
      {userDetailId && userDetail && (
        <div className="modal-overlay" onClick={() => { setUserDetailId(null); setUserDetail(null); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600, padding: 20 }}>
            <h3 style={{ marginTop: 0 }}>👤 {userDetail.user?.username}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{userDetail.user?.email}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 12, fontSize: 13 }}>
              <div><strong>Plán:</strong> {userDetail.user?.subscription?.plan || 'free'}</div>
              <div><strong>Rola:</strong> {userDetail.user?.role || 'user'}</div>
              <div><strong>Workspaces:</strong> {userDetail.memberships?.length || 0}</div>
              <div><strong>Kontakty:</strong> {userDetail.stats?.contactCount || 0}</div>
              <div><strong>Projekty:</strong> {userDetail.stats?.taskCount || 0}</div>
              <div><strong>Registrácia:</strong> {userDetail.user?.createdAt ? new Date(userDetail.user.createdAt).toLocaleDateString('sk-SK') : '—'}</div>
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => { setUserDetailId(null); setUserDetail(null); }}
              style={{ marginTop: 16, fontSize: 12 }}
            >
              Zavrieť
            </button>
          </div>
        </div>
      )}

      <AdminHelpToggle title="Aktivita">
        <p><strong>Čo tu vidíš:</strong> live feed posledných akcií v aplikácii s ~10s polling latency. Krátkejšia a rýchlejšia verzia Audit logu, určená na monitoring v reálnom čase.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Search</strong> — substring v <em>username / email / targetName</em>. Užitočné pre nájdenie všetkých akcií konkrétneho usera ("ako Ján používa appku").</li>
          <li><strong>Kategória</strong> — Auth / Contact / Task / Message / Workspace / Billing / User / Security.</li>
          <li><strong>Action</strong> — exact match na audit action (napr. <code>task.completed</code>, <code>auth.login_failed</code>). Pre konkrétny event type.</li>
          <li><strong>Pri aktívnom filtri</strong> sa auto-refresh automaticky <strong>vypína</strong> aby sa nemiešali nové eventy s filtrovanou históriou.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📅 Day separators</h4>
        <p>Sticky header pre každý nový deň: <em>📅 Dnes / Včera / streda 7. máj</em>. Pri scrollovaní sa nadpis prilepí navrch — vždy vieš z ktorého dňa udalosť pochádza.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🟢 Auto-refresh + smart pause</h4>
        <ul>
          <li>Default 10s polling (toggle vpravo hore na vypnutie).</li>
          <li><strong>Smart pause pri scrollovaní</strong> — keď scrollneš nadol viac ako 100px, polling sa zastaví aby ti nový event neskočil pod prst pri čítaní staršej položky. Po scroll-back nahor sa znova zapne.</li>
          <li>Filter aktívny → auto-refresh vypnutý úplne.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>👤 Klik na username</h4>
        <p>Otvorí mini-detail modal s kľúčovými údajmi (plán, rola, počty workspaces / kontaktov / projektov, dátum registrácie). Pre plnú správu užívateľa choď do tabu <strong>Používatelia</strong>.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📋 Detail riadku</h4>
        <ul>
          <li>Ikona action-u (rôzne emoji per typ — login, contact, task, billing atď.)</li>
          <li><strong>Username</strong> (klikateľný) → action label → cieľ akcie ("— názov projektu / kontaktu / správy").</li>
          <li>Druhý riadok ak má detail: <code>old → new</code> hodnoty (rola, plán, priority), subject správy, IP pri failed login, atď.</li>
          <li>Časová značka vpravo: relatívna ("pred 5 min") alebo absolútna ({'>'} 24h).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>↓ Load more</h4>
        <p>Tlačidlo „Zobraziť staršie" načíta ďalších 50 eventov. Funguje len bez aktívneho filtra (s filtrom by si mal použiť Audit log tab pre plnú pagináciu).</p>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Super admin akcie sa do feed-u nezarátavajú aby reflektoval skutočnú user-base aktivitu. Pre plný audit (vrátane svojich akcií) pozri tab <strong>Audit log</strong>.
        </p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: API METRICS TAB ───────────────────────────────────────
function ApiMetricsTab() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [routesView, setRoutesView] = useState('top'); // 'top' | 'slow' | 'errors'
  const [routeSearch, setRouteSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [routeSort, setRouteSort] = useState('total'); // 'total' | 'avgDuration' | 'errors' | 'route'
  const [routeOrder, setRouteOrder] = useState('desc');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const r = await adminApi.get('/api/admin/api-metrics');
      setMetrics(r.data);
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh 30s s Page Visibility pause
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 30000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const handleReset = async () => {
    if (!confirm('Resetovať všetky API metriky? Stratíš kompletnú históriu zberu od posledného reštartu.')) return;
    try {
      await adminApi.post('/api/admin/performance/reset');
      await load();
    } catch { alert('Reset zlyhal'); }
  };

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

  // Status groups summary
  const groups = metrics.statusGroups || { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };

  // Routes view selection — top by total / slow / errors
  const baseRoutes = routesView === 'slow' ? (metrics.topSlowRoutes || [])
    : routesView === 'errors' ? (metrics.topErrorRoutes || [])
    : (metrics.topRoutes || []);

  // Filter + sort
  const filteredRoutes = baseRoutes
    .filter((r) => {
      if (routeSearch && !r.route.toLowerCase().includes(routeSearch.toLowerCase())) return false;
      if (methodFilter && !(r.methods || {})[methodFilter]) return false;
      return true;
    })
    .sort((a, b) => {
      let av = a[routeSort] ?? 0;
      let bv = b[routeSort] ?? 0;
      if (routeSort === 'route') {
        av = a.route; bv = b.route;
        return routeOrder === 'asc' ? String(av).localeCompare(bv) : String(bv).localeCompare(av);
      }
      return routeOrder === 'asc' ? av - bv : bv - av;
    });

  const handleRouteSort = (col) => {
    if (routeSort === col) setRouteOrder(routeOrder === 'asc' ? 'desc' : 'asc');
    else { setRouteSort(col); setRouteOrder('desc'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          API Metriky
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h2>
        <button onClick={handleReset} className="btn btn-secondary" style={{ fontSize: 12 }}>
          🗑️ Reset metrík
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        {[
          { label: 'Celkom requestov', value: metrics.totalRequests.toLocaleString() },
          { label: 'Req/min (avg)', value: metrics.requestsPerMinute },
          { label: 'Error rate', value: `${metrics.errorRate}%`, color: metrics.errorRate > 5 ? '#ef4444' : metrics.errorRate > 1 ? '#f59e0b' : '#10b981' },
          { label: 'Tracking od', value: new Date(metrics.trackingSince).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '12px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: s.color || 'inherit' }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Status groups summary cards — agregát z 2xx/3xx/4xx/5xx */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 24 }}>
        <div style={{ padding: 10, background: '#d1fae5', borderRadius: 'var(--radius-sm)', textAlign: 'center', border: '1px solid #6ee7b7' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#065f46' }}>{groups['2xx'].toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#047857' }}>2xx Success</div>
        </div>
        <div style={{ padding: 10, background: '#dbeafe', borderRadius: 'var(--radius-sm)', textAlign: 'center', border: '1px solid #93c5fd' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#1e40af' }}>{groups['3xx'].toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#1d4ed8' }}>3xx Redirect</div>
        </div>
        <div style={{ padding: 10, background: '#fef3c7', borderRadius: 'var(--radius-sm)', textAlign: 'center', border: '1px solid #fcd34d' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#92400e' }}>{groups['4xx'].toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#b45309' }}>4xx Client Error</div>
        </div>
        <div style={{ padding: 10, background: '#fee2e2', borderRadius: 'var(--radius-sm)', textAlign: 'center', border: '1px solid #fca5a5' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#991b1b' }}>{groups['5xx'].toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#b91c1c' }}>5xx Server Error</div>
        </div>
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

      {/* Endpoints panel — view switcher + filter + table */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          {/* View tabs */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg-primary)', padding: 4, borderRadius: 'var(--radius-sm)' }}>
            {[
              { id: 'top', label: '📊 Top podľa volaní' },
              { id: 'slow', label: '🐢 Najpomalšie' },
              { id: 'errors', label: '🚨 Najviac zlyháva' }
            ].map((v) => (
              <button
                key={v.id}
                onClick={() => setRoutesView(v.id)}
                style={{
                  padding: '6px 12px', fontSize: 12,
                  background: routesView === v.id ? 'var(--accent-color, #6366f1)' : 'transparent',
                  color: routesView === v.id ? 'white' : 'var(--text-primary)',
                  border: 'none', borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer', fontWeight: routesView === v.id ? 600 : 400
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="🔍 Hľadať endpoint..."
              value={routeSearch}
              onChange={(e) => setRouteSearch(e.target.value)}
              className="form-input"
              style={{ fontSize: 12, width: 200, fontFamily: 'monospace' }}
            />
            <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 12 }}>
              <option value="">Všetky metódy</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '450px', overflow: 'auto' }}>
          {filteredRoutes.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
              {baseRoutes.length === 0 ? 'Žiadne dáta — metriky sa začnú zbierať po reštarte' : 'Žiadne výsledky pre filter'}
            </div>
          )}
          {filteredRoutes.length > 0 && (
            <>
              {/* Header row — clickable sort */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => handleRouteSort('route')}>
                  Route {routeSort === 'route' && (routeOrder === 'asc' ? '▲' : '▼')}
                </span>
                <span style={{ width: 130, textAlign: 'right' }}>Methods</span>
                <span style={{ width: 70, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleRouteSort('total')}>
                  Total {routeSort === 'total' && (routeOrder === 'asc' ? '▲' : '▼')}
                </span>
                <span style={{ width: 80, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleRouteSort('avgDuration')}>
                  Avg {routeSort === 'avgDuration' && (routeOrder === 'asc' ? '▲' : '▼')}
                </span>
                <span style={{ width: 70, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleRouteSort('errors')}>
                  Errors {routeSort === 'errors' && (routeOrder === 'asc' ? '▲' : '▼')}
                </span>
              </div>
              {filteredRoutes.map((r, i) => {
                const errorPct = r.total > 0 ? Math.round((r.errors / r.total) * 100) : 0;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: 12, fontFamily: 'monospace' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.route}</span>
                    <span style={{ width: 130, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>
                      {Object.entries(r.methods || {}).map(([m, c]) => `${m}:${c}`).join(' ')}
                    </span>
                    <span style={{ width: 70, textAlign: 'right', fontWeight: 600 }}>{r.total}</span>
                    <span style={{
                      width: 80, textAlign: 'right',
                      color: r.avgDuration > 1000 ? '#ef4444' : r.avgDuration > 500 ? '#f59e0b' : 'var(--text-muted)',
                      fontWeight: r.avgDuration > 500 ? 600 : 400
                    }}>
                      {r.avgDuration}ms
                    </span>
                    <span style={{
                      width: 70, textAlign: 'right',
                      color: r.errors > 0 ? (errorPct > 10 ? '#ef4444' : '#f59e0b') : 'var(--text-muted)',
                      fontWeight: r.errors > 0 ? 600 : 400
                    }}>
                      {r.errors > 0 ? `${r.errors} (${errorPct}%)` : '0'}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <AdminHelpToggle title="API metriky">
        <p><strong>Čo tu vidíš:</strong> štatistiky výkonu serverového API — koľko requestov sa volá, ktoré endpointy sú najťažšie, error rate, distribúcia status kódov.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Summary cards</h4>
        <ul>
          <li><strong>Celkom requestov</strong> — kumulatívny počet HTTP requestov od posledného reštartu / resetu.</li>
          <li><strong>Req/min (avg)</strong> — priemerná frekvencia volaní za sledované obdobie.</li>
          <li><strong>Error rate</strong> — % requestov s 4xx/5xx odpoveďou. Farebné: zelená (≤1%), oranžová (1-5%), červená ({'>'}5%).</li>
          <li><strong>Tracking od</strong> — kedy sa začalo zbieranie metrík (reštart servera alebo manual reset).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🎨 Status code groups</h4>
        <p>4 farebné karty: <strong>2xx Success</strong> (zelená), <strong>3xx Redirect</strong> (modrá), <strong>4xx Client Error</strong> (oranžová), <strong>5xx Server Error</strong> (červená). Zdravý pomer: 2xx {'>'} 95%, 5xx {'<'} 1%.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📈 Grafy</h4>
        <ul>
          <li><strong>Requesty za posledných 24h</strong> — Line chart hourly volume. Sledovať peak hodiny aplikácie.</li>
          <li><strong>Status kódy</strong> — Doughnut chart presnejších kódov (200, 401, 404, 500...). Healthy = dominantne zelená.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔀 3 view tabs (endpointy)</h4>
        <ul>
          <li><strong>📊 Top podľa volaní</strong> — endpointy s najvyšším počtom volaní (default). Tieto sú "hot path" — najdôležitejšie pre optimalizáciu.</li>
          <li><strong>🐢 Najpomalšie</strong> — top 10 endpointov podľa avgDuration (s minimum 5 volaní aby sa neukázali one-off outlier-y). Cieľ: žiadny endpoint nad 1000ms.</li>
          <li><strong>🚨 Najviac zlyháva</strong> — endpointy ktoré vrátili 4xx/5xx aspoň raz. Ukazuje tiež error % per route.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filter + sort</h4>
        <ul>
          <li><strong>Search box</strong> — substring v ceste endpointu (napr. <code>/api/contacts</code>).</li>
          <li><strong>Method filter</strong> — len GET / POST / PUT / DELETE / PATCH.</li>
          <li><strong>Klik na header column</strong> (Route / Total / Avg / Errors) → sort + toggle order.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔄 Auto-refresh + reset</h4>
        <ul>
          <li>Auto-refresh každých 30s s Page Visibility pause.</li>
          <li><strong>🗑️ Reset metrík</strong> — vyčistí in-memory counters. Užitočné po deployi alebo pri sledovaní efektu optimalizácie.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Daily check rituál</h4>
        <ol>
          <li>Error rate {'<'} 1%? Ak nie, otvor "🚨 Najviac zlyháva" view.</li>
          <li>5xx counter pri zelenej (0)? Žiadne vážne servery erorroy?</li>
          <li>"🐢 Najpomalšie" view — žiadny endpoint nad 1000ms?</li>
          <li>Hourly chart — peak hodiny zhodné s očakávaním (pracovné hodiny SK 9-17h)?</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Metriky sa zbierajú in-memory v server procese (apiMetrics service) — pri reštarte servera sa vynulujú. Žiadna persistencia v DB. Pre dlhodobý perf monitoring zvážiť APM (DataDog, New Relic, OpenTelemetry).
        </p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: STORAGE TAB ───────────────────────────────────────────
// Slovenské labely pre Mongo kolekcie. Sync s collection list v
// /api/admin/storage backende. Pri pridaní novej kolekcie treba upraviť
// obe miesta.
const STORAGE_COLL_LABELS = {
  users: '👥 Používatelia',
  workspaces: '🏢 Workspace-y',
  workspacemembers: '🤝 Členstvá',
  contacts: '👤 Kontakty',
  tasks: '📋 Projekty',
  messages: '✉️ Správy',
  notifications: '🔔 Notifikácie',
  pushsubscriptions: '🌐 Web push subs',
  apnsdevices: '🍎 APNs zariadenia',
  fcmdevices: '🤖 FCM zariadenia',
  auditlogs: '📜 Audit log',
  servererrors: '🔴 Server errory',
  pages: '📄 Stránky',
  emaillogs: '📧 Email log',
  promocodes: '🎟️ Promo kódy',
  invitations: '✉️ Pozvánky'
};

function StorageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per-workspace search + sort + paginácia
  const [wsSearch, setWsSearch] = useState('');
  const [wsSort, setWsSort] = useState('totalDocs');
  const [wsOrder, setWsOrder] = useState('desc');
  const [wsPage, setWsPage] = useState(1);
  const wsPerPage = 50;

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const r = await adminApi.get('/api/admin/storage');
      setData(r.data);
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh 60s s Page Visibility pause — storage sa zriedka
  // dramaticky mení, 60s je primerané.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  if (loading) return <div className="sa-loading">Načítavam storage metriky...</div>;
  if (!data) return <div className="sa-error">Nepodarilo sa načítať storage</div>;

  const fmtSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  };

  // Doughnut iba top 8 kolekcií + ostatné — inak je legenda nečitateľná
  // pri 16 položkách.
  const topColls = data.collections.slice(0, 8);
  const restColls = data.collections.slice(8);
  const restSize = restColls.reduce((sum, c) => sum + c.size, 0);
  const collectionData = {
    labels: [
      ...topColls.map(c => STORAGE_COLL_LABELS[c.name] || c.name),
      ...(restColls.length > 0 ? [`+${restColls.length} ostatných`] : [])
    ],
    datasets: [{
      data: [...topColls.map(c => c.size), ...(restColls.length > 0 ? [restSize] : [])],
      backgroundColor: [chartColors.primary, chartColors.blue, chartColors.green, chartColors.orange, chartColors.red, chartColors.gray, '#EC4899', '#06B6D4', '#84CC16']
    }]
  };

  // Per-workspace filter + sort + paginácia
  const filteredWs = (data.perWorkspace || [])
    .filter((w) => !wsSearch || (w.name || '').toLowerCase().includes(wsSearch.toLowerCase()))
    .sort((a, b) => {
      let av = a[wsSort] ?? 0; let bv = b[wsSort] ?? 0;
      if (wsSort === 'name') {
        av = a.name || ''; bv = b.name || '';
        return wsOrder === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return wsOrder === 'asc' ? av - bv : bv - av;
    });
  const wsTotalPages = Math.max(1, Math.ceil(filteredWs.length / wsPerPage));
  const pagedWs = filteredWs.slice((wsPage - 1) * wsPerPage, wsPage * wsPerPage);

  const handleWsSort = (col) => {
    if (wsSort === col) setWsOrder(wsOrder === 'asc' ? 'desc' : 'asc');
    else { setWsSort(col); setWsOrder('desc'); }
  };

  // Atlas tier usage warning gradient (zelená/oranžová/červená)
  const usagePct = data.database.usagePct || 0;
  const tierColor = usagePct < 60 ? '#10b981' : usagePct < 85 ? '#f59e0b' : '#ef4444';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Storage metriky
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h2>
      </div>

      {/* DB overview cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '12px' }}>
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

      {/* Atlas tier usage card s progress bar */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: 16, border: '1px solid var(--border-color)', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            ☁️ MongoDB Atlas tier usage ({data.database.tierLimitMb} MB)
          </h3>
          <span style={{ fontSize: 13, fontWeight: 700, color: tierColor }}>
            {usagePct}% využité
          </span>
        </div>
        <div style={{ height: 12, background: 'var(--bg-primary)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            width: `${Math.min(100, usagePct)}%`,
            height: '100%',
            background: tierColor,
            transition: 'width 0.5s ease'
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{fmtSize(data.database.storageSize)} z {data.database.tierLimitMb} MB</span>
          <span>
            {usagePct < 60 ? '✅ Healthy' : usagePct < 85 ? '⚠️ Watch — zvážte cleanup' : '🚨 Critical — upgrade tier alebo cleanup teraz'}
          </span>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, margin: 0 }}>
          Atlas tier limit sa nedá zistiť z dbStats. Aktuálna hodnota je z env var <code>ATLAS_TIER_LIMIT_MB</code> (default 512 = M0 Free).
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Collection breakdown chart */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Veľkosť kolekcií (top 8)</h3>
          <div style={{ height: '280px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Doughnut data={collectionData} options={{
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } } }
            }} />
          </div>
        </div>

        {/* Collection detail table */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Detaily kolekcií</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, maxHeight: 320, overflow: 'auto' }}>
            {data.collections.map(c => (
              <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{STORAGE_COLL_LABELS[c.name] || c.name}</span>
                  {c.growth7d != null && c.growth7d > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                      +{c.growth7d.toLocaleString()} / 7d
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 80, textAlign: 'right', fontSize: 11 }}>
                    {c.count.toLocaleString()} dok.
                  </span>
                  <span style={{ color: 'var(--text-muted)', minWidth: 50, textAlign: 'right', fontSize: 11 }}>
                    avg {fmtSize(c.avgObjSize)}
                  </span>
                  <span style={{ fontWeight: 600, minWidth: 70, textAlign: 'right' }}>{fmtSize(c.size)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Per workspace storage table — search + sort + pagination */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '16px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            Storage per workspace ({filteredWs.length})
          </h3>
          <input
            type="text"
            placeholder="🔍 Hľadať workspace..."
            value={wsSearch}
            onChange={(e) => { setWsSearch(e.target.value); setWsPage(1); }}
            className="form-input"
            style={{ fontSize: 12, width: 220 }}
          />
        </div>
        <div className="sa-table-wrap" style={{ width: '100%' }}>
          <table className="sa-table" style={{ fontSize: 12, width: '100%' }}>
            <thead>
              <tr>
                <th onClick={() => handleWsSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Workspace {wsSort === 'name' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleWsSort('contacts')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Kontakty {wsSort === 'contacts' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleWsSort('tasks')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Úlohy {wsSort === 'tasks' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleWsSort('messages')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Správy {wsSort === 'messages' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleWsSort('totalDocs')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Celkom dok. {wsSort === 'totalDocs' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleWsSort('estimatedSize')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Odhad veľkosti {wsSort === 'estimatedSize' && (wsOrder === 'asc' ? '▲' : '▼')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedWs.map(w => (
                <tr key={w.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: w.color, flexShrink: 0 }}></span>
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
              {pagedWs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                    Žiadne workspace-y pre tento filter
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {wsTotalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)' }}>
              Strana {wsPage} z {wsTotalPages} ({filteredWs.length} workspace-ov)
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" disabled={wsPage <= 1} onClick={() => setWsPage((p) => Math.max(1, p - 1))} style={{ fontSize: 11 }}>
                ← Predch.
              </button>
              <button className="btn btn-secondary" disabled={wsPage >= wsTotalPages} onClick={() => setWsPage((p) => p + 1)} style={{ fontSize: 11 }}>
                Ďalšia →
              </button>
            </div>
          </div>
        )}
      </div>

      <AdminHelpToggle title="Storage">
        <p><strong>Čo tu vidíš:</strong> využitie databázy MongoDB — koľko miesta zaberajú jednotlivé kolekcie, ktoré workspace-y ich najviac napĺňajú, a ako sa blížiš k limitu Atlas tier-u.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 DB overview cards</h4>
        <ul>
          <li><strong>Dáta</strong> — celková veľkosť uložených dokumentov (bez indexov a paddingov).</li>
          <li><strong>Storage</strong> — fyzické miesto na disku (vrátane indexov, paddingov, fragmentácie). <em>Toto je číslo ktoré ráta MongoDB Atlas pre tier limit.</em></li>
          <li><strong>Indexy</strong> — koľko miesta zaberajú samotné indexy. Pri rastúcich kolekciách indexy môžu byť 30-50% storage.</li>
          <li><strong>Kolekcie</strong> — počet existujúcich kolekcií v databáze.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>☁️ Atlas tier usage</h4>
        <ul>
          <li>Progress bar ukazuje aktuálne <em>storageSize / tierLimit</em>.</li>
          <li>Limit sa konfiguruje cez env var <code>ATLAS_TIER_LIMIT_MB</code>. Default 512 MB = M0 Free tier. M2 = 2048 MB, M5 = 5120 MB, M10+ vyššie.</li>
          <li>Farby: ✅ zelená ({'<'}60%), ⚠️ oranžová (60-85%), 🚨 červená ({'>'}85%) → hladaj cleanup alebo plánuj upgrade.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🍩 Veľkosť kolekcií (top 8)</h4>
        <p>Doughnut chart 8 najväčších kolekcií + agregát "ostatné". Pri 16 sledovaných kolekciách by individuálne legendy boli nečitateľné, preto top-N + remainder.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📋 Detaily kolekcií</h4>
        <ul>
          <li>Kompletný zoznam sledovaných kolekcií so labelmi v slovenčine + emoji.</li>
          <li><strong>Growth badge</strong> — zelený "+ X / 7d" pri kolekciách kde za posledný týždeň pribudli záznamy. Užitočné pre identifikáciu rýchlo rastúcich tabuliek (typicky <code>auditlogs</code>, <code>emaillogs</code>).</li>
          <li><strong>avg</strong> — priemerná veľkosť dokumentu. Veľké hodnoty ({'>'}10 KB) signalizujú že je tam veľa nested dát alebo embedded blob (avatary, page content).</li>
          <li>Ak chceš nastaviť TTL (auto-cleanup) na <code>auditlogs</code> alebo <code>emaillogs</code>, treba pridať <code>auditLogSchema.index(&#123; createdAt: 1 &#125;, &#123; expireAfterSeconds: ... &#125;)</code> v príslušnom schema súbore.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🏢 Storage per workspace</h4>
        <ul>
          <li>Tabuľka kontakty / úlohy / správy / total / odhad veľkosti per produkčný workspace (super admin testovacie sú vylúčené).</li>
          <li><strong>Search</strong> v reálnom čase + <strong>sort</strong> klikateľné header columns + <strong>paginácia</strong> 50 na stránku.</li>
          <li>Odhad veľkosti = počet × avgObjSize danej kolekcie. Nie je to presný číslo (Mongo nezbiera per-document size per workspace), ale je to dobrý proxy.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Daily check rituál</h4>
        <ol>
          <li>Atlas tier usage progress bar — žiadny alarm? Healthy {'<'} 60%.</li>
          <li>Detaily kolekcií — žiadna kolekcia s rastom +1000 / 7d ktorú by si nečakal? (typicky <code>auditlogs</code> a <code>servererrors</code>)</li>
          <li>Per-workspace tabuľka — žiadny workspace s 100k+ dokumentov? (môže byť stress test alebo abuse).</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Storage/dataSize čítame z Mongo <code>dbStats</code> a <code>collStats</code> commands. Tieto môžu byť o pár sekúnd staršie ako reálny stav (Mongo updatuje stats periodicky). Auto-refresh každých 60s.
        </p>
      </AdminHelpToggle>
    </div>
  );
}

// ─── P3: WORKSPACE COMPARISON TAB ──────────────────────────────
function WorkspaceComparisonTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sortBy, setSortBy] = useState('activityScore');
  const [sortOrder, setSortOrder] = useState('desc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 50;

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const r = await adminApi.get('/api/admin/workspace-comparison');
      setData(r.data);
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh 60s s Page Visibility pause — workspace activity sa
  // nemení tak často, 60s je primerané.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  if (loading) return <div className="sa-loading">Načítavam porovnanie...</div>;
  if (!data || data.length === 0) return <div className="sa-empty">Žiadne workspace-y</div>;

  // Filter + sort + paginácia (client-side — backend zatiaľ vracia celý zoznam)
  const filtered = data.filter((w) => !search || (w.name || '').toLowerCase().includes(search.toLowerCase()));
  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortBy] ?? 0;
    let bv = b[sortBy] ?? 0;
    if (sortBy === 'name' || sortBy === 'owner') {
      return sortOrder === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return sortOrder === 'asc' ? av - bv : bv - av;
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const paged = sorted.slice((page - 1) * perPage, page * perPage);

  const handleSort = (col) => {
    if (sortBy === col) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortOrder('desc'); }
  };

  // Reset page pri zmene filtra/sortu
  if (page > totalPages) setPage(1);

  const maxScore = Math.max(...data.map(d => d.activityScore || 1));
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';

  const exportCsv = () => {
    const header = ['#', 'Workspace', 'Vlastník', 'Členovia', 'Kontakty', 'Projekty', 'Úlohy', 'Dokončené %', 'Správy', 'Posledná aktivita', 'Skóre'];
    const rows = sorted.map((w, i) => [
      i + 1, w.name, w.owner, w.members, w.contacts,
      w.projects ?? w.tasks ?? 0, w.subtasks ?? 0,
      w.completionRate, w.messages,
      w.lastActivity ? new Date(w.lastActivity).toISOString() : '',
      w.activityScore
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `workspace-comparison-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Porovnanie workspace-ov
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportCsv} className="btn btn-secondary" style={{ fontSize: 12 }}>
            📥 Export CSV
          </button>
        </div>
      </div>

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            Detailné porovnanie ({filtered.length})
          </h3>
          <input
            type="text"
            placeholder="🔍 Hľadať workspace podľa názvu..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="form-input"
            style={{ fontSize: 12, width: 240 }}
          />
        </div>
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ fontSize: '12px' }}>
            <thead>
              <tr>
                <th>#</th>
                <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Workspace {sortBy === 'name' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('owner')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Vlastník {sortBy === 'owner' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('members')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Členovia {sortBy === 'members' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('contacts')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Kontakty {sortBy === 'contacts' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('projects')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} title="Top-level projekty (Task dokumenty)">
                  Projekty {sortBy === 'projects' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('subtasks')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} title="Úlohy (subtasky) vrátane všetkých zanorených úrovní">
                  Úlohy {sortBy === 'subtasks' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('completionRate')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} title="% dokončených úloh (alebo projektov, ak workspace nemá úlohy)">
                  Dokončené {sortBy === 'completionRate' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('messages')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                  Správy {sortBy === 'messages' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('lastActivity')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Posledná aktivita {sortBy === 'lastActivity' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => handleSort('activityScore')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Skóre {sortBy === 'activityScore' && (sortOrder === 'asc' ? '▲' : '▼')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.map((w, i) => {
                const idx = (page - 1) * perPage + i;
                // Backward-compat: staré API verzie nemali projects/subtasks polia
                // (vracali len `tasks` = projekty); zachováme rendering aj v tom
                // prípade, len úlohy ukáže "—".
                const projects = w.projects ?? w.tasks ?? 0;
                const subtasks = w.subtasks ?? null;
                const subtasksCompleted = w.subtasksCompleted ?? null;
                return (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{idx + 1}</td>
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
        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)' }}>
              Strana {page} z {totalPages} ({sorted.length} workspace-ov)
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ fontSize: 11 }}>
                ← Predch.
              </button>
              <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 11 }}>
                Ďalšia →
              </button>
            </div>
          </div>
        )}
      </div>

      <AdminHelpToggle title="Porovnanie">
        <p><strong>Čo tu vidíš:</strong> tabuľkové porovnanie všetkých produkčných workspace-ov (super admin testovacie sú vylúčené) — koľko kontaktov, projektov, úloh, správ a členov má každý + agregované activity score pre top-level pohľad.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Top 10 chart</h4>
        <p>Stacked horizontal Bar chart top 10 workspace-ov podľa skóre aktivity. Stacks (kontakty + projekty + úlohy + správy) ukazujú "tvar" workspace-u — dominantná modrá = kontaktovo orientovaný workspace, dominantná oranžová = chat-driven, atď.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Search + sort</h4>
        <ul>
          <li><strong>Search</strong> v reálnom čase — substring v názve workspace-u (case-insensitive).</li>
          <li><strong>Klik na header</strong> column toggluje sort + smer (▲▼). Sortovateľné: Workspace, Vlastník, Členovia, Kontakty, Projekty, Úlohy, Dokončené, Správy, Posledná aktivita, Skóre.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📋 Stĺpce</h4>
        <ul>
          <li><strong>Projekty</strong> — top-level Task dokumenty v DB (UI ich volá "Projekty").</li>
          <li><strong>Úlohy</strong> — počet úloh (subtasks) vrátane všetkých zanorených úrovní. Zobrazené ako <code>&lt;dokončené&gt;/&lt;celkom&gt;</code> ak existuje aspoň jedna úloha.</li>
          <li><strong>Dokončené</strong> — % dokončenosti počítané z úrovne úloh (ak workspace má aspoň jednu úlohu); inak fallback na úroveň projektov. Farby: zelená ({'>'}50%), oranžová (20-50%), červená ({'<'}20%).</li>
          <li><strong>Posledná aktivita</strong> — max(createdAt) z contact / task / message v danom workspace-e.</li>
          <li><strong>Skóre</strong> — vážený metric: kontakty × 2 + projekty × 3 + úlohy × 1 + správy × 1. Vizualizovaný progress barom relatívne k najsilnejšiemu workspace.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📥 Export CSV</h4>
        <p>Tlačidlo vpravo hore exportuje aktuálne <em>filtrovaný a sortovaný</em> zoznam (nie celý dataset). Užitočné pre QBR analýzu, board reporty alebo offline prácu.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔄 Auto-refresh</h4>
        <p>Stránka sa automaticky obnovuje každých 60s (pause pri schovanom tabe). Pre okamžitý refresh stačí prepnúť tab a vrátiť sa.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Daily check rituál</h4>
        <ol>
          <li>Sortuj podľa <em>Skóre</em> DESC — top 5 najaktívnejších workspace-ov, sleduj rast.</li>
          <li>Sortuj podľa <em>Dokončené</em> ASC — workspace-y s najnižším completion rate ({'<'}20%) sú signál že user "len zakladá projekty bez follow-throughu".</li>
          <li>Sortuj podľa <em>Posledná aktivita</em> DESC — najnovšia aktivita v top tail.</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Activity score je len váženy odhad a nie absolútna pravda — workspace s vysokým skóre môže byť "data hoarder" zatiaľ čo workspace s nízkym ale stálym tempom môže byť produkt-fit. Sleduj v kombinácii s lastActivity (sviežosť) a completionRate (efektivita).
        </p>
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
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedCode, setSelectedCode] = useState(null);
  const [stats, setStats] = useState(null);
  // Filter + sort
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState(''); // '' | 'active' | 'inactive' | 'expired' | 'exhausted' | 'stripe'
  const [sortBy, setSortBy] = useState('createdAt'); // createdAt | usedCount | value | expiresAt

  // Form state
  const [form, setForm] = useState({
    code: '', name: '', type: 'percentage', value: '',
    duration: 'once', durationInMonths: '3',
    validForPlans: [], validForPeriods: [],
    maxUses: '', maxUsesPerUser: '1', expiresAt: ''
  });

  const fetchCodes = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const res = await adminApi.get('/api/admin/promo-codes');
      setCodes(res.data);
    } catch { /* ignore */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  // Auto-refresh 60s s Page Visibility pause
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) fetchCodes(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 60000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchCodes]);

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

  // Stat header breakdown — kompletný overview promo kódov
  const breakdown = {
    total: codes.length,
    active: codes.filter((c) => c.isActive && !isExpired(c.expiresAt) && !(c.maxUses > 0 && c.usedCount >= c.maxUses)).length,
    inactive: codes.filter((c) => !c.isActive).length,
    expired: codes.filter((c) => isExpired(c.expiresAt)).length,
    exhausted: codes.filter((c) => c.maxUses > 0 && c.usedCount >= c.maxUses).length,
    stripeSync: codes.filter((c) => c.stripeCouponId).length,
    totalUses: codes.reduce((sum, c) => sum + (c.usedCount || 0), 0)
  };

  // Filter + sort
  const filtered = codes
    .filter((c) => {
      if (search) {
        const s = search.toLowerCase();
        if (!(c.code || '').toLowerCase().includes(s) && !(c.name || '').toLowerCase().includes(s)) return false;
      }
      if (filterStatus === 'active') {
        return c.isActive && !isExpired(c.expiresAt) && !(c.maxUses > 0 && c.usedCount >= c.maxUses);
      }
      if (filterStatus === 'inactive') return !c.isActive;
      if (filterStatus === 'expired') return isExpired(c.expiresAt);
      if (filterStatus === 'exhausted') return c.maxUses > 0 && c.usedCount >= c.maxUses;
      if (filterStatus === 'stripe') return !!c.stripeCouponId;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'usedCount') return (b.usedCount || 0) - (a.usedCount || 0);
      if (sortBy === 'value') return (b.value || 0) - (a.value || 0);
      if (sortBy === 'expiresAt') {
        const av = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
        const bv = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
        return av - bv;
      }
      // default: createdAt desc
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>
          Promo kódy
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● auto-refresh</span>}
        </h3>
        {!showForm && (
          <button className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 16px' }} onClick={() => setShowForm(true)}>
            + Nový kód
          </button>
        )}
      </div>

      {/* Stat header */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-secondary)' }}>
          Celkom: <strong>{breakdown.total}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#d1fae5', color: '#065f46' }}>
          ✅ Aktívnych: <strong>{breakdown.active}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          ⏰ Expirovaných: <strong>{breakdown.expired}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
          🔚 Vyčerpaných: <strong>{breakdown.exhausted}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#dbeafe', color: '#1e40af' }}>
          💳 Stripe sync: <strong>{breakdown.stripeSync}</strong>
        </span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', color: '#6D28D9' }}>
          🎯 Celkom použití: <strong>{breakdown.totalUses}</strong>
        </span>
      </div>

      {/* Filter toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="🔍 Hľadať kód alebo názov..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input"
          style={{ flex: '1 1 200px', minWidth: 180, fontSize: 13 }}
        />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13 }}>
          <option value="">Všetky stavy</option>
          <option value="active">✅ Aktívne</option>
          <option value="inactive">⏸ Neaktívne</option>
          <option value="expired">⏰ Expirované</option>
          <option value="exhausted">🔚 Vyčerpané</option>
          <option value="stripe">💳 So Stripe sync</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: 13 }}>
          <option value="createdAt">Najnovšie</option>
          <option value="usedCount">Najpoužívanejšie</option>
          <option value="value">Najvyššia hodnota</option>
          <option value="expiresAt">Končiace najskôr</option>
        </select>
        {(search || filterStatus) && (
          <button
            className="btn btn-secondary"
            onClick={() => { setSearch(''); setFilterStatus(''); }}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            ✕ Vymazať filtre
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
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎟️</div>
          <p>{codes.length === 0 ? 'Žiadne promo kódy' : 'Žiadne výsledky pre filter'}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {filtered.map(c => {
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
        <p><strong>Čo tu vidíš:</strong> správa promo kódov, ktoré užívatelia môžu uplatniť pri checkoute v Stripe (alebo zobraziť v aplikácii). Kódy sa po vytvorení automaticky propagujú do Stripe ako Promotion Codes.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Stat header</h4>
        <ul>
          <li><strong>Celkom</strong> — všetky kódy v DB.</li>
          <li><strong>✅ Aktívne</strong> — kódy ktoré sa dajú práve teraz uplatniť (isActive && !expired && !exhausted).</li>
          <li><strong>⏰ Expirované</strong> — expiresAt {'<'} now.</li>
          <li><strong>🔚 Vyčerpané</strong> — usedCount {'>='} maxUses (ak je maxUses {'>'} 0).</li>
          <li><strong>💳 Stripe sync</strong> — kódy ktoré majú stripeCouponId (úspešná Stripe propagácia).</li>
          <li><strong>🎯 Celkom použití</strong> — sumár usedCount naprieč všetkými kódmi.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filtre + sort</h4>
        <ul>
          <li><strong>Search</strong> — substring v <em>kóde</em> alebo <em>internom názve</em>.</li>
          <li><strong>Filter stavu</strong> — Aktívne / Neaktívne / Expirované / Vyčerpané / So Stripe sync.</li>
          <li><strong>Sort</strong> — Najnovšie (default) / Najpoužívanejšie / Najvyššia hodnota / Končiace najskôr.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>➕ Vytvorenie kódu</h4>
        <ul>
          <li><strong>Kód</strong> (napr. "PRPL-AKCIA50") — generátor cez tlačidlo „Generovať" vytvorí náhodný 6-znak suffix.</li>
          <li><strong>Typ zľavy</strong>:
            <ul>
              <li>🏷️ <strong>Percentuálna</strong> (napr. 20% zľava)</li>
              <li>💶 <strong>Fixná</strong> (napr. −5 € z faktúry)</li>
              <li>🎁 <strong>Voľné mesiace</strong> (napr. 2 mesiace zdarma)</li>
            </ul>
          </li>
          <li><strong>Platnosť zľavy</strong> (len pre percentage / fixed):
            <ul>
              <li>Len 1. platba — discount sa aplikuje raz</li>
              <li>Opakovane X mesiacov — sleduje sa N billing cyklov</li>
              <li>Navždy — celý lifetime predplatného</li>
            </ul>
            (freeMonths má implicitne „repeating" = X mesiacov, kde X = hodnota.)
          </li>
          <li><strong>Platné pre plány / obdobie</strong> — chip selector. Prázdne = platí pre všetky.</li>
          <li><strong>Limit použití</strong> — globálny strop (0 = neobmedzené).</li>
          <li><strong>Limit na užívateľa</strong> — koľkokrát môže ten istý user uplatniť (default 1).</li>
          <li><strong>Platnosť do</strong> — datetime kedy kód expiruje.</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📋 Zoznam kódov</h4>
        <ul>
          <li><strong>Status badges</strong>: NEAKTÍVNY (manual deaktivácia), EXPIROVANÝ (expiresAt past), VYČERPANÝ (usedCount {'>='} maxUses), STRIPE (úspešný sync).</li>
          <li><strong>📊 Štatistiky</strong> — modal s históriou použití (user / plán / obdobie / dátum).</li>
          <li><strong>⏸/▶</strong> — manuálne aktivovať/deaktivovať bez mazania.</li>
          <li><strong>🗑️</strong> — natrvalo zmazať (ak je už použitý, history sa zachová).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>💡 Daily check rituál</h4>
        <ol>
          <li>Sort „Najpoužívanejšie" — top kódy ako conversion driver. Stagnujú? Skús iný discount.</li>
          <li>Filter „Vyčerpané" — kandidáti na zvýšenie maxUses alebo nový kód s rovnakým tieži.</li>
          <li>Filter „Expirované" — cleanup kandidáti pri DB raste (mazanie nezruší Stripe historickú prepojenosť).</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> Promo kódy sa od admin-applied zliav (Discount editor v Používateľoch) líšia tým, že ich uplatňuje user sám pri Stripe checkoute. Discount editor je ručný „darček od admina" priamo do user.subscription.discount poľa.
        </p>
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

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🔴 Chyby</h4>
        <ul>
          <li>Zoznam zachytených 5xx server errorov (z Mongo kolekcie <code>servererrors</code> cez <code>serverErrorService</code>). Auto-refresh každých 30s, pause keď je tab schovaný alebo otvorený detail modal.</li>
          <li>Pri každej chybe vidíš stack trace, request URL, user-a (ak bol prihlásený), timestamp, count (koľkokrát už nastala). Klik na riadok → expanded view s plným contextom.</li>
          <li><strong>"Send to Claude"</strong> tlačidlo skopíruje structured prompt do clipboardu — vlož do Claude Code a opíš čo treba opraviť.</li>
          <li>Filter: <em>resolved</em> (vyriešené / nevyriešené / všetko), <em>source</em> (typ erroru), <em>search</em> (substring v message).</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🟡 Výkon</h4>
        <ul>
          <li>Top 20 najpomalších endpointov podľa priemernej doby odozvy + breakdown stavových kódov + error rate. Auto-refresh 30s.</li>
          <li><strong>Avg threshold:</strong> &lt; 500ms = OK (čierne), 500–1000ms = pomalšie (oranžové), &gt; 1000ms = problém (červené).</li>
          <li>Header ukazuje <em>"Metriky zbierame od ..."</em> — admin vidí kontext (3 hodiny vs 30 dní = veľký rozdiel pri interpretácii priemerov).</li>
          <li><strong>🗑️ Reset metrík</strong> tlačidlo vyčistí in-memory counters. Užitočné po deployi keď chceš vidieť čerstvé čísla bez historických request-ov.</li>
          <li><strong>⚠️ Limitácia:</strong> apiMetrics je in-memory — server reštart (alebo crash) ho automaticky vymaže. Žiadna persistencia.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🟢 Zdravie</h4>
        <ul>
          <li>Stav externých subsystémov: MongoDB, SMTP (mailer), APNs (Apple Push), Google OAuth, Memory utilization. Health monitor cron beží na pozadí každých 5 min — UI auto-pollne každých 30s aby sa nové dáta objavili rýchlo.</li>
          <li><strong>3 stavy:</strong> ✅ <em>OK</em> (zelená), ⚠️ <em>Watch</em> (oranžová, niečo na hrane), 🚨 <em>Error</em> (červená, zlyháva).</li>
          <li>Pri 3 erroroch po sebe pošle health monitor email na support@prplcrm.eu (anti-flapping). Recovery email tiež príde keď sa služba vráti.</li>
          <li><strong>"Re-check teraz"</strong> tlačidlo donúti okamžitý live check — užitočné keď ladíš SMTP / Google credentials a chceš vidieť výsledok hneď, nie čakať na ďalší cron tick.</li>
          <li><strong>Warming-up state:</strong> ak server bol nedávno reštartovaný a prvý cron ešte nestihol bežať, UI ukáže "rozbieha sa" miesto žiadnych dát. Klik na "Spustiť kontrolu teraz" naštartuje cron force-fully.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🔵 Aktívni</h4>
        <ul>
          <li>Práve online používatelia cez Socket.IO heartbeat. Auto-refresh 15s.</li>
          <li><strong>Online používatelia</strong> = unique userId-y, <strong>Aktívne sockety</strong> = celkový počet pripojení (1 user môže mať viac tabov / zariadení).</li>
          <li>"Failed logins (24h)" + "Registrácie (24h)" stat counters z audit logu.</li>
          <li><strong>🚫 Podozrivé IP adresy</strong> — IP-čky s viacerými neúspešnými login pokusmi za 24h. Top 10 podľa počtu. Pri &gt; 5 pokusoch z jednej IP zvážiť firewall block na úrovni Render / Cloudflare.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🟣 Využitie</h4>
        <ul>
          <li>Agregované feature usage z <code>AuditLog</code> kolekcie — ktoré akcie sú najčastejšie. Výberový filter 24h / 7d / 30d.</li>
          <li>Sledované akcie: kontakty (created/updated/deleted), projekty (created/updated/<strong>completed</strong>/deleted), úlohy (created/completed), správy (created/approved/rejected), auth (register/login/<strong>login_failed</strong>), workspace.created, notification.read.</li>
          <li><strong>Farebne odlíšené:</strong> 🟢 zelené = pozitívne akcie (created, completed), 🟠 oranžové = deletes, 🔴 červené = login_failed (security signal), 🟣 fialové = ostatné.</li>
          <li>Denný trend graf zobrazuje aktivitu za posledných 7 dní pre rýchly pohľad na dynamiku.</li>
          <li><strong>Použitie:</strong> sleduj <code>task.completed</code> ako kľúčovú KPI engagement — pomer completed:created &gt; 50% = zdravý workflow.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>💰 Príjmy</h4>
        <ul>
          <li><strong>MRR (Monthly Recurring Revenue)</strong> ráta <strong>iba reálne Stripe platby</strong> — admin-granted upgrades (free months, planUpgrade discount, manuálne plán prirídenia) nie sú reálny revenue, takže sa do MRR nezarátavajú. Bez tohto by graf falošne ukazoval príjem aj keby žiadna platba neprebehla. Yearly subscriptions sa rátajú ako <code>yearly_price / 12</code> (49 € / 12 = 4.083 €/mes pre Tím yearly).</li>
          <li><strong>ARR</strong> = MRR × 12, ukázané pod MRR cardom.</li>
          <li><strong>💳 Stripe-paying</strong> — počet active userov s reálnym Stripe predplatným (real-money cashflow).<br/>
            <strong>🎁 Admin-granted</strong> — počet active "paid" userov bez Stripe (free upgrades / promo / freeMonths). Tento počet je <em>informatívny</em>, neovplyvňuje MRR.</li>
          <li><strong>Nové Stripe (30d)</strong> — počet skutočných nových predplatných za posledných 30 dní (audit log: <code>billing.checkout_completed</code>, <code>billing.subscription_created</code>, <code>billing.subscription_renewed</code>).<br/>
            <strong>Nové admin (30d)</strong> — počet admin-granted upgrade akcií za 30d, info-only.</li>
          <li><strong>MRR = 0 € s admin-granted &gt; 0</strong> → zobrazí sa žltý info banner: žiadna reálna platba ešte neprebehla, ale máš X aktívnych free-upgrade userov. Bežný stav v early-stage SaaS.</li>
          <li><strong>Doughnut chart</strong> — pomer free / team / pro plánov. Sleduj nárast paid podielu týždenne.</li>
          <li><strong>Predplatné končiace v 7 dňoch</strong> — zoznam userov pred expirom. Každý riadok ukazuje plán + billing period (<em>mes./ročne</em>) + zdroj (<em>💳 stripe / 🎁 admin</em>). Email reminders im chodia automaticky cez subscription cron (T-7, T-1) — viď Email tab.</li>
        </ul>

        <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '14px' }}>🚦 Daily check rituál</h4>
        <ol>
          <li>Najprv <strong>Chyby</strong> → žiadne nové 5xx za posledných 24h?</li>
          <li><strong>Zdravie</strong> → všetky bodky zelené?</li>
          <li><strong>Aktívni</strong> → žiadne podozrivé IP-čky (&gt; 5 fail loginov)?</li>
          <li><strong>Výkon</strong> → žiadny endpoint nad 1000ms avg?</li>
          <li><strong>Príjmy</strong> → MRR rastie, alebo aspoň stabilný?</li>
        </ol>

        <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <em>Tip:</em> Ak vidíš nárast chýb v Chyby → pozri timestamp koreláciu s nedávnym deployom v <strong>Audit log</strong> tabu. Pre persistnutie chýb mimo nášho UI je všetko v Mongo kolekcii <code>servererrors</code> + alerty cez health monitor email.
        </p>
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
  const [refreshing, setRefreshing] = useState(false);

  // Performance load — môže bežať v "silent" mode (auto-refresh) bez full
  // loading state-u, alebo v "loud" mode (initial / manual refresh) s
  // klasickou "Načítavam..." spinerom.
  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const [s, e] = await Promise.all([
        adminApi.get('/api/admin/performance/slow'),
        adminApi.get('/api/admin/performance/errors-by-route')
      ]);
      setSlowData(s.data);
      setErrData(e.data);
    } catch (err) {
      console.error('Performance load', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh každých 30s s Page Visibility pause. Konzistentné so
  // stratégiou Prehľadu — žiadny network traffic ak admin neaktívne pozerá.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled || document.hidden) return;
      load(true);
    };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 30000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVisibility = () => document.hidden ? stop() : (load(true), start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [load]);

  const handleReset = async () => {
    if (!confirm('Naozaj resetovať performance metriky? Všetky aktuálne počty / priemery sa vymažú a začneme zbierať odznova.')) return;
    try {
      await adminApi.post('/api/admin/performance/reset');
      await load();
    } catch (err) {
      alert('Reset zlyhal');
    }
  };

  if (loading) return <div className="sa-loading">Načítavam...</div>;

  const startedAt = slowData?.startedAt ? new Date(slowData.startedAt) : null;
  const trackingFor = startedAt
    ? (() => {
        const ms = Date.now() - startedAt.getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `${mins} min`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} h ${mins % 60} min`;
        const days = Math.floor(hours / 24);
        return `${days} d ${hours % 24} h`;
      })()
    : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Metriky zbierame od <strong>{startedAt ? startedAt.toLocaleString('sk-SK') : '—'}</strong>
          {' '}({trackingFor}). Celkom requestov: <strong>{slowData?.totalRequests || 0}</strong>
          {' '}• Req/min: <strong>{slowData?.requestsPerMinute || 0}</strong>
          {' '}• Error rate: <strong style={{ color: (slowData?.errorRate || 0) > 5 ? '#ef4444' : 'inherit' }}>{slowData?.errorRate || 0}%</strong>
          {refreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● live</span>}
        </div>
        <button onClick={handleReset} className="btn btn-secondary" style={{ fontSize: 12 }}>
          🗑️ Reset metrík
        </button>
      </div>

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
                <td style={{ padding: '10px', textAlign: 'right' }}>{r.total ?? r.count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(slowData?.routes || []).length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Nie sú dáta (apiMetrics je in-memory, reštart ho vymaže)</div>}
      </div>

      {/* Status codes breakdown — vizuálne stat-cards pre rýchly scan */}
      {errData && Object.keys(errData.statusCodes || {}).length > 0 && (
        <>
          <h3>Stavové kódy</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
            {Object.entries(errData.statusCodes || {})
              .sort((a, b) => b[1] - a[1])
              .map(([code, count]) => (
                <DiagStat key={code} label={`Status ${code}`} value={count} color={code.startsWith('5') ? '#ef4444' : code.startsWith('4') ? '#f59e0b' : '#10b981'} />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── DIAG: HEALTH ───────────────────────────────────────────────────
function DiagHealthSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefreshing, setAutoRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setAutoRefreshing(true); else setLoading(true);
    try {
      const res = await adminApi.get('/api/admin/health/full');
      setData(res.data);
    } catch (err) {
      console.error('Health load', err);
    } finally {
      setLoading(false);
      setAutoRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh každých 30s — health monitor cron na pozadí beží každých
  // 5 min, ale UI ho pollne častejšie aby admin videl aktualizáciu hneď
  // ako cron dokončí (napr. recovery z error state). Page Visibility pause
  // šetrí I/O ak admin neaktívne pozerá.
  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    const tick = () => { if (!cancelled && !document.hidden) load(true); };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 30000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : (load(true), start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

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
  if (data?.warmingUp) {
    return (
      <div className="sa-card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>⏳</div>
        <h3 style={{ marginTop: 0 }}>Health monitor sa rozbieha</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Server bol nedávno reštartovaný. Prvý cron beh kontroluje SMTP, APNs a Google API — to môže trvať pár sekúnd.
        </p>
        <button className="btn btn-primary" onClick={refresh} disabled={refreshing} style={{ marginTop: 12 }}>
          {refreshing ? 'Kontrolujem…' : 'Spustiť kontrolu teraz'}
        </button>
      </div>
    );
  }
  if (!data?.checks) return <div className="sa-error">Žiadne dáta</div>;

  const statusColor = (s) => s === 'ok' ? '#10b981' : s === 'warn' ? '#f59e0b' : '#ef4444';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Posledná kontrola: <strong>{data.checkedAt ? new Date(data.checkedAt).toLocaleString('sk-SK') : '—'}</strong>
          {autoRefreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#10b981' }}>● live</span>}
          {!autoRefreshing && <span style={{ marginLeft: 8, fontSize: 11, color: '#94a3b8' }}>auto-refresh 30s</span>}
        </div>
        <button onClick={refresh} disabled={refreshing} className="btn btn-secondary" style={{ fontSize: '13px' }}>
          {refreshing ? 'Kontrolujem...' : '🔄 Re-check teraz'}
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

// Slovenské labely pre USAGE_ACTIONS — v UI radšej hovorová formulácia ako
// raw "contact.created". Mapa pokrýva všetky akcie z USAGE_ACTIONS na backende.
const USAGE_ACTION_LABELS = {
  'contact.created': '👤 Vytvorené kontakty',
  'contact.updated': '👤 Upravené kontakty',
  'contact.deleted': '👤 Vymazané kontakty',
  'task.created': '📋 Vytvorené projekty',
  'task.updated': '📋 Upravené projekty',
  'task.completed': '✅ Dokončené projekty',
  'task.deleted': '📋 Vymazané projekty',
  'subtask.created': '📝 Vytvorené úlohy',
  'subtask.completed': '📝 Dokončené úlohy',
  'message.created': '✉️ Odoslané správy',
  'message.approved': '✉️ Schválené správy',
  'message.rejected': '✉️ Zamietnuté správy',
  'auth.register': '🆕 Registrácie',
  'auth.login': '🔓 Prihlásenia',
  'auth.login_failed': '🚫 Neúspešné prihlásenia',
  'notification.read': '🔔 Prečítané notifikácie',
  'workspace.created': '🏢 Vytvorené workspaces'
};

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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        {(data?.actions || []).map(a => (
          <DiagStat
            key={a.action}
            label={USAGE_ACTION_LABELS[a.action] || a.action}
            value={a.count}
            color={
              a.action === 'auth.login_failed' ? '#ef4444' :
              a.action.endsWith('.completed') || a.action.endsWith('.created') ? '#10b981' :
              a.action.endsWith('.deleted') ? '#f59e0b' :
              '#6366f1'
            }
          />
        ))}
      </div>
      {(data?.actions || []).length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
          Za posledných {period} žiadna sledovaná aktivita.
        </div>
      )}

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
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}>
            ARR: {(data.mrr * 12).toFixed(2)} € · iba reálne Stripe platby
          </div>
        </div>
        <DiagStat label="💳 Stripe-paying" value={data.stripePaidCount ?? 0} color="#10b981" />
        <DiagStat
          label="🎁 Admin-granted"
          value={data.adminGrantedCount ?? 0}
          color="#8b5cf6"
        />
        <DiagStat label="Nové Stripe (30d)" value={data.newStripeSubs30d ?? 0} color="#10b981" />
        <DiagStat label="Nové admin (30d)" value={data.newAdminGranted30d ?? 0} color="#f59e0b" />
      </div>

      {/* Vysvetlenie pre prípady keď MRR = 0 — admin nech nepanikári */}
      {data.mrr === 0 && data.adminGrantedCount > 0 && (
        <div style={{ padding: 12, background: '#fef3c7', borderLeft: '4px solid #f59e0b', borderRadius: 'var(--radius-sm)', fontSize: 13, color: '#92400e', marginBottom: 16 }}>
          <strong>ℹ️ MRR = 0 €</strong> — máte {data.adminGrantedCount} {data.adminGrantedCount === 1 ? 'aktívny admin-granted plán' : 'aktívnych admin-granted plánov'} (free upgrades / promo zľavy), ale žiadnu reálnu Stripe platbu. MRR sa ráta len z Stripe-managed predplatných, lebo admin-granted nie sú reálny revenue.
        </div>
      )}

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
                    <td style={{ padding: '10px', textTransform: 'uppercase', fontWeight: 600 }}>
                      {u.plan}
                      {u.billingPeriod && (
                        <span style={{
                          marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4,
                          background: u.billingPeriod === 'yearly' ? '#ddd6fe' : '#fef3c7',
                          color: u.billingPeriod === 'yearly' ? '#6D28D9' : '#92400e',
                          textTransform: 'uppercase'
                        }}>
                          {u.billingPeriod === 'yearly' ? 'ročne' : 'mes.'}
                        </span>
                      )}
                      <span style={{
                        marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4,
                        background: u.isStripe ? '#d1fae5' : '#ede9fe',
                        color: u.isStripe ? '#065f46' : '#6D28D9',
                        textTransform: 'uppercase'
                      }} title={u.isStripe ? 'Stripe-managed (reálna platba)' : 'Admin-granted (free upgrade)'}>
                        {u.isStripe ? '💳 stripe' : '🎁 admin'}
                      </span>
                    </td>
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

// Mini list posledných 5 mailov pre konkrétneho usera, vrátane tlačidla
// na manuálne preposlanie reminderu (užitočné pre support workflow).
function UserEmailLogsMini({ userId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showSendMenu, setShowSendMenu] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.get(`/api/admin/users/${userId}/email-logs?limit=5`);
      setLogs(r.data || []);
    } catch (err) {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const handleManualSend = async (type) => {
    setShowSendMenu(false);
    if (!confirm(`Naozaj poslať email „${EMAIL_TYPE_LABELS[type]?.label || type}" tomuto používateľovi?`)) return;
    setSending(true);
    try {
      const r = await adminApi.post(`/api/admin/users/${userId}/send-email`, { type });
      const status = r.data?.status || 'unknown';
      alert(status === 'sent' ? '✅ Email odoslaný' : `Stav: ${status}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri odosielaní');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Posledné maily</h4>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowSendMenu(!showSendMenu)}
            disabled={sending}
            style={{ background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', color: 'var(--primary, #8B5CF6)', fontWeight: 500 }}
          >
            📤 Poslať email
          </button>
          {showSendMenu && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4,
              background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #e5e7eb)',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', zIndex: 10, minWidth: 200
            }}>
              {['reminder_t7', 'reminder_t1', 'expired', 'winback', 'welcome_pro', 'discount_assigned'].map((t) => {
                const meta = EMAIL_TYPE_LABELS[t];
                return (
                  <button
                    key={t}
                    onClick={() => handleManualSend(t)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 12px', background: 'transparent', border: 'none',
                      cursor: 'pointer', fontSize: 13
                    }}
                  >
                    {meta?.icon} {meta?.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Načítavam...</div>
      ) : logs.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>Žiadne maily ešte neboli poslané.</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
          {logs.map((l) => {
            const typeMeta = EMAIL_TYPE_LABELS[l.type] || { label: l.type, icon: '✉️', color: '#94a3b8' };
            const statusMeta = EMAIL_STATUS_LABELS[l.status] || { label: l.status, color: '#64748b' };
            return (
              <li key={l._id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-color, #e5e7eb)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>
                  <span style={{ color: typeMeta.color, fontWeight: 600 }}>{typeMeta.icon} {typeMeta.label}</span>
                  <span style={{ color: '#9ca3af', marginLeft: 8 }}>{new Date(l.sentAt).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </span>
                <span style={{ color: statusMeta.color, fontWeight: 600 }}>{statusMeta.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── EMAILS TAB ───────────────────────────────────────────────────
//
// Centrálny prehľad odoslaných systémových mailov. Filtre v hlavičke,
// stránkovaný list, klik na riadok otvorí HTML preview modal.
//
// Backend endpoints (server/routes/admin.js):
//   GET /api/admin/email-logs           paginated list
//   GET /api/admin/email-logs/:id       full preview (incl. HTML snapshot)
//   GET /api/admin/email-logs-stats     headline counters
//   GET /api/admin/email-config         SMTP status + promo codes

const EMAIL_TYPE_LABELS = {
  subscription_assigned: { label: 'Plán priradený', icon: '📦', color: '#8B5CF6' },
  discount_assigned: { label: 'Zľava priradená', icon: '🎁', color: '#10b981' },
  welcome_pro: { label: 'Welcome Pro', icon: '🎉', color: '#f59e0b' },
  reminder_t7: { label: 'Reminder T-7', icon: '⏰', color: '#06b6d4' },
  reminder_t1: { label: 'Reminder T-1', icon: '⚠️', color: '#f97316' },
  expired: { label: 'Expirovaný', icon: '🔚', color: '#ef4444' },
  winback: { label: 'Winback', icon: '💝', color: '#ec4899' },
  welcome: { label: 'Welcome', icon: '👋', color: '#6366f1' },
  invitation: { label: 'Pozvánka', icon: '✉️', color: '#3b82f6' },
  password_reset: { label: 'Reset hesla', icon: '🔑', color: '#64748b' },
  mobile_app_launch: { label: 'Mobile app launch', icon: '📱', color: '#8B5CF6' },
  admin_notify: { label: 'Admin notify', icon: '🛎️', color: '#94a3b8' }
};

const EMAIL_STATUS_LABELS = {
  sent: { label: 'Odoslané', color: '#10b981', bg: '#d1fae5' },
  failed: { label: 'Zlyhalo', color: '#dc2626', bg: '#fee2e2' },
  skipped_cooldown: { label: 'Cooldown', color: '#92400e', bg: '#fef3c7' },
  skipped_optout: { label: 'Opt-out', color: '#6b7280', bg: '#f3f4f6' },
  skipped_no_smtp: { label: 'Bez SMTP', color: '#6b7280', bg: '#f3f4f6' }
};

function EmailsTab() {
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // days: '' = custom range, '7'|'30'|'90' = preset; from/to override pri customRange
  const [filters, setFilters] = useState({ type: '', status: '', search: '', days: '30', from: '', to: '' });
  const [sort, setSort] = useState('sentAt');
  const [order, setOrder] = useState('desc');
  const [previewLog, setPreviewLog] = useState(null);
  const [statsDays, setStatsDays] = useState(30); // pre daily chart window

  const loadStats = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(false);
    try {
      const r = await adminApi.get(`/api/admin/email-logs-stats?days=${statsDays}`);
      setStats(r.data);
    } catch { /* ignore */ }
  }, [statsDays]);

  const loadConfig = useCallback(async () => {
    try {
      const r = await adminApi.get('/api/admin/email-config');
      setConfig(r.data);
    } catch { /* ignore */ }
  }, []);

  const loadLogs = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.type) params.append('type', filters.type);
      if (filters.status) params.append('status', filters.status);
      if (filters.search) params.append('search', filters.search);
      // Custom date range má prednosť pred preset days
      if (filters.from || filters.to) {
        if (filters.from) params.append('from', new Date(filters.from).toISOString());
        if (filters.to) params.append('to', new Date(filters.to + 'T23:59:59').toISOString());
      } else if (filters.days) {
        const since = new Date(Date.now() - parseInt(filters.days) * 24 * 60 * 60 * 1000);
        params.append('from', since.toISOString());
      }
      params.append('sort', sort);
      params.append('order', order);
      params.append('page', String(page));
      params.append('limit', String(limit));
      const r = await adminApi.get(`/api/admin/email-logs?${params.toString()}`);
      setLogs(r.data.logs || []);
      setTotal(r.data.total || 0);
    } catch {
      setLogs([]); setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filters, page, sort, order]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadLogs(); }, [loadLogs]);

  // Auto-refresh logs + stats každých 30s. Pause keď je modal otvorený alebo
  // tab v pozadí (Page Visibility API), aby sme neblokovali užívateľa pri čítaní.
  useEffect(() => {
    if (previewLog) return;
    let intervalId = null;
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      loadLogs(true);
      loadStats(true);
    };
    const start = () => { if (!intervalId) intervalId = setInterval(tick, 30000); };
    const stop = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVis = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [loadLogs, loadStats, previewLog]);

  const updateFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const toggleSort = (field) => {
    if (sort === field) {
      setOrder(order === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };

  const sortIcon = (field) => sort === field ? (order === 'desc' ? ' ↓' : ' ↑') : '';

  const exportCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.type) params.append('type', filters.type);
      if (filters.status) params.append('status', filters.status);
      if (filters.search) params.append('search', filters.search);
      if (filters.from || filters.to) {
        if (filters.from) params.append('from', new Date(filters.from).toISOString());
        if (filters.to) params.append('to', new Date(filters.to + 'T23:59:59').toISOString());
      } else if (filters.days) {
        const since = new Date(Date.now() - parseInt(filters.days) * 24 * 60 * 60 * 1000);
        params.append('from', since.toISOString());
      }
      params.append('page', '1');
      params.append('limit', '1000');
      const r = await adminApi.get(`/api/admin/email-logs?${params.toString()}`);
      const rows = (r.data.logs || []).map((l) => [
        new Date(l.sentAt).toISOString(),
        l.toEmail || '',
        l.user?.username || '',
        l.type || '',
        l.subject || '',
        l.status || '',
        l.error || '',
        l.triggeredBy || ''
      ]);
      const header = ['SentAt', 'ToEmail', 'Username', 'Type', 'Subject', 'Status', 'Error', 'TriggeredBy'];
      const csv = [header, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `email-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { alert('Export zlyhal'); }
  };

  const clearFilters = () => {
    setFilters({ type: '', status: '', search: '', days: '30', from: '', to: '' });
    setPage(1);
  };

  const hasActiveFilters = filters.type || filters.status || filters.search || filters.from || filters.to || filters.days !== '30';

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="sa-section sa-section-wide">
      <div className="sa-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>
            📧 Emaily
            {refreshing && <span style={{ marginLeft: 10, fontSize: 11, color: '#10b981', fontWeight: 400 }}>● auto-refresh</span>}
          </h2>
          <p style={{ margin: '4px 0 0' }}>Prehľad všetkých systémových mailov — transakčných (zmena plánu, zľava) a marketingových (pripomienky, winback).</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={statsDays}
            onChange={(e) => setStatsDays(parseInt(e.target.value))}
            className="sa-input"
            style={{ width: 'auto', fontSize: 12 }}
            title="Časové okno pre stat cards a daily chart"
          >
            <option value={7}>Stat: 7 dní</option>
            <option value={30}>Stat: 30 dní</option>
            <option value={90}>Stat: 90 dní</option>
          </select>
          <button onClick={exportCsv} className="btn btn-secondary" style={{ fontSize: 12 }}>
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* HEADLINE STAT CARDS */}
      <div className="sa-stat-grid" style={{ marginBottom: 20 }}>
        <StatCard
          icon="📬"
          label="Odoslaných za 7 dní"
          value={stats?.total7d ?? '—'}
        />
        <StatCard
          icon="📊"
          label={`Odoslaných za ${statsDays} dní`}
          value={stats?.total30d ?? '—'}
        />
        <StatCard
          icon="✅"
          label="Úspešnosť"
          value={stats ? `${(100 - (stats.failureRatePct || 0)).toFixed(1)}%` : '—'}
          sub={stats ? `${stats.failureRatePct}% failed` : ''}
        />
        <StatCard
          icon={config?.smtpConfigured ? '🟢' : '🔴'}
          label="SMTP stav"
          value={config?.smtpConfigured ? 'Pripojené' : 'Nepripojené'}
          sub={config?.smtpHost || ''}
        />
      </div>

      {/* DAILY VOLUME CHART */}
      {stats?.daily?.length > 0 && (
        <div className="sa-card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 14 }}>📈 Denný objem ({statsDays} dní)</h3>
          <div style={{ height: 180 }}>
            <Line
              data={{
                labels: stats.daily.map((d) => {
                  const dt = new Date(d.date);
                  return `${dt.getDate()}.${dt.getMonth() + 1}.`;
                }),
                datasets: [
                  {
                    label: 'Odoslané',
                    data: stats.daily.map((d) => d.sent),
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.10)',
                    fill: true,
                    tension: 0.3
                  },
                  {
                    label: 'Zlyhané',
                    data: stats.daily.map((d) => d.failed),
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.10)',
                    fill: true,
                    tension: 0.3
                  },
                  {
                    label: 'Skipped',
                    data: stats.daily.map((d) => d.skipped),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245,158,11,0.10)',
                    fill: true,
                    tension: 0.3
                  }
                ]
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
                scales: {
                  y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
                  x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 } }
                }
              }}
            />
          </div>
        </div>
      )}

      {/* TOP TYPES */}
      {stats?.topTypes7d?.length > 0 && (
        <div className="sa-card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>Najčastejšie typy (7 dní)</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {stats.topTypes7d.map((t) => {
              const meta = EMAIL_TYPE_LABELS[t.type] || { label: t.type, icon: '✉️', color: '#94a3b8' };
              return (
                <span key={t.type} style={{
                  padding: '6px 12px', borderRadius: 999,
                  background: meta.color + '20', color: meta.color,
                  fontSize: 13, fontWeight: 600
                }}>
                  {meta.icon} {meta.label} · {t.count}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* RECENT FAILED ALERT */}
      {stats?.recentFailed?.length > 0 && (
        <div className="sa-card" style={{ marginBottom: 20, borderLeft: '4px solid #ef4444' }}>
          <h3 style={{ marginTop: 0, color: '#dc2626' }}>⚠️ Posledné zlyhania (7 dní)</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {stats.recentFailed.map((f) => (
              <li key={f._id} style={{ fontSize: 13, marginBottom: 6 }}>
                <strong>{f.toEmail}</strong> · {EMAIL_TYPE_LABELS[f.type]?.label || f.type} ·{' '}
                <span style={{ color: '#dc2626' }}>{f.error || 'Unknown'}</span>{' '}
                <span style={{ color: '#9ca3af' }}>({new Date(f.sentAt).toLocaleString('sk-SK')})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* FILTERS */}
      <div className="sa-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="🔍 Hľadať email alebo username..."
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
            className="sa-input"
          />
          <select value={filters.type} onChange={(e) => updateFilter('type', e.target.value)} className="sa-input">
            <option value="">Všetky typy</option>
            {Object.entries(EMAIL_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label}</option>
            ))}
          </select>
          <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)} className="sa-input">
            <option value="">Všetky stavy</option>
            {Object.entries(EMAIL_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <select
            value={filters.from || filters.to ? '' : filters.days}
            onChange={(e) => setFilters((f) => ({ ...f, days: e.target.value, from: '', to: '' }))}
            className="sa-input"
            disabled={!!(filters.from || filters.to)}
            title={(filters.from || filters.to) ? 'Custom range má prednosť' : ''}
          >
            <option value="7">Posledných 7 dní</option>
            <option value="30">Posledných 30 dní</option>
            <option value="90">Posledných 90 dní</option>
            <option value="">Všetko</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Custom range:</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => updateFilter('from', e.target.value)}
            className="sa-input"
            style={{ width: 'auto', fontSize: 12 }}
            title="Od"
          />
          <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => updateFilter('to', e.target.value)}
            className="sa-input"
            style={{ width: 'auto', fontSize: 12 }}
            title="Do"
          />
          {hasActiveFilters && (
            <button onClick={clearFilters} className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 10px', marginLeft: 'auto' }}>
              ✕ Vymazať filtre
            </button>
          )}
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: hasActiveFilters ? 0 : 'auto' }}>
            {total} záznamov
          </span>
        </div>
      </div>

      {/* LOG TABLE */}
      <div className="sa-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Načítavam...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Žiadne maily nenájdené</div>
        ) : (
          <table className="sa-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th onClick={() => toggleSort('sentAt')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Klikni pre zoradenie">Čas{sortIcon('sentAt')}</th>
                <th onClick={() => toggleSort('toEmail')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Klikni pre zoradenie">Príjemca{sortIcon('toEmail')}</th>
                <th onClick={() => toggleSort('type')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Klikni pre zoradenie">Typ{sortIcon('type')}</th>
                <th>Subject</th>
                <th onClick={() => toggleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Klikni pre zoradenie">Stav{sortIcon('status')}</th>
                <th>Trigger</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const typeMeta = EMAIL_TYPE_LABELS[log.type] || { label: log.type, icon: '✉️', color: '#94a3b8' };
                const statusMeta = EMAIL_STATUS_LABELS[log.status] || { label: log.status, color: '#64748b', bg: '#f3f4f6' };
                return (
                  <tr key={log._id} style={{ cursor: 'pointer' }} onClick={() => setPreviewLog(log)}>
                    <td style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                      {new Date(log.sentAt).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{log.user?.username || '—'}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>{log.toEmail}</div>
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        background: typeMeta.color + '20', color: typeMeta.color,
                        fontSize: 12, fontWeight: 600
                      }}>
                        {typeMeta.icon} {typeMeta.label}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.subject || '—'}
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        background: statusMeta.bg, color: statusMeta.color,
                        fontSize: 12, fontWeight: 600
                      }}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{log.triggeredBy || 'system'}</td>
                    <td><span style={{ color: '#8B5CF6', fontSize: 12 }}>Zobraziť →</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e5e7eb' }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>
              Strana {page} z {totalPages} ({total} záznamov)
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Predch.</button>
              <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Ďalšia →</button>
            </div>
          </div>
        )}
      </div>

      {/* TEST EMAIL SENDER */}
      <EmailTestSender />

      {/* BROADCAST CAMPAIGNS — one-off announcement emails to all users */}
      <BroadcastSender />

      {/* SECURITY MAINTENANCE — bulk migrate plaintext tokens (MED-003 follow-up) */}
      <TokenMigrationCard />

      {/* CONFIG INFO */}
      {config && (
        <div className="sa-card" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>⚙️ Konfigurácia</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
            <div><strong>SMTP host:</strong> {config.smtpHost || '—'}</div>
            <div><strong>From:</strong> {config.smtpFrom}</div>
            <div><strong>Admin email:</strong> {config.adminEmail}</div>
            <div><strong>SMTP stav:</strong> {config.smtpConfigured
              ? <span style={{ color: '#10b981' }}>● Pripojené</span>
              : <span style={{ color: '#ef4444' }}>● Nepripojené</span>}</div>
          </div>
          <h4 style={{ marginBottom: 8 }}>Aktívne promo kódy</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(config.promoCodes || {}).map(([k, v]) => (
              <span key={k} style={{
                padding: '4px 10px', borderRadius: 4,
                background: '#f5f3ff', color: '#6D28D9',
                fontSize: 13, fontFamily: 'monospace'
              }}>{k}: <strong>{v}</strong></span>
            ))}
          </div>
        </div>
      )}

      <AdminHelpToggle title="Manuál — Emaily">
        <p>
          <strong>Čo tu vidíš:</strong> centrálny audit všetkých emailov ktoré systém poslal —
          transakčných (zmena plánu, zľava, vymazanie) a marketingových (reminders, winback, broadcast).
          Všetko sa loguje cez <code>EmailLog</code> kolekciu vrátane HTML snapshotu.
        </p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📊 Stat header + denný graf</h4>
        <ul>
          <li><strong>Odoslaných za 7d / 30d</strong> — celkový volume.</li>
          <li><strong>Úspešnosť</strong> — % zo súčtu sent + failed (skip akcie nezahrnuté).</li>
          <li><strong>SMTP stav</strong> — či je transporter pripojený (zelené) alebo nie (červené).</li>
          <li><strong>Denný graf</strong> — line chart sent / failed / skipped za zvolené okno (7/30/90 dní). Užitočné na detekciu výpadkov SMTP.</li>
          <li><strong>Top typy</strong> — chip-y najčastejších typov za 7 dní.</li>
          <li><strong>⚠️ Posledné zlyhania</strong> — quick alert sekcia s 5 posledných failed mailov + chyba (na detekciu issues bez čítania logov).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔍 Filtre</h4>
        <ul>
          <li><strong>Search</strong> — substring v <code>toEmail</code> alebo <code>username</code>.</li>
          <li><strong>Typ / Stav</strong> — dropdowny pre exact match.</li>
          <li><strong>Preset days</strong> — 7 / 30 / 90 / všetko.</li>
          <li><strong>Custom range</strong> — Od / Do dátumy. Override-uje preset.</li>
          <li><strong>Zoradenie</strong> — klik na header (Čas / Príjemca / Typ / Stav) toggluje asc/desc.</li>
          <li><strong>Vymazať filtre</strong> — reset na default (30 dní, žiadny typ/stav/search).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📨 Typy mailov</h4>
        <ul>
          <li><strong>📦 subscription_assigned</strong> — admin manuálne zmenil predplatné používateľa</li>
          <li><strong>🎁 discount_assigned</strong> — admin pridal zľavu / freeMonths / planUpgrade</li>
          <li><strong>🎉 welcome_pro</strong> — prvý upgrade na Tím/Pro plán (jednorazový)</li>
          <li><strong>👋 welcome</strong> — po registrácii nového účtu</li>
          <li><strong>⏰ reminder_t7</strong> — 7 dní pred expiráciou (so zľavou 20%)</li>
          <li><strong>⚠️ reminder_t1</strong> — deň pred expiráciou (so zľavou 30%, urgency copy)</li>
          <li><strong>🔚 expired</strong> — po automatickom downgrade na Free (so zľavou 30%)</li>
          <li><strong>💝 winback</strong> — 14 dní po expirácii (50% posledná ponuka)</li>
          <li><strong>✉️ invitation</strong> — pozvánka do workspace</li>
          <li><strong>🔑 password_reset</strong> — reset hesla token</li>
          <li><strong>📱 mobile_app_launch</strong> — broadcast oznam o iOS/Android appke</li>
          <li><strong>🛎️ admin_notify</strong> — interný error alert na <code>support@prplcrm.eu</code></li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🚦 Stavy</h4>
        <ul>
          <li><strong>Odoslané</strong> — SMTP úspešne prijal mail (200ms p95).</li>
          <li><strong>Zlyhalo</strong> — SMTP error (timeout / auth / rejected). Detail v preview.</li>
          <li><strong>Cooldown</strong> — rovnaký typ poslaný v posledných 24h, skip (anti-spam).</li>
          <li><strong>Opt-out</strong> — user vypol <code>marketingEmails</code> v profile (len pre marketing typy).</li>
          <li><strong>Bez SMTP</strong> — server nemá SMTP konfiguráciu (dev / misconfig).</li>
        </ul>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>👁️ Preview HTML</h4>
        <p>
          Klik na riadok otvorí modal s plným HTML snapshot — presne to čo user videl v inboxe.
          Iframe je <code>sandbox=""</code> aby skripty nebežali. Užitočné pre support
          („ako vyzerá ten email čo som dostal?") aj debug šablón.
        </p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📥 Export CSV</h4>
        <p>Exportuje aktuálne <em>filtrované</em> logy (max 1000 záznamov). Stĺpce: SentAt / ToEmail / Username / Type / Subject / Status / Error / TriggeredBy.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🧪 Test šablóny</h4>
        <p>
          Pošle preview email s mock dátami na zadanú adresu — pre vizuálnu kontrolu šablóny bez nutnosti
          meniť plán reálnemu užívateľovi. Tieto maily nepodliehajú cooldown ani opt-out.
        </p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📣 Broadcast</h4>
        <p>
          One-off announcement na všetkých registrovaných (alebo aktívnych za N dní). Two-step UX
          (dryRun → reálny send). Idempotentné — kto už dostal za 30 dní, sa preskočí.
          Posielanie 5 mailov/sek aby ESP nehodnotil ako bulk spam.
        </p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>🔄 Auto-refresh</h4>
        <p>Logs + stats sa obnovujú každých 30s. Pause keď je tab v pozadí (Page Visibility) alebo otvorený preview modal.</p>

        <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 14 }}>📤 Manuálne odoslanie pre konkrétneho usera</h4>
        <p>
          V tabe <strong>Používatelia → Predplatné</strong> je tlačidlo „📤 Poslať email" pre support workflow
          (napr. user nedostal automatický reminder a admin chce ručne preposlať konkrétny typ).
        </p>

        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <em>Pozn.:</em> EmailLog kolekcia momentálne neexpiruje. Ak presiahne 100k záznamov, odporúča sa
          pridať TTL index na <code>sentAt</code> (90 dní) — viď komentár v <code>EmailLog.js</code> modeli.
        </p>
      </AdminHelpToggle>

      {previewLog && <EmailPreviewModal log={previewLog} onClose={() => setPreviewLog(null)} />}
    </div>
  );
}

/**
 * TokenMigrationCard — MED-003 follow-up. Šifruje legacy plaintext OAuth
 * refresh tokeny v DB. Idempotentné — opakované volanie neškodí.
 */
function TokenMigrationCard() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const run = async (dryRun) => {
    if (!dryRun && !confirm('Naozaj zašifrovať plaintext tokeny v produkčnej DB? Operácia je idempotentná, ale dotkne sa všetkých userov s OAuth.')) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await adminApi.post('/api/admin/migrate-encrypt-tokens', { dryRun });
      setResult({ ok: true, ...r.data });
    } catch (err) {
      setResult({ ok: false, error: err.response?.data?.message || err.message });
    } finally {
      setRunning(false);
    }
  };

  const renderStats = (stats) => {
    if (!stats?.perPath) return null;
    return (
      <table style={{ width: '100%', marginTop: 12, fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Field</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Plaintext</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Encrypted</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Migrated</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(stats.perPath).map(([path, s]) => (
            <tr key={path} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 12 }}>{path}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: s.plaintext > 0 ? '#dc2626' : '#10b981' }}>{s.plaintext}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#10b981' }}>{s.encrypted}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#6D28D9', fontWeight: 600 }}>{s.migrated || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className="sa-card" style={{ marginTop: 20, borderLeft: '4px solid #ef4444' }}>
      <h3 style={{ marginTop: 0 }}>🔐 MED-003 — Encrypt legacy tokens</h3>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 12 }}>
        Šifruje plaintext OAuth refresh tokeny v DB ktoré ostali z času pred MED-003 deployom. AccessToken-y sa šifrujú prirodzene cez hodinový Google refresh cyklus, ale refreshToken-y sa nemodifikujú a treba ich migrovať jednorazovo. Operácia je idempotentná.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary" onClick={() => run(true)} disabled={running}>
          {running ? 'Beží...' : '1. Náhľad (dry run)'}
        </button>
        <button className="btn btn-primary" onClick={() => run(false)} disabled={running} style={{ background: '#dc2626' }}>
          {running ? 'Beží...' : '2. Spustiť migráciu'}
        </button>
      </div>
      {result?.ok && (
        <>
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: result.dryRun ? '#fef3c7' : '#d1fae5', color: result.dryRun ? '#92400e' : '#065f46', fontSize: 13 }}>
            {result.dryRun
              ? `📊 Dry run — ${result.stats.usersScanned} userov skenovaných. Reálne sa nezapísalo nič.`
              : `✅ Migrácia hotová — ${result.stats.usersScanned} userov skenovaných.`}
          </div>
          {renderStats(result.stats)}
        </>
      )}
      {result && !result.ok && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>
          ❌ {result.error}
        </div>
      )}
    </div>
  );
}

/**
 * BroadcastSender — UI pre one-off announcement broadcast (mobile app launch).
 *
 * Two-step UX: najprv dryRun (preview počtov), potom reálny send.
 * Backend posiela mailom asynchrónne (200ms throttle) — admin response
 * sa vráti okamžite, progress sledovať cez Email log table vyššie.
 */
function BroadcastSender() {
  const [days, setDays] = useState('');
  const [dryRunResult, setDryRunResult] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  const handleDryRun = async () => {
    setDryRunResult(null);
    setSendResult(null);
    try {
      const r = await adminApi.post('/api/admin/email-broadcast/mobile-app-launch', {
        activeWithinDays: days ? parseInt(days) : null,
        dryRun: true
      });
      setDryRunResult(r.data);
    } catch (err) {
      setDryRunResult({ error: err.response?.data?.message || err.message });
    }
  };

  const handleSend = async () => {
    if (!confirm(`Naozaj poslať broadcast email ${dryRunResult?.toSend || '?'} užívateľom? Toto sa nedá zastaviť.`)) return;
    setSending(true);
    setSendResult(null);
    try {
      const r = await adminApi.post('/api/admin/email-broadcast/mobile-app-launch', {
        activeWithinDays: days ? parseInt(days) : null,
        dryRun: false
      });
      setSendResult({ ok: true, ...r.data });
      setDryRunResult(null);
    } catch (err) {
      setSendResult({ ok: false, error: err.response?.data?.message || err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sa-card" style={{ marginTop: 20, borderLeft: '4px solid #f59e0b' }}>
      <h3 style={{ marginTop: 0 }}>📣 Broadcast — Mobilná appka oznam</h3>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 0 }}>
        Pošle email „Prpl CRM je teraz aj ako mobilná aplikácia" všetkým registrovaným užívateľom. Posielanie 5 mailov/sek (rate limit aby sme neboli označení za bulk spam). Idempotency: užívatelia, ktorí už mail dostali za posledných 30 dní, sa preskočia.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 4 }}>
            Komu poslať
          </label>
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="sa-input"
          >
            <option value="">Všetkým registrovaným užívateľom</option>
            <option value="30">Iba registrovaným za posledných 30 dní</option>
            <option value="90">Iba registrovaným za posledné 3 mesiace</option>
            <option value="180">Iba registrovaným za posledných 6 mesiacov</option>
            <option value="365">Iba registrovaným za posledný rok</option>
          </select>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '4px 0 0' }}>
            Filtrovaním sa vyhneš mŕtvym účtom (zlepší doručiteľnosť do Inboxu).
          </p>
        </div>
        <button className="btn btn-secondary" onClick={handleDryRun} style={{ height: 40 }}>
          1. Náhľad (dry run)
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={!dryRunResult?.toSend || sending}
          style={{ height: 40 }}
          title={!dryRunResult?.toSend ? 'Najprv urob dry run' : ''}
        >
          {sending ? 'Spúšťam...' : '2. Odoslať broadcast'}
        </button>
      </div>

      {dryRunResult && !dryRunResult.error && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fef3c7', fontSize: 13, color: '#92400e' }}>
          📊 <strong>Náhľad:</strong> {dryRunResult.eligibleUsers} eligibilných užívateľov, {dryRunResult.alreadySent} už dostalo, <strong>{dryRunResult.toSend}</strong> sa odošle. Predpokladaný čas: {Math.ceil((dryRunResult.toSend || 0) * 0.2)} sekúnd.
        </div>
      )}
      {dryRunResult?.error && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>
          ❌ {dryRunResult.error}
        </div>
      )}
      {sendResult?.ok && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#d1fae5', color: '#065f46', fontSize: 13 }}>
          ✅ Broadcast spustený na pozadí. Posielanie {sendResult.toSend} mailov beží — sledujte progress v Email log table vyššie (filter: typ „Mobile app launch"). Predpokladaný čas: {Math.ceil((sendResult.toSend || 0) * 0.2)} sekúnd.
        </div>
      )}
      {sendResult && !sendResult.ok && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>
          ❌ {sendResult.error}
        </div>
      )}
    </div>
  );
}

function EmailTestSender() {
  const [toEmail, setToEmail] = useState('');
  const [type, setType] = useState('welcome_pro');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const handleSend = async () => {
    setSending(true);
    setResult(null);
    try {
      const r = await adminApi.post('/api/admin/email-test', { toEmail, type });
      setResult({ ok: r.data?.success, status: r.data?.status });
    } catch (err) {
      setResult({ ok: false, status: 'error', error: err.response?.data?.message || err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sa-card" style={{ marginTop: 20, borderLeft: '4px solid #06b6d4' }}>
      <h3 style={{ marginTop: 0 }}>🧪 Test šablóny</h3>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 0 }}>
        Pošle preview email s mock dátami na zadanú adresu — pre vizuálnu kontrolu šablóny bez nutnosti meniť plán reálnemu užívateľovi. Tieto maily nepodliehajú cooldown ani opt-out.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 4 }}>Príjemca</label>
          <input
            type="email"
            placeholder="email@example.com"
            value={toEmail}
            onChange={(e) => setToEmail(e.target.value)}
            className="sa-input"
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 4 }}>Typ</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className="sa-input">
            <option value="welcome">👋 Welcome (po registrácii)</option>
            <option value="welcome_pro">🎉 Welcome Pro</option>
            <option value="subscription_assigned">📦 Plán priradený</option>
            <option value="discount_assigned">🎁 Zľava priradená</option>
            <option value="reminder_t7">⏰ Reminder T-7</option>
            <option value="reminder_t1">⚠️ Reminder T-1</option>
            <option value="expired">🔚 Expirovaný</option>
            <option value="winback">💝 Winback</option>
            <option value="mobile_app_launch">📱 Mobile app launch</option>
          </select>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={sending || !toEmail}
          style={{ height: 40, padding: '0 20px' }}
        >
          {sending ? 'Posielam...' : 'Poslať test'}
        </button>
      </div>
      {result && (
        <div style={{
          marginTop: 12, padding: 10, borderRadius: 8,
          background: result.ok ? '#d1fae5' : '#fee2e2',
          color: result.ok ? '#065f46' : '#991b1b',
          fontSize: 13
        }}>
          {result.ok
            ? `✅ Email odoslaný. Status: ${result.status}`
            : `❌ Chyba: ${result.error || result.status}`}
        </div>
      )}
    </div>
  );
}

function EmailPreviewModal({ log, onClose }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await adminApi.get(`/api/admin/email-logs/${log._id}`);
        if (!cancelled) setFull(r.data);
      } catch (err) {
        if (!cancelled) setFull({ error: 'Nepodarilo sa načítať preview' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [log._id]);

  const typeMeta = EMAIL_TYPE_LABELS[log.type] || { label: log.type, icon: '✉️' };
  const statusMeta = EMAIL_STATUS_LABELS[log.status] || { label: log.status };

  return (
    <div className="sa-modal-overlay" onClick={onClose}>
      <div className="sa-modal" style={{ maxWidth: 800, maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="sa-modal-head">
          <h3>{typeMeta.icon} {typeMeta.label}</h3>
          <button className="sa-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="sa-modal-body" style={{ overflow: 'auto' }}>
          <div style={{ marginBottom: 16, fontSize: 13, color: '#475569', lineHeight: 1.7 }}>
            <div><strong>Príjemca:</strong> {log.toEmail}</div>
            <div><strong>Subject:</strong> {log.subject || '—'}</div>
            <div><strong>From:</strong> {full?.fromAddress || '—'}</div>
            <div><strong>Stav:</strong> {statusMeta.label}</div>
            <div><strong>Čas:</strong> {new Date(log.sentAt).toLocaleString('sk-SK')}</div>
            <div><strong>Trigger:</strong> {log.triggeredBy || 'system'}</div>
            {full?.error && <div style={{ color: '#dc2626' }}><strong>Chyba:</strong> {full.error}</div>}
            {full?.context?.promoCode && <div><strong>Promo kód:</strong> <code>{full.context.promoCode}</code></div>}
          </div>

          {loading && <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>Načítavam preview...</div>}
          {!loading && full?.htmlSnapshot && (
            <div>
              <h4>Preview HTML</h4>
              <iframe
                srcDoc={full.htmlSnapshot}
                title="Email preview"
                style={{ width: '100%', height: 500, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}
                sandbox=""
              />
            </div>
          )}
          {!loading && !full?.htmlSnapshot && !full?.error && (
            <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>HTML snapshot nie je dostupný (skipped pred renderom).</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminPanel;
