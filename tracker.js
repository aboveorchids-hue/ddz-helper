// Turns a series of "my turn" screenshots into DouZero game state + advice.
// Robust to single misread cards: hand size, the green card-count bubbles and the last
// advice are used to reconcile what each player actually played.
import { legalActions, moveType, T, subtract, containsAll, fullDeck, LABEL, POSITIONS } from './engine.js';
import { readScreenshot } from './vision.js?v=h1';
import { missionRank, MISSION_TYPES } from './endgame.js?v=h1';

export const RANK_OF = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14, '2': 17, '小王': 20, '大王': 30 };
const asc = (a) => a.slice().sort((x, y) => x - y);
const key = (m) => asc(m).join(',');
const fmt = (m) => (m.length ? asc(m).reverse().map((c) => LABEL[c]).join(' ') : '不出');

// seat of each position for a given landlord seat. Play order: me -> right -> left -> me
function seatMap(landlordSeat) {
  if (landlordSeat === 'me') return { me: 'landlord', right: 'landlord_down', left: 'landlord_up' };
  if (landlordSeat === 'right') return { right: 'landlord', left: 'landlord_down', me: 'landlord_up' };
  return { left: 'landlord', me: 'landlord_down', right: 'landlord_up' };
}

// Every real rank glyph in the hand has the same height; the top of a joker column is a
// small letter ("J") or a fused block ("JO") with more letters stacked below it.
function jokerLabel(g, medianH, isHand) {
  if (!isHand) return null;
  const small = g.h < medianH * 0.85 && g.below >= 1;                        // lone "J" letter
  const odd = g.dist > 0.06 && g.below >= 2 && g.h < medianH * 1.25;          // fused "JO" block: matches no rank
  if (small || odd) return g.red ? '大王' : '小王';
  return null;
}

function glyphsToCards(gl, templates, k = 3, isHand = false) {
  const hs = gl.filter((g) => !g.joker).map((g) => g.h).sort((a, b) => a - b);
  const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  let leading = true; // jokers are always the leftmost cards of the hand
  return gl.map((g) => {
    const j = g.joker || (leading ? jokerLabel(g, med, isHand) : null);
    if (!j) leading = false;
    if (j) return { best: RANK_OF[j], alts: [RANK_OF[j]], dist: 0 };
    const scored = templates.filter((t) => t.vec.length === g.vec.length).map((t) => {
      let d = 0; for (let i = 0; i < t.vec.length; i++) { const e = g.vec[i] - t.vec[i]; d += e * e; }
      return { label: t.label, d: d / t.vec.length + 0.5 * (g.aspect - t.aspect) ** 2 };
    }).sort((a, b) => a.d - b.d);
    const alts = [];
    for (const s of scored) { const r = RANK_OF[s.label]; if (!alts.includes(r)) alts.push(r); if (alts.length >= k) break; }
    return { best: alts[0], alts, dist: scored[0] ? scored[0].d : 1 };
  });
}

// 太空梭 (this game's rule): 2+ consecutive bombs (no 2), optionally + 2x groups singles or pairs.
// It is a normal card type: any bomb or the rocket beats it. DouZero does not know it.
export function shuttleInfo(m) {
  if (m.length < 8) return null;
  const cnt = new Map(); for (const c of m) cnt.set(c, (cnt.get(c) || 0) + 1);
  const fours = [...cnt].filter(([, n]) => n === 4).map(([c]) => c).sort((a, b) => a - b);
  for (let len = fours.length; len >= 2; len--) for (let i = 0; i + len <= fours.length; i++) {
    const run = fours.slice(i, i + len);
    if (run[len - 1] - run[0] !== len - 1 || run.some((c) => c >= 17)) continue;
    const rest = m.length - 4 * len;
    const others = [...cnt].filter(([c]) => !run.includes(c));
    if (rest === 0) return { groups: len, rank: run[0], wings: 0 };
    if (rest === 2 * len) return { groups: len, rank: run[0], wings: 1 };
    if (rest === 4 * len && others.every(([, n]) => n % 2 === 0)) return { groups: len, rank: run[0], wings: 2 };
  }
  return null;
}

