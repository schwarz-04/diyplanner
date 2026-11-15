import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Scene } from './types';

/**
 * Maße im 3D-Bild: Wandlängen und Raumhöhe, Maße und Wandabstände des ausgewählten Möbels
 * und frei gemessene Strecken (zwei Punkte anklicken).
 * Linien liegen in der three.js-Szene, Beschriftungen sind HTML (CSS2DRenderer), damit sie scharf bleiben.
 */

const ACCENT = '#c2537a';
const DARK = '#2b2724';

const plan3 = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);
const fmt = (meters: number) => `${Math.round(meters * 100)} cm`;

export class Measure {
  readonly labels: CSS2DRenderer;
  private roomGroup = new THREE.Group();
  private selGroup = new THREE.Group();
  private manualGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private data: Scene | null = null;
  private selNode: THREE.Object3D | null = null;
  private pending: THREE.Vector3 | null = null;
  showRoom = true;
  showSelection = true;
  /** Maß einer Wand wurde angeklickt und geändert (Meter). */
  onEditWall: ((index: number, meters: number) => void) | null = null;
  onEditHeight: ((meters: number) => void) | null = null;
  /** Abstand zur Wand eingegeben: Möbel um delta (Meter) in Richtung (dx, dy) des Grundrisses verschieben. */
  onEditGap: ((dx: number, dy: number, delta: number) => void) | null = null;
  /** Höhe über dem Boden eingegeben (Meter). */
  onEditElevation: ((meters: number) => void) | null = null;
  /** Werkbank: Maß eines Teils angeklickt und geändert (Achse 0 Breite, 1 Tiefe, 2 Höhe; Meter). */
  onEditSize: ((axis: 0 | 1 | 2, meters: number) => void) | null = null;
  /** Winkel-Anzeige beim Drehen */
  private angleLabel: CSS2DObject | null = null;

  constructor(container: HTMLElement, scene: THREE.Scene) {
    this.labels = new CSS2DRenderer();
    const el = this.labels.domElement;
    el.className = 'dm-labels';
    container.appendChild(el);
    for (const g of [this.roomGroup, this.selGroup, this.manualGroup, this.previewGroup]) {
      g.renderOrder = 10;
      scene.add(g);
    }
  }

  /** Raum- und Möbelmaße hängen am bearbeiteten Raum (dessen Koordinaten), freie Messungen am Weltsystem. */
  attachTo(group: THREE.Object3D): void {
    group.add(this.roomGroup, this.selGroup);
  }

  detach(): void {
    clear(this.roomGroup);
    clear(this.selGroup);
    this.roomGroup.removeFromParent();
    this.selGroup.removeFromParent();
  }

  setSize(w: number, h: number): void {
    this.labels.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.labels.render(scene, camera);
  }

  // ------------------------------------------------------------------ Raummaße

