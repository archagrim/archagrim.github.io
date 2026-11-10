// Atelier 3D : lecture des fichiers .3mf et .stl en arrière-plan (Web Worker).
// Le fichier reste sur l'ordinateur : tout est lu ici, rien n'est envoyé en ligne.
// Sortie : sommets (Y vers le haut, centrés, posés à y = 0), indices, normales et quelques mesures.
import { Unzip, UnzipInflate, Inflate } from './lib/fflate.module.js';

const UNIT = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

class Grow {
  constructor(Type, n = 1 << 16) { this.T = Type; this.a = new Type(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new this.T(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push3(x, y, z) { this.need(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
  get view() { return this.a.subarray(0, this.n); }
}

// ---------- 3MF ----------

const normPath = (p) => ('/' + String(p || '').replace(/^\/+/, '')).toLowerCase();

function parseTransform(s) {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : null;
}

// Composition 3MF (vecteur ligne) : p × A puis × B
function mul(a, b) {
  if (!a) return b; if (!b) return a;
  const r = new Array(12);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    let s = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    if (i === 3) s += b[9 + j];
    r[i * 3 + j] = s;
  }
  return r;
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*)>/g;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
const VERTEX = /\bx="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/;
const TRI = /\bv1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/;

function attrs(s) {
  const o = {}; let m; ATTR.lastIndex = 0;
  while ((m = ATTR.exec(s))) {
    o[m[1]] = m[2];
    const i = m[1].indexOf(':');
    if (i > 0 && !(m[1].slice(i + 1) in o)) o[m[1].slice(i + 1)] = m[2];
  }
  return o;
}

export function makeModelParser(path) {
  const st = { path, unit: 1, objects: new Map(), build: [], hasBuild: false };
  const dec = new TextDecoder();
  let carry = '';
  let cur = null;

  function handle(close, name, rest) {
    const c = name.indexOf(':');
    const tag = c >= 0 ? name.slice(c + 1) : name;
    if (tag === 'vertex') {
      if (!cur) return;
      const m = VERTEX.exec(rest);
      if (m) cur.pos.push3(+m[1], +m[2], +m[3]);
      else { const a = attrs(rest); cur.pos.push3(+a.x, +a.y, +a.z); }
      return;
    }
    if (tag === 'triangle') {
      if (!cur) return;
      const m = TRI.exec(rest);
      if (m) cur.idx.push3(+m[1], +m[2], +m[3]);
      else { const a = attrs(rest); cur.idx.push3(+a.v1, +a.v2, +a.v3); }
      return;
    }
    if (close) { if (tag === 'object') cur = null; return; }
    if (tag === 'model') {
      const u = attrs(rest).unit;
      if (u && UNIT[u]) st.unit = UNIT[u];
    } else if (tag === 'object') {
      const a = attrs(rest);
      cur = { id: a.id, pos: new Grow(Float32Array), idx: new Grow(Uint32Array, 1 << 17), comps: [] };
      st.objects.set(a.id, cur);
      if (/\/\s*$/.test(rest)) cur = null;
    } else if (tag === 'component') {
      if (!cur) return;
      const a = attrs(rest);
      cur.comps.push({ id: a.objectid, path: a.path ? normPath(a.path) : null, t: parseTransform(a.transform) });
    } else if (tag === 'build') {
      st.hasBuild = true;
    } else if (tag === 'item') {
      const a = attrs(rest);
      st.build.push({ id: a.objectid, path: a.path ? normPath(a.path) : null, t: parseTransform(a.transform) });
    }
  }

  function scan(text) {
    TAG.lastIndex = 0; let m;
    while ((m = TAG.exec(text))) handle(m[1] === '/', m[2], m[3]);
  }

  return {
    st,
    push(chunk, final) {
      const text = carry + dec.decode(chunk, { stream: !final });
      const cut = final ? text.length : text.lastIndexOf('>') + 1;
      scan(text.slice(0, cut));
      carry = text.slice(cut);
    },
  };
}

// Sommaire de l'archive (répertoire central), ZIP64 compris : la façon fiable de lire un ZIP,
// y compris quand les tailles ne sont écrites qu'après les données (Bambu Studio, OrcaSlicer…)
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  const loc = eocd - 20;
  if ((count === 0xffff || cdOff === 0xffffffff) && loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    if (dv.getUint32(z64, true) === 0x06064b50) {
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOff = Number(dv.getBigUint64(z64 + 48, true));
    }
  }
  const dec = new TextDecoder();
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    for (let e = p + 46 + nlen, end = e + elen; e + 4 <= end;) {
      const id = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(dv.getBigUint64(q, true)); }
      }
      e += 4 + sz;
    }
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('archive 3MF abîmée');
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    out.push({ name, method, data: bytes.subarray(start, start + csize) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// Décompresse une entrée par morceaux et les passe à onChunk(chunk, final)
function inflateEntry(ent, onChunk, onProgress) {
  const STEP = 1 << 20, d = ent.data;
  if (ent.method === 0) {
    for (let o = 0; o < d.length; o += STEP) { const e = Math.min(o + STEP, d.length); onChunk(d.subarray(o, e), e === d.length); onProgress(e); }
    if (!d.length) onChunk(new Uint8Array(0), true);
    return;
  }
  if (ent.method !== 8) throw new Error('compression non prise en charge dans l\'archive (' + ent.method + ')');
  let done = false;
  const inf = new Inflate((chunk, final) => { if (final) done = true; onChunk(chunk, final); });
  for (let o = 0; o < d.length; o += STEP) { const e = Math.min(o + STEP, d.length); inf.push(d.subarray(o, e), e === d.length); onProgress(e); }
  if (!done) onChunk(new Uint8Array(0), true);
}

export function read3MF(buf, progress = () => {}) {
  const bytes = new Uint8Array(buf);
  const files = new Map();
  let rels = '';
  let err = null;
  const relDec = new TextDecoder();

  const entries = zipEntries(bytes);
  if (entries && entries.length) {
    const models = entries.filter((e) => /\.model$/i.test(e.name));
    const relEnt = entries.find((e) => /^_rels\/\.rels$/i.test(e.name.replace(/^\/+/, '')));
    if (relEnt) inflateEntry(relEnt, (c, final) => { rels += relDec.decode(c, { stream: !final }); }, () => {});
    const total = models.reduce((s, e) => s + e.data.length, 0) || 1;
    let before = 0;
    for (const ent of models) {
      const parser = makeModelParser(normPath(ent.name));
      files.set(normPath(ent.name), parser.st);
      inflateEntry(ent, (c, final) => parser.push(c, final), (n) => progress((before + n) / total));
      before += ent.data.length;
    }
  } else {
    readStreaming();
  }

  // Repli : lecture en flux depuis le début de l'archive
  function readStreaming() {
  const uz = new Unzip((f) => {
    const name = f.name;
    if (/\.model$/i.test(name)) {
      const p = makeModelParser(normPath(name));
      files.set(normPath(name), p.st);
      f.ondata = (e, chunk, final) => { if (e) { err = e; return; } try { p.push(chunk, final); } catch (x) { err = x; } };
      f.start();
    } else if (/(^|\/)_rels\/\.rels$/i.test(name)) {
      f.ondata = (e, chunk, final) => { if (!e) rels += relDec.decode(chunk, { stream: !final }); };
      f.start();
    }
  });
  uz.register(UnzipInflate);
  const STEP = 1 << 20;
  for (let o = 0; o < bytes.length; o += STEP) {
    const end = Math.min(o + STEP, bytes.length);
    uz.push(bytes.subarray(o, end), end === bytes.length);
    if (err) throw err;
    progress(end / bytes.length);
  }
  }
  if (!files.size) throw new Error("aucun modèle 3D trouvé dans le fichier");

  const relRoot = /Target="([^"]+\.model)"/i.exec(rels);
  const root = (relRoot && files.get(normPath(relRoot[1])))
    || [...files.values()].find((f) => f.build.length)
    || [...files.values()].find((f) => f.hasBuild)
    || files.values().next().value;

  const pos = new Grow(Float32Array, 1 << 20);
  const idx = new Grow(Uint32Array, 1 << 21);
  let objects = 0;

  function emit(path, id, T, depth) {
    if (depth > 16) return;
    const f = files.get(path) || root;
    const o = f.objects.get(id);
    if (!o) return;
    const P = o.pos.view, I = o.idx.view, u = f.unit;
    const nv = P.length / 3;
    if (nv && I.length) {
      objects++;
      const base = pos.n / 3;
      pos.need(P.length);
      const t = T;
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        if (t) {
          pos.a[pos.n++] = (x * t[0] + y * t[3] + z * t[6] + t[9]) * u;
          pos.a[pos.n++] = (x * t[1] + y * t[4] + z * t[7] + t[10]) * u;
          pos.a[pos.n++] = (x * t[2] + y * t[5] + z * t[8] + t[11]) * u;
        } else {
          pos.a[pos.n++] = x * u; pos.a[pos.n++] = y * u; pos.a[pos.n++] = z * u;
        }
      }
      idx.need(I.length);
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i], b = I[i + 1], c = I[i + 2];
        if (a < nv && b < nv && c < nv) { idx.a[idx.n++] = a + base; idx.a[idx.n++] = b + base; idx.a[idx.n++] = c + base; }
      }
    }
    for (const c of o.comps) emit(c.path || f.path, c.id, mul(c.t, T), depth + 1);
  }

  if (root.build.length) {
    for (const it of root.build) emit(it.path || root.path, it.id, it.t, 0);
  } else {
    const used = new Set();
    for (const f of files.values()) for (const o of f.objects.values()) for (const c of o.comps) used.add((c.path || f.path) + '#' + c.id);
    for (const [id] of root.objects) if (!used.has(root.path + '#' + id)) emit(root.path, id, null, 0);
  }
  if (!idx.n) throw new Error("le fichier ne contient aucun triangle");
  return { pos: pos.view.slice(), idx: idx.view.slice(), objects };
}

