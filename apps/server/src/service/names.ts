/**
 * Tolerant matching of passenger names from bookings against account names:
 * "LINDNER/JOERG MR" = "Jörg Lindner" = "Lindner, Jörg" = "Jorg Lindner".
 */

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mstr', 'mister', 'dr', 'prof', 'herr', 'frau', 'hr', 'fr', 'chd', 'inf', 'adt']);
const TITLE_SUFFIXES = ['mrs', 'mstr', 'miss', 'mr', 'ms'];

/** Two spellings per token: umlauts written out (ö → oe) and stripped (ö → o). */
function variants(name: string): [string[], string[]] {
  const lower = name.toLowerCase();
  const spelled = lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const tokens = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z]+/)
      .filter(Boolean)
      .filter((t) => !TITLES.has(t));
  return [tokens(spelled), tokens(lower)];
}

/** "JOERGMR" (title glued to the first name in some PNRs) → "joerg". */
function stripGluedTitle(token: string): string {
  for (const s of TITLE_SUFFIXES) if (token.length > s.length + 1 && token.endsWith(s)) return token.slice(0, -s.length);
  return token;
}

function tokenSet(tokens: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of tokens) {
    set.add(t);
    set.add(stripGluedTitle(t));
  }
  return set;
}

/** All tokens of the shorter name must appear in the longer one; at least two (first and last name), unless both are single words. */
export function namesMatch(passenger: string, account: string): boolean {
  const [pa, pb] = variants(passenger);
  const [aa, ab] = variants(account);
  for (const p of [pa, pb]) {
    for (const a of [aa, ab]) {
      if (!p.length || !a.length) continue;
      const pSet = tokenSet(p);
      const aSet = tokenSet(a);
      const [shorter, longerSet] = a.length <= p.length ? [a, pSet] : [p, aSet];
      if (shorter.length < 2 && !(p.length === 1 && a.length === 1)) continue;
      if (shorter.every((t) => longerSet.has(t) || longerSet.has(stripGluedTitle(t)))) return true;
    }
  }
  return false;
}

/** Users whose name matches one of the passengers. */
export function matchPassengers<U extends { id: string; name: string }>(passengers: string[], users: U[]): U[] {
  const hits = new Map<string, U>();
  for (const p of passengers) {
    if (!p?.trim()) continue;
    for (const u of users) if (namesMatch(p, u.name)) hits.set(u.id, u);
  }
  return [...hits.values()];
}
