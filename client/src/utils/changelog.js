import { isIosNativeApp } from './platform';

/**
 * Centrálny register noviniek („Čo je nové").
 *
 * Ako pridať novinku po ďalšej zmene:
 *  1. Pridaj NOVÝ objekt na ZAČIATOK poľa s `v` o 1 vyšším než doterajšie
 *     maximum. Pole je zoradené od najnovšej.
 *  2. `sections` = na ktorých stránkach sa novinka zobrazí v otázniku (?):
 *     'dashboard' | 'crm' | 'tasks' | 'messages'.
 *  3. Hotovo — používateľom sa pri najbližšom prihlásení automaticky ukáže
 *     okno „Čo je nové" na hlavnej stránke (/app), na dotknutých stránkach
 *     sa rozsvieti bodka na otázniku a novinka pribudne v jeho sekcii Novinky.
 *
 * `hideOnIos: true` skryje položku v iOS shelle (Apple guidelines — ceny,
 * odkazy na store a pod.), rovnako ako pri tipoch HelpGuide.
 */
export const CHANGELOG = [
  {
    v: 11,
    date: '2026-07-20',
    sections: ['tasks', 'dashboard'],
    icon: '👤',
    title: 'Nový pohľad „Moje úlohy"',
    description: 'Na stránke Projekty pribudlo tlačidlo 👤 — plochý zoznam všetkých projektov a úloh pridelených práve vám naprieč celým prostredím, zoskupený podľa termínov (Po termíne, Dnes, Najbližších 7 dní…). Úlohy odbavíte checkboxom priamo v zozname a klik na riadok vás prenesie na úlohu v projekte. Rýchly vstup: dlaždica „Moje úlohy" na Dashboarde.'
  },
  {
    v: 10,
    date: '2026-07-10',
    sections: ['tasks', 'crm'],
    icon: '📤',
    title: 'Kopírovanie a presun úloh medzi kontaktmi',
    description: 'Projekt, úlohu alebo podúlohu teraz skopírujete alebo presuniete do projektov iného kontaktu — tlačidlom 📤 pri riadku projektu či úlohy na stránke Projekty. V dvoch krokoch vyberiete kontakt a cieľový projekt (alebo „ako nový projekt"). Prílohy, termíny aj priradenia sa prenesú spolu.'
  },
  {
    v: 9,
    date: '2026-07-10',
    sections: ['tasks'],
    icon: '📌',
    title: 'Odkaz na originál pri kópiách',
    description: 'Každá kópia si pamätá, odkiaľ vznikla — v detaile uvidíte „📌 Skopírované z" a klik vás prenesie priamo na pôvodnú úlohu.'
  },
  {
    v: 8,
    date: '2026-07-09',
    sections: ['crm'],
    icon: '📋',
    title: 'Kopírovanie kontaktu do iného prostredia',
    description: 'Celý kontakt vrátane projektov, úloh, podúloh a príloh skopírujete do iného pracovného prostredia tlačidlom 📋 pri kontakte (zobrazí sa, keď máte viac prostredí). Originál ostáva nedotknutý.'
  },
  {
    v: 7,
    date: '2026-07-09',
    sections: ['dashboard'],
    icon: '🎨',
    title: 'Vlastné poradie a farby prostredí',
    description: 'V zozname prostredí si šípkami ▲▼ nastavíte vlastné poradie — je osobné, každý člen tímu môže mať iné. Paleta farieb prostredí sa rozšírila na 18 odtieňov.'
  },
  {
    v: 6,
    date: '2026-07-07',
    sections: ['tasks', 'crm'],
    icon: '🏁',
    title: 'Potvrdenie pred uzavretím projektu',
    description: 'Po dokončení poslednej úlohy sa projekt už nezatvorí automaticky — appka sa opýta, či ho chcete uzavrieť alebo nechať otvorený.'
  },
  {
    v: 5,
    date: '2026-07-07',
    sections: ['tasks', 'crm'],
    icon: '📅',
    title: 'Plynulejší výber dátumu a času',
    description: 'Kalendár a výber času sa otvoria na prvý klik a už „neblikajú" — platí všade, kde sa zadáva termín.'
  },
  {
    v: 4,
    date: '2026-07-04',
    sections: ['dashboard'],
    icon: '🔔',
    title: 'Spoľahlivejšie push notifikácie',
    description: 'Push notifikácie chodia pre všetky druhy upozornení (tímová aktivita, termíny, noví členovia) — jednotlivé druhy si vypnete v Nastaveniach notifikácií. Opravený aj odznak s číslom na ikone mobilnej appky.'
  },
  {
    v: 3,
    date: '2026-06-29',
    sections: ['dashboard'],
    icon: '💜',
    title: 'Nové logo a ikony',
    description: 'Appka dostala nové logo prpl s indigo-fialovým gradientom — nová ikona na ploche telefónu aj nový vzhľad na webe.'
  },
  {
    v: 2,
    date: '2026-06-03',
    sections: ['tasks', 'crm'],
    icon: '✏️',
    title: 'Premenovanie príloh',
    description: 'Súbor pomenujete už pri nahrávaní (užitočné pri fotkách z mobilu) a každú nahratú prílohu premenujete aj dodatočne cez ✏️ pri súbore.'
  },
  {
    v: 1,
    date: '2026-06-03',
    sections: ['dashboard'],
    icon: '🌅',
    title: 'Upozornenia na termíny ráno o 6:00',
    description: 'Pripomienky termínov bez konkrétneho času chodia ráno o 6:00 namiesto v noci. Pripomienky s presným časom naďalej chodia na minútu presne.'
  }
];

