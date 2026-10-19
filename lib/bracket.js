// Pure bracket structure builders (no DB). Output: match "specs" linked by keys.
// spec = { key, stage, round, position, label, home, away, next:[key,'home'|'away']|null, lnext:[key,slot]|null, best_of }

const nextPow2 = n => { let s = 1; while (s < n) s *= 2; return s; };

// Standard seeding order: for 8 -> [1,8,4,5,2,7,3,6] so 1 and 2 can only meet in the final.
function seedOrder(size) { let o = [1]; while (o.length < size) { const n = o.length * 2; o = o.flatMap(s => [s, n + 1 - s]); } return o; }

// Places participants into the first round. Byes (nulls) always face the top seeds.
// pairing 'seeded': list is in seed order (1 = best). 'as_listed': list is a draw order (e.g. random pairing tool):
// consecutive entries meet each other; the first entries take the bye slots.
function firstRoundSlots(list, pairing = 'seeded') {
  const n = list.length; if (n < 2) throw Object.assign(new Error('Need at least 2 participants'), { status: 400 });
  const S = nextPow2(n), order = seedOrder(S), slots = new Array(S).fill(null);
  if (pairing === 'as_listed') {
    let k = 0;
    for (let m = 0; m < S / 2; m++) { const bye = order[2 * m] > n || order[2 * m + 1] > n; slots[2 * m] = list[k++]; slots[2 * m + 1] = bye ? null : list[k++]; }
  } else order.forEach((seed, i) => { slots[i] = seed <= n ? list[seed - 1] : null; });
  return slots;
}

function roundName(r, R) {
  if (r === R) return 'Final'; if (r === R - 1) return 'Semi-final'; if (r === R - 2) return 'Quarter-final';
  return `Round of ${2 ** (R - r + 1)}`;
}

function singleElim(slots, { bestOf = 1, finalBestOf, stage = 'winners', prefix = 'W' } = {}) {
  const S = slots.length, R = Math.log2(S), specs = [];
  for (let r = 1; r <= R; r++) {
    const count = S / 2 ** r;
    for (let p = 0; p < count; p++) specs.push({
      key: `${prefix}${r}-${p}`, stage, round: r, position: p, label: roundName(r, R),
      home: r === 1 ? slots[2 * p] : null, away: r === 1 ? slots[2 * p + 1] : null,
      next: r < R ? [`${prefix}${r + 1}-${Math.floor(p / 2)}`, p % 2 ? 'away' : 'home'] : null, lnext: null,
      best_of: r === R && finalBestOf ? finalBestOf : bestOf,
    });
  }
  return specs;
}

// Double elimination: winners bracket (k rounds), losers bracket (2(k-1) rounds), grand final + optional reset.
function doubleElim(slots, { bestOf = 1, finalBestOf } = {}) {
  const S = slots.length, k = Math.log2(S);
  if (S < 4) throw Object.assign(new Error('Double elimination needs at least 3 participants'), { status: 400 });
  const wb = singleElim(slots, { bestOf }), L = 2 * (k - 1), specs = [...wb];
  wb.forEach(m => { if (m.round === k) { m.label = 'Winners final'; m.next = ['GF', 'home']; } else if (m.label === 'Semi-final') m.label = 'Winners semi-final'; else m.label = 'Winners ' + m.label; });
  const cnt = j => S / 2 ** (Math.ceil(j / 2) + 1);
  for (let j = 1; j <= L; j++) for (let p = 0; p < cnt(j); p++) {
    let next;
    if (j === L) next = ['GF', 'away'];
    else if (j % 2 === 1) next = [`L${j + 1}-${p}`, 'home'];
    else next = [`L${j + 1}-${Math.floor(p / 2)}`, p % 2 ? 'away' : 'home'];
    specs.push({ key: `L${j}-${p}`, stage: 'losers', round: j, position: p, label: j === L ? 'Losers final' : `Losers round ${j}`, home: null, away: null, next, lnext: null, best_of: bestOf });
  }
  // Drop WB losers into the losers bracket (order flipped on alternate rounds to reduce early rematches).
  for (const m of wb) {
    if (m.round === 1) m.lnext = [`L1-${Math.floor(m.position / 2)}`, m.position % 2 ? 'away' : 'home'];
    else { const j = 2 * (m.round - 1), c = cnt(j), p = m.round % 2 === 0 ? c - 1 - m.position : m.position; m.lnext = [`L${j}-${p}`, 'away']; }
  }
  specs.push({ key: 'GF', stage: 'grand_final', round: 1, position: 0, label: 'Grand final', home: null, away: null, next: null, lnext: null, best_of: finalBestOf || bestOf });
  specs.push({ key: 'GFR', stage: 'grand_final_reset', round: 2, position: 0, label: 'Grand final — reset', home: null, away: null, next: null, lnext: null, best_of: finalBestOf || bestOf });
  return specs;
}

// Circle-method round robin. Returns [[homeId, awayId], ...] per matchday.
function roundRobin(ids) {
  const a = [...ids]; if (a.length % 2) a.push(null);
  const n = a.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) { const h = a[i], w = a[n - 1 - i]; if (h != null && w != null) pairs.push(r % 2 ? [w, h] : [h, w]); }
    rounds.push(pairs); a.splice(1, 0, a.pop());
  }
  return rounds;
}

module.exports = { nextPow2, seedOrder, firstRoundSlots, roundName, singleElim, doubleElim, roundRobin };
