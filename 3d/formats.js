// Atelier 3D : lecture des autres formats 3D (OBJ, PLY, OFF, GLB/GLTF, FBX, DAE, 3DS, AMF, VRML, X3D).
// Tout se lit dans le worker, sur l'ordinateur. Chaque lecteur renvoie { pos, idx, objects, yUp, col? } :
// pos = sommets (Float32Array), idx = triangles (Uint32Array), col = couleurs sRGB par sommet (Uint8Array RGB), si le fichier en a.
import { unzipSync, unzlibSync } from './lib/fflate.module.js';

class Grow {
  constructor(Type, n = 1 << 16) { this.T = Type; this.a = new Type(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new this.T(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push(v) { this.need(1); this.a[this.n++] = v; }
  push3(x, y, z) { this.need(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
  get view() { return this.a.subarray(0, this.n); }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
// glTF et FBX donnent des couleurs linéaires ; on les garde en sRGB comme celles de la palette
const lin2srgb = (c) => clamp255((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
const unit2byte = (c) => clamp255(c * 255);

// Assemble un modèle à partir de plusieurs morceaux (sommets, triangles, couleurs facultatives)
class Builder {
  constructor() { this.pos = new Grow(Float32Array, 1 << 18); this.idx = new Grow(Uint32Array, 1 << 19); this.col = null; this.objects = 0; }
  get nv() { return this.pos.n / 3; }
  vertex(x, y, z) { this.pos.push3(x, y, z); if (this.col) this.col.push3(255, 255, 255); }
  color(i, r, g, b) {
    if (!this.col) { this.col = new Grow(Uint8Array, Math.max(this.pos.a.length, 3)); this.col.need(this.pos.n); this.col.a.fill(255, 0, this.pos.n); this.col.n = this.pos.n; }
    this.col.a[i * 3] = r; this.col.a[i * 3 + 1] = g; this.col.a[i * 3 + 2] = b;
  }
  tri(a, b, c) { this.idx.push3(a, b, c); }
  // polygone convexe (ou presque) découpé en éventail
  poly(list) { for (let k = 1; k + 1 < list.length; k++) this.idx.push3(list[0], list[k], list[k + 1]); }
  done(yUp, extra = {}) {
    const nv = this.nv;
    const idx = this.idx.view;
    let n = 0;
    const out = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (a < nv && b < nv && c < nv && a !== b && b !== c && a !== c) { out[n++] = a; out[n++] = b; out[n++] = c; }
    }
    if (!n) throw new Error('le fichier ne contient aucun triangle');
    const r = { pos: this.pos.view.slice(), idx: out.slice(0, n), objects: Math.max(1, this.objects), yUp, ...extra };
    if (this.col) r.col = this.col.a.slice(0, nv * 3);
    return r;
  }
}

// Transformation affine 4×4 (colonnes, comme glTF) appliquée aux sommets ajoutés depuis « from »
function applyMat(b, from, m) {
  if (!m) return;
  const a = b.pos.a;
  for (let i = from * 3; i < b.pos.n; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    a[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    a[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    a[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}
function matMul(a, b) {
  if (!a) return b; if (!b) return a;
  const r = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    r[i * 4 + j] = s;
  }
  return r;
}
const textOf = (buf) => new TextDecoder().decode(buf);

// Parcourt un texte ligne par ligne sans créer de grand tableau de lignes
function eachLine(text, fn) {
  let s = 0;
  const n = text.length;
  while (s < n) {
    let e = text.indexOf('\n', s); if (e < 0) e = n;
    fn(text, s, e);
    s = e + 1;
  }
}
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
function numbers(s) { const out = []; NUM.lastIndex = 0; let m; while ((m = NUM.exec(s))) out.push(+m[0]); return out; }

// ---------- OBJ (Wavefront) : Y vers le haut ----------
export function readOBJ(buf, progress) {
  const text = textOf(buf);
  const b = new Builder();
  let cols = false;
  const total = text.length;
  let line = 0;
  eachLine(text, (t, s, e) => {
    if ((++line & 0x3ffff) === 0) progress(s / total * 0.9);
    let i = s; while (i < e && (t.charCodeAt(i) === 32 || t.charCodeAt(i) === 9)) i++;
    const c0 = t.charCodeAt(i), c1 = t.charCodeAt(i + 1);
    if (c0 === 118 && (c1 === 32 || c1 === 9)) {          // « v x y z [r g b] »
      const v = numbers(t.slice(i + 2, e));
      b.vertex(v[0] || 0, v[1] || 0, v[2] || 0);
      if (v.length >= 6) {
        const k = v[3] > 1 || v[4] > 1 || v[5] > 1 ? 1 : 255;
        b.color(b.nv - 1, clamp255(v[3] * k), clamp255(v[4] * k), clamp255(v[5] * k)); cols = true;
      }
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)) {   // « f a/b/c d/e/f … »
      const parts = t.slice(i + 2, e).trim().split(/\s+/);
      const list = [];
      const nv = b.nv;
      for (const p of parts) {
        const k = parseInt(p, 10);
        if (Number.isNaN(k)) continue;
        list.push(k < 0 ? nv + k : k - 1);
      }
      if (list.length >= 3) b.poly(list);
    } else if ((c0 === 111 || c0 === 103) && (c1 === 32 || c1 === 9)) b.objects++;   // o / g
  });
  if (!cols) b.col = null;
  return b.done(true);
}

// ---------- PLY : ASCII ou binaire, couleurs par sommet ; Z vers le haut ----------
const PLY_T = {
  char: ['getInt8', 1], int8: ['getInt8', 1], uchar: ['getUint8', 1], uint8: ['getUint8', 1],
  short: ['getInt16', 2], int16: ['getInt16', 2], ushort: ['getUint16', 2], uint16: ['getUint16', 2],
  int: ['getInt32', 4], int32: ['getInt32', 4], uint: ['getUint32', 4], uint32: ['getUint32', 4],
  float: ['getFloat32', 4], float32: ['getFloat32', 4], double: ['getFloat64', 8], float64: ['getFloat64', 8],
};
export function readPLY(buf, progress) {
  const bytes = new Uint8Array(buf);
  const headEnd = (() => { const s = textOf(bytes.subarray(0, Math.min(bytes.length, 65536))); const k = s.indexOf('end_header'); if (k < 0) throw new Error('en-tête PLY introuvable'); const nl = s.indexOf('\n', k); return { text: s.slice(0, k), off: new TextEncoder().encode(s.slice(0, nl + 1)).length }; })();
  const lines = headEnd.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let format = 'ascii';
  const els = [];
  for (const l of lines) {
    const w = l.split(/\s+/);
    if (w[0] === 'format') format = w[1];
    else if (w[0] === 'element') els.push({ name: w[1], count: +w[2], props: [] });
    else if (w[0] === 'property' && els.length) {
      if (w[1] === 'list') els[els.length - 1].props.push({ list: true, ct: w[2], t: w[3], name: w[4] });
      else els[els.length - 1].props.push({ t: w[1], name: w[2] });
    }
  }
  const b = new Builder();
  let hasCol = false;
  const vEl = els.find(e => e.name === 'vertex');
  if (!vEl) throw new Error('aucun sommet dans ce PLY');
  const pi = (n) => vEl.props.findIndex(p => p.name === n);
  const ix = pi('x'), iy = pi('y'), iz = pi('z');
  const ir = Math.max(pi('red'), pi('diffuse_red'), pi('r')), ig = Math.max(pi('green'), pi('diffuse_green'), pi('g')), ib = Math.max(pi('blue'), pi('diffuse_blue'), pi('b'));
  const colFloat = ir >= 0 && /float|double/.test(vEl.props[ir].t);
  const onVertex = (vals) => {
    b.vertex(vals[ix], vals[iy], vals[iz]);
    if (ir >= 0 && ig >= 0 && ib >= 0) {
      const k = colFloat ? 255 : 1;
      b.color(b.nv - 1, clamp255(vals[ir] * k), clamp255(vals[ig] * k), clamp255(vals[ib] * k)); hasCol = true;
    }
  };
  const onFace = (list) => { if (list && list.length >= 3) b.poly(list); };
  if (format === 'ascii') {
    const text = textOf(bytes.subarray(headEnd.off));
    let li = 0, ei = 0, left = els[0] ? els[0].count : 0;
    eachLine(text, (t, s, e) => {
      while (ei < els.length && left === 0) { ei++; left = els[ei] ? els[ei].count : 0; }
      if (ei >= els.length) return;
      const raw = t.slice(s, e).trim(); if (!raw) return;
      const v = raw.split(/\s+/).map(Number);
      const el = els[ei]; left--;
      if ((++li & 0x3ffff) === 0) progress(s / text.length * 0.9);
      if (el === vEl) onVertex(v);
      else if (el.name === 'face') {
        let k = 0; let list = null;
        for (const p of el.props) {
          if (p.list) { const n = v[k++]; const l = v.slice(k, k + n); k += n; if (/vertex_ind/.test(p.name)) list = l; }
          else k++;
        }
        onFace(list);
      }
    });
  } else {
    const le = format === 'binary_little_endian';
    const dv = new DataView(buf, headEnd.off);
    let o = 0;
    const rd = (t) => { const [f, n] = PLY_T[t]; const v = dv[f](o, le); o += n; return v; };
    for (const el of els) {
      const isV = el === vEl, isF = el.name === 'face';
      for (let i = 0; i < el.count; i++) {
        if (isV) { const vals = el.props.map(p => p.list ? (() => { const n = rd(p.ct); for (let k = 0; k < n; k++) rd(p.t); return 0; })() : rd(p.t)); onVertex(vals); }
        else {
          let list = null;
          for (const p of el.props) {
            if (p.list) { const n = rd(p.ct); const l = new Array(n); for (let k = 0; k < n; k++) l[k] = rd(p.t); if (isF && /vertex_ind/.test(p.name)) list = l; }
            else rd(p.t);
          }
          if (isF) onFace(list);
        }
        if ((i & 0x3ffff) === 0) progress(Math.min(0.9, o / dv.byteLength * 0.9));
      }
    }
  }
  if (!hasCol) b.col = null;
  b.objects = 1;
  return b.done(false);
}

// ---------- OFF / COFF : Z vers le haut ----------
export function readOFF(buf) {
  const lines = textOf(buf).split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  if (!lines.length || !/^C?N?OFF/i.test(lines[0])) throw new Error('fichier OFF invalide');
  const hasCol = /^C/i.test(lines[0]);
  let li = 0;
  let counts = numbers(lines[0].replace(/^C?N?OFF/i, ''));
  if (counts.length < 2) { li = 1; counts = numbers(lines[1]); }
  li++;
  const nv = counts[0], nf = counts[1];
  const b = new Builder();
  for (let i = 0; i < nv && li < lines.length; i++, li++) {
    const v = numbers(lines[li]);
    b.vertex(v[0], v[1], v[2]);
    if (hasCol && v.length >= 6) { const s = v[3] > 1 || v[4] > 1 || v[5] > 1 ? 1 : 255; b.color(i, clamp255(v[3] * s), clamp255(v[4] * s), clamp255(v[5] * s)); }
  }
  for (let i = 0; i < nf && li < lines.length; i++, li++) {
    const v = numbers(lines[li]);
    const n = v[0];
    b.poly(v.slice(1, 1 + n));
  }
  b.objects = 1;
  return b.done(false);
}

// ---------- GLB / GLTF : Y vers le haut ----------
const GL_N = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GL_C = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GL_NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function b64(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
export function readGLTF(buf) {
  const bytes = new Uint8Array(buf);
  let json, bin = null;
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {   // « glTF »
    const dv = new DataView(buf);
    let o = 12;
    while (o < buf.byteLength) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      const chunk = bytes.subarray(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(textOf(chunk));
      else if (type === 0x004e4942) bin = chunk;
      o += 8 + len;
    }
  } else json = JSON.parse(textOf(bytes));
  if (!json) throw new Error('fichier glTF invalide');
  const req = json.extensionsRequired || [];
  if (req.includes('KHR_draco_mesh_compression')) throw new Error('compression Draco non prise en charge : exportez le modèle sans compression');
  if (req.includes('EXT_meshopt_compression') || req.includes('KHR_meshopt_compression')) throw new Error('compression meshopt non prise en charge : exportez le modèle sans compression');
  const buffers = (json.buffers || []).map((bf, i) => {
    if (bf.uri == null) return bin;
    const m = /^data:[^,]*;base64,(.*)$/.exec(bf.uri);
    if (m) return b64(m[1]);
    throw new Error('ce .gltf utilise un fichier séparé (' + bf.uri + ') : ouvrez plutôt la version .glb');
  });
  const acc = (i) => {
    const a = json.accessors[i];
    const C = GL_C[a.type], T = GL_N[a.componentType];
    const out = new Float64Array(a.count * C);
    if (a.bufferView != null) {
      const bv = json.bufferViews[a.bufferView];
      const src = buffers[bv.buffer];
      const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
      const stride = bv.byteStride || C * T.BYTES_PER_ELEMENT;
      const dv = new DataView(src.buffer, src.byteOffset);
      const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
      for (let i2 = 0; i2 < a.count; i2++) for (let c = 0; c < C; c++) out[i2 * C + c] = dv[get](off + i2 * stride + c * T.BYTES_PER_ELEMENT, true);
      if (a.normalized && GL_NORM[a.componentType]) { const d = GL_NORM[a.componentType]; for (let k = 0; k < out.length; k++) out[k] = Math.max(out[k] / d, -1); }
    }
    return { v: out, C, count: a.count, ct: a.componentType, norm: a.normalized };
  };
  const b = new Builder();
  const nodeMat = (n) => {
    if (n.matrix) return n.matrix;
    const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
  };
  let hasCol = false;
  const emitMesh = (mi, M) => {
    const mesh = json.meshes[mi];
    for (const p of mesh.primitives || []) {
      const mode = p.mode == null ? 4 : p.mode;
      if (mode < 4 || p.attributes.POSITION == null) continue;
      const P = acc(p.attributes.POSITION);
      const base = b.nv;
      for (let i = 0; i < P.count; i++) b.vertex(P.v[i * 3], P.v[i * 3 + 1], P.v[i * 3 + 2]);
      applyMat(b, base, M);
      if (p.attributes.COLOR_0 != null) {
        const Cc = acc(p.attributes.COLOR_0);
        const isInt = Cc.ct !== 5126;
        for (let i = 0; i < Cc.count; i++) {
          let r = Cc.v[i * Cc.C], g = Cc.v[i * Cc.C + 1], bl = Cc.v[i * Cc.C + 2];
          if (isInt && !Cc.norm) { const d = GL_NORM[Cc.ct] || 1; r /= d; g /= d; bl /= d; }
          b.color(base + i, lin2srgb(r), lin2srgb(g), lin2srgb(bl));
        }
        hasCol = true;
      } else if (p.material != null && json.materials && json.materials[p.material]) {
        const f = (json.materials[p.material].pbrMetallicRoughness || {}).baseColorFactor;
        if (f && (f[0] < 0.999 || f[1] < 0.999 || f[2] < 0.999)) { for (let i = 0; i < P.count; i++) b.color(base + i, lin2srgb(f[0]), lin2srgb(f[1]), lin2srgb(f[2])); hasCol = true; }
      }
      const I = p.indices != null ? acc(p.indices).v : null;
      const n = I ? I.length : P.count;
      const at = (k) => base + (I ? I[k] : k);
      if (mode === 4) for (let k = 0; k + 2 < n; k += 3) b.tri(at(k), at(k + 1), at(k + 2));
      else if (mode === 5) for (let k = 0; k + 2 < n; k++) { if (k & 1) b.tri(at(k + 1), at(k), at(k + 2)); else b.tri(at(k), at(k + 1), at(k + 2)); }
      else if (mode === 6) for (let k = 1; k + 1 < n; k++) b.tri(at(0), at(k), at(k + 1));
      b.objects++;
    }
  };
  const walk = (ni, parent, depth) => {
    if (depth > 64) return;
    const n = json.nodes[ni];
    const M = matMul(parent, nodeMat(n));
    if (n.mesh != null) emitMesh(n.mesh, M);
    for (const c of n.children || []) walk(c, M, depth + 1);
  };
  const scene = json.scenes && json.scenes[json.scene || 0];
  if (scene && scene.nodes) for (const ni of scene.nodes) walk(ni, null, 0);
  else (json.meshes || []).forEach((_, i) => emitMesh(i, null));
  if (!hasCol) b.col = null;
  return b.done(true);
}

// ---------- 3DS (3D Studio) : Z vers le haut ----------
export function read3DS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint16(0, true) !== 0x4d4d) throw new Error('fichier 3DS invalide');
  const b = new Builder();
  let base = 0;
  const walk = (start, end) => {
    let o = start;
    while (o + 6 <= end) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > end) break;
      const s = o + 6, e = o + len;
      if (id === 0x4d4d || id === 0x3d3d || id === 0x4100) walk(s, e);
      else if (id === 0x4000) { let k = s; while (k < e && dv.getUint8(k) !== 0) k++; b.objects++; walk(k + 1, e); }
      else if (id === 0x4110) { const n = dv.getUint16(s, true); base = b.nv; for (let i = 0; i < n; i++) { const p = s + 2 + i * 12; b.vertex(dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)); } }
      else if (id === 0x4120) { const n = dv.getUint16(s, true); for (let i = 0; i < n; i++) { const p = s + 2 + i * 8; b.tri(base + dv.getUint16(p, true), base + dv.getUint16(p + 2, true), base + dv.getUint16(p + 4, true)); } }
      o = e;
    }
  };
  walk(0, buf.byteLength);
  return b.done(false);
}

// ---------- Petit lecteur XML (DAE, AMF, X3D) sans DOM, utilisable dans un worker ----------
function parseXML(text) {
  const root = { name: '#root', a: {}, c: [], t: '' };
  const stack = [root];
  const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
  const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let last = 0, m;
  while ((m = TAG.exec(text))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.t += text.slice(last, m.index);
    last = TAG.lastIndex;
    if (m[5] != null) { top.t += m[5]; continue; }
    if (!m[2]) continue;
    const name = m[2].replace(/^.*:/, '');
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const el = { name, a: {}, c: [], t: '' };
    let am; ATTR.lastIndex = 0;
    while ((am = ATTR.exec(m[3] || ''))) el.a[am[1].replace(/^.*:/, '')] = am[2] != null ? am[2] : am[3];
    top.c.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}
const kids = (el, name) => el.c.filter(c => c.name === name);
const kid = (el, name) => el.c.find(c => c.name === name);
function* all(el, name) { for (const c of el.c) { if (c.name === name) yield c; yield* all(c, name); } }

// ---------- AMF : Z vers le haut, peut être compressé (zip) ----------
const AMF_UNIT = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, feet: 304.8, meter: 1000 };
export function readAMF(buf) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { const z = unzipSync(bytes); const f = Object.keys(z).find(n => /\.amf$/i.test(n)) || Object.keys(z)[0]; bytes = z[f]; }
  const doc = parseXML(textOf(bytes));
  const amf = [...all(doc, 'amf')][0] || doc;
  const u = AMF_UNIT[(amf.a.unit || 'millimeter').toLowerCase()] || 1;
  const b = new Builder();
  let hasCol = false;
  for (const obj of all(amf, 'object')) {
    for (const mesh of kids(obj, 'mesh')) {
      const base = b.nv;
      const verts = kid(mesh, 'vertices');
      if (!verts) continue;
      for (const v of kids(verts, 'vertex')) {
        const c = kid(v, 'coordinates');
        const g = (n) => +((kid(c, n) || { t: '0' }).t);
        b.vertex(g('x') * u, g('y') * u, g('z') * u);
        const col = kid(v, 'color');
        if (col) { const q = (n) => +((kid(col, n) || { t: '1' }).t); b.color(b.nv - 1, unit2byte(q('r')), unit2byte(q('g')), unit2byte(q('b'))); hasCol = true; }
      }
      for (const vol of kids(mesh, 'volume')) for (const t of kids(vol, 'triangle')) {
        const g = (n) => base + +((kid(t, n) || { t: '0' }).t);
        b.tri(g('v1'), g('v2'), g('v3'));
      }
      b.objects++;
    }
  }
  if (!hasCol) b.col = null;
  return b.done(false);
}

// ---------- DAE (Collada) : axe et unité lus dans le fichier ----------
export function readDAE(buf) {
  const doc = parseXML(textOf(buf));
  const asset = [...all(doc, 'asset')][0];
  const upEl = asset && kid(asset, 'up_axis');
  const unitEl = asset && kid(asset, 'unit');
  const up = upEl ? upEl.t.trim().toUpperCase() : 'Y_UP';
  const meters = unitEl && unitEl.a.meter ? +unitEl.a.meter : 1;
  const geoms = new Map();
  for (const g of all(doc, 'geometry')) geoms.set(g.a.id, g);
  const b = new Builder();
  const emitGeom = (g, M) => {
    const mesh = kid(g, 'mesh'); if (!mesh) return;
    const src = new Map();
    for (const s of kids(mesh, 'source')) { const fa = kid(s, 'float_array'); if (fa) src.set(s.a.id, numbers(fa.t)); }
    const vtx = kid(mesh, 'vertices');
    const vpos = vtx ? (kids(vtx, 'input').find(i => i.a.semantic === 'POSITION') || {}).a : null;
    const vid = vtx ? vtx.a.id : null;
    for (const prim of mesh.c.filter(c => /^(triangles|polylist|polygons|trifans|tristrips)$/.test(c.name))) {
      const inputs = kids(prim, 'input');
      const stride = inputs.reduce((s, i) => Math.max(s, +(i.a.offset || 0) + 1), 1);
      const vin = inputs.find(i => i.a.semantic === 'VERTEX') || inputs.find(i => i.a.semantic === 'POSITION');
      if (!vin) continue;
      const sid = vin.a.source.replace('#', '');
      const P = src.get(sid === vid && vpos ? vpos.source.replace('#', '') : sid);
      if (!P) continue;
      const off = +(vin.a.offset || 0);
      const base = b.nv;
      for (let i = 0; i + 2 < P.length; i += 3) b.vertex(P[i], P[i + 1], P[i + 2]);
      applyMat(b, base, M);
      const ps = kids(prim, 'p').map(p => numbers(p.t));
      const vc = kid(prim, 'vcount') ? numbers(kid(prim, 'vcount').t) : null;
      for (const p of ps) {
        const at = (k) => base + p[k * stride + off];
        const nIdx = Math.floor(p.length / stride);
        if (prim.name === 'triangles') for (let k = 0; k + 2 < nIdx; k += 3) b.tri(at(k), at(k + 1), at(k + 2));
        else if (prim.name === 'polylist' && vc) { let k = 0; for (const n of vc) { const l = []; for (let j = 0; j < n; j++) l.push(at(k + j)); b.poly(l); k += n; } }
        else if (prim.name === 'tristrips') for (let k = 0; k + 2 < nIdx; k++) { if (k & 1) b.tri(at(k + 1), at(k), at(k + 2)); else b.tri(at(k), at(k + 1), at(k + 2)); }
        else { const l = []; for (let k = 0; k < nIdx; k++) l.push(at(k)); b.poly(l); }
      }
      b.objects++;
    }
  };
  // instances placées dans la scène, avec leurs matrices ; sinon toutes les géométries telles quelles
  let placed = 0;
  const walkNode = (n, parent, depth) => {
    if (depth > 64) return;
    let M = parent;
    for (const c of n.c) {
      if (c.name === 'matrix') { const v = numbers(c.t); if (v.length === 16) M = matMul(M, [v[0], v[4], v[8], v[12], v[1], v[5], v[9], v[13], v[2], v[6], v[10], v[14], v[3], v[7], v[11], v[15]]); }
      else if (c.name === 'translate') { const v = numbers(c.t); M = matMul(M, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1]); }
      else if (c.name === 'scale') { const v = numbers(c.t); M = matMul(M, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]); }
    }
    for (const c of n.c) {
      if (c.name === 'instance_geometry') { const g = geoms.get((c.a.url || '').replace('#', '')); if (g) { emitGeom(g, M); placed++; } }
      else if (c.name === 'node') walkNode(c, M, depth + 1);
    }
  };
  for (const vs of all(doc, 'visual_scene')) for (const n of kids(vs, 'node')) walkNode(n, null, 0);
  if (!placed) for (const g of geoms.values()) emitGeom(g, null);
  const r = b.done(up !== 'Z_UP');
  // unité du fichier → millimètres
  const k = meters * 1000;
  if (Math.abs(k - 1) > 1e-6) for (let i = 0; i < r.pos.length; i++) r.pos[i] *= k;
  if (up === 'X_UP') for (let i = 0; i < r.pos.length; i += 3) { const x = r.pos[i]; r.pos[i] = -r.pos[i + 1]; r.pos[i + 1] = x; }
  return r;
}

// ---------- FBX binaire ou texte : géométries, unité du fichier ----------
export function readFBX(buf) {
  const bytes = new Uint8Array(buf);
  const head = textOf(bytes.subarray(0, 20));
  const b = new Builder();
  let unitScale = 1;     // centimètres par unité FBX
  const addGeom = (V, I) => {
    if (!V || !I) return;
    const base = b.nv;
    for (let i = 0; i + 2 < V.length; i += 3) b.vertex(V[i], V[i + 1], V[i + 2]);
    let list = [];
    for (let k = 0; k < I.length; k++) {
      let v = I[k];
      const end = v < 0; if (end) v = ~v;
      list.push(base + v);
      if (end) { b.poly(list); list = []; }
    }
    b.objects++;
  };
  if (head === 'Kaydara FBX Binary  ') {
    const dv = new DataView(buf);
    const ver = dv.getUint32(23, true);
    const big = ver >= 7500;
    const readNode = (o) => {
      const end = big ? Number(dv.getBigUint64(o, true)) : dv.getUint32(o, true);
      const np = big ? Number(dv.getBigUint64(o + 8, true)) : dv.getUint32(o + 4, true);
      const hl = big ? 25 : 13;
      if (end === 0) return null;
      const nameLen = dv.getUint8(o + hl - 1);
      const name = textOf(bytes.subarray(o + hl, o + hl + nameLen));
      let p = o + hl + nameLen;
      const props = [];
      for (let i = 0; i < np; i++) {
        const t = String.fromCharCode(dv.getUint8(p)); p++;
        if (t === 'Y') { props.push(dv.getInt16(p, true)); p += 2; }
        else if (t === 'C') { props.push(dv.getUint8(p)); p += 1; }
        else if (t === 'I') { props.push(dv.getInt32(p, true)); p += 4; }
        else if (t === 'F') { props.push(dv.getFloat32(p, true)); p += 4; }
        else if (t === 'D') { props.push(dv.getFloat64(p, true)); p += 8; }
        else if (t === 'L') { props.push(Number(dv.getBigInt64(p, true))); p += 8; }
        else if (t === 'S' || t === 'R') { const n = dv.getUint32(p, true); props.push(t === 'S' ? textOf(bytes.subarray(p + 4, p + 4 + n)) : null); p += 4 + n; }
        else if ('fdlib'.includes(t)) {
          const n = dv.getUint32(p, true), enc = dv.getUint32(p + 4, true), cl = dv.getUint32(p + 8, true);
          let data = bytes.subarray(p + 12, p + 12 + cl);
          if (enc === 1) data = unzlibSync(data);
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          props.push(t === 'd' ? new Float64Array(ab, 0, n) : t === 'f' ? new Float32Array(ab, 0, n) : t === 'i' ? new Int32Array(ab, 0, n) : t === 'l' ? Array.from(new BigInt64Array(ab, 0, n), Number) : new Uint8Array(ab, 0, n));
          p += 12 + cl;
        } else throw new Error('FBX : propriété inconnue');
      }
      const children = [];
      while (p < end) { const c = readNode(p); if (!c) { p += hl; break; } children.push(c); p = c.end; }
      return { name, props, children, end };
    };
    const nodes = [];
    let o = 27;
    while (o < buf.byteLength - 160) { const n = readNode(o); if (!n) break; nodes.push(n); o = n.end; }
    const find = (list, name) => list.find(n => n.name === name);
    const gs = find(nodes, 'GlobalSettings');
    const p70 = gs && find(gs.children, 'Properties70');
    if (p70) for (const P of p70.children) if (P.props[0] === 'UnitScaleFactor') unitScale = +P.props[4] || 1;
    const objs = find(nodes, 'Objects');
    if (objs) for (const g of objs.children) if (g.name === 'Geometry') {
      const V = find(g.children, 'Vertices'), I = find(g.children, 'PolygonVertexIndex');
      addGeom(V && V.props[0], I && I.props[0]);
    }
  } else {
    const text = textOf(bytes);
    const us = /UnitScaleFactor"[^\n]*?,\s*([-\d.eE+]+)\s*$/m.exec(text); if (us) unitScale = +us[1] || 1;
    const RE = /Geometry:[^{]*\{([\s\S]*?)\n\t\}/g; let m;
    while ((m = RE.exec(text))) {
      const blk = m[1];
      const V = /Vertices:\s*(?:\*\d+\s*\{\s*a:)?\s*([-\d.eE+,\s]+)/.exec(blk), I = /PolygonVertexIndex:\s*(?:\*\d+\s*\{\s*a:)?\s*([-\d,\s]+)/.exec(blk);
      if (V && I) addGeom(numbers(V[1]), numbers(I[1]));
    }
  }
  const r = b.done(true);
  const k = unitScale * 10;   // centimètres → millimètres
  if (Math.abs(k - 1) > 1e-6) for (let i = 0; i < r.pos.length; i++) r.pos[i] *= k;
  return r;
}

// ---------- VRML (.wrl, 1.0 et 2.0) : Y vers le haut, couleurs par sommet ou par face ----------
function blockAfter(text, from) {
  const s = text.indexOf('[', from); if (s < 0) return null;
  const e = text.indexOf(']', s); if (e < 0) return null;
  return { body: text.slice(s + 1, e), end: e + 1 };
}
export function readVRML(buf) {
  const text = textOf(buf).replace(/#[^\n]*/g, '');
  const b = new Builder();
  const defs = new Map();
  let lastPoints = null, hasCol = false;
  // repère les DEF de Coordinate et Color pour les USE
  const DEF = /DEF\s+(\S+)\s+(Coordinate3?|Color)\s*\{/g; let dm;
  while ((dm = DEF.exec(text))) { const blk = blockAfter(text, DEF.lastIndex); if (blk) defs.set(dm[1], numbers(blk.body)); }
  const RE = /(Coordinate3)\s*\{|IndexedFaceSet\s*\{/g; let m;
  while ((m = RE.exec(text))) {
    if (m[1]) { const blk = blockAfter(text, RE.lastIndex); if (blk) lastPoints = numbers(blk.body); continue; }
    // corps du nœud IndexedFaceSet (accolades équilibrées)
    let depth = 1, i = RE.lastIndex;
    while (i < text.length && depth) { const ch = text.charCodeAt(i++); if (ch === 123) depth++; else if (ch === 125) depth--; }
    const body = text.slice(RE.lastIndex, i - 1);
    let pts = null;
    const cu = /coord\s+USE\s+(\S+)/.exec(body);
    if (cu) pts = defs.get(cu[1]);
    else { const cp = /coord\s+(?:DEF\s+\S+\s+)?Coordinate\s*\{/.exec(body); if (cp) { const blk = blockAfter(body, cp.index); if (blk) pts = numbers(blk.body); } }
    if (!pts) pts = lastPoints;
    const ci = /coordIndex\s*\[/.exec(body);
    if (!pts || !ci) continue;
    const idxs = numbers(blockAfter(body, ci.index).body);
    const base = b.nv;
    for (let k = 0; k + 2 < pts.length; k += 3) b.vertex(pts[k], pts[k + 1], pts[k + 2]);
    // couleurs
    let cols = null;
    const colU = /color\s+USE\s+(\S+)/.exec(body);
    if (colU) cols = defs.get(colU[1]);
    else { const cc = /color\s+(?:DEF\s+\S+\s+)?Color\s*\{/.exec(body); if (cc) { const blk = blockAfter(body, cc.index); if (blk) cols = numbers(blk.body); } }
    const perVertex = !/colorPerVertex\s+FALSE/i.test(body);
    const cIdx = /colorIndex\s*\[/.exec(body) ? numbers(blockAfter(body, /colorIndex\s*\[/.exec(body).index).body) : null;
    const setC = (v, ci2) => { if (!cols || ci2 * 3 + 2 >= cols.length) return; b.color(base + v, unit2byte(cols[ci2 * 3]), unit2byte(cols[ci2 * 3 + 1]), unit2byte(cols[ci2 * 3 + 2])); hasCol = true; };
    let list = [], face = 0, pos = 0;
    for (let k = 0; k <= idxs.length; k++) {
      const v = k < idxs.length ? idxs[k] : -1;
      if (v < 0) {
        if (list.length >= 3) b.poly(list.map(x => base + x));
        if (cols) for (let j = 0; j < list.length; j++) {
          if (perVertex) setC(list[j], cIdx ? cIdx[pos - list.length + j] : list[j]);
          else setC(list[j], cIdx ? cIdx[face] : face);
        }
        list = []; face++; pos++;
      } else { list.push(v); pos++; }
    }
    b.objects++;
  }
  if (!hasCol) b.col = null;
  return b.done(true);
}

// ---------- X3D (XML) : Y vers le haut ----------
export function readX3D(buf) {
  const doc = parseXML(textOf(buf));
  const b = new Builder();
  const defs = new Map();
  for (const n of all(doc, 'Coordinate')) if (n.a.DEF) defs.set(n.a.DEF, n);
  for (const n of all(doc, 'Color')) if (n.a.DEF) defs.set(n.a.DEF, n);
  for (const n of all(doc, 'ColorRGBA')) if (n.a.DEF) defs.set(n.a.DEF, n);
  let hasCol = false;
  const pointsOf = (set) => { let c = kid(set, 'Coordinate'); if (c && c.a.USE) c = defs.get(c.a.USE); return c ? numbers(c.a.point || '') : null; };
  const colorsOf = (set) => { let c = kid(set, 'Color') || kid(set, 'ColorRGBA'); const four = c && c.name === 'ColorRGBA'; if (c && c.a.USE) c = defs.get(c.a.USE); return c ? { v: numbers(c.a.color || ''), n: four ? 4 : 3 } : null; };
  for (const set of [...all(doc, 'IndexedFaceSet'), ...all(doc, 'IndexedTriangleSet'), ...all(doc, 'TriangleSet')]) {
    const P = pointsOf(set); if (!P) continue;
    const base = b.nv;
    for (let k = 0; k + 2 < P.length; k += 3) b.vertex(P[k], P[k + 1], P[k + 2]);
    const C = colorsOf(set);
    if (C) { const nC = Math.floor(C.v.length / C.n); for (let k = 0; k < Math.min(nC, P.length / 3); k++) b.color(base + k, unit2byte(C.v[k * C.n]), unit2byte(C.v[k * C.n + 1]), unit2byte(C.v[k * C.n + 2])); hasCol = true; }
    if (set.name === 'IndexedFaceSet') {
      const I = numbers(set.a.coordIndex || '');
      let list = [];
      for (let k = 0; k <= I.length; k++) { const v = k < I.length ? I[k] : -1; if (v < 0) { if (list.length >= 3) b.poly(list.map(x => base + x)); list = []; } else list.push(v); }
    } else if (set.name === 'IndexedTriangleSet') {
      const I = numbers(set.a.index || '');
      for (let k = 0; k + 2 < I.length; k += 3) b.tri(base + I[k], base + I[k + 1], base + I[k + 2]);
    } else for (let k = 0; k + 2 < P.length / 3; k += 3) b.tri(base + k, base + k + 1, base + k + 2);
    b.objects++;
  }
  if (!hasCol) b.col = null;
  return b.done(true);
}

// Formats reconnus, par extension
export const EXTENSIONS = ['3mf', 'stl', 'obj', 'ply', 'off', 'glb', 'gltf', 'fbx', 'dae', '3ds', 'amf', 'wrl', 'vrml', 'x3d'];
export function readerFor(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase();
  return { obj: readOBJ, ply: readPLY, off: readOFF, glb: readGLTF, gltf: readGLTF, fbx: readFBX, dae: readDAE, '3ds': read3DS, amf: readAMF, wrl: readVRML, vrml: readVRML, x3d: readX3D }[ext] || null;
}
