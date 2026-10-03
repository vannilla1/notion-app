/**
 * nestedTaskUpdate.js — cielené zápisy do vnorených úloh/podúloh.
 *
 * Plánovač termínov (dueDateChecker) predtým ukladal CELÉ pole podúloh
 * (task.save() / Contact.updateOne({ tasks })) zo snapshotu načítaného na
 * začiatku behu. Zmena, ktorú používateľ medzitým urobil (dokončenie,
 * úprava, nový súbor), sa tak prepísala starou kópiou.
 *
 * Tu sa zo zmien skladá jeden updateOne, ktorý adresuje uzly podľa `id`
 * cez arrayFilters (`subtasks.$[n0].subtasks.$[n1].reminderSent`) a mení
 * iba označovacie polia konkrétnych uzlov. Uzol, ktorý používateľ medzitým
 * zmazal, sa jednoducho nezmení.
 *
 * Uzly bez `id` (veľmi staré dáta) sa adresovať nedajú — pozičná cesta by pri
 * súbežnej zmene poľa trafila iný uzol alebo pole doplnila null-mi. Takým
 * dokumentom najprv doplníme id jedným zápisom chráneným cez updatedAt
 * (`ensureNodeIds`).
 */
const { v4: uuidv4 } = require('uuid');

const MAX_DEPTH = 10;
const hasId = (node) => typeof node?.id === 'string' && node.id.length > 0;

// Mapa uzol → reťaz krokov od koreňa dokumentu ([{ arr, id }]). `arr` je
// názov poľa: 'tasks' (úlohy kontaktu) alebo 'subtasks'.
const mapNodeChains = (nodes, arr, parentChain = [], map = new Map()) => {
  if (!Array.isArray(nodes)) return map;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !hasId(node)) continue;
    const chain = [...parentChain, { arr, id: node.id }];
    map.set(node, chain);
    mapNodeChains(node.subtasks, 'subtasks', chain, map);
  }
  return map;
};

// true ak niektorý uzol stromu nemá id (treba ensureNodeIds).
const treeMissingIds = (nodes, depth = 0) => {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return false;
  return nodes.some((node) => node && typeof node === 'object'
    && (!hasId(node) || treeMissingIds(node.subtasks, depth + 1)));
};

const assignMissingIds = (nodes) => {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (!hasId(node)) node.id = uuidv4();
    assignMissingIds(node.subtasks);
  }
};

/**
 * Doplní chýbajúce id v poli `field` ('subtasks' pre Task, 'tasks' pre
 * Contact). Číta celý aktuálny dokument (nie projekciu — zápis celého poľa
 * nesmie stratiť polia mimo projekcie) a zapisuje len ak sa od prečítania
 * nezmenil (updatedAt), inak dokument v tomto behu preskočí.
 * Vracia true, ak sú id po volaní kompletné.
 */
const ensureNodeIds = async (collection, docId, field) => {
  const fresh = await collection.findOne({ _id: docId });
  if (!fresh) return false;
  if (!treeMissingIds(fresh[field])) return true;
  assignMissingIds(fresh[field]);
  const result = await collection.updateOne(
    { _id: docId, updatedAt: fresh.updatedAt ?? null },
    { $set: { [field]: fresh[field] } }
  );
  return result.modifiedCount === 1;
};

const createNestedUpdate = () => {
  const $set = {};
  const $addToSet = {};
  const arrayFilters = [];
  const idents = new Map();

  const prefixFor = (chain) => {
    let prefix = '';
    for (const step of chain) {
      const key = `${prefix}${step.arr}#${step.id}`;
      let ident = idents.get(key);
      if (!ident) {
        ident = `n${idents.size}`;
        idents.set(key, ident);
        arrayFilters.push({ [`${ident}.id`]: step.id });
      }
      prefix += `${step.arr}.$[${ident}].`;
    }
    return prefix;
  };

  return {
    set(chain, field, value) {
      $set[prefixFor(chain) + field] = value;
    },
    // Pridá hodnoty do poľa. Ak pole v snapshote existuje, ale nie je pole
    // (null z legacy dát), $addToSet by celý update zhodil → $set zjednotenia.
    addToSet(chain, field, values, current) {
      const path = prefixFor(chain) + field;
      if (current === undefined || Array.isArray(current)) {
        const prev = $addToSet[path]?.$each || [];
        $addToSet[path] = { $each: [...new Set([...prev, ...values])] };
      } else {
        const prev = Array.isArray($set[path]) ? $set[path] : [];
        $set[path] = [...new Set([...prev, ...values])];
      }
    },
    isEmpty() {
      return Object.keys($set).length === 0 && Object.keys($addToSet).length === 0;
    },
    build() {
      const update = {};
      if (Object.keys($set).length) update.$set = $set;
      if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
      return { update, options: arrayFilters.length ? { arrayFilters } : {} };
    }
  };
};

// Inclusion projekcia polí, ktoré plánovač číta, pre všetky úrovne podúloh
// (bez description, files a ďalších veľkých polí).
const REMINDER_FIELDS = [
  'id', 'title', 'dueDate', 'dueTime', 'completed', 'assignedTo', 'reminder',
  'reminderSent', 'timeReminders', 'timeRemindersSent', 'lastUrgencyLevel'
];
const reminderProjection = (prefix = '') => {
  const projection = {};
  let level = prefix;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    for (const f of REMINDER_FIELDS) projection[`${level}${f}`] = 1;
    level += 'subtasks.';
  }
  // Najnižšia úroveň `subtasks` (pod MAX_DEPTH) sa nenačíta — sanitizer
  // hlbšie stromy neprijme.
  return projection;
};

module.exports = {
  mapNodeChains,
  treeMissingIds,
  ensureNodeIds,
  createNestedUpdate,
  reminderProjection,
  MAX_DEPTH
};
