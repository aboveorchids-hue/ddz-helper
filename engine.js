// 鬥地主 AI engine: a faithful JS port of DouZero (kwai/DouZero, Apache-2.0)
// rules, legal-move generation, feature encoding and the LSTM+MLP value network.
// Card codes follow DouZero: 3..14 (14 = A), 17 = 2, 20 = 小王, 30 = 大王.

export const ALL_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
export const LABEL = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 17: '2', 20: '小王', 30: '大王' };
export const POSITIONS = ['landlord', 'landlord_down', 'landlord_up'];
const COL = { 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, 11: 8, 12: 9, 13: 10, 14: 11, 17: 12 };

export function fullDeck() {
  const d = [];
  for (let r = 3; r <= 14; r++) for (let i = 0; i < 4; i++) d.push(r);
  for (let i = 0; i < 4; i++) d.push(17);
  d.push(20, 30);
  return d;
}

const sortAsc = (a) => a.slice().sort((x, y) => x - y);
const key = (m) => m.join(',');
function countOf(cards) {
  const c = new Map();
  for (const x of cards) c.set(x, (c.get(x) || 0) + 1);
  return c;
}
export function subtract(cards, remove) {
  const c = countOf(remove);
  const out = [];
  for (const x of cards) {
    const n = c.get(x) || 0;
    if (n > 0) c.set(x, n - 1); else out.push(x);
  }
  return out;
}
export function containsAll(cards, sub) {
  return subtract(cards, sub).length === cards.length - sub.length;
}
function combinations(arr, k) {
  const res = [], cur = [];
  (function rec(start) {
    if (cur.length === k) { res.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
  })(0);
  return res;
}
function isContinuous(m) {
  for (let i = 0; i < m.length - 1; i++) if (m[i + 1] - m[i] !== 1) return false;
  return true;
}

// ---------------- move types (move_detector.py) ----------------
export const T = { PASS: 0, SINGLE: 1, PAIR: 2, TRIPLE: 3, BOMB: 4, ROCKET: 5, T31: 6, T32: 7, STRAIGHT: 8, PAIRS: 9, PLANE: 10, PLANE1: 11, PLANE2: 12, F42: 13, F422: 14, WRONG: 15 };
export function moveType(moveIn) {
  const move = sortAsc(moveIn);
  const n = move.length;
  const md = countOf(move);
  if (n === 0) return { type: T.PASS };
  if (n === 1) return { type: T.SINGLE, rank: move[0] };
  if (n === 2) {
    if (move[0] === move[1]) return { type: T.PAIR, rank: move[0] };
    if (move[0] === 20 && move[1] === 30) return { type: T.ROCKET };
    return { type: T.WRONG };
  }
  if (n === 3) return md.size === 1 ? { type: T.TRIPLE, rank: move[0] } : { type: T.WRONG };
  if (n === 4) {
    if (md.size === 1) return { type: T.BOMB, rank: move[0] };
    if (md.size === 2) {
      if ((move[0] === move[1] && move[1] === move[2]) || (move[1] === move[2] && move[2] === move[3]))
        return { type: T.T31, rank: move[1] };
    }
    return { type: T.WRONG };
  }
  if (isContinuous(move)) return { type: T.STRAIGHT, rank: move[0], len: n };
  if (n === 5) return md.size === 2 ? { type: T.T32, rank: move[2] } : { type: T.WRONG };
  const cd = new Map();
  for (const v of md.values()) cd.set(v, (cd.get(v) || 0) + 1);
  if (n === 6 && (md.size === 2 || md.size === 3) && cd.get(4) === 1 && (cd.get(2) === 1 || cd.get(1) === 2))
    return { type: T.F42, rank: move[2] };
  if (n === 8 && (((md.size === 3 || md.size === 2) && cd.get(4) === 1 && cd.get(2) === 2) || cd.get(4) === 2)) {
    let r = -1; for (const [c, v] of md) if (v === 4 && c > r) r = c;
    return { type: T.F422, rank: r };
  }
  const keys = [...md.keys()].sort((a, b) => a - b);
  if (md.size === cd.get(2) && isContinuous(keys)) return { type: T.PAIRS, rank: keys[0], len: keys.length };
  if (md.size === cd.get(3) && isContinuous(keys)) return { type: T.PLANE, rank: keys[0], len: keys.length };
  if ((cd.get(3) || 0) >= 2) {
    const s3 = [], single = [], pair = [];
    for (const [k, v] of md) {
      if (v === 3) s3.push(k); else if (v === 1) single.push(k); else if (v === 2) pair.push(k);
      else return { type: T.WRONG };
    }
    s3.sort((a, b) => a - b);
    if (isContinuous(s3)) {
      if (s3.length === single.length + pair.length * 2) return { type: T.PLANE1, rank: s3[0], len: s3.length };
      if (s3.length === pair.length && md.size === s3.length * 2) return { type: T.PLANE2, rank: s3[0], len: s3.length };
    }
    if (s3.length === 4) {
      if (isContinuous(s3.slice(1))) return { type: T.PLANE1, rank: s3[1], len: 3 };
      if (isContinuous(s3.slice(0, 3))) return { type: T.PLANE1, rank: s3[0], len: 3 };
    }
  }
  return { type: T.WRONG };
}

// ---------------- move generation (move_generator.py) ----------------
class MovesGen {
  constructor(cards) {
    this.cards = cards.slice();
    this.cd = countOf(cards);
  }
  serial(cards, minSerial, repeat, repeatNum) {
    if (repeatNum < minSerial) repeatNum = 0;
    const s = [...new Set(cards)].sort((a, b) => a - b);
    const recs = [];
    let start = 0, i = 0, longest = 1;
    while (i < s.length) {
      if (i + 1 < s.length && s[i + 1] - s[i] === 1) { longest++; i++; }
      else { recs.push([start, longest]); i++; start = i; longest = 1; }
    }
    const moves = [];
    const rep = (arr) => sortAsc(arr.flatMap((x) => Array(repeat).fill(x)));
    for (const [st, lg] of recs) {
      if (lg < minSerial) continue;
      const L = s.slice(st, st + lg);
      if (repeatNum === 0) {
        for (let steps = minSerial; steps <= lg; steps++)
          for (let idx = 0; steps + idx <= lg; idx++) moves.push(rep(L.slice(idx, idx + steps)));
      } else {
        if (lg < repeatNum) continue;
        for (let idx = 0; idx + repeatNum <= lg; idx++) moves.push(rep(L.slice(idx, idx + repeatNum)));
      }
    }
    return moves;
  }
  single() { return [...new Set(this.cards)].map((x) => [x]); }
  pair() { const r = []; for (const [k, v] of this.cd) if (v >= 2) r.push([k, k]); return r; }
  triple() { const r = []; for (const [k, v] of this.cd) if (v >= 3) r.push([k, k, k]); return r; }
  bomb() { const r = []; for (const [k, v] of this.cd) if (v === 4) r.push([k, k, k, k]); return r; }
  rocket() { return this.cd.has(20) && this.cd.has(30) ? [[20, 30]] : []; }
  t31() { const r = []; for (const t of this.single()) for (const tr of this.triple()) if (t[0] !== tr[0]) r.push(t.concat(tr)); return r; }
  t32() { const r = []; for (const t of this.pair()) for (const tr of this.triple()) if (t[0] !== tr[0]) r.push(t.concat(tr)); return r; }
  straight(n = 0) { return this.serial(this.cards, 5, 1, n); }
  pairs(n = 0) { const sp = []; for (const [k, v] of this.cd) if (v >= 2) sp.push(k); return this.serial(sp, 3, 2, n); }
  plane(n = 0) { const st = []; for (const [k, v] of this.cd) if (v >= 3) st.push(k); return this.serial(st, 2, 3, n); }
  plane1(n = 0) {
    const out = [];
    for (const s3 of this.plane(n)) {
      const set = new Set(s3);
      const rest = this.cards.filter((x) => !set.has(x));
      for (const sub of combinations(rest, set.size)) out.push(s3.concat(sub));
    }
    return out;
  }
  plane2(n = 0) {
    const out = [];
    const pairSet = []; for (const [k, v] of this.cd) if (v >= 2) pairSet.push(k);
    pairSet.sort((a, b) => a - b);
    for (const s3 of this.plane(n)) {
      const set = new Set(s3);
      const cand = pairSet.filter((x) => !set.has(x));
      for (const sub of combinations(cand, set.size)) out.push(sortAsc(s3.concat(sub, sub)));
    }
    return out;
  }
  f42() {
    const out = [];
    for (const [fc, v] of this.cd) {
      if (v !== 4) continue;
      const rest = this.cards.filter((k) => k !== fc);
      for (const sub of combinations(rest, 2)) out.push([fc, fc, fc, fc].concat(sub));
    }
    return out;
  }
  f422() {
    const out = [];
    for (const [fc, v] of this.cd) {
      if (v !== 4) continue;
      const rest = []; for (const [k, w] of this.cd) if (k !== fc && w >= 2) rest.push(k);
      for (const [a, b] of combinations(rest, 2)) out.push([fc, fc, fc, fc, a, a, b, b]);
    }
    return out;
  }
  all() {
    return [].concat(this.single(), this.pair(), this.triple(), this.bomb(), this.rocket(), this.t31(), this.t32(),
      this.straight(), this.pairs(), this.plane(), this.plane1(), this.plane2(), this.f42(), this.f422());
  }
}

const rankOfTriple = (m) => { let r = -1; for (const [k, v] of countOf(m)) if (v === 3 && k > r) r = k; return r; };
const rankOfFour = (m) => { let r = 0; for (const [k, v] of countOf(m)) if (v === 4) r = k; return r; };

// game.py get_legal_card_play_actions; returns de-duplicated, sorted moves ([] = 不出)
export function legalActions(hand, rivalMove) {
  const mg = new MovesGen(hand);
  const rt = moveType(rivalMove);
  const rv = sortAsc(rivalMove);
  const len = rt.len || 1;
  let moves = [];
  const gt = (sel) => (ms) => ms.filter((m) => sel(sortAsc(m)) > sel(rv));
  switch (rt.type) {
    case T.PASS: moves = mg.all(); break;
    case T.SINGLE: moves = gt((m) => m[0])(mg.single()); break;
    case T.PAIR: moves = gt((m) => m[0])(mg.pair()); break;
    case T.TRIPLE: moves = gt((m) => m[0])(mg.triple()); break;
    case T.BOMB: moves = gt((m) => m[0])(mg.bomb().concat(mg.rocket())); break;
    case T.ROCKET: moves = []; break;
    case T.T31: moves = gt((m) => m[1])(mg.t31()); break;
    case T.T32: moves = gt((m) => m[2])(mg.t32()); break;
    case T.STRAIGHT: moves = gt((m) => m[0])(mg.straight(len)); break;
    case T.PAIRS: moves = gt((m) => m[0])(mg.pairs(len)); break;
    case T.PLANE: moves = gt((m) => m[0])(mg.plane(len)); break;
    case T.PLANE1: moves = gt(rankOfTriple)(mg.plane1(len)); break;
    case T.PLANE2: moves = gt(rankOfTriple)(mg.plane2(len)); break;
    case T.F42: moves = gt((m) => m[2])(mg.f42()); break;
    case T.F422: moves = gt(rankOfFour)(mg.f422()); break;
    default: moves = [];
  }
  if (![T.PASS, T.BOMB, T.ROCKET].includes(rt.type)) moves = moves.concat(mg.bomb(), mg.rocket());
  if (rivalMove.length !== 0) moves.push([]);
  const seen = new Set(), out = [];
  for (const m of moves) { const s = sortAsc(m); const k = key(s); if (!seen.has(k)) { seen.add(k); out.push(s); } }
  return out;
}

export function isBomb(m) {
  const t = moveType(m).type;
  return t === T.BOMB || t === T.ROCKET;
}

// ---------------- features (env.py get_obs) ----------------
export function cards2array(cards, out = new Float32Array(54), off = 0) {
  out.fill(0, off, off + 54);
  for (const [c, n] of countOf(cards)) {
    if (c < 20) { const col = COL[c]; for (let r = 0; r < n; r++) out[off + col * 4 + r] = 1; }
    else if (c === 20) out[off + 52] = 1;
    else if (c === 30) out[off + 53] = 1;
  }
  return out;
}
function oneHot(n, size) { const a = new Float32Array(size); if (n >= 1 && n <= size) a[n - 1] = 1; return a; }
function bombHot(n) { const a = new Float32Array(15); a[Math.min(n, 14)] = 1; return a; }
function concat(parts) {
  let L = 0; for (const p of parts) L += p.length;
  const o = new Float32Array(L); let i = 0;
  for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}

// Derive a DouZero infoset from the action sequence.
// state: { myPos, hand, seq } where seq[i] was played by POSITIONS[i % 3]
export function buildInfoset(state) {
  const { myPos, hand, seq } = state;
  const played = { landlord: [], landlord_down: [], landlord_up: [] };
  const lastMoveDict = { landlord: [], landlord_down: [], landlord_up: [] };
  let bombNum = 0;
  seq.forEach((m, i) => {
    const p = POSITIONS[i % 3];
    played[p] = played[p].concat(m);
    lastMoveDict[p] = m.slice();
    if (m.length && isBomb(m)) bombNum++;
  });
  const numLeft = state.numLeft || {
    landlord: 20 - played.landlord.length,
    landlord_down: 17 - played.landlord_down.length,
    landlord_up: 17 - played.landlord_up.length,
  };
  numLeft[myPos] = hand.length;
  let lastMove = [];
  if (seq.length) lastMove = seq[seq.length - 1].length === 0 ? (seq[seq.length - 2] || []) : seq[seq.length - 1];
  const allPlayed = [].concat(played.landlord, played.landlord_down, played.landlord_up);
  const other = state.otherHand || subtract(subtract(fullDeck(), hand), allPlayed);
  return { myPos, hand: sortAsc(hand), other: sortAsc(other), played, lastMoveDict, numLeft, bombNum, lastMove: sortAsc(lastMove), seq };
}

export function encode(info) {
  const a = (c) => cards2array(c);
  const p = info.myPos;
  let xna;
  if (p === 'landlord') {
    xna = concat([a(info.hand), a(info.other), a(info.lastMove), a(info.played.landlord_up), a(info.played.landlord_down),
      oneHot(info.numLeft.landlord_up, 17), oneHot(info.numLeft.landlord_down, 17), bombHot(info.bombNum)]);
  } else {
    const mate = p === 'landlord_up' ? 'landlord_down' : 'landlord_up';
    xna = concat([a(info.hand), a(info.other), a(info.played.landlord), a(info.played[mate]), a(info.lastMove),
      a(info.lastMoveDict.landlord), a(info.lastMoveDict[mate]), oneHot(info.numLeft.landlord, 20), oneHot(info.numLeft[mate], 17), bombHot(info.bombNum)]);
  }
  // z: last 15 moves, padded at the front with passes, reshaped 5 x 162
  const seq = info.seq.slice(-15);
  const padded = Array(15 - seq.length).fill([]).concat(seq);
  const z = new Float32Array(15 * 54);
  padded.forEach((m, i) => cards2array(m, z, i * 54));
  return { xna, z };
}

// ---------------- network ----------------
function f16ToF32(u16) {
  const out = new Float32Array(u16.length);
  const tbl = new Float32Array(1), ib = new Uint32Array(tbl.buffer);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) { out[i] = (s ? -1 : 1) * m * 5.960464477539063e-8; continue; }
    if (e === 31) { ib[0] = s | 0x7f800000 | (m << 13); out[i] = tbl[0]; continue; }
    ib[0] = s | ((e + 112) << 23) | (m << 13);
    out[i] = tbl[0];
  }
  return out;
}

