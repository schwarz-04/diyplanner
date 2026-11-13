import { clone, uid } from './edits';
import type { Home, PlacedRoom, Scene } from './types';

/**
 * Wohnung aus mehreren Räumen. Jeder Raum behält seine eigenen Koordinaten (Szene wie bisher),
 * dazu kommen Lage (position) und Drehung (rotation, Grad) im gemeinsamen Grundriss.
 * Neue Räume werden an eine Wand angebaut; dabei bekommen beide Wände eine Tür an derselben Stelle.
 */

export type Pt = [number, number];

export function isHome(v: unknown): v is Home {
  return !!v && typeof v === 'object' && Array.isArray((v as Home).rooms);
}

/** Altes Format (ein Raum) in eine Wohnung mit einem Raum umwandeln. */
export function toHome(v: Scene | Home): Home {
  if (isHome(v)) return v;
  return { version: 2, rooms: [{ id: uid('room'), position: [0, 0], rotation: 0, scene: v }] };
}

export function replaceRoom(home: Home, index: number, scene: Scene): Home {
  return { ...home, rooms: home.rooms.map((r, i) => (i === index ? { ...r, scene } : r)) };
}

/** Punkt aus Raumkoordinaten in den gemeinsamen Grundriss. */
export function toWorld(r: Pick<PlacedRoom, 'position' | 'rotation'>, p: Pt): Pt {
  const a = (r.rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [r.position[0] + p[0] * c - p[1] * s, r.position[1] + p[0] * s + p[1] * c];
}

const rot = (v: Pt, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
};

function wallGeom(s: Scene, i: number) {
  const p = s.room.polygon;
  const a = p[i];
  const b = p[(i + 1) % p.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const n: Pt = [u[1], -u[0]]; // Außennormale (wie in build.ts)
  return { a, b, len, u, n };
}

/** Leerer rechteckiger Raum (Maße in Metern). */
export function emptyRoom(name: string, length: number, width: number, height: number, template?: Scene): Scene {
  const wallColor = template?.walls[0]?.color ?? '#f1efea';
  return {
    version: 1,
    room: { name, height, polygon: [[0, 0], [length, 0], [length, width], [0, width]] },
    walls: [0, 1, 2, 3].map(() => ({ id: uid('wall'), color: wallColor, thickness: 0.12, openings: [], panels: [] })),
    floor: clone(template?.floor ?? { material: 'wood', color: '#b48a60' }),
    ceiling: clone(template?.ceiling ?? { material: 'paint', color: '#ffffff' }),
    objects: [],
    meta: { source: 'manual', notes: '', dimensions_confirmed: true },
  };
}

/**
 * Baut einen Raum an Wand wallIndex des Raums hostIndex an.
 * Liefert die neue Wohnung oder eine Fehlermeldung.
 */
export function attachRoom(home: Home, hostIndex: number, wallIndex: number, scene: Scene): Home | string {
  const next = clone(home);
  const host = next.rooms[hostIndex];
  const hw = wallGeom(host.scene, wallIndex);
  const doorW = 0.9;
  if (hw.len < doorW + 0.3) return 'Diese Wand ist zu kurz für eine Tür.';
  const room = clone(scene);

  // Wand des neuen Raums: eine mit Tür, sonst die längste
  let j = room.walls.findIndex((w) => w.openings.some((o) => o.type === 'door'));
  if (j < 0) {
    let best = -1;
    room.walls.forEach((_, k) => {
      const l = wallGeom(room, k).len;
      if (l > best) { best = l; j = k; }
    });
  }
  const rw = wallGeom(room, j);
  let door = room.walls[j].openings.find((o) => o.type === 'door');
  if (!door) {
    if (rw.len < doorW + 0.3) return 'Der neue Raum hat keine Wand, die lang genug für eine Tür ist.';
    door = { id: uid('op'), type: 'door', offset: rw.len / 2, width: doorW, height: 2.01, sill: 0 };
    room.walls[j].openings.push(door);
  }

  // Drehung: Außennormale der neuen Wand zeigt genau gegen die der Gastwand
  const nHost = rot(hw.n, host.rotation);
  let rotation = (Math.atan2(-nHost[1], -nHost[0]) - Math.atan2(rw.n[1], rw.n[0])) * (180 / Math.PI);
  rotation = ((rotation % 360) + 360) % 360;
  const snapped = Math.round(rotation / 90) * 90;
  if (Math.abs(snapped - rotation) < 0.5) rotation = snapped % 360;

  // Türmitte des neuen Raums liegt der Mitte der Gastwand gegenüber, um die Wanddicke versetzt
  const gap = host.scene.walls[wallIndex].thickness ?? 0.12;
  const hostOffset = hw.len / 2;
  const target = toWorld(host, [hw.a[0] + hw.u[0] * hostOffset, hw.a[1] + hw.u[1] * hostOffset]);
  const anchorLocal: Pt = [rw.a[0] + rw.u[0] * door.offset, rw.a[1] + rw.u[1] * door.offset];
  const anchor = rot(anchorLocal, rotation);
  const position: Pt = [target[0] + nHost[0] * gap - anchor[0], target[1] + nHost[1] * gap - anchor[1]];

  host.scene.walls[wallIndex].openings = host.scene.walls[wallIndex].openings.filter((o) =>
    Math.abs(o.offset - hostOffset) > (o.width + doorW) / 2);
  host.scene.walls[wallIndex].openings.push({ id: uid('op'), type: 'door', offset: hostOffset, width: door.width, height: door.height, sill: 0 });

  const placed: PlacedRoom = { id: uid('room'), position, rotation, scene: room };
  if (overlapsExisting(next, placed)) return 'An dieser Wand ist kein Platz, dort liegt schon ein anderer Raum.';
  next.rooms.push(placed);
  return next;
}

/** Grobe Prüfung: liegt die Mitte des neuen Raums in einem vorhandenen Raum? */
function overlapsExisting(home: Home, r: PlacedRoom): boolean {
  const poly = r.scene.room.polygon.map((p) => toWorld(r, p));
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return home.rooms.some((o) => pointIn(o.scene.room.polygon.map((p) => toWorld(o, p)), cx, cy));
}

function pointIn(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ Grundriss zum Begehen

export interface WalkWorld {
  rooms: Pt[][];
  /** Wandstücke ohne Türöffnungen */
  solids: [Pt, Pt][];
  /** Durchgänge in Türen (Viereck durch die Wanddicke) */
  passages: Pt[][];
  height: number;
}

export function walkWorld(home: Home): WalkWorld {
  const w: WalkWorld = { rooms: [], solids: [], passages: [], height: Infinity };
  for (const r of home.rooms) {
    const s = r.scene;
    w.rooms.push(s.room.polygon.map((p) => toWorld(r, p)));
    w.height = Math.min(w.height, s.room.height);
    s.walls.forEach((wall, i) => {
      const g = wallGeom(s, i);
      const t = wall.thickness ?? 0.12;
      const at = (off: number, out = 0): Pt => toWorld(r, [g.a[0] + g.u[0] * off + g.n[0] * out, g.a[1] + g.u[1] * off + g.n[1] * out]);
      const doors = wall.openings.filter((o) => o.type === 'door').map((o) => [o.offset - o.width / 2, o.offset + o.width / 2]).sort((p, q) => p[0] - q[0]);
      let cursor = 0;
      for (const [o0, o1] of doors) {
        if (o0 > cursor) w.solids.push([at(cursor), at(o0)]);
        w.passages.push([at(o0, -0.05), at(o1, -0.05), at(o1, t + 0.05), at(o0, t + 0.05)]);
        cursor = Math.max(cursor, o1);
      }
      if (cursor < g.len) w.solids.push([at(cursor), at(g.len)]);
    });
  }
  return w;
}

/** Startpunkt beim Begehen: vor einer Tür des Raums (falls vorhanden), sonst in der Mitte. */
export function walkStart(r: PlacedRoom): { x: number; y: number; look: Pt } {
  const s = r.scene;
  const poly = s.room.polygon;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const center: Pt = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  let start = center;
  for (let i = 0; i < s.walls.length; i++) {
    const door = s.walls[i].openings.find((o) => o.type === 'door');
    if (!door) continue;
    const g = wallGeom(s, i);
    start = [g.a[0] + g.u[0] * door.offset - g.n[0] * 0.6, g.a[1] + g.u[1] * door.offset - g.n[1] * 0.6];
    break;
  }
  const [x, y] = toWorld(r, start);
  return { x, y, look: toWorld(r, center) };
}
