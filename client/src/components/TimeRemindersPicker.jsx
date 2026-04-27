/**
 * Multi-select picker pre časové pripomienky pred presným termínom úlohy.
 *
 * Zobrazí sa LEN ak má úloha vyplnený dueTime (HH:MM). Bez času sa
 * automatické pripomienky riadia per-day urgency-level prechodmi
 * (14d / 7d / 3d / overdue), ktoré chodia ako "general" notifikácie a
 * push gating-uje sa cez Settings.
 *
 * User si môže vybrať jeden alebo viacero časov pred termínom — keď
 * cron 5-min checker zachytí, že now == dueDateTime - X min, pošle
 * 'direct' notifikáciu (vždy push, bez ohľadu na Settings).
 *
 * Hodnoty zodpovedajú backend whitelist-u (sanitizeTimeReminders).
 */
const REMINDER_OPTIONS = [
  { value: 15,   label: '15 min' },
  { value: 30,   label: '30 min' },
  { value: 60,   label: '1 hodina' },
  { value: 120,  label: '2 hodiny' },
  { value: 1440, label: '1 deň' }
];

export default function TimeRemindersPicker({ value, onChange, hasTime }) {
  // Bez nastaveného času nemá zmysel ponúkať časové pripomienky.
  if (!hasTime) {
    return (
      <div className="time-reminders-picker time-reminders-picker--disabled">
        <div className="time-reminders-hint">
          🔔 Časové pripomienky sa odomknú po nastavení času termínu (HH:MM).
          Auto-pripomienky 14 / 7 / 3 dni a po termíne chodia automaticky pre
          úlohy s dátumom.
        </div>
      </div>
    );
  }

  const selected = new Set((value || []).map(Number));

  const toggle = (mins) => {
    const next = new Set(selected);
    if (next.has(mins)) next.delete(mins);
    else next.add(mins);
    onChange(Array.from(next).sort((a, b) => b - a));
  };

  return (
    <div className="time-reminders-picker">
      <div className="time-reminders-grid">
        {REMINDER_OPTIONS.map(opt => {
          const checked = selected.has(opt.value);
          return (
            <label
              key={opt.value}
              className={`time-reminder-pill ${checked ? 'checked' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          );
        })}
      </div>
      <div className="time-reminders-hint">
        Push notifikácia ti príde X minút/hodín pred presným časom termínu.
        Označ jednu alebo viacero hodnôt.
      </div>
    </div>
  );
}