  setRoom(data: Scene): void {
    this.data = data;
    clear(this.roomGroup);
    this.roomGroup.visible = this.showRoom;
    if (data.diy) return; // Werkbank hat keine Wände
    const poly = data.room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const n = inwardNormal(poly, i);
      const off = 0.14;
      const p1 = plan3(a[0] + n[0] * off, a[1] + n[1] * off, 0.02);
      const p2 = plan3(b[0] + n[0] * off, b[1] + n[1] * off, 0.02);
      dimLine(this.roomGroup, p1, p2, plan3(n[0], n[1]).multiplyScalar(0.08), ACCENT);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l = label(p1.clone().lerp(p2, 0.5), fmt(len), 'room');
      editable(l.element, len, 30, 3000, (v) => this.onEditWall?.(i, v));
      this.roomGroup.add(l);
    }
    // Raumhöhe in der ersten Ecke
    const c = poly[0];
    const n0 = inwardNormal(poly, 0);
    const nl = inwardNormal(poly, poly.length - 1);
    const corner = [c[0] + (n0[0] + nl[0]) * 0.14, c[1] + (n0[1] + nl[1]) * 0.14];
    const h1 = plan3(corner[0], corner[1], 0);
    const h2 = plan3(corner[0], corner[1], data.room.height);
    dimLine(this.roomGroup, h1, h2, plan3(n0[0], n0[1]).multiplyScalar(0.08), ACCENT);
    const hl = label(h1.clone().lerp(h2, 0.5), `Höhe ${fmt(data.room.height)}`, 'room');
    editable(hl.element, data.room.height, 180, 600, (v) => this.onEditHeight?.(v));
    this.roomGroup.add(hl);
  }

  setRoomVisible(v: boolean): void {
    this.showRoom = v;
    this.roomGroup.visible = v;
  }

  // ------------------------------------------------------------------ Ausgewähltes Möbel

  setSelection(node: THREE.Object3D | null, size?: [number, number, number]): void {
    this.selNode = node;
    this.selSize = size ?? null;
    this.updateSelection();
  }

  private selSize: [number, number, number] | null = null;

  /** Neu berechnen (auch während das Möbel gezogen wird). */
  updateSelection(): void {
    clear(this.selGroup);
    const node = this.selNode;
    if (!node || !this.data || !this.showSelection) return;
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    // In Raumkoordinaten umrechnen (der Raum kann in der Wohnung verschoben und gedreht sein)
    const parent = this.selGroup.parent;
    if (parent) box.applyMatrix4(parent.matrixWorld.clone().invert());
    // three -> Grundriss: x = x, y = -z
    const minX = box.min.x, maxX = box.max.x, minY = -box.max.z, maxY = -box.min.z;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const top = box.max.y;
    if (this.data.diy && this.selSize) {
      this.partDims(node, this.selSize);
      return;
    }
    if (this.selSize) {
      const [w, d, h] = this.selSize;
      this.selGroup.add(label(plan3(cx, cy, top + 0.18), `${c1(w)} × ${c1(d)} × ${c1(h)} cm`, 'object'));
    }
    // Abstände zu den Wänden in den vier Richtungen des Grundrisses
    const poly = this.data.room.polygon;
    const z = Math.min(0.03, top);
    const rays: [number, number, number, number][] = this.data.diy ? [] : [
      [maxX, cy, 1, 0], [minX, cy, -1, 0], [cx, maxY, 0, 1], [cx, minY, 0, -1],
    ];
    for (const [ox, oy, dx, dy] of rays) {
      const t = castToWalls(poly, ox, oy, dx, dy);
      if (t === null || t < 0.02 || t > 15) continue;
      const p1 = plan3(ox, oy, z + 0.01);
      const p2 = plan3(ox + dx * t, oy + dy * t, z + 0.01);
      dimLine(this.selGroup, p1, p2, plan3(-dy, dx).multiplyScalar(0.05), DARK, true);
      const gl = label(p1.clone().lerp(p2, 0.5), fmt(t), 'gap');
      editable(gl.element, t, 0, 3000, (v) => this.onEditGap?.(dx, dy, t - v));
      this.selGroup.add(gl);
    }
    // Höhe über dem Boden (Wandregale, Bilder, Hängelampen …)
    const bottom = box.min.y;
    if (bottom > 0.03) {
      const p1 = plan3(maxX + 0.04, cy, 0);
      const p2 = plan3(maxX + 0.04, cy, bottom);
      dimLine(this.selGroup, p1, p2, plan3(0.05, 0), DARK, true);
      const el = label(p1.clone().lerp(p2, 0.5), `↑ ${fmt(bottom)}`, 'gap');
      editable(el.element, bottom, 0, 600, (v) => this.onEditElevation?.(v));
      this.selGroup.add(el);
    }
  }

  /** Werkbank: Maßpfeile an den Kanten des Teils (wie an den Wänden), Werte anklickbar. */
  private partDims(node: THREE.Object3D, size: [number, number, number]): void {
    const [w, d, h] = size;
    node.updateWorldMatrix(true, false);
    const parent = this.selGroup.parent;
    const toLocal = parent ? parent.matrixWorld.clone().invert() : new THREE.Matrix4();
    const m = toLocal.multiply(node.matrixWorld);
    // Teil-Koordinaten (three): x = Breite, y = Höhe, z = -Tiefe, Ursprung unten Mitte
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).transformDirection(m).multiplyScalar(Math.hypot(x, y, z));
    const off = 0.05;
    const tk = 0.025;
    const lines: { axis: 0 | 1 | 2; a: THREE.Vector3; b: THREE.Vector3; tick: THREE.Vector3; text: string }[] = [
      // Breite: vordere Unterkante
      { axis: 0, a: P(-w / 2, 0, d / 2 + off), b: P(w / 2, 0, d / 2 + off), tick: V(0, 0, tk), text: c1(w) },
      // Tiefe: rechte Unterkante
      { axis: 1, a: P(w / 2 + off, 0, d / 2), b: P(w / 2 + off, 0, -d / 2), tick: V(tk, 0, 0), text: c1(d) },
      // Höhe: vordere linke Kante
      { axis: 2, a: P(-w / 2 - off, 0, d / 2), b: P(-w / 2 - off, h, d / 2), tick: V(tk, 0, 0), text: c1(h) },
    ];
    for (const ln of lines) {
      dimLine(this.selGroup, ln.a, ln.b, ln.tick, ACCENT);
      // Hilfslinien von der Kante zum Maß
      const l = label(ln.a.clone().lerp(ln.b, 0.5), `${ln.text} cm`, 'part');
      editable(l.element, size[ln.axis], 0.1, 1000, (v) => this.onEditSize?.(ln.axis, v));
      this.selGroup.add(l);
    }
  }

  /** Winkel beim Drehen über dem Möbel zeigen (null = ausblenden). */
  showAngle(node: THREE.Object3D | null, deg: number | null): void {
    if (!node || deg === null) {
      if (this.angleLabel) {
        this.angleLabel.element.remove();
        this.angleLabel.removeFromParent();
        this.angleLabel = null;
      }
      return;
    }
    if (!this.angleLabel) {
      this.angleLabel = label(new THREE.Vector3(), '', 'angle');
      this.manualGroup.parent?.add(this.angleLabel);
    }
    const box = new THREE.Box3().setFromObject(node);
    const c = box.getCenter(new THREE.Vector3());
    this.angleLabel.position.set(c.x, box.max.y + 0.35, c.z);
    this.angleLabel.element.textContent = `${Math.round(((deg % 360) + 360) % 360)}°`;
  }

  // ------------------------------------------------------------------ Frei messen

  get measuring(): boolean {
    return this.pending !== null;
  }

  /** Klickpunkt im Messmodus. Liefert die Strecke, sobald zwei Punkte gesetzt sind. */
  addPoint(p: THREE.Vector3): number | null {
    if (!this.pending) {
      this.pending = p.clone();
      clear(this.previewGroup);
      this.previewGroup.add(dot(p));
      return null;
    }
    const a = this.pending;
    this.pending = null;
    clear(this.previewGroup);
    const g = new THREE.Group();
    g.add(dot(a), dot(p));
    dimLine(g, a, p, null, ACCENT);
    const dist = a.distanceTo(p);
    g.add(label(a.clone().lerp(p, 0.5), fmt(dist), 'manual'));
    this.manualGroup.add(g);
    return dist;
  }

  preview(p: THREE.Vector3 | null): void {
    if (!this.pending) return;
    clear(this.previewGroup);
    this.previewGroup.add(dot(this.pending));
    if (!p) return;
    dimLine(this.previewGroup, this.pending, p, null, ACCENT);
    this.previewGroup.add(label(this.pending.clone().lerp(p, 0.5), fmt(this.pending.distanceTo(p)), 'manual'));
  }

  cancelPending(): void {
    this.pending = null;
    clear(this.previewGroup);
  }

  clearManual(): void {
    this.cancelPending();
    clear(this.manualGroup);
  }

  get manualCount(): number {
    return this.manualGroup.children.length;
  }
}

