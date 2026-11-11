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
  const { pos } = mesh;
  // Z vers le haut (impression 3D) → Y vers le haut (affichage) : (x, y, z) → (x, z, -y)
  for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1], z = pos[i + 2]; pos[i + 1] = z; pos[i + 2] = -y; }
  place(pos);
  return measure(pos, mesh.idx, mesh.objects);
}

// Pose le modèle au sol, centré : renvoie le déplacement appliqué
export function place(pos) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  const dx = -(minX + maxX) / 2, dy = -minY, dz = -(minZ + maxZ) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] += dx; pos[i + 1] += dy; pos[i + 2] += dz; }
  return [dx, dy, dz];
}

// Dimensions, empreinte au sol, normales lissées et volume d'un modèle déjà posé au sol
export function measure(pos, idx, objects = 1) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const w = maxX - minX, h = maxY - minY, d = maxZ - minZ;

  // Empreinte au sol : étendue des sommets dans le premier demi-millimètre
  const band = minY + Math.min(0.5, h * 0.02);
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
    stats: { tris: idx.length / 3, verts: pos.length / 3, objects, w, h, d, footprint, volume: Math.abs(vol) / 6 },
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

// ---------- Réparation ----------
// Soudure des sommets, triangles dégénérés ou en double, faces remises dans le même sens que leurs voisines,
// petits trous bouchés, modèles retournés remis à l'endroit, poussières isolées retirées.
// Les arêtes partagées par plus de deux faces sont laissées telles quelles (les slicers s'en accommodent).
export const REPAIR_MAX_TRIS = 6e6;

