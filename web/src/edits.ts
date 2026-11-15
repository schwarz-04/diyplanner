import { inwardNormal } from './measure';
import type { Catalog, Category, Panel, Scene, SceneObject } from './types';

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(16).slice(2, 10)}`;

export function wallLength(scene: Scene, i: number): number {
  const p = scene.room.polygon;
  const a = p[i];
  const b = p[(i + 1) % p.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function roomCenter(scene: Scene): [number, number] {
  const p = scene.room.polygon;
  const xs = p.map((v) => v[0]);
  const ys = p.map((v) => v[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function roomArea(scene: Scene): number {
  const p = scene.room.polygon;
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Wand auf ein gemessenes Maß bringen.
 * Achsenparallele Wand: der Raum wird nur in dieser Richtung gestreckt (Möbelgrößen bleiben).
 * Schräge Wand oder "proportional": der ganze Raum wird gleichmäßig skaliert.
 */
export function setWallLength(scene: Scene, index: number, newLength: number, proportional: boolean): Scene {
  const s = clone(scene);
  const current = wallLength(s, index);
  if (current < 0.01 || newLength < 0.1) return s;
  const factor = newLength / current;
  const p = s.room.polygon;
  const a = p[index];
  const b = p[(index + 1) % p.length];
  const alongX = Math.abs(b[1] - a[1]) < 1e-3;
  const alongY = Math.abs(b[0] - a[0]) < 1e-3;
  const fx = proportional || !(alongX || alongY) ? factor : alongX ? factor : 1;
  const fy = proportional || !(alongX || alongY) ? factor : alongY ? factor : 1;
  const ox = Math.min(...p.map((v) => v[0]));
  const oy = Math.min(...p.map((v) => v[1]));
  const map = (x: number, y: number): [number, number] => [ox + (x - ox) * fx, oy + (y - oy) * fy];

  const oldLengths = s.walls.map((_, i) => wallLength(s, i));
  s.room.polygon = p.map(([x, y]) => map(x, y));
  s.walls.forEach((wall, i) => {
    const k = wallLength(s, i) / (oldLengths[i] || 1);
    for (const op of wall.openings) op.offset *= k;
    for (const pn of wall.panels) {
      pn.offset *= k;
      if (pn.width) pn.width *= k;
    }
  });
  for (const o of s.objects) {
    const [x, y] = map(o.position[0], o.position[1]);
    o.position = [x, y, o.position[2]];
  }
  s.meta.dimensions_confirmed = true;
  return s;
}

export interface NewObjectOptions {
  /** Wand für Wandobjekte (Bilder, Spiegel, Vorhänge); ohne Angabe die längste Wand */
  wall?: number;
  label?: string;
  size?: [number, number, number];
  color?: string;
  product?: SceneObject['product'];
}

export function newObject(scene: Scene, catalog: Catalog, category: Category, opt: NewObjectOptions = {}): SceneObject {
  const c = catalog.categories[category] ?? catalog.categories.box;
  const size = [...(opt.size ?? c.size)] as [number, number, number];
  const H = scene.room.height;
  let [x, y] = roomCenter(scene);
  let z = scene.diy ? 0 : c.z ?? 0;
  let rotation = 0;
  if (c.mount === 'ceiling') {
    size[2] = Math.min(size[2], H - 0.3);
    z = H - size[2];
  } else if (c.mount === 'wall' && scene.walls.length) {
    let i = opt.wall ?? -1;
    if (i < 0 || i >= scene.walls.length) {
      const lengths = scene.walls.map((_, k) => wallLength(scene, k));
      i = lengths.indexOf(Math.max(...lengths));
    }
    const p = scene.room.polygon;
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const n = inwardNormal(p, i);
    // mehrere Bilder an derselben Wand nebeneinander statt übereinander
    const same = scene.objects.filter((o) => o.category === category).length;
    const t = 0.5 + (((same % 5) - 2) * 0.15);
    const off = size[1] / 2 + 0.005;
    x = a[0] + (b[0] - a[0]) * t + n[0] * off;
    y = a[1] + (b[1] - a[1]) * t + n[1] * off;
    rotation = ((Math.atan2(n[0], -n[1]) * 180) / Math.PI + 360) % 360;
    size[2] = Math.min(size[2], H - z - 0.05);
  }
  return {
    id: uid('obj'),
    category,
    label: opt.label ?? c.label,
    position: [x, y, z],
    rotation: Math.round(rotation * 10) / 10,
    size,
    color: opt.color ?? c.color,
    product: opt.product ?? null,
  };
}

export function newPanel(catalog: Catalog, type: Panel['type'], roomHeight: number): Panel {
  const c = catalog.panels[type];
  return {
    id: uid('pn'),
    type,
    offset: 0,
    width: null,
    height: Math.min(c.height, roomHeight),
    bottom: 0,
    color: c.color,
  };
}

/** Ermittelt die Wand-Indexnummer zu einer Wand-ID. */
export const wallIndex = (scene: Scene, id: string) => scene.walls.findIndex((w) => w.id === id);

export function findPanel(scene: Scene, id: string) {
  for (const [i, w] of scene.walls.entries()) {
    const p = w.panels.find((x) => x.id === id);
    if (p) return { wall: w, wallIndex: i, panel: p };
  }
  return null;
}

/** Meter -> cm, auf Millimeter genau (Plattenstärken) */
export const cm = (m: number) => Math.round(m * 1000) / 10;
export const m = (cmValue: number) => cmValue / 100;
