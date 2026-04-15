const { getUrgencyLevel } = require('../../services/dueDateChecker');

/**
 * dueDateChecker testy — urgency level calculation (pure function).
 *
 * Testujeme len exportovanú čistú funkciu `getUrgencyLevel`. Hlavný cron
 * `checkDueDates` integruje viacero modelov + notificationService + Socket.IO;
 * pokryli by sme ho len plnohodnotným integračným testom (mimo scope).
 *
 * Urgency škála (viď services/dueDateChecker.js:13-29):
 *   - overdue: < 0 dní (po termíne) ALEBO == 0 (dnes)
 *   - danger:  1-3 dní
 *   - warning: 4-7 dní
 *   - success: 8-14 dní
 *   - null:    > 14 dní alebo žiadny dueDate
 *
 * Dátumy sa normalizujú na začiatok dňa (setHours(0,0,0,0)) a rozdiel
 * sa počíta cez Math.ceil — preto 1.4 dňa → 2 dni, 0.5 dňa → 1 deň.
 */
describe('dueDateChecker.getUrgencyLevel', () => {
  /**
   * Pomocná: vráti dátum posunutý o `days` odo dneška (na polnoc).
   * Pozitívne = budúcnosť, negatívne = minulosť.
   */
  const daysFromNow = (days) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d;
  };

  describe('Null / no date', () => {
    it('should return null for null dueDate', () => {
      expect(getUrgencyLevel(null)).toBeNull();
    });

    it('should return null for undefined dueDate', () => {
      expect(getUrgencyLevel(undefined)).toBeNull();
    });

    it('should return null for dueDate > 14 days away', () => {
      expect(getUrgencyLevel(daysFromNow(15))).toBeNull();
      expect(getUrgencyLevel(daysFromNow(30))).toBeNull();
      expect(getUrgencyLevel(daysFromNow(100))).toBeNull();
    });
  });

  describe('Overdue (≤ 0 days)', () => {
    it('should return "overdue" for today (0 days)', () => {
      expect(getUrgencyLevel(daysFromNow(0))).toBe('overdue');
    });

    it('should return "overdue" for yesterday (-1 day)', () => {
      expect(getUrgencyLevel(daysFromNow(-1))).toBe('overdue');
    });

    it('should return "overdue" for a week ago', () => {
      expect(getUrgencyLevel(daysFromNow(-7))).toBe('overdue');
    });

    it('should return "overdue" for a month ago', () => {
      expect(getUrgencyLevel(daysFromNow(-30))).toBe('overdue');
    });
  });

  describe('Danger (1-3 days)', () => {
    it.each([1, 2, 3])('should return "danger" for %i day(s) from now', (d) => {
      expect(getUrgencyLevel(daysFromNow(d))).toBe('danger');
    });
  });

  describe('Warning (4-7 days)', () => {
    it.each([4, 5, 6, 7])('should return "warning" for %i days from now', (d) => {
      expect(getUrgencyLevel(daysFromNow(d))).toBe('warning');
    });
  });

  describe('Success (8-14 days)', () => {
    it.each([8, 10, 14])('should return "success" for %i days from now', (d) => {
      expect(getUrgencyLevel(daysFromNow(d))).toBe('success');
    });
  });

  describe('Boundary transitions', () => {
    it('day 3 → danger, day 4 → warning (hranica)', () => {
      expect(getUrgencyLevel(daysFromNow(3))).toBe('danger');
      expect(getUrgencyLevel(daysFromNow(4))).toBe('warning');
    });

    it('day 7 → warning, day 8 → success (hranica)', () => {
      expect(getUrgencyLevel(daysFromNow(7))).toBe('warning');
      expect(getUrgencyLevel(daysFromNow(8))).toBe('success');
    });

    it('day 14 → success, day 15 → null (hranica)', () => {
      expect(getUrgencyLevel(daysFromNow(14))).toBe('success');
      expect(getUrgencyLevel(daysFromNow(15))).toBeNull();
    });
  });

  describe('ISO string / non-Date input', () => {
    it('should handle ISO string dates', () => {
      const twoDaysOut = new Date();
      twoDaysOut.setHours(0, 0, 0, 0);
      twoDaysOut.setDate(twoDaysOut.getDate() + 2);
      expect(getUrgencyLevel(twoDaysOut.toISOString())).toBe('danger');
    });

    it('should handle timestamp number', () => {
      const fiveDaysOut = Date.now() + 5 * 24 * 60 * 60 * 1000;
      expect(getUrgencyLevel(fiveDaysOut)).toBe('warning');
    });
  });

  describe('Time-of-day normalization', () => {
    it('should treat dueDate at 23:59 the same as at 00:00 (same calendar day)', () => {
      // Dnes o polnoci vs. dnes o 23:59 — oba sú "overdue"
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);

      const todayLate = new Date();
      todayLate.setHours(23, 59, 59, 999);

      expect(getUrgencyLevel(todayMidnight)).toBe('overdue');
      expect(getUrgencyLevel(todayLate)).toBe('overdue');
    });
  });
});
