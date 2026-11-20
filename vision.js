// Screenshot recognition for the 神來也鬥地主 table, robust to the Vision Pro
// window being off-centre / slightly tilted. Works on ImageData-like objects
// ({width, height, data: RGBA Uint8ClampedArray}) in both browser and Node.

export const TEAL_ASPECT = 0.543; // (window bottom - rail) / table width

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function isTeal(r, g, b) { return g - r > 25 && b - r > 35 && b > 60 && g > 55 && b - g < 45 && b - g > -15; }
function isRed(r, g, b) { const m = Math.max(g, b); return r > 60 && r - m > 40 && r > 1.7 * m; }
function isPink(r, g, b) { return r > 170 && g < 150 && b > 90 && r - g > 70 && b - g > 10; }

// ---------- connected components on a binary mask (Uint8Array, w*h) ----------
function components(mask, w, h, x0, y0, x1, y1) {
  const lab = new Int32Array(w * h).fill(0);
  const comps = [];
  const stack = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (!mask[i] || lab[i]) continue;
    const id = comps.length + 1;
    let minx = x, maxx = x, miny = y, maxy = y, n = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop(); n++;
      const jx = j % w, jy = (j / w) | 0;
      if (jx < minx) minx = jx; if (jx > maxx) maxx = jx; if (jy < miny) miny = jy; if (jy > maxy) maxy = jy;
      const nb = [j - 1, j + 1, j - w, j + w];
      for (let q = 0; q < 4; q++) {
        const k = nb[q];
        if (k < 0 || k >= w * h) continue;
        const kx = k % w, ky = (k / w) | 0;
        if (kx < x0 || kx >= x1 || ky < y0 || ky >= y1) continue;
        if (Math.abs(kx - jx) > 1) continue;
        if (mask[k] === mask[j] && !lab[k]) { lab[k] = id; stack.push(k); }
      }
    }
    comps.push({ id, x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, n });
  }
  return { comps, lab };
}

// ---------- 1. locate the table (teal felt) and build a normalised frame ----------
export function locateTable(img) {
  const { width: W, height: H, data } = img;
  const S = 4; // subsample
  const gw = Math.floor(W / S), gh = Math.floor(H / S);
  const m = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = ((y * S) * W + x * S) * 4;
    m[y * gw + x] = isTeal(data[i], data[i + 1], data[i + 2]) ? 1 : 0;
  }
  const { comps } = components(m, gw, gh, 0, 0, gw, gh);
  if (!comps.length) return null;
  comps.sort((a, b) => b.n - a.n);
  const c = comps[0];
  if (c.n < gw * gh * 0.03) return null;
  // per-row left/right extents inside the main blob's bbox
  const rows = [];
  for (let y = c.y; y < c.y + c.h; y++) {
    let l = -1, r = -1;
    for (let x = c.x; x < c.x + c.w; x++) if (m[y * gw + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) rows.push({ y: y * S, l: l * S, r: r * S });
  }
  // top of felt at the centre columns
  const cx0 = c.x + Math.floor(c.w * 0.45), cx1 = c.x + Math.floor(c.w * 0.55);
  const tops = [];
  for (let x = cx0; x < cx1; x++) for (let y = c.y; y < c.y + c.h; y++) if (m[y * gw + x]) { tops.push(y * S); break; }
  tops.sort((a, b) => a - b);
  const top = tops[Math.floor(tops.length / 2)];
  const fit = (pts, keepLow) => {
    // robust line x = a*y + b, iteratively dropping occluded points
    let use = pts;
    let a = 0, b = 0;
    for (let it = 0; it < 4; it++) {
      const n = use.length; if (n < 5) break;
      let sy = 0, sx = 0, syy = 0, sxy = 0;
      for (const p of use) { sy += p.y; sx += p.x; syy += p.y * p.y; sxy += p.x * p.y; }
      const den = n * syy - sy * sy;
      a = den ? (n * sxy - sx * sy) / den : 0; b = (sx - a * sy) / n;
      const res = use.map((p) => p.x - (a * p.y + b));
      const sorted = res.map(Math.abs).sort((x, y) => x - y);
      const tol = Math.max(6, sorted[Math.floor(sorted.length * 0.5)] * 2.5);
      use = use.filter((p, i) => (keepLow ? res[i] < tol : res[i] > -tol));
    }
    return { a, b };
  };
  const tableH0 = (c.w * S) * TEAL_ASPECT;
  const band = rows.filter((r) => r.y > top + tableH0 * 0.05 && r.y < top + tableH0 * 0.7);
  const L = fit(band.map((r) => ({ y: r.y, x: r.l })), true);
  const R = fit(band.map((r) => ({ y: r.y, x: r.r })), false);
  const Lx = (y) => L.a * y + L.b, Rx = (y) => R.a * y + R.b;
  const width = Rx(top) - Lx(top);
  const T = width * TEAL_ASPECT;
  // window roll: the rail is a symmetric arc, so its height at u=0.3 and u=0.7 should match
  const xc = (Lx(top) + Rx(top)) / 2;
  const railY = (u) => {
    const xs = Math.round((Lx(top) + u * width) / S), ys = [];
    for (let x = xs - Math.round(c.w * 0.02); x <= xs + Math.round(c.w * 0.02); x++) {
      for (let y = c.y; y < c.y + c.h; y++) if (m[y * gw + x]) { ys.push(y * S); break; }
    }
    ys.sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)] : null;
  };
  // roll from the side edges: keystone (pitch/yaw) tilts them in opposite directions and cancels,
  // a roll tilts both the same way
  let slope = -(L.a + R.a) / 2;
  if (!Number.isFinite(slope) || Math.abs(slope) > 0.2) slope = 0;
  const toImg = (u, v) => {
    const y0 = top + v * T;
    let y = y0, x = 0;
    for (let it = 0; it < 3; it++) { x = Lx(y) + u * (Rx(y) - Lx(y)); y = y0 + slope * (x - xc); }
    return { x, y };
  };
  const toNorm = (x, y) => ({ u: (x - Lx(y)) / (Rx(y) - Lx(y)), v: (y - slope * (x - xc) - top) / T });
  return { top, T, width, Lx, Rx, toImg, toNorm, slope };
}

// Pixel rectangle covering a normalised region
function rectOf(tb, img, u0, v0, u1, v1) {
  const ps = [tb.toImg(u0, v0), tb.toImg(u1, v0), tb.toImg(u0, v1), tb.toImg(u1, v1)];
  const x0 = Math.max(0, Math.floor(Math.min(...ps.map((p) => p.x))));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...ps.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...ps.map((p) => p.y))));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ps.map((p) => p.y))));
  return { x0, y0, x1, y1 };
}

