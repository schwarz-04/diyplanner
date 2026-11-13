import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Scene, Selection } from './types';

/** Grundriss (x, y, z-oben) -> three.js (x, y-oben, z). Entspricht dem glTF-Export von Blender. */
export const planToThree = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);
export const threeToPlan = (v: THREE.Vector3): [number, number, number] => [v.x, -v.z, v.y];

type ViewMode = 'orbit' | 'top';

export interface ViewerEvents {
  onSelect: (sel: Selection) => void;
  onObjectMoved: (id: string, position: [number, number, number], rotation: number) => void;
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
  private loader = new GLTFLoader();
  private pointerDown: { x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver;

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
    this.gizmo.addEventListener('objectChange', () => this.selectionBox?.update());
    this.scene.add(this.gizmo.getHelper());

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved < 5 && !this.gizmo.dragging) this.pick(e);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ Laden

  async load(url: string, data: Scene, keepCamera: boolean): Promise<void> {
    const gltf = await this.loader.parseAsync(await fetchModel(url), '');
    const prevSel = this.selection;
    this.gizmo.detach();
    if (this.root) {
      this.scene.remove(this.root);
      disposeTree(this.root);
    }
    this.root = gltf.scene;
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
    if (!keepCamera) this.frame();
    this.setSelection(prevSel && this.nodeFor(prevSel) ? prevSel : null, false);
  }

  /** Kamera so setzen, dass der ganze Raum sichtbar ist. */
  frame(): void {
    if (!this.sceneData) return;
    const { center, size } = this.roomBounds();
    const h = this.sceneData.room.height;
    this.controls.target.copy(planToThree(center.x, center.y, h * 0.35));
    if (this.mode === 'top') {
      this.camera.position.copy(planToThree(center.x, center.y - 0.01, Math.max(size.x, size.y) * 1.6 + h));
    } else {
      const d = Math.max(size.x, size.y) * 1.25 + 2;
      this.camera.position.copy(planToThree(center.x + d * 0.55, center.y - d * 0.8, h + d * 0.55));
    }
    this.controls.update();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.controls.maxPolarAngle = mode === 'top' ? 0.01 : Math.PI * 0.49;
    this.controls.minPolarAngle = 0;
    this.frame();
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
    if (node && sel?.kind === 'object') this.gizmo.attach(node);
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
  }

  // ------------------------------------------------------------------ Demo-Modus ohne Server

  private templates = new Map<string, THREE.Object3D>();
  private baseSizes = new Map<string, [number, number, number]>();

  /** Lädt Möbel-Vorlagen (ein Objekt je Kategorie in Standardgröße), aus denen neue Möbel geklont werden. */
  async loadLibrary(url: string, sizes: Record<string, [number, number, number]>): Promise<void> {
    const gltf = await this.loader.parseAsync(await fetchModel(url), '');
    gltf.scene.traverse((o) => {
      const d = o.userData;
      if (d?.dm_type === 'object' && d.dm_category && !this.templates.has(d.dm_category)) {
        this.templates.set(d.dm_category, o);
        this.baseSizes.set(`tpl:${d.dm_category}`, sizes[d.dm_category]);
      }
    });
  }

  /** Merkt sich die Größe, mit der Blender die Objekte des geladenen GLB gebaut hat. */
  rememberBaseSizes(data: Scene): void {
    for (const o of data.objects) this.baseSizes.set(o.id, [...o.size] as [number, number, number]);
  }

  /**
   * Gleicht die Möbel in der 3D-Ansicht mit den Szenendaten ab, ohne dass Blender neu baut:
   * fehlende werden aus Vorlagen geklont, gelöschte entfernt, Lage, Größe und Farbe übernommen.
   */
  syncScene(data: Scene): void {
    if (!this.root) return;
    this.sceneData = data;
    const wanted = new Set(data.objects.map((o) => o.id));
    for (const [id, node] of [...this.nodes]) {
      if (node.userData.dm_type === 'object' && !wanted.has(id)) this.removeNode(id);
    }
    for (const o of data.objects) {
      let node = this.nodes.get(o.id);
      if (!node) {
        const tpl = this.templates.get(o.category) ?? this.templates.get('box');
        if (!tpl) continue;
        node = tpl.clone(true);
        const tplKey = `${tpl.userData.dm_id}_main`;
        node.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.geometry = mesh.geometry.clone();
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map((m) => cloneMat(m, tplKey, o.id))
            : cloneMat(mesh.material, tplKey, o.id);
        });
        node.userData = { ...tpl.userData, dm_id: o.id, dm_label: o.label };
        this.baseSizes.set(o.id, this.baseSizes.get(`tpl:${o.category}`) ?? [...o.size] as [number, number, number]);
        this.root.add(node);
        this.nodes.set(o.id, node);
      }
      const base = this.baseSizes.get(o.id) ?? o.size;
      node.position.copy(planToThree(o.position[0], o.position[1], o.position[2]));
      node.rotation.set(0, THREE.MathUtils.degToRad(o.rotation), 0);
      // Blender: Breite x, Tiefe y, Höhe z -> three.js: x, Höhe y, Tiefe z
      node.scale.set(o.size[0] / base[0], o.size[2] / base[2], o.size[1] / base[1]);
      this.setColor(o.id, o.color);
    }
    data.walls.forEach((w) => {
      this.setColor(w.id, w.color);
      w.panels.forEach((p) => this.setColor(p.id, p.color));
    });
    this.setColor('floor', data.floor.color);
    this.setColor('ceiling', data.ceiling.color);
    this.selectionBox?.update();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ Schleife

  private tick(): void {
    this.controls.update();
    this.updateWallVisibility();
    this.renderer.render(this.scene, this.camera);
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
    this.camera.aspect = w / h;
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

/**
 * Lädt ein Modell als .glb. Eingebettetes glTF (JSON mit data:-Puffern) wird im Speicher in ein
 * GLB umgebaut, weil manche Hosts (z. B. Artifacts) fetch() auf data:-Adressen per CSP sperren.
 */
async function fetchModel(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Modell konnte nicht geladen werden (${res.status})`);
  const buf = await res.arrayBuffer();
  if (new Uint8Array(buf, 0, 1)[0] !== 0x7b) return buf; // kein JSON -> schon GLB
  const json = JSON.parse(new TextDecoder().decode(buf));
  let bin = new Uint8Array(0);
  const uri: string | undefined = json.buffers?.[0]?.uri;
  if (uri?.startsWith('data:')) {
    const raw = atob(uri.slice(uri.indexOf(',') + 1));
    bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    delete json.buffers[0].uri;
  }
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jp = pad(jsonBytes.length);
  const bp = pad(bin.length);
  const total = 12 + 8 + jsonBytes.length + jp + (bin.length ? 8 + bin.length + bp : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jp, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jp);
  if (bin.length) {
    const o = 20 + jsonBytes.length + jp;
    dv.setUint32(o, bin.length + bp, true);
    dv.setUint32(o + 4, 0x004e4942, true); // BIN
    out.set(bin, o + 8);
  }
  return out.buffer;
}

function cloneMat(m: THREE.Material, tplKey: string, id: string): THREE.Material {
  const c = m.clone();
  if (m.name === tplKey) c.name = `${id}_main`;
  return c;
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
