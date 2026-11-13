import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildScene } from './build';
import { Measure } from './measure';
import { WalkControls, type Blocker } from './walk';
import type { Scene, Selection } from './types';

/** Grundriss (x, y, z-oben) -> three.js (x, y-oben, z). Siehe auch build.ts. */
export const planToThree = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);
export const threeToPlan = (v: THREE.Vector3): [number, number, number] => [v.x, -v.z, v.y];

export type ViewMode = 'orbit' | 'top' | 'walk';
export type Tool = 'select' | 'measure';

export interface ViewerEvents {
  onSelect: (sel: Selection) => void;
  onObjectMoved: (id: string, position: [number, number, number], rotation: number) => void;
  onMeasured?: (meters: number) => void;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  private root: THREE.Group | null = null;
  private nodes = new Map<string, THREE.Object3D>();
  private selection: Selection = null;
  private selectionBox: THREE.BoxHelper | null = null;
  private sceneData: Scene | null = null;
  private mode: ViewMode = 'orbit';
  private pointerDown: { x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver;
  readonly measure: Measure;
  readonly walk: WalkControls;
  private tool: Tool = 'select';
  private shift = { x: 0, y: 0 };
  /** > 1: Kamera beim Einpassen weiter weg (Startseite am Handy). */
  zoomOut = 1;
  private clock = new THREE.Clock();
  private anims: { node: THREE.Object3D; y: number; t: number }[] = [];
  private fades: { mats: THREE.MeshStandardMaterial[]; from: THREE.Color[]; to: THREE.Color; t: number; ms: number }[] = [];

  constructor(private container: HTMLElement, private events: ViewerEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#f4f1ec');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c9b9a5', 0.9));
    const sun = new THREE.DirectionalLight('#fff4e5', 1.6);
    sun.position.set(6, 10, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -10;
    cam.right = cam.top = 10;
    this.scene.add(sun, sun.target);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 30;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.showY = false;
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) this.commitTransform();
    });
    this.gizmo.addEventListener('objectChange', () => {
      this.selectionBox?.update();
      this.measure.updateSelection();
    });
    this.scene.add(this.gizmo.getHelper());