function isLegal(m, rival) {
  const sh = shuttleInfo(m);
  if (sh && sh.wings > 0) {
    if (!rival.length) return true;
    const rs = shuttleInfo(rival);
    return !!rs && rs.groups === sh.groups && rs.wings === sh.wings && sh.rank > rs.rank;
  }
  if (!m.length) return rival.length > 0;
  if (moveType(m).type === T.WRONG) return false;
  if (!rival.length) return true;
  const k = key(m);
  return legalActions(m, rival).some((a) => key(a) === k);
}

// Choose labels for an opponent's play. `want` = number of cards they played according to the
// card-count bubble (or null). Prefers the best-scoring combination that is legal and possible.
function resolvePlay(cards, rival, unseen, want) {
  let cs = cards.slice();
  const notes = [];
  if (want != null && want > 0 && want !== cs.length) {
    const ranks = new Set(cs.map((c) => c.best));
    if (want > cs.length && ranks.size === 1 && want <= 4) {
      // overlapping cards of the same rank (pair / triple / bomb) where a corner was hidden
      while (cs.length < want) cs.push(cs[0]);
      notes.push('fill');
    } else if (want < cs.length) {
      // drop the least confident extra glyphs
      cs = cs.map((c, i) => ({ c, i })).sort((a, b) => a.c.dist - b.c.dist).slice(0, want).sort((a, b) => a.i - b.i).map((x) => x.c);
      notes.push('trim');
    }
  }
  const best = cs.map((c) => c.best);
  const ok = (m) => containsAll(unseen, m) && isLegal(m, rival);
  if (ok(best)) return { move: best, notes };
  const tries = [];
  for (let i = 0; i < cs.length; i++) for (const a of cs[i].alts.slice(1)) { const m = best.slice(); m[i] = a; tries.push(m); }
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++)
    for (const a of cs[i].alts.slice(1)) for (const b of cs[j].alts.slice(1)) { const m = best.slice(); m[i] = a; m[j] = b; tries.push(m); }
  const allAlts = new Set(cs.flatMap((c) => c.alts));
  for (const a of allAlts) tries.push(Array(cs.length).fill(a));
  for (const m of tries) if (ok(m)) return { move: m, notes: notes.concat('fixed') };
  return { move: best, notes, invalid: true };
}

export class Tracker {
  constructor(agent, templates, opts = {}) {
    this.agent = agent;
    this.templates = templates;
    this.missionTpl = opts.missionTpl || null;
    this.handT = templates.filter((t) => t.size === 'hand');
    this.tableT = templates.filter((t) => t.size === 'table');
    this.reset();
  }
  reset() { this.game = null; }

  // Advice for one screenshot (ImageData-like)
  process(img, preRec = null) {
    const rec = preRec || readScreenshot(img, this.templates, false, this.missionTpl);
    if (!rec.ok) return { kind: 'error', message: rec.error };
    let handCards = glyphsToCards(rec.handGlyphs, this.handT, 3, true);
    const warnings = [];
    // the card-count bubble next to my avatar is the authority on how many cards I hold:
    // drop the worst-matching extra glyphs (shadows, edge artefacts)
    const meCnt = rec.counts && rec.counts.me && rec.counts.me.value != null && rec.counts.me.dist < 0.06 ? rec.counts.me.value : null;
    if (meCnt != null && meCnt > 0 && handCards.length > meCnt) {
      const extra = handCards.length - meCnt;
      const order = handCards.map((c, i) => ({ i, d: c.dist })).filter((x) => x.d > 0.02).sort((a, b) => b.d - a.d).slice(0, extra).map((x) => x.i);
      if (order.length === extra) handCards = handCards.filter((c, i) => !order.includes(i));
    }
    const hand = handCards.map((c) => c.best);
    const cnt = {}; for (const c of hand) cnt[c] = (cnt[c] || 0) + 1;
    for (const [r, n] of Object.entries(cnt)) if (n > (r >= 20 ? 1 : 4)) warnings.push(`辨識到 ${n} 張 ${LABEL[r]}，可能認錯`);
    if (handCards.some((c) => c.dist > 0.03)) warnings.push('有幾張手牌辨識信心偏低，請核對下方手牌');

    const counts = this.readCounts(rec);
    if (counts.me != null && counts.me !== hand.length) warnings.push(`手牌辨識到 ${hand.length} 張，但你的剩餘張數顯示 ${counts.me} 張`);

    const myTurn = rec.myTimer > 0.15 || rec.buttons.length >= 2;
    if (!myTurn) return { kind: 'wait', message: '目前看起來不是你的回合（你旁邊沒有倒數計時）', hand, rec };
    const phase = rec.bottom.state === 'down' ? 'bid' : rec.bottom.state === 'up' ? 'play'
      : (rec.buttons.length === 2 && hand.length <= 17 ? 'bid' : 'play');
    if (phase === 'bid') return this.bid(hand, warnings, rec);
    return this.play(rec, hand, counts, warnings);
  }

