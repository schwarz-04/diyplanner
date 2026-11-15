/**
 * DIY-Bereich: aus Möbeln und Bauteilen (Holzplatten, Leisten, Rollen) ein eigenes Möbel bauen.
 *
 * Die Teile liegen als normale Objekte in einer Werkbank-Szene (Scene.diy = true).
 * Hier wird berechnet, wo Teile aneinander liegen, welche Schrauben dort passen (Größe, Anzahl,
 * Bohrpunkte), und daraus die Materialliste gebaut.
 */
import * as THREE from 'three';
import type { Catalog, DiyBuild, Product, Scene, SceneObject } from './types';

export const BENCH = 3; // Kantenlänge der Werkbank in Metern
const BAUTEILE = new Set(['board', 'batten', 'caster', 'foot']);
/** Plattenstärke fertiger Möbel (IKEA-Korpus), in die geschraubt wird */
const PANEL = 0.016;

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export function benchScene(name: string): Scene {
  return {
    version: 1,
    diy: true,
    room: { name, height: 4, polygon: [[0, 0], [BENCH, 0], [BENCH, BENCH], [0, BENCH]] },
    walls: [],
    floor: { material: 'paint', color: '#e9e4dc' },
    ceiling: { material: 'paint', color: '#ffffff' },
    objects: [],
    meta: { source: 'diy', notes: '', dimensions_confirmed: true },
  };
}

export function newBuild(name: string): DiyBuild {
  return { id: uid('diy'), name, scene: benchScene(name) };
}

export const isBauteil = (category: string): boolean => BAUTEILE.has(category);

// ------------------------------------------------------------------ Geometrie

export interface Box { min: [number, number, number]; max: [number, number, number] }

/** Achsparalleler Quader eines Teils in Werkbank-Koordinaten (x, y, z nach oben). */
export function partBox(o: SceneObject): Box {
  const a = (o.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hx = (o.size[0] * c + o.size[1] * s) / 2;
  const hy = (o.size[0] * s + o.size[1] * c) / 2;
  return {
    min: [o.position[0] - hx, o.position[1] - hy, o.position[2]],
    max: [o.position[0] + hx, o.position[1] + hy, o.position[2] + o.size[2]],
  };
}

export function bounds(objects: SceneObject[]): Box | null {
  if (!objects.length) return null;
  const b: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const o of objects) {
    const p = partBox(o);
    for (let i = 0; i < 3; i++) {
      b.min[i] = Math.min(b.min[i], p.min[i]);
      b.max[i] = Math.max(b.max[i], p.max[i]);
    }
  }
  return b;
}

// ------------------------------------------------------------------ Verbindungen und Schrauben

export interface Screw {
  /** Bohrpunkt auf der Außenseite des durchbohrten Teils */
  at: [number, number, number];
  axis: 0 | 1 | 2;
  /** Richtung der Schraube entlang der Achse (+1 / -1) */
  dir: 1 | -1;
}

export interface Joint {
  /** Teil, durch das gebohrt wird */
  through: SceneObject;
  /** Teil, in das geschraubt wird */
  into: SceneObject;
  /** Durchmesser und Länge in mm */
  dia: number;
  len: number;
  /** Vorbohren im ersten Teil, mm */
  pilot: number;
  screws: Screw[];
  /** Bohrpunkte in cm, gemessen von der linken unteren Ecke der Kontaktfläche */
  points: [number, number][];
  /** Größe der Kontaktfläche in cm */
  area: [number, number];
  kind: 'flaeche' | 'kante' | 'rolle';
}

const LENGTHS = [12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100];
const TOL = 0.003;

/** Dicke eines Teils entlang der Achse, wie sie für die Schraube zählt. */
function thickness(o: SceneObject, box: Box, axis: number): number {
  const t = box.max[axis] - box.min[axis];
  // Fertige Möbel sind hohl: geschraubt wird in die Korpusplatte
  return isBauteil(o.category) ? t : Math.min(t, PANEL);
}

