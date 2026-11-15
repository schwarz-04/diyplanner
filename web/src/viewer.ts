import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { buildScene } from './build';
import { buildScrews } from './diy';
import { Measure } from './measure';
import { WalkControls, type Blocker } from './walk';
import { toHome, toWorld, walkStart, walkWorld } from './home';
import type { Home, Scene, Selection } from './types';

/** Grundriss (x, y, z-oben) -> three.js (x, y-oben, z). Siehe auch build.ts. */
export const planToThree = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);
export const threeToPlan = (v: THREE.Vector3): [number, number, number] => [v.x, -v.z, v.y];

export type ViewMode = 'orbit' | 'top' | 'walk';
export type Tool = 'select' | 'measure';

export interface ViewerEvents {
  onSelect: (sel: Selection) => void;
  onObjectMoved: (id: string, position: [number, number, number], rotation: number) => void;
  /** Während des Ziehens (noch nicht gespeichert), z. B. für den Grundriss. */
  onObjectMoving?: (id: string, position: [number, number, number], rotation: number) => void;
  onMeasured?: (meters: number) => void;
  /** Standort beim Begehen (gemeinsamer Grundriss). */
  onWalk?: (x: number, y: number, yaw: number) => void;
  /** Ein anderer Raum der Wohnung wurde angetippt. */
  onRoomPick?: (index: number) => void;
}

