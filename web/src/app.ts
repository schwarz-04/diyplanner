import { Api } from './api';
import { analysisToScene, apartmentToHome, isApartment, prepareApartment, prepareInput, type RoomAnalysis } from './analysis';
import { attachRoom, emptyRoom, moveRoom, replaceRoom, rotateRoom, toHome } from './home';
import { PlanView } from './plan';
import { PART_DEFAULTS, attach, collisions, composeObject, connected, freeSpot, isBauteil, cutTo, jointKey, materials, newBuild, splitAt, tip, withCasters, type Joint, type Materials } from './diy';
import { TOOL_ORDER, TOOL_SETS, findToolProducts, type Tool as DiyTool, type ToolContext, type ToolSet } from './tools';
import { Showcase } from './showcase';
import { Viewer, type Tool, type ViewMode } from './viewer';
import {
  clone, cm, findPanel, m, newObject, type NewObjectOptions, newPanel, roomArea, setWallLength, uid, wallIndex, wallLength,
} from './edits';
import type { Catalog, Category, DiyBuild, Home, Panel, Product, Project, ProjectSummary, Scene, SceneObject, Selection, ShopProduct } from './types';

type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

/** Kleiner DOM-Helfer: h('button', {class: 'x', onclick}, 'Text') */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

const KIND_LABEL: Record<string, string> = {
  video: 'Video',
  photos: 'Fotos',
  floorplan: 'Grundriss',
};

export interface AppOptions {
  apiBase: string;
  /** WordPress-REST-Nonce (für angemeldete Nutzer). */
  nonce?: string;
  projectParam?: string;
  /** Vollbild im Plugin: Link zurück zur Webseite (z. B. Startseite) mit ihrem Namen. */
  backUrl?: string;
  backLabel?: string;
  /** Demo ohne Server: feste Szene, Änderungen an Möbeln und Farben laufen nur im Browser. */
  demo?: DemoData;
}

export interface DemoData {
  title: string;
  scene: Scene;
  catalog: Catalog;
  renderUrl?: string;
}

export class App {
  private api: Api;
  private viewer!: Viewer;
  private catalog!: Catalog;
  private project: Project | null = null;
  private home: Home | null = null;
  private active = 0;
  /** Der Raum der Wohnung, der gerade bearbeitet wird. */
  private get scene(): Scene | null {
    return this.home?.rooms[this.active]?.scene ?? null;
  }
  private selection: Selection = null;
  private undoStack: Home[] = [];
  private redoStack: Home[] = [];
  private saveTimer: number | undefined;
  private saveChain: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private analysisAvailable = false;
  private canCreate = true;
  private loginUrl = '';
  private proportional = false;
  private gizmoMode: 'translate' | 'rotate' = 'translate';
  private menu: MenuId | null = null;
  private tool: Tool = 'select';
  private showDims = true;
  private showcase: Showcase | null = null;
  /** DIY-Bereich: solange gesetzt, ist this.home die Werkbank und hier liegt die eigentliche Wohnung */
  private mainHome: Home | null = null;
  private diyId = '';
  private roomActive = 0;
  private elMode = h('div', { class: 'dm-modebar needs-project' });
  /** Leiste unten: ganze Wohnung oder einen Raum herausgreifen */
  private elRooms = h('div', { class: 'dm-roombar needs-project', hidden: true });
  private elBench = h('div', { class: 'dm-bench', hidden: true });
  private benchPanel: 'size' | 'cut' | 'color' | null = null;
  /** Verschrauben: dieses Teil wird an das nächste angeklickte Teil geschoben */
  private attachFrom: string | null = null;
  /** Farbverlauf unten im 3D-Hintergrund (Test) */
  private gradient = (() => { try { return localStorage.getItem('dm3d_gradient') !== '0'; } catch { return true; } })();
  private products: ShopProduct[] = [];
  /** Werkzeuge aus der Produktliste (Kategorie Werkzeug) */
  private toolProducts: ShopProduct[] = [];
  /** Verbindungen aus der Produkttabelle (Schrauben, Winkel, Scharniere …) */
  private connProducts: ShopProduct[] = [];
  /** Farben aus der Produkttabelle (Wandfarbe, Kreidefarbe, Lack …) */
  private paintProducts: ShopProduct[] = [];
  /** Gewählte Filter und Variante je Unterkategorie im Menü „Verbindungen“ */
  private connPick: Record<string, { kind?: string; length?: string; diameter?: string; id?: string }> = {};
  private amazonTag = '';
  private productQuery = '';
  private furnTab: FurnTab | null = null;
  private shopFilter: 'all' | Product['source'] = 'all';
  /** Bei ausgewähltem Möbel: Katalog statt Eigenschaften zeigen */
  private furnAdd = true;
  private favs = loadFavs();
  private plan!: PlanView;
  /** Breites Fenster: Seitenleiste links, Grundriss rechts. Schmal: Leiste unten, Grundriss als Karte. */
  private wide = false;
  private planOpen: boolean | null = null;
  /** Offene Liste rechts über dem Grundriss (breit) bzw. als Karte (schmal). */
  private sheet: SheetId | null = null;
  private theme: Theme = loadTheme();
  private user = { name: '', loginUrl: '', logoutUrl: '', profileUrl: '' };
  private version = '';

  // DOM
  private elStatus = h('span', { class: 'dm-status' });
  private elTitle = h('span', { class: 'dm-title' }, 'Raumplaner');
  private elDock = h('nav', { class: 'dm-dock' });
  private elPop = h('div', { class: 'dm-pop', hidden: true });
  private elCaption = h('div', { class: 'dm-caption', hidden: true });
  private elCanvas = h('div', { class: 'dm-canvas' });
  private elOverlay = h('div', { class: 'dm-overlay', hidden: true });
  private elToolbar = h('div', { class: 'dm-floating', hidden: true });
  private elPlan = h('div', { class: 'dm-plan' });
  private elSheet = h('div', { class: 'dm-sheet', hidden: true });
  private elPlanHead = h('div', { class: 'dm-plan-head' });
  private elPlanBody = h('div', { class: 'dm-plan-body' });
  private elVersion = h('div', { class: 'dm-version' });
  private btnUndo = h('button', { class: 'dm-round', title: 'Rückgängig (Strg+Z)', onclick: () => this.undo() }, icon(ICON_UNDO));
  private btnRedo = h('button', { class: 'dm-round', title: 'Wiederholen (Strg+Y)', onclick: () => this.redo() }, icon(ICON_REDO));

  constructor(private root: HTMLElement, private opts: AppOptions) {
    this.api = new Api(opts.apiBase, opts.nonce);
  }

  async start(): Promise<void> {
    this.root.classList.add('dm-app');
    this.root.append(
      h('header', { class: 'dm-top' },
        h('div', { class: 'dm-brand' },
          this.opts.backUrl ? h('a', { class: 'dm-backlink', href: this.opts.backUrl, title: 'Zurück zur Webseite' }, '← ' + (this.opts.backLabel || 'Webseite')) : null,
          h('button', { class: 'dm-title-btn needs-project', title: 'Projekt umbenennen', onclick: () => this.showSave() }, this.elTitle)),
        h('div', { class: 'dm-actions' },
          this.btnUndo, this.btnRedo,
          h('span', { class: 'dm-sep needs-project' }),
          this.sheetBtn('save', ICON_SAVE, 'Speichern', 'Projekt mit Namen speichern'),
          this.sheetBtn('favs', ICON_HEART, 'Merkliste', 'Gemerkte Produkte'),
          this.sheetBtn('shop', ICON_CART, 'Einkaufsliste', 'Alle Produkte im Projekt'),
          this.sheetBtn('render', ICON_CAMERA, 'Foto-Rendering', 'Fotorealistisches Bild'),
          this.elStatus,
        ),
      ),
      h('div', { class: 'dm-main' },
        h('aside', { class: 'dm-side' }, this.elDock, this.elPop),
        h('div', { class: 'dm-stage' }, this.elCanvas, this.elMode, this.elRooms, this.elToolbar, this.elBench, this.elVersion,
          h('div', { class: 'dm-zoom needs-project' },
            h('button', { class: 'dm-round', title: 'Hineinzoomen', onclick: () => this.viewer.zoom(0.8) }, '+'),
            h('button', { class: 'dm-round', title: 'Herauszoomen', onclick: () => this.viewer.zoom(1.25) }, '−'),
            h('button', { class: 'dm-round', title: 'Ganzen Raum zeigen', onclick: () => this.viewer.frame(false) }, icon(ICON_FIT)))),
        h('aside', { class: 'dm-right' }, this.elSheet, this.elPlan)),
      this.elOverlay,
      this.elCaption,
    );
    this.btnUndo.classList.add('needs-project');
    this.btnRedo.classList.add('needs-project');
    this.elPlan.append(this.elPlanHead, this.elPlanBody,
      h('p', { class: 'dm-plan-hint' }, 'Möbel ziehen = verschieben · Maß anklicken = ändern'));
    this.plan = new PlanView(this.elPlanBody, {
      onSelectObject: (id) => this.viewer.setSelection(id ? { kind: 'object', id } : null, true),
      onObjectMoving: (id, x, y) => {
        const o = this.scene?.objects.find((v) => v.id === id);
        if (o) this.viewer.moveNode(id, [x, y, o.position[2]]);
      },
      onObjectMoved: (id, x, y) => {
        const o = this.scene?.objects.find((v) => v.id === id);
        if (o) this.objectMoved(id, [x, y, o.position[2]], o.rotation);
      },
      onRoomPick: (i) => this.switchRoom(i),
      onRoomMoved: (i, pos) => { if (this.home) this.applyHome(moveRoom(this.home, i, pos), true); },
      onEditWall: (i, meters) => this.editWall(i, meters),
    });
    this.viewer = new Viewer(this.elCanvas, {
      onSelect: (sel) => this.select(sel),
      onObjectMoving: (id, pos, rot) => this.plan.updateObject(id, pos[0], pos[1], rot),
      onWalk: (x, y, yaw) => this.plan.setViewer(x, y, yaw),
      onObjectMoved: (id, pos, rot) => this.objectMoved(id, pos, rot),
      onGroupMoved: (moves) => this.groupMoved(moves),
      onMeasured: () => this.renderMenu(),
      onRoomPick: (i) => this.switchRoom(i),
    });
    this.viewer.measure.onEditWall = (i, meters) => this.editWall(i, meters);
    this.viewer.measure.onEditHeight = (meters) => { this.rebuildWith((n) => (n.room.height = meters)); };
    this.viewer.measure.onEditGap = (dx, dy, delta) => {
      const sel = this.selection;
      const o = sel?.kind === 'object' ? this.scene?.objects.find((v) => v.id === sel.id) : undefined;
      if (!o) return;
      const pos: [number, number, number] = [o.position[0] + dx * delta, o.position[1] + dy * delta, o.position[2]];
      this.viewer.moveNode(o.id, pos);
      this.objectMoved(o.id, pos, o.rotation);
    };
    this.viewer.measure.onEditSize = (axis, meters) => this.benchEdit((x) => { x.size[axis] = Math.round(meters * 10000) / 10000; });
    this.viewer.measure.onEditElevation = (meters) => {
      const sel = this.selection;
      const o = sel?.kind === 'object' ? this.scene?.objects.find((v) => v.id === sel.id) : undefined;
      if (!o) return;
      const pos: [number, number, number] = [o.position[0], o.position[1], meters];
      this.viewer.moveNode(o.id, pos);
      this.objectMoved(o.id, pos, o.rotation);
    };
    this.applyTheme();
    this.renderDock();
    const layout = () => {
      const wide = this.root.clientWidth >= 1000;
      if (wide !== this.wide || this.planOpen === null) {
        this.wide = wide;
        this.root.classList.toggle('dm-wide', wide);
        if (this.planOpen === null) this.planOpen = wide;
        this.renderMenu();
      }
      this.updateShift();
    };
    new ResizeObserver(layout).observe(this.root);
    layout();
    window.addEventListener('keydown', (e) => this.onKey(e));

    if (this.opts.demo) {
      await this.startDemo(this.opts.demo);
      return;
    }

    try {
      const [catalog, health] = await Promise.all([this.api.catalog(), this.api.health()]);
      this.catalog = { ...catalog, categories: { ...PART_DEFAULTS, ...catalog.categories } };
      this.analysisAvailable = health.analysis_available;
      this.canCreate = health.can_create ?? true;
      this.loginUrl = health.login_url ?? '';
      this.version = health.version ?? '';
      this.user = { name: health.user ?? '', loginUrl: health.login_url ?? '', logoutUrl: health.logout_url ?? '', profileUrl: health.profile_url ?? '' };
      this.elVersion.textContent = this.version ? `Raumplaner v${this.version}` : '';
      // Produktliste ist optional (ältere Plugin-Versionen haben sie nicht)
      this.api.products().then((r) => {
        const all = r.products ?? [];
        this.products = all.filter((p) => p.group !== 'werkzeug' && p.group !== 'verbindung' && p.group !== 'farbe');
        this.paintProducts = all.filter((p) => p.group === 'farbe');
        this.toolProducts = all.filter((p) => p.group === 'werkzeug');
        this.connProducts = all.filter((p) => p.group === 'verbindung');
        this.amazonTag = r.amazon_tag ?? '';
        this.renderMenu();
      }).catch(() => undefined);
    } catch (err) {
      this.showError(`Server nicht erreichbar: ${(err as Error).message}`);
      return;
    }

    const pid = new URLSearchParams(location.search).get(this.opts.projectParam ?? 'projekt');
    if (pid) await this.openProject(pid);
    else this.showStart();
    this.updateButtons();
  }