/** Positionen entlang einer Strecke: Randabstand, dann höchstens alle `step` Meter. */
function along(len: number, inset: number, step: number): number[] {
  if (len < inset * 2 + 0.02) return [len / 2];
  const span = len - inset * 2;
  const n = Math.max(2, Math.ceil(span / step) + 1);
  return Array.from({ length: n }, (_, i) => inset + (span * i) / (n - 1));
}

/** Alle Stellen, an denen zwei Teile flächig aneinander liegen, mit passenden Schrauben. */
export function joints(objects: SceneObject[], off: string[] = []): Joint[] {
  const out: Joint[] = [];
  const skip = new Set(off);
  const boxes = objects.map(partBox);
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (skip.has(jointKey(objects[i].id, objects[j].id))) continue;
      const A = boxes[i], B = boxes[j];
      for (const axis of [0, 1, 2] as const) {
        // A unter/neben B (dir +1) oder umgekehrt
        const aFirst = Math.abs(A.max[axis] - B.min[axis]) < TOL;
        const bFirst = Math.abs(B.max[axis] - A.min[axis]) < TOL;
        if (!aFirst && !bFirst) continue;
        const [u, v] = ([0, 1, 2] as const).filter((k) => k !== axis);
        const u0 = Math.max(A.min[u], B.min[u]), u1 = Math.min(A.max[u], B.max[u]);
        const v0 = Math.max(A.min[v], B.min[v]), v1 = Math.min(A.max[v], B.max[v]);
        const du = u1 - u0, dv = v1 - v0;
        if (du < 0.008 || dv < 0.008) continue;
        const plane = aFirst ? A.max[axis] : B.max[axis];
        const lower = aFirst ? i : j; // Teil auf der negativen Seite der Kontaktfläche
        const upper = aFirst ? j : i;
        const joint = makeJoint(objects, boxes, lower, upper, axis, plane, [u, v], [u0, v0], [du, dv]);
        if (joint) out.push(joint);
        break;
      }
    }
  }
  return out;
}

function makeJoint(
  objects: SceneObject[], boxes: Box[], lower: number, upper: number, axis: 0 | 1 | 2, plane: number,
  uv: (0 | 1 | 2)[], origin: [number, number], size: [number, number],
): Joint | null {
  const [u, v] = uv;
  const [du, dv] = size;
  const oL = objects[lower], oU = objects[upper];
  const tL = thickness(oL, boxes[lower], axis), tU = thickness(oU, boxes[upper], axis);
  const rolle = [oL, oU].find((o) => o.category === 'caster' || o.category === 'foot');
  // Durch das dünnere Teil bohren; Rollen und Füße werden immer durch ihre Platte verschraubt
  let throughLower = tL <= tU;
  if (rolle) throughLower = rolle === oL;
  else if (isBauteil(oL.category) !== isBauteil(oU.category)) throughLower = isBauteil(oL.category);
  const through = throughLower ? oL : oU;
  const into = throughLower ? oU : oL;
  const t1 = (throughLower ? tL : tU) * 1000;
  const t2 = (throughLower ? tU : tL) * 1000;
  const dir: 1 | -1 = throughLower ? 1 : -1;
  // Außenseite des durchbohrten Teils
  const face = throughLower ? boxes[lower].min[axis] : boxes[upper].max[axis];
  const at = (pu: number, pv: number): Screw => {
    const p: [number, number, number] = [0, 0, 0];
    p[axis] = rolle ? plane : face;
    p[u] = origin[0] + pu;
    p[v] = origin[1] + pv;
    return { at: p, axis, dir };
  };

  let pts: [number, number][];
  let kind: Joint['kind'];
  let len: number;
  let dia: number;
  if (rolle) {
    kind = 'rolle';
    const iu = Math.min(0.008, du / 4), iv = Math.min(0.008, dv / 4);
    pts = rolle.category === 'foot' && Math.min(du, dv) < 0.03 ? [[du / 2, dv / 2]] : [[iu, iv], [du - iu, iv], [iu, dv - iv], [du - iu, dv - iv]];
    dia = 4;
    len = pick(Math.min(16, t2 - 2));
  } else {
    const narrow = Math.min(du, dv) < 0.06;
    if (narrow) {
      // Stoß auf eine Kante: eine Reihe in der Mitte
      kind = 'kante';
      const longU = du >= dv;
      const row = along(longU ? du : dv, 0.05, 0.25);
      pts = row.map((p) => (longU ? [p, dv / 2] : [du / 2, p]) as [number, number]);
    } else {
      kind = 'flaeche';
      const us = along(du, Math.min(0.05, du / 4), 0.3);
      const vs = along(dv, Math.min(0.05, dv / 4), 0.3);
      // Nur der Rand der Fläche, nicht das ganze Raster
      pts = [];
      for (const a of us) for (const b of vs) {
        if (a === us[0] || a === us[us.length - 1] || b === vs[0] || b === vs[vs.length - 1]) pts.push([a, b]);
      }
    }
    // Die Schraube soll möglichst tief greifen, darf aber nicht durchstoßen
    const deep = !isBauteil(into.category) ? t2 : Math.min(t2, Math.max(25, t1 * 1.8));
    len = pick(t1 + deep - 2);
    if (len <= t1 + 5) return null; // zu dünn zum Verschrauben
    dia = t1 <= 12 ? 3.5 : len >= 60 ? 4.5 : 4;
  }
  return {
    through, into, dia, len, pilot: Math.round(dia * 0.7 * 2) / 2, kind,
    screws: pts.map(([a, b]) => at(a, b)),
    points: pts.map(([a, b]) => [Math.round(a * 1000) / 10, Math.round(b * 1000) / 10]),
    area: [Math.round(du * 1000) / 10, Math.round(dv * 1000) / 10],
  };
}