  // card-count bubbles -> numbers (null when unreadable / implausible)
  readCounts(rec) {
    const out = {};
    for (const s of ['left', 'right', 'me']) {
      const c = rec.counts && rec.counts[s];
      out[s] = c && c.value != null && c.value >= 0 && c.value <= 20 && c.dist < 0.06 ? c.value : null;
    }
    return out;
  }

  bid(hand, warnings, rec) {
    if (hand.length !== 17) warnings.push(`手牌辨識到 ${hand.length} 張（叫地主時應為 17 張）`);
    const h17 = hand.slice(0, 17);
    const kind = rec.bidKind || 'call';
    // deterministic sampling (same hand -> same answer)
    let seed = h17.reduce((a, c) => (a * 31 + c) >>> 0, 7);
    const rng = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pL = this.agent.landlordWinProb(h17, 10, rng);
    const farm = this.farmerOutlook(h17, kind, rng, 8);
    // expected coins in units of (base score x current multiplier); 15% is taken from winnings.
    // landlord: wins or loses double (against both farmers); robbing doubles the multiplier again.
    const evTake = (kind === 'rob' ? 2 : 1) * 2 * (0.85 * pL - (1 - pL));
    const evPass = farm.pTake * (0.85 * farm.pF - (1 - farm.pF));
    const take = evTake > evPass;
    this.game = null; // a new game starts after bidding
    const verb = kind === 'rob' ? ['搶地主', '不搶'] : ['叫地主', '不叫'];
    const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    const mission = rec.mission && rec.mission.ok ? { word: rec.mission.word, mult: rec.mission.mult } : null;
    return {
      kind: 'bid', take, winProb: pL, hand, warnings, rec, bidKind: kind, evTake, evPass, pF: farm.pF, mission,
      message: take ? verb[0] : verb[1],
      detail: `${verb[0]}：當地主勝率約 ${(pL * 100).toFixed(0)}%，期望 ${f(evTake)}　｜　${verb[1]}：當農民勝率約 ${(farm.pF * 100).toFixed(0)}%，期望 ${f(evPass)}` +
        `（單位：底分×目前倍數，已扣 15% 抽成${kind === 'rob' ? '；搶了倍數 ×2，叫地主的人還能再搶回去，那樣倍數再 ×2、你當農民' : ''}）`,
    };
  }

  // If I do not take the landlord: simulate deals where an opponent becomes landlord and
  // evaluate my hand as a farmer after the landlord's (and partner's) first move.
  farmerOutlook(h17, kind, rng, samples) {
    const pool = subtract(fullDeck(), h17);
    const strength = (h) => {
      const c = {}; for (const x of h) c[x] = (c[x] || 0) + 1;
      let s = 2 * (c[17] || 0) + (c[14] || 0) + (c[20] ? 3 : 0) + (c[30] ? 4 : 0) + (c[20] && c[30] ? 3 : 0);
      for (const [r, n] of Object.entries(c)) if (n === 4) s += 5;
      return s;
    };
    let taken = 0, sumP = 0;
    for (let k = 0; k < samples; k++) {
      const p = pool.slice();
      for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      const A = p.slice(0, 17), B = p.slice(17, 34), bottom = p.slice(34, 37);
      const sA = strength(A), sB = strength(B);
      if (kind === 'call' && Math.max(sA, sB) < 5) continue; // nobody would call: redeal (worth 0)
      const L = (sA >= sB ? A : B).concat(bottom), F = sA >= sB ? B : A;
      taken++;
      const me = rng() < 0.5 ? 'landlord_down' : 'landlord_up';
      const seq = [this.agent.rank({ myPos: 'landlord', hand: L, seq: [], wpOnly: true })[0].move];
      if (me === 'landlord_up') seq.push(this.agent.rank({ myPos: 'landlord_down', hand: F, seq, wpOnly: true })[0].move);
      sumP += this.agent.rank({ myPos: me, hand: h17, seq, wpOnly: true }).reduce((a, x) => Math.max(a, x.winProb), 0);
    }
    return { pTake: taken / samples, pF: taken ? sumP / taken : 0.5 };
  }