// ---------- STL ----------

// Fusionne les sommets identiques pour un ombrage lisse (les STL répètent chaque sommet)
function weld(tri) {
  const n = tri.length / 3;
  const bits = new Uint32Array(tri.buffer, tri.byteOffset, tri.length);
  let cap = 1; while (cap < n * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const pos = new Float32Array(tri.length);
  const pb = new Uint32Array(pos.buffer);
  const idx = new Uint32Array(n);
  let vc = 0;
  for (let i = 0; i < n; i++) {
    const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) {
        table[h] = vc; pb[vc * 3] = a; pb[vc * 3 + 1] = b; pb[vc * 3 + 2] = c; idx[i] = vc++; break;
      }
      if (pb[e * 3] === a && pb[e * 3 + 1] === b && pb[e * 3 + 2] === c) { idx[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  return { pos: pos.slice(0, vc * 3), idx };
}

export function readSTL(buf, progress = () => {}) {
  const dv = new DataView(buf);
  const count = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  let tri;
  if (count > 0 && 84 + count * 50 === buf.byteLength) {
    tri = new Float32Array(count * 9);
    for (let i = 0, o = 84; i < count; i++, o += 50) {
      for (let k = 0; k < 9; k++) tri[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
      if ((i & 0xffff) === 0) progress(i / count * 0.6);
    }
  } else {
    const text = new TextDecoder().decode(buf);
    if (!/facet/i.test(text.slice(0, 4096))) throw new Error("ce STL n'est ni binaire ni texte valide");
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    const g = new Grow(Float32Array, 1 << 20); let m;
    while ((m = re.exec(text))) g.push3(+m[1], +m[2], +m[3]);
    const n = Math.floor(g.n / 9) * 9;
    tri = g.a.slice(0, n);
  }
  if (!tri.length) throw new Error("le fichier ne contient aucun triangle");
  progress(0.7);
  const w = weld(tri);
  return { pos: w.pos, idx: w.idx, objects: 1 };
}

// ---------- Mise en place et mesures ----------

export function finish(mesh) {
  const { pos, idx } = mesh;
  // Z vers le haut (impression 3D) → Y vers le haut (affichage) : (x, y, z) → (x, z, -y)
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 2], z = -pos[i + 1];
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= cx; pos[i + 1] -= minY; pos[i + 2] -= cz; }
  const w = maxX - minX, h = maxY - minY, d = maxZ - minZ;

  // Empreinte au sol : étendue des sommets dans le premier demi-millimètre
  const band = Math.min(0.5, h * 0.02);
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] <= band) {
      const x = pos[i], z = pos[i + 2];
      if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (z < fz0) fz0 = z; if (z > fz1) fz1 = z;
    }
  }
  const footprint = Number.isFinite(fx0) ? Math.max(fx1 - fx0, fz1 - fz0) : Math.max(w, d);

  // Normales lissées et volume (somme des tétraèdres signés)
  const nrm = new Float32Array(pos.length);
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx2 = pos[c], cy = pos[c + 1], cz2 = pos[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx2 - ax, vy = cy - ay, vz = cz2 - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    vol += ax * (by * cz2 - bz * cy) - ay * (bx * cz2 - bz * cx2) + az * (bx * cy - by * cx2);
  }
  // Normales stockées sur 16 bits : deux fois moins de mémoire, sans différence visible
  const n16 = new Int16Array(nrm.length);
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    n16[i] = Math.round(nrm[i] / l * 32767);
    n16[i + 1] = Math.round(nrm[i + 1] / l * 32767);
    n16[i + 2] = Math.round(nrm[i + 2] / l * 32767);
  }
  return {
    pos, idx, nrm: n16,
    stats: { tris: idx.length / 3, verts: pos.length / 3, objects: mesh.objects, w, h, d, footprint, volume: Math.abs(vol) / 6 },
  };
}