function pick(max: number): number {
  let best = LENGTHS[0];
  for (const l of LENGTHS) if (l <= max) best = l;
  return best;
}

/** Schraubenköpfe als kleine Markierungen in der Werkbank. */
export function buildScrews(scene: Scene): THREE.Group {
  const group = new THREE.Group();
  group.name = 'diy_screws';
  const head = new THREE.MeshStandardMaterial({ color: '#c0396b', roughness: 0.4, metalness: 0.3 });
  const shaft = new THREE.MeshStandardMaterial({ color: '#8d8d8d', roughness: 0.4, metalness: 0.8 });
  for (const j of joints(scene.objects, scene.diyOff)) {
    for (const s of j.screws) {
      const axisVec = new THREE.Vector3(s.axis === 0 ? 1 : 0, s.axis === 2 ? 1 : 0, s.axis === 1 ? -1 : 0).multiplyScalar(s.dir);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisVec);
      const pos = new THREE.Vector3(s.at[0], s.at[2], -s.at[1]);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.003, 12), head);
      h.position.copy(pos).addScaledVector(axisVec, -0.0015);
      h.quaternion.copy(q);
      const len = j.len / 1000;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.001, len, 6), shaft);
      b.position.copy(pos).addScaledVector(axisVec, len / 2);
      b.quaternion.copy(q);
      group.add(h, b);
    }
  }
  return group;
}

// ------------------------------------------------------------------ Materialliste

export interface CutRow { label: string; size: string; count: number }
export interface ScrewRow { label: string; count: number; pilot: number }
export interface PartRow { product: Product; label: string; count: number }

export interface Materials {
  /** Zuschnittliste: Platten und Leisten */
  cuts: CutRow[];
  /** Rollen, Füße und andere Kleinteile ohne Shop-Link */
  hardware: CutRow[];
  /** Möbel ohne Shop-Link */
  furniture: CutRow[];
  /** Fertige Möbel und Produkte mit Shop-Link */
  products: PartRow[];
  screws: ScrewRow[];
  joints: Joint[];
  /** Außenmaße in Metern: Breite, Tiefe, Höhe */
  size: [number, number, number];
}

const cm = (m: number): string => {
  const v = Math.round(m * 1000) / 10;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');
};

