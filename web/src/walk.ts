import * as THREE from 'three';
import { inwardNormal, pointInPolygon } from './measure';
import type { Scene } from './types';

/**
 * Ich-Perspektive: auf Augenhöhe durch den Raum gehen.
 * Desktop: W/A/S/D oder Pfeiltasten, Maus ziehen zum Umsehen, Umschalt = schneller.
 * Handy: Joystick links unten zum Gehen, mit dem Finger auf dem Bild ziehen zum Umsehen.
 * Wände und Möbel halten auf (einfache Kollision im Grundriss).
 */

const EYE = 1.6;
const RADIUS = 0.25;
const SPEED = 1.4;

export interface Blocker { minX: number; maxX: number; minY: number; maxY: number }

export class WalkControls {
  enabled = false;
  private x = 0;
  private y = 0;
  private yaw = 0; // 0 = Blick in +y (Grundriss)
  private pitch = 0;
  private keys = new Set<string>();
  private joy = { x: 0, y: 0 };
  private look: { id: number; x: number; y: number } | null = null;
  private scene: Scene | null = null;
  private blockers: Blocker[] = [];
  readonly joystick: HTMLElement;
  private knob: HTMLElement;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement, joystickParent: HTMLElement) {
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.look) return;
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.enabled || !this.look || e.pointerId !== this.look.id) return;
      const k = e.pointerType === 'touch' ? 0.006 : 0.004;
      this.yaw -= (e.clientX - this.look.x) * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - this.look.y) * k, -1.2, 1.2);
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    });
    const endLook = (e: PointerEvent) => { if (this.look?.id === e.pointerId) this.look = null; };
    window.addEventListener('pointerup', endLook);
    window.addEventListener('pointercancel', endLook);
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || (e.target as HTMLElement).closest?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    // Joystick für Touch-Geräte
    this.knob = document.createElement('div');
    this.knob.className = 'dm-joy-knob';
    this.joystick = document.createElement('div');
    this.joystick.className = 'dm-joy';
    this.joystick.hidden = true;
    this.joystick.append(this.knob);
    joystickParent.append(this.joystick);
    let joyId: number | null = null;
    const moveJoy = (e: PointerEvent) => {
      const r = this.joystick.getBoundingClientRect();
      const max = r.width / 2;
      let dx = e.clientX - (r.left + max);
      let dy = e.clientY - (r.top + max);
      const len = Math.hypot(dx, dy);
      if (len > max) { dx *= max / len; dy *= max / len; }
      this.joy = { x: dx / max, y: -dy / max };
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    this.joystick.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      joyId = e.pointerId;
      this.joystick.setPointerCapture(e.pointerId);
      moveJoy(e);
    });
    this.joystick.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) moveJoy(e); });
    const endJoy = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      joyId = null;
      this.joy = { x: 0, y: 0 };
      this.knob.style.transform = '';
    };
    this.joystick.addEventListener('pointerup', endJoy);
    this.joystick.addEventListener('pointercancel', endJoy);
  }

  /** Startet im Raum: an der Tür (falls vorhanden), sonst in der Mitte, Blick zur Raummitte. */
  enable(scene: Scene, blockers: Blocker[]): void {
    this.setScene(scene, blockers);
    const poly = scene.room.polygon;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let start: [number, number] = [cx, cy];
    scene.walls.some((w, i) => {
      const door = w.openings.find((o) => o.type === 'door');
      if (!door) return false;
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n = inwardNormal(poly, i);
      start = [a[0] + ((b[0] - a[0]) / len) * door.offset + n[0] * 0.6, a[1] + ((b[1] - a[1]) / len) * door.offset + n[1] * 0.6];
      return true;
    });
    if (!this.free(start[0], start[1])) start = this.findFree(start, [cx, cy]);
    [this.x, this.y] = start;
    this.yaw = Math.atan2(-(cx - this.x), cy - this.y);
    if (Math.hypot(cx - this.x, cy - this.y) < 0.3) this.yaw = 0;
    this.pitch = -0.08;
    this.enabled = true;
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.joystick.hidden = !matchMedia('(pointer: coarse)').matches;
    this.apply();
  }

  disable(): void {
    this.enabled = false;
    this.keys.clear();
    this.look = null;
    this.joystick.hidden = true;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  /** Neue Szene oder verschobene Möbel übernehmen. */
  setScene(scene: Scene, blockers: Blocker[]): void {
    this.scene = scene;
    this.blockers = blockers;
  }

  update(dt: number): void {
    if (!this.enabled) return;
    let fwd = this.joy.y;
    let side = this.joy.x;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) fwd += 1;
    if (k.has('s') || k.has('arrowdown')) fwd -= 1;
    if (k.has('d')) side += 1;
    if (k.has('a')) side -= 1;
    if (k.has('arrowleft')) this.yaw += 1.8 * dt;
    if (k.has('arrowright')) this.yaw -= 1.8 * dt;
    const len = Math.hypot(fwd, side);
    if (len > 1) { fwd /= len; side /= len; }
    if (len > 0.01) {
      const speed = SPEED * (k.has('shift') ? 2 : 1) * dt;
      // Blickrichtung im Grundriss: (−sin yaw, cos yaw); rechts davon: (cos yaw, sin yaw)
      const fx = -Math.sin(this.yaw), fy = Math.cos(this.yaw);
      const dx = (fx * fwd + fy * side) * speed;
      const dy = (fy * fwd - fx * side) * speed;
      if (this.free(this.x + dx, this.y + dy)) { this.x += dx; this.y += dy; }
      else if (this.free(this.x + dx, this.y)) this.x += dx;
      else if (this.free(this.x, this.y + dy)) this.y += dy;
    }
    this.apply();
  }

  private apply(): void {
    const eye = Math.min(EYE, (this.scene?.room.height ?? 2.5) - 0.15);
    this.camera.position.set(this.x, eye, -this.y);
    // three.js: Blick (−sin yaw, cos yaw) im Grundriss = (−sin yaw, 0, −cos yaw)
    const dir = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  private free(x: number, y: number): boolean {
    const poly = this.scene?.room.polygon;
    if (!poly || !pointInPolygon(poly, x, y)) return false;
    for (let i = 0; i < poly.length; i++) {
      if (segmentDistance(poly[i], poly[(i + 1) % poly.length], x, y) < RADIUS) return false;
    }
    for (const b of this.blockers) {
      if (x > b.minX - RADIUS * 0.6 && x < b.maxX + RADIUS * 0.6 && y > b.minY - RADIUS * 0.6 && y < b.maxY + RADIUS * 0.6) return false;
    }
    return true;
  }

  /** Nächsten freien Punkt auf einem Raster suchen. */
  private findFree(from: [number, number], center: [number, number]): [number, number] {
    let best: [number, number] = center;
    let bestD = Infinity;
    for (let gx = -8; gx <= 8; gx += 0.2) {
      for (let gy = -8; gy <= 8; gy += 0.2) {
        const x = center[0] + gx, y = center[1] + gy;
        if (!this.free(x, y)) continue;
        const d = Math.hypot(x - from[0], y - from[1]);
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best;
  }
}

function segmentDistance(a: [number, number], b: [number, number], x: number, y: number): number {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const l2 = ex * ex + ey * ey || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2));
  return Math.hypot(x - (a[0] + ex * t), y - (a[1] + ey * t));
}
