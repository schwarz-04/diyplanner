/**
 * Baut aus der Szenenbeschreibung (Format: web/src/types.ts) die 3D-Szene direkt im Browser.
 *
 * Geometrie wird im Grundriss-System aufgebaut (x, y, z nach oben) und dann in das
 * three.js-System (y nach oben) gedreht: (x, y, z) -> (x, z, -y), siehe planToThree.
 *
 * Jedes Element bekommt userData (dm_id, dm_type, ...), an denen der Editor Wände, Böden und
 * Möbel erkennt. Die Hauptfarbe liegt in einem eigenen Material "<id>_main", damit der Editor
 * einzelne Elemente umfärben kann.
 */
import * as THREE from 'three';
import type { Panel, Scene, SceneObject, Wall } from './types';

const planToThree = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);

// ------------------------------------------------------------------ Materialien

type MatOpts = { roughness?: number; metalness?: number; opacity?: number };

function mat(name: string, color: string, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name,
    color: new THREE.Color(color || '#999999'),
    roughness: o.roughness ?? 0.7,
    metalness: o.metalness ?? 0,
    side: THREE.DoubleSide,
  });
  if (o.opacity !== undefined && o.opacity < 1) {
    m.transparent = true;
    m.opacity = o.opacity;
    m.depthWrite = false;
  }
  return m;
}

/** Gemeinsame Materialien (Beine, Textil, Laub, Keramik, Glas, Rahmen, Filz). */
function sharedMaterials() {
  return {
    accent: mat('accent', '#2f2a26', { roughness: 0.5 }),
    light: mat('textile_light', '#f3f1ec', { roughness: 0.95 }),
    green: mat('leaf', '#4f7a46', { roughness: 0.8 }),
    ceramic: mat('ceramic', '#e9e6e0', { roughness: 0.35 }),
    glass: mat('glass', '#cfe6f2', { roughness: 0.05, opacity: 0.25 }),
    frame: mat('window_frame', '#f4f4f2', { roughness: 0.4 }),
    felt: mat('panel_felt', '#2b2b2b', { roughness: 1 }),
  };
}
type Shared = ReturnType<typeof sharedMaterials>;

// ------------------------------------------------------------------ Geometrie-Baukasten

/** Sammelt Quader, Zylinder und Kugeln (im z-oben-System) je Materialindex. */
class Geo {
  private parts: THREE.BufferGeometry[][] = [];

  private push(g: THREE.BufferGeometry, m: number): void {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute('uv');
    (this.parts[m] ??= []).push(ng);
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m = 0): void {
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return;
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.push(g, m);
  }

  cylinder(cx: number, cy: number, z0: number, z1: number, rBottom: number, rTop = rBottom, m = 0): void {
    const g = new THREE.CylinderGeometry(rTop, rBottom, z1 - z0, 24);
    g.rotateX(Math.PI / 2); // Achse y -> z
    g.translate(cx, cy, (z0 + z1) / 2);
    this.push(g, m);
  }

  sphere(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, m = 0): void {
    const g = new THREE.IcosahedronGeometry(1, 2);
    g.scale(rx, ry, rz);
    g.translate(cx, cy, cz);
    this.push(g, m);
  }

  /** Fertige Geometrie mit Materialgruppen, bereits ins y-oben-System gedreht. */
  build(): THREE.BufferGeometry {
    const out = new THREE.BufferGeometry();
    const pos: number[] = [];
    const nor: number[] = [];
    this.parts.forEach((list, m) => {
      if (!list) return;
      const start = pos.length / 3;
      for (const g of list) {
        pos.push(...(g.getAttribute('position').array as Float32Array));
        nor.push(...(g.getAttribute('normal').array as Float32Array));
        g.dispose();
      }
      out.addGroup(start, pos.length / 3 - start, m);
    });
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.rotateX(-Math.PI / 2);
    out.computeBoundingSphere();
    return out;
  }
}

function meshNode(name: string, geo: Geo, materials: THREE.Material[], data: Record<string, unknown>): THREE.Mesh {
  const mesh = new THREE.Mesh(geo.build(), materials);
  mesh.name = name;
  mesh.userData = data;
  return mesh;
}

// ------------------------------------------------------------------ Raum