    this.measure = new Measure(container, this.scene);
    this.walk = new WalkControls(this.camera, this.renderer.domElement, container);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved >= 5 || this.gizmo.dragging) return;
      if (this.tool === 'measure') {
        const p = this.surfacePoint(e);
        if (p) {
          const d = this.measure.addPoint(p);
          if (d !== null) this.events.onMeasured?.(d);
        }
      } else this.pick(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.tool === 'measure' && this.measure.measuring && e.pointerType !== 'touch') this.measure.preview(this.surfacePoint(e));
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ Laden

  /** Baut die Szene aus den Daten neu auf (dauert nur Millisekunden). */
  setScene(data: Scene, keepCamera: boolean): void {
    const built = buildScene(data);
    const prevSel = this.selection;
    this.gizmo.detach();
    if (this.root) {
      this.scene.remove(this.root);
      disposeTree(this.root);
    }
    this.root = built;
    this.nodes.clear();
    this.root.traverse((o) => {
      const id = o.userData?.dm_id as string | undefined;
      if (id) this.nodes.set(id, o);
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        const type = findData(mesh)?.dm_type;
        mesh.castShadow = type === 'object' || type === 'panel';
        mesh.receiveShadow = true;
        for (const m of materials(mesh)) {
          if (m.transparent || m.opacity < 1) m.depthWrite = false;
        }
      }
    });
    this.scene.add(this.root);
    this.sceneData = data;
    this.measure.setRoom(data);
    this.walk.setScene(data, this.blockers());
    if (!keepCamera) this.frame();
    this.setSelection(prevSel && this.nodeFor(prevSel) ? prevSel : null, false);
  }

  /** Kamera so setzen, dass der ganze Raum sichtbar ist. */
  frame(): void {
    if (!this.sceneData || this.mode === 'walk') return;
    const { center, size } = this.roomBounds();
    const h = this.sceneData.room.height;
    this.controls.target.copy(planToThree(center.x, center.y, h * 0.35));
    if (this.mode === 'top') {
      this.camera.position.copy(planToThree(center.x, center.y - 0.01, Math.max(size.x, size.y) * 1.6 + h));
    } else {
      // Hochformat (Handy): weiter weg, damit der Raum in die Breite passt
      const d = (Math.max(size.x, size.y) * 1.25 + 2) * Math.max(1, 0.85 / this.camera.aspect) * this.zoomOut;
      this.camera.position.copy(planToThree(center.x + d * 0.55, center.y - d * 0.8, h + d * 0.55));
    }
    this.controls.update();
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    const wasWalk = this.mode === 'walk';
    this.mode = mode;
    if (mode === 'walk') {
      if (!this.sceneData) return;
      this.gizmo.detach();
      this.controls.enabled = false;
      this.controls.autoRotate = false;
      this.walk.enable(this.sceneData, this.blockers());
      return;
    }
    if (wasWalk) {
      this.walk.disable();
      this.controls.enabled = true;
      if (this.selection?.kind === 'object') this.setSelection(this.selection, false);
    }
    this.controls.maxPolarAngle = mode === 'top' ? 0.01 : Math.PI * 0.49;
    this.controls.minPolarAngle = 0;
    this.frame();
  }

  /** Bildmitte verschieben (Pixel), z. B. damit ein offenes Menü den Raum nicht verdeckt. */
  setViewShift(x: number, y: number): void {
    if (Math.abs(x - this.shift.x) < 1 && Math.abs(y - this.shift.y) < 1) return;
    this.shift = { x, y };
    this.resize();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.measure.cancelPending();
    this.renderer.domElement.style.cursor = tool === 'measure' ? 'crosshair' : '';
    if (tool === 'measure') this.setSelection(null, true);
  }

  /** Grundriss-Rechtecke der Möbel, an denen man beim Begehen nicht vorbeikommt. */
  private blockers(): Blocker[] {
    const out: Blocker[] = [];
    for (const o of this.sceneData?.objects ?? []) {
      if (o.size[2] < 0.25 || o.position[2] > 1.2) continue; // Teppiche und Hängendes
      const node = this.nodes.get(o.id);
      if (!node) continue;
      const b = new THREE.Box3().setFromObject(node);
      if (b.isEmpty()) continue;
      out.push({ minX: b.min.x, maxX: b.max.x, minY: -b.max.z, maxY: -b.min.z });
    }
    return out;
  }

  /** Punkt auf einer sichtbaren Fläche unter dem Mauszeiger (für das Messen). */
  private surfacePoint(e: PointerEvent): THREE.Vector3 | null {
    if (!this.root) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.root, true).find((h) => isVisible(h.object));
    return hit ? hit.point.clone() : null;
  }

  // ------------------------------------------------------------------ Animationen (Startseite)

  /** Möbel fällt sanft von oben an seinen Platz. */
  animateIn(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.anims.push({ node, y: node.position.y, t: 0 });
    node.position.y += 1.2;
    node.scale.setScalar(0.6);
  }

  /** Farbe weich überblenden (Materialname <key>_main). */
  fadeColor(key: string, hex: string, ms = 700): void {
    const mats: THREE.MeshStandardMaterial[] = [];
    this.root?.traverse((o) => {
      for (const m of materials(o as THREE.Mesh)) if (m.name === `${key}_main`) mats.push(m as THREE.MeshStandardMaterial);
    });
    if (mats.length) this.fades.push({ mats, from: mats.map((m) => m.color.clone()), to: new THREE.Color(hex), t: 0, ms });
  }

  private runAnimations(dt: number): void {
    this.anims = this.anims.filter((a) => {
      a.t = Math.min(1, a.t + dt / 0.55);
      const e = 1 - Math.pow(1 - a.t, 3);
      a.node.position.y = a.y + (1 - e) * 1.2;
      a.node.scale.setScalar(0.6 + 0.4 * e);
      return a.t < 1;
    });
    this.fades = this.fades.filter((f) => {
      f.t = Math.min(1, f.t + (dt * 1000) / f.ms);
      f.mats.forEach((m, i) => m.color.copy(f.from[i]).lerp(f.to, f.t));
      return f.t < 1;
    });
  }

  private roomBounds() {
    const poly = this.sceneData!.room.polygon;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const min = new THREE.Vector2(Math.min(...xs), Math.min(...ys));
    const max = new THREE.Vector2(Math.max(...xs), Math.max(...ys));
    return { center: min.clone().add(max).multiplyScalar(0.5), size: max.clone().sub(min) };
  }

  // ------------------------------------------------------------------ Auswahl

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    if (!this.root) return;
    const hits = ray.intersectObject(this.root, true).filter((h) => isVisible(h.object));
    for (const hit of hits) {
      const data = findData(hit.object);
      if (!data) continue;
      const sel = toSelection(data);
      if (sel) {
        this.setSelection(sel, true);
        return;
      }
    }
    this.setSelection(null, true);
  }

  setSelection(sel: Selection, notify: boolean): void {
    this.selection = sel;
    this.gizmo.detach();
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.dispose();
      this.selectionBox = null;
    }
    const node = sel ? this.nodeFor(sel) : null;
    if (node && sel?.kind !== 'floor' && sel?.kind !== 'ceiling') {
      this.selectionBox = new THREE.BoxHelper(node, '#e0457b');
      this.scene.add(this.selectionBox);
    }
    if (node && sel?.kind === 'object' && this.mode !== 'walk') this.gizmo.attach(node);
    const obj = sel?.kind === 'object' ? this.sceneData?.objects.find((o) => o.id === sel.id) : undefined;
    this.measure.setSelection(obj && node ? node : null, obj?.size);
    if (notify) this.events.onSelect(sel);
  }

  setGizmoMode(mode: 'translate' | 'rotate'): void {
    this.gizmo.setMode(mode);
    this.gizmo.showX = mode === 'translate';
    this.gizmo.showZ = mode === 'translate';
    this.gizmo.showY = mode === 'rotate';
    if (mode === 'rotate') this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    else this.gizmo.setTranslationSnap(null);
  }

  private nodeFor(sel: NonNullable<Selection>): THREE.Object3D | undefined {
    if (sel.kind === 'floor' || sel.kind === 'ceiling') return this.nodes.get(sel.kind);
    return this.nodes.get(sel.id);
  }

  private commitTransform(): void {
    const sel = this.selection;
    if (sel?.kind !== 'object') return;
    const node = this.nodes.get(sel.id);
    if (!node) return;
    node.position.y = Math.max(0, node.position.y);
    const rot = ((THREE.MathUtils.radToDeg(node.rotation.y) % 360) + 360) % 360;
    this.events.onObjectMoved(sel.id, threeToPlan(node.position), Math.round(rot * 10) / 10);
    this.selectionBox?.update();
    this.measure.updateSelection();
    if (this.sceneData) this.walk.setScene(this.sceneData, this.blockers());
  }

  // ------------------------------------------------------------------ Änderungen ohne Neubau

  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (this.selection && 'id' in this.selection && this.selection.id === id) this.setSelection(null, true);
    node.parent?.remove(node);
    disposeTree(node);
    this.nodes.delete(id);
  }

  setColor(key: string, hex: string): void {
    this.root?.traverse((o) => {
      for (const m of materials(o as THREE.Mesh)) {
        if (m.name === `${key}_main`) (m as THREE.MeshStandardMaterial).color.set(hex);
      }
    });
  }

  updateData(data: Scene): void {
    this.sceneData = data;
    this.walk.setScene(data, this.blockers());
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ Schleife

  private tick(): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.mode === 'walk') this.walk.update(dt);
    else this.controls.update();
    this.runAnimations(dt);
    this.updateWallVisibility();
    this.renderer.render(this.scene, this.camera);
    this.measure.render(this.scene, this.camera);
  }

  /** Wände zwischen Kamera und Raum ausblenden (Puppenhaus-Ansicht). */
  private updateWallVisibility(): void {
    if (!this.sceneData || !this.root) return;
    const cam = this.camera.position;
    const camPlan = threeToPlan(cam);
    const hidden = new Set<string>();
    const poly = this.sceneData.room.polygon;
    for (const [id, node] of this.nodes) {
      const d = node.userData;
      if (d.dm_type !== 'wall') continue;
      const i = d.dm_index as number;
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (!a || !b) continue;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const outside = (camPlan[0] - mx) * d.dm_nx + (camPlan[1] - my) * d.dm_ny > 0.05;
      node.visible = !outside;
      if (outside) hidden.add(id);
    }
    for (const node of this.nodes.values()) {
      const d = node.userData;
      if (d.dm_wall) node.visible = !hidden.has(d.dm_wall);
      if (d.dm_type === 'ceiling') node.visible = camPlan[2] < this.sceneData.room.height - 0.05;
    }
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.measure?.setSize(w, h);
    this.camera.aspect = w / h;
    if (this.shift.x || this.shift.y) this.camera.setViewOffset(w, h, -this.shift.x, this.shift.y, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

// ------------------------------------------------------------------ Hilfsfunktionen

function materials(mesh: THREE.Mesh): THREE.Material[] {
  if (!mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** userData mit dm_*-Feldern am Objekt oder einem Elternteil finden. */
function findData(o: THREE.Object3D | null): Record<string, any> | null {
  while (o) {
    if (o.userData?.dm_type) return o.userData;
    o = o.parent;
  }
  return null;
}

function isVisible(o: THREE.Object3D | null): boolean {
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

function toSelection(d: Record<string, any>): Selection {
  switch (d.dm_type) {
    case 'object':
      return { kind: 'object', id: d.dm_id };
    case 'wall':
      return { kind: 'wall', id: d.dm_id };
    case 'panel':
      return { kind: 'panel', id: d.dm_id };
    case 'window':
    case 'door':
      return { kind: 'wall', id: d.dm_wall };
    case 'floor':
      return { kind: 'floor' };
    case 'ceiling':
      return { kind: 'ceiling' };
    default:
      return null;
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      for (const m of materials(mesh)) m.dispose();
    }
  });
}