export const SECTION_LABELS = {
  dashboard: 'Dashboard',
  crm: 'Kontakty',
  tasks: 'Projekty',
  messages: 'Správy'
};

const SECTIONS = Object.keys(SECTION_LABELS);
const LATEST_V = CHANGELOG.reduce((max, n) => Math.max(max, n.v), 0);

// Stav „videné" per používateľ (localStorage — per zariadenie + účet):
// { modal: <v>, sections: { tasks: <v>, ... } }
const storageKey = (userId) => `prplNewsSeen:${userId || 'anon'}`;

const readState = (userId) => {
  try {
    return JSON.parse(localStorage.getItem(storageKey(userId))) || {};
  } catch {
    return {};
  }
};

const writeState = (userId, state) => {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch { /* private mode / plné úložisko — novinky sa ukážu znova, nič sa nerozbije */ }
};

const isVisible = (n) => !(n.hideOnIos && isIosNativeApp());

/** Novinky pre sekciu otáznika (max 8 najnovších, iOS filter). */
export const newsForSection = (section) =>
  CHANGELOG.filter(n => n.sections.includes(section) && isVisible(n)).slice(0, 8);

/** Novinky, ktoré používateľ ešte nevidel v okne „Čo je nové". */
export const getUnseenModalNews = (userId) => {
  const seenV = readState(userId).modal || 0;
  return CHANGELOG.filter(n => n.v > seenV && isVisible(n));
};

/** Má sekcia otáznika nevidené novinky? (červená bodka na ?) */
export const hasUnseenSectionNews = (userId, section) => {
  const state = readState(userId);
  const seenV = (state.sections && state.sections[section]) || 0;
  return CHANGELOG.some(n => n.v > seenV && n.sections.includes(section) && isVisible(n));
};

/** Otvorenie otáznika na stránke = novinky tej sekcie videné. */
export const markSectionNewsSeen = (userId, section) => {
  if (!section) return;
  const state = readState(userId);
  state.sections = { ...(state.sections || {}), [section]: LATEST_V };
  writeState(userId, state);
};

/** Zavretie okna „Čo je nové" = všetko videné (modal aj bodky na stránkach). */
export const markAllNewsSeen = (userId) => {
  writeState(userId, {
    modal: LATEST_V,
    sections: SECTIONS.reduce((acc, s) => ({ ...acc, [s]: LATEST_V }), {})
  });
};

/** '2026-07-10' → '10. 7. 2026' */
export const formatNewsDate = (iso) => {
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};