function floorAndCeiling(scene: Scene, root: THREE.Group): void {
  const shape = new THREE.Shape(scene.room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  const surfaces = [
    { kind: 'floor', z: 0, surf: scene.floor, rough: 0.55 },
    { kind: 'ceiling', z: scene.room.height, surf: scene.ceiling, rough: 0.9 },
  ] as const;
  for (const s of surfaces) {
    const g = new THREE.ShapeGeometry(shape);
    g.translate(0, 0, s.z);
    g.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(g, mat(`${s.kind}_main`, s.surf.color, { roughness: s.rough }));
    mesh.name = s.kind;
    mesh.userData = { dm_id: s.kind, dm_type: s.kind, dm_material: s.surf.material };
    root.add(mesh);
  }
}

function intervalSubtract(start: number, end: number, cuts: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[start, end]];
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) { next.push([p0, p1]); continue; }
      if (c0 > p0) next.push([p0, c0]);
      if (c1 < p1) next.push([c1, p1]);
    }
    parts = next;
  }
  return parts.filter(([a, b]) => b - a > 0.01);
}

/** Gruppe im lokalen Wandsystem: x entlang der Wand, y > 0 in den Raum, z nach oben. */
function wallFrame(a: number[], angle: number): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(planToThree(a[0], a[1], 0));
  g.rotation.y = angle;
  return g;
}

function walls(scene: Scene, root: THREE.Group, sh: Shared): void {
  const poly = scene.room.polygon;
  const height = scene.room.height;
  const n = poly.length;
  scene.walls.forEach((wall, i) => {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (!a || !b) return;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.05) return;
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const t = wall.thickness ?? 0.12;
    const frame = wallFrame(a, angle);
    root.add(frame);

    // Die Wand liegt außerhalb der Raumkontur (y in [-t, 0]) und ist an beiden Enden um t
    // verlängert, damit die Ecken geschlossen sind.
    const openings = [...wall.openings].sort((p, q) => p.offset - q.offset);
    const geo = new Geo();
    let cursor = -t;
    for (const op of openings) {
      const o0 = op.offset - op.width / 2;
      const o1 = op.offset + op.width / 2;
      const sill = op.sill ?? 0;
      const top = sill + op.height;
      geo.box(cursor, o0, -t, 0, 0, height);
      geo.box(o0, o1, -t, 0, 0, sill);
      geo.box(o0, o1, -t, 0, top, height);
      cursor = Math.max(cursor, o1);
    }
    geo.box(cursor, length + t, -t, 0, 0, height);
    const nx = Math.sin(angle);
    const ny = -Math.cos(angle); // Außennormale im Grundriss
    frame.add(meshNode(`Wall_${i}`, geo, [mat(`${wall.id}_main`, wall.color, { roughness: 0.9 })],
      { dm_id: wall.id, dm_type: 'wall', dm_index: i, dm_nx: nx, dm_ny: ny, dm_length: length }));

    for (const op of openings) {
      const o0 = op.offset - op.width / 2;
      const o1 = op.offset + op.width / 2;
      const sill = op.sill ?? 0;
      const top = sill + op.height;
      const f = 0.05;
      const g = new Geo();
      g.box(o0, o0 + f, -t, 0, sill, top);
      g.box(o1 - f, o1, -t, 0, sill, top);
      g.box(o0, o1, -t, 0, top - f, top);
      if (op.type === 'window') {
        g.box(o0, o1, -t, 0, sill, sill + f);
        g.box((o0 + o1) / 2 - f / 2, (o0 + o1) / 2 + f / 2, -t * 0.6, -t * 0.4, sill, top);
        g.box(o0 + f, o1 - f, -t * 0.52, -t * 0.48, sill + f, top - f, 1);
      }
      frame.add(meshNode(`${op.type}_${op.id}`, g, [sh.frame, sh.glass],
        { dm_id: op.id, dm_type: op.type, dm_wall: wall.id }));
    }

    for (const p of wall.panels) frame.add(panel(p, wall, length, height, sh));
  });
}

function panel(p: Panel, wall: Wall, length: number, roomHeight: number, sh: Shared): THREE.Mesh {
  const start = Math.max(0, p.offset ?? 0);
  const width = p.width || length - start;
  const end = Math.min(length, start + width);
  const bottom = p.bottom ?? 0;
  const top = Math.min(roomHeight, bottom + (p.height ?? 2.4));
  // Öffnungen aussparen, sofern sie das Paneel in der Höhe berühren
  const cuts: [number, number][] = [];
  for (const op of wall.openings) {
    const ob = op.sill ?? 0;
    const ot = ob + op.height;
    if (ot > bottom && ob < top) cuts.push([op.offset - op.width / 2 - 0.02, op.offset + op.width / 2 + 0.02]);
  }
  const g = new Geo();
  for (const [s0, s1] of intervalSubtract(start, end, cuts)) {
    if (p.type === 'slats') {
      g.box(s0, s1, 0, 0.012, bottom, top, 1); // dunkler Filz dahinter
      const slat = 0.03;
      const gap = 0.015;
      for (let x = s0 + gap / 2; x + slat <= s1; x += slat + gap) g.box(x, x + slat, 0.012, 0.032, bottom, top);
    } else if (p.type === 'wainscot') {
      g.box(s0, s1, 0, 0.015, bottom, top);
      g.box(s0, s1, 0, 0.035, top - 0.04, top); // Abschlussleiste
      const n = Math.max(1, Math.round((s1 - s0) / 0.6));
      const field = (s1 - s0) / n;
      for (let k = 0; k < n; k++) {
        g.box(s0 + k * field + 0.07, s0 + (k + 1) * field - 0.07, 0.015, 0.025, bottom + 0.1, top - 0.14);
      }
    } else {
      g.box(s0, s1, 0, 0.018, bottom, top);
    }
  }
  return meshNode(`Panel_${p.id}`, g, [mat(`${p.id}_main`, p.color, { roughness: 0.6 }), sh.felt],
    { dm_id: p.id, dm_type: 'panel', dm_wall: wall.id });
}

