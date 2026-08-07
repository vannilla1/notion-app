/**
 * taskSort.js — jednotné poradie projektov naprieč appkou.
 *
 * Pravidlo: nedokončené pred dokončenými → priorita (vysoká → stredná →
 * nízka) → ABECEDA v rámci priority (slovenské triedenie, čísla v názvoch
 * prirodzene: „Projekt 2" < „Projekt 10").
 *
 * Nahrádza ručné drag & drop poradie projektov (pole `order`) — to od
 * 6. 8. 2026 už o poradí nerozhoduje. Drag podúloh V RÁMCI projektu
 * ostáva (tam `order` platí ďalej).
 */
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

export const compareTasksForDisplay = (a, b) => {
  const aCompleted = a.completed === true;
  const bCompleted = b.completed === true;
  if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
  const priA = PRIORITY_ORDER[a.priority] ?? 1;
  const priB = PRIORITY_ORDER[b.priority] ?? 1;
  if (priA !== priB) return priA - priB;
  return (a.title || '').localeCompare(b.title || '', 'sk', { numeric: true, sensitivity: 'base' });
};