// ---------- 2. card-glyph extraction ----------
// Finds rank glyphs (top-most ink blob of each card column) inside a region.
// size: expected glyph height as a fraction of T.
function findGlyphs(img, tb, reg, size, opts = {}) {
  const { width: W, data } = img;
  const { x0, y0, x1, y1 } = reg;
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  // local card background = column max of low-saturation luminance (smoothed)
  const lum = new Float32Array(w * h), sat = new Float32Array(w * h), red = new Uint8Array(w * h), rness = new Float32Array(w * h), blu = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + y0) * W + (x + x0)) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    lum[y * w + x] = lumOf(r, g, b);
    sat[y * w + x] = Math.max(r, g, b) - Math.min(r, g, b);
    red[y * w + x] = isRed(r, g, b) ? 1 : 0;
    rness[y * w + x] = r - (g + b) / 2;
    blu[y * w + x] = b - r;
  }
  // background = max of card-like (low saturation) luminance along the same column only,
  // so a grey (disabled) card is never compared with a neighbouring white card
  const rad = Math.max(4, Math.round(size * tb.T * 1.0));
  const bg = new Float32Array(w * h), bgRed = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0, mr = 0; const a = Math.max(0, y - rad), b = Math.min(h - 1, y + rad);
      for (let k = a; k <= b; k++) { const i = k * w + x; if (sat[i] < 65 && lum[i] > m) { m = lum[i]; mr = rness[i]; } }
      bg[y * w + x] = m; bgRed[y * w + x] = mr;
    }
  }
  const makeInk = (darkK, redK) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!(bg[i] > (opts.minBg || 110))) continue;
      if (rness[i] - bgRed[i] > redK && lum[i] < bg[i] - 8) m[i] = 2;
      else if (sat[i] < 70 && lum[i] < bg[i] * darkK && blu[i] < 28) m[i] = 1;
    }
    return m;
  };
  const ink = makeInk(opts.darkK || 0.64, opts.redK || 22);
  // the joker search always uses the standard (stricter) ink; card edges must not become letters
  const inkJ = (opts.darkK || 0.64) === 0.64 && (opts.redK || 22) === 22 ? ink : makeInk(0.64, 22);
  const inkness = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (bg[i] <= 0) continue;
    const dk = Math.min(1, Math.max(0, (bg[i] - lum[i]) / bg[i] / 0.55));
    const rd = Math.min(1, Math.max(0, (rness[i] - bgRed[i] - 10) / 70));
    inkness[i] = Math.max(dk, rd);
  }
  const { comps, lab } = components(ink, w, h, 0, 0, w, h);
  if (opts.dbgInk) opts.dbgInk.push({ ink, w, h, x0, y0, comps, bg, lab });
  const gh = size * tb.T;
  // ---- jokers: a vertical stack of small letters "J O K E R" (or one tall narrow merged strip)
  const findJokers = (comps, lab, ink) => {
    const jokers = [];
    // number of narrow "waists" in a vertical strip (gaps between stacked letters)
    const letterDips = (c) => {
      const rows = [];
      for (let yy = c.y; yy < c.y + c.h; yy++) { let k = 0; for (let xx = c.x; xx < c.x + c.w; xx++) if (lab[yy * w + xx] === c.id) k++; rows.push(k); }
      const med = rows.slice().sort((p, q) => p - q)[Math.floor(rows.length / 2)];
      let dips = 0, inDip = false;
      for (const k of rows) { const d = k <= med * 0.45; if (d && !inDip) dips++; inDip = d; }
      return dips;
    };
    const single = (c) => c.h > gh * 0.22 && c.h < gh * 0.62 && c.w > gh * 0.12 && c.w < gh * 0.8;
    const fused = (c) => c.h >= gh * 0.8 && c.h < gh * 5 && c.w >= gh * 0.3 && c.w <= gh * 0.75 && c.h / c.w >= 2.0 && c.n / (c.w * c.h) > 0.2;
    // hand: fused letters must show a waist (a plain "J" rank must not count); table cards are tiny,
    // so there a fused strip is accepted when the jester drawing sits right next to it (checked below)
    const letters = comps.filter((c) => single(c) || (fused(c) && (letterDips(c) >= 1 || !opts.hand))).sort((a, b) => a.y - b.y);
    const hasArt = (x0s, x1s, y0s, ext) => comps.some((q) => q.w > gh * 0.6 && q.w < gh * 1.8 && q.h > gh * 0.6 && q.h < gh * 1.8 &&
      q.x >= x1s - gh * 0.2 && q.x < x1s + gh * 2.2 && q.y + q.h / 2 > y0s + ext * 0.3 && q.y < y0s + ext + gh * 0.3);
    const used = new Set();
    for (const a of letters) {
      if (used.has(a)) continue;
      const stack = [a];
      let last = a;
      for (const b of letters) {
        if (b === a || used.has(b) || b.y <= last.y) continue;
        const cxA = last.x + last.w / 2, cxB = b.x + b.w / 2;
        const maxGap = last.w < gh * 0.6 && b.w < gh * 0.6 ? gh * 0.9 : gh * 0.5;
        if (Math.abs(cxA - cxB) < gh * 0.35 && b.y - (last.y + last.h) < maxGap && b.y - (last.y + last.h) > -gh * 0.2) { stack.push(b); last = b; }
      }
      const y0s = stack[0].y, y1s = Math.max(...stack.map((c) => c.y + c.h));
      const ext = y1s - y0s;
      const singles = stack.filter(single), nFused = stack.length - singles.length;
      const hs = singles.map((c) => c.h).sort((p, q) => p - q), hm = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
      const similar = singles.every((c) => c.h > hm * 0.6 && c.h < hm * 1.7);
      const sx0 = Math.min(...stack.map((c) => c.x)), sx1 = Math.max(...stack.map((c) => c.x + c.w));
      const ok = similar && (
        // J O K (E R) as separate letters: three stacked letters already say joker even when the lower
        // ones hide under a card-type button or the "E" merges with the black jester hat
        (nFused === 0 && stack.length >= 3 && ext >= gh * (stack.length >= 4 ? 1.8 : 1.4)) ||
        (ext >= gh * 1.8 && (
          (nFused >= 1 && stack.length >= 2 && ext >= gh * 2.0) || // some letters fused + more letters
          (stack.length === 1 && a.h >= gh * 1.8 && letterDips(a) >= 3) || // whole word fused into one strip
          // a small table joker blurs the whole word into one strip with no waists left: far taller and
          // narrower than a rank fused with its suit, and the jester drawing sits right beside it
          (!opts.hand && stack.length === 1 && a.h >= gh * 1.9 && a.h >= a.w * 3.5 && hasArt(sx0, sx1, y0s, ext)))));
      const noWaist = stack.some((c) => fused(c) && letterDips(c) < 1);
      if (ok && (!noWaist || hasArt(sx0, sx1, y0s, ext))) {
        stack.forEach((c) => used.add(c));
        let rN = 0, n = 0;
        for (const c of stack) for (let yy = c.y; yy < c.y + c.h; yy++) for (let xx = c.x; xx < c.x + c.w; xx++) {
          if (lab[yy * w + xx] === c.id && ink[yy * w + xx]) { n++; if (ink[yy * w + xx] === 2) rN++; }
        }
        const x0s = Math.min(...stack.map((c) => c.x)), x1s = Math.max(...stack.map((c) => c.x + c.w));
        jokers.push({ x: x0s, y: y0s, w: x1s - x0s, h: Math.round(Math.min(ext, gh)), ext, red: rN / Math.max(1, n) > 0.4, ids: new Set(stack.map((c) => c.id)) });
      }
    }
    // blur can split the same letters into two parallel stacks: one joker per card column
    const uniq = [];
    for (const j of jokers.sort((a, b) => b.ext - a.ext)) {
      const dup = uniq.some((k) => Math.min(k.x + k.w, j.x + j.w) - Math.max(k.x, j.x) > Math.min(k.w, j.w) * 0.4);
      if (dup) { for (const id of j.ids) uniq.find((k) => Math.min(k.x + k.w, j.x + j.w) - Math.max(k.x, j.x) > Math.min(k.w, j.w) * 0.4).ids.add(id); }
      else uniq.push(j);
    }
    return uniq.sort((a, b) => a.x - b.x);
  };
  const cj = inkJ === ink ? { comps, lab } : components(inkJ, w, h, 0, 0, w, h);
  const jokers1 = findJokers(cj.comps, cj.lab, inkJ);
  // split rank glyphs that touch the suit symbol below them (blur on small cards / window edge)
  const normalH = comps.filter((c) => c.h > gh * 0.6 && c.h < gh * 1.3 && c.w < gh * 1.3 && c.n > gh * gh * 0.06).map((c) => c.h).sort((a, b) => a - b);
  const typH = normalH.length ? normalH[Math.floor(normalH.length * 0.75)] : gh * 0.85; // upper quartile = rank height (suits are shorter)
  for (const c of comps) {
    if (!(c.h > Math.min(gh * 1.45, typH * 1.45) && c.h < gh * 2.8 && c.w < gh * 1.3 && c.w > gh * 0.2)) continue;
    const rowCnt = [];
    for (let yy = 0; yy < c.h; yy++) { let cnt = 0; for (let xx = c.x; xx < c.x + c.w; xx++) if (lab[(c.y + yy) * w + xx] === c.id) cnt++; rowCnt.push(cnt); }
    const med = rowCnt.slice().sort((a, b) => a - b)[Math.floor(rowCnt.length / 2)];
    let bestRow = -1, bestCnt = Infinity;
    for (let yy = Math.round(gh * 0.6); yy < Math.min(c.h - gh * 0.25, gh * 1.4); yy++) {
      if (rowCnt[yy] < bestCnt) { bestCnt = rowCnt[yy]; bestRow = yy; }
    }
    if (!(bestRow > 0 && bestCnt <= Math.max(2, med * 0.45))) bestRow = Math.round(typH); // no clear neck: crop to typical rank height
    if (bestRow > 0) {
      let minx = Infinity, maxx = -1, n = 0;
      for (let yy = 0; yy < bestRow; yy++) for (let xx = c.x; xx < c.x + c.w; xx++) if (lab[(c.y + yy) * w + xx] === c.id) { n++; if (xx < minx) minx = xx; if (xx > maxx) maxx = xx; }
      if (n) { c.h = bestRow; c.x = minx; c.w = maxx - minx + 1; c.n = n; }
    }
  }
  let cand = comps.filter((c) => c.h > gh * 0.45 && c.h < gh * 1.45 && c.w < gh * 1.3 && c.w > gh * 0.08 && c.n > gh * gh * 0.035);
  // colour of each component
  for (const c of cand) {
    let r = 0, n = 0;
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (lab[y * w + x] === c.id) { n++; if (ink[y * w + x] === 2) r++; }
    c.red = r / Math.max(1, n) > 0.5;
  }
  // card-ness: ring around component must be mostly card background
  cand = cand.filter((c) => {
    const m = Math.max(2, Math.round(c.h * 0.15));
    let good = 0, tot = 0;
    for (let y = c.y - m; y <= c.y + c.h + m; y++) for (let x = c.x - m; x <= c.x + c.w + m; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (y >= c.y && y < c.y + c.h && x >= c.x && x < c.x + c.w) continue;
      tot++; const i = y * w + x;
      if (sat[i] < 65 && lum[i] > (opts.minBg || 110) * 0.9) good++;
      else if (ink[i]) good++;
    }
    return tot && good / tot > 0.55;
  });
  // merge '1' + '0' (and other split glyphs) that sit side by side with the same top
  cand.sort((a, b) => a.x - b.x);
  const merged = [];
  for (const c of cand) {
    const p = merged.slice().reverse().find((p) => c.x - (p.x + p.w) < gh * 0.25 && c.x - (p.x + p.w) > -gh * 0.1 && Math.abs(c.y - p.y) < gh * 0.25);
    if (p && c.x - (p.x + p.w) < gh * 0.25 && c.x - (p.x + p.w) > -gh * 0.1 && Math.abs(c.y - p.y) < gh * 0.25 &&
        Math.abs(c.h - p.h) < gh * 0.3 && p.w < gh * 0.42 && c.red === p.red) {
      const nx = Math.min(p.x, c.x), ny = Math.min(p.y, c.y);
      p.w = Math.max(p.x + p.w, c.x + c.w) - nx; p.h = Math.max(p.y + p.h, c.y + c.h) - ny; p.x = nx; p.y = ny;
      p.parts = (p.parts || [p.id]).concat(c.id); p.n += c.n;
    } else merged.push(Object.assign({}, c, { parts: [c.id] }));
  }
  // keep only the top-most glyph of each card column (drop suits / joker letters below)
  let out = merged.filter((c) => !merged.some((o) => o !== c && o.y + o.h <= c.y + gh * 0.15 && c.y - (o.y + o.h) < gh * 1.2 &&
    Math.min(o.x + o.w, c.x + c.w) - Math.max(o.x, c.x) > Math.min(o.w, c.w) * 0.4));
  // rank glyphs of one card row share (almost) the same top; raised (selected) cards sit higher.
  // Drop anything clearly below the typical rank line or touching the region's bottom edge.
  const vTop = (c) => tb.toNorm(c.x + x0 + c.w / 2, c.y + y0).v * tb.T; // roll-corrected top, in px
  // in the hand, rank tops always sit at 0.66-0.76 of the table height (raised cards at the low end);
  // anything starting lower is a suit, a card-type button or its shadow
  const band = opts.band || [0.63, 0.80];
  if (opts.hand) out = out.filter((c) => { const v = vTop(c) / tb.T; return v > band[0] && v < band[1]; });
  const tops = out.map(vTop).sort((a, b) => a - b);
  const tMed = tops.length ? tops[Math.floor(tops.length * 0.4)] : 0;
  const kept = out.filter((c) => vTop(c) <= tMed + gh * 0.6 && c.y + c.h < h - 2);
  if (opts.dbgInk) Object.assign(opts.dbgInk[opts.dbgInk.length - 1], { out: out.map((c) => `${c.x},${c.y} ${c.w}x${c.h} vt${vTop(c).toFixed(0)}`), tMed });
  // jokers in the hand are always the leftmost cards and their letters start at the rank line
  const validJ = (list) => list.filter((j) => {
    if (!opts.hand) return true;
    // the other joker (both can be in the hand) is not a "card to the left" of this one
    const inAnyJ = (c) => list.some((k) => c.x + c.w / 2 > k.x - gh * 0.3 && c.x + c.w / 2 < k.x + k.w + gh * 0.3);
    const others = kept.filter((c) => !inAnyJ(c));
    const minX = others.length ? Math.min(...others.map((c) => c.x)) : Infinity;
    return j.x + j.w < minX + gh * 0.2 && Math.abs(vTop(j) - tMed) < gh * 0.9;
  });
  let jokers = validJ(jokers1);
  if (!jokers.length) {
    // blurry screenshots break the letters into strokes: thicken the ink by one pixel and retry
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = inkJ[y * w + x];
      if (!v) for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1 && !v; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < h && xx < w && inkJ[yy * w + xx]) v = inkJ[yy * w + xx];
      }
      dil[y * w + x] = v;
    }
    const d = components(dil, w, h, 0, 0, w, h);
    jokers = validJ(findJokers(d.comps, d.lab, inkJ));
  }
  if (opts.dbgInk) opts.dbgInk[opts.dbgInk.length - 1].jokers = jokers;
  // only inside the game window (a removed background is white and looks like card paper)
  const inWindow = (c) => { const n = tb.toNorm(c.x + x0 + c.w / 2, c.y + y0 + c.h / 2); return n.u > 0.015 && n.u < 0.985; };
  // drop anything that belongs to a joker card (its letters or the jester drawing)
  const inJoker = (c) => jokers.some((j) => {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const inCol = cx > j.x - gh * 0.3 && cx < j.x + j.w + gh * 0.3 && cy > j.y - gh * 1.2 && cy < j.y + j.ext + gh * 0.3;
    const inArt = cx >= j.x + j.w && cx < j.x + j.w + gh * 2.6 && cy > j.y + j.ext * 0.5 && cy < j.y + j.ext + gh * 0.5;
    return inCol || inArt;
  });
  const jokerGlyphs = jokers.map((j) => ({ x: j.x + x0, y: j.y + y0, w: j.w, h: j.h, red: j.red, below: 0, vec: [], aspect: 0.5,
    joker: j.red ? '大王' : '小王', label: j.red ? '大王' : '小王', dist: 0, margin: 1, noCardCheck: true }));
  // feature vectors
  return jokerGlyphs.concat(kept.filter((c) => !inJoker(c) && inWindow(c)).map((c) => ({
    x: c.x + x0, y: c.y + y0, w: c.w, h: c.h, red: c.red,
    below: merged.filter((o) => o !== c && o.y > c.y + c.h * 0.5 && Math.min(o.x + o.w, c.x + c.w) - Math.max(o.x, c.x) > Math.min(o.w, c.w) * 0.3).length,
    vec: glyphVecCont(inkness, w, h, c),
    aspect: c.w / c.h,
  })));
}

