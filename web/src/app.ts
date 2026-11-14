import { Api } from './api';
import { analysisToScene, prepareInput } from './analysis';
import { attachRoom, emptyRoom, moveRoom, replaceRoom, rotateRoom, toHome } from './home';
import { PlanView } from './plan';
import { TOOL_SETS, findToolProduct, type Tool as DiyTool, type ToolContext, type ToolSet } from './tools';
import { Showcase } from './showcase';
import { Viewer, type Tool, type ViewMode } from './viewer';
import {
  clone, cm, findPanel, m, newObject, type NewObjectOptions, newPanel, roomArea, setWallLength, uid, wallIndex, wallLength,
} from './edits';
import type { Catalog, Category, Home, Panel, Product, Project, ProjectSummary, Scene, SceneObject, Selection, ShopProduct } from './types';

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
  /** Farbverlauf unten im 3D-Hintergrund (Test) */
  private gradient = (() => { try { return localStorage.getItem('dm3d_gradient') !== '0'; } catch { return true; } })();
  private products: ShopProduct[] = [];
  /** Werkzeuge aus der Produktliste (Kategorie Werkzeug) */
  private toolProducts: ShopProduct[] = [];
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
        h('div', { class: 'dm-stage' }, this.elCanvas, this.elToolbar, this.elVersion,
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
      this.catalog = catalog;
      this.analysisAvailable = health.analysis_available;
      this.canCreate = health.can_create ?? true;
      this.loginUrl = health.login_url ?? '';
      this.version = health.version ?? '';
      this.user = { name: health.user ?? '', loginUrl: health.login_url ?? '', logoutUrl: health.logout_url ?? '', profileUrl: health.profile_url ?? '' };
      this.elVersion.textContent = this.version ? `Raumplaner v${this.version}` : '';
      // Produktliste ist optional (ältere Plugin-Versionen haben sie nicht)
      this.api.products().then((r) => {
        const all = r.products ?? [];
        this.products = all.filter((p) => p.group !== 'werkzeug');
        this.toolProducts = all.filter((p) => p.group === 'werkzeug');
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
      this.demoNotice('Für einen neuen Raum aus Video, Fotos oder Grundriss braucht es den Server mit der KI-Analyse. Diese Demo zeigt die fertig analysierte Küche.');
      return;
    }
    let kind = 'video';
    const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*', class: 'dm-file' }) as HTMLInputElement;
    const hint = h('textarea', {
      class: 'dm-input', rows: 2,
      placeholder: 'Optional: Hinweise, z. B. "Wohnzimmer, Deckenhöhe 2,50 m, Fensterwand 4,20 m"',
    }) as HTMLTextAreaElement;
    const accept: Record<string, string> = { video: 'video/*', photos: 'image/*', floorplan: 'image/*,application/pdf' };
    const help: Record<string, string> = {
      video: 'Langsam einmal rundherum filmen, Kamera auf Brusthöhe, 20–60 Sekunden.',
      photos: '4–12 Fotos aus verschiedenen Ecken, möglichst viel Wand und Boden im Bild.',
      floorplan: 'Grundriss als Bild oder PDF, gerne mit Maßen.',
    };
    const helpEl = h('p', { class: 'dm-muted' }, help.video);
    const tabs = Object.keys(KIND_LABEL).map((k) =>
      h('button', {
        class: `dm-tab${k === kind ? ' active' : ''}`,
        onclick: (e: Event) => {
          kind = k;
          fileInput.accept = accept[k];
          helpEl.textContent = help[k];
          tabs.forEach((t) => t.classList.toggle('active', t === e.currentTarget));
        },
      }, KIND_LABEL[k]));
    const err = h('p', { class: 'dm-error', hidden: true });
    const go = h('button', {
      class: 'dm-btn primary',
      disabled: !this.canCreate || !this.analysisAvailable,
      onclick: async () => {
        const files = Array.from(fileInput.files ?? []);
        if (!files.length) {
          err.textContent = 'Bitte zuerst eine Datei auswählen.';
          err.hidden = false;
          return;
        }
        await this.create(kind, files, hint.value);
      },
    }, 'Raum erstellen');

    if (!this.scene) this.startShowcase();
    this.showOverlay(
      h('div', { class: 'dm-card' },
        h('h2', {}, 'Neuen Raum erstellen'),
        h('p', {}, 'Lade ein Video, Fotos oder einen Grundriss hoch. Die KI baut daraus eine 3D-Szene, die du frei bearbeiten kannst.'),
        h('div', { class: 'dm-tabs' }, tabs),
        helpEl,
        fileInput,
        hint,
        !this.analysisAvailable && h('p', { class: 'dm-note' }, 'Hinweis: Die KI-Analyse ist noch nicht eingerichtet (API-Key fehlt in den Plugin-Einstellungen). Du kannst aber schon den Demo-Raum bearbeiten.'),
        !this.canCreate && h('p', { class: 'dm-note' }, 'Bitte melde dich an, um einen Raum zu erstellen. ',
          this.loginUrl && h('a', { href: this.loginUrl }, 'Zur Anmeldung')),
        err,
        h('div', { class: 'dm-row end' },
          this.scene && h('button', { class: 'dm-btn ghost', onclick: () => this.hideOverlay() }, 'Abbrechen'),
          !this.scene && h('button', { class: 'dm-btn ghost', onclick: () => this.showProjects() }, 'Meine Projekte'),
          h('button', { class: 'dm-btn', disabled: !this.canCreate, onclick: () => this.create('demo', [], '') }, 'Demo-Raum öffnen'),
          go,
        ),
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

  private async create(kind: string, files: File[], hint: string): Promise<void> {
    try {
      if (kind === 'demo') {
        this.showProgress('Demo-Raum wird geladen');
        const { id } = await this.api.createProject('demo', null, '');
        await this.openProject(id);
        return;
      }
      this.showProgress('Dateien werden vorbereitet');
      const input = await prepareInput(files, (t) => this.showProgress(t));
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
      this.showProgress(`${p.step || 'Verarbeitung läuft'} (${secs} s, meist etwa eine Minute)`);
      await sleep(2000);
      p = await this.api.project(id);
    }
    if (p.state === 'error') throw new Error(p.error || 'Die Szene konnte nicht erstellt werden.');
    if (!p.scene && p.analysis) {
      // Erste Öffnung nach der Analyse: KI-Antwort in eine Szene umwandeln und speichern.
      p.scene = analysisToScene(p.analysis, p.kind ?? 'video', this.catalog);
      p = await this.api.saveScene(id, p.scene);
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
      this.active = 0;
      this.undoStack = [];
      this.redoStack = [];
      this.stopShowcase();
      const url = new URL(location.href);
      url.searchParams.set(this.opts.projectParam ?? 'projekt', id);
      history.replaceState(null, '', url);
      rememberLocal(id);
      this.viewer.setHome(this.home, 0, false);
      this.hideOverlay();
      if (this.wide && !this.menu) this.menu = 'furniture';
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
        : h('p', { class: 'dm-muted' }, 'Noch keine gespeicherten Projekte. Erstelle einen Raum oder öffne den Demo-Raum, er wird automatisch gesichert.'),
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
  private async apply(next: Scene, rebuild: boolean): Promise<void> {
    if (!this.home) return;
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
    this.renderPanel();
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
    const snapshot = this.home!;
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
    copy.position = [src.position[0] + 0.3, src.position[1] - 0.3, src.position[2]];
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
    this.selection = sel;
    // Produkt gewählt: rechts die Einkaufsliste zeigen (außer beim Speichern oder Rendern)
    if (!same && sel?.kind === 'object' && this.wide && this.sheet !== 'save' && this.sheet !== 'render') {
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
    if (o.category === 'shelf' || o.category === 'wall_shelf') return 'regal';
    if (cat?.mount === 'wall') return 'wand';
    if (cat?.group === 'deko' || ['rug', 'plant', 'lamp'].includes(o.category)) return null;
    return 'moebel';
  }

  /** Menü „Werkzeug“: passende Werkzeuge und Anleitung zur Auswahl, sonst fürs ganze Projekt. */
  private toolsMenu(): Child[] {
    const ctx = this.toolContext();
    const project = this.projectTools();
    const out: Child[] = [];
    if (ctx) {
      out.push(h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Passend zur Auswahl:'), this.toolSetView(TOOL_SETS[ctx], true));
      const rest = project.filter((t) => t !== TOOL_SETS[ctx]);
      if (rest.length) out.push(h('h4', {}, 'Weitere Arbeiten im Projekt'), ...rest.map((t) => this.toolSetView(t, false)));
    } else if (project.length) {
      out.push(h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Für dein Projekt brauchst du diese Werkzeuge. Wähle ein Möbel, Regal oder eine Wand, um nur die passenden zu sehen.'),
        ...project.map((t, i) => this.toolSetView(t, i === 0)));
    } else {
      out.push(h('p', { class: 'dm-muted small', style: 'margin-top:0' }, 'Noch nichts im Raum, das Werkzeug braucht. Alle Anleitungen:'),
        ...Object.values(TOOL_SETS).map((t) => this.toolSetView(t, false)));
    }
    // Werkzeuge aus dem Shop, die keiner Arbeit zugeordnet sind
    const used = new Set(Object.values(TOOL_SETS).flatMap((t) => t.tools).map((t) => findToolProduct(t, this.toolProducts)?.id).filter(Boolean));
    const more = this.toolProducts.filter((p) => !used.has(p.id));
    if (more.length) {
      out.push(h('details', { class: 'dm-toolset' }, h('summary', {}, `Weitere Werkzeuge (${more.length})`),
        h('div', { class: 'dm-favs-list' }, more.map((p) => this.toolRow({ name: '', match: [p.name.toLowerCase()] })))));
    }
    out.push(h('button', { class: 'dm-btn small', style: 'margin-top:10px', onclick: () => this.printShopList() }, icon(ICON_PDF), ' Einkaufsliste mit Werkzeug und Anleitung als PDF'));
    return out;
  }

  private toolSetView(set: ToolSet, open: boolean): HTMLElement {
    return h('details', { class: 'dm-toolset', open },
      h('summary', {}, set.title),
      h('div', { class: 'dm-favs-list' }, set.tools.map((t) => this.toolRow(t))),
      h('details', { class: 'dm-guide' }, h('summary', {}, 'Anleitung'),
        h('ol', {}, set.guide.map((g) => h('li', {}, g)))));
  }

  private toolRow(t: DiyTool): HTMLElement {
    const p = findToolProduct(t, this.toolProducts);
    const text = h('span', { class: 'dm-product-text' }, h('strong', {}, p?.name || t.name),
      h('span', { class: 'dm-muted small' }, [p ? SHOP_LABEL[p.source] : '', p?.price != null ? euro(p.price) : '', !p ? t.note ?? '' : t.name].filter(Boolean).join(' · ')));
    if (!p) return h('div', { class: 'dm-favrow dm-toolrow' }, h('span', { class: 'dm-favlink' }, h('span', { class: 'dm-product-ph' }, '🔧'), text));
    const key = `tool:${p.id}`;
    return h('div', { class: 'dm-favrow dm-toolrow' },
      h('a', { class: 'dm-favlink', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' }, productImage(p), text),
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

  private renderDock(): void {
    const btn = (m: { id: MenuId; label: string; icon: string }) => h('button', {
      class: `dm-dock-btn${this.menu === m.id ? ' active' : ''}`,
      title: m.label,
      onclick: () => this.toggleMenu(m.id),
    }, icon(m.icon), h('span', {}, m.label));
    this.elDock.replaceChildren(
      ...MENUS.map(btn),
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
    this.elTitle.textContent = s ? this.project?.name || s.room.name || 'Raumplaner' : 'Raumplaner';
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
    o.rotation = (((o.rotation + deg) % 360) + 360) % 360;
    this.apply(next, true);
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
  private colorTarget(): { name: string; color: string; palette: string[]; apply: (c: string) => void } | null {
    const s = this.scene!;
    const sel = this.selection;
    if (sel?.kind === 'object') {
      const o = s.objects.find((x) => x.id === sel.id);
      if (!o) return null;
      return { name: o.label || 'Möbel', color: o.color, palette: FURNITURE_COLORS,
        apply: (c) => this.recolor(o.id, c, (n) => {
          const x = n.objects.find((y) => y.id === o.id)!;
          x.color = c;
          if (x.product?.variants) x.product.variant = x.product.variants.find((v) => v.color.toLowerCase() === c.toLowerCase())?.name;
        }) };
    }
    if (sel?.kind === 'wall') {
      const i = wallIndex(s, sel.id);
      if (i < 0) return null;
      return { name: `Wand ${i + 1}`, color: s.walls[i].color, palette: WALL_COLORS,
        apply: (c) => this.recolor(sel.id, c, (n) => (n.walls[i].color = c)) };
    }
    if (sel?.kind === 'panel') {
      const f = findPanel(s, sel.id);
      if (!f) return null;
      return { name: this.catalog.panels[f.panel.type]?.label ?? 'Paneel', color: f.panel.color, palette: FURNITURE_COLORS,
        apply: (c) => this.recolor(sel.id, c, (n) => (n.walls[f.wallIndex].panels.find((x) => x.id === sel.id)!.color = c)) };
    }
    if (sel?.kind === 'floor') {
      return { name: 'Boden', color: s.floor.color, palette: FLOOR_COLORS, apply: (c) => this.recolor('floor', c, (n) => (n.floor.color = c)) };
    }
    if (sel?.kind === 'ceiling') {
      return { name: 'Decke', color: s.ceiling.color, palette: WALL_COLORS, apply: (c) => this.recolor('ceiling', c, (n) => (n.ceiling.color = c)) };
    }
    return { name: 'Alle Wände', color: s.walls[0]?.color ?? '#ffffff', palette: WALL_COLORS, apply: (c) => {
      const next = clone(s);
      for (const w of next.walls) { w.color = c; this.viewer.setColor(w.id, c); }
      this.apply(next, false);
    } };
  }

  private colorMenu(): Child[] {
    const t = this.colorTarget();
    if (!t) return [h('p', { class: 'dm-muted' }, 'Bitte etwas auswählen.')];
    const pick = (c: string) => { t.apply(c); this.renderMenu(); };
    const sel = this.selection;
    const obj = sel?.kind === 'object' ? this.scene!.objects.find((x) => x.id === sel.id) : undefined;
    return [
      h('p', {}, 'Farbe für ', h('strong', {}, t.name), sel ? '' : ' (oder tippe etwas im Bild an)'),
      obj && this.variantPicker(obj),
      !sel && h('div', { class: 'dm-row', style: 'margin-bottom:10px' },
        h('button', { class: 'dm-btn small', onclick: () => this.viewer.setSelection({ kind: 'floor' }, true) }, 'Boden'),
        h('button', { class: 'dm-btn small', onclick: () => this.viewer.setSelection({ kind: 'ceiling' }, true) }, 'Decke')),
      h('div', { class: 'dm-swatches' }, t.palette.map((c) =>
        h('button', {
          class: `dm-swatch${c.toLowerCase() === t.color.toLowerCase() ? ' active' : ''}`,
          style: `background:${c}`, title: c, onclick: () => pick(c),
        }))),
      field('Eigene Farbe', colorInput(t.color, pick)),
    ];
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
    const counts: Record<FurnTab, number> = { favs: 0, regale: 0, moebel: 0, deko: 0, formen: 0 };
    for (const p of this.products) {
      counts[productGroup(p, this.catalog)]++;
      if (this.favs.has(p.id)) counts.favs++;
    }
    if (!this.furnTab) this.furnTab = this.products.length ? (['deko', 'moebel', 'regale'] as FurnTab[]).find((t) => counts[t]) ?? 'formen' : 'formen';
    const tab = this.furnTab;
    const tabBtn = (t: FurnTab, label: string | Node) => h('button', {
      class: `dm-tab${tab === t ? ' active' : ''}`, title: t === 'favs' ? 'Gemerkte Produkte' : '',
      onclick: () => { this.furnTab = t; this.shopFilter = 'all'; this.productQuery = ''; this.renderMenu(); },
    }, label, t !== 'formen' && counts[t] ? h('span', { class: 'dm-count' }, String(counts[t])) : '');
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
        chips(cats.filter((c) => this.catalog.categories[c].group !== 'deko')),
        h('h4', {}, 'Deko'),
        chips(cats.filter((c) => this.catalog.categories[c].group === 'deko')));
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
    return this.products.filter((p) => (tab === 'favs' ? this.favs.has(p.id) : productGroup(p, this.catalog) === tab));
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
      for (const o of r.scene.objects) {
        if (!o.product?.url) continue;
        if (o.skipShop) { hidden++; continue; }
        const key = `${o.product.url}|${o.product.variant ?? ''}`;
        const g = groups.get(key) ?? { key, p: o.product, label: o.label || o.product.name, count: 0, rooms: new Set<string>() };
        g.count++;
        g.rooms.add(r.scene.room.name || `Raum ${i + 1}`);
        groups.set(key, g);
      }
    });
    const rows = [...groups.values()];
    const priced = rows.filter((g) => g.p.price != null);
    const total = priced.reduce((sum, g) => sum + (g.p.price ?? 0) * g.count, 0);
    return { rows, hidden, total, missing: rows.length - priced.length };
  }

  private printShopList(): void {
    const { rows, total, missing } = this.shopRows();
    this.printList('shop', rows.map((g) => ({
      name: g.label, url: g.p.url, image: g.p.image, source: g.p.source, price: g.p.price, count: g.count,
      variant: g.p.variant && (g.p.variants?.length ?? 0) > 1 ? g.p.variant : '', rooms: [...g.rooms].join(', '),
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
      title: `Einkaufsliste${rows.length ? ` (${rows.reduce((n, g) => n + g.count, 0)})` : ''}`,
      body: [
        rows.length
          ? h('div', { class: 'dm-favs-list' }, rows.map((g) => h('div', { class: `dm-favrow${g.key === current ? ' current' : ''}` },
            h('a', { class: 'dm-favlink', href: this.shopLink(g.p.url), target: '_blank', rel: 'sponsored noopener', title: 'Im Shop ansehen (neuer Tab)' },
              productImage(g.p),
              h('span', { class: 'dm-product-text' },
                h('strong', {}, (g.count > 1 ? `${g.count} × ` : '') + g.label),
                h('span', { class: 'dm-muted small' }, [
                  SHOP_LABEL[g.p.source], g.p.variant && (g.p.variants?.length ?? 0) > 1 ? g.p.variant : '',
                  g.p.price != null ? euro(g.p.price * g.count) : 'Preis im Shop', [...g.rooms].join(', '),
                ].filter(Boolean).join(' · ')))),
            h('button', { class: 'dm-btn small ghost', title: 'Aus der Einkaufsliste nehmen (bleibt im Raum)', onclick: () => this.setSkipShop(g.key, true) }, '✕'))))
          : h('p', { class: 'dm-muted small' }, 'Noch keine Produkte im Projekt. Unter „Möbel“ findest du Produkte oder fügst eines per Link ein.'),
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
    const title = kind === 'shop' ? 'Einkaufsliste' : 'Merkliste';
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
      const p = findToolProduct(x, this.toolProducts);
      if (!p) return `<li><strong>${esc(x.name)}</strong>${x.note ? ` <span class="m">· ${esc(x.note)}</span>` : ''}</li>`;
      const link = this.shopLink(p.url);
      return `<li class="tp">${p.image ? `<img src="${esc(p.image)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ''}<span><strong>${esc(x.name)}</strong>: ${esc(p.name)}${p.price != null ? ` · ${esc(euro(p.price))}` : ''}<br><a href="${esc(link)}">${esc(link)}</a></span></li>`;
    };
    const toolHtml = tools.length ? `<h2>Werkzeug und Anleitung</h2>${tools.map((t) => `<section><h3>${esc(t.title)}</h3><ul>${t.tools.map(toolLi).join('')}</ul>
      <p class="gh">Anleitung</p><ol>${t.guide.map((g) => `<li>${esc(g)}</li>`).join('')}</ol></section>`).join('')}` : '';
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
      <table>${items}</table>${sum}${toolHtml}${amazon}
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
      numberInput(cm(o.size[axis]), 1, 1000, (v) => update((x) => (x.size[axis] = m(v)), true), 'cm');
    return [
      field('Bezeichnung', h('input', {
        class: 'dm-input', value: o.label,
        onchange: (e: Event) => update((x) => (x.label = (e.target as HTMLInputElement).value), false).then(() => this.renderPanel()),
      })),
      h('div', { class: 'dm-row three' }, field('Breite', sizeInput(0)), field('Tiefe', sizeInput(1)), field('Höhe', sizeInput(2))),
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
    if (sel && s) {
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

const WALL_COLORS = ['#efede8', '#f5efe4', '#e6dccb', '#d9cbb5', '#c9b49a', '#b8c4b0', '#9fb0a4', '#a9b8c6', '#7d8b99', '#d8b8a8', '#c98f7a', '#4a5560'];

function field(label: string, input: Node): HTMLElement {
  return h('label', { class: 'dm-field' }, h('span', {}, label), input);
}

function numberInput(value: number, min: number, max: number, onCommit: (v: number) => void, unit = 'cm'): HTMLElement {
  const input = h('input', { class: 'dm-input', type: 'number', value: String(value), min, max, step: 1 }) as HTMLInputElement;
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

type MenuId = 'view' | 'room' | 'select' | 'remove' | 'color' | 'furniture' | 'style' | 'tools' | 'account';
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

const MENUS: { id: MenuId; label: string; icon: string }[] = [
  { id: 'view', label: 'Ansicht', icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>' },
  { id: 'room', label: 'Raum', icon: '<path d="M4 4h16v16H4z"/><path d="M4 13h7v7M14 4v6h6"/>' },
  { id: 'furniture', label: 'Möbel', icon: '<path d="M5 11V8a2 2 0 012-2h10a2 2 0 012 2v3"/><path d="M3 12a2 2 0 014 0v2h10v-2a2 2 0 014 0v5H3z"/><path d="M5 17v2M19 17v2"/>' },
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

const euro = (v: number) => v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

interface SheetContent { title: string; body: Child[]; actions?: Child[] }

interface ShopRow { key: string; p: Product; label: string; count: number; rooms: Set<string> }

interface PrintRow { name: string; url: string; image?: string; source: Product['source']; price?: number | null; count?: number; variant?: string; rooms?: string }

const ICON_TOOL = '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>';
const ICON_PDF = '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M12 11v6M9.5 14.5L12 17l2.5-2.5"/>';

type FurnTab = 'favs' | 'regale' | 'moebel' | 'deko' | 'formen';

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
