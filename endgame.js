// Perfect-information endgame search for the 任務場 (mission) multiplier, used over sampled
// opponent hands (PIMC). Values are the landlord's coins for the rest of the game in units of
// (base x current multiplier): landlord wins +1.7*M (15% fee), loses -2*M, M = 2^(bombs from now)
// x (mission multiplier when the winning play is the mission's card type).
import { legalActions, moveType, T, subtract } from './engine.js';

export const MISSION_TYPES = {
  '單張': [T.SINGLE], '一對': [T.PAIR], '三張': [T.TRIPLE], '三帶一': [T.T31], '三帶二': [T.T32],
  '順子': [T.STRAIGHT], '連對': [T.PAIRS], '飛機': [T.PLANE, T.PLANE1, T.PLANE2],
  '飛機帶小翼': [T.PLANE1], '飛機帶大翼': [T.PLANE2], '炸彈': [T.BOMB], '火箭': [T.ROCKET], '四帶二': [T.F42, T.F422],
};

const ABORT = { abort: true };
const KICK = new Set([T.T31, T.T32, T.PLANE1, T.PLANE2, T.F42, T.F422]);
// Moves that differ only in their kickers: keep the two with the lowest kickers (kickers are the
// junk a player wants to shed; this keeps the search tractable with big hands).
function pruneKickers(moves) {
  const groups = new Map(), out = [];
  for (const m of moves) {
    const t = m.length >= 4 ? moveType(m) : null;
    if (!t || !KICK.has(t.type)) { out.push(m); continue; }
    const cnt = new Map(); for (const c of m) cnt.set(c, (cnt.get(c) || 0) + 1);
    const main = t.type === T.F42 || t.type === T.F422 ? 4 : 3;
    let kick = 0; for (const [c, n] of cnt) if (n < main) kick += c * n;
    const g = `${t.type}|${t.rank}|${t.len || 0}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ m, kick });
  }
  for (const list of groups.values()) { list.sort((a, b) => a.kick - b.kick); for (const x of list.slice(0, 2)) out.push(x.m); }
  return out;
}
const bombLike = (m) => { if (m.length !== 2 && m.length !== 4) return false; const t = moveType(m).type; return t === T.BOMB || t === T.ROCKET; };

export class Solver {
  constructor(mission, budget = Infinity, deadline = Infinity) {
    this.mission = mission; // { types: [T...], mult } or null
    this.budget = budget; this.deadline = deadline; this.nodes = 0; this.tt = new Map();
  }
  finish(m, turn) {
    const mt = this.mission && this.mission.types.includes(moveType(m).type) ? this.mission.mult : 1;
    return (turn === 0 ? 1.7 : -2) * (bombLike(m) ? 2 : 1) * mt;
  }
  // landlord's value with best play by both sides; hands: [landlord, down, up], sorted ascending
  search(hands, turn, rival, rivalBy, alpha = -Infinity, beta = Infinity) {
    if (++this.nodes > this.budget || ((this.nodes & 1023) === 0 && Date.now() > this.deadline)) throw ABORT;
    const k = hands[0].join(',') + '|' + hands[1].join(',') + '|' + hands[2].join(',') + '|' + turn + '|' + rival.join(',') + '|' + rivalBy;
    const e = this.tt.get(k);
    if (e) { if (e.f === 0) return e.v; if (e.f === 1 && e.v >= beta) return e.v; if (e.f === 2 && e.v <= alpha) return e.v; }
    const a0 = alpha, b0 = beta, maxi = turn === 0, hand = hands[turn];
    const moves = pruneKickers(legalActions(hand, rival));
    // going out first, then bigger plays
    moves.sort((x, y) => (y.length === hand.length) - (x.length === hand.length) || y.length - x.length);
    let best = maxi ? -Infinity : Infinity;
    for (const m of moves) {
      let v;
      if (m.length && m.length === hand.length) v = this.finish(m, turn);
      else {
        const f = m.length && bombLike(m) ? 2 : 1;
        const nh = hands.slice(); if (m.length) nh[turn] = subtract(hand, m);
        const nt = (turn + 1) % 3;
        let nr = rival, nb = rivalBy;
        if (m.length) { nr = m; nb = turn; }
        if (nt === nb) { nr = []; nb = -1; } // everyone else passed: the last player leads again
        v = f * this.search(nh, nt, nr, nb, alpha / f, beta / f);
      }
      if (maxi) { if (v > best) best = v; if (best > alpha) alpha = best; }
      else { if (v < best) best = v; if (best < beta) beta = best; }
      if (alpha >= beta) break;
    }
    this.tt.set(k, { v: best, f: best <= a0 ? 2 : best >= b0 ? 1 : 0 });
    return best;
  }
}

// value of each of my candidate moves, averaged over random deals of the unseen cards
// ctx: { me (0..2), hands: my hand, counts: {pos: n} for the other two, pool: unseen cards,
//        rival, rivalBy, candidates: [moves], mission, samples, budget (nodes per sample), rng }
export function pimc(ctx) {
  const { me, hand, counts, pool, rival, rivalBy, candidates, mission, samples = 12, budget = 40000, rng = Math.random, deadline = Infinity } = ctx;
  const others = [0, 1, 2].filter((p) => p !== me);
  if (others.some((p) => counts[p] == null) || counts[others[0]] + counts[others[1]] > pool.length) return null;
  const sum = candidates.map(() => 0), n = candidates.map(() => 0);
  let done = 0, aborted = 0;
  const toMine = (v) => (me === 0 ? v : v > 0 ? -v / 1.7 : -v * 0.425);
  for (let s = 0; s < samples; s++) {
    if (Date.now() > deadline) break;
    const p = pool.slice();
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    const hands = [null, null, null];
    hands[me] = hand.slice().sort((a, b) => a - b);
    hands[others[0]] = p.slice(0, counts[others[0]]).sort((a, b) => a - b);
    hands[others[1]] = p.slice(counts[others[0]], counts[others[0]] + counts[others[1]]).sort((a, b) => a - b);
    const solver = new Solver(mission, budget, deadline);
    const vals = [];
    try {
      for (const m of candidates) {
        let v;
        if (m.length && m.length === hand.length) v = solver.finish(m, me);
        else {
          const f = m.length && bombLike(m) ? 2 : 1;
          const nh = hands.slice(); if (m.length) nh[me] = subtract(hands[me], m);
          const nt = (me + 1) % 3;
          let nr = rival, nb = rivalBy;
          if (m.length) { nr = m; nb = me; }
          if (nt === nb) { nr = []; nb = -1; }
          v = f * solver.search(nh, nt, nr, nb);
        }
        vals.push(toMine(v));
      }
    } catch (err) { if (err === ABORT) { aborted++; continue; } throw err; }
    vals.forEach((v, i) => { sum[i] += v; n[i]++; });
    done++;
  }
  if (!done) return { done, aborted, ev: null };
  return { done, aborted, ev: sum.map((s, i) => s / n[i]) };
}

// Fewest plays to empty a hand (k), and fewest when one of them has to be the mission's card type (kT).
export function finishPlan(hand, types, memo = new Map()) {
  if (!hand.length) return { k: 0, kT: Infinity };
  const key = hand.join(',');
  const hit = memo.get(key); if (hit) return hit;
  const low = hand[0];
  let k = Infinity, kT = Infinity;
  for (const m of legalActions(hand, [])) {
    if (!m.includes(low)) continue; // every card is played some time: decide the lowest one's play first
    const r = finishPlan(subtract(hand, m), types, memo);
    const isT = types.includes(moveType(m).type);
    if (1 + r.k < k) k = 1 + r.k;
    const t = 1 + (isT ? r.k : r.kT);
    if (t < kT) kT = t;
  }
  const out = { k, kT };
  memo.set(key, out);
  return out;
}

// How often the winning play of a DouZero self-play game is of each type (filled in by the tracker
// from sim/final_types.json; a rough prior for "the other side finishes with the mission type").
export const FINISH_PRIOR = { default: 0.1, '單張': 0.523, '一對': 0.223, '三張': 0.04, '三帶一': 0.093, '三帶二': 0.05, '順子': 0.013, '連對': 0.003,
  '飛機': 0.003, '飛機帶小翼': 0.003, '飛機帶大翼': 0.003, '炸彈': 0.02, '火箭': 0.017, '四帶二': 0.013 }; // 300 self-play games

// Re-rank DouZero's moves for a 任務場 game (the winning side's last play of the mission's card
// type multiplies the stake).
// ctx: ranked (DouZero list, best first), hand, me (0 landlord, 1 down, 2 up), counts {pos: n},
//      pool (cards that could be in the other hands), rival, rivalBy, mission {word, types, mult},
//      m0 (2^bombs so far), rng, deadline (ms timestamp), maxTotal
export function missionRank(ctx) {
  const { ranked, hand, me, counts, pool, rival, rivalBy, mission, m0 = 1, rng = Math.random, deadline = Date.now() + 1000, maxTotal = 16 } = ctx;
  if (!ranked.length || !mission) return null;
  const N = mission.mult, types = mission.types;
  const ev0 = (r) => (r.ev != null ? r.ev : m0 * (0.85 * r.winProb - (1 - r.winProb)));
  const others = [0, 1, 2].filter((p) => p !== me);
  const total = hand.length + others.reduce((a, p) => a + (counts[p] || 0), 0);
  // 1) small endgame: solve sampled deals exactly, mission multiplier included
  if (others.every((p) => counts[p] > 0) && total <= maxTotal) {
    const cand = ranked.slice(0, 10);
    const res = pimc({ me, hand, counts, pool, rival, rivalBy, candidates: cand.map((r) => r.move), mission, samples: 16, budget: 40000, rng, deadline });
    if (res && res.ev && res.done >= 4) {
      const unit = (v) => (me === 0 ? v / 2 : v) * m0; // landlord coins are double the per-unit figure
      const out = cand.map((r, i) => Object.assign({}, r, { missionEv: unit(res.ev[i]) }));
      const top = out[0];
      out.sort((a, b) => b.missionEv - a.missionEv);
      // keep DouZero's choice unless the search finds something clearly better
      if (out[0] !== top && out[0].missionEv - top.missionEv < 0.05 * m0) { out.splice(out.indexOf(top), 1); out.unshift(top); }
      return { how: 'search', ranked: out.concat(ranked.slice(10)), samples: res.done };
    }
  }
  // 2) bigger positions: can I still end with the mission type after this move?
  const prior = FINISH_PRIOR[mission.word] ?? FINISH_PRIOR.default;
  const mine = me === 0 ? 1 : 0.5; // a farmer's side also wins through the partner
  const memo = new Map();
  const qOf = (m) => {
    if (m.length && m.length === hand.length) return types.includes(moveType(m).type) ? 1 : 0;
    const R = m.length ? subtract(hand, m) : hand;
    if (R.length > 12) return prior;
    const p = finishPlan(R, types, memo);
    if (p.kT === Infinity) return 0;
    if (p.kT === 1) return 0.8;
    if (p.kT === p.k) return 0.6;
    if (p.kT === p.k + 1) return 0.35;
    return 0.15;
  };
  const top = ranked.slice(0, 8).map((r) => {
    const q = qOf(r.move) * mine + prior * (1 - mine);
    const P = r.winProb;
    const missionEv = ev0(r) + (N - 1) * m0 * (P * 0.85 * q - (1 - P) * prior);
    return Object.assign({}, r, { missionEv, finishT: q });
  });
  const first = top[0];
  top.sort((a, b) => b.missionEv - a.missionEv);
  if (top[0] !== first && top[0].missionEv - first.missionEv < 0.05 * m0) { top.splice(top.indexOf(first), 1); top.unshift(first); }
  return { how: 'plan', ranked: top.concat(ranked.slice(8)) };
}