export function materials(scene: Scene, catalog: Catalog): Materials {
  const cuts = new Map<string, CutRow>();
  const hardware = new Map<string, CutRow>();
  const furniture = new Map<string, CutRow>();
  const products = new Map<string, PartRow>();
  const add = (map: Map<string, CutRow>, label: string, size: string) => {
    const key = `${label}|${size}`;
    const row = map.get(key) ?? { label, size, count: 0 };
    row.count++;
    map.set(key, row);
  };
  for (const o of scene.objects) {
    const label = o.label || catalog.categories[o.category]?.label || 'Teil';
    if (o.product?.url) {
      const key = `${o.product.url}|${o.product.variant ?? ''}`;
      const row = products.get(key) ?? { product: o.product, label: o.label || o.product.name, count: 0 };
      row.count++;
      products.set(key, row);
    } else if (o.category === 'board' || o.category === 'batten') {
      // Länge × Breite × Stärke, größtes Maß zuerst
      const dims = [...o.size].sort((a, b) => b - a);
      add(cuts, label, `${cm(dims[0])} × ${cm(dims[1])} × ${cm(dims[2])} cm`);
    } else if (isBauteil(o.category)) {
      add(hardware, label, o.category === 'caster' ? `Ø ${cm(Math.min(o.size[0], o.size[1]))} cm, Höhe ${cm(o.size[2])} cm` : `Höhe ${cm(o.size[2])} cm`);
    } else {
      add(furniture, label, `${cm(o.size[0])} × ${cm(o.size[1])} × ${cm(o.size[2])} cm`);
    }
  }
  const js = joints(scene.objects, scene.diyOff);
  const screws = new Map<string, ScrewRow>();
  for (const j of js) {
    const label = `Spanplattenschraube ${String(j.dia).replace('.', ',')} × ${j.len} mm`;
    const row = screws.get(label) ?? { label, count: 0, pilot: j.pilot };
    row.count += j.screws.length;
    screws.set(label, row);
  }
  const b = bounds(scene.objects);
  return {
    cuts: [...cuts.values()], hardware: [...hardware.values()], furniture: [...furniture.values()], products: [...products.values()],
    screws: [...screws.values()], joints: js,
    size: b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [0, 0, 0],
  };
}

/** Fertiges DIY-Möbel als ein Objekt für den Raum (Teile relativ zur Mitte der Grundfläche). */
export function composeObject(build: DiyBuild, base?: SceneObject): SceneObject | null {
  const b = bounds(build.scene.objects);
  if (!b) return null;
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const parts = build.scene.objects.map((o) => ({
    ...structuredClone(o),
    position: [o.position[0] - cx, o.position[1] - cy, o.position[2] - b.min[2]] as [number, number, number],
  }));
  return {
    id: base?.id ?? uid('obj'),
    category: 'diy',
    label: build.name,
    position: base?.position ?? [0, 0, 0],
    rotation: base?.rotation ?? 0,
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    color: build.scene.objects[0]?.color ?? '#d9b98c',
    product: null,
    parts,
    diyId: build.id,
  };
}

/** Höhe, auf der ein neues Teil an der Stelle (x, y) aufliegt: Oberkante des höchsten Teils darunter. */
export function topAt(objects: SceneObject[], x: number, y: number): number {
  let z = 0;
  for (const o of objects) {
    const b = partBox(o);
    if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]) z = Math.max(z, b.max[2]);
  }
  return z;
}

/** Vier Rollen unter die Ecken des untersten Teils setzen und alles um die Rollenhöhe anheben. */
export function withCasters(scene: Scene, label: string, size: [number, number, number] = [0.05, 0.05, 0.07]): Scene {
  const next: Scene = structuredClone(scene);
  const b = bounds(next.objects);
  if (!b) return next;
  const lowest = next.objects.filter((o) => Math.abs(partBox(o).min[2] - b.min[2]) < 0.002);
  const base = bounds(lowest)!;
  const lift = size[2] - b.min[2];
  for (const o of next.objects) o.position[2] += lift;
  const inset = 0.03 + size[0] / 2;
  const xs = [base.min[0] + inset, base.max[0] - inset];
  const ys = [base.min[1] + Math.min(inset, (base.max[1] - base.min[1]) / 2), base.max[1] - Math.min(inset, (base.max[1] - base.min[1]) / 2)];
  for (const x of xs) for (const y of ys) {
    next.objects.push({ id: uid('obj'), category: 'caster', label, position: [x, y, 0], rotation: 0, size: [...size], color: '#4a4a4a', product: null });
  }
  return next;
}

