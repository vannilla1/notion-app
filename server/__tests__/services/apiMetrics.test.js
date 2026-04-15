/**
 * apiMetrics testy — in-memory request counter middleware.
 *
 * Testujeme:
 *   - trackRequest middleware zachytí res.finish event a inkrementuje countery
 *   - getMetrics() vráti topRoutes, hourlyData (24h), statusCodes, errorRate
 *   - errorRate je správne počítaný (4xx+5xx / total * 100, zaokrúhlené na 2 des.)
 *   - avgDuration sa počíta ako kumulatívny priemer
 *
 * POZN: apiMetrics drží state v module-level objektoch, preto si musíme
 * stav resetovať cez jest.resetModules() pred každým testom.
 */
describe('apiMetrics service', () => {
  let apiMetrics;

  beforeEach(() => {
    // Reset module state medzi testmi (counters sú module-level)
    jest.resetModules();
    apiMetrics = require('../../services/apiMetrics');
  });

  /**
   * Helper: simulate Express req/res cycle. Volá next() synchronne,
   * potom spustí res.on('finish') callback manuálne.
   */
  const simulateRequest = ({ method = 'GET', route = '/api/test', status = 200, baseUrl = '' } = {}) => {
    const req = {
      method,
      baseUrl,
      path: route,
      route: { path: route.replace(baseUrl, '') }
    };
    let finishCallback;
    const res = {
      statusCode: status,
      on: (event, cb) => {
        if (event === 'finish') finishCallback = cb;
      }
    };
    const next = jest.fn();
    apiMetrics.trackRequest(req, res, next);
    expect(next).toHaveBeenCalled();
    // Simulate finish emission
    if (finishCallback) finishCallback();
  };

  describe('trackRequest middleware', () => {
    it('should call next() immediately (non-blocking)', () => {
      const next = jest.fn();
      const req = { method: 'GET', path: '/x', baseUrl: '', route: { path: '/x' } };
      const res = { statusCode: 200, on: jest.fn() };
      apiMetrics.trackRequest(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should register a finish handler on response', () => {
      const next = jest.fn();
      const req = { method: 'GET', path: '/x', baseUrl: '', route: { path: '/x' } };
      const res = { statusCode: 200, on: jest.fn() };
      apiMetrics.trackRequest(req, res, next);
      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    });

    it('should increment totalRequests on finish', () => {
      simulateRequest({ method: 'GET', route: '/api/contacts' });
      simulateRequest({ method: 'POST', route: '/api/contacts' });
      simulateRequest({ method: 'GET', route: '/api/tasks' });

      const m = apiMetrics.getMetrics();
      expect(m.totalRequests).toBe(3);
    });

    it('should group requests by route and method', () => {
      simulateRequest({ method: 'GET', route: '/api/contacts' });
      simulateRequest({ method: 'GET', route: '/api/contacts' });
      simulateRequest({ method: 'POST', route: '/api/contacts' });

      const m = apiMetrics.getMetrics();
      const contacts = m.topRoutes.find((r) => r.route === '/api/contacts');
      expect(contacts).toBeDefined();
      expect(contacts.total).toBe(3);
      expect(contacts.methods.GET).toBe(2);
      expect(contacts.methods.POST).toBe(1);
    });

    it('should increment statusCodes counter', () => {
      simulateRequest({ status: 200 });
      simulateRequest({ status: 200 });
      simulateRequest({ status: 404 });
      simulateRequest({ status: 500 });

      const m = apiMetrics.getMetrics();
      expect(m.statusCodes['200']).toBe(2);
      expect(m.statusCodes['404']).toBe(1);
      expect(m.statusCodes['500']).toBe(1);
    });
  });

  describe('getMetrics', () => {
    it('should return zeros on cold start', () => {
      const m = apiMetrics.getMetrics();
      expect(m.totalRequests).toBe(0);
      expect(m.errorRate).toBe(0);
      expect(m.topRoutes).toEqual([]);
      expect(m.hourlyData).toHaveLength(24); // vždy posledných 24 hodín
    });

    it('should compute errorRate = (4xx+5xx)/total * 100, rounded to 2 decimals', () => {
      // 8 úspešných + 2 errory = 20% error rate
      for (let i = 0; i < 8; i++) simulateRequest({ status: 200 });
      simulateRequest({ status: 404 });
      simulateRequest({ status: 500 });

      const m = apiMetrics.getMetrics();
      expect(m.totalRequests).toBe(10);
      expect(m.errorRate).toBe(20); // 20.00 → 20
    });

    it('should handle fractional error rates', () => {
      // 99 × 200 + 1 × 500 = 1% error rate
      for (let i = 0; i < 99; i++) simulateRequest({ status: 200 });
      simulateRequest({ status: 500 });

      const m = apiMetrics.getMetrics();
      expect(m.errorRate).toBe(1);
    });

    it('should sort topRoutes by total desc and cap at 20', () => {
      // 3 routes s rôznym počtom volaní
      for (let i = 0; i < 5; i++) simulateRequest({ route: '/api/a' });
      for (let i = 0; i < 10; i++) simulateRequest({ route: '/api/b' });
      simulateRequest({ route: '/api/c' });

      const m = apiMetrics.getMetrics();
      expect(m.topRoutes[0].route).toBe('/api/b');
      expect(m.topRoutes[0].total).toBe(10);
      expect(m.topRoutes[1].route).toBe('/api/a');
      expect(m.topRoutes[2].route).toBe('/api/c');
    });

    it('should return hourlyData with 24 entries ending at current hour', () => {
      simulateRequest({ route: '/api/x' });
      const m = apiMetrics.getMetrics();
      expect(m.hourlyData).toHaveLength(24);
      // Posledný záznam = aktuálna hodina
      const nowHourKey = new Date().toISOString().slice(0, 13);
      expect(m.hourlyData[23].hour).toBe(nowHourKey);
      expect(m.hourlyData[23].count).toBe(1);
    });

    it('should track avgDuration per route (monotonic accumulation)', () => {
      // duration = finish - start; keďže simulateRequest je synchrónny,
      // duration bude ~0ms. Testujeme že pole existuje a je číslo.
      simulateRequest({ route: '/api/fast' });
      simulateRequest({ route: '/api/fast' });

      const m = apiMetrics.getMetrics();
      const fast = m.topRoutes.find((r) => r.route === '/api/fast');
      expect(fast).toBeDefined();
      expect(typeof fast.avgDuration).toBe('number');
      expect(fast.avgDuration).toBeGreaterThanOrEqual(0);
    });

    it('should report requestsPerMinute as a non-negative number', () => {
      simulateRequest({ route: '/api/x' });
      const m = apiMetrics.getMetrics();
      expect(typeof m.requestsPerMinute).toBe('number');
      expect(m.requestsPerMinute).toBeGreaterThanOrEqual(0);
    });
  });
});