  // landlord seat: the 地主 badge; otherwise card counts (landlord started with 20)
  landlordSeat(rec, hand, counts, vis) {
    const seats = Object.entries(rec.badge).sort((x, y) => y[1] - x[1]);
    const [bestS, best] = seats[0], second = seats[1][1];
    if (best > 0.012 && best > second * 2.5) return { seat: bestS, how: 'badge' };
    // blurry / small screenshots: a faint badge still counts when the other seats show nothing
    if (best > 0.003 && best > second * 3 && second < 0.002) return { seat: bestS, how: 'badge-weak' };
    if (hand.length === 20 || counts.me === 20) return { seat: 'me', how: 'count' };
    for (const s of ['left', 'right']) {
      const n = counts[s];
      const shown = Array.isArray(vis[s]) ? vis[s].length : 0;
      if (n != null && n + shown === 20) return { seat: s, how: 'count' };
    }
    return null;
  }

  play(rec, hand, counts, warnings) {
    const raw = {
      left: rec.leftPass ? 'pass' : rec.leftGlyphs.length ? glyphsToCards(rec.leftGlyphs, this.tableT) : 'empty',
      right: rec.rightPass ? 'pass' : rec.rightGlyphs.length ? glyphsToCards(rec.rightGlyphs, this.tableT) : 'empty',
    };
    let g = this.game;
    const ls = this.landlordSeat(rec, hand, counts, raw);
    let seat = ls ? ls.seat : null;
    // hand and card counts can only shrink inside one game; both opponents' counts going up = new deal
    const up = (s) => g && g.counts && g.counts[s] != null && counts[s] != null && counts[s] > g.counts[s];
    // a weak badge reading never overrides the landlord of a game in progress
    if (g && ls && ls.how !== 'badge' && seat !== g.landlordSeat && hand.length <= g.hand.length) seat = g.landlordSeat;
    let newGame = !g || hand.length > g.hand.length || (seat && seat !== g.landlordSeat) || (up('left') && up('right'));
    if (!seat) {
      if (g && !newGame) seat = g.landlordSeat;
      else return { kind: 'error', message: '認不出誰是地主（找不到「地主」標記，張數也無法判斷）', hand, rec };
    }
    const pos = seatMap(seat);

    // duplicate screenshot of the same turn: same hand, same table -> just repeat the advice
    const tableSig = JSON.stringify([raw.left === 'pass' || raw.left === 'empty' ? raw.left : raw.left.map((c) => c.best),
      raw.right === 'pass' || raw.right === 'empty' ? raw.right : raw.right.map((c) => c.best)]);
    if (g && !newGame && key(g.hand) === key(hand) && g.tableSig === tableSig && g.lastResult) {
      return Object.assign({}, g.lastResult, { rec, duplicate: true, warnings: ['這張看起來跟上一張是同一回合，建議不變'] });
    }

    let myAction = null;
    if (!newGame && g) {
      // a different deal with the same landlord seat: several cards appeared that were never in my hand
      if (subtract(hand, g.hand).length >= 3) newGame = true;
    }
    if (newGame) {
      g = this.game = { landlordSeat: seat, pos, seq: [], hand: hand.slice(), partial: false, counts: {}, lastAdvice: null };
      const full = pos.me === 'landlord' ? 20 : 17;
      // joining mid-game as landlord: my own last play is unknown (record a pass), then what the two
      // farmers have on the table now
      const midLandlord = pos.me === 'landlord' && hand.length < full;
      if (midLandlord) g.seq.push([]);
      const order = pos.me === 'landlord' ? (midLandlord ? ['right', 'left'] : []) : pos.me === 'landlord_down' ? ['left'] : ['right', 'left'];
      for (const s of order) g.seq.push(this.oppAction(raw[s], s, g, hand, null, warnings));
      if (hand.length < full) {
        g.partial = true;
        warnings.push('這局是從中途開始記牌的，之前出過的牌不知道，建議準確度會降低');
      }
    } else {
      myAction = this.inferMyAction(g, hand, warnings);
      g.seq.push(myAction);
      // a count reading is trusted only if it is close to what the history predicts
      // (a dropped "1" would be off by 10; a misread play is off by 1-2)
      const before = this.historyCounts(g.seq);
      const vis = (s) => (Array.isArray(raw[s]) ? raw[s].length : 0);
      const okNow = (s) => counts[s] != null && (g.partial || Math.abs(counts[s] - (before[pos[s]] - vis(s))) <= 3);
      const drop = (s) => {
        if (!okNow(s) || g.counts[s] == null) return null;
        const d = g.counts[s] - counts[s];
        return d >= 0 && d <= 20 ? d : null;
      };
      g.seq.push(this.oppAction(raw.right, 'right', g, hand, drop('right'), warnings));
      g.seq.push(this.oppAction(raw.left, 'left', g, hand, drop('left'), warnings));
    }
    {
      const after = this.historyCounts(g.seq);
      for (const s of ['left', 'right']) if (counts[s] != null && !g.partial && Math.abs(counts[s] - after[pos[s]]) > 3) counts[s] = null;
    }
    g.hand = hand.slice();
    g.counts = { left: counts.left, right: counts.right, me: hand.length };
    g.tableSig = tableSig;
    if (g.seq.length % 3 !== POSITIONS.indexOf(pos.me)) warnings.push('回合順序對不上，可能漏截了一輪');

    const state = { myPos: pos.me, hand, seq: g.seq.slice() };
    // card counts: trust the bubbles when readable (essential when the history is incomplete)
    const nl = {};
    for (const [s, p] of Object.entries(pos)) if (s !== 'me' && counts[s] != null && counts[s] > 0) nl[p] = counts[s];
    if (Object.keys(nl).length === 2) {
      state.numLeft = Object.assign({ [pos.me]: hand.length }, nl);
      const hist = this.historyCounts(g.seq);
      for (const [s, p] of Object.entries(pos)) if (s !== 'me' && !g.partial && hist[p] !== nl[p]) {
        warnings.push(`${s === 'left' ? '左家' : '右家'}剩 ${nl[p]} 張，但記牌推算是 ${hist[p]} 張，可能有一手牌認錯或漏截`);
      }
    }
    if (g.partial) {
      state.otherHand = subtract(subtract(fullDeck(), hand), g.seq.flat());
      state.wpOnly = true; // unknown history: the win-rate model is far more robust than ADP here
    }
    const rivalNow = this.lastMoveOf(g.seq);
    if (rivalNow.length && shuttleInfo(rivalNow)) {
      // a 太空梭 can only be beaten by a bomb or the rocket in this game (DouZero would call 33334444 a 四帶兩對)
      state.filter = (m) => !m.length || moveType(m).type === T.BOMB || moveType(m).type === T.ROCKET;
      warnings.push('對手出的是太空梭（連續炸彈），只能用炸彈或火箭壓');
    }
    let ranked;
    if (rec.noBeat && !rivalNow.length) {
      // the game says nothing in my hand beats the table, yet no opponent play was recognised
      warnings.push('遊戲顯示你要不起，但沒認到對手出的牌（可能被擋住或認錯），請照遊戲按「不出」');
      ranked = [{ move: [], winProb: null, ev: null }];
    } else {
      // 「您沒有更大的牌可以出」 on screen: the game only allows passing
      if (rec.noBeat) state.filter = (m) => !m.length;
      ranked = this.agent.rank(state);
      if (!ranked.length) ranked = [{ move: [], winProb: null, ev: null }];
    }
    // 任務場: the winning side's last play of the shown card type multiplies the stake
    const seen = rec.mission && rec.mission.ok && MISSION_TYPES[rec.mission.word] ? { word: rec.mission.word, types: MISSION_TYPES[rec.mission.word], mult: rec.mission.mult } : null;
    if (seen) g.mission = seen; // keep it for this game in case a later screenshot hides the banner
    const mi = seen || g.mission || null;
    let missionInfo = null;
    if (mi && !rec.noBeat && ranked.length > 1 && ranked[0].winProb != null) {
      const me = POSITIONS.indexOf(pos.me);
      const left = state.numLeft || (g.partial ? null : this.historyCounts(g.seq));
      const cnt = {};
      if (left) for (const p of [0, 1, 2]) if (p !== me) cnt[p] = left[POSITIONS[p]];
      const pool = subtract(subtract(fullDeck(), hand), g.seq.flat());
      const { rival, by } = this.rivalOf(g.seq);
      const bombs = g.seq.filter((m) => m.length && (moveType(m).type === T.BOMB || moveType(m).type === T.ROCKET)).length;
      const r = missionRank({ ranked, hand, me, counts: cnt, pool, rival, rivalBy: by, mission: mi, m0: 2 ** Math.min(bombs, 10), deadline: Date.now() + 1000 });
      if (r) {
        missionInfo = { word: mi.word, mult: mi.mult, how: r.how, changed: r.ranked[0].move.join() !== ranked[0].move.join(), plain: ranked[0].move };
        ranked = r.ranked;
      }
    } else if (mi) missionInfo = { word: mi.word, mult: mi.mult, how: null, changed: false };
    const best = ranked[0];
    g.lastAdvice = best ? best.move : null;
    const result = { kind: 'play', best, ranked: ranked.slice(0, 4), hand, warnings, rec, pos, counts, seq: g.seq.slice(), myAction, mission: missionInfo };
    g.lastResult = Object.assign({}, result, { rec: null });
    return result;
  }

