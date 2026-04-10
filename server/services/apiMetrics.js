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

const trackRequest = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.path;
    const method = req.method;
    const status = res.statusCode;
    const hourKey = new Date().toISOString().slice(0, 13);

    // Route stats
    if (!counters.routes[route]) {
      counters.routes[route] = { total: 0, methods: {}, avgDuration: 0, totalDuration: 0 };
    }
    const r = counters.routes[route];
    r.total++;
    r.methods[method] = (r.methods[method] || 0) + 1;
    r.totalDuration += duration;
    r.avgDuration = Math.round(r.totalDuration / r.total);

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

  // Top routes by total requests
  const topRoutes = Object.entries(counters.routes)
    .map(([route, data]) => ({ route, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

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

  return {
    totalRequests: counters.totalRequests,
    trackingSince: counters.startedAt,
    topRoutes,
    hourlyData,
    statusCodes: counters.statusCodes,
    errorRate: counters.totalRequests > 0
      ? Math.round((errorCount / counters.totalRequests) * 10000) / 100
      : 0,
    requestsPerMinute: counters.totalRequests > 0
      ? Math.round(counters.totalRequests / ((Date.now() - counters.startedAt.getTime()) / 60000) * 100) / 100
      : 0
  };
};

module.exports = { trackRequest, getMetrics };
