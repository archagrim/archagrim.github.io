// Atelier 3D : découpe d'un modèle en deux pièces par un plan, avec tenons ou goupilles pour les réassembler.
// Utilisé par la page (aperçu de la coupe, placement des tenons) et par le lecteur en arrière-plan (découpe complète).
// Repère : celui de l'affichage (Y vers le haut, millimètres du modèle). Le plan est { n: normale unitaire, c } : n·p = c.
// La pièce A est du côté de la normale (n·p > c), la pièce B de l'autre côté.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Deux axes (u, v) dans le plan, avec u × v = n
export function planeBasis(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const h = ay < 0.9 ? [0, 1, 0] : ax < az ? [1, 0, 0] : [0, 0, 1];
  const u = unit(crossV(h, n));
  const v = crossV(n, u);
  return { u, v };
}

// Coupe d'un maillage par un plan. Les sommets à moins d'un rien du plan sont considérés « sur le plan » :
// ils servent tels quels aux deux pièces (aucun point de coupe en double, aucun triangle aplati).
// keep : garder les triangles de chaque côté (sinon, seulement les bords de la coupe, pour l'aperçu).
// Renvoie les triangles A et B, les points ajoutés, et pour chaque pièce les contours de sa face de coupe,
// déjà dans le sens de cette face.
function planeCut(pos, idx, n, c, col, keep) {
  const V = pos.length / 3, T = idx.length / 3;
  let big = 1;
  for (let i = 0; i < pos.length; i++) { const a = Math.abs(pos[i]); if (a > big) big = a; }
  const eps = big * 2e-7;
  const side = new Int8Array(V);
  for (let i = 0; i < V; i++) {
    const dd = pos[i * 3] * n[0] + pos[i * 3 + 1] * n[1] + pos[i * 3 + 2] * n[2] - c;
    side[i] = dd > eps ? 1 : dd < -eps ? -1 : 0;
  }
  // sens du modèle (normales vers l'extérieur ou à l'envers) : les faces ajoutées le suivent
  let vol = 0;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, e = idx[t * 3 + 2] * 3;
    vol += pos[a] * (pos[b + 1] * pos[e + 2] - pos[b + 2] * pos[e + 1]) - pos[a + 1] * (pos[b] * pos[e + 2] - pos[b + 2] * pos[e]) + pos[a + 2] * (pos[b] * pos[e + 1] - pos[b + 1] * pos[e]);
  }
  const inv = vol < 0 ? -1 : 1;
  const P = [], C = [];
  const at = new Map();
  const dist = (i) => pos[i * 3] * n[0] + pos[i * 3 + 1] * n[1] + pos[i * 3 + 2] * n[2] - c;
  const cut = (i, j) => {
    const key = i < j ? i * V + j : j * V + i;
    let id = at.get(key);
    if (id !== undefined) return id;
    const di = dist(i), dj = dist(j), t = di / (di - dj);
    P.push(pos[i * 3] + t * (pos[j * 3] - pos[i * 3]), pos[i * 3 + 1] + t * (pos[j * 3 + 1] - pos[i * 3 + 1]), pos[i * 3 + 2] + t * (pos[j * 3 + 2] - pos[i * 3 + 2]));
    if (col) for (let k = 0; k < 3; k++) C.push(Math.round(col[i * 3 + k] + t * (col[j * 3 + k] - col[i * 3 + k])));
    id = V + P.length / 3 - 1;
    at.set(key, id);
    return id;
  };
  const onPlane = (id) => id >= V || side[id] === 0;
  // bords de coupe de chaque pièce : arêtes posées sur le plan ; deux triangles qui en partagent une l'annulent
  const edges = [new Map(), new Map()];
  const triA = [], triB = [];
  const put = (k, a, b, e) => {
    if (keep) (k ? triB : triA).push(a, b, e);
    const E = edges[k];
    for (const [x, w] of [[a, b], [b, e], [e, a]]) {
      if (!onPlane(x) || !onPlane(w)) continue;
      const rev = w * 1e8 + x;
      if (E.has(rev)) E.delete(rev); else E.set(x * 1e8 + w, [x, w]);
    }
  };
  for (let t = 0; t < T; t++) {
    const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const sg = [side[v[0]], side[v[1]], side[v[2]]];
    const np = (sg[0] > 0) + (sg[1] > 0) + (sg[2] > 0), nn = (sg[0] < 0) + (sg[1] < 0) + (sg[2] < 0);
    if (!nn && np) { put(0, v[0], v[1], v[2]); continue; }
    if (!np && nn) { put(1, v[0], v[1], v[2]); continue; }
    if (!np && !nn) {
      // triangle posé sur le plan : il revient à la pièce qui est sous sa face
      const a = v[0] * 3, b = v[1] * 3, e = v[2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const wx = pos[e] - pos[a], wy = pos[e + 1] - pos[a + 1], wz = pos[e + 2] - pos[a + 2];
      const dn = ((uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2]) * inv;
      put(dn > 0 ? 1 : 0, v[0], v[1], v[2]);
      continue;
    }
    if (np + nn === 3) {
      // un sommet seul de son côté : un triangle d'un côté, un quadrilatère de l'autre
      const lone = np === 1 ? sg.findIndex(x => x > 0) : sg.findIndex(x => x < 0);
      const p = v[lone], q = v[(lone + 1) % 3], r = v[(lone + 2) % 3];
      const pq = cut(p, q), pr = cut(p, r);
      const one = np === 1 ? 0 : 1;
      put(one, p, pq, pr);
      put(1 - one, pq, q, r); put(1 - one, pq, r, pr);
      continue;
    }
    // un sommet sur le plan, un de chaque côté : deux triangles qui partent de ce sommet
    const z = sg.findIndex(x => x === 0);
    const a = v[z], b = v[(z + 1) % 3], e = v[(z + 2) % 3];
    const x = cut(b, e);
    put(side[b] > 0 ? 0 : 1, a, b, x);
    put(side[e] > 0 ? 0 : 1, a, x, e);
  }
  // contours : les bords restants, parcourus à l'envers (sens de la face de coupe de chaque pièce)
  const loopsOf = (E) => {
    const seg = new Map();
    for (const [x, w] of E.values()) { let l = seg.get(w); if (!l) seg.set(w, l = []); l.push(x); }
    return chain(seg);
  };
  const la = loopsOf(edges[0]), lb = loopsOf(edges[1]);
  return { V, P, C, triA, triB, loopsA: la.loops, loopsB: lb.loops, open: la.open + lb.open, inv,
    all: (i) => (i < V ? [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] : [P[(i - V) * 3], P[(i - V) * 3 + 1], P[(i - V) * 3 + 2]]) };
}

