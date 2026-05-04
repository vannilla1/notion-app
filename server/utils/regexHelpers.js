/**
 * Regex helpers — ochrana proti ReDoS (Regular Expression Denial of Service).
 *
 * Audit MED-002: niektoré endpointy dovolili user-controlled string priamo
 * v `$regex` Mongo query, čo umožňovalo poslať katastrofický pattern
 * (napr. `(a+)+`) ktorý drví CPU pri match-i nad neutralnym textom.
 * Aj pre admin-only endpointy je to nebezpečné — kompromitovaný admin
 * účet alebo session fixation by zahltil DB connection pool.
 *
 * `escapeRegex(str)` prevedie všetky regex meta-znaky na literálne, takže
 * zo `(a+)+` sa stane `\(a\+\)\+` — čistý substring match.
 *
 * Použitie:
 *   const safePattern = escapeRegex(req.query.search || '');
 *   { name: { $regex: safePattern, $options: 'i' } }
 *
 * Pre maxLength validáciu: vždy obmedz dĺžku search inputu na ~100 znakov,
 * aby ani escapnutý pattern nevytvoril zbytočne dlhý lineárny match.
 */

const REGEX_META_CHARS = /[.*+?^${}()|[\]\\]/g;

const escapeRegex = (str) => {
  if (str === null || str === undefined) return '';
  return String(str).replace(REGEX_META_CHARS, '\\$&');
};

module.exports = { escapeRegex };
