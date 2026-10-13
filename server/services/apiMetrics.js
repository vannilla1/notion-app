// Simple in-memory API request counter
// Tracks requests per route per hour, resets every 24h

const counters = {
  routes: {},      // { '/api/contacts': { total: 0, methods: { GET: 0, POST: 0 } } }
  hourly: {},      // { '2026-04-10T14': 42 }
  statusCodes: {}, // { 200: 100, 404: 5 }
  startedAt: new Date(),
  totalRequests: 0
};

// Clean old hourly data (keep last 48h)
const cleanOldData = () => {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 48);
  const cutoffKey = cutoff.toISOString().slice(0, 13);
  for (const key of Object.keys(counters.hourly)) {
    if (key < cutoffKey) delete counters.hourly[key];
  }
};

// Startup grace window — počas prvých STARTUP_GRACE_MS po boot-e ignorujeme
// 503 responses. Sú to typicky requesty ktoré prišli kým ešte Mongoose
// connectovala na MongoDB — DB readiness middleware vracia 503 a admin
// panel ich potom ukazoval ako "100% error rate" čo mätie. Reálne to nie
// sú aplikačné chyby, len normálne startup okno.
const STARTUP_GRACE_MS = 30_000;
const SERVER_BOOT_TIME = Date.now();

// Strop počtu sledovaných route kľúčov. Keď request nematchne žiadnu routu
// (404 skeny, 503 z DB-readiness middleware), kľúčom je surová req.path —
// každá unikátna cesta by inak vytvorila nový záznam v counters.routes,
// ktorý sa nikdy nemaže (cleanOldData čistí len hourly). Neautentifikovaný
// klient by tak riadil rast pamäte procesu.
const MAX_ROUTES = 1000;
const OVERFLOW_ROUTE = '__other__';

// Normalizácia nespárovanej cesty — UUID / ObjectId / číselné ID → /:id,
// bez query stringu (rovnaký vzor ako serverErrorService._normalizePath,
// lokálna kópia aby apiMetrics ostal bez závislostí na Mongo modeloch).
const normalizeUnmatchedPath = (path) => {
  if (typeof path !== 'string' || !path) return '<unknown>';
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$|\?)/gi, '/:id')
    .replace(/\/[a-f0-9]{24}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '')
    .slice(0, 200);
};

const trackRequest = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    let route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : normalizeUnmatchedPath(req.path);
    // Nový kľúč nad stropom ide do spoločného bucketu namiesto neobmedzeného
    // rastu; existujúce kľúče sa ďalej počítajú normálne.
    if (!counters.routes[route] && Object.keys(counters.routes).length >= MAX_ROUTES) {
      route = OVERFLOW_ROUTE;
    }
    const method = req.method;
    const status = res.statusCode;
    const hourKey = new Date().toISOString().slice(0, 13);

    // Skip startup-window 503s — nie sú to bug-y, len boot artifacts
    const isStartup503 = status === 503 && (Date.now() - SERVER_BOOT_TIME) < STARTUP_GRACE_MS;
    if (isStartup503) return;

    // Route stats
    if (!counters.routes[route]) {
      counters.routes[route] = {
        total: 0, methods: {}, avgDuration: 0, totalDuration: 0,
        // Per-route status group counters — pre top-error-routes view.
        // Bez nich sme nevedeli povedať "ktoré endpointy zlyhávajú najviac".
        statusGroups: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
        errors: 0 // 4xx + 5xx
      };
    }
    const r = counters.routes[route];
    r.total++;
    r.methods[method] = (r.methods[method] || 0) + 1;
    r.totalDuration += duration;
    r.avgDuration = Math.round(r.totalDuration / r.total);
    // Status group bucket
    const statusGroup = `${Math.floor(status / 100)}xx`;
    if (r.statusGroups[statusGroup] !== undefined) {
      r.statusGroups[statusGroup]++;
    }
    if (status >= 400) r.errors++;

    // Hourly
    counters.hourly[hourKey] = (counters.hourly[hourKey] || 0) + 1;

    // Status codes
    counters.statusCodes[status] = (counters.statusCodes[status] || 0) + 1;

    // Total
    counters.totalRequests++;
  });

  next();
};

const getMetrics = () => {
  cleanOldData();

  // Top routes by total requests + samostatné top-by-duration a top-by-errors
  // pohľady. Admin si vyberie podľa toho čo lovi (najťažšie cesty / najpomalšie
  // / najviac zlyhávajúce).
  const allRoutes = Object.entries(counters.routes)
    .map(([route, data]) => ({ route, ...data }));
  const topRoutes = [...allRoutes].sort((a, b) => b.total - a.total).slice(0, 20);
  const topSlowRoutes = [...allRoutes]
    .filter((r) => r.total >= 5) // ignore one-off endpoints
    .sort((a, b) => b.avgDuration - a.avgDuration)
    .slice(0, 10);
  const topErrorRoutes = [...allRoutes]
    .filter((r) => r.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);

  // Hourly data for last 24h
  const now = new Date();
  const hourlyData = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(d.getHours() - i);
    const key = d.toISOString().slice(0, 13);
    hourlyData.push({ hour: key, count: counters.hourly[key] || 0 });
  }

  // Error rate
  const errorCount = Object.entries(counters.statusCodes)
    .filter(([code]) => parseInt(code) >= 400)
    .reduce((sum, [, count]) => sum + count, 0);

  // Aggregate status groups z global statusCodes (2xx/3xx/4xx/5xx)
  const statusGroups = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const [code, count] of Object.entries(counters.statusCodes)) {
    const group = `${Math.floor(parseInt(code) / 100)}xx`;
    if (statusGroups[group] !== undefined) statusGroups[group] += count;
  }

  return {
    totalRequests: counters.totalRequests,
    trackingSince: counters.startedAt,
    topRoutes,
    topSlowRoutes,
    topErrorRoutes,
    hourlyData,
    statusCodes: counters.statusCodes,
    statusGroups,
    errorRate: counters.totalRequests > 0
      ? Math.round((errorCount / counters.totalRequests) * 10000) / 100
      : 0,
    requestsPerMinute: counters.totalRequests > 0
      ? Math.round(counters.totalRequests / ((Date.now() - counters.startedAt.getTime()) / 60000) * 100) / 100
      : 0
  };
};

// Reset všetkých counterov. Užitočné po deploy-i alebo pri performance
// debugovaní — admin chce vidieť čerstvé čísla z aktuálnej zmeny, nie
// staré priemery skreslené historickými request-mi.
const resetMetrics = () => {
  counters.routes = {};
  counters.hourly = {};
  counters.statusCodes = {};
  counters.totalRequests = 0;
  counters.startedAt = new Date();
};

module.exports = { trackRequest, getMetrics, resetMetrics };
