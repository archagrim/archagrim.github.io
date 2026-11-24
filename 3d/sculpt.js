// Atelier 3D : sculpture au pinceau sur le maillage affiché.
// Outils : creuser, ajouter, lisser, aplatir. À la fin de chaque trait, les arêtes trop étirées sont coupées
// en deux (les triangles se resserrent là où la surface s'est allongée), sans toucher au reste du modèle.
// Repère : celui de l'affichage (Y vers le haut, unités du modèle). Normales sur 16 bits, couleurs sRGB 8 bits.

const grow = (Ctor, src, n) => { const a = new Ctor(n); a.set(src); return a; };
const EK = 0x4000000;                     // clé d'arête : a × EK + b (jusqu'à 67 millions de sommets)

export class Sculptor {
  constructor(pos, idx, nrm, col) {
    this.V = pos.length / 3;
    this.T = idx.length / 3;
    const vc = Math.ceil(this.V * 1.25) + 1024, tc = Math.ceil(this.T * 1.25) + 2048;
    this.pos = grow(Float32Array, pos, vc * 3);
    this.nrm = grow(Int16Array, nrm, vc * 3);
    this.col = col && col.length === pos.length ? grow(Uint8Array, col, vc * 3) : null;
    this.idx = grow(Uint32Array, idx, tc * 3);
    this.stamp = new Uint32Array(vc);      // sommets déjà vus pendant une touche
    this.moved = new Uint32Array(vc);      // sommets déplacés pendant le trait en cours
    this.tstamp = new Uint32Array(tc);
    this.dabId = 0; this.strokeId = 0; this.tickId = 0;
    this.edge = this.medianEdge();
    this.cell = Math.max(this.edge * 6, 1e-3);
    this.buildAdjacency();
    this.buildGrid();
    this.undo = [];
    this.stroke = null;
    this.added = 0;                        // triangles ajoutés depuis le début
  }