const GW = 10, GH = 14;
// area-averaged continuous ink intensity over the glyph box, contrast-normalised
function glyphVecCont(inkness, w, h, c) {
  const v = new Array(GW * GH).fill(0);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const ya = c.y + (gy * c.h) / GH, yb = c.y + ((gy + 1) * c.h) / GH;
    const xa = c.x + (gx * c.w) / GW, xb = c.x + ((gx + 1) * c.w) / GW;
    let s = 0, n = 0;
    for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y++)
      for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const wy = Math.min(yb, y + 1) - Math.max(ya, y), wx = Math.min(xb, x + 1) - Math.max(xa, x);
        const wt = Math.max(0.05, wy) * Math.max(0.05, wx);
        s += inkness[y * w + x] * wt; n += wt;
      }
    v[gy * GW + gx] = n ? s / n : 0;
  }
  let mx = 0; for (const x of v) if (x > mx) mx = x;
  return mx > 0 ? v.map((x) => x / mx) : v;
}
function glyphVec(ink, lab, w, c) {
  const v = new Array(GW * GH).fill(0);
  const ids = new Set(c.parts || [c.id]);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const ya = c.y + (gy * c.h) / GH, yb = c.y + ((gy + 1) * c.h) / GH;
    const xa = c.x + (gx * c.w) / GW, xb = c.x + ((gx + 1) * c.w) / GW;
    let s = 0, n = 0;
    for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y++)
      for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x++) { n++; if (ids.has(lab[y * w + x])) s++; }
    v[gy * GW + gx] = n ? s / n : 0;
  }
  return v;
}