  private async startDemo(d: DemoData): Promise<void> {
    this.catalog = d.catalog;
    this.elTitle.textContent = d.title;
    try {
      this.home = toHome(d.scene);
      this.active = 0;
      this.viewer.setHome(this.home, 0, false);
      this.hideOverlay();
      this.select(null);
      this.setStatus('Demo: Änderungen bleiben im Browser');
      this.updateButtons();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private demoNotice(text: string, title = 'Noch nicht verfügbar'): void {
    this.showOverlay(h('div', { class: 'dm-card' },
      h('h2', {}, title),
      h('p', {}, text),
      h('div', { class: 'dm-row end' },
        h('button', { class: 'dm-btn primary', onclick: () => this.hideOverlay() }, 'Zurück zum Raum'))));
  }

  // ================================================================== Projekt anlegen / laden

  private showStart(): void {
    if (this.opts.demo) {
      this.demoNotice('Für eine neue Wohnung aus einem Grundriss braucht es den Server mit der KI-Analyse. Diese Demo zeigt eine fertig eingerichtete Wohnung.');
      return;
    }
    const err = h('p', { class: 'dm-error', hidden: true });
    const fail = (text: string) => { err.textContent = text; err.hidden = false; };
    const blocked = !this.canCreate || !this.analysisAvailable;

    // Hauptweg: Grundriss der Wohnung, Fotos und Videos nur ergänzend
    const planInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, class: 'dm-file' }) as HTMLInputElement;
    const extraInput = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'dm-file' }) as HTMLInputElement;
    const hint = h('textarea', {
      class: 'dm-input', rows: 2,
      placeholder: 'Optional: Hinweise, z. B. "Deckenhöhe 2,50 m, Altbau, Bad hat eine Dusche"',
    }) as HTMLTextAreaElement;
    const go = h('button', {
      class: 'dm-btn primary', disabled: blocked,
      onclick: async () => {
        const plan = Array.from(planInput.files ?? []);
        if (!plan.length) return fail('Bitte zuerst den Grundriss auswählen.');
        await this.create('apartment', plan, hint.value, Array.from(extraInput.files ?? []));
      },
    }, 'Wohnung erstellen');

    // Ohne Grundriss: einzelner Raum aus Video oder Fotos (Maße geschätzt)
    let kind = 'video';
    const roomInput = h('input', { type: 'file', multiple: true, accept: 'video/*', class: 'dm-file' }) as HTMLInputElement;
    const accept: Record<string, string> = { video: 'video/*', photos: 'image/*' };
    const help: Record<string, string> = {
      video: 'Langsam einmal rundherum filmen, Kamera auf Brusthöhe, 20–60 Sekunden.',
      photos: '4–12 Fotos aus verschiedenen Ecken, möglichst viel Wand und Boden im Bild.',
    };
    const helpEl = h('p', { class: 'dm-muted small' }, help.video);
    const tabs = Object.keys(KIND_LABEL).filter((k) => k !== 'floorplan').map((k) =>
      h('button', {
        class: `dm-tab${k === kind ? ' active' : ''}`,
        onclick: (e: Event) => {
          kind = k;
          roomInput.accept = accept[k];
          helpEl.textContent = help[k];
          tabs.forEach((t) => t.classList.toggle('active', t === e.currentTarget));
        },
      }, KIND_LABEL[k]));
    const goRoom = h('button', {
      class: 'dm-btn small', disabled: blocked,
      onclick: async () => {
        const files = Array.from(roomInput.files ?? []);
        if (!files.length) return fail('Bitte zuerst ein Video oder Fotos auswählen.');
        await this.create(kind, files, hint.value);
      },
    }, 'Einzelnen Raum erstellen');

    if (!this.scene) this.startShowcase();
    this.showOverlay(
      h('div', { class: 'dm-card' },
        h('h2', {}, 'Deine Wohnung planen'),
        h('p', {}, 'Lade den Grundriss deiner Wohnung hoch. Die KI baut daraus alle Räume maßstabsgetreu in 3D nach. Danach richtest du die ganze Wohnung ein oder nimmst dir einzelne Räume vor.'),
        h('div', { class: 'dm-upstep' },
          h('strong', {}, '1. Grundriss'),
          h('span', { class: 'dm-muted small' }, 'Bild oder PDF, am besten mit Maßen. Die Maße kommen aus dem Plan.'),
          planInput),
        h('div', { class: 'dm-upstep' },
          h('strong', {}, '2. Fotos oder Videos ', h('span', { class: 'dm-muted small' }, '(optional)')),
          h('span', { class: 'dm-muted small' }, 'Damit übernimmt die KI deine Möbel, Wandfarben und Böden. Für die Maße zählt der Grundriss.'),
          extraInput),
        hint,
        !this.analysisAvailable && h('p', { class: 'dm-note' }, 'Hinweis: Die KI-Analyse ist noch nicht eingerichtet (API-Key fehlt in den Plugin-Einstellungen). Du kannst aber schon die Demo-Wohnung bearbeiten.'),
        !this.canCreate && h('p', { class: 'dm-note' }, 'Bitte melde dich an, um eine Wohnung zu erstellen. ',
          this.loginUrl && h('a', { href: this.loginUrl }, 'Zur Anmeldung')),
        err,
        h('div', { class: 'dm-row end' },
          this.scene && h('button', { class: 'dm-btn ghost', onclick: () => this.hideOverlay() }, 'Abbrechen'),
          !this.scene && h('button', { class: 'dm-btn ghost', onclick: () => this.showProjects() }, 'Meine Projekte'),
          h('button', { class: 'dm-btn', disabled: !this.canCreate, onclick: () => this.create('demo', [], '') }, 'Demo-Wohnung öffnen'),
          go,
        ),
        h('details', { class: 'dm-details dm-noplan' },
          h('summary', {}, 'Kein Grundriss zur Hand? Einzelnen Raum aus Video oder Fotos'),
          h('div', { class: 'dm-tabs' }, tabs),
          helpEl,
          roomInput,
          h('p', { class: 'dm-muted small' }, 'Die Maße werden dabei geschätzt. Weitere Räume baust du später unter „Raum“ an.'),
          h('div', { class: 'dm-row end' }, goRoom)),
      ),
    );
  }

  /** Hintergrund der Startseite: Beispielraum richtet sich selbst ein. */
  private async startShowcase(): Promise<void> {
    if (this.showcase) return;
    try {
      const demo = await this.api.demoScene();
      if (this.scene || this.showcase) return;
      this.showcase = new Showcase(this.viewer, demo, (text) => {
        this.elCaption.textContent = text;
        this.elCaption.hidden = !text;
      });
      this.elOverlay.classList.add('dm-showcase');
      this.viewer.zoomOut = this.elCanvas.clientWidth <= 760 ? 1.35 : 1;
      this.showcase.start();
      this.applyTheme();
      requestAnimationFrame(() => this.updateShift());
    } catch {
      /* ohne Beispielraum bleibt der Hintergrund schlicht */
    }
  }

  private stopShowcase(): void {
    this.showcase?.stop();
    this.showcase = null;
    this.viewer.zoomOut = 1;
    this.elOverlay.classList.remove('dm-showcase');
    this.updateShift();
    this.applyTheme();
  }

  /** Raum in den freien Teil des Bildes schieben (neben die Startkarte bzw. über das offene Menü). */
  private updateShift(): void {
    if (!this.viewer) return;
    const stage = this.elCanvas.getBoundingClientRect();
    let sx = 0, sy = 0;
    const card = this.showcase && !this.elOverlay.hidden ? this.elOverlay.querySelector('.dm-card') : null;
    if (card) {
      const r = card.getBoundingClientRect();
      if (stage.width > 760) sx = Math.max(0, (r.right - stage.left) / 2);
      else sy = Math.max(0, (stage.bottom - r.top) / 2);
    }
    // Offene Menüs verschieben das Bild bewusst nicht, damit die Perspektive ruhig bleibt.
    this.viewer.setViewShift(sx, sy);
    this.elCaption.style.left = `calc(50% + ${sx}px)`;
  }

  private async create(kind: string, files: File[], hint: string, extra: File[] = []): Promise<void> {
    try {
      if (kind === 'demo') {
        this.showProgress('Demo-Wohnung wird geladen');
        const { id } = await this.api.createProject('demo', null, '');
        await this.openProject(id);
        return;
      }
      this.showProgress('Dateien werden vorbereitet');
      const input = kind === 'apartment'
        ? await prepareApartment(files, extra, (t) => this.showProgress(t))
        : await prepareInput(files, (t) => this.showProgress(t));
      this.showProgress('Bilder werden hochgeladen');
      const { id } = await this.api.createProject(kind, input, hint);
      // Die Analyse läuft im Hintergrund; openProject fragt den Stand ab, falls die
      // Verbindung vorher abbricht (z. B. Zeitlimit beim Webhoster).
      this.api.analyze(id).catch(() => undefined);
      await this.openProject(id);
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  /** Wartet auf die KI-Analyse und liefert das Projekt mit fertiger Szene. */
  private async waitForProject(id: string): Promise<Project & { scene: Scene | Home }> {
    let p = await this.api.project(id);
    const started = Date.now();
    while (p.state === 'queued' || p.state === 'analyzing') {
      const secs = Math.round((Date.now() - started) / 1000);
      this.showProgress(`${p.step || 'Verarbeitung läuft'} (${secs} s, ${p.kind === 'apartment' ? 'bei einer ganzen Wohnung meist zwei bis vier Minuten' : 'meist etwa eine Minute'})`);
      await sleep(2000);
      p = await this.api.project(id);
    }
    if (p.state === 'error') throw new Error(p.error || 'Die Szene konnte nicht erstellt werden.');
    if (!p.scene && p.analysis) {
      // Erste Öffnung nach der Analyse: KI-Antwort in eine Szene umwandeln und speichern.
      const apt = isApartment(p.analysis) ? p.analysis : null;
      p.scene = apt ? apartmentToHome(apt, this.catalog) : analysisToScene(p.analysis as RoomAnalysis, p.kind ?? 'video', this.catalog);
      p = await this.api.saveScene(id, p.scene);
      if (apt?.apartment_name) p = { ...p, ...(await this.api.saveMeta(id, { name: apt.apartment_name }).catch(() => ({}))) };
    }
    if (!p.scene) throw new Error('Die Szene konnte nicht erstellt werden.');
    return p as Project & { scene: Scene | Home };
  }

  private async openProject(id: string): Promise<void> {
    this.showProgress('Projekt wird geladen');
    try {
      const p = await this.waitForProject(id);
      this.project = p;
      this.home = toHome(p.scene);
      this.mainHome = null;
      this.diyId = '';
      this.root.classList.remove('dm-diy');
      this.active = 0;
      this.undoStack = [];
      this.redoStack = [];
      this.stopShowcase();
      this.viewer.setRoomFocus(false);
      const url = new URL(location.href);
      url.searchParams.set(this.opts.projectParam ?? 'projekt', id);
      history.replaceState(null, '', url);
      rememberLocal(id);
      this.viewer.setHome(this.home, 0, false);
      this.hideOverlay();
      this.select(null);
      this.setStatus('Gespeichert');
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  // ================================================================== Speichern und Projekte

  /** Kleines Vorschaubild der aktuellen Ansicht (JPEG). */
  private thumbnail(): string {
    try {
      this.viewer.screenshot(); // frisches Bild ohne Auswahl rendern
      const c = document.createElement('canvas');
      const el = this.viewer.renderer.domElement;
      const w = 480, hh = Math.round((480 * el.height) / Math.max(1, el.width));
      c.width = w;
      c.height = Math.min(hh, 360);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(el, 0, (c.height - hh) / 2, w, hh);
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return '';
    }
  }

  private showSave(): void {
    this.sheet = 'save';
    this.renderSheet();
  }

  private saveSheet(): SheetContent | null {
    if (this.opts.demo) {
      return { title: 'Projekt speichern', body: [h('p', { class: 'dm-muted' }, 'Auf der Webseite werden Projekte gespeichert und lassen sich über Home wieder öffnen. In dieser Demo bleiben Änderungen nur im Browser.')] };
    }
    if (!this.project || !this.scene) return null;
    const name = h('input', { class: 'dm-input', value: this.project.name || this.scene.room.name || '', placeholder: 'z. B. Wohnzimmer Herbst' }) as HTMLInputElement;
    const save = async (asCopy: boolean) => {
      const n = name.value.trim() || this.scene!.room.name || 'Mein Projekt';
      this.closeSheet();
      const sel = this.selection;
      this.viewer.setSelection(null, false);
      const thumb = this.thumbnail();
      if (sel) this.viewer.setSelection(sel, false);
      try {
        await this.persist();
        if (asCopy) {
          const { id } = await this.api.copyProject(this.project!.id, n);
          await this.api.saveMeta(id, { name: n, thumb });
          rememberLocal(id);
          await this.openProject(id);
          this.toast(`Als „${n}“ gespeichert`);
        } else {
          this.project = await this.api.saveMeta(this.project!.id, { name: n, thumb });
          rememberLocal(this.project.id);
          this.renderMenu();
          this.toast('Gespeichert. Über Home öffnest du es wieder.');
        }
        this.setStatus('Gespeichert');
      } catch (e) {
        this.toast((e as Error).message);
      }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(false); });
    setTimeout(() => { name.focus(); name.select(); }, 0);
    return {
      title: 'Projekt speichern',
      body: [
        h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Änderungen werden laufend gesichert. Mit Namen findest du das Projekt über Home wieder.'),
        field('Name', name),
      ],
      actions: [
        h('button', { class: 'dm-btn primary', onclick: () => save(false) }, 'Speichern'),
        h('button', { class: 'dm-btn', disabled: !this.canCreate, title: 'Neues Projekt, das bisherige bleibt unverändert', onclick: () => save(true) }, 'Als Kopie'),
      ],
    };
  }

  private async showProjects(): Promise<void> {
    if (this.opts.demo) {
      this.demoNotice('Auf der Webseite findest du hier alle gespeicherten Projekte und öffnest sie wieder.');
      return;
    }
    const back = () => (this.scene ? this.hideOverlay() : this.showStart());
    this.showProgress('Projekte werden geladen');
    let list: ProjectSummary[] = [];
    try {
      list = (await this.api.myProjects(localProjects())).projects;
    } catch (e) {
      this.showError((e as Error).message);
      return;
    }
    const current = this.project?.id;
    const date = (t: number) => (t ? new Date(t * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    const card = (p: ProjectSummary) => h('div', { class: `dm-project${p.id === current ? ' current' : ''}` },
      h('button', { class: 'dm-project-thumb', title: 'Öffnen', onclick: () => (p.id === current ? this.hideOverlay() : this.openProject(p.id)) },
        p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('span', {}, '◆')),
      h('div', { class: 'dm-project-text' },
        h('strong', {}, p.name),
        h('span', { class: 'dm-muted small' }, [p.rooms > 1 ? `${p.rooms} Räume` : p.room_names[0] || '1 Raum', date(p.updated), p.id === current ? 'geöffnet' : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'dm-project-actions' },
        h('button', { class: 'dm-btn small primary', onclick: () => (p.id === current ? this.hideOverlay() : this.openProject(p.id)) }, 'Öffnen'),
        h('button', { class: 'dm-btn small ghost', onclick: () => this.renameProject(p) }, 'Umbenennen'),
        h('button', { class: 'dm-btn small ghost', disabled: !this.canCreate, onclick: () => this.copyProject(p) }, 'Kopie'),
        h('button', { class: 'dm-btn small ghost danger', title: 'Löschen', onclick: () => this.deleteProject(p) }, icon(TRASH))));
    this.showOverlay(h('div', { class: 'dm-card wide' },
      h('div', { class: 'dm-row', style: 'justify-content:space-between;align-items:center' },
        h('h2', { style: 'margin:0' }, 'Meine Projekte'),
        h('button', { class: 'dm-btn primary', onclick: () => this.showStart() }, '+ Neues Projekt')),
      list.length
        ? h('div', { class: 'dm-projects' }, list.map(card))
        : h('p', { class: 'dm-muted' }, 'Noch keine gespeicherten Projekte. Erstelle eine Wohnung aus deinem Grundriss oder öffne die Demo-Wohnung, sie wird automatisch gesichert.'),
      h('p', { class: 'dm-muted small' }, 'Ohne Anmeldung merkt sich nur dieser Browser deine Projekte. Angemeldet findest du sie auf jedem Gerät.'),
      h('div', { class: 'dm-row end' }, h('button', { class: 'dm-btn ghost', onclick: back }, this.scene ? 'Zurück zum Raum' : 'Zurück'))));
  }

  private renameProject(p: ProjectSummary): void {
    const name = window.prompt('Neuer Name', p.name);
    if (name === null || !name.trim()) return;
    this.api.saveMeta(p.id, { name: name.trim() }).then((r) => {
      if (this.project?.id === p.id) { this.project = r; this.renderMenu(); }
      this.showProjects();
    }).catch((e) => this.toast((e as Error).message));
  }

  private async copyProject(p: ProjectSummary): Promise<void> {
    try {
      if (this.project?.id === p.id) await this.persist();
      const { id } = await this.api.copyProject(p.id, `${p.name} (Kopie)`);
      rememberLocal(id);
      this.showProjects();
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  private async deleteProject(p: ProjectSummary): Promise<void> {
    if (!window.confirm(`„${p.name}“ wirklich löschen? Das lässt sich nicht rückgängig machen.`)) return;
    try {
      await this.api.deleteProject(p.id);
      forgetLocal(p.id);
      if (this.project?.id === p.id) {
        this.project = null;
        this.home = null;
        const url = new URL(location.href);
        url.searchParams.delete(this.opts.projectParam ?? 'projekt');
        history.replaceState(null, '', url);
        location.reload();
        return;
      }
      this.showProjects();
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  // ================================================================== Änderungen

  /**
   * Übernimmt eine geänderte Szene.
   * rebuild = true: die 3D-Szene wird neu aufgebaut (neue Möbel, Maße, Paneele).
   * rebuild = false: der Editor hat die Änderung schon selbst angezeigt, es wird nur gespeichert.
   */
  private async apply(next: Scene, rebuild: boolean, together?: Set<string>): Promise<void> {
    if (!this.home) return;
    // Werkbank: Teile dürfen nicht ineinander ragen (verschraubte Teile untereinander schon, z. B. schräg gedreht)
    if (next.diy && this.scene?.diy) {
      const before = new Set(collisions(this.scene.objects).map(([a, b]) => `${a.id}|${b.id}`));
      const bad = collisions(next.objects).find(([a, b]) => !before.has(`${a.id}|${b.id}`) && !(together?.has(a.id) && together.has(b.id)));
      if (bad) {
        this.toast(`Geht nicht: „${bad[0].label || 'Teil'}“ würde in „${bad[1].label || 'Teil'}“ hineinragen.`);
        this.renderPanel();
        return;
      }
    }
    this.applyHome(replaceRoom(this.home, this.active, next), rebuild);
  }

  /** Änderung an der ganzen Wohnung (Raum anbauen oder entfernen, oder ein Raum geändert). */
  private applyHome(next: Home, rebuild: boolean): void {
    if (!this.home) return;
    this.undoStack.push(this.home);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.show(next, rebuild);
  }

  private show(next: Home, rebuild: boolean): void {
    this.home = next;
    this.active = Math.min(this.active, next.rooms.length - 1);
    if (rebuild) {
      this.viewer.setHome(next, this.active, true);
      this.renderPanel();
    } else {
      this.viewer.updateData(next.rooms[this.active].scene);
      this.renderPlan();
    }
    this.updateButtons();
    this.scheduleSave();
  }

  /** Anderen Raum der Wohnung bearbeiten. */
  private switchRoom(index: number): void {
    if (!this.home || index === this.active || !this.home.rooms[index]) return;
    if (this.tool === 'measure') this.setTool('select');
    this.active = index;
    this.selection = null;
    this.viewer.setHome(this.home, index, true);
    if (this.viewer.focused) this.viewer.frame(false);
    this.renderPanel();
    this.renderRoomBar();
    this.toast(`${this.scene!.room.name || `Raum ${index + 1}`} wird bearbeitet`);
  }

  private scheduleSave(): void {
    if (this.opts.demo) {
      this.setStatus('Demo: Änderungen bleiben im Browser');
      return;
    }
    this.setStatus('Änderungen …');
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(), 700);
  }

  private persist(): Promise<unknown> {
    window.clearTimeout(this.saveTimer);
    const snapshot = this.fullHome()!;
    const id = this.project!.id;
    this.saveChain = this.saveChain.then(async () => {
      this.setBusy(+1, 'Speichern …');
      try {
        this.project = await this.api.saveScene(id, snapshot);
        this.setStatus('Gespeichert');
      } catch (err) {
        this.setStatus('Fehler beim Speichern');
        this.toast((err as Error).message);
      } finally {
        this.setBusy(-1);
      }
    });
    return this.saveChain;
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev || !this.home) return;
    this.redoStack.push(this.home);
    this.show(prev, true);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next || !this.home) return;
    this.undoStack.push(this.home);
    this.show(next, true);
  }

  private objectMoved(id: string, pos: [number, number, number], rot: number): void {
    const next = clone(this.scene!);
    const o = next.objects.find((x) => x.id === id);
    if (!o) return;
    o.position = pos.map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
    o.rotation = rot;
    this.apply(next, false);
    this.renderPanel();
  }

  /** Werkbank: verschraubte Teile gemeinsam an die neue Stelle übernehmen. */
  private groupMoved(moves: { id: string; position: [number, number, number]; rotation: number }[]): void {
    const next = clone(this.scene!);
    for (const m of moves) {
      const o = next.objects.find((x) => x.id === m.id);
      if (!o) continue;
      o.position = m.position.map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
      o.rotation = m.rotation;
    }
    this.apply(next, false, new Set(moves.map((m) => m.id)));
    this.renderPanel();
  }

  private deleteObject(id: string): void {
    const next = clone(this.scene!);
    next.objects = next.objects.filter((o) => o.id !== id);
    this.viewer.removeNode(id);
    this.apply(next, false);
  }

  private emptyRoom(): void {
    if (!this.scene?.objects.length) return;
    const next = clone(this.scene);
    for (const o of next.objects) this.viewer.removeNode(o.id);
    next.objects = [];
    this.apply(next, false);
    this.toast('Raum geleert. Mit ↶ holst du die Möbel zurück.');
    this.renderPanel();
  }

  private recolor(key: string, color: string, mutate: (s: Scene) => void): void {
    const next = clone(this.scene!);
    mutate(next);
    this.viewer.setColor(key, color);
    this.apply(next, false);
  }

  private async addObject(category: Category, opt: NewObjectOptions = {}): Promise<string> {
    const next = clone(this.scene!);
    // Wandobjekte an die ausgewählte Wand hängen
    const sel = this.selection;
    const wall = sel?.kind === 'wall' ? wallIndex(next, sel.id) : sel?.kind === 'panel' ? findPanel(next, sel.id)?.wallIndex : undefined;
    const obj = newObject(next, this.catalog, category, { wall: wall ?? this.viewer.facingWall(), ...opt });
    // Werkbank: neue Teile auf das stellen, was schon in der Mitte steht (Rollen und Füße bleiben unten)
    if (next.diy) obj.position = freeSpot(next.objects, obj.size, obj.rotation);
    next.objects.push(obj);
    await this.apply(next, true);
    this.viewer.setSelection({ kind: 'object', id: obj.id }, true);
    return obj.id;
  }

  /** Neues Teil: Menü schließen, halbtransparent einsetzen, Nutzer verschiebt/dreht und bestätigt. */
  private async placeNew(category: Category, opt: NewObjectOptions = {}): Promise<void> {
    // Schmal: Menü schließen, damit der Raum frei ist. Breit bleibt die Seitenleiste stehen (kein Springen des Bildes).
    if (!this.wide) this.menu = null;
    this.furnAdd = true;
    this.renderMenu();
    const id = await this.addObject(category, opt);
    this.setGizmo('translate');
    this.viewer.startPlacing(id);
    this.renderFloating();
  }

  /** Eigenschaften des ausgewählten Möbels im Möbel-Menü zeigen (statt des Katalogs). */
  private editObject(): void {
    this.menu = 'furniture';
    this.furnAdd = false;
    this.renderMenu();
  }

  private confirmPlacing(): void {
    if (!this.viewer.placingId) return;
    this.viewer.stopPlacing();
    // Werkbank: das Teil bleibt ausgewählt, damit man es gleich bearbeiten kann
    if (this.inDiy) { this.renderFloating(); return; }
    this.viewer.setSelection(null, true);
    this.toast('Platziert');
  }

  private cancelPlacing(): void {
    const id = this.viewer.placingId;
    if (!id) return;
    this.viewer.stopPlacing();
    this.deleteObject(id);
    this.renderFloating();
  }

  private async duplicateObject(id: string): Promise<void> {
    const next = clone(this.scene!);
    const src = next.objects.find((o) => o.id === id);
    if (!src) return;
    const copy: SceneObject = { ...clone(src), id: uid('obj') };
    copy.position = next.diy ? freeSpot(next.objects, copy.size, copy.rotation) : [src.position[0] + 0.3, src.position[1] - 0.3, src.position[2]];
    next.objects.push(copy);
    await this.apply(next, true);
    this.viewer.setSelection({ kind: 'object', id: copy.id }, true);
  }

  private async rebuildWith(mutate: (s: Scene) => void): Promise<void> {
    const next = clone(this.scene!);
    mutate(next);
    await this.apply(next, true);
  }

  // ================================================================== Menü unten (Drop-up)

  private select(sel: Selection): void {
    const same = sel?.kind === 'object' && this.selection?.kind === 'object' && sel.id === this.selection.id;
    if (!same) this.furnAdd = true; // Möbel-Menü zeigt wieder den Katalog
    if (this.attachFrom && this.inDiy && sel?.kind === 'object' && sel.id !== this.attachFrom) {
      const from = this.attachFrom;
      this.attachFrom = null;
      this.selection = sel;
      this.attachParts(from, sel.id);
      return;
    }
    this.selection = sel;
    // Produkt gewählt: rechts die Einkaufsliste zeigen (außer beim Speichern oder Rendern)
    if (!same && sel?.kind === 'object' && this.wide && !this.inDiy && this.sheet !== 'save' && this.sheet !== 'render') {
      this.sheet = 'shop';
      this.renderSheet();
    }
    this.renderMenu();
    this.renderFloating();
  }

  // ------------------------------------------------------------------ Werkzeuge

  /** Welche Arbeit steht für die Auswahl an? */
  private toolContext(): ToolContext | null {
    const sel = this.selection;
    const s = this.scene;
    if (!sel || !s) return null;
    if (sel.kind === 'panel') return 'paneel';
    if (sel.kind === 'wall') return 'farbe';
    if (sel.kind !== 'object') return null;
    const o = s.objects.find((x) => x.id === sel.id);
    return o ? this.objectToolContext(o) : null;
  }

  private objectToolContext(o: SceneObject): ToolContext | null {
    const cat = this.catalog.categories[o.category];
    if (o.category === 'board' || o.category === 'batten') return 'makeover';
    if (cat?.group === 'bauteil') return 'moebel';
    if (o.category === 'shelf' || o.category === 'wall_shelf') return 'regal';
    if (cat?.mount === 'wall') return 'wand';
    if (cat?.group === 'deko' || ['rug', 'plant', 'lamp'].includes(o.category)) return null;
    return 'moebel';
  }

  /** Menü „Werkzeug“: alle Kategorien, die zur Auswahl oder zum Projekt passenden sind aufgeklappt. */
  private toolsMenu(): Child[] {
    const ctx = this.toolContext();
    const inProject = new Set(this.projectTools());
    const out: Child[] = [h('p', { class: 'dm-muted small', style: 'margin-top:0' }, ctx
      ? `Passend zur Auswahl: ${TOOL_SETS[ctx].title}`
      : 'Wähle ein Möbel, Regal oder eine Wand, um die passenden Werkzeuge zu sehen.')];
    for (const c of TOOL_ORDER) {
      const set = TOOL_SETS[c];
      out.push(this.toolSetView(set, ctx ? c === ctx : inProject.has(set), c === ctx));
    }
    // Werkzeuge aus dem Shop, die keiner Kategorie zugeordnet sind
    const used = new Set(Object.values(TOOL_SETS).flatMap((t) => t.tools).flatMap((t) => findToolProducts(t, this.toolProducts)).map((p) => p.id));
    const rest = this.toolProducts.filter((p) => !used.has(p.id));
    if (rest.length) {
      out.push(h('details', { class: 'dm-toolset' }, h('summary', {}, `Sonstiges (${rest.length})`),
        h('div', { class: 'dm-favs-list' }, rest.map((p) => this.toolProductRow(p, '')))));
    }
    out.push(h('button', { class: 'dm-btn small', style: 'margin-top:10px', onclick: () => this.printShopList() }, icon(ICON_PDF), ' Einkaufsliste mit Werkzeug und Anleitung als PDF'));
    return out;
  }

  private toolSetView(set: ToolSet, open: boolean, current = false): HTMLElement {
    return h('details', { class: `dm-toolset${current ? ' current' : ''}`, open },
      h('summary', {}, set.title),
      h('div', { class: 'dm-favs-list' }, set.tools.flatMap((t) => this.toolRows(t))),
      h('details', { class: 'dm-guide' }, h('summary', {}, 'Anleitung'),
        h('ol', {}, set.guide.map((g) => h('li', {}, g)))));
  }

  /** Ein Werkzeug: alle passenden Shop-Produkte, sonst nur der Name. */
  private toolRows(t: DiyTool): HTMLElement[] {
    const list = findToolProducts(t, this.toolProducts);
    if (list.length) return list.map((p) => this.toolProductRow(p, t.name));
    if (t.match.some((m) => /blatt/.test(m))) return []; // reines Zubehör ohne Produkt weglassen
    return [h('div', { class: 'dm-favrow dm-toolrow' }, h('span', { class: 'dm-favlink' }, h('span', { class: 'dm-product-ph' }, '🔧'),
      h('span', { class: 'dm-product-text' }, h('strong', {}, t.name), t.note ? h('span', { class: 'dm-muted small' }, t.note) : '')))];
  }

  private toolProductRow(p: ShopProduct, label: string): HTMLElement {
    const key = `tool:${p.id}`;
    return h('div', { class: 'dm-favrow dm-toolrow' },
      h('a', { class: 'dm-favlink', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' }, productImage(p),
        h('span', { class: 'dm-product-text' }, h('strong', {}, p.name),
          h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.price != null ? euro(p.price) : '', label].filter(Boolean).join(' · ')))),
      h('button', { class: `dm-fav${this.favs.has(key) ? ' active' : ''}`, title: 'Merken', onclick: () => {
        this.toggleFav({ key, name: p.name, url: p.url, image: p.image, source: p.source, price: p.price }); this.renderMenu();
      } }, icon(ICON_HEART)));
  }

  /** Alle Arbeiten im ganzen Projekt. */
  private projectTools(): ToolSet[] {
    const ctxs = new Set<ToolContext>();
    for (const r of this.home?.rooms ?? []) {
      for (const o of r.scene.objects) { const c = this.objectToolContext(o); if (c) ctxs.add(c); }
      if (r.scene.walls.some((w) => w.panels?.length)) ctxs.add('paneel');
    }
    return [...ctxs].map((c) => TOOL_SETS[c]);
  }

  // ================================================================== DIY-Bereich

  private get inDiy(): boolean {
    return !!this.mainHome;
  }

  private get builds(): DiyBuild[] {
    return (this.mainHome ?? this.home)?.builds ?? [];
  }

  private get build(): DiyBuild | undefined {
    return this.fullHome()?.builds?.find((b) => b.id === this.diyId);
  }

  /** Ganze Wohnung samt Bauplänen, auch während die Werkbank offen ist. */
  private fullHome(): Home | null {
    const main = this.mainHome;
    if (!main || !this.home) return this.home;
    const scene = this.home.rooms[0].scene;
    const builds = (main.builds ?? []).map((b) => (b.id === this.diyId ? { ...b, name: scene.room.name || b.name, scene } : b));
    const current = builds.find((b) => b.id === this.diyId);
    // Schon im Raum stehende Exemplare dieses Möbels mitziehen
    const rooms = current ? main.rooms.map((r) => (r.scene.objects.some((o) => o.diyId === current.id)
      ? { ...r, scene: { ...r.scene, objects: r.scene.objects.map((o) => (o.diyId === current.id ? composeObject(current, o) ?? o : o)) } }
      : r)) : main.rooms;
    return { ...main, rooms, builds };
  }

  /** Werkbank öffnen: vorhandenen Bauplan (id), sonst den letzten oder einen neuen. */
  private enterDiy(id?: string): void {
    const main = this.fullHome();
    if (!main) return;
    if (!this.inDiy) this.roomActive = this.active;
    if (this.viewer.viewMode !== 'orbit') this.viewer.setMode('orbit'); // Werkbank nur in 3D
    let builds = main.builds ?? [];
    let build = id === 'new' ? undefined : builds.find((b) => b.id === id) ?? builds[builds.length - 1];
    if (!build) {
      build = newBuild(`DIY-Möbel ${builds.length + 1}`);
      builds = [...builds, build];
    }
    this.mainHome = { ...main, builds };
    this.diyId = build.id;
    this.home = { version: 2, rooms: [{ id: build.id, position: [0, 0], rotation: 0, scene: build.scene }] };
    this.active = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.root.classList.add('dm-diy');
    this.viewer.setHome(this.home, 0, false);
        this.menu = this.wide && !build.scene.objects.length ? 'parts' : null;
    this.furnAdd = true;
    this.sheet = null;
    this.renderSheet();
    this.renderPanel();
    this.updateButtons();
    this.scheduleSave();
  }

  private exitDiy(): void {
    const full = this.fullHome();
    if (!this.inDiy || !full) return;
    this.mainHome = null;
    this.diyId = '';
    this.home = full;
    this.active = Math.min(this.roomActive, full.rooms.length - 1);
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.root.classList.remove('dm-diy');
    this.viewer.setHome(full, this.active, false);
    if (this.menu === 'diy') this.menu = this.wide ? 'furniture' : null;
    this.renderSheet();
    this.renderPanel();
    this.updateButtons();
    this.scheduleSave();
  }

  private deleteBuild(id: string): void {
    const full = this.fullHome();
    if (!full || !confirm('Diesen Bauplan löschen? Bereits in Räume gestellte Exemplare bleiben stehen.')) return;
    const builds = (full.builds ?? []).filter((b) => b.id !== id);
    if (this.inDiy) {
      this.mainHome = { ...full, builds };
      if (id === this.diyId) {
        this.diyId = '';
        this.exitDiy();
        return;
      }
      this.scheduleSave();
      this.renderMenu();
    } else {
      this.applyHome({ ...full, builds }, false);
      this.renderMenu();
    }
  }

  /** DIY-Möbel als ein Stück in den Raum stellen. */
  private async placeBuild(id: string): Promise<void> {
    if (this.inDiy) this.exitDiy();
    const build = this.home?.builds?.find((b) => b.id === id);
    const obj = build && composeObject(build);
    if (!obj || !this.scene) { this.toast('Der Bauplan ist noch leer.'); return; }
    const next = clone(this.scene);
    const spot = newObject(next, this.catalog, 'box', { size: obj.size });
    obj.position = spot.position;
    next.objects.push(obj);
    if (!this.wide) this.menu = null;
    await this.apply(next, true);
    this.viewer.setSelection({ kind: 'object', id: obj.id }, true);
    this.setGizmo('translate');
    this.viewer.startPlacing(obj.id);
    this.renderFloating();
  }

  /** Baupläne, von denen ein Exemplar in einem Raum steht. */
  private placedBuilds(): DiyBuild[] {
    const used = new Set((this.home?.rooms ?? []).flatMap((r) => r.scene.objects.map((o) => o.diyId)).filter(Boolean));
    return this.builds.filter((b) => used.has(b.id));
  }

  private renderMode(): void {
    const btn = (diy: boolean, ic: string, label: string, short: string, title: string) => h('button', {
      class: `dm-modebtn${this.inDiy === diy ? ' active' : ''}`, title,
      onclick: () => { if (diy !== this.inDiy) (diy ? this.enterDiy() : this.exitDiy()); },
    }, icon(ic), h('span', { class: 'dm-long' }, label), h('span', { class: 'dm-short' }, short));
    this.elMode.replaceChildren(
      btn(false, ICON_PLAN, 'Raumplaner', 'Raum', 'Räume einrichten und Möbel stellen'),
      btn(true, ICON_TOOL, 'Virtuelle Werkbank', 'Werkbank', 'Eigene Möbel aus Möbeln, Platten und Rollen bauen'));
    this.renderRoomBar();
  }

  /** Ganze Wohnung im Blick, bei Bedarf einen Raum herausgreifen (die anderen werden ausgeblendet). */
  private renderRoomBar(): void {
    const rooms = this.home?.rooms ?? [];
    const show = !this.inDiy && rooms.length > 1 && this.viewer?.viewMode !== 'walk';
    this.elRooms.hidden = !show;
    if (!show) { this.elRooms.replaceChildren(); return; }
    const focus = this.viewer.focused;
    this.elRooms.replaceChildren(
      h('button', { class: `dm-roomchip all${focus ? '' : ' active'}`, title: 'Alle Räume zeigen', onclick: () => this.focusRoom(null) }, icon(ICON_PLAN), 'Ganze Wohnung'),
      h('span', { class: 'dm-sep' }),
      ...rooms.map((r, i) => h('button', {
        class: `dm-roomchip${focus && i === this.active ? ' active' : ''}${!focus && i === this.active ? ' current' : ''}`,
        title: focus && i === this.active ? 'Wird bearbeitet' : 'Diesen Raum herausgreifen',
        onclick: () => this.focusRoom(i),
      }, r.scene.room.name || `Raum ${i + 1}`)));
  }

  /** null: ganze Wohnung zeigen; sonst diesen Raum bearbeiten und allein zeigen. */
  private focusRoom(index: number | null): void {
    if (index === null) {
      this.viewer.setRoomFocus(false);
    } else {
      if (index !== this.active) this.switchRoom(index);
      this.viewer.setRoomFocus(true);
    }
    this.renderRoomBar();
  }

  // ------------------------------------------------------------------ Werkbank-Leiste

  private benchEdit(mutate: (o: SceneObject, s: Scene) => void): void {
    const sel = this.selection;
    if (sel?.kind !== 'object' || !this.scene) return;
    const next = clone(this.scene);
    const o = next.objects.find((x) => x.id === sel.id);
    if (!o) return;
    mutate(o, next);
    this.apply(next, true);
  }

  /** Verschrauben: a an b heranschieben, die Schrauben setzt das Programm an der Kontaktfläche. */
  private attachParts(fromId: string, toId: string): void {
    const next = clone(this.scene!);
    const a = next.objects.find((x) => x.id === fromId);
    const b = next.objects.find((x) => x.id === toId);
    if (!a || !b) return;
    const key = jointKey(a.id, b.id);
    const wasOff = next.diyOff?.includes(key);
    next.diyOff = (next.diyOff ?? []).filter((k) => k !== key);
    const moved = attach(a, b);
    if (!moved && !wasOff) { this.toast('Die beiden Teile liegen schon aneinander und sind verschraubt.'); return; }
    this.apply(next, true).then(() => {
      this.viewer.setSelection({ kind: 'object', id: fromId }, true);
      const n = materials(this.scene!, this.catalog).joints.filter((j) => jointKey(j.through.id, j.into.id) === key).reduce((sum, j) => sum + j.screws.length, 0);
      this.toast(n ? `Verschraubt mit ${n} Schrauben` : 'Aneinandergesetzt. Hier ist das Material zu dünn für Schrauben.');
    });
  }

  private renderBench(): void {
    const s = this.scene;
    const show = this.inDiy && !!s && !this.viewer?.placingId;
    this.elBench.hidden = !show;
    if (!show || !s) { this.elBench.replaceChildren(); return; }
    const sel = this.selection;
    const o = sel?.kind === 'object' ? s.objects.find((x) => x.id === sel.id) : undefined;
    if (!o || (this.benchPanel === 'cut' && !isBauteil(o.category))) this.benchPanel = null;
    if (this.benchPanel !== 'cut') this.viewer.previewCut(null);
    const tool = (ic: string, label: string, onclick: () => void, opt: { active?: boolean; disabled?: boolean; title?: string } = {}) => h('button', {
      class: `dm-benchbtn${opt.active ? ' active' : ''}`, disabled: !!opt.disabled, title: opt.title ?? label, onclick,
    }, icon(ic), h('span', {}, label));
    const panelBtn = (id: 'size' | 'cut' | 'color', ic: string, label: string, title: string) =>
      tool(ic, label, () => { this.benchPanel = this.benchPanel === id ? null : id; this.renderBench(); }, { active: this.benchPanel === id, disabled: !o, title });
    const none = !o;
    const bar = h('div', { class: 'dm-benchbar' },
      tool(BI.add, 'Teil', () => this.openMenu('parts'), { title: 'Holzplatte, Leiste, Rolle oder Fuß hinzufügen' }),
      h('span', { class: 'dm-sep' }),
      panelBtn('size', BI.size, 'Maße', 'Breite, Tiefe, Höhe und Lage einstellen'),
      tool(BI.cut, 'Zuschneiden', () => { this.benchPanel = this.benchPanel === 'cut' ? null : 'cut'; this.renderBench(); },
        { active: this.benchPanel === 'cut', disabled: !o || !isBauteil(o.category) || o.category === 'caster' || o.category === 'foot', title: o && !isBauteil(o.category) ? 'Fertige Möbel lassen sich nicht zuschneiden' : 'Kürzen oder in zwei Stücke sägen' }),
      tool(BI.tip, 'Kippen', () => this.benchEdit((x) => tip(x)), { disabled: none || !!o?.product?.url, title: 'Liegend, stehend, hochkant' }),
      tool(ICON_ROTATE, 'Drehen', () => o && this.rotateBy(o.id, 90), { disabled: none, title: 'Um 90° drehen' }),
      panelBtn('color', BI.color, 'Farbe', 'Farbe oder Holzton ändern'),
      tool(BI.screw, 'Verschrauben', () => {
        this.attachFrom = this.attachFrom ? null : o?.id ?? null;
        if (this.attachFrom) this.toast('Jetzt das Teil anklicken, an das es geschraubt werden soll.');
        this.renderBench();
      }, { disabled: none, active: !!this.attachFrom, title: 'An ein anderes Teil setzen und verschrauben' }),
      tool(BI.copy, 'Kopie', () => o && this.duplicateObject(o.id), { disabled: none }),
      tool(TRASH, 'Löschen', () => o && this.deleteObject(o.id), { disabled: none }),
      h('span', { class: 'dm-sep' }),
      tool(BI.caster, 'Rollen', () => this.apply(withCasters(s, this.catalog.categories.caster.label), true), { disabled: !s.objects.length, title: 'Vier Möbelrollen unter die Ecken setzen' }),
      tool(BI.plan, 'Bauplan', () => this.openMenu('diy'), { title: 'Materialliste, Schrauben und Bohrplan' }));
    const out: Node[] = [];
    if (this.attachFrom) {
      out.push(h('div', { class: 'dm-benchpanel hint' }, `„${s.objects.find((x) => x.id === this.attachFrom)?.label ?? 'Teil'}“ verschrauben: Klicke das zweite Teil an.`,
        h('button', { class: 'dm-btn small ghost', onclick: () => { this.attachFrom = null; this.renderBench(); } }, 'Abbrechen')));
    } else if (o && this.benchPanel) {
      out.push(this.benchPanelView(o));
    } else if (o) {
      const c = (v: number) => String(cm(v)).replace('.', ',');
      const linked = connected(s.objects, s.diyOff, o.id).length - 1;
      out.push(h('div', { class: 'dm-benchpanel info' }, h('strong', {}, o.label || 'Teil'), ` · ${c(o.size[0])} × ${c(o.size[1])} × ${c(o.size[2])} cm`,
        linked ? h('span', { class: 'dm-muted small' }, ` · fest verschraubt mit ${linked} ${linked === 1 ? 'Teil' : 'Teilen'}, bewegt sich gemeinsam (Lösen im Bauplan)`) : ''));
    } else if (!s.objects.length) {
      out.push(h('div', { class: 'dm-benchpanel info' }, 'Leere Werkbank. Mit „Teil“ fügst du Möbel, Holzplatten, Leisten oder Rollen hinzu.'));
    }
    out.push(bar);
    this.elBench.replaceChildren(...out);
  }

  private benchPanelView(o: SceneObject): HTMLElement {
    const c = (v: number) => cm(v);
    if (this.benchPanel === 'size') {
      const size = (axis: 0 | 1 | 2) => numberInput(c(o.size[axis]), 0.1, 1000, (v) => this.benchEdit((x) => { x.size[axis] = m(v); }), 'cm');
      return h('div', { class: 'dm-benchpanel' },
        field('Breite', size(0)), field('Tiefe', size(1)), field('Höhe', size(2)),
        field('Über Boden', numberInput(c(o.position[2]), 0, 400, (v) => this.benchEdit((x) => { x.position[2] = m(v); }), 'cm')),
        field('Drehung', numberInput(Math.round(o.rotation), -360, 720, (v) => this.benchEdit((x) => { x.rotation = ((v % 360) + 360) % 360; }), '°')));
    }
    if (this.benchPanel === 'cut') {
      // Maße nach Größe benennen: längste Seite = Länge, dann Breite, dann Stärke
      const order = ([0, 1, 2] as const).slice().sort((a, b) => o.size[b] - o.size[a]);
      const names: Record<number, string> = { [order[0]]: 'Länge', [order[1]]: 'Breite', [order[2]]: 'Stärke' };
      const fmt = (v: number) => String(Math.round(v * 1000) / 10).replace('.', ',');
      const axisSel = h('select', { class: 'dm-input' }, order.map((a) =>
        h('option', { value: String(a) }, `${names[a]} (${fmt(o.size[a])} cm)`))) as HTMLSelectElement;
      const amount = h('input', { class: 'dm-input', type: 'number', step: 0.1, min: 0.1, placeholder: 'z. B. 20' }) as HTMLInputElement;
      const result = h('span', { class: 'dm-cutinfo dm-muted small' }, 'Gib ein, wie viel abgesägt werden soll.');
      const confirmBtn = h('button', { class: 'dm-btn small primary', disabled: true, title: 'Abgesägtes Stück fällt weg' }, 'Kürzen') as HTMLButtonElement;
      const splitBtn = h('button', { class: 'dm-btn small', disabled: true, title: 'Beide Stücke bleiben auf der Werkbank' }, 'In zwei Teile sägen') as HTMLButtonElement;
      const read = (): { axis: 0 | 1 | 2; keep: number } | null => {
        const axis = Number(axisSel.value) as 0 | 1 | 2;
        const cut = m(Number(amount.value));
        const keep = o.size[axis] - cut;
        if (!(cut > 0.0009) || keep < 0.001) return null;
        return { axis, keep };
      };
      const update = () => {
        const r = read();
        confirmBtn.disabled = splitBtn.disabled = !r;
        this.viewer.previewCut(r ? o.id : null, r?.axis, r?.keep ?? null);
        const axis = Number(axisSel.value);
        result.textContent = r
          ? `Neue ${names[axis]}: ${fmt(r.keep)} cm · abgesägt: ${fmt(o.size[axis] - r.keep)} cm (halbtransparent)`
          : amount.value ? `Höchstens ${fmt(o.size[axis] - 0.001)} cm.` : 'Gib ein, wie viel abgesägt werden soll.';
      };
      axisSel.addEventListener('change', update);
      amount.addEventListener('input', update);
      confirmBtn.addEventListener('click', () => { const r = read(); if (r) { this.benchPanel = null; this.benchEdit((x) => cutTo(x, r.axis, r.keep)); } });
      splitBtn.addEventListener('click', () => { const r = read(); if (r) { this.benchPanel = null; this.benchEdit((x, sc) => { const rest = splitAt(x, r.axis, r.keep); rest.position = freeSpot(sc.objects, rest.size, rest.rotation); sc.objects.push(rest); }); } });
      requestAnimationFrame(() => amount.focus());
      return h('div', { class: 'dm-benchpanel cut' },
        field('Sägen entlang', axisSel), field('Absägen', h('span', { class: 'dm-unit' }, amount, h('small', {}, 'cm'))),
        confirmBtn, splitBtn, h('button', { class: 'dm-btn small ghost', onclick: () => { this.benchPanel = null; this.renderBench(); } }, 'Abbrechen'),
        result);
    }
    const WOOD = ['#e8d2ad', '#d9b98c', '#c79a63', '#a9713f', '#7a5233', '#4b3524'];
    const sw = (col: string) => h('button', { class: `dm-swatch${!o.paint && o.color.toLowerCase() === col ? ' active' : ''}`, style: `background:${col}`, title: col, onclick: () => this.benchEdit((x) => { x.color = col; x.paint = undefined; }) });
    const paints = this.paintsFor('moebel');
    const isCur = (p: ShopProduct) => o.paint?.url === p.url && (o.paint?.variant ?? '') === (p.paint?.shade ?? '');
    return h('div', { class: 'dm-benchpanel colors' },
      paints.length ? h('span', { class: 'dm-muted small' }, 'Lack & Kreidefarbe') : '',
      ...paints.map((p) => h('button', { class: `dm-swatch${isCur(p) ? ' active' : ''}`, style: `background:${p.paint!.hex}`,
        title: `${p.paint!.shade} · ${p.paint!.product || p.name}${p.paint!.maker ? ` (${p.paint!.maker})` : ''}`,
        onclick: () => this.benchEdit((x) => { x.color = p.paint!.hex; x.paint = paintRef(p); }) })),
      o.paint ? h('span', { class: 'dm-paintname small' }, `${o.paint.variant} · ${o.paint.name}`) : '',
      h('span', { class: 'dm-muted small' }, 'Holz'), ...WOOD.map(sw),
      h('span', { class: 'dm-muted small' }, 'Lack'), ...FURNITURE_COLORS.slice(0, 12).map(sw),
      colorInput(o.color, (hex) => this.benchEdit((x) => { x.color = hex; x.paint = undefined; })));
  }

  private materialView(mat: Materials, scene?: Scene): Child[] {
    const rows = (list: { label: string; size?: string; count: number }[]) => h('ul', { class: 'dm-matlist' },
      list.map((r) => h('li', {}, h('strong', {}, `${r.count} × ${r.label}`), r.size ? h('span', { class: 'dm-muted small' }, ` · ${r.size}`) : '')));
    const out: Child[] = [];
    if (mat.cuts.length) out.push(h('h4', {}, 'Zuschnitt'), rows(mat.cuts));
    if (mat.furniture.length) out.push(h('h4', {}, 'Möbel'), rows(mat.furniture));
    if (mat.hardware.length) out.push(h('h4', {}, 'Kleinteile'), rows(mat.hardware));
    if (mat.screws.length) {
      out.push(h('h4', {}, 'Schrauben'), h('ul', { class: 'dm-matlist' }, mat.screws.map((r) => {
        const p = this.screwProduct(r.dia, r.len);
        return h('li', {}, h('strong', {}, `${r.count} × ${r.label}`), h('span', { class: 'dm-muted small' }, ` · vorbohren ${String(r.pilot).replace('.', ',')} mm`),
          p ? h('a', { class: 'dm-matlink', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener' }, `Passend: ${p.name}${p.conn?.pack ? ` (${p.conn.pack})` : ''}`) : '');
      })));
    }
    const hw = scene?.diyHardware ?? [];
    if (hw.length) {
      const edit = !!scene && scene === this.scene && this.inDiy;
      out.push(h('h4', {}, 'Verbindungen und Beschläge'), h('ul', { class: 'dm-matlist' }, hw.map((r) => {
        const shop = this.connProducts.find((p) => p.id === r.product.catalog_id);
        return h('li', { class: 'dm-hwrow' },
          h('span', {}, h('strong', {}, `${r.count} × `), h('a', { class: 'dm-matlink inline', href: this.shopLink(r.product.url), target: '_blank', rel: 'sponsored noopener' }, r.product.name),
            r.sub ? h('span', { class: 'dm-muted small' }, ` · ${r.sub}`) : ''),
          edit && shop ? h('span', { class: 'dm-stepper' },
            h('button', { class: 'dm-btn small ghost', title: 'Eins weniger', onclick: () => this.addHardware(shop, -1) }, '−'),
            h('button', { class: 'dm-btn small ghost', title: 'Eins mehr', onclick: () => this.addHardware(shop, 1) }, '+')) : '');
      })));
    }
    return out;
  }

  private jointLabel(j: Joint): string {
    const name = (o: SceneObject) => o.label || this.catalog.categories[o.category]?.label || 'Teil';
    return `${name(j.through)} an ${name(j.into)}`;
  }

  /** Eingaben im Menü „Bauteile“ (cm), bleiben beim Neuzeichnen erhalten. */
  private partForm = {
    board: { lage: 'liegend', l: 80, b: 40, s: 1.8 },
    batten: { lage: 'liegend', l: 100, b: 4, s: 2 },
    caster: { d: 5, h: 7 },
    foot: { d: 4, h: 10 },
  };

  /** Menü „Bauteile“ (nur Werkbank): Maße eingeben, dann einfügen. */
  private partsMenu(): Child[] {
    const f = this.partForm;
    const num = (obj: Record<string, number | string>, key: string, label: string, min = 0.1, max = 400) => {
      const input = h('input', { class: 'dm-input', type: 'number', step: 0.1, min, max, value: String(obj[key]) }) as HTMLInputElement;
      input.addEventListener('input', () => { const v = Number(input.value); if (Number.isFinite(v) && v >= min && v <= max) obj[key] = v; });
      return field(label, h('span', { class: 'dm-unit' }, input, h('small', {}, 'cm')));
    };
    const lage = (obj: { lage: string }, opts: [string, string][]) => {
      const sel = h('select', { class: 'dm-input' }, opts.map(([v, l]) => h('option', { value: v, selected: obj.lage === v }, l))) as HTMLSelectElement;
      sel.addEventListener('change', () => { obj.lage = sel.value; });
      return field('Lage', sel);
    };
    const preset = (label: string, apply: () => void) => h('button', { class: 'dm-chip', onclick: () => { apply(); this.renderMenu(); } }, label);
    const insert = (label: string, run: () => void) => h('button', { class: 'dm-btn primary small', style: 'margin-top:6px', onclick: run }, '+ ', label);
    const M = (v: number) => Math.round(v * 10) / 1000; // cm -> m (auf mm)
    // Länge × Breite × Stärke -> Breite, Tiefe, Höhe auf der Werkbank
    const orient = (lg: string, l: number, b: number, t: number): [number, number, number] =>
      lg === 'stehend' ? [M(l), M(t), M(b)] : lg === 'seite' ? [M(t), M(b), M(l)] : lg === 'senkrecht' ? [M(b), M(t), M(l)] : [M(l), M(b), M(t)];
    const label = (c: Category) => this.catalog.categories[c]?.label ?? PART_DEFAULTS[c]?.label ?? 'Teil';
    return [
      h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Maße eingeben und einfügen: das Teil kommt neben die anderen auf die Werkbank. Ändern kannst du es danach jederzeit über die Maßpfeile oder „Maße“. Fertige Möbel wie BILLY oder KALLAX findest du unter „Möbel“, Schrauben und Beschläge unter „Verbindungen“.'),
      h('details', { class: 'dm-toolset dm-partform', open: true }, h('summary', {}, 'Holzplatte'),
        h('div', { class: 'dm-grid' },
          preset('Regalboden 80 × 30', () => Object.assign(f.board, { lage: 'liegend', l: 80, b: 30, s: 1.8 })),
          preset('Seitenwand 60 × 40', () => Object.assign(f.board, { lage: 'seite', l: 60, b: 40, s: 1.8 })),
          preset('Front 80 × 60', () => Object.assign(f.board, { lage: 'stehend', l: 80, b: 60, s: 1.8 })),
          preset('Rückwand 5 mm', () => Object.assign(f.board, { lage: 'stehend', l: 80, b: 60, s: 0.5 }))),
        lage(f.board, [['liegend', 'liegend (Boden, Deckel)'], ['stehend', 'stehend (Front, Rückwand)'], ['seite', 'Seitenwand']]),
        h('div', { class: 'dm-row3' }, num(f.board, 'l', 'Länge'), num(f.board, 'b', 'Breite'), num(f.board, 's', 'Stärke', 0.1, 10)),
        insert('Platte einfügen', () => this.placeNew('board', { label: label('board'), size: orient(f.board.lage, f.board.l, f.board.b, f.board.s) }))),
      h('details', { class: 'dm-toolset dm-partform', open: true }, h('summary', {}, 'Leiste / Kantholz'),
        h('div', { class: 'dm-grid' },
          preset('Leiste 4 × 2', () => Object.assign(f.batten, { b: 4, s: 2 })),
          preset('Kantholz 4 × 4', () => Object.assign(f.batten, { b: 4, s: 4 })),
          preset('Kantholz 6 × 6', () => Object.assign(f.batten, { b: 6, s: 6 }))),
        lage(f.batten, [['liegend', 'liegend'], ['senkrecht', 'senkrecht (Bein, Pfosten)']]),
        h('div', { class: 'dm-row3' }, num(f.batten, 'l', 'Länge'), num(f.batten, 'b', 'Breite', 0.1, 40), num(f.batten, 's', 'Stärke', 0.1, 40)),
        insert('Leiste einfügen', () => this.placeNew('batten', { label: label('batten'), size: orient(f.batten.lage, f.batten.l, f.batten.b, f.batten.s) }))),
      h('details', { class: 'dm-toolset dm-partform' }, h('summary', {}, 'Möbelrolle'),
        h('div', { class: 'dm-grid' },
          preset('50 mm', () => Object.assign(f.caster, { d: 5, h: 7 })),
          preset('75 mm', () => Object.assign(f.caster, { d: 7.5, h: 10 }))),
        h('div', { class: 'dm-row3' }, num(f.caster, 'd', 'Rad Ø', 1, 20), num(f.caster, 'h', 'Höhe', 1, 30)),
        insert('Rolle einfügen', () => this.placeNew('caster', { label: label('caster'), size: [M(f.caster.d), M(f.caster.d), M(f.caster.h)] }))),
      h('details', { class: 'dm-toolset dm-partform' }, h('summary', {}, 'Möbelfuß'),
        h('div', { class: 'dm-row3' }, num(f.foot, 'd', 'Ø', 1, 20), num(f.foot, 'h', 'Höhe', 1, 80)),
        insert('Fuß einfügen', () => this.placeNew('foot', { label: label('foot'), size: [M(f.foot.d), M(f.foot.d), M(f.foot.h)] }))),
    ];
  }

  // ------------------------------------------------------------------ Verbindungen

  /** Menü „Verbindungen“: Schrauben, Nägel, Winkel, Scharniere, Griffe … mit Auswahl der Variante. */
  private connMenu(): Child[] {
    const list = this.connProducts;
    if (!list.length) {
      return [h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Hier erscheinen Schrauben, Nägel, Winkel, Scharniere und Griffe aus dem Shop, sobald die Tabelle „Verbindungen“ in WordPress importiert ist.')];
    }
    const subs = new Map<string, ShopProduct[]>();
    for (const p of list) {
      const sub = p.conn?.sub || 'Sonstiges';
      subs.set(sub, [...(subs.get(sub) ?? []), p]);
    }
    const order = CONN_ORDER;
    const sorted = [...subs.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    return [
      h('p', { class: 'dm-muted small', style: 'margin-top:0' }, this.inDiy
        ? 'Wähle Art, Länge und Durchmesser. Mit „Zum Bauplan“ kommt die Verbindung auf die Materialliste. Schrauben für aneinanderliegende Teile setzt das Programm selbst, passende Produkte stehen dann in der Materialliste.'
        : 'Wähle Art, Länge und Durchmesser und öffne das passende Produkt im Shop.'),
      ...sorted.map((sub, i) => this.connSection(sub, subs.get(sub)!, i < 2)),
    ];
  }

  private connSection(sub: string, items: ShopProduct[], open: boolean): HTMLElement {
    const pick = (this.connPick[sub] ??= {});
    const keys = [['kind', 'Art'], ['length', 'Länge'], ['diameter', 'Durchmesser']] as const;
    const matches = (p: ShopProduct, skip?: string) => keys.every(([k]) => k === skip || !pick[k] || (p.conn?.[k] ?? '') === pick[k]);
    const filters: HTMLElement[] = [];
    for (const [k, label] of keys) {
      // Werte, die zu den anderen gewählten Filtern passen
      const values = [...new Set(items.filter((p) => matches(p, k)).map((p) => p.conn?.[k] ?? '').filter(Boolean))].sort(naturalSort);
      const all = new Set(items.map((p) => p.conn?.[k] ?? '').filter(Boolean));
      if (all.size < 2) continue;
      const sel = h('select', { class: 'dm-input' },
        h('option', { value: '' }, 'Alle'),
        values.map((v) => h('option', { value: v, selected: pick[k] === v }, v))) as HTMLSelectElement;
      sel.addEventListener('change', () => { pick[k] = sel.value || undefined; pick.id = undefined; this.renderMenu(); });
      filters.push(field(label, sel));
    }
    const shown = items.filter((p) => matches(p));
    const chosen = shown.find((p) => p.id === pick.id) ?? shown[0];
    const variant = h('select', { class: 'dm-input' }, shown.map((p) => h('option', { value: p.id, selected: p === chosen }, connShort(p)))) as HTMLSelectElement;
    variant.addEventListener('change', () => { pick.id = variant.value; this.renderMenu(); });
    return h('details', { class: 'dm-toolset dm-conn', open },
      h('summary', {}, `${sub} (${items.length})`),
      filters.length ? h('div', { class: 'dm-conn-filters' }, ...filters) : '',
      shown.length > 1 ? field('Variante', variant) : '',
      chosen ? this.connCard(chosen) : h('p', { class: 'dm-muted small' }, 'Keine passende Variante. Setz einen Filter auf „Alle“.'));
  }

  private connCard(p: ShopProduct): HTMLElement {
    const c = p.conn;
    const key = `conn:${p.id}`;
    const facts = [c?.kind, [c?.diameter && `Ø ${c.diameter}`, c?.length].filter(Boolean).join(' · '), [c?.material, c?.finish].filter(Boolean).join(', '), c?.pack && `Inhalt: ${c.pack}`]
      .filter(Boolean) as string[];
    return h('div', { class: 'dm-conn-card' },
      h('div', { class: 'dm-favrow dm-toolrow' },
        h('a', { class: 'dm-favlink', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' }, productImage(p),
          h('span', { class: 'dm-product-text' }, h('strong', {}, p.name),
            h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.price != null ? euro(p.price) : ''].filter(Boolean).join(' · ')))),
        h('button', { class: `dm-fav${this.favs.has(key) ? ' active' : ''}`, title: 'Merken', onclick: () => {
          this.toggleFav({ key, name: p.name, url: p.url, image: p.image, source: p.source, price: p.price }); this.renderMenu();
        } }, icon(ICON_HEART))),
      facts.length ? h('ul', { class: 'dm-conn-facts dm-muted small' }, facts.map((f) => h('li', {}, f))) : '',
      this.inDiy ? h('button', { class: 'dm-btn small primary', onclick: () => this.addHardware(p) }, '+ Zum Bauplan') : '');
  }

  /** Verbindung auf die Materialliste des DIY-Möbels setzen (oder die Anzahl erhöhen). */
  private addHardware(p: ShopProduct, delta = 1): void {
    if (!this.scene?.diy) return;
    const next = clone(this.scene);
    const list = (next.diyHardware ??= []);
    const row = list.find((r) => r.product.catalog_id === p.id || r.product.url === p.url);
    if (row) row.count = Math.max(0, row.count + delta);
    else if (delta > 0) list.push({ product: { source: p.source, name: p.name, url: p.url, sku: '', image: p.image, price: p.price, catalog_id: p.id }, count: delta, sub: p.conn?.sub });
    next.diyHardware = list.filter((r) => r.count > 0);
    this.apply(next, false);
    if (delta > 0 && !row) this.toast(`„${p.name}“ steht jetzt in der Materialliste.`);
    this.renderPanel();
    if (this.sheet === 'shop') this.renderSheet();
  }

  /** Passendes Shop-Produkt für eine vom Programm berechnete Schraube (Durchmesser × Länge in mm). */
  private screwProduct(dia: number, len: number): ShopProduct | undefined {
    const screws = this.connProducts.filter((p) => /schraube/i.test(p.conn?.sub ?? '') && !/schloss|confirmat|m\d/i.test(`${p.name} ${p.conn?.diameter}`));
    const mm = (v: string | undefined) => { const n = parseFloat((v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
    const sized = screws.filter((p) => Math.abs(mm(p.conn?.diameter) - dia) < 0.01);
    const exact = sized.find((p) => mm(p.conn?.length) === len);
    if (exact) return exact;
    // gleiche Stärke, nächstkürzere Länge (zu lang darf nicht durchstoßen), sonst das Sortiment
    const shorter = sized.filter((p) => mm(p.conn?.length) <= len).sort((a, b) => mm(b.conn?.length) - mm(a.conn?.length))[0];
    return shorter ?? screws.find((p) => !p.conn?.length);
  }

  /** Menü „Bauplan“ im DIY-Bereich. */
  private diyMenu(): Child[] {
    const s = this.scene!;
    const mat = materials(s, this.catalog);
    const c = (v: number) => String(Math.round(v * 1000) / 10).replace('.', ',');
    const name = h('input', { class: 'dm-input', value: s.room.name }) as HTMLInputElement;
    name.addEventListener('change', () => {
      const next = clone(s);
      next.room.name = name.value.trim() || 'DIY-Möbel';
      this.apply(next, false);
      this.renderMenu();
    });
    const out: Child[] = [
      field('Name des Möbels', name),
      s.objects.length
        ? h('p', { class: 'dm-muted small' }, `Außenmaße: ${c(mat.size[0])} × ${c(mat.size[1])} × ${c(mat.size[2])} cm (Breite × Tiefe × Höhe), ${s.objects.length} Teile`)
        : h('p', { class: 'dm-muted small' }, 'Noch leer. Unter „Möbel“ fügst du Möbel und Bauteile (Holzplatten, Leisten, Rollen) hinzu. Schiebst du Teile aneinander, rasten sie ein und bekommen automatisch passende Schrauben.'),
      h('div', { class: 'dm-col' },
        h('button', { class: 'dm-btn primary', disabled: !s.objects.length, onclick: () => this.placeBuild(this.diyId) }, 'In den Raum einfügen'),
        h('button', { class: 'dm-btn', disabled: !s.objects.length, onclick: () => this.printShopList() }, icon(ICON_PDF), ' Materialliste und Bohrplan als PDF'),
        h('button', { class: 'dm-btn', disabled: !s.objects.length, title: 'Setzt vier Möbelrollen unter die Ecken und hebt das Möbel an', onclick: () => this.apply(withCasters(s, this.catalog.categories.caster.label), true) }, '+ Vier Rollen unten anbringen')),
    ];
    if (mat.joints.length) {
      out.push(h('h4', {}, `Verbindungen (${mat.joints.length})`), ...mat.joints.map((j) => h('details', { class: 'dm-toolset' },
        h('summary', {}, this.jointLabel(j)),
        h('button', { class: 'dm-btn small ghost', style: 'float:right', title: 'Diese beiden Teile nicht verschrauben', onclick: () => {
          const next = clone(s);
          next.diyOff = [...(next.diyOff ?? []), jointKey(j.through.id, j.into.id)];
          this.apply(next, true);
        } }, 'Lösen'),
        h('p', { class: 'dm-muted small', style: 'margin:2px 0' }, `${j.screws.length} × ${String(j.dia).replace('.', ',')} × ${j.len} mm, vorbohren ${String(j.pilot).replace('.', ',')} mm`),
        h('p', { class: 'dm-muted small', style: 'margin:2px 0' }, `Bohrpunkte auf der Kontaktfläche (${String(j.area[0]).replace('.', ',')} × ${String(j.area[1]).replace('.', ',')} cm), von der Ecke gemessen: ${j.points.map((p) => `${String(p[0]).replace('.', ',')} / ${String(p[1]).replace('.', ',')}`).join(' · ')} cm`))));
    } else if (s.objects.length > 1) {
      out.push(h('p', { class: 'dm-muted small' }, 'Noch keine Verbindungen: Schiebe zwei Teile Fläche an Fläche, dann setzt das Programm die Schrauben.'));
    }
    out.push(...this.materialView(mat, s));
    const builds = this.builds;
    out.push(h('h4', {}, 'Meine DIY-Möbel'),
      h('div', { class: 'dm-col' }, builds.map((b) => h('div', { class: 'dm-row' },
        h('button', { class: `dm-btn small${b.id === this.diyId ? ' primary' : ''}`, style: 'flex:1', onclick: () => { if (b.id !== this.diyId) this.enterDiy(b.id); } }, b.id === this.diyId ? s.room.name || b.name : b.name),
        h('button', { class: 'dm-btn small ghost danger', title: 'Bauplan löschen', onclick: () => this.deleteBuild(b.id) }, icon(TRASH)))),
      h('button', { class: 'dm-btn small', onclick: () => this.enterDiy('new') }, '+ Neues DIY-Möbel')));
    return out;
  }

  /** Früherer Name, wird an vielen Stellen nach Änderungen aufgerufen. */
  private renderPanel(): void {
    this.renderMenu();
    this.renderFloating();
  }

  private toggleMenu(id: MenuId): void {
    this.menu = this.menu === id ? null : id;
    if (id === 'furniture') this.furnAdd = true;
    this.renderMenu();
  }

  private openMenu(id: MenuId): void {
    this.menu = id;
    this.renderMenu();
  }

  /** Werkbank: nur Bauplan, Möbel, Bauteile, Verbindungen, Werkzeug (Ansicht, Farbe, Entfernen stecken in der Leiste unten). */
  private dockMenus(): { id: MenuId; label: string; icon: string }[] {
    if (!this.inDiy) return MENUS.filter((m) => !BENCH_ONLY.has(m.id));
    return BENCH_MENUS.map((id) => MENUS.find((m) => m.id === id)!);
  }

  private renderDock(): void {
    const btn = (m: { id: MenuId; label: string; icon: string }) => h('button', {
      class: `dm-dock-btn${this.menu === m.id ? ' active' : ''}`,
      title: m.label,
      onclick: () => this.toggleMenu(m.id),
    }, icon(m.icon), h('span', {}, m.label));
    this.elDock.replaceChildren(
      ...this.dockMenus().map(btn),
      h('span', { class: 'dm-dock-spacer' }),
      h('button', { class: 'dm-dock-btn dm-dock-home', title: 'Home: alle Projekte, neues Projekt', onclick: () => this.showProjects() }, icon(ICON_HOME), h('span', {}, 'Home')),
      btn({ id: 'account', label: this.user.name ? 'Konto' : 'Konto', icon: ICON_USER }));
  }

  // ------------------------------------------------------------------ Konto und Darstellung

  private accountMenu(): Child[] {
    const u = this.user;
    const themeBtn = (t: Theme, label: string) => h('button', {
      class: `dm-tab${this.theme === t ? ' active' : ''}`,
      onclick: () => { this.theme = t; saveTheme(t); this.applyTheme(); this.renderMenu(); },
    }, label);
    return [
      u.name
        ? h('p', { style: 'margin-top:0' }, 'Angemeldet als ', h('strong', {}, u.name))
        : h('p', { class: 'dm-muted', style: 'margin-top:0' }, 'Nicht angemeldet. Deine Projekte merkt sich nur dieser Browser.'),
      h('div', { class: 'dm-col' },
        h('button', { class: 'dm-btn', onclick: () => this.showProjects() }, icon(ICON_HOME), ' Meine Projekte'),
        h('button', { class: 'dm-btn', onclick: () => this.showStart() }, '+ Neues Projekt'),
        u.name && u.profileUrl && h('a', { class: 'dm-btn', href: u.profileUrl }, 'Profil bearbeiten'),
        u.name && u.logoutUrl && h('a', { class: 'dm-btn ghost', href: u.logoutUrl }, 'Abmelden'),
        !u.name && u.loginUrl && h('a', { class: 'dm-btn primary', href: u.loginUrl }, 'Anmelden')),
      h('h4', {}, 'Darstellung'),
      h('div', { class: 'dm-tabs', style: 'margin-top:0' }, themeBtn('light', 'Hell'), themeBtn('dark', 'Dunkel'), themeBtn('auto', 'Automatisch')),
      h('label', { class: 'dm-check', style: 'margin-top:8px' },
        h('input', { type: 'checkbox', checked: this.gradient, onchange: (e: Event) => {
          this.gradient = (e.target as HTMLInputElement).checked;
          try { localStorage.setItem('dm3d_gradient', this.gradient ? '1' : '0'); } catch { /* egal */ }
          this.applyTheme();
        } }),
        ' Farbverlauf im Hintergrund'),
      this.version && h('p', { class: 'dm-muted small' }, `Raumplaner Version ${this.version}`),
    ];
  }

  private applyTheme(): void {
    const dark = this.theme === 'dark' || (this.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    this.root.classList.toggle('dm-dark', dark);
    document.documentElement.classList.toggle('dm3d-dark', dark);
    this.viewer?.setDark(dark, !this.scene || this.gradient);
  }

  // ------------------------------------------------------------------ Listen rechts (Speichern, Merkliste, Einkaufsliste, Rendering)

  private sheetBtn(id: SheetId, ic: string, label: string, title: string): HTMLElement {
    const b = h('button', { class: 'dm-btn ghost needs-project', 'data-sheet': id, title, onclick: () => this.toggleSheet(id) }, icon(ic), h('span', {}, label));
    return b;
  }

  private toggleSheet(id: SheetId): void {
    if (this.sheet === id && this.wide) { this.closeSheet(); return; }
    this.sheet = id;
    this.renderSheet();
  }

  private renderSheet(): void {
    this.root.querySelectorAll('[data-sheet]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-sheet') === this.sheet && this.wide));
    if (!this.sheet || !this.scene) {
      this.elSheet.hidden = true;
      this.elSheet.replaceChildren();
      return;
    }
    const content = {
      save: () => this.saveSheet(),
      favs: () => this.favSheet(),
      shop: () => this.shopSheet(),
      render: () => this.renderSheetContent(),
    }[this.sheet]();
    if (!content) return;
    const { title, body, actions } = content;
    if (!this.wide) {
      this.elSheet.hidden = true;
      this.showOverlay(h('div', { class: 'dm-card' }, h('h2', {}, title), ...body,
        h('div', { class: 'dm-row end' }, ...(actions ?? []), h('button', { class: 'dm-btn primary', onclick: () => this.closeSheet() }, 'Schließen'))));
      return;
    }
    this.elSheet.hidden = false;
    this.elSheet.replaceChildren(
      h('div', { class: 'dm-sheet-head' }, h('strong', {}, title),
        h('button', { class: 'dm-btn ghost small', title: 'Schließen', onclick: () => this.closeSheet() }, '✕')),
      h('div', { class: 'dm-sheet-body' }, ...body, actions && actions.length ? h('div', { class: 'dm-row', style: 'margin-top:8px' }, ...actions) : null));
  }

  private closeSheet(): void {
    const wasOverlay = !this.wide && !!this.sheet;
    this.sheet = null;
    this.renderSheet();
    if (wasOverlay) this.hideOverlay();
  }


  private renderMenu(): void {
    const s = this.scene;
    this.elTitle.textContent = s ? this.project?.name || (this.mainHome ?? this.home)?.rooms[0]?.scene.room.name || 'Raumplaner' : 'Raumplaner';
    this.renderMode();
    if ((this.menu === 'room' || this.menu === 'style') && this.inDiy) this.menu = 'diy';
    if (this.menu && this.menu !== 'account' && !this.dockMenus().some((m) => m.id === this.menu)) this.menu = null;
    this.root.classList.toggle('dm-empty', !s);
    this.root.classList.toggle('dm-panel-open', !!this.menu && !!s);
    this.renderPlan();
    if (this.sheet === 'shop' && this.wide) this.renderSheet();
    this.renderDock();
    this.elPop.replaceChildren();
    this.elPop.hidden = !this.menu || !s;
    if (!this.menu || !s) {
      this.updateShift();
      return;
    }
    const def = MENUS.find((m) => m.id === this.menu) ?? { id: 'account' as MenuId, label: 'Konto', icon: ICON_USER };
    const body: Child[] = {
      view: () => this.viewMenu(),
      room: () => this.roomMenu(),
      select: () => this.selectMenu(),
      remove: () => this.removeMenu(),
      color: () => this.colorMenu(),
      furniture: () => this.furnitureMenu(),
      style: () => this.styleMenu(),
      tools: () => this.toolsMenu(),
      diy: () => this.diyMenu(),
      parts: () => this.partsMenu(),
      conn: () => this.connMenu(),
      account: () => this.accountMenu(),
    }[this.menu]();
    requestAnimationFrame(() => this.updateShift());
    this.elPop.append(
      h('div', { class: 'dm-pop-head' },
        h('strong', {}, def.label),
        h('button', { class: 'dm-btn ghost small', title: 'Schließen', onclick: () => this.toggleMenu(this.menu!) }, '✕')),
      h('div', { class: 'dm-pop-body' }, body),
    );
  }

  // ------------------------------------------------------------------ Grundriss

  private editWall(index: number, meters: number): void {
    const s = this.scene;
    if (!s) return;
    this.apply(setWallLength(s, index, meters, this.proportional), true);
    this.toast(`Wand ${index + 1}: ${Math.round(meters * 100)} cm`);
  }

  private toggleMoveRooms(): void {
    this.plan.moveRooms = !this.plan.moveRooms;
    if (this.plan.moveRooms) {
      this.planOpen = true;
      this.toast('Im Grundriss einen Raum ziehen. Er rastet an den Nachbarräumen ein.');
    }
    this.renderMenu();
  }

  private renderPlan(): void {
    const home = this.home;
    const open = !!this.planOpen;
    this.elPlan.classList.toggle('collapsed', !open);
    if (home && home.rooms.length < 2) this.plan.moveRooms = false;
    const many = !!home && home.rooms.length > 1;
    this.elPlanHead.replaceChildren(
      h('button', { class: 'dm-plan-toggle', title: open ? 'Grundriss einklappen' : 'Grundriss zeigen', onclick: () => { this.planOpen = !open; this.renderPlan(); } },
        icon(ICON_PLAN), h('strong', {}, 'Grundriss')),
      ...(open && many ? [
        h('button', { class: `dm-btn small${this.plan.moveRooms ? ' primary' : ''}`, title: 'Ganze Räume im Grundriss verschieben', onclick: () => this.toggleMoveRooms() }, 'Räume verschieben'),
        h('button', { class: 'dm-btn small', title: 'Bearbeiteten Raum um 90° drehen', onclick: () => this.applyHome(rotateRoom(this.home!, this.active, 90), true) }, '90°'),
      ] : []));
    const sel = this.selection;
    this.plan.setData(open ? home : null, this.active, sel?.kind === 'object' ? sel.id : null);
    this.renderFavs();
  }

  // ------------------------------------------------------------------ Favoriten

  private toggleFav(item: FavItem): void {
    if (this.favs.has(item.key)) this.favs.delete(item.key);
    else this.favs.set(item.key, item);
    saveFavs(this.favs);
    this.renderFavs();
  }

  private favRow(f: FavItem): HTMLElement {
    return h('div', { class: 'dm-favrow' },
      h('a', { class: 'dm-favlink', href: this.shopLink(f.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' },
        productImage(f),
        h('span', { class: 'dm-product-text' },
          h('strong', {}, f.name),
          h('span', { class: 'dm-muted small' }, [SHOP_LABEL[f.source], f.price != null ? euro(f.price) : ''].filter(Boolean).join(' · ')))),
      h('button', { class: 'dm-btn small ghost', title: 'Von der Merkliste nehmen', onclick: () => { this.toggleFav(f); this.renderMenu(); } }, '✕'));
  }

  /** Merkliste neu zeichnen, wenn sie offen ist. */
  private renderFavs(): void {
    if (this.sheet === 'favs') this.renderSheet();
  }

  private showFavorites(): void {
    this.sheet = 'favs';
    this.renderSheet();
  }

  private favSheet(): SheetContent {
    const list = [...this.favs.values()];
    return {
      title: `Merkliste${list.length ? ` (${list.length})` : ''}`,
      body: [
        list.length
          ? h('div', { class: 'dm-favs-list' }, list.map((f) => this.favRow(f)))
          : h('p', { class: 'dm-muted small' }, 'Noch nichts gemerkt. Tippe im Möbel-Menü auf das Herz oder bei einem Möbel auf „Produkt merken“.'),
        list.length > 0 && h('p', { class: 'dm-muted small' }, 'Ein Klick öffnet das Produkt im Shop (neuer Tab).'),
        this.amazonTag && list.some((f) => f.source === 'amazon') && h('p', { class: 'dm-muted small' }, 'Als Amazon-Partner verdienen wir an qualifizierten Verkäufen.'),
      ],
      actions: list.length ? [h('button', { class: 'dm-btn small', onclick: () => this.printList('favs', list.map((f) => ({ name: f.name, url: f.url, image: f.image, source: f.source, price: f.price }))) }, icon(ICON_PDF), ' Als PDF'),
        h('button', { class: 'dm-btn small', onclick: () => { if (!this.wide) this.closeSheet(); this.furnTab = 'favs'; this.shopFilter = 'all'; this.productQuery = ''; this.furnAdd = true; this.openMenu('furniture'); } }, 'Gemerkte in den Raum einfügen')] : [],
    };
  }

  // ------------------------------------------------------------------ Ansicht

  private setView(mode: ViewMode): void {
    if (this.tool === 'measure') this.setTool('select');
    if (mode === 'walk' && this.viewer.focused) this.viewer.setRoomFocus(false); // Begehen: durch alle Räume
    this.viewer.setMode(mode);
    if (mode === 'walk' && !this.wide) this.menu = null;
    if (mode !== 'walk') this.plan.setViewer(null);
    this.renderMenu();
    this.renderFloating();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.viewer.setTool(tool);
    if (tool === 'measure') this.menu = null;
    this.renderMenu();
    this.renderFloating();
  }

  private viewMenu(): Child[] {
    const mode = this.viewer.viewMode;
    const seg = (m: ViewMode, label: string) =>
      h('button', { class: `dm-tab${mode === m ? ' active' : ''}`, onclick: () => this.setView(m) }, label);
    return [
      h('div', { class: 'dm-tabs' }, seg('orbit', '3D'), seg('top', 'Draufsicht'), seg('walk', 'Begehen')),
      h('p', { class: 'dm-muted small' }, mode === 'walk'
        ? 'Gehen mit W/A/S/D oder den Pfeiltasten (am Handy mit dem Joystick), umsehen durch Ziehen.'
        : 'Drehen: ziehen · Verschieben: rechte Maustaste oder zwei Finger · Zoomen: Mausrad oder zwei Finger.'),
      h('h4', {}, 'Maße'),
      h('label', { class: 'dm-check' },
        h('input', { type: 'checkbox', checked: this.showDims, onchange: (e: Event) => {
          this.showDims = (e.target as HTMLInputElement).checked;
          this.viewer.measure.setRoomVisible(this.showDims);
          this.viewer.measure.showSelection = this.showDims;
          this.viewer.measure.updateSelection();
        } }),
        'Raummaße und Möbelabstände anzeigen'),
      h('div', { class: 'dm-row' },
        h('button', { class: 'dm-btn primary', onclick: () => this.setTool('measure') }, 'Abstand messen'),
        this.viewer.measure.manualCount > 0 && h('button', { class: 'dm-btn', onclick: () => {
          this.viewer.measure.clearManual();
          this.renderMenu();
        } }, 'Messungen löschen')),
      h('div', { class: 'dm-row', style: 'margin-top:8px' },
        mode !== 'walk' && h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.frame() }, 'Ansicht zurücksetzen'),
        mode !== 'walk' && (this.home?.rooms.length ?? 0) > 1 && h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.frame(true) }, 'Ganze Wohnung')),
    ];
  }

  // ------------------------------------------------------------------ Raum anpassen

  private roomMenu(): Child[] {
    const s = this.scene!;
    const rect = rectangleWalls(s);
    const wallInput = (i: number) => numberInput(cm(wallLength(s, i)), 30, 3000, (v) =>
      this.apply(setWallLength(s, i, m(v), this.proportional), true), 'cm');
    const rooms = this.home!.rooms;
    return [
      h('div', { class: 'dm-rooms' },
        rooms.map((r, i) => h('button', {
          class: `dm-chip${i === this.active ? ' active' : ''}`,
          onclick: () => this.switchRoom(i),
        }, r.scene.room.name || `Raum ${i + 1}`)),
        h('button', { class: 'dm-chip add', onclick: () => this.showAddRoom() }, '+ Raum anbauen')),
      rooms.length > 1 && h('div', { class: 'dm-row', style: 'margin-bottom:10px' },
        h('button', { class: `dm-btn small${this.plan.moveRooms ? ' primary' : ''}`, onclick: () => this.toggleMoveRooms() }, 'Räume verschieben'),
        h('button', { class: 'dm-btn small', title: 'Diesen Raum um 90° drehen', onclick: () => this.applyHome(rotateRoom(this.home!, this.active, 90), true) }, '90° drehen')),
      field('Name', h('input', {
        class: 'dm-input', value: s.room.name,
        onchange: (e: Event) => this.apply({ ...clone(s), room: { ...clone(s.room), name: (e.target as HTMLInputElement).value } }, false)
          .then(() => this.renderMenu()),
      })),
      h('div', { class: 'dm-row three' },
        field('Höhe', numberInput(cm(s.room.height), 180, 600, (v) => this.rebuildWith((n) => (n.room.height = m(v))))),
        rect && field('Länge', wallInput(rect.length)),
        rect && field('Breite', wallInput(rect.width)),
      ),
      h('p', { class: 'dm-muted small' }, `${roomArea(s).toFixed(1).replace('.', ',')} m² · ${s.objects.length} Möbel · `,
        s.meta.dimensions_confirmed ? 'Maße angepasst' : 'Maße geschätzt, trage gemessene Werte ein'),
      h('label', { class: 'dm-check' },
        h('input', { type: 'checkbox', checked: this.proportional, onchange: (e: Event) => (this.proportional = (e.target as HTMLInputElement).checked) }),
        'Ganzen Raum proportional skalieren'),
      h('details', { class: 'dm-details', open: !rect },
        h('summary', {}, 'Wände einzeln'),
        ...s.walls.map((w, i) => h('div', { class: 'dm-wallrow' },
          h('button', { class: 'dm-link', onclick: () => this.viewer.setSelection({ kind: 'wall', id: w.id }, true) }, `Wand ${i + 1}`),
          wallInput(i)))),
      s.meta.notes && h('details', { class: 'dm-details' }, h('summary', {}, 'Hinweise der KI'), h('pre', {}, s.meta.notes)),
    ];
  }

  // ------------------------------------------------------------------ Wohnung: Räume anbauen

  private removeRoom(): void {
    if (!this.home || this.home.rooms.length < 2) return;
    const name = this.scene?.room.name || 'Raum';
    const next = { ...this.home, rooms: this.home.rooms.filter((_, i) => i !== this.active) };
    this.active = Math.max(0, this.active - 1);
    this.selection = null;
    this.applyHome(next, true);
    this.toast(`${name} entfernt. Mit ↶ holst du ihn zurück.`);
  }

  private showAddRoom(): void {
    const s = this.scene!;
    const lengths = s.walls.map((_, i) => wallLength(s, i));
    // Vorschlag: längste Wand ohne Tür
    let wall = lengths.indexOf(Math.max(...lengths.filter((_, i) => !s.walls[i].openings.some((o) => o.type === 'door')), 0));
    if (wall < 0) wall = lengths.indexOf(Math.max(...lengths));
    const wallSelect = h('select', { class: 'dm-input', onchange: (e: Event) => (wall = Number((e.target as HTMLSelectElement).value)) },
      lengths.map((l, i) => h('option', { value: String(i), selected: i === wall }, `Wand ${i + 1} (${cm(l)} cm)`))) as HTMLSelectElement;
    const server = !this.opts.demo && this.analysisAvailable && this.canCreate;
    let kind = 'empty';
    const name = h('input', { class: 'dm-input', value: `Raum ${this.home!.rooms.length + 1}` }) as HTMLInputElement;
    const num = (v: number) => h('input', { class: 'dm-input', type: 'number', min: 100, max: 3000, value: String(v) }) as HTMLInputElement;
    const len = num(400), wid = num(300);
    const file = h('input', { type: 'file', multiple: true, accept: 'video/*', class: 'dm-file' }) as HTMLInputElement;
    const hint = h('textarea', { class: 'dm-input', rows: 2, placeholder: 'Optional: z. B. "Flur, 1,20 m breit"' }) as HTMLTextAreaElement;
    const emptyBox = h('div', {},
      field('Name', name),
      h('div', { class: 'dm-row three' }, field('Länge (cm)', len), field('Breite (cm)', wid)));
    const uploadBox = h('div', { hidden: true },
      server ? h('div', {}, file, hint)
        : h('p', { class: 'dm-note' }, this.opts.demo
          ? 'In dieser Demo geht nur ein leerer Raum. Auf der Webseite kannst du auch ein Video oder Fotos hochladen.'
          : 'Für Video oder Fotos bitte anmelden (und den API-Key in den Plugin-Einstellungen eintragen).'));
    const err = h('p', { class: 'dm-error', hidden: true });
    const tabs = [['empty', 'Leerer Raum'], ['video', 'Aus Video'], ['photos', 'Aus Fotos']].map(([k, label]) =>
      h('button', {
        class: `dm-tab${k === kind ? ' active' : ''}`,
        onclick: (e: Event) => {
          kind = k;
          emptyBox.hidden = k !== 'empty';
          uploadBox.hidden = k === 'empty';
          file.accept = k === 'video' ? 'video/*' : 'image/*';
          tabs.forEach((t) => t.classList.toggle('active', t === e.currentTarget));
        },
      }, label));
    const fail = (text: string) => { err.textContent = text; err.hidden = false; };
    this.showOverlay(h('div', { class: 'dm-card' },
      h('h2', {}, 'Raum anbauen'),
      h('p', { class: 'dm-muted' }, 'Der neue Raum wird an eine Wand des aktuellen Raums gesetzt. In beide Wände kommt eine Tür, durch die du beim Begehen gehen kannst.'),
      field(`An welche Wand von „${s.room.name || 'diesem Raum'}“?`, wallSelect),
      h('div', { class: 'dm-tabs' }, tabs),
      emptyBox, uploadBox, err,
      h('div', { class: 'dm-row end' },
        h('button', { class: 'dm-btn ghost', onclick: () => this.hideOverlay() }, 'Abbrechen'),
        h('button', { class: 'dm-btn primary', onclick: async () => {
          if (kind === 'empty') {
            const l = Number(len.value), w = Number(wid.value);
            if (!(l >= 100 && w >= 100)) return fail('Bitte Länge und Breite in cm angeben (mindestens 100).');
            this.attachNewRoom(wall, emptyRoom(name.value.trim() || 'Neuer Raum', m(l), m(w), s.room.height, s), fail);
            return;
          }
          if (!server) return fail('Das geht hier leider nicht, siehe Hinweis oben.');
          const files = Array.from(file.files ?? []);
          if (!files.length) return fail('Bitte zuerst eine Datei auswählen.');
          try {
            this.showProgress('Dateien werden vorbereitet');
            const input = await prepareInput(files, (t) => this.showProgress(t));
            this.showProgress('Bilder werden hochgeladen');
            const { id } = await this.api.createProject(kind, input, hint.value);
            this.api.analyze(id).catch(() => undefined);
            const p = await this.waitForProject(id);
            this.attachNewRoom(wall, toHome(p.scene).rooms[0].scene, (text) => this.showError(text));
          } catch (e) {
            this.showError((e as Error).message);
          }
        } }, 'Anbauen')),
    ));
  }

  private attachNewRoom(wall: number, room: Scene, fail: (text: string) => void): void {
    const res = attachRoom(this.home!, this.active, wall, room);
    if (typeof res === 'string') return fail(res);
    this.hideOverlay();
    this.active = res.rooms.length - 1;
    this.selection = null;
    this.applyHome(res, true);
    this.viewer.frame(true);
    this.toast(`${room.room.name || 'Neuer Raum'} angebaut. Unter Ansicht → Begehen gehst du durch die Tür.`);
  }

  // ------------------------------------------------------------------ Auswahl

  private selectMenu(): Child[] {
    const s = this.scene!;
    const sel = this.selection;
    const obj = sel?.kind === 'object' ? s.objects.find((o) => o.id === sel.id) : undefined;
    return [
      obj
        ? h('div', {},
          h('p', {}, h('strong', {}, obj.label || this.catalog.categories[obj.category]?.label), ' ist ausgewählt.'),
          this.viewer.viewMode === 'walk'
            ? h('p', { class: 'dm-muted small' }, 'Zum Bewegen und Drehen in die 3D-Ansicht wechseln.')
            : h('p', { class: 'dm-muted small' }, 'Im Bild oder im Grundriss ziehen zum Verschieben. Der Bogen am Boden dreht, der Pfeil nach oben verstellt die Höhe.'),
          h('div', { class: 'dm-row' },
            h('button', { class: 'dm-btn', onclick: () => this.rotateBy(obj.id, 90) }, '90° drehen'),
            h('button', { class: 'dm-btn', onclick: () => this.duplicateObject(obj.id) }, 'Duplizieren'),
            h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.setSelection(null, true) }, 'Aufheben')))
        : h('p', { class: 'dm-muted' }, sel ? 'Wand, Boden oder Paneel ausgewählt. Bewegen lassen sich nur Möbel.' : 'Tippe im Bild auf ein Möbelstück oder wähle es hier aus.'),
      h('h4', {}, 'Im Raum'),
      s.objects.length
        ? h('div', { class: 'dm-grid' }, s.objects.map((o) =>
          h('button', {
            class: `dm-chip${sel?.kind === 'object' && sel.id === o.id ? ' active' : ''}`,
            onclick: () => this.viewer.setSelection({ kind: 'object', id: o.id }, true),
          }, o.label || this.catalog.categories[o.category]?.label)))
        : h('p', { class: 'dm-muted small' }, 'Noch keine Möbel. Unter „Möbel“ fügst du welche hinzu.'),
    ];
  }

  private setGizmo(mode: 'translate' | 'rotate'): void {
    this.gizmoMode = mode;
    this.viewer.setGizmoMode(mode);
    this.renderMenu();
    this.renderFloating();
  }

  /** Winkel des Möbels: anzeigen und frei eingeben. */
  private angleInput(o: SceneObject): HTMLElement {
    const input = h('input', { class: 'dm-angle', type: 'number', min: -360, max: 720, step: 1, value: String(Math.round(o.rotation)), title: 'Drehung in Grad' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      this.rotateTo(o.id, v);
    });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    return h('label', { class: 'dm-angle-wrap', title: 'Drehung in Grad' }, icon(ICON_ROTATE), input, '°');
  }

  private rotateTo(id: string, deg: number): void {
    const next = clone(this.scene!);
    const o = next.objects.find((x) => x.id === id);
    if (!o) return;
    o.rotation = ((Math.round(deg) % 360) + 360) % 360;
    this.apply(next, true);
  }

  private rotateBy(id: string, deg: number): void {
    const next = clone(this.scene!);
    const o = next.objects.find((x) => x.id === id);
    if (!o) return;
    // Werkbank: verschraubte Teile drehen als Ganzes um das gewählte Teil
    const group = next.diy ? connected(next.objects, next.diyOff, id) : [id];
    const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    for (const gid of group) {
      const x = next.objects.find((v) => v.id === gid);
      if (!x) continue;
      if (x !== o) {
        const dx = x.position[0] - o.position[0], dy = x.position[1] - o.position[1];
        x.position[0] = Math.round((o.position[0] + dx * cos - dy * sin) * 1000) / 1000;
        x.position[1] = Math.round((o.position[1] + dx * sin + dy * cos) * 1000) / 1000;
      }
      x.rotation = (((x.rotation + deg) % 360) + 360) % 360;
    }
    this.apply(next, true, new Set(group));
  }

  // ------------------------------------------------------------------ Entfernen

  private removeMenu(): Child[] {
    const s = this.scene!;
    const sel = this.selection;
    const obj = sel?.kind === 'object' ? s.objects.find((o) => o.id === sel.id) : undefined;
    const panel = sel?.kind === 'panel' ? findPanel(s, sel.id) : null;
    const panels = s.walls.reduce((n, w) => n + w.panels.length, 0);
    return [
      (this.home?.rooms.length ?? 0) > 1 && h('button', { class: 'dm-btn danger wide', style: 'margin-bottom:8px', onclick: () => this.removeRoom() },
        `Raum „${s.room.name || 'ohne Namen'}“ aus der Wohnung entfernen`),
      h('h4', { style: 'margin-top:0' }, 'Auswahl'),
      obj ? h('button', { class: 'dm-btn danger wide', onclick: () => this.deleteObject(obj.id) }, `${obj.label || 'Möbel'} entfernen`)
        : panel ? h('button', { class: 'dm-btn danger wide', onclick: () => this.removeSelected() }, 'Paneel entfernen')
          : h('p', { class: 'dm-muted small' }, 'Nichts ausgewählt. Tippe ein Möbelstück an, um es zu entfernen.'),
      h('h4', {}, 'Ganzer Raum'),
      h('div', { class: 'dm-col' },
        h('button', { class: 'dm-btn danger', disabled: !s.objects.length, onclick: () => this.emptyRoom() }, `Alle Möbel entfernen (${s.objects.length})`),
        h('button', { class: 'dm-btn', disabled: !panels, onclick: () => {
          this.rebuildWith((n) => n.walls.forEach((w) => (w.panels = [])));
          this.toast('Paneele entfernt. Mit ↶ holst du sie zurück.');
        } }, `Alle Wandpaneele entfernen (${panels})`)),
      h('p', { class: 'dm-muted small' }, 'Alles lässt sich mit ↶ oben rückgängig machen.'),
    ];
  }

  private removeSelected(): void {
    const sel = this.selection;
    if (sel?.kind === 'object') this.deleteObject(sel.id);
    else if (sel?.kind === 'panel') {
      const found = findPanel(this.scene!, sel.id);
      if (!found) return;
      this.viewer.setSelection({ kind: 'wall', id: found.wall.id }, true);
      this.rebuildWith((n) => { n.walls[found.wallIndex].panels = n.walls[found.wallIndex].panels.filter((x) => x.id !== sel.id); });
    }
  }

  // ------------------------------------------------------------------ Farbe

  /** Ziel der Farbwahl: Auswahl oder (ohne Auswahl) alle Wände. */
  /** Was gerade eingefärbt wird. kind bestimmt, welche Farben aus dem Shop passen. paint: Shop-Farbe oder undefined (eigene Farbe). */
  private colorTarget(): { name: string; color: string; palette: string[]; kind: PaintKind; paint?: Product; apply: (c: string, paint?: Product) => void } | null {
    const s = this.scene!;
    const sel = this.selection;
    if (sel?.kind === 'object') {
      const o = s.objects.find((x) => x.id === sel.id);
      if (!o) return null;
      return { name: o.label || 'Möbel', color: o.color, palette: FURNITURE_COLORS, kind: 'moebel', paint: o.paint,
        apply: (c, paint) => this.recolor(o.id, c, (n) => {
          const x = n.objects.find((y) => y.id === o.id)!;
          x.color = c;
          x.paint = paint;
          if (x.product?.variants) x.product.variant = x.product.variants.find((v) => v.color.toLowerCase() === c.toLowerCase())?.name;
        }) };
    }
    if (sel?.kind === 'wall') {
      const i = wallIndex(s, sel.id);
      if (i < 0) return null;
      return { name: `Wand ${i + 1}`, color: s.walls[i].color, palette: WALL_COLORS, kind: 'wand', paint: s.walls[i].paint,
        apply: (c, paint) => this.recolor(sel.id, c, (n) => { n.walls[i].color = c; n.walls[i].paint = paint; }) };
    }
    if (sel?.kind === 'panel') {
      const f = findPanel(s, sel.id);
      if (!f) return null;
      return { name: this.catalog.panels[f.panel.type]?.label ?? 'Paneel', color: f.panel.color, palette: FURNITURE_COLORS, kind: 'paneel', paint: f.panel.paint,
        apply: (c, paint) => this.recolor(sel.id, c, (n) => { const x = n.walls[f.wallIndex].panels.find((y) => y.id === sel.id)!; x.color = c; x.paint = paint; }) };
    }
    if (sel?.kind === 'floor') {
      return { name: 'Boden', color: s.floor.color, palette: FLOOR_COLORS, kind: 'boden', apply: (c) => this.recolor('floor', c, (n) => { n.floor.color = c; n.floor.paint = undefined; }) };
    }
    if (sel?.kind === 'ceiling') {
      return { name: 'Decke', color: s.ceiling.color, palette: WALL_COLORS, kind: 'wand', paint: s.ceiling.paint,
        apply: (c, paint) => this.recolor('ceiling', c, (n) => { n.ceiling.color = c; n.ceiling.paint = paint; }) };
    }
    const same = s.walls.every((w) => w.paint?.url === s.walls[0]?.paint?.url && w.paint?.variant === s.walls[0]?.paint?.variant);
    return { name: 'Alle Wände', color: s.walls[0]?.color ?? '#ffffff', palette: WALL_COLORS, kind: 'wand', paint: same ? s.walls[0]?.paint : undefined, apply: (c, paint) => {
      const next = clone(s);
      for (const w of next.walls) { w.color = c; w.paint = paint; this.viewer.setColor(w.id, c); }
      this.apply(next, false);
    } };
  }

  private colorMenu(): Child[] {
    const t = this.colorTarget();
    if (!t) return [h('p', { class: 'dm-muted' }, 'Bitte etwas auswählen.')];
    const pick = (c: string) => { t.apply(c); this.renderMenu(); };
    const sel = this.selection;
    const obj = sel?.kind === 'object' ? this.scene!.objects.find((x) => x.id === sel.id) : undefined;
    const own = !t.paint;
    return [
      h('p', {}, 'Farbe für ', h('strong', {}, t.name), sel ? '' : ' (oder tippe etwas im Bild an)'),
      obj && this.variantPicker(obj),
      !sel && h('div', { class: 'dm-row', style: 'margin-bottom:10px' },
        h('button', { class: 'dm-btn small', onclick: () => this.viewer.setSelection({ kind: 'floor' }, true) }, 'Boden'),
        h('button', { class: 'dm-btn small', onclick: () => this.viewer.setSelection({ kind: 'ceiling' }, true) }, 'Decke')),
      ...this.paintPicker(t.kind, t.paint, (p) => { t.apply(p.paint!.hex, paintRef(p)); this.renderMenu(); }),
      this.paintsFor(t.kind).length ? h('h4', {}, 'Freie Farbtöne') : '',
      h('div', { class: 'dm-swatches' }, t.palette.map((c) =>
        h('button', {
          class: `dm-swatch${own && c.toLowerCase() === t.color.toLowerCase() ? ' active' : ''}`,
          style: `background:${c}`, title: c, onclick: () => pick(c),
        }))),
      field('Eigene Farbe', colorInput(t.color, pick)),
    ];
  }

  /** Farben aus dem Shop, die zu Wand, Möbel oder Paneel passen (mit Farbcode). */
  private paintsFor(kind: PaintKind): ShopProduct[] {
    if (kind === 'boden') return [];
    return this.paintProducts.filter((p) => p.paint?.hex && (kind === 'paneel' || paintUse(p) === kind));
  }

  /** Shop-Farben als Farbfelder je Unterkategorie, dazu das gewählte Produkt und passendes Zubehör. */
  private paintPicker(kind: PaintKind, current: Product | undefined, choose: (p: ShopProduct) => void): Child[] {
    const list = this.paintsFor(kind);
    if (!list.length) return [];
    const subs = new Map<string, ShopProduct[]>();
    for (const p of list) subs.set(p.paint!.sub || 'Farben', [...(subs.get(p.paint!.sub || 'Farben') ?? []), p]);
    const isCur = (p: ShopProduct) => !!current && current.url === p.url && (current.variant ?? '') === (p.paint?.shade ?? '');
    const cur = list.find(isCur);
    const out: Child[] = [];
    for (const [sub, items] of subs) {
      out.push(h('h4', {}, sub), h('div', { class: 'dm-swatches dm-paints' }, items.map((p) => h('button', {
        class: `dm-swatch dm-paint${isCur(p) ? ' active' : ''}`, style: `background:${p.paint!.hex}`,
        title: `${p.paint!.shade} · ${p.paint!.product || p.name}${p.paint!.maker ? ` (${p.paint!.maker})` : ''}`, onclick: () => choose(p),
      }, h('span', {}, p.paint!.shade)))));
    }
    if (cur) {
      out.splice(0, 0, h('div', { class: 'dm-paintcard' },
        h('span', { class: 'dm-paintchip', style: `background:${cur.paint!.hex}` }),
        h('a', { class: 'dm-favlink', href: this.shopLink(cur.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' }, productImage(cur),
          h('span', { class: 'dm-product-text' }, h('strong', {}, cur.paint!.shade),
            h('span', { class: 'dm-muted small' }, [cur.paint!.product || cur.name, cur.paint!.maker, cur.price != null ? euro(cur.price) : ''].filter(Boolean).join(' · '))))));
    }
    // Grundierung, Versiegelung: ohne Farbfeld, nur als Link
    const extras = this.paintProducts.filter((p) => !p.paint?.hex && (kind === 'paneel' || paintUse(p) === kind));
    if (extras.length) {
      out.push(h('details', { class: 'dm-toolset' }, h('summary', {}, `Dazu passend (${extras.length})`),
        h('div', { class: 'dm-favs-list' }, extras.map((p) => this.toolProductRow(p, [p.paint?.sub, p.paint?.shade].filter(Boolean).join(', '))))));
    }
    return out;
  }

  // ------------------------------------------------------------------ Produkte und Einkaufsliste

  private shopLink(url: string): string {
    if (!this.amazonTag || shopOf(url) !== 'amazon') return url;
    try {
      const u = new URL(url);
      if (!u.searchParams.has('tag')) u.searchParams.set('tag', this.amazonTag);
      return u.toString();
    } catch {
      return url;
    }
  }

  private productCard(p: Product, link = true): HTMLElement {
    return h('div', { class: 'dm-product' },
      productImage(p),
      h('div', { class: 'dm-product-text' },
        h('strong', {}, p.name || 'Produkt'),
        h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.variant && (p.variants?.length ?? 0) > 1 ? p.variant : '', p.price != null ? euro(p.price) : ''].filter(Boolean).join(' · '))),
      link && h('a', { class: 'dm-btn small', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener' }, 'Zum Shop'));
  }

  /** Farbvarianten eines Produkts als Auswahl (nur wenn es mehrere gibt). */
  private variantPicker(o: SceneObject): HTMLElement | null {
    const vs = o.product?.variants;
    if (!vs || vs.length < 2) return null;
    const current = o.product?.variant ?? vs.find((v) => v.color.toLowerCase() === o.color.toLowerCase())?.name;
    return h('div', { class: 'dm-field' },
      h('span', {}, 'Farbvariante'),
      h('div', { class: 'dm-variants' }, vs.map((v) => h('button', {
        class: `dm-chip dm-variant${v.name === current ? ' active' : ''}`,
        onclick: () => {
          this.recolor(o.id, v.color, (n) => {
            const x = n.objects.find((y) => y.id === o.id)!;
            x.color = v.color;
            if (x.product) x.product.variant = v.name;
          });
          this.renderMenu();
        },
      }, h('i', { style: `background:${v.color}` }), v.name))));
  }

  /** Katalog: Reiter Regale / Möbel / Deko (aus der Produkttabelle) und Eigene (einfache Formen, per Link). */
  private catalogView(back: boolean): Child[] {
    const counts: Record<FurnTab, number> = { favs: 0, regale: 0, moebel: 0, deko: 0, formen: 0, bauteile: 0 };
    if (this.furnTab === 'bauteile' && !this.inDiy) this.furnTab = null;
    for (const p of this.products) {
      counts[productGroup(p, this.catalog)]++;
      if (this.favs.has(p.id)) counts.favs++;
    }
    if (!this.furnTab) this.furnTab = this.products.length ? (['deko', 'moebel', 'regale'] as FurnTab[]).find((t) => counts[t]) ?? 'formen' : 'formen';
    const tab = this.furnTab;
    const tabBtn = (t: FurnTab, label: string | Node) => h('button', {
      class: `dm-tab${tab === t ? ' active' : ''}`, title: t === 'favs' ? 'Gemerkte Produkte' : '',
      onclick: () => { this.furnTab = t; this.shopFilter = 'all'; this.productQuery = ''; this.renderMenu(); },
    }, label, t !== 'formen' && t !== 'bauteile' && counts[t] ? h('span', { class: 'dm-count' }, String(counts[t])) : '');
    const out: Child[] = [];
    if (back) {
      const sel = this.selection;
      const o = sel?.kind === 'object' ? this.scene?.objects.find((x) => x.id === sel.id) : undefined;
      out.push(h('div', { class: 'dm-selcard' },
        h('span', {}, h('strong', {}, o?.label || 'Möbel'), ' ist ausgewählt'),
        h('button', { class: 'dm-btn small', onclick: () => this.editObject() }, 'Anpassen')));
    }
    out.push(h('div', { class: 'dm-tabs dm-tabs-tight', style: 'margin-top:0' },
      tabBtn('deko', 'Deko'), tabBtn('moebel', 'Möbel'), tabBtn('regale', 'Regale'), tabBtn('formen', 'Eigene'), tabBtn('favs', icon(ICON_HEART))));

    if (tab === 'formen') {
      const cats = Object.keys(this.catalog.categories) as Category[];
      const chips = (list: Category[]) => h('div', { class: 'dm-grid' }, list.map((c) =>
        h('button', { class: 'dm-chip', onclick: () => this.placeNew(c) }, '+ ', this.catalog.categories[c].label)));
      out.push(
        h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Einfache Formen in Standardgröße, oder ein Produkt aus einem beliebigen Shop per Link.'),
        h('button', { class: 'dm-btn small', style: 'margin-bottom:10px', onclick: () => this.showAddByLink() }, '+ Produkt per Link'),
        h('h4', {}, 'Möbel'),
        chips(cats.filter((c) => !this.catalog.categories[c].group)),
        h('h4', {}, 'Deko'),
        chips(cats.filter((c) => this.catalog.categories[c].group === 'deko')));
      if (!this.inDiy) {
        out.push(h('h4', {}, 'Meine DIY-Möbel'),
          h('div', { class: 'dm-col' },
            this.builds.filter((b) => b.scene.objects.length).map((b) => h('button', { class: 'dm-chip', onclick: () => this.placeBuild(b.id) }, '+ ', b.name)),
            h('button', { class: 'dm-btn small', onclick: () => this.enterDiy(this.builds.length ? undefined : 'new') }, this.builds.length ? 'DIY-Bereich öffnen' : '+ Eigenes Möbel bauen')));
      }
      return out;
    }

    const inTab = this.inTab(tab);
    if (tab === 'favs' && !inTab.length) {
      out.push(h('p', { class: 'dm-muted small' }, 'Noch nichts gemerkt. Tippe bei einem Produkt auf das Herz, dann findest du es hier wieder.'));
      return out;
    }
    const shops = (['ikea', 'amazon', 'other'] as Product['source'][]).filter((src) => inTab.some((p) => p.source === src));
    if (shops.length > 1) {
      const chip = (f: 'all' | Product['source'], label: string) => h('button', {
        class: `dm-pill${this.shopFilter === f ? ' active' : ''}`,
        onclick: () => { this.shopFilter = f; this.refreshProductList(); this.renderMenu(); },
      }, label);
      const order: Product['source'][] = ['amazon', 'ikea', 'other'];
      out.push(h('div', { class: 'dm-pills' }, ...order.filter((src) => shops.includes(src)).map((src) => chip(src, SHOP_LABEL[src])), chip('all', 'Alle')));
    }
    if (inTab.length > 6) {
      const search = h('input', { class: 'dm-input', type: 'search', placeholder: 'Suchen …', value: this.productQuery }) as HTMLInputElement;
      search.addEventListener('input', () => { this.productQuery = search.value; this.refreshProductList(); });
      out.push(search);
    }
    out.push(this.productList(inTab));
    out.push(h('div', { class: 'dm-row', style: 'margin-top:8px' },
      h('button', { class: 'dm-btn small ghost', onclick: () => this.showShoppingList() }, 'Einkaufsliste')));
    return out;
  }

  private refreshProductList(): void {
    const tab = this.furnTab;
    const body = this.elPop.querySelector('.dm-product-list');
    if (!tab || tab === 'formen' || !body) return;
    body.replaceWith(this.productList(this.inTab(tab)));
  }

  private inTab(tab: FurnTab): ShopProduct[] {
    return this.products.filter((p) => (tab === 'favs' ? this.favs.has(p.id) : productGroup(p, this.catalog) === tab))
      .sort((a, b) => productRank(b) - productRank(a) || a.name.localeCompare(b.name, 'de'));
  }

  private productList(items: ShopProduct[]): HTMLElement {
    const q = this.productQuery.trim().toLowerCase();
    const list = items.filter((p) => (this.shopFilter === 'all' || p.source === this.shopFilter)
      && (!q || `${p.name} ${SHOP_LABEL[p.source]} ${this.catalog.categories[p.category]?.label}`.toLowerCase().includes(q)));
    return h('div', { class: 'dm-product-list' },
      list.length ? list.map((p) => h('div', {
        class: 'dm-product pick', title: 'In den Raum setzen', role: 'button', tabindex: 0,
        onclick: () => this.addProduct(p),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.stopPropagation(); this.addProduct(p); } },
      },
        productImage(p),
        h('div', { class: 'dm-product-text' },
          h('strong', {}, p.name),
          h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.size.map((v) => Math.round(v * 100)).join(' × ') + ' cm', p.price != null ? euro(p.price) : ''].filter(Boolean).join(' · ')),
          (p.variants?.length ?? 0) > 1 && h('span', { class: 'dm-dots', title: p.variants!.map((v) => v.name).join(', ') },
            p.variants!.slice(0, 8).map((v) => h('i', { style: `background:${v.color}` })))),
        h('button', {
          class: `dm-fav${this.favs.has(p.id) ? ' active' : ''}`, title: this.favs.has(p.id) ? 'Von der Merkliste nehmen' : 'Produkt merken',
          onclick: (e: Event) => {
            e.stopPropagation();
            this.toggleFav({ key: p.id, name: p.name, url: p.url, image: p.image || undefined, source: p.source, price: p.price });
            if (this.furnTab === 'favs') this.renderMenu();
            else (e.currentTarget as HTMLElement).classList.toggle('active', this.favs.has(p.id));
          },
        }, icon(ICON_HEART)),
        h('span', { class: 'dm-product-add' }, '+')))
        : h('p', { class: 'dm-muted small' }, 'Nichts gefunden.'));
  }

  private addProduct(p: ShopProduct): void {
    this.placeNew(p.category, {
      label: p.name,
      size: [...p.size] as [number, number, number],
      color: p.variants?.[0]?.color ?? p.color,
      product: {
        source: p.source, name: p.name, url: p.url, sku: '', image: p.image || undefined, price: p.price, catalog_id: p.id,
        ...((p.variants?.length ?? 0) > 1 ? { variants: p.variants, variant: p.variants![0].name } : {}),
      },
    });
  }

  /** Eigenes Produkt: Link einfügen, Maße selbst eintragen. */
  private showAddByLink(): void {
    const url = h('input', { class: 'dm-input', type: 'url', placeholder: 'https://www.ikea.com/de/de/p/…' }) as HTMLInputElement;
    const name = h('input', { class: 'dm-input', placeholder: 'z. B. Bücherregal weiß' }) as HTMLInputElement;
    const cats = Object.keys(this.catalog.categories) as Category[];
    const cat = h('select', { class: 'dm-input' }, cats.map((c) => h('option', { value: c }, this.catalog.categories[c].label))) as HTMLSelectElement;
    const num = (ph: string) => h('input', { class: 'dm-input', type: 'number', min: 1, max: 1000, step: 1, placeholder: ph }) as HTMLInputElement;
    const w = num('B'), d = num('T'), hh = num('H');
    const price = h('input', { class: 'dm-input', type: 'number', min: 0, step: 0.01, placeholder: 'optional' }) as HTMLInputElement;
    const color = h('input', { type: 'color', class: 'dm-color', value: '#c9b8a0' }) as HTMLInputElement;
    cat.addEventListener('change', () => {
      const c = this.catalog.categories[cat.value as Category];
      w.placeholder = String(Math.round(c.size[0] * 100));
      d.placeholder = String(Math.round(c.size[1] * 100));
      hh.placeholder = String(Math.round(c.size[2] * 100));
      color.value = c.color;
    });
    cat.dispatchEvent(new Event('change'));
    const err = h('p', { class: 'dm-error', hidden: true });
    this.showOverlay(h('div', { class: 'dm-card' },
      h('h2', {}, 'Produkt per Link einfügen'),
      h('p', { class: 'dm-muted' }, 'Kopiere den Link von der Produktseite (IKEA, Amazon oder ein anderer Shop) und trage die Maße aus der Produktbeschreibung ein. Das Teil kommt in echter Größe in den Raum und auf die Einkaufsliste.'),
      field('Link zum Produkt', url),
      field('Name', name),
      field('Art (bestimmt die Form)', cat),
      h('div', { class: 'dm-row three' }, field('Breite cm', w), field('Tiefe cm', d), field('Höhe cm', hh)),
      h('div', { class: 'dm-row three' }, field('Preis €', price), field('Farbe', color)),
      err,
      h('div', { class: 'dm-row end' },
        h('button', { class: 'dm-btn ghost', onclick: () => this.hideOverlay() }, 'Abbrechen'),
        h('button', { class: 'dm-btn primary', onclick: () => {
          const link = url.value.trim();
          if (!/^https?:\/\//.test(link)) {
            err.textContent = 'Bitte einen Link beginnend mit https:// einfügen.';
            err.hidden = false;
            return;
          }
          const c = this.catalog.categories[cat.value as Category];
          const val = (el: HTMLInputElement, i: number) => (Number(el.value) > 0 ? m(Number(el.value)) : c.size[i]);
          const label = name.value.trim() || c.label;
          this.hideOverlay();
          this.placeNew(cat.value as Category, {
            label, color: color.value,
            size: [val(w, 0), val(d, 1), val(hh, 2)],
            product: { source: shopOf(link), name: label, url: link, sku: '', price: price.value ? Number(price.value) : null },
          });
        } }, 'Einfügen')),
    ));
  }

  /** Alle verlinkten Produkte der Wohnung mit Summe. */
  private showShoppingList(): void {
    this.sheet = 'shop';
    this.renderSheet();
  }

  /** Produkte der Einkaufsliste: gleiche zusammengefasst, mit Anzahl und Räumen. */
  private shopRows(): { rows: ShopRow[]; hidden: number; total: number; missing: number } {
    const groups = new Map<string, ShopRow>();
    let hidden = 0;
    (this.home?.rooms ?? []).forEach((r, i) => {
      for (const o of r.scene.objects.flatMap((x) => (x.parts?.length ? x.parts : [x]))) {
        if (!o.product?.url) continue;
        if (o.skipShop) { hidden++; continue; }
        const key = `${o.product.url}|${o.product.variant ?? ''}`;
        const g = groups.get(key) ?? { key, p: o.product, label: o.label || o.product.name, count: 0, rooms: new Set<string>() };
        g.count++;
        g.rooms.add(r.scene.room.name || `Raum ${i + 1}`);
        groups.set(key, g);
      }
    });
    // Farben aus dem Shop: Fläche zusammenzählen, daraus die Zahl der Eimer/Dosen (2 Anstriche, ca. 10 m² je Liter)
    const skip = new Set(this.home?.skipPaints ?? []);
    const hiddenPaints = new Set<string>();
    const paints = new Map<string, { p: Product; area: number; rooms: Set<string> }>();
    const addPaint = (paint: Product | undefined, area: number, room: string) => {
      if (!paint?.url) return;
      const key = `paint:${paint.url}|${paint.variant ?? ''}`;
      if (skip.has(key)) { if (!hiddenPaints.has(key)) { hiddenPaints.add(key); hidden++; } return; }
      const g = paints.get(key) ?? { p: paint, area: 0, rooms: new Set<string>() };
      g.area += Math.max(0, area);
      g.rooms.add(room);
      paints.set(key, g);
    };
    const box = (sz: number[]) => 2 * (sz[0] * sz[2] + sz[1] * sz[2]) + sz[0] * sz[1];
    (this.home?.rooms ?? []).forEach((r, i) => {
      const sc = r.scene;
      const room = sc.room.name || `Raum ${i + 1}`;
      const poly = sc.room.polygon;
      sc.walls.forEach((w, k) => {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
        addPaint(w.paint, len * sc.room.height - w.openings.reduce((sum, o) => sum + o.width * o.height, 0), room);
        for (const pn of w.panels) addPaint(pn.paint, (pn.width ?? len) * pn.height, room);
      });
      addPaint(sc.ceiling.paint, polygonArea(poly), room);
      for (const o of sc.objects.flatMap((x) => (x.parts?.length ? [x, ...x.parts] : [x]))) addPaint(o.paint, box(o.size), room);
    });
    for (const [key, g] of paints) {
      const liters = (g.area * 2) / 10;
      const can = canLiters(g.p.name);
      const count = can ? Math.max(1, Math.ceil(liters / can)) : 1;
      const label = g.p.variant ? `${g.p.variant} – ${g.p.name}` : g.p.name;
      groups.set(key, { key, p: g.p, label, count, rooms: g.rooms,
        note: `für ca. ${String(Math.round(g.area * 10) / 10).replace('.', ',')} m², 2 Anstriche${can ? ` ≈ ${String(Math.round(liters * 10) / 10).replace('.', ',')} l` : ''}` });
    }
    const rows = [...groups.values()];
    const priced = rows.filter((g) => g.p.price != null);
    const total = priced.reduce((sum, g) => sum + (g.p.price ?? 0) * g.count, 0);
    return { rows, hidden, total, missing: rows.length - priced.length };
  }

  private printShopList(): void {
    const { rows, total, missing } = this.shopRows();
    this.printList('shop', rows.map((g) => ({
      name: g.label, url: g.p.url, image: g.p.image, source: g.p.source, price: g.p.price, count: g.count,
      variant: g.p.variant && (g.p.variants?.length ?? 0) > 1 ? g.p.variant : '', rooms: [[...g.rooms].join(', '), g.note].filter(Boolean).join(' · '),
    })), total, missing);
  }

  private shopSheet(): SheetContent | null {
    if (!this.home) return null;
    const { rows, hidden, total, missing } = this.shopRows();
    const priced = rows.filter((g) => g.p.price != null);
    const sel = this.selection;
    const so = sel?.kind === 'object' ? this.scene?.objects.find((x) => x.id === sel.id) : undefined;
    const current = so?.product?.url ? `${so.product.url}|${so.product.variant ?? ''}` : '';
    const amazon = rows.some((g) => g.p.source === 'amazon');
    return {
      title: `${this.inDiy ? 'Materialliste' : 'Einkaufsliste'}${rows.length ? ` (${rows.reduce((n, g) => n + g.count, 0)})` : ''}`,
      body: [
        ...(this.inDiy && this.scene ? this.materialView(materials(this.scene, this.catalog), this.scene) : []),
        ...(!this.inDiy ? this.placedBuilds().flatMap((b) => [h('h4', { class: 'dm-diyhead' }, `DIY-Möbel: ${b.name}`), ...this.materialView(materials(b.scene, this.catalog), b.scene)]) : []),
        this.inDiy && rows.length > 0 && h('h4', {}, 'Produkte'),
        rows.length
          ? h('div', { class: 'dm-favs-list' }, rows.map((g) => h('div', { class: `dm-favrow${g.key === current ? ' current' : ''}` },
            h('a', { class: 'dm-favlink', href: this.shopLink(g.p.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' },
              productImage(g.p),
              h('span', { class: 'dm-product-text' },
                h('strong', {}, (g.count > 1 ? `${g.count} × ` : '') + g.label),
                h('span', { class: 'dm-muted small' }, [
                  SHOP_LABEL[g.p.source], g.p.variant && (g.p.variants?.length ?? 0) > 1 ? g.p.variant : '',
                  g.p.price != null ? euro(g.p.price * g.count) : 'Preis im Shop', [...g.rooms].join(', '), g.note ?? '',
                ].filter(Boolean).join(' · ')))),
            h('button', { class: 'dm-btn small ghost', title: 'Aus der Einkaufsliste nehmen (bleibt im Raum)', onclick: () => this.setSkipShop(g.key, true) }, '✕'))))
          : h('p', { class: 'dm-muted small' }, this.inDiy
            ? 'Noch keine Produkte im Bauplan. Unter „Möbel“ findest du Möbel und Bauteile.'
            : 'Noch keine Produkte im Projekt. Unter „Möbel“ findest du Produkte oder fügst eines per Link ein.'),
        rows.length > 0 && (priced.length
          ? h('p', { class: 'dm-shoplist-total' }, h('strong', {}, `Summe: ${euro(total)}`),
            missing ? h('span', { class: 'dm-muted small' }, ` plus ${missing} Produkt${missing > 1 ? 'e' : ''} ohne Preisangabe`) : '')
          : h('p', { class: 'dm-muted small' }, 'Für diese Produkte ist kein Preis hinterlegt, den aktuellen Preis zeigt der Shop.')),
        priced.length > 0 && h('p', { class: 'dm-muted small' }, 'Preise wie hinterlegt, der aktuelle Preis steht im Shop.'),
        hidden > 0 && h('p', { class: 'dm-muted small' }, `${hidden} Produkt${hidden > 1 ? 'e' : ''} ausgeblendet. `,
          h('button', { class: 'dm-link', onclick: () => this.setSkipShop(null, false) }, 'Wieder anzeigen')),
        amazon && this.amazonTag && h('p', { class: 'dm-muted small' }, 'Als Amazon-Partner verdienen wir an qualifizierten Verkäufen.'),
      ],
      actions: [h('button', { class: 'dm-btn small', onclick: () => this.printShopList() }, icon(ICON_PDF), ' PDF mit Werkzeug und Anleitung')],
    };
  }

  /** Produkt aus der Einkaufsliste nehmen oder alle wieder aufnehmen (key = null). */
  private setSkipShop(key: string | null, skip: boolean): void {
    if (!this.home) return;
    const next: Home = structuredClone(this.home);
    if (key === null) next.skipPaints = undefined;
    else if (key.startsWith('paint:')) next.skipPaints = skip ? [...new Set([...(next.skipPaints ?? []), key])] : (next.skipPaints ?? []).filter((k) => k !== key);
    for (const r of next.rooms) for (const o of r.scene.objects) {
      if (!o.product?.url) continue;
      if (key === null || `${o.product.url}|${o.product.variant ?? ''}` === key) o.skipShop = skip || undefined;
    }
    this.applyHome(next, false);
    this.renderSheet();
  }

  /** Liste als druckbare Seite öffnen, dort „Als PDF speichern“. */
  private printList(kind: 'shop' | 'favs', rows: PrintRow[], total = 0, missing = 0): void {
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const title = kind === 'shop' ? (this.inDiy ? 'Materialliste' : 'Einkaufsliste') : 'Merkliste';
    const project = this.project?.name || this.scene?.room.name || 'Raumplaner';
    const date = new Date().toLocaleDateString('de-DE');
    const items = rows.map((r) => {
      const link = this.shopLink(r.url);
      const meta = [SHOP_LABEL[r.source], r.variant, r.rooms].filter(Boolean).join(' · ');
      return `<tr><td class="img">${r.image ? `<img src="${esc(r.image)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ''}</td>
        <td><strong>${r.count && r.count > 1 ? `${r.count} × ` : ''}${esc(r.name)}</strong><br><span class="m">${esc(meta)}</span><br><a href="${esc(link)}">${esc(link)}</a></td>
        <td class="p">${r.price != null ? esc(euro(r.price * (r.count ?? 1))) : '<span class="m">Preis im Shop</span>'}</td></tr>`;
    }).join('');
    const sum = kind === 'shop' && total > 0
      ? `<p class="sum">Summe: ${esc(euro(total))}${missing ? ` <span class="m">plus ${missing} ohne Preisangabe</span>` : ''}</p>` : '';
    const tools = kind === 'shop' ? this.projectTools() : [];
    const toolLi = (x: DiyTool) => {
      const list = findToolProducts(x, this.toolProducts);
      if (!list.length) return /blatt/.test(x.match.join()) ? '' : `<li><strong>${esc(x.name)}</strong>${x.note ? ` <span class="m">· ${esc(x.note)}</span>` : ''}</li>`;
      return list.map((p) => {
      const link = this.shopLink(p.url);
      return `<li class="tp">${p.image ? `<img src="${esc(p.image)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ''}<span><strong>${esc(x.name)}</strong>: ${esc(p.name)}${p.price != null ? ` · ${esc(euro(p.price))}` : ''}<br><a href="${esc(link)}">${esc(link)}</a></span></li>`;
      }).join('');
    };
    const toolHtml = tools.length ? `<h2>Werkzeug und Anleitung</h2>${tools.map((t) => `<section><h3>${esc(t.title)}</h3><ul>${t.tools.map(toolLi).join('')}</ul>
      <p class="gh">Anleitung</p><ol>${t.guide.map((g) => `<li>${esc(g)}</li>`).join('')}</ol></section>`).join('')}` : '';
    // DIY-Möbel: Zuschnitt, Schrauben und Bohrplan
    const plans = kind === 'shop' ? (this.inDiy ? [this.build].filter((b): b is DiyBuild => !!b) : this.placedBuilds()).filter((b) => b.scene.objects.length) : [];
    const num = (v: number) => String(v).replace('.', ',');
    const li = (list: { label: string; size?: string; count: number }[]) => list.map((r) => `<li><strong>${r.count} × ${esc(r.label)}</strong>${r.size ? ` <span class="m">· ${esc(r.size)}</span>` : ''}</li>`).join('');
    const diyHtml = plans.map((b) => {
      const mat = materials(b.scene, this.catalog);
      const c = (v: number) => num(Math.round(v * 1000) / 10);
      return `<h2>DIY-Möbel: ${esc(b.name)}</h2><p class="m">Außenmaße ${c(mat.size[0])} × ${c(mat.size[1])} × ${c(mat.size[2])} cm (Breite × Tiefe × Höhe)</p>
        ${mat.cuts.length ? `<h3>Zuschnitt</h3><ul>${li(mat.cuts)}</ul>` : ''}
        ${mat.furniture.length ? `<h3>Möbel</h3><ul>${li(mat.furniture)}</ul>` : ''}
        ${mat.hardware.length ? `<h3>Kleinteile</h3><ul>${li(mat.hardware)}</ul>` : ''}
        ${mat.screws.length ? `<h3>Schrauben</h3><ul>${mat.screws.map((r) => {
          const p = this.screwProduct(r.dia, r.len);
          return `<li><strong>${r.count} × ${esc(r.label)}</strong> <span class="m">· vorbohren ${num(r.pilot)} mm</span>${p ? `<br><span class="m">Passend: ${esc(p.name)}</span> <a href="${esc(this.shopLink(p.url))}">${esc(this.shopLink(p.url))}</a>` : ''}</li>`;
        }).join('')}</ul>` : ''}
        ${b.scene.diyHardware?.length ? `<h3>Verbindungen und Beschläge</h3><ul>${b.scene.diyHardware.map((r) => `<li><strong>${r.count} × ${esc(r.product.name)}</strong>${r.sub ? ` <span class="m">· ${esc(r.sub)}</span>` : ''}<br><a href="${esc(this.shopLink(r.product.url))}">${esc(this.shopLink(r.product.url))}</a></li>`).join('')}</ul>` : ''}
        ${mat.joints.length ? `<h3>Bohrplan</h3><ol>${mat.joints.map((j) => `<li><strong>${esc(this.jointLabel(j))}</strong>: ${j.screws.length} × ${num(j.dia)} × ${j.len} mm.
          <span class="m">Kontaktfläche ${num(j.area[0])} × ${num(j.area[1])} cm, Bohrpunkte von der Ecke gemessen (cm): ${j.points.map((p) => `${num(p[0])} / ${num(p[1])}`).join(' · ')}</span></li>`).join('')}</ol>` : ''}`;
    }).join('');
    const amazon = this.amazonTag && rows.some((r) => r.source === 'amazon') ? '<p class="m">Als Amazon-Partner verdienen wir an qualifizierten Verkäufen.</p>' : '';
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)} – ${esc(project)}</title><style>
      body{font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#2b2724;margin:28px}
      h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 6px}h3{font-size:13px;margin:12px 0 4px}
      .m{color:#7a716b;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:14px}
      td{border-bottom:1px solid #e6e0da;padding:8px 6px;vertical-align:top}td.img{width:64px}td.img img{width:60px;height:60px;object-fit:contain}
      td.p{text-align:right;white-space:nowrap}a{color:#b8456f;font-size:11px;word-break:break-all}.sum{text-align:right;font-size:15px;font-weight:600}
      ul,ol{margin:0;padding-left:18px}li{margin:2px 0}li.tp{list-style:none;margin-left:-18px;display:flex;gap:8px;align-items:center}
      li.tp img{width:40px;height:40px;object-fit:contain}.gh{font-weight:600;margin:8px 0 2px}section{break-inside:avoid;margin-bottom:10px}@media print{body{margin:12mm}.noprint{display:none}}
      .noprint{margin-bottom:16px}button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #c9bfb7;background:#fff;cursor:pointer}
    </style></head><body>
      <div class="noprint"><button onclick="print()">Als PDF speichern / drucken</button></div>
      <h1>${esc(title)}</h1><p class="m">${esc(project)} · ${esc(date)} · DIY Mamis Raumplaner</p>
      <table>${items}</table>${sum}${diyHtml}${toolHtml}${amazon}
      <script>window.addEventListener('load',function(){setTimeout(function(){print()},300)});<\/script>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { this.toast('Bitte Pop-ups für diese Seite erlauben, dann klappt der PDF-Download.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  // ------------------------------------------------------------------ Möbel anpassen

  private furnitureMenu(): Child[] {
    const s = this.scene!;
    const sel = this.selection;
    const o = sel?.kind === 'object' ? s.objects.find((x) => x.id === sel.id) : undefined;
    if (!o || this.furnAdd) return this.catalogView(!!o);
    const update = (mutate: (x: SceneObject) => void, rebuild: boolean) => {
      const next = clone(s);
      mutate(next.objects.find((x) => x.id === o.id)!);
      return this.apply(next, rebuild);
    };
    const sizeInput = (axis: 0 | 1 | 2) =>
      numberInput(cm(o.size[axis]), 0.1, 1000, (v) => update((x) => (x.size[axis] = m(v)), true), 'cm');
    return [
      field('Bezeichnung', h('input', {
        class: 'dm-input', value: o.label,
        onchange: (e: Event) => update((x) => (x.label = (e.target as HTMLInputElement).value), false).then(() => this.renderPanel()),
      })),
      o.parts?.length
        ? h('div', { class: 'dm-col' },
          h('p', { class: 'dm-muted small', style: 'margin:0' }, `DIY-Möbel aus ${o.parts.length} Teilen, ${String(cm(o.size[0])).replace('.', ',')} × ${String(cm(o.size[1])).replace('.', ',')} × ${String(cm(o.size[2])).replace('.', ',')} cm`),
          this.builds.some((b) => b.id === o.diyId) && h('button', { class: 'dm-btn small', onclick: () => this.enterDiy(o.diyId) }, 'Im DIY-Bereich bearbeiten'))
        : h('div', { class: 'dm-row three' }, field('Breite', sizeInput(0)), field('Tiefe', sizeInput(1)), field('Höhe', sizeInput(2))),
      h('div', { class: 'dm-row three' },
        field('Drehung', numberInput(Math.round(o.rotation), -360, 720, (v) => update((x) => (x.rotation = ((v % 360) + 360) % 360), true), '°')),
        field('Über Boden', numberInput(cm(o.position[2]), 0, 300, (v) => update((x) => (x.position[2] = m(v)), true), 'cm'))),
      o.product?.url && this.productCard(o.product, false),
      this.variantPicker(o),
      o.product?.url && (() => {
        const pr = o.product!;
        const key = pr.catalog_id || pr.url;
        const on = this.favs.has(key);
        return h('div', { class: 'dm-row dm-product-actions' },
          h('a', { class: 'dm-btn primary', href: this.shopLink(pr.url), target: '_blank', rel: 'sponsored noopener' }, 'Produkt ansehen'),
          h('button', {
            class: `dm-btn${on ? ' active' : ''}`,
            onclick: () => { this.toggleFav({ key, name: o.label || pr.name, url: pr.url, image: pr.image, source: pr.source, price: pr.price }); this.renderMenu(); },
          }, icon(ICON_HEART), on ? 'Gemerkt' : 'Produkt merken'));
      })(),
      h('details', { class: 'dm-details' },
        h('summary', {}, o.product?.url ? 'Produkt-Link ändern' : 'Produkt-Link hinzufügen'),
        h('input', {
          class: 'dm-input', type: 'url', placeholder: 'https://…', value: o.product?.url ?? '',
          onchange: (e: Event) => update((x) => {
            const url = (e.target as HTMLInputElement).value.trim();
            x.product = url ? { ...(x.product ?? {}), source: shopOf(url), name: x.product?.name || x.label, url, sku: x.product?.sku ?? '' } : null;
          }, false).then(() => this.renderMenu()),
        })),
      h('div', { class: 'dm-row' },
        h('button', { class: 'dm-btn', onclick: () => this.openMenu('color') }, 'Farbe'),
        h('button', { class: 'dm-btn', onclick: () => this.duplicateObject(o.id) }, 'Duplizieren'),
        h('button', { class: 'dm-btn danger', onclick: () => this.deleteObject(o.id) }, 'Entfernen')),
      h('button', { class: 'dm-btn primary', style: 'width:100%;margin-top:12px', onclick: () => { this.furnAdd = true; this.renderMenu(); } }, '+ Weiteres Möbel oder Deko hinzufügen'),
    ];
  }

  // ------------------------------------------------------------------ Style

  private applyStyle(st: StylePreset): void {
    this.rebuildWith((n) => {
      for (const w of n.walls) w.color = st.walls;
      n.floor.material = st.floor[0];
      n.floor.color = st.floor[1];
      n.ceiling.color = st.ceiling;
      for (const o of n.objects) {
        const group = STYLE_GROUP[o.category];
        if (group) o.color = st[group];
      }
      for (const w of n.walls) for (const p of w.panels) p.color = st.panel;
    });
    this.toast(`Stil „${st.name}“ angewendet. Mit ↶ zurück.`);
  }

  private styleMenu(): Child[] {
    const s = this.scene!;
    const sel = this.selection;
    const wi = sel?.kind === 'wall' ? wallIndex(s, sel.id) : sel?.kind === 'panel' ? findPanel(s, sel.id)?.wallIndex ?? -1 : -1;
    const out: Child[] = [
      h('div', { class: 'dm-styles' }, STYLES.map((st) =>
        h('button', { class: 'dm-style', onclick: () => this.applyStyle(st) },
          h('span', { class: 'dm-style-colors' }, [st.walls, st.floor[1], st.upholstery, st.wood].map((c) => h('i', { style: `background:${c}` }))),
          st.name))),
      h('h4', {}, 'Boden'),
      h('select', {
        class: 'dm-input',
        onchange: (e: Event) => {
          const mat = (e.target as HTMLSelectElement).value;
          const color = this.catalog.floor_materials[mat]?.color ?? s.floor.color;
          this.recolor('floor', color, (n) => { n.floor.material = mat; n.floor.color = color; });
          this.renderMenu();
        },
      }, Object.entries(this.catalog.floor_materials).map(([k, v]) => h('option', { value: k, selected: k === s.floor.material }, v.label))),
      h('h4', {}, wi >= 0 ? `Wand ${wi + 1}: Paneele, Fenster, Türen` : 'Paneele, Fenster, Türen'),
    ];
    if (wi < 0) {
      out.push(h('p', { class: 'dm-muted small' }, 'Tippe im Bild auf eine Wand, um Paneele, Fenster oder Türen zu setzen.'));
      return out;
    }
    const w = s.walls[wi];
    out.push(
      h('div', { class: 'dm-row', style: 'flex-wrap:wrap' },
        (Object.keys(this.catalog.panels) as Panel['type'][]).map((t) =>
          h('button', { class: 'dm-btn small', onclick: () => this.rebuildWith((n) => {
            n.walls[wi].panels.push(newPanel(this.catalog, t, n.room.height));
          }) }, `+ ${this.catalog.panels[t].label}`)),
        h('button', { class: 'dm-btn small', onclick: () => this.rebuildWith((n) => {
          n.walls[wi].openings.push({ id: uid('op'), type: 'window', offset: wallLength(n, wi) / 2, width: 1.2, height: 1.3, sill: 0.9 });
        }) }, '+ Fenster'),
        h('button', { class: 'dm-btn small', onclick: () => this.rebuildWith((n) => {
          n.walls[wi].openings.push({ id: uid('op'), type: 'door', offset: Math.min(0.8, wallLength(n, wi) / 2), width: 0.86, height: 2.01, sill: 0 });
        }) }, '+ Tür')),
      ...w.panels.map((p) => this.panelRow(p, wi)),
      ...w.openings.map((op) =>
        h('div', { class: 'dm-wallrow' },
          h('span', {}, `${op.type === 'door' ? 'Tür' : 'Fenster'} · ${cm(op.width)} × ${cm(op.height)} cm`),
          h('button', { class: 'dm-btn small danger', onclick: () => this.rebuildWith((n) => {
            n.walls[wi].openings = n.walls[wi].openings.filter((x) => x.id !== op.id);
          }) }, 'Entfernen'))),
    );
    return out;
  }

  private panelRow(p: Panel, wi: number): HTMLElement {
    const update = (mutate: (x: Panel) => void) => {
      const next = clone(this.scene!);
      mutate(next.walls[wi].panels.find((x) => x.id === p.id)!);
      return this.apply(next, true);
    };
    const open = this.selection?.kind === 'panel' && this.selection.id === p.id;
    return h('details', { class: 'dm-details', open },
      h('summary', {}, this.catalog.panels[p.type]?.label ?? 'Paneel'),
      h('div', { class: 'dm-row three' },
        field('Höhe', numberInput(cm(p.height), 20, 600, (v) => update((x) => (x.height = m(v))), 'cm')),
        field('Start', numberInput(cm(p.offset), 0, 3000, (v) => update((x) => (x.offset = m(v))), 'cm')),
        field('Breite', numberInput(p.width ? cm(p.width) : 0, 0, 3000, (v) => update((x) => (x.width = v > 0 ? m(v) : null)), 'cm'))),
      h('p', { class: 'dm-muted small' }, 'Breite 0 = über die ganze Wand.'),
      h('div', { class: 'dm-row' },
        h('button', { class: 'dm-btn small', onclick: () => { this.viewer.setSelection({ kind: 'panel', id: p.id }, true); this.openMenu('color'); } }, 'Farbe'),
        h('button', { class: 'dm-btn small danger', onclick: () => this.rebuildWith((n) => {
          n.walls[wi].panels = n.walls[wi].panels.filter((x) => x.id !== p.id);
        }) }, 'Entfernen')));
  }

  // ------------------------------------------------------------------ Leiste oben im Bild

  private renderFloating(): void {
    this.renderBench();
    const sel = this.selection;
    const s = this.scene;
    this.elToolbar.replaceChildren();
    const rows: Child[] = [];
    if (this.viewer?.viewMode === 'walk') {
      rows.push(h('div', { class: 'dm-floating-row hint' },
        h('span', {}, matchMedia('(pointer: coarse)').matches ? 'Joystick: gehen · Ziehen: umsehen' : 'W/A/S/D: gehen · Ziehen: umsehen'),
        h('button', { class: 'dm-btn small primary', onclick: () => this.setView('orbit') }, 'Beenden')));
    }
    if (this.tool === 'measure') {
      rows.push(h('div', { class: 'dm-floating-row hint' },
        h('span', {}, 'Messen: zwei Punkte antippen'),
        h('button', { class: 'dm-btn small primary', onclick: () => this.setTool('select') }, 'Fertig')));
    }
    const placing = this.viewer?.placingId;
    if (placing && s && sel?.kind === 'object' && sel.id === placing) {
      const o = s.objects.find((x) => x.id === placing);
      const coarse = matchMedia('(pointer: coarse)').matches;
      rows.push(h('div', { class: 'dm-floating-row placing' },
        h('span', { class: 'dm-floating-name' }, o?.label || 'Möbel'),
        h('span', { class: 'dm-muted small' }, 'Ziehen: verschieben · Bogen: drehen · Pfeil nach oben: Höhe'),
        h('button', { class: 'dm-btn small ghost', onclick: () => this.cancelPlacing() }, 'Abbrechen'),
        h('button', { class: 'dm-btn small primary', onclick: () => this.confirmPlacing() }, coarse ? 'Hier platzieren' : 'Platzieren (Enter)')));
      this.elToolbar.replaceChildren(...rows.filter(Boolean) as Node[]);
      this.elToolbar.hidden = false;
      return;
    }
    if (sel && s && !this.inDiy) {
      const btn = (label: string | Node, onclick: () => void, cls = '') => h('button', { class: `dm-btn small ${cls}`, onclick }, label);
      let name = '';
      const items: Child[] = [];
      if (sel.kind === 'object') {
        const o = s.objects.find((x) => x.id === sel.id);
        name = o?.label || 'Möbel';
        if (o) items.push(this.angleInput(o), btn('↻ 90°', () => this.rotateBy(sel.id, 90)));
        items.push(btn('Farbe', () => this.openMenu('color')), btn('Anpassen', () => this.editObject()),
          btn('Kopie', () => this.duplicateObject(sel.id)), btn(icon(TRASH), () => this.deleteObject(sel.id), 'danger icon'));
      } else if (sel.kind === 'wall') {
        name = `Wand ${wallIndex(s, sel.id) + 1}`;
        items.push(btn('Farbe', () => this.openMenu('color')), btn('Paneele & Fenster', () => this.openMenu('style')));
      } else if (sel.kind === 'panel') {
        name = 'Paneel';
        items.push(btn('Farbe', () => this.openMenu('color')), btn('Maße', () => this.openMenu('style')), btn(icon(TRASH), () => this.removeSelected(), 'danger icon'));
      } else {
        name = sel.kind === 'floor' ? 'Boden' : 'Decke';
        items.push(btn('Farbe', () => this.openMenu('color')));
      }
      rows.push(h('div', { class: 'dm-floating-row' },
        h('span', { class: 'dm-floating-name' }, name), ...items,
        h('button', { class: 'dm-btn small ghost', title: 'Auswahl aufheben', onclick: () => this.viewer.setSelection(null, true) }, '✕')));
    }
    this.elToolbar.append(...rows.filter(Boolean) as Node[]);
    this.elToolbar.hidden = rows.length === 0;
  }

  // ================================================================== Rendering

  private renderImage(): void {
    this.sheet = 'render';
    this.renderSheet();
  }

  private renderSheetContent(): SheetContent {
    const demo = this.opts.demo;
    if (demo?.renderUrl) {
      return { title: 'Foto-Rendering', body: [
        h('img', { src: demo.renderUrl, class: 'dm-render', alt: 'Gerendertes Bild des Raums' }),
        h('p', { class: 'dm-muted small' }, 'Vorab gerendertes Beispielbild, zeigt den Raum vor deinen Änderungen.'),
      ] };
    }
    return { title: 'Foto-Rendering', body: [
      h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Das fotorealistische KI-Rendering der aktuellen Ansicht ist in Arbeit. Bis dahin kannst du die aktuelle 3D-Ansicht als Bild speichern.'),
      h('button', { class: 'dm-btn', onclick: () => this.downloadView() }, 'Ansicht als Bild speichern'),
    ] };
  }

  private downloadView(): void {
    const sel = this.selection;
    this.viewer.setSelection(null, false);
    const url = this.viewer.screenshot();
    if (sel) this.viewer.setSelection(sel, false);
    const a = h('a', { href: url, download: `${(this.project?.name || this.scene?.room.name || 'raum').replace(/[^\w äöüÄÖÜß-]+/g, '')}.png` }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ================================================================== Hilfen

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    if (this.viewer?.placingId) {
      if (e.key === 'Enter') { e.preventDefault(); this.confirmPlacing(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelPlacing(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { this.cancelPlacing(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection?.kind === 'object') this.deleteObject(this.selection.id);
    else if (e.key === 'r' && this.selection?.kind === 'object') this.setGizmo('rotate');
    else if (e.key === 'g' && this.selection?.kind === 'object') this.setGizmo('translate');
    else if (e.key === 'Escape') {
      if (this.tool === 'measure') this.setTool('select');
      else if (this.selection) this.viewer.setSelection(null, true);
      else if (this.viewer.viewMode === 'walk') this.setView('orbit');
      else if (this.menu) this.toggleMenu(this.menu);
    }
  }

  private updateButtons(): void {
    this.btnUndo.disabled = !this.undoStack.length;
    this.btnRedo.disabled = !this.redoStack.length;
  }

  private setBusy(delta: number, label?: string): void {
    this.busy = Math.max(0, this.busy + delta);
    this.root.classList.toggle('dm-busy', this.busy > 0);
    if (label) this.setStatus(label);
  }

  private setStatus(text: string): void {
    this.elStatus.textContent = text;
  }

  private showOverlay(content: Node): void {
    this.elOverlay.replaceChildren(content);
    this.elOverlay.hidden = false;
  }

  private hideOverlay(): void {
    this.elOverlay.hidden = true;
    this.elOverlay.replaceChildren();
    this.updateShift();
  }

  private showProgress(text: string): void {
    this.showOverlay(h('div', { class: 'dm-card center' }, h('div', { class: 'dm-spinner' }), h('p', {}, text)));
  }

  private showError(text: string): void {
    this.showOverlay(h('div', { class: 'dm-card' },
      h('h2', {}, 'Das hat nicht geklappt'),
      h('p', { class: 'dm-error' }, text),
      h('div', { class: 'dm-row end' },
        this.scene && h('button', { class: 'dm-btn ghost', onclick: () => this.hideOverlay() }, 'Zurück zum Raum'),
        h('button', { class: 'dm-btn primary', onclick: () => this.showStart() }, 'Neu versuchen'))));
  }

  private toast(text: string): void {
    const t = h('div', { class: 'dm-toast' }, text);
    this.root.append(t);
    setTimeout(() => t.remove(), 3500);
  }
}

// ------------------------------------------------------------------ Formular-Bausteine

type PaintKind = 'wand' | 'moebel' | 'paneel' | 'boden';

/** Wofür eine Shop-Farbe gedacht ist: Wand (Wandfarbe, Kreidefarbe für Wände, Tiefgrund) oder Möbel (Lack, Renovierfarbe …). */
function paintUse(p: ShopProduct): 'wand' | 'moebel' {
  const sub = (p.paint?.sub ?? '').toLowerCase();
  const name = p.name.toLowerCase();
  if (/wand/.test(sub)) return 'wand';
  if (/renovier|lack|möbel|holz/.test(sub)) return 'moebel';
  if (/lack|möbel|tür|küche|holz|versiegel|wachs|klar/.test(name)) return 'moebel';
  if (/grundierung|schutz/.test(sub) && !/tiefgrund|wand/.test(name)) return 'moebel';
  return 'wand';
}

/** Gewählte Shop-Farbe, wie sie im Projekt gespeichert wird (Farbton als Variante). */
function paintRef(p: ShopProduct): Product {
  return { source: p.source, name: p.paint?.product || p.name, url: p.url, sku: '', image: p.image, price: p.price, catalog_id: p.id, variant: p.paint?.shade };
}

/** Gebindegröße in Litern aus dem Produktnamen („2,5 l“, „750 ml“), sonst null. */
function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

function canLiters(name: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i.exec(name);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return m[2].toLowerCase() === 'ml' ? v / 1000 : v;
}

const WALL_COLORS = ['#efede8', '#f5efe4', '#e6dccb', '#d9cbb5', '#c9b49a', '#b8c4b0', '#9fb0a4', '#a9b8c6', '#7d8b99', '#d8b8a8', '#c98f7a', '#4a5560'];

function field(label: string, input: Node): HTMLElement {
  return h('label', { class: 'dm-field' }, h('span', {}, label), input);
}

function numberInput(value: number, min: number, max: number, onCommit: (v: number) => void, unit = 'cm'): HTMLElement {
  const input = h('input', { class: 'dm-input', type: 'number', value: String(value), min, max, step: unit === 'cm' ? 0.1 : 1 }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v) && v >= min && v <= max && v !== value) onCommit(v);
    else input.value = String(value);
  });
  return h('span', { class: 'dm-unit' }, input, h('small', {}, unit));
}

function colorInput(value: string, onCommit: (hex: string) => void): HTMLElement {
  const input = h('input', { type: 'color', value: value || '#ffffff', class: 'dm-color' }) as HTMLInputElement;
  input.addEventListener('change', () => onCommit(input.value));
  return input;
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ Menü, Farben, Stile

type MenuId = 'view' | 'room' | 'select' | 'remove' | 'color' | 'furniture' | 'style' | 'tools' | 'diy' | 'parts' | 'conn' | 'account';
type SheetId = 'save' | 'favs' | 'shop' | 'render';
type Theme = 'light' | 'dark' | 'auto';

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem('dm3d_theme');
    return v === 'dark' || v === 'auto' ? v : 'light';
  } catch {
    return 'light';
  }
}

function saveTheme(t: Theme): void {
  try {
    localStorage.setItem('dm3d_theme', t);
  } catch {
    /* privater Modus */
  }
}

const TRASH = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>';

const BENCH_MENUS: MenuId[] = ['diy', 'furniture', 'parts', 'conn', 'tools'];
const BENCH_ONLY = new Set<MenuId>(['diy', 'parts']);

const MENUS: { id: MenuId; label: string; icon: string }[] = [
  { id: 'diy', label: 'Bauplan', icon: '<path d="M4 20V8l8-4 8 4v12"/><path d="M4 12h16M9 20v-4h6v4"/>' },
  { id: 'view', label: 'Ansicht', icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>' },
  { id: 'room', label: 'Raum', icon: '<path d="M4 4h16v16H4z"/><path d="M4 13h7v7M14 4v6h6"/>' },
  { id: 'parts', label: 'Bauteile', icon: '<path d="M3 14l9-5 9 5-9 5z"/><path d="M3 14v3l9 5 9-5v-3"/><path d="M8 6.5l4-2.2 4 2.2"/>' },
  { id: 'furniture', label: 'Möbel', icon: '<path d="M5 11V8a2 2 0 012-2h10a2 2 0 012 2v3"/><path d="M3 12a2 2 0 014 0v2h10v-2a2 2 0 014 0v5H3z"/><path d="M5 17v2M19 17v2"/>' },
  { id: 'conn', label: 'Verbindungen', icon: '<path d="M9 3h6l-1 3h-4z"/><path d="M12 6v15"/><path d="M10 9l4 1.5M10 12l4 1.5M10 15l4 1.5M10 18l2 1"/>' },
  { id: 'style', label: 'Style', icon: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>' },
  { id: 'color', label: 'Farbe', icon: '<path d="M12 3a9 9 0 100 18c1.4 0 2-.9 2-1.8 0-1.4-1-1.9 0-2.9s3 0 4.2-1.1C20.5 14 21 13 21 11c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1.1"/><circle cx="10" cy="7.5" r="1.1"/><circle cx="15" cy="7.5" r="1.1"/>' },
  { id: 'tools', label: 'Werkzeug', icon: '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>' },
  { id: 'remove', label: 'Entfernen', icon: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>' },
];

function icon(paths: string): HTMLElement {
  const span = h('span', { class: 'dm-icon' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}

const FURNITURE_COLORS = [
  '#f2f0eb', '#e4ddd0', '#cfc9bf', '#b5a48c', '#8a8f98', '#4a5560', '#2b2b2b', '#111111',
  '#a9b9a6', '#4f7a46', '#a9b8c6', '#3d5a80', '#c98f7a', '#b5651d', '#d4a373', '#9c7650',
  '#6e5440', '#3f3a36',
];
const FLOOR_COLORS = ['#e3cfae', '#d2b48c', '#b48a60', '#9a6b43', '#6e5440', '#d6d3cc', '#b9b6b0', '#9b9b98', '#a59d93', '#5c5a57', '#efe9df', '#3f3a36'];

interface StylePreset {
  name: string; walls: string; ceiling: string; floor: [string, string];
  upholstery: string; wood: string; rug: string; panel: string;
}

const STYLES: StylePreset[] = [
  { name: 'Skandinavisch', walls: '#f2f0eb', ceiling: '#ffffff', floor: ['wood', '#d8bf98'], upholstery: '#cfc9bf', wood: '#d9c3a0', rug: '#e8e1d4', panel: '#e9e4da' },
  { name: 'Japandi', walls: '#e9e2d6', ceiling: '#f4f0e8', floor: ['wood', '#b89b74'], upholstery: '#a89f91', wood: '#6e5440', rug: '#d8cdb9', panel: '#9c7650' },
  { name: 'Industrial', walls: '#b9b6b0', ceiling: '#d6d3cc', floor: ['concrete', '#8d8c88'], upholstery: '#5a4636', wood: '#3f3a36', rug: '#6b6660', panel: '#4a3b30' },
  { name: 'Boho', walls: '#efe2d0', ceiling: '#f7efe3', floor: ['wood', '#a87b52'], upholstery: '#ece0cc', wood: '#8a5a3b', rug: '#c98f6a', panel: '#c9a57a' },
  { name: 'Modern dunkel', walls: '#4a5560', ceiling: '#e8e6e2', floor: ['wood', '#6e5440'], upholstery: '#8a8f98', wood: '#2f2a27', rug: '#9fa4a8', panel: '#2f2a27' },
  { name: 'Landhaus', walls: '#f5efe4', ceiling: '#ffffff', floor: ['wood', '#b48a60'], upholstery: '#b8c4b0', wood: '#e9e4da', rug: '#c9b8a0', panel: '#e9e4da' },
];

/** Welche Stilfarbe ein Möbel bekommt (Fernseher, Pflanze, Lampe bleiben). */
const STYLE_GROUP: Partial<Record<Category, 'upholstery' | 'wood' | 'rug'>> = {
  sofa: 'upholstery', armchair: 'upholstery', bed: 'upholstery',
  chair: 'wood', dining_table: 'wood', coffee_table: 'wood', side_table: 'wood', desk: 'wood',
  wardrobe: 'wood', shelf: 'wood', sideboard: 'wood',
  rug: 'rug',
};

/** Rechteckiger, achsenparalleler Raum: welche Wand ist Länge, welche Breite? */
function rectangleWalls(s: Scene): { length: number; width: number } | null {
  const p = s.room.polygon;
  if (p.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-3 && Math.abs(a[1] - b[1]) > 1e-3) return null;
  }
  return wallLength(s, 0) >= wallLength(s, 1) ? { length: 0, width: 1 } : { length: 1, width: 0 };
}

const SHOP_LABEL: Record<string, string> = { ikea: 'IKEA', amazon: 'Amazon', other: 'Shop' };

function shopOf(url: string): Product['source'] {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* kein gültiger Link */ }
  if (/(^|\.)ikea\./.test(host)) return 'ikea';
  if (/(^|\.)(amazon\.|amzn\.)/.test(host)) return 'amazon';
  return 'other';
}

/** Reihenfolge der Unterkategorien im Menü „Verbindungen“ */
const CONN_ORDER = ['Schrauben', 'Nägel', 'Winkel', 'Scharniere', 'Griffe', 'Dübel', 'Holzdübel/Lamellos', 'Möbelverbinder', 'Regalträger', 'Haken'];

const naturalSort = (a: string, b: string) => a.localeCompare(b, 'de', { numeric: true });

/** Kurzer Name einer Variante: Maße, sonst der Produktname */
function connShort(p: ShopProduct): string {
  const c = p.conn;
  const dims = [c?.diameter, c?.length].filter(Boolean).join(' × ');
  return dims ? `${dims} · ${p.name}` : p.name;
}

const euro = (v: number) => v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

interface SheetContent { title: string; body: Child[]; actions?: Child[] }

interface ShopRow { key: string; p: Product; label: string; count: number; rooms: Set<string>; note?: string }

interface PrintRow { name: string; url: string; image?: string; source: Product['source']; price?: number | null; count?: number; variant?: string; rooms?: string }

/** Symbole der Werkbank-Leiste */
const BI = {
  add: '<path d="M12 5v14M5 12h14"/>',
  size: '<path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/><path d="M8 12h8M12 8v8"/>',
  cut: '<path d="M2 14l12-7v9l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1z"/><path d="M14 6h5a2 2 0 012 2v7a2 2 0 01-2 2h-5z"/><path d="M17.5 9.5v4"/>',
  tip: '<path d="M4 20h16"/><rect x="5" y="9" width="6" height="11"/><path d="M14 16h6v4M13 9a6 6 0 016 5"/>',
  color: '<path d="M18.5 3.5a2.1 2.1 0 013 3L12 16l-4-4z"/><path d="M8 12c-3 0-4 2-4 4 0 1.5-1 2.5-2 3 3 1 8 .5 8-4"/>',
  screw: '<path d="M3 6h10v5H3z"/><path d="M13 7h3l1 1.5-1 1.5h-3"/><path d="M17 8.5h4.5"/><path d="M6 11l-1 6h5l-1-6"/><path d="M4 17h7v3H4z"/><path d="M5.5 8.5h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  caster: '<path d="M5 5h14M12 5v5"/><circle cx="12" cy="15" r="5"/><circle cx="12" cy="15" r="1"/>',
  plan: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7M9 8h3"/>',
};

const ICON_TOOL = '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>';
const ICON_PDF = '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M12 11v6M9.5 14.5L12 17l2.5-2.5"/>';

type FurnTab = 'favs' | 'regale' | 'moebel' | 'deko' | 'formen' | 'bauteile';

const ICON_HOME = '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>';
const ICON_SAVE = '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>';
const ICON_HEART = '<path d="M12 20s-7-4.4-7-9.5A3.5 3.5 0 0112 8a3.5 3.5 0 017 2.5C19 15.6 12 20 12 20z"/>';
const ICON_CART = '<path d="M4 5h2l2 10h10l2-7H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="16.5" cy="19" r="1.3"/>';
const ICON_CAMERA = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
const ICON_FIT = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
const ICON_ROTATE = '<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v4.5h-4.5"/>';
const ICON_UNDO = '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12"/>';
const ICON_REDO = '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12"/>';
const ICON_USER = '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5.3 7-5.3s5.8 1.7 7 5.3"/>';
const ICON_PLAN = '<path d="M4 4h16v16H4z"/><path d="M4 12h6M10 4v5M14 20v-7h6"/>';

const FAV_KEY = 'dm3d_merkliste';

/** Gemerktes Produkt (Merkliste, im Browser gespeichert). key = Eintrag der Produktliste oder der Link. */
interface FavItem { key: string; name: string; url: string; image?: string; source: Product['source']; price?: number | null }

function loadFavs(): Map<string, FavItem> {
  const out = new Map<string, FavItem>();
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(v)) {
      for (const f of v) {
        if (f && typeof f.key === 'string' && typeof f.url === 'string' && /^https?:\/\//.test(f.url)) {
          out.set(f.key, { key: f.key, name: String(f.name ?? ''), url: f.url, image: typeof f.image === 'string' ? f.image : undefined, source: shopOf(f.url), price: typeof f.price === 'number' ? f.price : null });
        }
      }
    }
  } catch {
    /* privater Modus */
  }
  return out;
}

function saveFavs(favs: Map<string, FavItem>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs.values()].slice(0, 200)));
  } catch {
    /* privater Modus */
  }
}

/** Bereich im Möbel-Menü: aus der Produkttabelle (Spalte Kategorie), sonst aus dem 3D-Modell. */
/** Bekannte, oft verbaute Möbel zuerst, Nischenprodukte ans Ende. */
const TOP_PRODUCTS = ['billy', 'kallax', 'vesken', 'pax', 'ivar', 'bestå', 'besta', 'eket', 'platsa', 'hemnes', 'malm', 'trofast', 'metod',
  'småstad', 'smastad', 'brimnes', 'nordli', 'alex', 'hejne', 'bror', 'omar', 'hyllis', 'jonaxel', 'lack', 'baggebo', 'kleppstad', 'havsta', 'idanäs', 'vihals'];
const LOW_PRODUCTS = ['gewächshaus', 'beistelltisch', 'hocker', 'tritthocker', 'servierwagen', 'zeitschriften', 'fußmatte', 'schuhlöffel'];

function productRank(p: ShopProduct): number {
  const n = p.name.toLowerCase();
  let score = 0;
  const top = TOP_PRODUCTS.findIndex((w) => n.includes(w));
  if (top >= 0) score += 1000 - top * 10;
  if (LOW_PRODUCTS.some((w) => n.includes(w))) score -= 500;
  if (p.source === 'ikea') score += 100;
  // größere Möbel vor Kleinteilen
  score += Math.min(200, p.size[0] * p.size[1] * p.size[2] * 400);
  return score;
}

function productGroup(p: ShopProduct, catalog: Catalog): 'regale' | 'moebel' | 'deko' {
  if (p.group === 'regale' || p.group === 'moebel' || p.group === 'deko') return p.group;
  if (p.category === 'shelf' || p.category === 'wall_shelf') return 'regale';
  if (catalog.categories[p.category]?.group === 'deko' || ['rug', 'plant', 'lamp'].includes(p.category)) return 'deko';
  return 'moebel';
}

// ------------------------------------------------------------------ Projekte im Browser merken

const LOCAL_KEY = 'dm3d_projects';

function localProjects(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x)).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function rememberLocal(id: string): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([id, ...localProjects().filter((x) => x !== id)].slice(0, 50)));
  } catch {
    /* privater Modus */
  }
}

function forgetLocal(id: string): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localProjects().filter((x) => x !== id)));
  } catch {
    /* privater Modus */
  }
}

/** Produktbild; lädt es nicht, erscheint der Anfangsbuchstabe des Shops. */
function productImage(p: { image?: string; source: Product['source'] }): HTMLElement {
  const ph = () => h('span', { class: 'dm-product-ph' }, SHOP_LABEL[p.source]?.[0] ?? '·');
  if (!p.image) return ph();
  const img = h('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
  img.addEventListener('error', () => img.replaceWith(ph()));
  return img;
}