// ------------------------------------------------------------------ Möbel
// Lokales System: Grundfläche zentriert um (0, 0), Unterkante bei z = 0, Vorderseite nach -y.
// Materialindex 0 = Hauptfarbe, 1 = dunkles Holz/Metall, 2 = helles Textil, 3 = Grün, 4 = Keramik.

const ACCENT = 1;
const LIGHT = 2;
const CERAMIC = 4;

function legs(g: Geo, w: number, d: number, z1: number, inset = 0.05, size = 0.04, m = ACCENT): void {
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * (w / 2 - inset);
      const cy = sy * (d / 2 - inset);
      g.box(cx - size / 2, cx + size / 2, cy - size / 2, cy + size / 2, 0, z1, m);
    }
  }
}

type Builder = (g: Geo, w: number, d: number, h: number) => void;

const sofa: Builder = (g, w, d, h) => {
  const arm = Math.min(0.2, w * 0.12);
  const leg = 0.1;
  const seat = Math.max(0.38, h * 0.5);
  legs(g, w, d, leg, 0.08);
  g.box(-w / 2 + arm, w / 2 - arm, -d / 2, d / 2 - 0.22, leg, seat - 0.12);
  g.box(-w / 2 + arm + 0.01, w / 2 - arm - 0.01, -d / 2 + 0.02, d / 2 - 0.23, seat - 0.12, seat);
  g.box(-w / 2, w / 2, d / 2 - 0.22, d / 2, leg, h);
  for (const s of [-1, 1]) {
    const [x0, x1] = [s * w / 2, s * (w / 2 - arm)].sort((p, q) => p - q);
    g.box(x0, x1, -d / 2, d / 2 - 0.22, leg, seat + 0.14);
  }
};

const chair: Builder = (g, w, d, h) => {
  const seat = Math.min(0.47, h * 0.55);
  legs(g, w, d, seat - 0.04, 0.03, 0.035);
  g.box(-w / 2, w / 2, -d / 2, d / 2, seat - 0.04, seat);
  g.box(-w / 2, w / 2, d / 2 - 0.04, d / 2, seat, h);
};

const table: Builder = (g, w, d, h) => {
  legs(g, w, d, h - 0.04, 0.06, 0.05, 0);
  g.box(-w / 2, w / 2, -d / 2, d / 2, h - 0.04, h);
};

const coffeeTable: Builder = (g, w, d, h) => {
  legs(g, w, d, h - 0.04, 0.05, 0.035);
  g.box(-w / 2, w / 2, -d / 2, d / 2, h - 0.04, h);
  g.box(-w / 2 + 0.05, w / 2 - 0.05, -d / 2 + 0.05, d / 2 - 0.05, 0.08, 0.1);
};

const bed: Builder = (g, w, d, h) => {
  const frame = 0.32;
  g.box(-w / 2, w / 2, -d / 2, d / 2, 0.05, frame);
  legs(g, w, d, 0.05, 0.06, 0.06);
  g.box(-w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.03, d / 2 - 0.1, frame, frame + 0.22, LIGHT);
  g.box(-w / 2, w / 2, d / 2 - 0.08, d / 2, 0.05, h);
  const pw = (w - 0.2) / 2;
  for (const s of [-1, 1]) {
    const cx = s * (pw / 2 + 0.03);
    g.box(cx - pw / 2, cx + pw / 2, d / 2 - 0.5, d / 2 - 0.12, frame + 0.22, frame + 0.34, LIGHT);
  }
};