export class Net {
  constructor(t) { Object.assign(this, t); this.inDim = t.w1Shape[1]; }
  static fromBlob(manifest, buffer, pos) {
    const all = manifest.dtype === 'float16' ? f16ToF32(new Uint16Array(buffer)) : new Float32Array(buffer);
    const g = (k) => { const e = manifest.tensors[pos][k]; const n = e.shape.reduce((x, y) => x * y, 1); return all.subarray(e.offset, e.offset + n); };
    return new Net({
      wih: g('lstm.weight_ih_l0'), whh: g('lstm.weight_hh_l0'), bih: g('lstm.bias_ih_l0'), bhh: g('lstm.bias_hh_l0'),
      w: [1, 2, 3, 4, 5, 6].map((i) => g(`dense${i}.weight`)), b: [1, 2, 3, 4, 5, 6].map((i) => g(`dense${i}.bias`)),
      w1Shape: manifest.tensors[pos]['dense1.weight'].shape,
    });
  }
  lstm(z) {
    const H = 128, h = new Float32Array(H), c = new Float32Array(H), g = new Float32Array(4 * H);
    const sig = (x) => 1 / (1 + Math.exp(-x));
    for (let t = 0; t < 5; t++) {
      const xo = t * 162;
      for (let j = 0; j < 4 * H; j++) {
        let s = this.bih[j] + this.bhh[j];
        const ri = j * 162, rh = j * H;
        for (let k = 0; k < 162; k++) { const v = z[xo + k]; if (v) s += this.wih[ri + k] * v; }
        for (let k = 0; k < H; k++) s += this.whh[rh + k] * h[k];
        g[j] = s;
      }
      for (let k = 0; k < H; k++) {
        const i = sig(g[k]), f = sig(g[H + k]), gg = Math.tanh(g[2 * H + k]), o = sig(g[3 * H + k]);
        c[k] = f * c[k] + i * gg;
        h[k] = o * Math.tanh(c[k]);
      }
    }
    return h;
  }
  // Q-values for every action (array of card lists) given encoded state.
  values(enc, actions) {
    const N = actions.length, D = this.inDim, W = 512;
    const h = this.lstm(enc.z);
    const front = concat([h, enc.xna]);
    const actOff = D - 54;
    if (front.length !== actOff) throw new Error(`feature size ${front.length} != ${actOff}`);
    const w1 = this.w[0], base = new Float32Array(W);
    for (let j = 0; j < W; j++) {
      let s = this.b[0][j]; const r = j * D;
      for (let k = 0; k < actOff; k++) { const v = front[k]; if (v) s += w1[r + k] * v; }
      base[j] = s;
    }
    let cur = new Float32Array(N * W);
    const av = new Float32Array(54);
    for (let n = 0; n < N; n++) {
      cards2array(actions[n], av);
      const nz = []; for (let k = 0; k < 54; k++) if (av[k]) nz.push(k);
      for (let j = 0; j < W; j++) {
        let s = base[j]; const r = j * D + actOff;
        for (const k of nz) s += w1[r + k];
        cur[n * W + j] = s > 0 ? s : 0;
      }
    }
    // 8 candidate moves per pass over each weight row (weights are the memory bottleneck)
    for (let L = 1; L <= 4; L++) {
      const wl = this.w[L], bl = this.b[L], nxt = new Float32Array(N * W);
      for (let n = 0; n < N; n += 8) {
        const o = []; for (let q = 0; q < 8; q++) o.push(Math.min(n + q, N - 1) * W);
        const [o0, o1, o2, o3, o4, o5, o6, o7] = o;
        for (let j = 0; j < W; j++) {
          const r = j * W, bj = bl[j];
          let s0 = bj, s1 = bj, s2 = bj, s3 = bj, s4 = bj, s5 = bj, s6 = bj, s7 = bj;
          for (let k = 0; k < W; k++) {
            const wv = wl[r + k];
            s0 += wv * cur[o0 + k]; s1 += wv * cur[o1 + k]; s2 += wv * cur[o2 + k]; s3 += wv * cur[o3 + k];
            s4 += wv * cur[o4 + k]; s5 += wv * cur[o5 + k]; s6 += wv * cur[o6 + k]; s7 += wv * cur[o7 + k];
          }
          const ss = [s0, s1, s2, s3, s4, s5, s6, s7];
          for (let q = 0; q < 8 && n + q < N; q++) nxt[o[q] + j] = ss[q] > 0 ? ss[q] : 0;
        }
      }
      cur = nxt;
    }
    const out = new Float32Array(N), w6 = this.w[5], b6 = this.b[5][0];
    for (let n = 0; n < N; n++) { let s = b6; for (let k = 0; k < W; k++) s += w6[k] * cur[n * W + k]; out[n] = s; }
    return out;
  }
}