export const jointKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Standardwerte der Bauteile, falls der Katalog der Webseite sie (noch) nicht kennt. */
export const PART_DEFAULTS: Catalog['categories'] = {
  board: { label: 'Holzplatte', size: [0.8, 0.4, 0.018], color: '#d9b98c', group: 'bauteil' },
  batten: { label: 'Leiste', size: [1, 0.04, 0.02], color: '#d9b98c', group: 'bauteil' },
  caster: { label: 'Möbelrolle', size: [0.05, 0.05, 0.07], color: '#4a4a4a', group: 'bauteil' },
  foot: { label: 'Möbelfuß', size: [0.04, 0.04, 0.1], color: '#d9b98c', group: 'bauteil' },
  diy: { label: 'DIY-Möbel', size: [0.8, 0.4, 0.8], color: '#d9b98c', group: 'bauteil' },
} as Catalog['categories'];

/** Richtung der Breite (0) oder Tiefe (1) eines Teils auf der Werkbank. */
function axisDir(o: SceneObject, axis: 0 | 1): [number, number] {
  const a = (o.rotation * Math.PI) / 180;
  return axis === 0 ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)];
}

/** Teil entlang einer Achse kürzen; das vordere Ende bleibt, wo es ist. */
export function cutTo(o: SceneObject, axis: 0 | 1 | 2, length: number): void {
  const old = o.size[axis];
  o.size[axis] = length;
  if (axis === 2) return;
  const d = axisDir(o, axis);
  o.position[0] -= (d[0] * (old - length)) / 2;
  o.position[1] -= (d[1] * (old - length)) / 2;
}

/** Teil an der Stelle `at` (vom vorderen Ende) in zwei Stücke sägen. Gibt das zweite Stück zurück. */
export function splitAt(o: SceneObject, axis: 0 | 1 | 2, at: number): SceneObject {
  const old = o.size[axis];
  const rest: SceneObject = { ...structuredClone(o), id: uid('obj') };
  cutTo(o, axis, at);
  rest.size[axis] = old - at;
  const gap = 0.02; // kleiner Abstand, damit man beide Stücke sieht
  if (axis === 2) rest.position[2] = o.position[2] + at + gap;
  else {
    const d = axisDir(o, axis);
    rest.position[0] = o.position[0] + d[0] * (at / 2 + gap + rest.size[axis] / 2);
    rest.position[1] = o.position[1] + d[1] * (at / 2 + gap + rest.size[axis] / 2);
  }
  return rest;
}

/** Teil kippen: Breite -> Tiefe -> Höhe reihum tauschen (liegend, stehend, hochkant). */
export function tip(o: SceneObject): void {
  o.size = [o.size[2], o.size[0], o.size[1]];
}

/** Teil a an Teil b heranschieben, bis sich zwei Flächen berühren. false: lagen schon aneinander. */
export function attach(a: SceneObject, b: SceneObject): boolean {
  const A = partBox(a), B = partBox(b);
  const gap = [0, 1, 2].map((k) => (A.min[k] > B.max[k] ? B.max[k] - A.min[k] : A.max[k] < B.min[k] ? B.min[k] - A.max[k] : 0));
  if (gap.every((g) => Math.abs(g) < 0.0005)) {
    const touching = [0, 1, 2].some((k) => Math.abs(A.min[k] - B.max[k]) < 0.003 || Math.abs(A.max[k] - B.min[k]) < 0.003);
    if (touching) return false;
    // Teile stecken ineinander: a obenauf setzen
    a.position[2] = B.max[2];
    return true;
  }
  // In der Richtung mit dem größten Abstand heranschieben, in den anderen so weit, dass sich die Flächen überdecken
  const main = gap.map(Math.abs).indexOf(Math.max(...gap.map(Math.abs)));
  for (let k = 0; k < 3; k++) {
    if (k === main || gap[k] === 0) continue;
    const size = A.max[k] - A.min[k];
    const need = Math.min(size, B.max[k] - B.min[k], 0.02);
    a.position[k] += gap[k] + Math.sign(gap[k]) * (k === 2 ? need : Math.min(size, need));
  }
  a.position[main] += gap[main];
  if (a.position[2] < 0) a.position[2] = 0;
  return true;
}
