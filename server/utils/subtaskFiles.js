/**
 * subtaskFiles.js — prílohy podúloh sa NIKDY neberú z tela požiadavky.
 *
 * PUT /api/tasks/:id a PUT /api/contacts/:contactId/tasks/:taskId prijímajú
 * celý strom `subtasks` od klienta (úprava názvu, poradia, dokončenia…).
 * Do 9/2026 sa ukladal doslovne, vrátane `files[]` — používateľ tak mohol do
 * svojej podúlohy podstrčiť cudzie fileId a potom ho stiahnuť alebo zmazať
 * cez /api/tasks/:taskId/files/:fileId (bloby globálnych úloh majú
 * ContactFile.contactId = null, takže ich nič neviaže na prostredie).
 *
 * Prílohy pribúdajú a ubúdajú len cez upload/delete routy. Tu ich preto pri
 * každom PUT vezmeme zo servera podľa ID podúlohy (hľadá sa v celom strome,
 * takže presun podúlohy pod iného rodiča ich zachová). Nová podúloha, ktorú
 * server nepozná, začína bez príloh.
 */
const toPlain = (s) => (s && typeof s.toObject === 'function' ? s.toObject() : s);

const collectFiles = (subtasks, map = new Map()) => {
  if (!Array.isArray(subtasks)) return map;
  for (const raw of subtasks) {
    const s = toPlain(raw);
    if (!s || typeof s !== 'object') continue;
    if (s.id != null) map.set(String(s.id), Array.isArray(s.files) ? s.files : []);
    collectFiles(s.subtasks, map);
  }
  return map;
};

const applyFiles = (subtasks, map) => {
  // Nie-pole (objekt, {0:…, length:1}) by Mongoose zabalil do [obj] a uložil
  // aj s podstrčenými files[] — preto sa z neho nič neprevezme.
  if (!Array.isArray(subtasks)) return [];
  return subtasks.map((raw) => {
    const s = toPlain(raw);
    if (!s || typeof s !== 'object') return s;
    const serverFiles = s.id != null ? map.get(String(s.id)) : undefined;
    return {
      ...s,
      files: serverFiles || [],
      subtasks: applyFiles(s.subtasks, map)
    };
  });
};

/**
 * @param {Array} incoming  strom podúloh z req.body.subtasks
 * @param {Array} existing  aktuálny strom podúloh z DB
 * @returns {Array} incoming s files[] prevzatými zo servera; pri nie-poli
 *          vráti `existing` (zmena podúloh sa ignoruje)
 */
const withServerSubtaskFiles = (incoming, existing) => {
  // Poškodený strom (nie pole) ignorujeme a necháme serverový — žiadny
  // legitímny klient taký neposiela a doslovné uloženie by otvorilo presne
  // tú dieru, ktorú tento modul zatvára.
  if (!Array.isArray(incoming)) return existing;
  return applyFiles(incoming, collectFiles(existing));
};

module.exports = { withServerSubtaskFiles };