function cabinet(g: Geo, w: number, d: number, h: number, doors: number, plinth = 0, legHeight = 0): void {
  const z0 = Math.max(plinth, legHeight);
  if (legHeight) legs(g, w, d, legHeight, 0.06, 0.03);
  else if (plinth) g.box(-w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.05, d / 2, 0, plinth, ACCENT);
  g.box(-w / 2, w / 2, -d / 2 + 0.02, d / 2, z0, h);
  const gap = 0.004;
  const dw = w / doors;
  for (let k = 0; k < doors; k++) {
    const x0 = -w / 2 + k * dw + gap;
    const x1 = -w / 2 + (k + 1) * dw - gap;
    g.box(x0, x1, -d / 2, -d / 2 + 0.02, z0 + gap, h - gap);
    const hx = k % 2 === 0 ? x1 - 0.06 : x0 + 0.06;
    const hz = z0 + (h - z0) * (h > 1.2 ? 0.5 : 0.75);
    g.box(hx - 0.008, hx + 0.008, -d / 2 - 0.025, -d / 2, hz - 0.1, hz + 0.1, ACCENT);
  }
}

const shelf: Builder = (g, w, d, h) => {
  const t = 0.02;
  g.box(-w / 2, -w / 2 + t, -d / 2, d / 2, 0, h);
  g.box(w / 2 - t, w / 2, -d / 2, d / 2, 0, h);
  g.box(-w / 2, w / 2, d / 2 - 0.01, d / 2, 0, h);
  const n = Math.max(2, Math.round(h / 0.36));
  for (let k = 0; k <= n; k++) {
    const z = Math.min(h - t, (k * (h - t)) / n);
    g.box(-w / 2 + t, w / 2 - t, -d / 2, d / 2, z, z + t);
  }
};

const tv: Builder = (g, w, d, h) => {
  g.box(-w / 2, w / 2, -d / 2, d / 2, 0, h);
  g.box(-w / 2 + 0.01, w / 2 - 0.01, -d / 2 - 0.002, -d / 2, 0.01, h - 0.01, ACCENT);
};

const lamp: Builder = (g, w, d, h) => {
  const r = Math.min(w, d) / 2;
  g.cylinder(0, 0, 0, 0.03, r * 0.6, r * 0.6, ACCENT);
  g.cylinder(0, 0, 0.03, h - 0.3, 0.012, 0.012, ACCENT);
  g.cylinder(0, 0, h - 0.32, h, r, r * 0.7);
};

const plant: Builder = (g, w, d, h) => {
  const r = Math.min(w, d) / 2;
  const pot = Math.min(0.4, h * 0.3);
  g.cylinder(0, 0, 0, pot, r * 0.55, r * 0.7, CERAMIC);
  g.sphere(0, 0, pot + (h - pot) * 0.5, r, r, (h - pot) / 2);
};

const rug: Builder = (g, w, d, h) => g.box(-w / 2, w / 2, -d / 2, d / 2, 0, Math.max(h, 0.01));
const box: Builder = (g, w, d, h) => g.box(-w / 2, w / 2, -d / 2, d / 2, 0, h);

const FURNITURE: Record<string, Builder> = {
  sofa,
  armchair: sofa,
  chair,
  dining_table: table,
  desk: table,
  side_table: table,
  coffee_table: coffeeTable,
  bed,
  wardrobe: (g, w, d, h) => cabinet(g, w, d, h, Math.max(2, Math.round(w / 0.5)), 0.06),
  sideboard: (g, w, d, h) => cabinet(g, w, d, h, Math.max(2, Math.round(w / 0.45)), 0, 0.12),
  shelf,
  tv,
  lamp,
  plant,
  rug,
  box,
};

/** Ein Möbelstück als eigener Knoten (Position und Drehung am Knoten, damit der Editor es bewegen kann). */
export function buildObject(o: SceneObject, sh: Shared = sharedMaterials()): THREE.Mesh {
  const [w, d, h] = o.size;
  const g = new Geo();
  (FURNITURE[o.category] ?? box)(g, w, d, h);
  const mesh = meshNode(`${o.category}_${o.id}`, g,
    [mat(`${o.id}_main`, o.color, { roughness: 0.75 }), sh.accent, sh.light, sh.green, sh.ceramic],
    { dm_id: o.id, dm_type: 'object', dm_category: o.category, dm_label: o.label });
  mesh.position.copy(planToThree(o.position[0], o.position[1], o.position[2]));
  mesh.rotation.y = THREE.MathUtils.degToRad(o.rotation);
  return mesh;
}

// ------------------------------------------------------------------ Einstieg

export function buildScene(scene: Scene): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Room';
  const sh = sharedMaterials();
  floorAndCeiling(scene, root);
  walls(scene, root, sh);
  for (const o of scene.objects) root.add(buildObject(o, sh));
  return root;
}