export class Agent {
  // `adp` (optional): {manifest, buffer} of DouZero's ADP model, whose value is the expected score
  // including bomb doubling. With it, moves are ranked by expected coins instead of win probability.
  constructor(manifest, buffer, adp = null) {
    this.nets = {};
    for (const p of POSITIONS) this.nets[p] = Net.fromBlob(manifest, buffer, p);
    this.adp = null;
    this.mode = 'adp';
    if (adp) { this.adp = {}; for (const p of POSITIONS) this.adp[p] = Net.fromBlob(adp.manifest, adp.buffer, p); }
  }
  // returns [{move, q, winProb}] sorted best first
  rank(state) {
    const info = buildInfoset(state);
    let acts = legalActions(info.hand, info.lastMove);
    if (state.filter) acts = acts.filter(state.filter);
    if (acts.length === 0) return [];
    const enc = encode(info);
    const q = this.nets[info.myPos].values(enc, acts);
    let qa = this.adp && this.useAdp !== false && !state.wpOnly ? this.adp[info.myPos].values(enc, acts) : null;
    // ADP values are E[±2^bombs]; anything far outside that range means an out-of-distribution state
    if (qa && qa.some((v) => !Number.isFinite(v) || Math.abs(v) > 64)) qa = null;
    const m0 = 2 ** Math.min(info.bombNum, 10); // stake multiplier from bombs already played
    return acts.map((m, i) => {
      const P = Math.min(1, Math.max(0, (q[i] + 1) / 2));
      const r = { move: m, q: q[i], winProb: P };
      if (qa) {
        if (this.mode === 'hybrid') {
          // P from the win-rate model, expected stake M from ADP (ADP ≈ M·(2P−1))
          const d = 2 * P - 1;
          let M = m0;
          if (Math.abs(d) >= 0.15) { const est = qa[i] / d; if (est > 0) M = Math.min(16 * m0, Math.max(m0, est)); }
          Object.assign(r, { adp: qa[i], mult: M, ev: M * (1.85 * P - 1) });
        } else {
          // ADP value = E[m·(win − lose)], m = 2^bombs. With 15% taken from winnings:
          // E[coins] = E[0.85·m·win − m·lose] = 0.925·ADP − 0.075·E[m]; E[m] ≈ current stake, doubled by a bomb/rocket.
          const Em = m0 * (m.length && isBomb(m) ? 2 : 1);
          Object.assign(r, { adp: qa[i], ev: 0.925 * qa[i] - 0.075 * Em });
        }
      }
      return r;
    }).sort((a, b) => (qa ? b.ev - a.ev : b.q - a.q));
  }
  // Estimated win probability as landlord for a 17-card hand, sampling the 3 bottom cards.
  landlordWinProb(hand17, samples = 6, rng = Math.random, known = null) {
    const pool = subtract(fullDeck(), hand17);
    let tot = 0;
    for (let s = 0; s < samples; s++) {
      let bottom;
      if (known) bottom = known; else {
        const p = pool.slice();
        for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
        bottom = p.slice(0, 3);
      }
      const hand = hand17.concat(bottom);
      const best = this.rank({ myPos: 'landlord', hand, seq: [], wpOnly: true })[0];
      tot += best.winProb;
      if (known) return tot;
    }
    return tot / samples;
  }
}