interface RoomView { group: THREE.Group; index: number; scene: Scene }

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  /** Neues Möbel, noch nicht bestätigt: halbtransparent, Raum bleibt fest. */
  private placing: { id: string; mats: Map<THREE.Mesh, THREE.Material | THREE.Material[]> } | null = null;
  /** Bodenrahmen und Drehgriff des ausgewählten Möbels. */
  private handles: { id: string; group: THREE.Group; hit: THREE.Mesh } | null = null;
  private drag: {
    kind: 'move' | 'rotate'; id: string; plane: THREE.Plane; start: THREE.Vector3; startWorld: THREE.Vector3;
    startRot: number; startAngle: number; pointerId: number; moved: boolean;
  } | null = null;
  private root: THREE.Group | null = null;
  private homeRoot = new THREE.Group();
  private rooms: RoomView[] = [];
  private home: Home | null = null;
  private active = 0;
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
  private sun!: THREE.DirectionalLight;
  private windowLights = new THREE.Group();
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
    const sun = new THREE.DirectionalLight('#fff4e5', 1.8);
    sun.position.set(6, 10, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -10;
    cam.right = cam.top = 10;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    RectAreaLightUniformsLib.init();
    this.scene.add(this.windowLights);

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
      const v = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !v && !this.placing;
      if (!v) this.commitTransform();
    });
    this.gizmo.addEventListener('objectChange', () => this.objectChanged());
    // Nur die drei Pfeile zeigen: die Flächen- und Mittelgriffe verwirren und verdecken das Möbel.
    const giz = (this.gizmo as unknown as { _gizmo?: Record<string, Record<string, THREE.Object3D> | undefined> })._gizmo;
    for (const set of [giz?.gizmo?.translate, giz?.picker?.translate]) {
      for (const c of [...(set?.children ?? [])]) if (['XY', 'YZ', 'XZ', 'XYZ'].includes(c.name)) set!.remove(c);
    }
    this.scene.add(this.gizmo.getHelper());
    this.setGizmoMode('translate');

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

    // Möbel direkt ziehen und am Bogen drehen. Fängt den Zeiger vor Kamera und Pfeilen ab.
    container.addEventListener('pointerdown', (e) => this.dragStart(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.dragMove(e));
    const end = (e: PointerEvent) => this.dragEnd(e);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ Laden

  /** Einzelner Raum (Startseite, Demo): wird als Wohnung mit einem Raum gezeigt. */
  setScene(data: Scene, keepCamera: boolean): void {
    this.setHome(toHome(data), 0, keepCamera);
  }

  /** Baut die Wohnung neu auf (dauert nur Millisekunden). Bearbeitet wird der Raum active. */
  setHome(home: Home, active: number, keepCamera: boolean): void {
    const prevSel = active === this.active ? this.selection : null;
    const placingId = this.placing?.id;
    this.previewCut(null);
    this.stopPlacing();
    this.gizmo.detach();
    this.measure.detach();
    this.scene.remove(this.homeRoot);
    disposeTree(this.homeRoot);
    this.homeRoot = new THREE.Group();
    this.rooms = [];
    this.nodes.clear();
    this.home = home;
    this.active = Math.min(active, home.rooms.length - 1);
    home.rooms.forEach((r, index) => {
      const group = buildScene(r.scene);
      group.position.set(r.position[0], 0, -r.position[1]);
      group.rotation.y = (r.rotation * Math.PI) / 180;
      group.userData.dm_room = index;
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          const type = findData(mesh)?.dm_type;
          // Wände und Decke werfen Schatten, damit Sonnenlicht nur durch die Fenster fällt
          mesh.castShadow = type === 'object' || type === 'panel' || type === 'wall' || type === 'ceiling';
          mesh.receiveShadow = true;
          for (const m of materials(mesh)) {
            if (m.transparent || m.opacity < 1) m.depthWrite = false;
          }
        }
        if (index === this.active) {
          const id = o.userData?.dm_id as string | undefined;
          if (id) this.nodes.set(id, o);
        }
      });
      this.homeRoot.add(group);
      this.rooms.push({ group, index, scene: r.scene });
    });
    this.scene.add(this.homeRoot);
    this.homeRoot.updateMatrixWorld(true);
    this.root = this.rooms[this.active].group;
    this.sceneData = home.rooms[this.active].scene;
    this.measure.attachTo(this.root);
    this.measure.setRoom(this.sceneData);
    this.updateLights();
    this.updateWalkWorld();
    if (!keepCamera) this.frame(home.rooms.length > 1);
    this.setSelection(prevSel && this.nodeFor(prevSel) ? prevSel : null, false);
    if (placingId && this.selection?.kind === 'object' && this.selection.id === placingId) this.startPlacing(placingId);
  }

  // ------------------------------------------------------------------ Neues Möbel platzieren

  get placingId(): string | null {
    return this.placing?.id ?? null;
  }

  /** Möbel halbtransparent zeigen, bis es bestätigt wird. Solange bleibt die Kamera fest. */
  startPlacing(id: string): void {
    this.stopPlacing();
    const node = this.nodes.get(id);
    if (!node) return;
    const mats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mats.set(mesh, mesh.material);
      const ghost = (m: THREE.Material) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = Math.min(m.opacity, 0.45);
        c.depthWrite = false;
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(ghost) : ghost(mesh.material);
      mesh.castShadow = false;
    });
    this.placing = { id, mats };
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'move';
  }

  /** Platzieren beenden: wieder voll sichtbar. */
  stopPlacing(): void {
    const p = this.placing;
    if (!p) return;
    this.placing = null;
    this.controls.enabled = this.mode !== 'walk';
    this.renderer.domElement.style.cursor = this.tool === 'measure' ? 'crosshair' : '';
    for (const [mesh, orig] of p.mats) {
      const ghosts = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const origs = Array.isArray(orig) ? orig : [orig];
      // Farbänderungen während des Platzierens übernehmen
      origs.forEach((m, i) => {
        const g = ghosts[i] as THREE.MeshStandardMaterial | undefined;
        if (g?.color && (m as THREE.MeshStandardMaterial).color) (m as THREE.MeshStandardMaterial).color.copy(g.color);
        g?.dispose();
      });
      mesh.material = orig;
      mesh.castShadow = true;
    }
  }

  // ------------------------------------------------------------------ Bodenrahmen, Drehgriff, Ziehen

  private setHandles(id: string | null): void {
    if (this.handles) {
      this.scene.remove(this.handles.group);
      disposeTree(this.handles.group);
      this.handles = null;
    }
    const node = id ? this.nodes.get(id) : null;
    if (!id || !node) return;
    const { group, hit } = footprint(node);
    this.scene.add(group);
    this.handles = { id, group, hit };
    this.updateHandles();
  }

  private updateHandles(): void {
    const hd = this.handles;
    if (!hd) return;
    const node = this.nodes.get(hd.id);
    if (!node) return;
    node.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    node.getWorldPosition(pos);
    node.getWorldQuaternion(q);
    hd.group.position.set(pos.x, 0.025, pos.z);
    hd.group.quaternion.copy(q);
    hd.group.updateMatrixWorld(true);
  }

  /** Nach jeder Bewegung (Pfeile, Ziehen, Drehen): Hilfslinien nachführen. */
  private objectChanged(): void {
    const sel = this.selection;
    if (sel?.kind === 'object') {
      const node = this.nodes.get(sel.id);
      if (node) {
        // Nur um die Hochachse drehen, nie unter den Boden oder durch die Decke
        node.rotation.x = 0;
        node.rotation.z = 0;
        const size = this.sceneData?.objects.find((o) => o.id === sel.id)?.size;
        const top = Math.max(0, (this.sceneData?.room.height ?? 2.5) - (size?.[2] ?? 0));
        node.position.y = THREE.MathUtils.clamp(node.position.y, 0, top);
        if (this.sceneData?.diy) {
          this.snapToParts(node, sel.id);
          this.blockCollision(node, sel.id);
        }
        const rot = ((THREE.MathUtils.radToDeg(node.rotation.y) % 360) + 360) % 360;
        this.events.onObjectMoving?.(sel.id, threeToPlan(node.position), rot);
      }
    }
    this.selectionBox?.update();
    this.measure.updateSelection();
    this.updateHandles();
  }

  /** Werkbank: Teile dürfen nicht ineinander geschoben werden. Bei Kollision zurück auf die letzte gültige Lage. */
  private blockCollision(node: THREE.Object3D, id: string): void {
    node.updateWorldMatrix(true, false);
    const a = new THREE.Box3().setFromObject(node).expandByScalar(-0.0015);
    let hit = false;
    for (const [otherId, other] of this.nodes) {
      if (otherId === id || findData(other)?.dm_type !== 'object') continue;
      if (a.intersectsBox(new THREE.Box3().setFromObject(other).expandByScalar(-0.0015))) { hit = true; break; }
    }
    const valid = node.userData.dm_valid as { p: THREE.Vector3; r: number } | undefined;
    if (hit && valid) {
      node.position.copy(valid.p);
      node.rotation.y = valid.r;
      node.updateWorldMatrix(true, false);
    } else if (!hit) {
      node.userData.dm_valid = { p: node.position.clone(), r: node.rotation.y };
    }
  }

  // ------------------------------------------------------------------ Zuschnitt-Vorschau

  private cutPreview: { node: THREE.Object3D; group: THREE.Group; mats: { m: THREE.Material; t: boolean; o: number; dw: boolean }[] } | null = null;

  /** Schnitt zeigen: Linie an der Schnittstelle, wegfallender Teil halbtransparent. keep = Länge, die bleibt (m), null = aus. */
  previewCut(id: string | null, axis: 0 | 1 | 2 = 0, keep: number | null = null): void {
    const prev = this.cutPreview;
    if (prev) {
      prev.node.remove(prev.group);
      disposeTree(prev.group);
      for (const x of prev.mats) { x.m.transparent = x.t; x.m.opacity = x.o; x.m.depthWrite = x.dw; x.m.needsUpdate = true; }
      this.cutPreview = null;
      this.setOverlaysVisible(true);
    }
    if (!id || keep === null) return;
    const node = this.nodes.get(id) as THREE.Mesh | undefined;
    const o = this.sceneData?.objects.find((x) => x.id === id);
    if (!node || !o) return;
    const [w, d, h] = o.size;
    const full = o.size[axis];
    if (!(keep > 0 && keep < full)) return;
    // Lokale Maße im three-System: x = Breite, y = Höhe, z = -Tiefe; behalten wird das vordere Ende (wie cutTo)
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      return g;
    };
    let kept: THREE.BufferGeometry, plane: THREE.BufferGeometry;
    const e = 0.004;
    if (axis === 0) {
      kept = box(-w / 2, -w / 2 + keep, 0, h, -d / 2, d / 2);
      plane = box(-w / 2 + keep - 0.0005, -w / 2 + keep + 0.0005, -e, h + e, -d / 2 - e, d / 2 + e);
    } else if (axis === 1) {
      kept = box(-w / 2, w / 2, 0, h, d / 2 - keep, d / 2);
      plane = box(-w / 2 - e, w / 2 + e, -e, h + e, d / 2 - keep - 0.0005, d / 2 - keep + 0.0005);
    } else {
      kept = box(-w / 2, w / 2, 0, keep, -d / 2, d / 2);
      plane = box(-w / 2 - e, w / 2 + e, keep - 0.0005, keep + 0.0005, -d / 2 - e, d / 2 + e);
    }
    const group = new THREE.Group();
    group.name = 'cut_preview';
    group.add(new THREE.Mesh(kept, new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.75 })));
    const accent = new THREE.Color('#c2537a');
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(plane), new THREE.LineBasicMaterial({ color: accent, depthTest: false }));
    line.renderOrder = 10;
    const sheet = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }));
    sheet.renderOrder = 9;
    group.add(line, sheet);
    const mats = (Array.isArray(node.material) ? node.material : [node.material]).map((m) => {
      const saved = { m, t: m.transparent, o: m.opacity, dw: m.depthWrite };
      m.transparent = true;
      m.opacity = 0.22;
      m.depthWrite = false;
      m.needsUpdate = true;
      return saved;
    });
    node.add(group);
    this.cutPreview = { node, group, mats };
    // Auswahlrahmen, Griffe und Pfeile verdecken sonst die Schnittlinie
    this.setOverlaysVisible(false);
  }

  private setOverlaysVisible(v: boolean): void {
    if (this.selectionBox) this.selectionBox.visible = v;
    if (this.handles) this.handles.group.visible = v;
    (this.gizmo as unknown as THREE.Object3D).visible = v;
    const helper = (this.gizmo as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.();
    if (helper) helper.visible = v;
  }

  /** Werkbank: Flächen des bewegten Teils rasten an den Flächen der anderen Teile ein. */
  private snapToParts(node: THREE.Object3D, id: string): void {
    const SNAP = 0.025;
    node.updateWorldMatrix(true, false);
    const a = new THREE.Box3().setFromObject(node);
    const shift = new THREE.Vector3();
    const best = [SNAP, SNAP, SNAP];
    const axes = ['x', 'y', 'z'] as const;
    for (const [otherId, other] of this.nodes) {
      if (otherId === id || findData(other)?.dm_type !== 'object') continue;
      const b = new THREE.Box3().setFromObject(other);
      axes.forEach((ax, i) => {
        const [u, v] = axes.filter((k) => k !== ax);
        // nur wenn sich die Teile in den beiden anderen Richtungen (fast) überdecken
        if (a.max[u] < b.min[u] - SNAP || a.min[u] > b.max[u] + SNAP || a.max[v] < b.min[v] - SNAP || a.min[v] > b.max[v] + SNAP) return;
        for (const d of [b.max[ax] - a.min[ax], b.min[ax] - a.max[ax], b.min[ax] - a.min[ax], b.max[ax] - a.max[ax]]) {
          if (Math.abs(d) < best[i]) { best[i] = Math.abs(d); shift[ax] = d; }
        }
      });
    }
    if (shift.lengthSq() > 0) {
      const world = node.getWorldPosition(new THREE.Vector3()).add(shift);
      node.position.copy(node.parent ? node.parent.worldToLocal(world) : world);
      if (node.position.y < 0) node.position.y = 0;
      node.updateWorldMatrix(true, false);
    }
  }

  private rayFor(e: PointerEvent): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray;
  }

  private dragStart(e: PointerEvent): void {
    if (e.target !== this.renderer.domElement || e.button !== 0 || this.tool !== 'select' || this.drag) return;
    const sel = this.selection;
    if (sel?.kind !== 'object') return;
    const node = this.nodes.get(sel.id);
    if (!node) return;
    const ray = this.rayFor(e);
    const begin = (kind: 'move' | 'rotate', plane: THREE.Plane): void => {
      const start = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!start) return;
      const world = node.getWorldPosition(new THREE.Vector3());
      this.drag = {
        kind, id: sel.id, plane, start, startWorld: world, startRot: node.rotation.y,
        startAngle: Math.atan2(-(start.z - world.z), start.x - world.x), pointerId: e.pointerId, moved: false,
      };
      this.controls.enabled = false;
      e.stopPropagation();
      e.preventDefault();
    };
    // Drehgriff hat Vorrang
    if (this.handles && ray.intersectObject(this.handles.hit, false).length) {
      begin('rotate', new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.025));
      return;
    }
    // Pfeile des Griffs (auf Touch-Geräten gibt es vorher kein Hover)
    const g = this.gizmo as unknown as { axis: string | null; pointerHover?: (p: unknown) => void; _getPointer?: (e: PointerEvent) => unknown };
    if (e.pointerType !== 'mouse') g.pointerHover?.(g._getPointer?.(e));
    if (g.axis && g.axis !== 'XYZ') return;
    const hit = ray.intersectObject(node, true)[0];
    if (!hit && !this.placing) return;
    const at = hit?.point ?? node.getWorldPosition(new THREE.Vector3());
    const cat = this.sceneData?.objects.find((o) => o.id === sel.id)?.category ?? '';
    let plane: THREE.Plane;
    if (WALL_ITEMS.has(cat)) {
      // An der Wand: seitlich und in der Höhe verschieben
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(node.matrixWorld);
      normal.y = 0;
      if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), at);
    } else {
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), at);
    }
    begin('move', plane);
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const node = this.nodes.get(d.id);
    if (!node) return;
    const p = this.rayFor(e).ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!p) return;
    d.moved = true;
    if (d.kind === 'rotate') {
      const angle = Math.atan2(-(p.z - d.startWorld.z), p.x - d.startWorld.x);
      let deg = THREE.MathUtils.radToDeg(d.startRot + angle - d.startAngle);
      deg = ((deg % 360) + 360) % 360;
      // Einrasten bei 0°, 90°, 180°, 270° (Umschalt = ohne Einrasten), sonst ganze Grad
      const snap = [0, 90, 180, 270, 360].find((v) => Math.abs(deg - v) < 7);
      deg = snap !== undefined && !e.shiftKey ? snap % 360 : Math.round(deg);
      node.rotation.y = THREE.MathUtils.degToRad(deg);
      this.measure.showAngle(node, deg);
    } else {
      const target = d.startWorld.clone().add(p.sub(d.start));
      node.position.copy(node.parent ? node.parent.worldToLocal(target) : target);
    }
    this.objectChanged();
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    this.measure.showAngle(null, null);
    this.controls.enabled = !this.placing && this.mode !== 'walk';
    if (d.moved) this.commitTransform();
  }

  /** Möbel von außen bewegen (Grundriss), ohne Neubau. */
  moveNode(id: string, position: [number, number, number], rotation?: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.position.copy(planToThree(position[0], position[1], position[2]));
    if (rotation !== undefined) node.rotation.y = THREE.MathUtils.degToRad(rotation);
    this.selectionBox?.update();
    this.measure.updateSelection();
    this.updateHandles();
  }

  setDark(dark: boolean, gradient = false): void {
    const top = dark ? '#1f1d1b' : '#f4f1ec';
    const old = this.scene.background;
    if (old instanceof THREE.Texture) old.dispose();
    if (!gradient) {
      this.scene.background = new THREE.Color(top);
      return;
    }
    // Verlauf nur im unteren Bereich
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 512;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, top);
    grad.addColorStop(0.45, top);
    grad.addColorStop(1, dark ? '#58524d' : '#ddcfc7');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = tex;
  }

  /** Hinein- (factor < 1) oder herauszoomen. Beim Begehen ändert sich der Blickwinkel. */
  zoom(factor: number): void {
    if (this.mode === 'walk') {
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov * factor, 30, 90);
      this.camera.updateProjectionMatrix();
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(len));
    this.controls.update();
  }

  /**
   * Tageslicht: Sonne scheint durch das größte Fenster des bearbeiteten Raums (Wände und Decke werfen Schatten),
   * dazu ein weiches Flächenlicht in jeder Fensteröffnung.
   */
  private updateLights(): void {
    for (const l of [...this.windowLights.children]) {
      this.windowLights.remove(l);
      (l as THREE.Light).dispose?.();
    }
    let best: { center: THREE.Vector3; out: THREE.Vector3; area: number } | null = null;
    for (const r of this.rooms) {
      const s = r.scene;
      const poly = s.room.polygon;
      s.walls.forEach((wall, i) => {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (!a || !b) return;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const n = [Math.sin(ang), -Math.cos(ang)]; // außen
        const t = wall.thickness ?? 0.12;
        for (const op of wall.openings) {
          if (op.type !== 'window') continue;
          const px = a[0] + u[0] * op.offset, py = a[1] + u[1] * op.offset;
          const z = (op.sill ?? 0) + op.height / 2;
          // Position im Raum (lokal), etwas vor der Öffnung
          const local = planToThree(px - n[0] * 0.02, py - n[1] * 0.02, z);
          const center = r.group.localToWorld(local.clone());
          const outLocal = planToThree(px + n[0], py + n[1], z);
          const out = r.group.localToWorld(outLocal).sub(center).normalize();
          const light = new THREE.RectAreaLight('#fff3df', r.index === this.active ? 3.2 : 2, op.width, op.height);
          light.position.copy(center);
          light.lookAt(center.clone().sub(out));
          this.windowLights.add(light);
          const area = op.width * op.height + (r.index === this.active ? 100 : 0);
          if (!best || area > best.area) best = { center: r.group.localToWorld(planToThree(px + n[0] * t, py + n[1] * t, z)), out, area };
          void t;
        }
      });
    }
    const sun = this.sun;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    if (best) {
      const b = best as { center: THREE.Vector3; out: THREE.Vector3 };
      // Sonne schräg von außen und oben, etwas seitlich, damit ein Lichtfleck auf den Boden fällt
      const side = new THREE.Vector3(-b.out.z, 0, b.out.x).multiplyScalar(0.35);
      const dir = b.out.clone().add(side).normalize();
      sun.target.position.copy(b.center).addScaledVector(b.out, -1.5).setY(0);
      sun.position.copy(sun.target.position).addScaledVector(dir, 7).setY(sun.target.position.y + 5.5);
      cam.left = cam.bottom = -8;
      cam.right = cam.top = 8;
      cam.near = 0.5;
      cam.far = 30;
    } else {
      sun.position.set(6, 10, 4);
      sun.target.position.set(0, 0, 0);
      cam.left = cam.bottom = -10;
      cam.right = cam.top = 10;
    }
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  /** Wand des bearbeiteten Raums, auf die die Kamera am direktesten schaut (für Bilder, Spiegel …). */
  facingWall(): number {
    if (!this.sceneData || !this.root) return 0;
    const cam = threeToPlan(this.root.worldToLocal(this.camera.position.clone()));
    const poly = this.sceneData.room.polygon;
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len; // Außennormale
      const mx = (a[0] + b[0]) / 2 - cam[0], my = (a[1] + b[1]) / 2 - cam[1];
      const score = (mx * nx + my * ny) / (Math.hypot(mx, my) || 1) + len * 0.02;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  get activeRoom(): number {
    return this.active;
  }

  /** Kamera so setzen, dass der Raum (all: die ganze Wohnung) sichtbar ist. */
  frame(all = false): void {
    if (!this.sceneData || !this.home || this.mode === 'walk') return;
    const idx = all ? this.home.rooms.map((_, i) => i) : [this.active];
    const pts = idx.flatMap((i) => this.home!.rooms[i].scene.room.polygon.map((p) => toWorld(this.home!.rooms[i], p)));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const center = new THREE.Vector2((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
    const size = new THREE.Vector2(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const h = this.sceneData.room.height;
    if (this.sceneData.diy && this.mode !== 'top') {
      // Werkbank: Blick fast waagerecht auf die Teile (wie auf einer Werkbank), nicht von oben
      const objs = this.sceneData.objects;
      const box = new THREE.Box3();
      for (const o of objs) {
        const n = this.nodes.get(o.id);
        if (n) box.expandByObject(n);
      }
      if (box.isEmpty()) box.set(planToThree(center.x - 0.6, center.y + 0.4, 0), planToThree(center.x + 0.6, center.y - 0.4, 0.8));
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(0.6, box.getSize(new THREE.Vector3()).length() / 2);
      this.controls.target.set(c.x, Math.max(0.15, c.y), c.z);
      const d = (r * 2.4 + 0.6) * Math.max(1, 0.85 / this.camera.aspect);
      // ca. 18° über der Waagerechten, leicht von vorne rechts
      const el = THREE.MathUtils.degToRad(18), az = THREE.MathUtils.degToRad(28);
      this.camera.position.set(c.x + d * Math.cos(el) * Math.sin(az), Math.max(0.15, c.y) + d * Math.sin(el), c.z + d * Math.cos(el) * Math.cos(az));
      this.controls.update();
      return;
    }
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
      if (!this.home) return;
      this.gizmo.detach();
      this.controls.enabled = false;
      this.controls.autoRotate = false;
      this.walk.enable(walkWorld(this.home), this.blockers(), walkStart(this.home.rooms[this.active]));
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

  /** Grundriss-Rechtecke der Möbel aller Räume, an denen man beim Begehen nicht vorbeikommt. */
  private blockers(): Blocker[] {
    const out: Blocker[] = [];
    for (const r of this.rooms) {
      r.group.traverse((node) => {
        if (node.userData?.dm_type !== 'object') return;
        const o = r.scene.objects.find((x) => x.id === node.userData.dm_id);
        if (!o || o.size[2] < 0.25 || o.position[2] > 1.2) return; // Teppiche und Hängendes
        const b = new THREE.Box3().setFromObject(node);
        if (!b.isEmpty()) out.push({ minX: b.min.x, maxX: b.max.x, minY: -b.max.z, maxY: -b.min.z });
      });
    }
    return out;
  }

  private updateWalkWorld(): void {
    if (this.home) this.walk.setWorld(walkWorld(this.home), this.blockers());
  }

  /** Punkt auf einer sichtbaren Fläche unter dem Mauszeiger (für das Messen). */
  private surfacePoint(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.homeRoot, true).find((h) => isVisible(h.object));
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
    const hits = ray.intersectObject(this.homeRoot, true).filter((h) => isVisible(h.object));
    const roomOf = (o: THREE.Object3D | null): number => {
      while (o) {
        if (typeof o.userData?.dm_room === 'number') return o.userData.dm_room;
        o = o.parent;
      }
      return -1;
    };
    if (hits.length) {
      const r = roomOf(hits[0].object);
      if (r >= 0 && r !== this.active) {
        this.events.onRoomPick?.(r);
        return;
      }
    }
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
    if (this.placing && !(sel?.kind === 'object' && sel.id === this.placing.id)) this.stopPlacing();
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
    this.setHandles(node && sel?.kind === 'object' ? sel.id : null);
    const obj = sel?.kind === 'object' ? this.sceneData?.objects.find((o) => o.id === sel.id) : undefined;
    this.measure.setSelection(obj && node ? node : null, obj?.size);
    if (notify) this.events.onSelect(sel);
  }

  setGizmoMode(mode: 'translate' | 'rotate'): void {
    this.gizmo.setMode(mode);
    // Verschieben: alle drei Richtungen (auch in der Höhe). Drehen: nur um die Hochachse.
    this.gizmo.showX = mode === 'translate';
    this.gizmo.showZ = mode === 'translate';
    this.gizmo.showY = true;
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
    this.updateHandles();
    this.updateWalkWorld();
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
    if (this.home) {
      this.home = { ...this.home, rooms: this.home.rooms.map((r, i) => (i === this.active ? { ...r, scene: data } : r)) };
      this.rooms[this.active].scene = data;
    }
    if (data.diy && this.root) {
      // Schrauben neu setzen, wenn Teile verschoben wurden
      const old = this.root.getObjectByName('diy_screws');
      if (old) { this.root.remove(old); disposeTree(old); }
      this.root.add(buildScrews(data));
    }
    this.updateWalkWorld();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ Schleife

  private tick(): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.mode === 'walk') {
      this.walk.update(dt);
      const w = this.walk.position;
      this.events.onWalk?.(w.x, w.y, w.yaw);
    } else this.controls.update();
    this.runAnimations(dt);
    this.updateWallVisibility();
    this.renderer.render(this.scene, this.camera);
    this.measure.render(this.scene, this.camera);
  }

  /** Wände zwischen Kamera und Raum ausblenden (Puppenhaus-Ansicht), für jeden Raum der Wohnung. */
  private updateWallVisibility(): void {
    const walking = this.mode === 'walk';
    for (const r of this.rooms) {
      const camPlan = threeToPlan(r.group.worldToLocal(this.camera.position.clone()));
      const poly = r.scene.room.polygon;
      const hidden = new Set<string>();
      r.group.traverse((node) => {
        const d = node.userData;
        if (d.dm_type !== 'wall') return;
        const i = d.dm_index as number;
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (!a || !b) return;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const outside = !walking && (camPlan[0] - mx) * d.dm_nx + (camPlan[1] - my) * d.dm_ny > 0.05;
        node.visible = !outside;
        if (outside) hidden.add(d.dm_id);
      });
      r.group.traverse((node) => {
        const d = node.userData;
        if (d.dm_wall) node.visible = !hidden.has(d.dm_wall);
        if (d.dm_type === 'ceiling') node.visible = camPlan[2] < r.scene.room.height - 0.05;
      });
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

/** Wandobjekte: beim Ziehen an der Wand entlang und in der Höhe verschieben. */
const WALL_ITEMS = new Set(['wall_shelf', 'picture', 'mirror', 'curtain']);

/** Rahmen am Boden unter dem Möbel (in dessen Drehung) mit Bogen-Griff zum Drehen. */
function footprint(node: THREE.Object3D): { group: THREE.Group; hit: THREE.Mesh } {
  node.updateWorldMatrix(true, true);
  const inv = node.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv));
  });
  const g = new THREE.Group();
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.2, 0, -0.2), new THREE.Vector3(0.2, 0.2, 0.2));
  const pad = 0.03;
  const w = box.max.x - box.min.x + pad * 2;
  const d = box.max.z - box.min.z + pad * 2;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const accent = '#c2537a';
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(cx, 0, cz);
  fill.renderOrder = 8;
  const hw = w / 2, hd = d / 2;
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(cx - hw, 0.002, cz - hd), new THREE.Vector3(cx + hw, 0.002, cz - hd),
    new THREE.Vector3(cx + hw, 0.002, cz + hd), new THREE.Vector3(cx - hw, 0.002, cz + hd),
  ]), new THREE.LineBasicMaterial({ color: accent, transparent: true, depthTest: false }));
  outline.renderOrder = 9;

  // Drehgriff: Viertelbogen mit Pfeilspitzen vor der vorderen rechten Ecke
  const r = Math.hypot(hw, hd) + 0.16;
  const mat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, depthTest: false });
  const arcStart = -Math.PI / 4 - 0.5, arcLen = 1.0;
  const arc = new THREE.Mesh(new THREE.TorusGeometry(r, 0.02, 6, 24, arcLen), mat);
  const handle = new THREE.Group();
  handle.add(arc);
  for (const [a, dir] of [[0, -1], [arcLen, 1]] as const) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 10), mat);
    cone.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
    cone.rotation.z = a + (dir > 0 ? 0 : Math.PI);
    handle.add(cone);
  }
  const hit = new THREE.Mesh(new THREE.TorusGeometry(r, 0.11, 6, 16, arcLen + 0.3),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
  hit.rotation.z = -0.15;
  handle.add(hit);
  // Torus liegt in der XY-Ebene: flach auf den Boden legen und nach vorne rechts drehen
  handle.rotation.set(-Math.PI / 2, 0, arcStart);
  handle.position.set(cx, 0.004, cz);
  handle.traverse((o) => (o.renderOrder = 10));
  g.add(fill, outline, handle);
  return { group: g, hit };
}