// ---------- 3. classification ----------
export function classify(g, templates) {
  let best = null, bestD = Infinity, second = Infinity;
  for (const t of templates) {
    let d = 0;
    for (let i = 0; i < t.vec.length; i++) { const e = g.vec[i] - t.vec[i]; d += e * e; }
    d = d / t.vec.length + 0.5 * (g.aspect - t.aspect) ** 2;
    if (d < bestD) { if (best && best.label !== t.label) second = bestD; bestD = d; best = t; }
    else if (d < second && best && t.label !== best.label) second = d;
  }
  return { label: best ? best.label : null, dist: bestD, margin: second - bestD };
}

// ---------- 4. high-level read of a screenshot ----------
const HAND_SIZE = 0.078, TABLE_SIZE = 0.042;

function countPixels(img, reg, pred, step = 2) {
  let n = 0, t = 0;
  for (let y = reg.y0; y < reg.y1; y += step) for (let x = reg.x0; x < reg.x1; x += step) {
    const i = (y * img.width + x) * 4; t++;
    if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  }
  return t ? n / t : 0;
}

// Detect the decision buttons row: returns {count, boxes}
function findButtons(img, tb) {
  const reg = rectOf(tb, img, 0.2, 0.42, 0.95, 0.69);
  const W = img.width, w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + reg.y0) * W + x + reg.x0) * 4;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const orange = r > 160 && b < 120 && r - b > 90;           // orange / yellow buttons
    const grey = lumOf(r, g, b) > 112 && Math.max(r, g, b) - Math.min(r, g, b) < 30; // disabled / grey buttons
    m[y * w + x] = orange || grey ? 1 : 0;
  }
  const { comps } = components(m, w, h, 0, 0, w, h);
  const bw = tb.width * 0.11, bh = tb.T * 0.075;
  const boxes = comps.filter((c) => c.w > bw * 0.6 && c.w < bw * 1.6 && c.h > bh * 0.5 && c.h < bh * 1.8 && c.n > c.w * c.h * 0.45)
    .map((c) => ({ x: c.x + reg.x0, y: c.y + reg.y0, w: c.w, h: c.h }));
  // keep the largest horizontally aligned group
  let bestGroup = [];
  for (const b of boxes) {
    const g = boxes.filter((o) => Math.abs((o.y + o.h / 2) - (b.y + b.h / 2)) < bh * 0.5);
    if (g.length > bestGroup.length) bestGroup = g;
  }
  return bestGroup.sort((a, b) => a.x - b.x);
}

// ---------- table furniture: bottom cards, turn timer, card-count bubbles ----------
export const SEAT_POS = {
  count: { left: [0.159, -0.03], right: [0.846, -0.016], me: [0.158, 0.39] },
  timer: { left: [0.214, -0.037], right: [0.808, -0.013], me: [0.235, 0.39] },
};