  historyCounts(seq) {
    const n = { landlord: 20, landlord_down: 17, landlord_up: 17 };
    seq.forEach((m, i) => { n[POSITIONS[i % 3]] -= m.length; });
    return n;
  }

  // the play I have to beat and who made it (seq is in landlord, down, up order)
  rivalOf(seq) {
    const n = seq.length;
    if (n && seq[n - 1].length) return { rival: seq[n - 1], by: (n - 1) % 3 };
    if (n >= 2 && seq[n - 2].length) return { rival: seq[n - 2], by: (n - 2) % 3 };
    return { rival: [], by: -1 };
  }

  lastMoveOf(seq) {
    if (!seq.length) return [];
    return seq[seq.length - 1].length ? seq[seq.length - 1] : (seq[seq.length - 2] || []);
  }

  // What did I play since the last screenshot? Hand size tells how many cards; the last advice
  // and the cards that disappeared tell which. Robust to one or two misread cards.
  inferMyAction(g, hand, warnings) {
    const k = g.hand.length - hand.length;
    const gone = subtract(g.hand, hand);
    if (k <= 0) return [];
    const rival = this.lastMoveOf(g.seq);
    const adv = g.lastAdvice || [];
    // the cards that left my hand are the best evidence (I may not have followed the advice);
    // the advice only fills in when one card was misread and what disappeared is not a legal play
    if (gone.length === k && isLegal(gone, rival)) return asc(gone);
    if (adv.length === k && subtract(adv, gone).length <= 1 && isLegal(adv, rival)) return asc(adv);
    // choose the legal move of size k (from the previous hand) that best matches what disappeared
    let best = null, bestScore = -1;
    for (const m of legalActions(g.hand, rival)) {
      if (m.length !== k) continue;
      const score = (m.length - subtract(m, gone).length) * 2 + (m.length - subtract(m, adv).length);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    if (best) { if (key(best) !== key(gone)) warnings.push(`上一手你出的牌推定為 ${fmt(best)}`); return asc(best); }
    warnings.push('無法確定上一手你出了什麼，可能手牌認錯');
    return asc(gone.slice(0, k));
  }

  oppAction(rawSide, seat, g, myHand, want, warnings) {
    const name = seat === 'left' ? '左家' : '右家';
    if (rawSide === 'pass' || rawSide === 'empty') {
      if (want) warnings.push(`${name}的剩餘張數少了 ${want} 張，但桌上沒看到他出的牌`);
      return [];
    }
    const unseen = subtract(subtract(fullDeck(), myHand), g.seq.flat());
    const rival = this.lastMoveOf(g.seq);
    const r = resolvePlay(rawSide, rival, unseen, want);
    if (r.invalid) warnings.push(`${name}出的牌（${fmt(r.move)}）看起來不合規則，可能認錯`);
    if (want != null && want !== r.move.length) warnings.push(`${name}出的牌辨識到 ${r.move.length} 張，但他的剩餘張數少了 ${want} 張`);
    return asc(r.move);
  }
}