// Relie les segments de la coupe en contours fermés (listes d'identifiants de points)
function chain(seg) {
  const loops = [];
  let open = 0;
  for (const start of seg.keys()) {
    const out = seg.get(start);
    while (out.length) {
      const loop = [start];
      let next = out.pop(), closed = false;
      while (loop.length < 5e6) {
        if (next === start) { closed = true; break; }
        loop.push(next);
        const l = seg.get(next);
        if (!l || !l.length) break;
        next = l.pop();
      }
      if (closed && loop.length >= 3) loops.push(loop); else open++;
    }
  }
  return { loops, open };
}

function pointInPoly(x, y, P) {
  let c = false;
  for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) {
    const ax = P[i], ay = P[i + 1], bx = P[j], by = P[j + 1];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) c = !c;
  }
  return c;
}
function polyArea(P) {
  let a = 0;
  for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) a += P[j] * P[i + 1] - P[i] * P[j + 1];
  return a / 2;
}
// Distance d'un point au bord le plus proche d'un contour
function edgeDist(x, y, P) {
  let best = Infinity;
  for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) {
    const ax = P[j], ay = P[j + 1], bx = P[i], by = P[i + 1];
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + t * ex - x, dy = ay + t * ey - y, dd = dx * dx + dy * dy;
    if (dd < best) best = dd;
  }
  return Math.sqrt(best);
}

