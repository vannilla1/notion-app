/**
 * Socket „task-updated" → zlúčenie s úlohou, ktorú už klient má.
 *
 * Nie každá serverová mutácia posiela obohatenú úlohu: PUT /api/tasks/:id
 * pridá contactNames / contactName / assignedUsers, ale emity z podúloh
 * a príloh (upload, delete, rename) posielajú holý taskToPlainObject. Klient
 * úlohu predtým nahradil celú → kolegom po každej novej fotke či podúlohe
 * zmizli odznaky kontaktov a avatary priradených až do ďalšieho načítania.
 *
 * Preto obohacujúce polia, ktoré udalosť NEOBSAHUJE (undefined), prevezmeme
 * z pôvodnej úlohy. Ak ich udalosť obsahuje (aj prázdne pole), platí udalosť.
 */
const ENRICHED_KEYS = ['contactNames', 'contactName', 'assignedUsers'];

export const mergeTaskUpdate = (prevTask, updatedTask) => {
  if (!prevTask) return updatedTask;
  const merged = { ...updatedTask };
  for (const key of ENRICHED_KEYS) {
    if (merged[key] === undefined && prevTask[key] !== undefined) merged[key] = prevTask[key];
  }
  return merged;
};