// ---------- Contrôle du maillage ----------
// Trous (arêtes ouvertes), arêtes non conformes, faces à l'orientation incohérente, pièces et fragments isolés.
// Les sommets sont d'abord soudés par position exacte, pour ne pas compter les coutures comme des trous.
export const CHECK_MAX_TRIS = 8e6;
export function analyzeMesh(pos, idx) {
  const V = pos.length / 3, T = idx.length / 3;
  const MAXMARK = 60000;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  let cap = 1; while (cap < V * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const canon = new Uint32Array(V);
  for (let i = 0; i < V; i++) {
    const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) { table[h] = i; canon[i] = i; break; }
      if (bits[e * 3] === a && bits[e * 3 + 1] === b && bits[e * 3 + 2] === c) { canon[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { x = find(x); y = find(y); if (x !== y) parent[y] = x; };

  // Une clé par demi-arête : (min·V + max)·2 + sens
  const keys = new Float64Array(T * 3);
  let k = 0, degenerate = 0, vol = 0;
  const edge = (u, v) => { if (u !== v) keys[k++] = u < v ? (u * V + v) * 2 : (v * V + u) * 2 + 1; };
  for (let t = 0; t < T; t++) {
    const a = canon[idx[t * 3]], b = canon[idx[t * 3 + 1]], c = canon[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) degenerate++;
    union(a, b); union(b, c);
    edge(a, b); edge(b, c); edge(c, a);
    const A = a * 3, B = b * 3, C = c * 3;
    vol += pos[A] * (pos[B + 1] * pos[C + 2] - pos[B + 2] * pos[C + 1])
         - pos[A + 1] * (pos[B] * pos[C + 2] - pos[B + 2] * pos[C])
         + pos[A + 2] * (pos[B] * pos[C + 1] - pos[B + 1] * pos[C]);
  }
  const used = keys.subarray(0, k);
  used.sort();
  const red = new Grow(Float32Array, 4096), orange = new Grow(Float32Array, 4096);
  const mark = (g, v) => { if (g.n < MAXMARK * 3) g.push3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); };
  let open = 0, nonManifold = 0, flipped = 0;
  for (let i = 0; i < used.length;) {
    const base = Math.floor(used[i] / 2);
    let j = i, fwd = 0, rev = 0;
    while (j < used.length && Math.floor(used[j] / 2) === base) { if (used[j] % 2) rev++; else fwd++; j++; }
    const n = j - i, u = Math.floor(base / V), v = base - u * V;
    if (n === 1) { open++; mark(red, u); mark(red, v); }
    else if (n > 2) { nonManifold++; mark(orange, u); mark(orange, v); }
    else if (fwd === 2 || rev === 2) { flipped++; mark(orange, u); mark(orange, v); }
    i = j;
  }

  // Pièces : composantes connexes ; un fragment est une pièce minuscule à côté du reste
  const triCount = new Int32Array(V);
  for (let t = 0; t < T; t++) triCount[find(canon[idx[t * 3]])]++;
  let largest = 0, largestN = 0;
  for (let i = 0; i < V; i++) if (triCount[i] > largestN) { largestN = triCount[i]; largest = i; }
  const thr = Math.max(1, Math.min(5000, Math.floor(T * 0.001)));
  let parts = 0, fragments = 0;
  for (let i = 0; i < V; i++) {
    const n = triCount[i];
    if (!n) continue;
    if (i !== largest && n < thr) fragments++; else parts++;
  }
  if (fragments) {
    for (let t = 0; t < T; t++) {
      const r = find(canon[idx[t * 3]]);
      if (r !== largest && triCount[r] < thr) { mark(red, canon[idx[t * 3]]); mark(red, canon[idx[t * 3 + 1]]); mark(red, canon[idx[t * 3 + 2]]); }
    }
  }
  return {
    open, nonManifold, flipped, parts, fragments, degenerate,
    insideOut: vol < 0 && open === 0,
    red: red.view.slice(), orange: orange.view.slice(),
  };
}

export function readModel(name, buf, progress) {
  const is3mf = /\.3mf$/i.test(name) || (new Uint8Array(buf, 0, 2)[0] === 0x50 && new Uint8Array(buf, 0, 2)[1] === 0x4b);
  const mesh = is3mf ? read3MF(buf, (p) => progress('lecture', p)) : readSTL(buf, (p) => progress('lecture', p));
  progress('mesures', 1);
  const r = finish(mesh);
  r.check = r.stats.tris <= CHECK_MAX_TRIS ? analyzeMesh(r.pos, r.idx) : { skipped: true };
  return r;
}

// ---------- Point d'entrée du worker ----------
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (e) => {
    const { name, file } = e.data;
    try {
      const buf = await file.arrayBuffer();
      let last = 0;
      const r = readModel(name, buf, (phase, p) => {
        const now = Date.now();
        if (now - last > 80 || p === 1) { last = now; self.postMessage({ type: 'progress', phase, p }); }
      });
      const transfer = [r.pos.buffer, r.idx.buffer, r.nrm.buffer];
      if (r.check.red) transfer.push(r.check.red.buffer, r.check.orange.buffer);
      self.postMessage({ type: 'done', pos: r.pos, idx: r.idx, nrm: r.nrm, stats: r.stats, check: r.check }, transfer);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  };
}