// Îlots de la coupe : un contour extérieur et ses trous (rangés par imbrication, quel que soit le sens des contours)
function islandsOf(P2) {
  const k = P2.length, depth = new Array(k).fill(0), parent = new Array(k).fill(-1), area = P2.map(p => Math.abs(polyArea(p)));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if (i === j || area[j] <= area[i]) continue;
      if (pointInPoly(P2[i][0], P2[i][1], P2[j])) {
        depth[i]++;
        if (parent[i] < 0 || area[j] < area[parent[i]]) parent[i] = j;
      }
    }
  }
  const islands = [];
  const at = new Map();
  for (let i = 0; i < k; i++) if (depth[i] % 2 === 0) { at.set(i, islands.length); islands.push({ outer: i, holes: [], area: area[i] }); }
  for (let i = 0; i < k; i++) if (depth[i] % 2 === 1 && at.has(parent[i])) { const isl = islands[at.get(parent[i])]; isl.holes.push(i); isl.area -= area[i]; }
  return islands;
}

// Coupe seule (pour l'aperçu) : contours en 2D dans le plan, îlots
export function section(pos, idx, n, c) {
  const { u, v } = planeBasis(n);
  const k = planeCut(pos, idx, n, c, null, false);
  const P2 = k.loopsA.map(l => { const F = new Float64Array(l.length * 2); l.forEach((id, i) => { const p = k.all(id); F[i * 2] = dot(p, u); F[i * 2 + 1] = dot(p, v); }); return F; });
  return { n, c, u, v, loops: P2, islands: islandsOf(P2), open: k.open };
}

// Étendue du modèle le long d'une direction (pour le curseur de position du plan)
export function extent(pos, n) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const s = pos[i] * n[0] + pos[i + 1] * n[1] + pos[i + 2] * n[2];
    if (s < lo) lo = s; if (s > hi) hi = s;
  }
  return [lo, hi];
}

class Pt { constructor(x, y) { this.x = x; this.y = y; } equals(o) { return o.x === this.x && o.y === this.y; } }

// Rayon de l'empreinte d'un tenon (le carré compte par sa diagonale)
const reach = (shape, r) => (shape === 'square' ? r * Math.SQRT2 : r);

// Place des tenons au cœur de chaque îlot assez grand (point le plus éloigné des bords), deux si l'îlot est long
export function autoConnectors(sec, opt) {
  const need = reach(opt.shape, opt.d / 2 + opt.gap / 2) + opt.wall;
  const out = [];
  for (const isl of sec.islands) {
    const polys = [sec.loops[isl.outer], ...isl.holes.map(h => sec.loops[h])];
    const O = polys[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < O.length; i += 2) { if (O[i] < x0) x0 = O[i]; if (O[i] > x1) x1 = O[i]; if (O[i + 1] < y0) y0 = O[i + 1]; if (O[i + 1] > y1) y1 = O[i + 1]; }
    const clear = (x, y) => {
      if (!pointInPoly(x, y, O)) return -1;
      for (let k = 1; k < polys.length; k++) if (pointInPoly(x, y, polys[k])) return -1;
      let m = Infinity;
      for (const P of polys) m = Math.min(m, edgeDist(x, y, P));
      return m;
    };
    // meilleur point d'une zone : grille, puis affinage autour du meilleur
    const best = (cx, cy, half, steps, keep) => {
      let bx = cx, by = cy, bd = keep ? clear(cx, cy) : -1;
      let h = half;
      for (let round = 0; round < 3; round++) {
        const step = (2 * h) / steps, sx = bx, sy = by;
        for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
          const x = sx - h + i * step, y = sy - h + j * step;
          const dd = clear(x, y);
          if (dd > bd) { bd = dd; bx = x; by = y; }
        }
        h = step;
      }
      return [bx, by, bd];
    };
    const [px, py, pd] = best((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2, 28, false);
    if (pd < need) continue;
    // axe principal de l'îlot : deux tenons s'il est assez long (une pièce ne peut alors plus tourner)
    let mx = 0, my = 0, n = O.length / 2;
    for (let i = 0; i < O.length; i += 2) { mx += O[i]; my += O[i + 1]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < O.length; i += 2) { const dx = O[i] - mx, dy = O[i + 1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ex = Math.cos(ang), ey = Math.sin(ang);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < O.length; i += 2) { const s = (O[i] - mx) * ex + (O[i + 1] - my) * ey; if (s < lo) lo = s; if (s > hi) hi = s; }
    const len = hi - lo;
    const two = [];
    if (len > Math.max(6 * need, 5 * opt.d)) {
      for (const f of [0.28, 0.72]) {
        const s = lo + f * len;
        const q = best(mx + ex * s, my + ey * s, len * 0.12, 10, true);
        if (q[2] >= need) two.push(q);
      }
    }
    if (two.length === 2 && Math.hypot(two[0][0] - two[1][0], two[0][1] - two[1][1]) > 2 * need) for (const q of two) out.push([q[0], q[1]]);
    else out.push([px, py]);
  }
  return out;
}

// Vérifie un tenon (u, v) : dans un îlot et assez loin des bords. Renvoie l'îlot ou -1.
export function connectorIsland(sec, x, y, opt) {
  const need = reach(opt.shape, opt.d / 2 + opt.gap / 2) + opt.wall;
  for (let k = 0; k < sec.islands.length; k++) {
    const isl = sec.islands[k];
    const O = sec.loops[isl.outer];
    if (!pointInPoly(x, y, O)) continue;
    if (isl.holes.some(h => pointInPoly(x, y, sec.loops[h]))) return -1;
    let m = edgeDist(x, y, O);
    for (const h of isl.holes) m = Math.min(m, edgeDist(x, y, sec.loops[h]));
    return m >= need ? k : -1;
  }
  return -1;
}

// Profil d'un tenon autour de (0, 0) : cercle ou carré, dans le sens trigonométrique
const segs = (r) => Math.max(16, Math.min(64, Math.ceil(2 * Math.PI * r / 0.35)));
function profile(shape, r, N = segs(r)) {
  if (shape === 'square') return [[r, -r], [r, r], [-r, r], [-r, -r]];
  const out = [];
  for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; out.push([r * Math.cos(a), r * Math.sin(a)]); }
  return out;
}