  // Longueur d'arête typique (médiane sur un échantillon)
  medianEdge() {
    const { pos, idx } = this, T = this.T, n = Math.min(T, 20000), L = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = Math.floor(k * T / n), a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3;
      L[k] = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
    }
    L.sort();
    return L[n >> 1] || 1;
  }

  // Triangles autour de chaque sommet
  buildAdjacency() {
    const V = this.V, T = this.T, idx = this.idx;
    const start = new Int32Array(V + 1);
    for (let i = 0; i < T * 3; i++) start[idx[i] + 1]++;
    for (let v = 0; v < V; v++) start[v + 1] += start[v];
    const fill = start.slice(0, V), list = new Int32Array(T * 3);
    for (let t = 0; t < T; t++) for (let j = 0; j < 3; j++) list[fill[idx[t * 3 + j]]++] = t;
    this.vtStart = start; this.vtList = list;
  }

  // Grille des sommets pour trouver vite ceux qui sont sous le pinceau
  buildGrid() {
    const V = this.V, P = this.pos, C = this.cell;
    let cap = 1; while (cap < V) cap <<= 1;
    const mask = cap - 1, head = new Int32Array(cap).fill(-1), next = new Int32Array(Math.max(V, 1));
    for (let i = 0; i < V; i++) {
      const h = this.key(Math.floor(P[i * 3] / C), Math.floor(P[i * 3 + 1] / C), Math.floor(P[i * 3 + 2] / C), mask);
      next[i] = head[h]; head[h] = i;
    }
    this.grid = { head, next, mask };
    this.drift = 0;
  }
  key(x, y, z, mask) { return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask; }

  // Sommets à moins de R du point c : fn(i, distance)
  near(c, R, fn) {
    const { head, next, mask } = this.grid, P = this.pos, C = this.cell, Rq = R + this.drift;
    const id = ++this.dabId, st = this.stamp, R2 = R * R;
    const x0 = Math.floor((c[0] - Rq) / C), x1 = Math.floor((c[0] + Rq) / C);
    const y0 = Math.floor((c[1] - Rq) / C), y1 = Math.floor((c[1] + Rq) / C);
    const z0 = Math.floor((c[2] - Rq) / C), z1 = Math.floor((c[2] + Rq) / C);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      for (let i = head[this.key(x, y, z, mask)]; i >= 0; i = next[i]) {
        if (st[i] === id) continue;
        st[i] = id;
        const dx = P[i * 3] - c[0], dy = P[i * 3 + 1] - c[1], dz = P[i * 3 + 2] - c[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= R2) fn(i, Math.sqrt(d2));
      }
    }
  }

  beginStroke() {
    this.strokeId++;
    this.stroke = { ids: [], old: [], V0: this.V, T0: this.T, replaced: [], lo: Infinity, hi: -1 };
  }

  // Une touche du pinceau. tool : 'dig' | 'add' | 'smooth' | 'flat' ; force 0..1.
  // Renvoie la plage de sommets modifiés { lo, hi } (pour la carte graphique), ou null.
  dab(c, R, tool, force) {
    const S = this.stroke;
    if (!S) return null;
    const ids = [], ws = [];
    this.near(c, R, (i, d) => { const t = d / R, w = (1 - t * t); ids.push(i); ws.push(w * w); });
    if (!ids.length) return null;
    const P = this.pos, N = this.nrm;
    // normale et centre de la zone
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, sw = 0;
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k], w = ws[k];
      nx += N[i * 3] * w; ny += N[i * 3 + 1] * w; nz += N[i * 3 + 2] * w;
      cx += P[i * 3] * w; cy += P[i * 3 + 1] * w; cz += P[i * 3 + 2] * w; sw += w;
    }
    const nl = Math.hypot(nx, ny, nz);
    if (!nl || !sw) return null;
    nx /= nl; ny /= nl; nz /= nl; cx /= sw; cy /= sw; cz /= sw;
    // garder la position d'avant le trait (pour annuler)
    const mv = this.moved, sid = this.strokeId;
    for (const i of ids) if (mv[i] !== sid) { mv[i] = sid; S.ids.push(i); S.old.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); }
    let maxMove = 0;
    if (tool === 'dig' || tool === 'add') {
      const amt = R * 0.06 * force * (tool === 'dig' ? -1 : 1);
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k], a = amt * ws[k];
        P[i * 3] += nx * a; P[i * 3 + 1] += ny * a; P[i * 3 + 2] += nz * a;
        if (Math.abs(a) > maxMove) maxMove = Math.abs(a);
      }
    } else if (tool === 'flat') {
      const k0 = 0.5 * force;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k], d = (P[i * 3] - cx) * nx + (P[i * 3 + 1] - cy) * ny + (P[i * 3 + 2] - cz) * nz, a = -d * ws[k] * k0;
        P[i * 3] += nx * a; P[i * 3 + 1] += ny * a; P[i * 3 + 2] += nz * a;
        if (Math.abs(a) > maxMove) maxMove = Math.abs(a);
      }
    } else {
      // lisser : chaque sommet va vers le centre de ses voisins
      const tgt = new Float32Array(ids.length * 3), st = this.vtStart, lst = this.vtList, I = this.idx;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k];
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let q = st[i]; q < st[i + 1]; q++) {
          const t = lst[q];
          for (let j = 0; j < 3; j++) { const v = I[t * 3 + j]; if (v === i) continue; sx += P[v * 3]; sy += P[v * 3 + 1]; sz += P[v * 3 + 2]; n++; }
        }
        if (!n) { tgt[k * 3] = P[i * 3]; tgt[k * 3 + 1] = P[i * 3 + 1]; tgt[k * 3 + 2] = P[i * 3 + 2]; continue; }
        tgt[k * 3] = sx / n; tgt[k * 3 + 1] = sy / n; tgt[k * 3 + 2] = sz / n;
      }
      const k0 = 0.6 * force;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k], a = ws[k] * k0;
        const dx = (tgt[k * 3] - P[i * 3]) * a, dy = (tgt[k * 3 + 1] - P[i * 3 + 1]) * a, dz = (tgt[k * 3 + 2] - P[i * 3 + 2]) * a;
        P[i * 3] += dx; P[i * 3 + 1] += dy; P[i * 3 + 2] += dz;
        const m = Math.hypot(dx, dy, dz); if (m > maxMove) maxMove = m;
      }
    }
    this.drift += maxMove;
    const r = this.updateNormals(ids);
    if (r.lo < S.lo) S.lo = r.lo;
    if (r.hi > S.hi) S.hi = r.hi;
    return r;
  }

  // Normales des sommets touchés et de leurs voisins
  updateNormals(ids) {
    const st = this.vtStart, lst = this.vtList, I = this.idx, P = this.pos, N = this.nrm;
    const id = ++this.dabId, seen = this.stamp, verts = [];
    for (const i of ids) for (let q = st[i]; q < st[i + 1]; q++) {
      const t = lst[q];
      for (let j = 0; j < 3; j++) { const v = I[t * 3 + j]; if (seen[v] !== id) { seen[v] = id; verts.push(v); } }
    }
    let lo = Infinity, hi = -1;
    for (const v of verts) {
      let nx = 0, ny = 0, nz = 0;
      for (let q = st[v]; q < st[v + 1]; q++) {
        const t = lst[q], a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
        nx += uy * wz - uz * wy; ny += uz * wx - ux * wz; nz += ux * wy - uy * wx;
      }
      const l = Math.hypot(nx, ny, nz);
      if (l) { N[v * 3] = Math.round(nx / l * 32767); N[v * 3 + 1] = Math.round(ny / l * 32767); N[v * 3 + 2] = Math.round(nz / l * 32767); }
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return { lo, hi };
  }

  // Fin du trait : les arêtes étirées (plus de 2 fois la taille d'origine) près des sommets déplacés
  // sont coupées en deux, jusqu'à 4 fois. Renvoie { topo: maillage changé, added }.
  endStroke() {
    const S = this.stroke;
    this.stroke = null;
    if (!S || !S.ids.length) return { topo: false, added: 0, empty: true };
    const Lmax = this.edge * 2, L2 = Lmax * Lmax, sid = this.strokeId, mv = this.moved;
    const tid = sid, ts = this.tstamp;
    let region = [];
    const st = this.vtStart, lst = this.vtList;
    for (const i of S.ids) for (let q = st[i]; q < st[i + 1]; q++) { const t = lst[q]; if (ts[t] !== tid) { ts[t] = tid; region.push(t); } }
    const T0 = this.T;
    const limit = T0 + Math.max(2e6, T0);           // garde-fou : pas plus de 2 millions de triangles en un trait
    for (let pass = 0; pass < 4 && region.length && this.T < limit; pass++) {
      const mid = new Map();
      const I = this.idx;
      for (const t of region) {
        for (let j = 0; j < 3; j++) {
          const a = I[t * 3 + j], b = I[t * 3 + (j + 1) % 3];
          if (mv[a] !== sid && mv[b] !== sid) continue;
          const P = this.pos;
          const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
          if (dx * dx + dy * dy + dz * dz <= L2) continue;
          const k = a < b ? a * EK + b : b * EK + a;
          if (!mid.has(k)) mid.set(k, -1);
        }
      }
      if (!mid.size) break;
      for (const k of mid.keys()) {
        const a = Math.floor(k / EK), b = k - a * EK;
        mid.set(k, this.addMid(a, b));
      }
      const next = [];
      for (const t of region) {
        const I2 = this.idx, a = I2[t * 3], b = I2[t * 3 + 1], c = I2[t * 3 + 2];
        const m0 = mid.get(a < b ? a * EK + b : b * EK + a), m1 = mid.get(b < c ? b * EK + c : c * EK + b), m2 = mid.get(c < a ? c * EK + a : a * EK + c);
        const e0 = m0 !== undefined, e1 = m1 !== undefined, e2 = m2 !== undefined;
        if (!e0 && !e1 && !e2) continue;
        if (ts[t] !== tid + 0x80000000) { ts[t] = tid + 0x80000000; S.replaced.push(t, a, b, c); }
        let tris;
        if (e0 && e1 && e2) tris = [[a, m0, m2], [m0, b, m1], [m2, m1, c], [m0, m1, m2]];
        else if (e0 && e1) tris = [[m0, b, m1], [a, m0, m1], [a, m1, c]];
        else if (e1 && e2) tris = [[m1, c, m2], [a, b, m1], [a, m1, m2]];
        else if (e2 && e0) tris = [[a, m0, m2], [m0, b, c], [m0, c, m2]];
        else if (e0) tris = [[a, m0, c], [m0, b, c]];
        else if (e1) tris = [[a, b, m1], [a, m1, c]];
        else tris = [[a, b, m2], [m2, b, c]];
        this.setTri(t, tris[0]); next.push(t);
        for (let q = 1; q < tris.length; q++) next.push(this.addTri(tris[q]));
      }
      region = next;
    }
    const added = this.T - T0;
    this.undo.push(S);
    if (this.undo.length > 40) this.undo.shift();
    if (added) { this.added += added; this.buildAdjacency(); this.renormal(S.ids.concat(Array.from({ length: this.V - S.V0 }, (_, k) => S.V0 + k))); }
    this.buildGrid();
    return { topo: added > 0, added };
  }

  // sommet au milieu d'une arête (position, normale et couleur moyennes), compté comme déplacé
  addMid(a, b) {
    this.ensureV(this.V + 1);
    const v = this.V++, P = this.pos, N = this.nrm, C = this.col;
    for (let k = 0; k < 3; k++) {
      P[v * 3 + k] = (P[a * 3 + k] + P[b * 3 + k]) / 2;
      N[v * 3 + k] = (N[a * 3 + k] + N[b * 3 + k]) >> 1;
      if (C) C[v * 3 + k] = (C[a * 3 + k] + C[b * 3 + k] + 1) >> 1;
    }
    this.moved[v] = this.strokeId;
    return v;
  }
  setTri(t, [a, b, c]) { const I = this.idx; I[t * 3] = a; I[t * 3 + 1] = b; I[t * 3 + 2] = c; }
  addTri(tri) { this.ensureT(this.T + 1); const t = this.T++; this.setTri(t, tri); return t; }
  ensureV(n) {
    if (n * 3 <= this.pos.length) return;
    const cap = Math.ceil(n * 1.5);
    this.pos = grow(Float32Array, this.pos, cap * 3);
    this.nrm = grow(Int16Array, this.nrm, cap * 3);
    if (this.col) this.col = grow(Uint8Array, this.col, cap * 3);
    this.stamp = grow(Uint32Array, this.stamp, cap);
    this.moved = grow(Uint32Array, this.moved, cap);
  }
  ensureT(n) {
    if (n * 3 <= this.idx.length) return;
    const cap = Math.ceil(n * 1.5);
    this.idx = grow(Uint32Array, this.idx, cap * 3);
    this.tstamp = grow(Uint32Array, this.tstamp, cap);
  }
  renormal(ids) { if (ids.length) this.updateNormals(ids); }

  // Annule le dernier trait. Renvoie { topo } (true si les triangles ont changé), ou null s'il n'y a rien.
  undoStroke() {
    const S = this.undo.pop();
    if (!S) return null;
    const topo = this.T !== S.T0 || this.V !== S.V0;
    const R = S.replaced;
    for (let k = R.length - 4; k >= 0; k -= 4) this.setTri(R[k], [R[k + 1], R[k + 2], R[k + 3]]);
    this.added -= this.T - S.T0;
    this.T = S.T0; this.V = S.V0;
    const P = this.pos;
    for (let k = 0; k < S.ids.length; k++) { const i = S.ids[k]; P[i * 3] = S.old[k * 3]; P[i * 3 + 1] = S.old[k * 3 + 1]; P[i * 3 + 2] = S.old[k * 3 + 2]; }
    if (topo) this.buildAdjacency();
    this.renormal(S.ids);
    this.buildGrid();
    let lo = Infinity, hi = -1;
    for (const i of S.ids) { if (i < lo) lo = i; if (i > hi) hi = i; }
    return { topo, lo, hi };
  }

  // Vues sur le maillage courant (sans copie)
  views() {
    return {
      pos: this.pos.subarray(0, this.V * 3), nrm: this.nrm.subarray(0, this.V * 3),
      col: this.col ? this.col.subarray(0, this.V * 3) : null, idx: this.idx.subarray(0, this.T * 3),
    };
  }
  get strokes() { return this.undo.length; }
}