// 'down' while the three bottom cards are still face down (bidding), 'up' once revealed
function bottomState(img, tb, shift = 0) {
  const reg = rectOf(tb, img, 0.44, -0.29 + shift, 0.66, -0.15 + shift);
  const green = countPixels(img, reg, (r, g, b) => g > 80 && g - r > 25 && g - b > 40, 2);
  const white = countPixels(img, reg, (r, g, b) => lumOf(r, g, b) > 170 && Math.max(r, g, b) - Math.min(r, g, b) < 45, 2);
  return { green, white, state: green > 0.22 ? 'down' : white > 0.18 ? 'up' : 'unknown' };
}

// is the countdown disc (dark round centre inside a gold ring) next to my avatar?
function myTimer(img, tb) {
  const reg = rectOf(tb, img, 0.18, 0.29, 0.31, 0.49);
  const w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
  if (w < 5 || h < 5) return 0;
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + reg.y0) * img.width + x + reg.x0) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    dark[y * w + x] = lumOf(r, g, b) < 70 && !(g - r > 25 && g - b > 15) ? 1 : 0;
  }
  const { comps } = components(dark, w, h, 0, 0, w, h);
  const T = tb.T;
  let best = 0;
  for (const c of comps) {
    if (c.w < T * 0.045 || c.w > T * 0.13 || c.h < T * 0.045 || c.h > T * 0.13) continue;
    if (Math.abs(c.w - c.h) > Math.max(c.w, c.h) * 0.3 || c.n < c.w * c.h * 0.4) continue;
    // gold ring just outside the disc
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, R = (c.w + c.h) / 4;
    let gold = 0, tot = 0;
    for (let a = 0; a < 48; a++) for (const k of [1.1, 1.2, 1.3]) {
      const x = Math.round(cx + Math.cos(a * Math.PI / 24) * R * k) + reg.x0, y = Math.round(cy + Math.sin(a * Math.PI / 24) * R * k) + reg.y0;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      tot++; if (r > 150 && g > 110 && b < 130 && r - b > 50) gold++;
    }
    if (tot) best = Math.max(best, gold / tot);
  }
  return best;
}

// the countdown disc (dark centre, gold ring) sits next to whoever has to act
function timerScores(img, tb) {
  const out = {};
  for (const [seat, [u, v]] of Object.entries(SEAT_POS.timer)) {
    const reg = rectOf(tb, img, u - 0.03, v - 0.055, u + 0.03, v + 0.055);
    const gold = countPixels(img, reg, (r, g, b) => r > 160 && g > 120 && b < 120 && r - b > 60, 1);
    const dark = countPixels(img, reg, (r, g, b) => lumOf(r, g, b) < 55 && b >= r - 10, 1);
    out[seat] = Math.min(gold * 4, 1) * Math.min(dark * 2.5, 1);
  }
  return out;
}

// Binary mask over a pixel region, subsampled by S
function maskOf(img, reg, S, pred) {
  const w = Math.max(0, Math.floor((reg.x1 - reg.x0) / S)), h = Math.max(0, Math.floor((reg.y1 - reg.y0) / S));
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((reg.y0 + y * S) * img.width + reg.x0 + x * S) * 4;
    m[y * w + x] = +pred(img.data[i], img.data[i + 1], img.data[i + 2]) || 0;
  }
  return { m, w, h };
}