// Distance jusqu'à la paroi du modèle depuis o, le long de dir (premier triangle touché parmi tris), Infinity sinon
function rayHit(pos, idx, tris, o, dir) {
  let best = Infinity;
  for (const t of tris) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = o[0] - pos[a], ty = o[1] - pos[a + 1], tz = o[2] - pos[a + 2];
    const uu = (tx * px + ty * py + tz * pz) * inv;
    if (uu < 0 || uu > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const vv = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (vv < 0 || uu + vv > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-4 && dist < best) best = dist;
  }
  return best;
}

// ---------- Découpe complète ----------
// src : { pos, idx, col? } ; plane : { n, c } ; conns : [[u, v], …] ; opt :
//   kind 'peg' (tenon d'un côté, trou de l'autre) | 'dowel' (trous des deux côtés et goupilles à part) | 'none'
//   shape 'round' | 'square', d (diamètre), h (longueur), gap (jeu sur le diamètre), wall (paroi mini), flip (tenon sur A)
// Renvoie { parts: [A, B, goupilles?], warn: [...], placed, open }
export function splitMesh(src, plane, conns, opt, ShapeUtils) {
  const { pos, idx } = src, col = src.col || null;
  const n = unit(plane.n), c = plane.c;
  const { u, v } = planeBasis(n);
  const warn = [];
  const k0 = planeCut(pos, idx, n, c, col, true);
  const { V, P, C, triA, triB, inv } = k0;
  const loops = k0.loopsA, loopsB = k0.loopsB, open = k0.open;
  const T = idx.length / 3;
  if (open) warn.push('open');
  // sommets ajoutés après ceux du modèle et les points de coupe : ceux des tenons
  const newV = (x, y, z, rgb) => { P.push(x, y, z); if (col) C.push(rgb ? rgb[0] : 255, rgb ? rgb[1] : 255, rgb ? rgb[2] : 255); return V + P.length / 3 - 1; };
  const all = (i) => (i < V ? [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] : [P[(i - V) * 3], P[(i - V) * 3 + 1], P[(i - V) * 3 + 2]]);
  const to2 = (p3) => [dot(p3, u), dot(p3, v)];
  const from2 = (x, y, off) => [n[0] * (c + off) + u[0] * x + v[0] * y, n[1] * (c + off) + u[1] * x + v[1] * y, n[2] * (c + off) + u[2] * x + v[2] * y];
  const to2F = (ls) => ls.map(l => { const F = new Float64Array(l.length * 2); l.forEach((id, i) => { const q = to2(all(id)); F[i * 2] = q[0]; F[i * 2 + 1] = q[1]; }); return F; });
  const L2 = to2F(loops), L2B = to2F(loopsB);
  const islands = islandsOf(L2), islandsB = islandsOf(L2B);
  const sec = { loops: L2, islands }, secB = { loops: L2B, islands: islandsB };

  // tenons retenus : dans un îlot, assez loin des bords, assez de matière derrière
  const kind = opt.kind || 'none';
  const r = opt.d / 2, gap = Math.max(0, opt.gap || 0), rh = r + gap / 2, wall = opt.wall || 1;
  const ch = Math.min(0.4, r * 0.25);              // chanfrein en bout de tenon, pour qu'il entre facilement
  const extraDepth = 0.3;                            // fond du trou un peu plus profond que le tenon
  const placed = [];
  if (kind !== 'none' && conns.length) {
    const chk = { shape: opt.shape, d: opt.d, gap, wall };
    // coordonnées de chaque sommet dans le plan : on ne teste que les triangles autour de chaque tenon
    const pu = new Float32Array(V), pv = new Float32Array(V);
    for (let i = 0; i < V; i++) { pu[i] = pos[i * 3] * u[0] + pos[i * 3 + 1] * u[1] + pos[i * 3 + 2] * u[2]; pv[i] = pos[i * 3] * v[0] + pos[i * 3 + 1] * v[1] + pos[i * 3 + 2] * v[2]; }
    const near = (x, y, R) => {
      const list = [];
      for (let t = 0; t < T; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], e = idx[t * 3 + 2];
        if (Math.max(pu[a], pu[b], pu[e]) < x - R || Math.min(pu[a], pu[b], pu[e]) > x + R) continue;
        if (Math.max(pv[a], pv[b], pv[e]) < y - R || Math.min(pv[a], pv[b], pv[e]) > y + R) continue;
        list.push(t);
      }
      return list;
    };
    for (const [x, y] of conns) {
      const k = connectorIsland(sec, x, y, chk);
      if (k < 0) { warn.push('edge'); continue; }
      // matière disponible de chaque côté (rayons au centre et au bord du trou)
      const ring = profile('round', reach(opt.shape, rh) * 0.95);
      const probe = [[0, 0], ...ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 6)) === 0)];
      const tris = near(x, y, reach(opt.shape, rh) + 0.5);
      let upA = Infinity, upB = Infinity;
      for (const [dx, dy] of probe) {
        const o = from2(x + dx, y + dy, 0);
        upA = Math.min(upA, rayHit(pos, idx, tris, o, n));
        upB = Math.min(upB, rayHit(pos, idx, tris, o, [-n[0], -n[1], -n[2]]));
      }
      let h = opt.h;
      if (kind === 'peg') {
        const room = (opt.flip ? upB : upA) - wall - extraDepth;
        if (room < h) { if (room < 1.2) { warn.push('thin'); continue; } h = Math.floor(room * 10) / 10; warn.push('short'); }
        placed.push({ x, y, h });
      } else {
        const room = Math.min(upA, upB) - wall - extraDepth;
        let half = h / 2;
        if (room < half) { if (room < 1.2) { warn.push('thin'); continue; } half = Math.floor(room * 10) / 10; warn.push('short'); }
        placed.push({ x, y, h: half * 2 });
      }
    }
  }

  // pièces : triangles, puis faces de coupe et tenons
  const flip = !!opt.flip;
  const pegOn = kind === 'peg' ? (flip ? 'A' : 'B') : null;
  const build = (side) => {
    const tri = side === 'A' ? triA : triB;
    const out = tri.slice();
    const sgn = side === 'A' ? 1 : -1;              // la pièce A s'étend vers +n
    const capN = side === 'A' ? [-n[0], -n[1], -n[2]] : n;   // la face de coupe regarde vers l'autre pièce
    const face = (a, b, e, want) => {
      const pa = all(a), pb = all(b), pe = all(e);
      const nn = crossV([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pe[0] - pa[0], pe[1] - pa[1], pe[2] - pa[2]]);
      if (dot(nn, want) * inv < 0) out.push(a, e, b); else out.push(a, b, e);
    };
    // empreinte de chaque tenon dans la face de coupe : tenon qui sort (rayon r) ou trou (rayon rh)
    const holesByIsland = new Map();
    for (const pc of placed) {
      const isPeg = pegOn === side;
      const rad = isPeg ? r : rh;
      const prof = profile(opt.shape, rad);
      const ring0 = prof.map(([dx, dy]) => newV(...from2(pc.x + dx, pc.y + dy, 0)));
      const ki = connectorIsland(side === 'A' ? sec : secB, pc.x, pc.y, { shape: opt.shape, d: 0, gap: 0, wall: 0 });
      if (!holesByIsland.has(ki)) holesByIsland.set(ki, []);
      holesByIsland.get(ki).push({ ids: ring0, pts: prof.map(([dx, dy]) => [pc.x + dx, pc.y + dy]) });
      // tube et fond : tenon vers l'autre pièce, ou trou vers l'intérieur de cette pièce
      const len = isPeg ? pc.h : kind === 'dowel' ? pc.h / 2 + extraDepth : pc.h + extraDepth;
      const dir = isPeg ? -sgn : sgn;                // un tenon sort de la pièce, un trou y entre
      const rings = [ring0];
      const radial = isPeg ? 1 : -1;                 // normale des parois : vers l'extérieur (tenon) ou vers l'axe (trou)
      if (isPeg && ch > 0) {
        const inner = profile(opt.shape, rad - ch, prof.length);
        rings.push(prof.map(([dx, dy]) => newV(...from2(pc.x + dx, pc.y + dy, dir * (len - ch)))));
        rings.push(inner.map(([dx, dy]) => newV(...from2(pc.x + dx, pc.y + dy, dir * len))));
      } else {
        rings.push(prof.map(([dx, dy]) => newV(...from2(pc.x + dx, pc.y + dy, dir * len))));
      }
      const axisAt = (off) => from2(pc.x, pc.y, off);
      for (let q = 0; q + 1 < rings.length; q++) {
        const A0 = rings[q], A1 = rings[q + 1], m = A0.length;
        for (let i = 0; i < m; i++) {
          const a = A0[i], b = A0[(i + 1) % m], e = A1[i], f = A1[(i + 1) % m];
          const mid = all(a), ax = axisAt(dot(mid, n) - c);
          const want = [(mid[0] - ax[0]) * radial, (mid[1] - ax[1]) * radial, (mid[2] - ax[2]) * radial];
          face(a, b, e, want); face(b, f, e, want);
        }
      }
      const last = rings[rings.length - 1];
      const cen = newV(...from2(pc.x, pc.y, dir * len));
      // bout du tenon : vers l'autre pièce ; fond du trou : vers l'ouverture
      const capWant = isPeg ? [n[0] * dir, n[1] * dir, n[2] * dir] : [-n[0] * dir, -n[1] * dir, -n[2] * dir];
      for (let i = 0; i < last.length; i++) face(cen, last[i], last[(i + 1) % last.length], capWant);
    }
    // faces de coupe : chaque îlot avec ses trous (ceux du modèle et ceux des tenons)
    const LS = side === 'A' ? loops : loopsB, LF = side === 'A' ? L2 : L2B;
    (side === 'A' ? islands : islandsB).forEach((isl, ki) => {
      const contour = LS[isl.outer], holes = isl.holes.map(h => LS[h]);
      const conn = holesByIsland.get(ki) || [];
      const toV2 = (F) => { const out2 = []; for (let i = 0; i < F.length; i += 2) out2.push(new Pt(F[i], F[i + 1])); return out2; };
      const cpts = toV2(LF[isl.outer]);
      const hpts = isl.holes.map(h => toV2(LF[h])).concat(conn.map(cn => cn.pts.map(([x, y]) => new Pt(x, y))));
      const idLists = [contour, ...holes, ...conn.map(cn => cn.ids)];
      let faces;
      try { faces = ShapeUtils.triangulateShape(cpts, hpts); } catch (e) { warn.push('cap'); return; }
      const ids = [contour.slice(0, cpts.length), ...hpts.map((h, i) => idLists[i + 1].slice(0, h.length))].flat();
      for (const f of faces) {
        const a = ids[f[0]], b = ids[f[1]], e = ids[f[2]];
        if (a === undefined || b === undefined || e === undefined) continue;
        face(a, b, e, capN);
      }
    });
    return out;
  };
  const outA = build('A'), outB = build('B');

  // goupilles : petits cylindres à part, rangés à leur place (dans les trous) pour l'assemblage
  const pins = [];
  if (kind === 'dowel') {
    const rp = r, chp = Math.min(0.3, rp * 0.2);
    for (const pc of placed) {
      const L = pc.h - 0.2;                          // un peu plus courte que les deux trous réunis
      const pf = profile(opt.shape, rp), pi = profile(opt.shape, rp - chp, pf.length);
      const lv = [[pi, -L / 2], [pf, -L / 2 + chp], [pf, L / 2 - chp], [pi, L / 2]];
      const rings = lv.map(([pr, off]) => pr.map(([dx, dy]) => newV(...from2(pc.x + dx, pc.y + dy, off))));
      const face = (a, b, e, want) => {
        const pa = all(a), pb = all(b), pe = all(e);
        const nn = crossV([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pe[0] - pa[0], pe[1] - pa[1], pe[2] - pa[2]]);
        if (dot(nn, want) < 0) pins.push(a, e, b); else pins.push(a, b, e);
      };
      for (let q = 0; q + 1 < rings.length; q++) {
        const A0 = rings[q], A1 = rings[q + 1], m = A0.length;
        for (let i = 0; i < m; i++) {
          const a = A0[i], b = A0[(i + 1) % m], e = A1[i], f = A1[(i + 1) % m];
          const mid = all(a), ax = from2(pc.x, pc.y, dot(mid, n) - c);
          const want = [mid[0] - ax[0], mid[1] - ax[1], mid[2] - ax[2]];
          face(a, b, e, want); face(b, f, e, want);
        }
      }
      for (const [ring, off, sg] of [[rings[0], -L / 2, -1], [rings[3], L / 2, 1]]) {
        const cen = newV(...from2(pc.x, pc.y, off));
        for (let i = 0; i < ring.length; i++) face(cen, ring[i], ring[(i + 1) % ring.length], [n[0] * sg, n[1] * sg, n[2] * sg]);
      }
    }
  }

  // chaque pièce ne garde que ses sommets
  const total = V + P.length / 3;
  const pack = (tri) => {
    const map = new Int32Array(total).fill(-1);
    const np = [], nc = [];
    const ni = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) {
      const g = tri[i];
      let m = map[g];
      if (m < 0) {
        m = np.length / 3; map[g] = m;
        const p3 = all(g); np.push(p3[0], p3[1], p3[2]);
        if (col) { if (g < V) nc.push(col[g * 3], col[g * 3 + 1], col[g * 3 + 2]); else nc.push(C[(g - V) * 3], C[(g - V) * 3 + 1], C[(g - V) * 3 + 2]); }
      }
      ni[i] = m;
    }
    return { pos: Float32Array.from(np), idx: ni, col: col ? Uint8Array.from(nc) : null };
  };
  const parts = [pack(outA), pack(outB)];
  if (pins.length) parts.push(pack(pins));
  return { parts, warn: [...new Set(warn)], placed: placed.length, asked: kind === 'none' ? 0 : conns.length, open, islands: islands.length };
}