function weldIndexed(pos, idx) {
  const V = pos.length / 3;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  let cap = 1; while (cap < V * 2) cap <<= 1;
  const mask = cap - 1, table = new Int32Array(cap).fill(-1), map = new Uint32Array(V);
  const out = new Float32Array(pos.length), ob = new Uint32Array(out.buffer);
  let n = 0;
  for (let i = 0; i < V; i++) {
    const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) { table[h] = n; ob[n * 3] = a; ob[n * 3 + 1] = b; ob[n * 3 + 2] = c; map[i] = n++; break; }
      if (ob[e * 3] === a && ob[e * 3 + 1] === b && ob[e * 3 + 2] === c) { map[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  const ni = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) ni[i] = map[idx[i]];
  return { pos: out.slice(0, n * 3), idx: ni, merged: V - n };
}

// Table des arêtes : pour chaque arête, combien de faces la partagent et les deux premières
function edgeTable(idx) {
  const T = idx.length / 3;
  let cap = 1; while (cap < T * 2.4) cap <<= 1;
  const mask = cap - 1;
  const ka = new Int32Array(cap).fill(-1), kb = new Int32Array(cap), t1 = new Int32Array(cap), t2 = new Int32Array(cap).fill(-1), cnt = new Uint8Array(cap);
  const slot = new Int32Array(T * 3).fill(-1);
  for (let t = 0; t < T; t++) {
    for (let j = 0; j < 3; j++) {
      const u = idx[t * 3 + j], v = idx[t * 3 + (j + 1) % 3];
      if (u === v) continue;
      const a = u < v ? u : v, b = u < v ? v : u;
      let h = (Math.imul(a, 0x9E3779B1) ^ Math.imul(b, 0x85EBCA77)) & mask;
      for (;;) {
        if (ka[h] < 0) { ka[h] = a; kb[h] = b; t1[h] = t; cnt[h] = 1; break; }
        if (ka[h] === a && kb[h] === b) { if (cnt[h] < 255) cnt[h]++; if (cnt[h] === 2) t2[h] = t; break; }
        h = (h + 1) & mask;
      }
      slot[t * 3 + j] = h;
    }
  }
  return { slot, t1, t2, cnt };
}

// Triangule un contour (indices de sommets, dans l'ordre) en gardant son sens de parcours
function fillLoop(pos, loop, extra, V) {
  const n = loop.length, out = [];
  if (n === 3) return [loop[0], loop[1], loop[2]];
  if (n > 400) {
    // grand trou : éventail autour d'un nouveau sommet central
    let cx = 0, cy = 0, cz = 0;
    for (const i of loop) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; }
    const c = V + extra.length / 3;
    extra.push(cx / n, cy / n, cz / n);
    for (let i = 0; i < n; i++) out.push(loop[i], loop[(i + 1) % n], c);
    return out;
  }
  // projection sur le plan le plus proche du contour (normale de Newell)
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % n] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const [u, v] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
  const P = loop.map(i => [pos[i * 3 + u], pos[i * 3 + v]]);
  let area = 0;
  for (let i = 0; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const o = area >= 0 ? 1 : -1;
  const list = [...Array(n).keys()];
  const crs = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[b][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[b][0]);
  const inside = (p, a, b, c) => {
    const d1 = (P[b][0] - P[a][0]) * (p[1] - P[a][1]) - (P[b][1] - P[a][1]) * (p[0] - P[a][0]);
    const d2 = (P[c][0] - P[b][0]) * (p[1] - P[b][1]) - (P[c][1] - P[b][1]) * (p[0] - P[b][0]);
    const d3 = (P[a][0] - P[c][0]) * (p[1] - P[c][1]) - (P[a][1] - P[c][1]) * (p[0] - P[c][0]);
    return d1 * o > 0 && d2 * o > 0 && d3 * o > 0;
  };
  let guard = n * n;
  while (list.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < list.length; k++) {
      const a = list[(k + list.length - 1) % list.length], b = list[k], c = list[(k + 1) % list.length];
      if (crs(a, b, c) * o <= 0) continue;
      let ok = true;
      for (const m of list) { if (m !== a && m !== b && m !== c && inside(P[m], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      out.push(loop[a], loop[b], loop[c]);
      list.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  // contour tordu : on finit en éventail
  for (let k = 1; k + 1 < list.length; k++) out.push(loop[list[0]], loop[list[k]], loop[list[k + 1]]);
  return out;
}

export function repairMesh(pos0, idx0) {
  const report = { merged: 0, degenerate: 0, duplicates: 0, flipped: 0, inverted: 0, holes: 0, bigHoles: 0, fragments: 0 };
  const wld = weldIndexed(pos0, idx0);
  const pos = wld.pos, src = wld.idx;
  report.merged = wld.merged;
  const V = pos.length / 3;

  // 1. triangles dégénérés et en double
  const T0 = src.length / 3, keep = new Uint8Array(T0);
  let cap = 1; while (cap < T0 * 2) cap <<= 1;
  const tmask = cap - 1, ttab = new Int32Array(cap).fill(-1);
  const sorted3 = (a, b, c) => { if (a > b) [a, b] = [b, a]; if (b > c) [b, c] = [c, b]; if (a > b) [a, b] = [b, a]; return [a, b, c]; };
  for (let t = 0; t < T0; t++) {
    const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
    if (a === b || b === c || a === c) { report.degenerate++; continue; }
    const [x, y, z] = sorted3(a, b, c);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & tmask, dup = -1;
    for (;;) {
      const e = ttab[h];
      if (e < 0) { ttab[h] = t; break; }
      const [ex, ey, ez] = sorted3(src[e * 3], src[e * 3 + 1], src[e * 3 + 2]);
      if (ex === x && ey === y && ez === z) { dup = e; break; }
      h = (h + 1) & tmask;
    }
    if (dup < 0) { keep[t] = 1; continue; }
    report.duplicates++;
    const ea = src[dup * 3], eb = src[dup * 3 + 1], ec = src[dup * 3 + 2];
    const same = (ea === a && eb === b) || (ea === b && eb === c) || (ea === c && eb === a);
    if (!same && keep[dup]) { keep[dup] = 0; report.duplicates++; }   // double paroi d'épaisseur nulle : les deux s'en vont
  }
  let T = 0;
  for (let t = 0; t < T0; t++) T += keep[t];
  const idx = new Uint32Array(T * 3);
  for (let t = 0, k = 0; t < T0; t++) if (keep[t]) { idx[k++] = src[t * 3]; idx[k++] = src[t * 3 + 1]; idx[k++] = src[t * 3 + 2]; }

  // 2. même sens que les voisines, de proche en proche (arêtes partagées par exactement deux faces)
  const { slot, t1, t2, cnt } = edgeTable(idx);
  const flip = new Uint8Array(T), comp = new Int32Array(T).fill(-1), queue = new Int32Array(T);
  let ncomp = 0;
  for (let s = 0; s < T; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = ncomp;
    let qh = 0, qt = 0; queue[qt++] = s;
    while (qh < qt) {
      const t = queue[qh++];
      for (let j = 0; j < 3; j++) {
        const h = slot[t * 3 + j];
        if (h < 0 || cnt[h] !== 2) continue;
        const n = t1[h] === t ? t2[h] : t1[h];
        if (n < 0 || n === t || comp[n] >= 0) continue;
        const u = idx[t * 3 + j], v = idx[t * 3 + (j + 1) % 3];
        let sameDir = 0;
        for (let k = 0; k < 3; k++) if (idx[n * 3 + k] === u && idx[n * 3 + (k + 1) % 3] === v) sameDir = 1;
        flip[n] = flip[t] ^ sameDir;
        comp[n] = ncomp;
        queue[qt++] = n;
      }
    }
    ncomp++;
  }

  // 3. trous : contours d'arêtes qui n'appartiennent qu'à une face
  const out = new Map();
  for (let t = 0; t < T; t++) {
    for (let j = 0; j < 3; j++) {
      const h = slot[t * 3 + j];
      if (h < 0 || cnt[h] !== 1) continue;
      let p = idx[t * 3 + j], q = idx[t * 3 + (j + 1) % 3];
      if (flip[t]) [p, q] = [q, p];
      // le bouchon parcourt l'arête dans l'autre sens : q → p
      if (!out.has(q)) out.set(q, []);
      out.get(q).push(p, t);
    }
  }
  const extra = [], fillIdx = [], fillComp = [];
  for (const start of out.keys()) {
    while (out.get(start).length) {
      const loop = [start];
      let lst = out.get(start), owner = lst[lst.length - 1], next = lst[lst.length - 2];
      lst.length -= 2;
      let closed = false;
      while (loop.length < 20000) {
        if (next === start) { closed = true; break; }
        loop.push(next);
        lst = out.get(next);
        if (!lst || !lst.length) break;
        next = lst[lst.length - 2]; lst.length -= 2;
      }
      if (!closed || loop.length < 3) continue;
      if (loop.length > 5000) { report.bigHoles++; continue; }
      const tris = fillLoop(pos, loop, extra, V);
      for (let i = 0; i < tris.length; i += 3) { fillIdx.push(tris[i], tris[i + 1], tris[i + 2]); fillComp.push(comp[owner]); }
      report.holes++;
    }
  }
  const allPos = extra.length ? (() => { const a = new Float32Array(pos.length + extra.length); a.set(pos); a.set(extra, pos.length); return a; })() : pos;

  // 4. volume signé de chaque pièce : une pièce négative est retournée, on la remet à l'endroit
  const vol = new Float64Array(ncomp);
  const tet = (a, b, c) => {
    const A = a * 3, B = b * 3, C = c * 3, p = allPos;
    return p[A] * (p[B + 1] * p[C + 2] - p[B + 2] * p[C + 1]) - p[A + 1] * (p[B] * p[C + 2] - p[B + 2] * p[C]) + p[A + 2] * (p[B] * p[C + 1] - p[B + 1] * p[C]);
  };
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    vol[comp[t]] += flip[t] ? tet(a, c, b) : tet(a, b, c);
  }
  for (let i = 0; i < fillComp.length; i++) vol[fillComp[i]] += tet(fillIdx[i * 3], fillIdx[i * 3 + 1], fillIdx[i * 3 + 2]);
  const inv = new Uint8Array(ncomp);
  for (let c = 0; c < ncomp; c++) if (vol[c] < -1e-3) { inv[c] = 1; report.inverted++; }

  // 5. assemblage, en remettant chaque face dans le bon sens
  const N = T + fillComp.length;
  let res = new Uint32Array(N * 3);
  let k = 0;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (flip[t] ^ inv[comp[t]]) { res[k++] = a; res[k++] = c; res[k++] = b; report.flipped++; }
    else { res[k++] = a; res[k++] = b; res[k++] = c; }
  }
  for (let i = 0; i < fillComp.length; i++) {
    const a = fillIdx[i * 3], b = fillIdx[i * 3 + 1], c = fillIdx[i * 3 + 2];
    if (inv[fillComp[i]]) { res[k++] = a; res[k++] = c; res[k++] = b; } else { res[k++] = a; res[k++] = b; res[k++] = c; }
  }

  // 6. poussières : très petites pièces isolées (moins de 2 mm et peu de faces)
  const VA = allPos.length / 3;
  const parent = new Int32Array(VA);
  for (let i = 0; i < VA; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < N; t++) {
    const a = find(res[t * 3]), b = find(res[t * 3 + 1]), c = find(res[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const tc = new Int32Array(VA), bb = new Float32Array(VA * 6);
  for (let i = 0; i < VA; i++) { bb[i * 6] = bb[i * 6 + 1] = bb[i * 6 + 2] = Infinity; bb[i * 6 + 3] = bb[i * 6 + 4] = bb[i * 6 + 5] = -Infinity; }
  for (let t = 0; t < N; t++) {
    const r = find(res[t * 3]);
    tc[r]++;
    for (let j = 0; j < 3; j++) {
      const v = res[t * 3 + j] * 3;
      for (let d = 0; d < 3; d++) { const x = allPos[v + d]; if (x < bb[r * 6 + d]) bb[r * 6 + d] = x; if (x > bb[r * 6 + 3 + d]) bb[r * 6 + 3 + d] = x; }
    }
  }
  let largest = 0;
  for (let i = 0; i < VA; i++) if (tc[i] > tc[largest]) largest = i;
  const thr = Math.max(1, Math.min(5000, Math.floor(N * 0.001)));
  const dust = new Uint8Array(VA);
  for (let i = 0; i < VA; i++) {
    if (!tc[i] || i === largest || tc[i] >= thr) continue;
    const dg = Math.hypot(bb[i * 6 + 3] - bb[i * 6], bb[i * 6 + 4] - bb[i * 6 + 1], bb[i * 6 + 5] - bb[i * 6 + 2]);
    if (dg < 2) { dust[i] = 1; report.fragments++; }
  }
  if (report.fragments) {
    const kept = new Uint32Array(N * 3);
    let m = 0;
    for (let t = 0; t < N; t++) if (!dust[find(res[t * 3])]) { kept[m++] = res[t * 3]; kept[m++] = res[t * 3 + 1]; kept[m++] = res[t * 3 + 2]; }
    res = kept.slice(0, m);
  }
  return compact(allPos, res, report);
}

// Retire les sommets inutilisés
function compact(pos, idx, report) {
  const V = pos.length / 3, map = new Int32Array(V).fill(-1);
  let n = 0;
  for (let i = 0; i < idx.length; i++) if (map[idx[i]] < 0) map[idx[i]] = n++;
  const np = new Float32Array(n * 3), ni = new Uint32Array(idx.length);
  for (let v = 0; v < V; v++) { const m = map[v]; if (m >= 0) { np[m * 3] = pos[v * 3]; np[m * 3 + 1] = pos[v * 3 + 1]; np[m * 3 + 2] = pos[v * 3 + 2]; } }
  for (let i = 0; i < idx.length; i++) ni[i] = map[idx[i]];
  return { pos: np, idx: ni, report };
}

// ---------- Coupe du socle ----------
// Garde ce qui est au-dessus de la hauteur y0 et referme la coupe par une face plane (le dessous de la figurine).
export async function cutMesh(pos, idx, y0) {
  const V = pos.length / 3, T = idx.length / 3;
  // aucun sommet pile sur le plan, pour que chaque point de coupe soit unique
  for (let g = 0; g < 50; g++) {
    let hit = false;
    for (let i = 1; i < pos.length; i += 3) if (pos[i] === y0) { hit = true; break; }
    if (!hit) break;
    y0 += 1e-4;
  }
  const above = new Uint8Array(V);
  for (let i = 0; i < V; i++) above[i] = pos[i * 3 + 1] > y0 ? 1 : 0;
  const tri = new Grow(Uint32Array, Math.max(1024, T * 3));
  const extra = [], cutAt = new Map(), seg = new Map();
  const cross = (i, j) => {
    const key = i < j ? i * V + j : j * V + i;
    let id = cutAt.get(key);
    if (id !== undefined) return id;
    const t = (y0 - pos[i * 3 + 1]) / (pos[j * 3 + 1] - pos[i * 3 + 1]);
    id = V + extra.length / 3;
    extra.push(pos[i * 3] + t * (pos[j * 3] - pos[i * 3]), y0, pos[i * 3 + 2] + t * (pos[j * 3 + 2] - pos[i * 3 + 2]));
    cutAt.set(key, id);
    return id;
  };
  const addSeg = (from, to) => { if (from === to) return; if (!seg.has(from)) seg.set(from, []); seg.get(from).push(to); };
  for (let t = 0; t < T; t++) {
    const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const s = above[v[0]] + above[v[1]] + above[v[2]];
    if (s === 3) { tri.push3(v[0], v[1], v[2]); continue; }
    if (s === 0) continue;
    // le sommet « seul de son côté » en premier, en gardant le sens de parcours
    const lone = s === 1 ? v.findIndex(x => above[x]) : v.findIndex(x => !above[x]);
    const p = v[lone], q = v[(lone + 1) % 3], r = v[(lone + 2) % 3];
    if (s === 1) {
      const pq = cross(p, q), pr = cross(p, r);
      tri.push3(p, pq, pr);
      addSeg(pr, pq);
    } else {
      const qp = cross(q, p), rp = cross(r, p);
      tri.push3(q, r, rp); tri.push3(q, rp, qp);
      addSeg(qp, rp);
    }
  }
  // contours de la coupe
  const loops = [];
  let open = 0;
  for (const start of seg.keys()) {
    while (seg.get(start).length) {
      const loop = [start];
      let next = seg.get(start).pop(), closed = false;
      while (loop.length < 1e6) {
        if (next === start) { closed = true; break; }
        loop.push(next);
        const l = seg.get(next);
        if (!l || !l.length) break;
        next = l.pop();
      }
      if (closed && loop.length >= 3) loops.push(loop); else open++;
    }
  }
  const allPos = new Float32Array(pos.length + extra.length);
  allPos.set(pos); allPos.set(extra, pos.length);
  let capped = 0;
  if (loops.length) {
    const { ShapeUtils, Vector2 } = await import('./lib/three.module.js');
    const pts = loops.map(l => l.map(i => new Vector2(allPos[i * 3], allPos[i * 3 + 2])));
    const areas = pts.map(p => ShapeUtils.area(p));
    let big = 0;
    for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[big])) big = i;
    const sign = Math.sign(areas[big]) || 1;
    const outers = [], holes = [];
    loops.forEach((l, i) => (Math.sign(areas[i]) === sign ? outers : holes).push(i));
    const inPoly = (pt, poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    const holesOf = new Map(outers.map(o => [o, []]));
    for (const h of holes) {
      let best = -1;
      for (const o of outers) if (inPoly(pts[h][0], pts[o]) && (best < 0 || Math.abs(areas[o]) < Math.abs(areas[best]))) best = o;
      if (best >= 0) holesOf.get(best).push(h);
    }
    for (const o of outers) {
      const hs = holesOf.get(o);
      const ids = [...loops[o], ...hs.flatMap(h => loops[h])];
      let faces;
      try { faces = ShapeUtils.triangulateShape(pts[o].slice(), hs.map(h => pts[h].slice())); } catch (e) { continue; }
      for (const f of faces) {
        let a = ids[f[0]], b = ids[f[1]], c = ids[f[2]];
        if (a === undefined || b === undefined || c === undefined) continue;
        // la face du dessous regarde vers le bas
        const ny = (allPos[b * 3 + 2] - allPos[a * 3 + 2]) * (allPos[c * 3] - allPos[a * 3]) - (allPos[b * 3] - allPos[a * 3]) * (allPos[c * 3 + 2] - allPos[a * 3 + 2]);
        if (ny > 0) [b, c] = [c, b];
        tri.push3(a, b, c);
      }
      capped++;
    }
  }
  const r = compact(allPos, tri.view, null);
  return { pos: r.pos, idx: r.idx, loops: loops.length, capped, open };
}

// Retouches demandées depuis la page : réparation, puis coupe du socle ; renvoie un modèle posé au sol
export async function editModel(pos, idx, opts) {
  let report = null, cut = null;
  if (opts.repair) { const r = repairMesh(pos, idx); pos = r.pos; idx = r.idx; report = r.report; }
  if (opts.cut > 0) { const r = await cutMesh(pos, idx, opts.cut); pos = r.pos; idx = r.idx; cut = { loops: r.loops, capped: r.capped, open: r.open }; }
  const offset = place(pos);
  const out = measure(pos, idx, opts.objects || 1);
  out.offset = offset;
  out.report = report;
  out.cut = cut;
  out.check = out.stats.tris <= CHECK_MAX_TRIS ? analyzeMesh(out.pos, out.idx) : { skipped: true };
  return out;
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
    if (e.data.op === 'edit') {
      try {
        const r = await editModel(e.data.pos, e.data.idx, e.data);
        const transfer = [r.pos.buffer, r.idx.buffer, r.nrm.buffer];
        if (r.check.red) transfer.push(r.check.red.buffer, r.check.orange.buffer);
        self.postMessage({ type: 'edited', pos: r.pos, idx: r.idx, nrm: r.nrm, stats: r.stats, check: r.check, offset: r.offset, report: r.report, cut: r.cut }, transfer);
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.message || err) });
      }
      return;
    }
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