// White card faces of an opponent's latest play. The window's shape moves them relative to the
// rail (a squarer window pushes them up over it), so search a tall band and return the box of the
// card row (pixels), or null when that side of the table is empty.
function findTableCards(img, tb, u0, u1) {
  const reg = rectOf(tb, img, u0, -0.14, u1, 0.36);
  const S = 2, T = tb.T / S;
  const { m, w, h } = maskOf(img, reg, S, (r, g, b) => lumOf(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 50);
  if (w < 4 || h < 4) return null;
  const { comps } = components(m, w, h, 0, 0, w, h);
  const vOf = (yy) => tb.toNorm(reg.x0 + (u0 + u1) / 2, reg.y0 + yy * S).v;
  // a played card reaches below the rail; its face is a tall, mostly white block
  const faces = comps.filter((c) => c.h > T * 0.06 && c.h < T * 0.26 && c.w > T * 0.025 && c.w < T * 1.0 &&
    c.n > c.w * c.h * 0.35 && vOf(c.y + c.h) > 0.05 && vOf(c.y) < 0.2);
  if (!faces.length) return null;
  faces.sort((a, b) => b.n - a.n);
  const big = faces[0];
  const row = faces.filter((c) => Math.abs(c.y - big.y) < T * 0.05 && Math.abs(c.y + c.h - (big.y + big.h)) < T * 0.06);
  const pad = Math.round(tb.T * 0.02);
  const x0 = Math.min(...row.map((c) => c.x)), x1 = Math.max(...row.map((c) => c.x + c.w));
  const y0 = Math.min(...row.map((c) => c.y)), y1 = Math.max(...row.map((c) => c.y + c.h));
  return {
    x0: Math.max(reg.x0, reg.x0 + x0 * S - pad), x1: Math.min(reg.x1, reg.x0 + x1 * S + pad),
    y0: Math.max(reg.y0, reg.y0 + y0 * S - pad), y1: Math.min(reg.y1, reg.y0 + y1 * S + pad),
  };
}

// The card-count bubble next to an opponent's avatar (green fan; red when nearly out). Its height
// relative to the rail depends on the window's shape, so find it instead of assuming a spot.
function findCountBubble(img, tb, u0, u1, v0, v1) {
  const reg = rectOf(tb, img, u0, v0, u1, v1);
  const S = 2, T = tb.T / S;
  // green bubble = 1, pinkish-red bubble = 2 (the hall behind is a darker orange-red: kept out)
  const { m, w, h } = maskOf(img, reg, S, (r, g, b) => (g - r > 30 && g - b > 25 && g > 90 ? 1 : r > 190 && g < 120 && b - g > 10 && r - b > 80 ? 2 : 0));
  if (w < 4 || h < 4) return null;
  const { comps } = components(m, w, h, 0, 0, w, h);
  const ok = comps.filter((c) => c.w > T * 0.06 && c.w < T * 0.24 && c.h > T * 0.04 && c.h < T * 0.16 && c.n > c.w * c.h * 0.3);
  if (!ok.length) return null;
  ok.sort((a, b) => b.n - a.n);
  const c = ok[0];
  return { x: reg.x0 + (c.x + c.w / 2) * S, y: reg.y0 + (c.y + c.h / 2) * S };
}

// white digits inside the green card-fan bubble
function readCount(img, tb, u, v, templates, at = null) {
  const c = at || tb.toImg(u, v);
  const hw = Math.round(tb.T * 0.075), hh = Math.round(tb.T * 0.055);
  const x0 = Math.max(0, Math.round(c.x - hw)), y0 = Math.max(0, Math.round(c.y - hh));
  const w = Math.min(img.width, Math.round(c.x + hw)) - x0, h = Math.min(img.height, Math.round(c.y + hh)) - y0;
  if (w <= 4 || h <= 4) return null;
  const white = new Uint8Array(w * h), soft = new Float32Array(w * h), Ls = new Float32Array(w * h), Ss = new Float32Array(w * h);
  let greenN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + y0) * img.width + x + x0) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    Ls[y * w + x] = lumOf(r, g, b); Ss[y * w + x] = Math.max(r, g, b) - Math.min(r, g, b);
    if ((g - r > 30 && g - b > 25) || (r - g > 50 && r - b > 40)) greenN++; // green bubble, or red when a player is nearly out
  }
  // adaptive threshold: digits are the brightest low-saturation pixels of the bubble
  const sortedL = Array.from(Ls).sort((a, b) => a - b);
  const Lmed = sortedL[Math.floor(sortedL.length * 0.5)], Lhi = sortedL[Math.floor(sortedL.length * 0.985)];
  const thr = Math.max(130, (Lmed + Lhi) / 2);
  for (let i = 0; i < w * h; i++) {
    white[i] = Ls[i] > thr && Ss[i] < 80 ? 1 : 0;
    soft[i] = Ss[i] < 90 ? Math.min(1, Math.max(0, (Ls[i] - Lmed) / Math.max(20, Lhi - Lmed))) : 0;
  }
  if (greenN < w * h * 0.15) return null; // no bubble here (covered by a chat bubble etc.)
  const T = tb.T;
  const pick = (white, soft) => {
    const { comps } = components(white, w, h, 0, 0, w, h);
    const cands = comps.filter((q) => q.h > T * 0.028 && q.h < T * 0.085 && q.w > T * 0.004 && q.w < T * 0.06 && q.n > 8 &&
      Math.abs(q.y + q.h / 2 - h / 2) < h * 0.38).sort((a, b) => a.x - b.x);
    // best group of 1-2 neighbouring, equally tall digits closest to the bubble centre
    let ds = null, bestScore = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const a = cands[i], group = [a];
      for (let j = i + 1; j < cands.length && group.length < 2; j++) {
        const b = cands[j], gap = b.x - (a.x + a.w);
        const vov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (gap > -2 && gap < a.h * 0.7 && Math.abs(b.h - a.h) < Math.max(a.h, b.h) * 0.4 && vov > Math.min(a.h, b.h) * 0.55) group.push(b);
      }
      const gx0 = group[0].x, gx1 = group[group.length - 1].x + group[group.length - 1].w;
      const score = Math.abs((gx0 + gx1) / 2 - w / 2) + Math.abs(a.y + a.h / 2 - h / 2) - group.length * T * 0.02;
      if (score < bestScore) { bestScore = score; ds = group; }
    }
    if (!ds) return { value: null, dist: 1, digits: [] };
    const out = ds.map((q) => {
      const g = { x: q.x, y: q.y, w: q.w, h: q.h, aspect: q.w / q.h, vec: glyphVecCont(soft, w, h, q) };
      return Object.assign(g, templates.length ? classify(g, templates) : { label: null, dist: 1 });
    });
    const value = out.every((d) => d.label != null) ? Number(out.map((d) => d.label).join('')) : null;
    return { value, dist: Math.max(...out.map((d) => d.dist)), digits: out };
  };
  let res = pick(white, soft);
  if (res.value == null || res.dist > 0.05) {
    // the last-card warning draws the digit as a white outline around a dark fill: fill the holes
    const { comps: bgc, lab } = components(white.map((x) => 1 - x), w, h, 0, 0, w, h);
    const holes = new Set(bgc.filter((q) => q.x > 0 && q.y > 0 && q.x + q.w < w && q.y + q.h < h && q.n < T * T * 0.004).map((q) => q.id));
    if (holes.size) {
      const white2 = white.slice(), soft2 = soft.slice();
      for (let i = 0; i < w * h; i++) if (!white[i] && holes.has(lab[i])) { white2[i] = 1; soft2[i] = 1; }
      const res2 = pick(white2, soft2);
      if (res2.value != null && res2.dist < res.dist) res = Object.assign(res2, { filled: true });
    }
  }
  return res;
}

let MISSION_TPL = null; // rendered card-type words / digits for the 任務場 banner (mission_tpl.json)
export function setMissionTemplates(t) { MISSION_TPL = t; }