// ------------------------------------------------------------------ Bausteine

function clear(g: THREE.Group): void {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}

function label(pos: THREE.Vector3, text: string, kind: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `dm-dim dm-dim-${kind}`;
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.position.copy(pos);
  return obj;
}

/** Maß anklickbar machen: wird zum Eingabefeld (cm), Enter übernimmt, Esc bricht ab. */
export function editable(el: HTMLElement, meters: number, minCm: number, maxCm: number, commit: (meters: number) => void): void {
  el.classList.add('dm-dim-edit');
  el.title = 'Anklicken, um das Maß zu ändern';
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', () => {
    if (el.querySelector('input')) return;
    const text = el.textContent ?? '';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(minCm);
    input.max = String(maxCm);
    const cmNow = Math.round(meters * 1000) / 10;
    input.step = minCm < 1 ? '0.1' : '1';
    input.value = String(cmNow);
    input.className = 'dm-dim-input';
    el.replaceChildren(input, document.createTextNode(' cm'));
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = Number(input.value);
      el.textContent = text;
      if (ok && Number.isFinite(v) && v >= minCm && v <= maxCm && Math.abs(cmNow - v) > 0.01) commit(v / 100);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}

/** Maßlinie mit Endstrichen. tick: Richtung der Endstriche (null = keine). */
function dimLine(g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, tick: THREE.Vector3 | null, color: string, dashed = false): void {
  const pts = [a, b];
  if (tick) pts.push(a.clone().add(tick), a.clone().sub(tick), b.clone().add(tick), b.clone().sub(tick));
  const geo = new THREE.BufferGeometry().setFromPoints(
    tick ? [a, b, pts[2], pts[3], pts[4], pts[5]] : [a, b]);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.04, depthTest: false, transparent: true })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new THREE.LineSegments(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 10;
  g.add(line);
}

function dot(p: THREE.Vector3): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 12, 8),
    new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }));
  m.position.copy(p);
  m.renderOrder = 11;
  return m;
}

/** Normale der Wand i, die in den Raum zeigt. */
export function inwardNormal(poly: [number, number][], i: number): [number, number] {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let nx = -(b[1] - a[1]) / len;
  let ny = (b[0] - a[0]) / len;
  const mx = (a[0] + b[0]) / 2 + nx * 0.05;
  const my = (a[1] + b[1]) / 2 + ny * 0.05;
  if (!pointInPolygon(poly, mx, my)) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

export function pointInPolygon(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Entfernung vom Punkt in Richtung (dx, dy) bis zur nächsten Wand, oder null. */
function castToWalls(poly: [number, number][], ox: number, oy: number, dx: number, dy: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
    const u = ((ax - ox) * dy - (ay - oy) * dx) / den;
    if (t > -1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && (best === null || t < best)) best = t;
  }
  return best;
}

/** cm mit einer Nachkommastelle, wenn nötig (Plattenstärken) */
function c1(m: number): string {
  const v = Math.round(m * 1000) / 10;
  return (v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)).replace('.', ',');
}