// ---------- Fichiers des pièces ----------
// Les pièces sont écrites dans le repère du fichier d'origine (déplacement home, échelle s) : ouvertes ensemble,
// elles se remettent en place toutes seules.
export function toFileCoords(pos, home, s) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - home[0]) * s; out[i + 1] = (pos[i + 1] - home[1]) * s; out[i + 2] = (pos[i + 2] - home[2]) * s;
  }
  return out;
}
// STL binaire, Z vers le haut : affichage (x, y, z) → impression (x, −z, y)
export function writeSTL(pos, idx, title) {
  const T = idx.length / 3;
  const buf = new ArrayBuffer(84 + T * 50), dv = new DataView(buf);
  const head = ('Atelier 3D - ' + (title || '')).slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 0x7f);
  dv.setUint32(80, T, true);
  let o = 84;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, e = idx[t * 3 + 2] * 3;
    const A = [pos[a], -pos[a + 2], pos[a + 1]], B = [pos[b], -pos[b + 2], pos[b + 1]], E = [pos[e], -pos[e + 2], pos[e + 1]];
    const nn = unit(crossV([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [E[0] - A[0], E[1] - A[1], E[2] - A[2]]));
    for (const val of [...nn, ...A, ...B, ...E]) { dv.setFloat32(o, val, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