export function readScreenshot(img, templates, debug = false, missionTpl = MISSION_TPL) {
  const tb = locateTable(img);
  if (!tb) return { ok: false, error: '找不到牌桌（綠色桌面）' };
  const res = { ok: true, table: tb, dbg: {} };
  const readRow = (u0, v0, u1, v1, size, minBg) => {
    const reg = rectOf(tb, img, u0, v0, u1, v1);
    const isHand = size === HAND_SIZE;
    // table cards are small: thin strokes blur to light grey, so use a more sensitive ink threshold there
    const gl = findGlyphs(img, tb, reg, size, { minBg, hand: isHand, band: isHand ? handBand : null, darkK: isHand ? 0.64 : 0.76, redK: isHand ? 22 : 18, dbgInk: debug ? (res.inks = res.inks || []) : null });
    for (const g of gl) if (!g.joker) Object.assign(g, classify(g, templates.filter((t) => t.size === (size === HAND_SIZE ? 'hand' : 'table'))));
    gl.sort((a, b) => a.x - b.x);
    if (debug) res.dbg[`${u0},${v0}`] = { reg, gl };
    return gl;
  };
  res.buttons = findButtons(img, tb);
  // rank tops of the hand sit ~0.17 below the action buttons; a squarer window moves both down
  let handBand = [0.63, 0.80];
  if (res.buttons.length >= 2) {
    const bv = res.buttons.map((b) => tb.toNorm(b.x + b.w / 2, b.y + b.h / 2).v).sort((a, b) => a - b)[Math.floor(res.buttons.length / 2)];
    handBand = [Math.min(0.63, bv + 0.07), Math.max(0.80, bv + 0.235)];
  }
  res.handBand = handBand;
  // the game's own 「您沒有更大的牌可以出」 hint: light text centred just above the action buttons.
  // When it shows, the game only lets you pass.
  res.noBeat = false; res.noBeatScore = 0;
  if (res.buttons.length >= 3) {
    const bv = res.buttons.map((b) => tb.toNorm(b.x + b.w / 2, b.y + b.h / 2).v).sort((a, b) => a - b)[Math.floor(res.buttons.length / 2)];
    let n = 0, t = 0; const xs = [];
    for (let v = bv - 0.16; v < bv - 0.05; v += 0.004) for (let u = 0.3; u < 0.7; u += 0.002) {
      const p = tb.toImg(u, v); const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      t++; if (lumOf(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 55) { n++; xs.push(u); }
    }
    xs.sort((a, b) => a - b);
    const frac = t ? n / t : 0;
    const span = xs.length > 10 ? xs[Math.floor(xs.length * 0.95)] - xs[Math.floor(xs.length * 0.05)] : 0;
    const mid = xs.length ? xs[Math.floor(xs.length / 2)] : 0;
    res.noBeatScore = frac;
    res.noBeat = frac > 0.05 && span > 0.18 && Math.abs(mid - 0.5) < 0.06;
  }
  const inBtn = (g) => res.buttons.some((b) => g.x + g.w / 2 > b.x && g.x + g.w / 2 < b.x + b.w && g.y + g.h / 2 > b.y && g.y + g.h / 2 < b.y + b.h);
  // hand: lower part of the window
  res.handGlyphs = readRow(0.0, Math.min(0.625, handBand[0] - 0.005), 1.0, Math.max(0.99, handBand[1] + 0.19), HAND_SIZE, 80);
  // opponents' latest plays (upper table area), left / right of centre
  const onCard = (g) => { if (g.noCardCheck) return true;
    let good = 0, tot = 0;
    for (const k of [2.5, 2.8]) {
      const y = Math.round(g.y + g.h * k);
      if (y >= img.height) continue;
      for (let x = g.x; x < g.x + g.w; x++) {
        const i = (y * img.width + x) * 4, r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2];
        tot++; if ((Math.max(r, gg, b) - Math.min(r, gg, b) < 60 && lumOf(r, gg, b) > 140) || isRed(r, gg, b) || lumOf(r, gg, b) < 60) good++;
      }
    }
    return tot > 0 && good / tot > 0.6;
  };
  const readCards = (u0, u1) => {
    const box = findTableCards(img, tb, u0, u1);
    if (!box) return [];
    const gl = findGlyphs(img, tb, box, TABLE_SIZE, { minBg: 150, hand: false, darkK: 0.76, redK: 18, dbgInk: debug ? (res.inks = res.inks || []) : null });
    for (const g of gl) if (!g.joker) Object.assign(g, classify(g, templates.filter((t) => t.size === 'table')));
    gl.sort((a, b) => a.x - b.x);
    if (debug) res.dbg[`cards${u0}`] = { reg: box, gl };
    return gl;
  };
  res.leftGlyphs = readCards(0.12, 0.49);
  res.rightGlyphs = readCards(0.51, 0.87);
  const plausible = (g) => g.joker || g.aspect < 1.15 && (!templates.length || g.dist < 0.09);
  // a white chat bubble looks like a card face, but its text gives mostly implausible "glyphs"
  const keep = (gl) => { const good = gl.filter((g) => plausible(g) && onCard(g)); return gl.length >= 3 && good.length < gl.length * 0.5 ? [] : good; };
  if (debug) res.rawTable = { left: res.leftGlyphs.map((g) => `${g.label}/${(g.dist ?? 0).toFixed(3)}/${(g.aspect ?? 0).toFixed(2)}`), right: res.rightGlyphs.map((g) => `${g.label}/${(g.dist ?? 0).toFixed(3)}/${(g.aspect ?? 0).toFixed(2)}`) };
  res.leftGlyphs = keep(res.leftGlyphs);
  res.rightGlyphs = keep(res.rightGlyphs);
  // 不出 tags
  res.leftPass = countPixels(img, rectOf(tb, img, 0.15, 0.04, 0.48, 0.26), isPink) > 0.02;
  res.rightPass = countPixels(img, rectOf(tb, img, 0.52, 0.04, 0.85, 0.26), isPink) > 0.02;
  res.handGlyphs = res.handGlyphs.filter((g) => !inBtn(g));
  // landlord badge: yellow-green "地主" text + jester hat above an avatar
  const badgeCol = (r, g, b) => (g > 140 && b < 110 && g >= r - 20 && g - b > 60) || (r > 200 && g > 150 && b < 90 && r - b > 130);
  // the opponents' corner (avatar, badge, count bubble) and the bottom-card panel hang from the
  // window's top edge: measure how far the count bubbles sit from where they are in a 16:10-ish window
  const bubbleSearch = { left: [0.09, 0.25, -0.2, 0.06], right: [0.75, 0.91, -0.2, 0.06], me: [0.09, 0.25, 0.28, 0.5] };
  const bubbleAt = {};
  for (const seat of Object.keys(bubbleSearch)) { const [a0, a1, b0, b1] = bubbleSearch[seat]; bubbleAt[seat] = findCountBubble(img, tb, a0, a1, b0, b1); }
  const shifts = ['left', 'right'].filter((s) => bubbleAt[s]).map((s) => tb.toNorm(bubbleAt[s].x, bubbleAt[s].y).v - SEAT_POS.count[s][1]);
  const topShift = shifts.length ? Math.max(-0.15, Math.min(0.05, shifts.reduce((a, b) => a + b, 0) / shifts.length)) : 0;
  res.topShift = topShift;
  res.badge = {
    left: countPixels(img, rectOf(tb, img, 0.0, -0.165 + topShift, 0.13, -0.10 + topShift), badgeCol, 1),
    right: countPixels(img, rectOf(tb, img, 0.87, -0.165 + topShift, 1.0, -0.10 + topShift), badgeCol, 1),
    me: countPixels(img, rectOf(tb, img, 0.0, 0.23, 0.13, 0.33), badgeCol, 1),
  };
  res.bottom = bottomState(img, tb, topShift);
  res.mission = missionTpl ? readMission(img, tb, missionTpl, topShift) : null;
  // bidding banner: yellow-green 「叫地主」 (nobody has called yet) vs teal 「搶地主」 (robbing doubles the stakes)
  {
    const reg = rectOf(tb, img, 0.33, 0.10, 0.67, 0.32);
    const yg = countPixels(img, reg, (r, g, b) => g > 150 && r > 120 && b < 110 && g - b > 80, 2);
    const tl = countPixels(img, reg, (r, g, b) => g > 140 && b > 120 && r < 140 && g - r > 40, 2);
    res.bidKind = tl > 0.04 && tl > yg * 3 ? 'rob' : yg > 0.04 ? 'call' : null;
  }
  res.timer = timerScores(img, tb);
  res.myTimer = myTimer(img, tb);
  const digitT = templates.filter((t) => t.size === 'digit');
  res.counts = {};
  for (const [seat, [u, v]] of Object.entries(SEAT_POS.count)) {
    const at = bubbleAt[seat];
    res.counts[seat] = readCount(img, tb, u, v, digitT, at);
    if (at && res.counts[seat]) res.counts[seat].at = at;
  }
  return res;
}

// ---------- 任務場 mission banner: 「最後手牌以<牌型>勝利，倍數x<N>」 ----------
// White text with the card type and the multiplier in yellow, centred above the rail.
const isYellowText = (r, g, b) => r > 190 && g > 195 && b < 120 && g >= r - 22 && r - b > 100; // lemon yellow, not the hall's gold
const isWhiteText = (r, g, b) => lumOf(r, g, b) > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 50;

