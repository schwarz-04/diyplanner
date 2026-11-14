import { snapRoom, toWorld, type Pt } from './home';
import type { Home, PlacedRoom, SceneObject } from './types';

/**
 * Grundriss (2D) neben dem 3D-Bild: alle Räume der Wohnung von oben.
 * Möbel antippen = auswählen, ziehen = verschieben. Maße des bearbeiteten Raums anklicken = ändern.
 * Im Modus „Räume verschieben“ lassen sich ganze Räume ziehen (rasten an Nachbarräumen ein).
 */

export interface PlanEvents {
  onSelectObject: (id: string | null) => void;
  onObjectMoving: (id: string, x: number, y: number) => void;
  onObjectMoved: (id: string, x: number, y: number) => void;
  onRoomPick: (index: number) => void;
  onRoomMoved: (index: number, position: Pt) => void;
  onEditWall: (index: number, meters: number) => void;
}

const NS = 'http://www.w3.org/2000/svg';
const ACCENT = '#c2537a';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class PlanView {
  readonly svg: SVGSVGElement;
  moveRooms = false;
  private home: Home | null = null;
  private active = 0;
  private selected: string | null = null;
  private objectNodes = new Map<string, SVGGElement>();
  private drag:
    | { kind: 'object'; id: string; pointerId: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; x: number; y: number }
    | { kind: 'room'; index: number; pointerId: number; sx: number; sy: number; moved: boolean; node: SVGGElement; pos: Pt }
    | null = null;

  constructor(private container: HTMLElement, private events: PlanEvents) {
    this.svg = el('svg', { class: 'dm-plan-svg', preserveAspectRatio: 'xMidYMid meet' });
    container.append(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.move(e));
    const up = (e: PointerEvent) => this.up(e);
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  setData(home: Home | null, active: number, selected: string | null): void {
    this.home = home;
    this.active = active;
    this.selected = selected;
    if (!this.drag) this.render();
  }

  /** Möbel wurde im 3D-Bild bewegt (noch nicht gespeichert). */
  updateObject(id: string, x: number, y: number, rotation: number): void {
    const node = this.objectNodes.get(id);
    const room = this.home?.rooms[this.active];
    if (!node || !room || this.drag) return;
    const w = toWorld(room, [x, y]);
    node.setAttribute('transform', `translate(${w[0]} ${-w[1]}) rotate(${-(room.rotation + rotation)})`);
  }

  // ------------------------------------------------------------------ Zeichnen

  private render(): void {
    const svg = this.svg;
    svg.replaceChildren();
    this.objectNodes.clear();
    const home = this.home;
    if (!home) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of home.rooms) {
      for (const p of r.scene.room.polygon) {
        const w = toWorld(r, p);
        x0 = Math.min(x0, w[0]); x1 = Math.max(x1, w[0]);
        y0 = Math.min(y0, w[1]); y1 = Math.max(y1, w[1]);
      }
    }
    const pad = 1.0;
    svg.setAttribute('viewBox', `${x0 - pad} ${-y1 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);
    const unit = Math.max(x1 - x0, y1 - y0) + pad * 2; // für Schriftgrößen
    const font = Math.max(0.15, unit * 0.03);
    // bearbeiteten Raum zuletzt (liegt oben)
    const order = home.rooms.map((_, i) => i).sort((a, b) => Number(a === this.active) - Number(b === this.active));
    for (const i of order) svg.append(this.room(home.rooms[i], i, font));
    svg.classList.toggle('move-rooms', this.moveRooms);
  }

  private room(r: PlacedRoom, index: number, font: number): SVGGElement {
    const s = r.scene;
    const isActive = index === this.active;
    const g = el('g', { 'data-room': index, class: `dm-plan-room${isActive ? ' active' : ''}` });
    const pts = s.room.polygon.map((p) => toWorld(r, p));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${-p[1]}`).join(' ') + ' Z';
    const t = s.walls[0]?.thickness ?? 0.12;
    g.append(el('path', { d, class: 'dm-plan-floor', fill: isActive ? s.floor.color : '#efebe5', 'fill-opacity': isActive ? 0.55 : 1 }));
    g.append(el('path', { d, class: 'dm-plan-walls', fill: 'none', stroke: isActive ? '#4a433d' : '#a69d94', 'stroke-width': t, 'stroke-linejoin': 'miter' }));

    // Öffnungen
    s.walls.forEach((wall, i) => {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      for (const op of wall.openings) {
        const p0: Pt = [a[0] + u[0] * (op.offset - op.width / 2), a[1] + u[1] * (op.offset - op.width / 2)];
        const p1: Pt = [a[0] + u[0] * (op.offset + op.width / 2), a[1] + u[1] * (op.offset + op.width / 2)];
        g.append(el('line', { x1: p0[0], y1: -p0[1], x2: p1[0], y2: -p1[1], stroke: op.type === 'door' ? '#fff' : '#bcd9ea', 'stroke-width': t * 1.15, 'pointer-events': 'none' }));
        if (op.type === 'window') g.append(el('line', { x1: p0[0], y1: -p0[1], x2: p1[0], y2: -p1[1], stroke: '#5b8fb0', 'stroke-width': t * 0.25, 'pointer-events': 'none' }));
      }
    });

    // Möbel: Teppiche zuerst, hohe Teile zuletzt
    const objs = [...s.objects].sort((p, q) => (p.position[2] + p.size[2]) - (q.position[2] + q.size[2]));
    for (const o of objs) g.append(this.object(r, o, isActive));

    if (isActive) {
      // Maße außen an den Wänden
      const cx = pts.reduce((v, p) => v + p[0], 0) / pts.length;
      const cy = pts.reduce((v, p) => v + p[1], 0) / pts.length;
      pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.2) return;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        let nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
        if ((mx + nx - cx) ** 2 + (my + ny - cy) ** 2 < (mx - cx) ** 2 + (my - cy) ** 2) { nx = -nx; ny = -ny; }
        const text = el('text', {
          x: mx + nx * font * 1.5, y: -(my + ny * font * 1.5), 'font-size': font, class: 'dm-plan-dim',
          'text-anchor': 'middle', 'dominant-baseline': 'central', 'data-wall': i,
        });
        text.textContent = `${Math.round(len * 100)}`;
        const tip = el('title');
        tip.textContent = 'Anklicken, um die Wandlänge zu ändern (cm)';
        text.append(tip);
        g.append(text);
      });
    } else {
      const cx = pts.reduce((v, p) => v + p[0], 0) / pts.length;
      const cy = pts.reduce((v, p) => v + p[1], 0) / pts.length;
      const name = el('text', { x: cx, y: -cy, 'font-size': font, class: 'dm-plan-name', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'pointer-events': 'none' });
      name.textContent = s.room.name || `Raum ${index + 1}`;
      g.append(name);
    }
    return g;
  }

  private object(r: PlacedRoom, o: SceneObject, isActive: boolean): SVGGElement {
    const w = toWorld(r, [o.position[0], o.position[1]]);
    const g = el('g', { transform: `translate(${w[0]} ${-w[1]}) rotate(${-(r.rotation + o.rotation)})`, class: `dm-plan-obj${isActive && o.id === this.selected ? ' selected' : ''}` });
    if (isActive) g.setAttribute('data-obj', o.id);
    else g.setAttribute('pointer-events', 'none');
    const [ow, od] = o.size;
    const round = ['plant', 'vase', 'pouf', 'lamp', 'table_lamp', 'pendant', 'basket'].includes(o.category);
    const shape = round
      ? el('ellipse', { rx: ow / 2, ry: od / 2 })
      : el('rect', { x: -ow / 2, y: -od / 2, width: ow, height: od, rx: Math.min(0.04, ow / 4, od / 4) });
    shape.setAttribute('fill', o.color);
    shape.setAttribute('fill-opacity', isActive ? '0.9' : '0.45');
    g.append(shape);
    const tip = el('title');
    tip.textContent = `${o.label} (${Math.round(ow * 100)} × ${Math.round(od * 100)} cm)`;
    g.append(tip);
    if (isActive) this.objectNodes.set(o.id, g);
    return g;
  }

  // ------------------------------------------------------------------ Bedienen

  /** Bildschirmpunkt -> Grundriss-Koordinaten (Meter, y nach oben). */
  private point(e: PointerEvent): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, -p.y];
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || !this.home) return;
    const target = e.target as Element;
    const wall = target.closest('[data-wall]');
    if (wall) {
      this.editWall(Number(wall.getAttribute('data-wall')), e);
      return;
    }
    const [x, y] = this.point(e);
    const roomNode = target.closest('[data-room]') as SVGGElement | null;
    const roomIndex = roomNode ? Number(roomNode.getAttribute('data-room')) : -1;
    if (this.moveRooms && roomNode) {
      this.drag = { kind: 'room', index: roomIndex, pointerId: e.pointerId, sx: x, sy: y, moved: false, node: roomNode, pos: this.home.rooms[roomIndex].position };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    const obj = target.closest('[data-obj]');
    if (obj) {
      const id = obj.getAttribute('data-obj')!;
      const o = this.home.rooms[this.active].scene.objects.find((v) => v.id === id);
      if (!o) return;
      if (id !== this.selected) this.events.onSelectObject(id);
      this.drag = { kind: 'object', id, pointerId: e.pointerId, sx: x, sy: y, ox: o.position[0], oy: o.position[1], moved: false, x: o.position[0], y: o.position[1] };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (roomIndex >= 0 && roomIndex !== this.active) this.events.onRoomPick(roomIndex);
    else if (this.selected) this.events.onSelectObject(null);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId || !this.home) return;
    const [x, y] = this.point(e);
    const dx = x - d.sx, dy = y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 0.03) return;
    d.moved = true;
    if (d.kind === 'room') {
      const room = this.home.rooms[d.index];
      d.pos = snapRoom(this.home, d.index, [room.position[0] + dx, room.position[1] + dy]);
      d.node.setAttribute('transform', `translate(${d.pos[0] - room.position[0]} ${-(d.pos[1] - room.position[1])})`);
      return;
    }
    // Weltverschiebung in Raumkoordinaten umrechnen
    const room = this.home.rooms[this.active];
    const a = (-room.rotation * Math.PI) / 180;
    d.x = d.ox + dx * Math.cos(a) - dy * Math.sin(a);
    d.y = d.oy + dx * Math.sin(a) + dy * Math.cos(a);
    const node = this.objectNodes.get(d.id);
    const o = room.scene.objects.find((v) => v.id === d.id);
    if (node && o) {
      const w = toWorld(room, [d.x, d.y]);
      node.setAttribute('transform', `translate(${w[0]} ${-w[1]}) rotate(${-(room.rotation + o.rotation)})`);
    }
    this.events.onObjectMoving(d.id, d.x, d.y);
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    if (d.kind === 'room') {
      if (d.moved) this.events.onRoomMoved(d.index, d.pos);
      else if (d.index !== this.active) this.events.onRoomPick(d.index);
      else this.render();
      return;
    }
    if (d.moved) this.events.onObjectMoved(d.id, d.x, d.y);
  }

  private editWall(index: number, e: PointerEvent): void {
    const room = this.home?.rooms[this.active];
    if (!room) return;
    e.preventDefault();
    const p = room.scene.room.polygon;
    const a = p[index], b = p[(index + 1) % p.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const box = this.container.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '30';
    input.max = '3000';
    input.value = String(Math.round(len * 100));
    input.className = 'dm-plan-input';
    input.style.left = `${Math.max(4, Math.min(box.width - 84, e.clientX - box.left - 40))}px`;
    input.style.top = `${Math.max(4, e.clientY - box.top - 14)}px`;
    this.container.append(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = Number(input.value);
      input.remove();
      if (ok && Number.isFinite(v) && v >= 30 && v <= 3000 && v !== Math.round(len * 100)) this.events.onEditWall(index, v / 100);
    };
    input.addEventListener('keydown', (k) => {
      k.stopPropagation();
      if (k.key === 'Enter') finish(true);
      else if (k.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}