// area-averaged coverage of a binary mask inside a box, on an R x C grid
function gridOf(mask, w, box, R, C) {
  const out = new Array(R * C).fill(0);
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  for (let gy = 0; gy < R; gy++) for (let gx = 0; gx < C; gx++) {
    const ya = box.y0 + (gy * bh) / R, yb = box.y0 + ((gy + 1) * bh) / R;
    const xa = box.x0 + (gx * bw) / C, xb = box.x0 + ((gx + 1) * bw) / C;
    let s = 0, n = 0;
    for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y++)
      for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x++) {
        const wy = Math.min(yb, y + 1) - Math.max(ya, y), wx = Math.min(xb, x + 1) - Math.max(xa, x);
        const wt = Math.max(0.05, wy) * Math.max(0.05, wx);
        s += (mask[y * w + x] ? 1 : 0) * wt; n += wt;
      }
    out[gy * C + gx] = n ? s / n : 0;
  }
  return out;
}
export function classifyShape(mask, w, box, tpls) {
  const asp = (box.x1 - box.x0) / Math.max(1, box.y1 - box.y0);
  let best = null, bestD = Infinity, second = Infinity;
  for (const t of tpls) {
    const g = gridOf(mask, w, box, t.R, t.C);
    let d = 0; for (let i = 0; i < g.length; i++) { const e = g[i] - t.vec[i]; d += e * e; }
    d = d / g.length + 0.05 * Math.log(asp / t.aspect) ** 2;
    if (d < bestD) { if (best && best.label !== t.label) second = bestD; bestD = d; best = t; }
    else if (best && t.label !== best.label && d < second) second = d;
  }
  return { label: best ? best.label : null, dist: bestD, margin: second - bestD };
}
// tight box of mask pixels inside a box
function tightBox(mask, w, b) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) if (mask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export function readMission(img, tb, tpl, topShift = 0, debug = false) {
  if (!tpl || !tpl.words) return null;
  const reg = rectOf(tb, img, 0.2, -0.34 + Math.min(0, topShift), 0.8, -0.015);
  const w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
  if (w < 40 || h < 10) return null;
  const Y = new Uint8Array(w * h), Wt = new Uint8Array(w * h);
  const cy = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + reg.y0) * img.width + x + reg.x0) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (isYellowText(r, g, b)) { Y[y * w + x] = 1; cy[y]++; } else if (isWhiteText(r, g, b)) Wt[y * w + x] = 1;
  }
  const T = tb.T, minRow = Math.max(2, w * 0.003);
  // bands of rows that contain yellow text
  const bands = [];
  for (let y = 0; y < h; y++) {
    if (cy[y] < minRow) continue;
    const last = bands[bands.length - 1];
    if (last && y - last.y1 <= Math.max(2, T * 0.006)) last.y1 = y + 1; else bands.push({ y0: y, y1: y + 1 });
  }
  const colSegs = (mask, y0, y1, gap) => {
    const segs = [];
    for (let x = 0; x < w; x++) {
      let on = false; for (let y = y0; y < y1 && !on; y++) if (mask[y * w + x]) on = true;
      if (!on) continue;
      const last = segs[segs.length - 1];
      if (last && x - last.x1 <= gap) last.x1 = x + 1; else segs.push({ x0: x, x1: x + 1 });
    }
    return segs;
  };
  let found = null;
  for (const b of bands) {
    const th = b.y1 - b.y0;
    if (th < T * 0.018 || th > T * 0.09) continue;
    const y0 = Math.max(0, Math.round(b.y0 - th * 0.15)), y1 = Math.min(h, Math.round(b.y1 + th * 0.15));
    const ys = colSegs(Y, y0, y1, th * 0.55).filter((s) => s.x1 - s.x0 > th * 0.3);
    if (ys.length < 2) continue;
    const typeSeg = ys[0], multSeg = ys[ys.length - 1];
    // white words before the type ("最後手牌以") and between it and the multiplier ("勝利，倍數")
    const whiteIn = (xa, xb) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = Math.max(0, xa); x < Math.min(w, xb); x++) n += Wt[y * w + x]; return n / Math.max(1, (xb - xa) * (y1 - y0)); };
    const before = whiteIn(typeSeg.x0 - th * 5, typeSeg.x0), between = whiteIn(typeSeg.x1, multSeg.x0);
    const span = (multSeg.x1 - (typeSeg.x0 - th * 5)) / w;
    if (before < 0.08 || between < 0.06 || multSeg.x0 - typeSeg.x1 < th * 2.5 || span < 0.3) continue;
    found = { y0, y1, th, typeSeg, multSeg, before, between };
    break;
  }
  if (!found) return null;
  const { y0, y1, th, typeSeg, multSeg } = found;
  const tbox = tightBox(Y, w, { x0: typeSeg.x0, x1: typeSeg.x1, y0, y1 });
  const word = classifyShape(Y, w, tbox, tpl.words);
  // multiplier: "x" then digit(s)
  const mbox = { x0: multSeg.x0, x1: multSeg.x1, y0, y1 };
  const lab = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = mbox.x0; x < mbox.x1; x++) lab[y * w + x] = Y[y * w + x];
  const { comps } = components(lab, w, h, mbox.x0, y0, mbox.x1, y1);
  const parts = comps.filter((c) => c.n > th * th * 0.02).sort((a, b) => a.x - b.x);
  // the first glyph is always the "x"; at low resolution it can be as tall as the digits
  let digitsC = parts.slice(1);
  if (parts.length === 1) {
    // "x" and digit touching: cut at the emptiest column in the left half
    const c = parts[0];
    let bestX = -1, bestN = Infinity;
    for (let x = c.x + Math.round(c.w * 0.25); x < c.x + Math.round(c.w * 0.6); x++) {
      let n = 0; for (let y = c.y; y < c.y + c.h; y++) n += lab[y * w + x] ? 1 : 0;
      if (n < bestN) { bestN = n; bestX = x; }
    }
    digitsC = bestX > 0 ? [{ x: bestX + 1, y: c.y, w: c.x + c.w - bestX - 1, h: c.h }] : [];
  }
  const tall = Math.max(...digitsC.map((c) => c.h), 1);
  digitsC = digitsC.filter((c) => c.h > tall * 0.6);
  // overlapping columns belong to one digit
  const digits = [];
  for (const c of digitsC) { const d = digits[digits.length - 1]; if (d && c.x < d.x1) { d.x1 = Math.max(d.x1, c.x + c.w); d.y0 = Math.min(d.y0, c.y); d.y1 = Math.max(d.y1, c.y + c.h); } else digits.push({ x0: c.x, x1: c.x + c.w, y0: c.y, y1: c.y + c.h }); }
  const dres = digits.map((d) => classifyShape(Y, w, d, tpl.digits));
  const mult = dres.length && dres.every((d) => d.label != null) ? Number(dres.map((d) => d.label).join('')) : null;
  const out = { word: word.label, wordDist: word.dist, wordMargin: word.margin, mult, multDist: dres.length ? Math.max(...dres.map((d) => d.dist)) : 1,
    multMargin: dres.length ? Math.min(...dres.map((d) => d.margin)) : 0 };
  out.ok = out.word != null && word.dist < 0.14 && word.margin > 0.04 && mult != null && mult >= 2 && mult <= 20 && out.multDist < 0.25 && out.multMargin > 0.04;
  if (debug) Object.assign(out, { reg, found, tbox, digits });
  return out;
}
