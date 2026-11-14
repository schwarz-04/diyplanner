import { Api } from './api';
import { analysisToScene, prepareInput } from './analysis';
import { attachRoom, emptyRoom, replaceRoom, toHome } from './home';
import { Showcase } from './showcase';
import { Viewer, type Tool, type ViewMode } from './viewer';
import {
  clone, cm, findPanel, m, newObject, type NewObjectOptions, newPanel, roomArea, setWallLength, uid, wallIndex, wallLength,
} from './edits';
import type { Catalog, Category, Home, Panel, Product, Project, Scene, SceneObject, Selection, ShopProduct } from './types';

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
  private products: ShopProduct[] = [];
  private amazonTag = '';
  private productQuery = '';

  // DOM
  private elStatus = h('span', { class: 'dm-status' });
  private elTitle = h('span', { class: 'dm-title' }, 'Raumplaner');
  private elDock = h('nav', { class: 'dm-dock' });
  private elPop = h('div', { class: 'dm-pop', hidden: true });
  private elCaption = h('div', { class: 'dm-caption', hidden: true });
  private elCanvas = h('div', { class: 'dm-canvas' });
  private elOverlay = h('div', { class: 'dm-overlay', hidden: true });
  private elToolbar = h('div', { class: 'dm-floating', hidden: true });
  private btnUndo = h('button', { class: 'dm-btn ghost', title: 'Rückgängig (Strg+Z)', onclick: () => this.undo() }, '↶');
  private btnRedo = h('button', { class: 'dm-btn ghost', title: 'Wiederholen (Strg+Y)', onclick: () => this.redo() }, '↷');

  constructor(private root: HTMLElement, private opts: AppOptions) {
    this.api = new Api(opts.apiBase, opts.nonce);
  }

  async start(): Promise<void> {
    this.root.classList.add('dm-app');
    this.root.append(
      h('header', { class: 'dm-top' },
        h('div', { class: 'dm-brand' },
          this.opts.backUrl ? h('a', { class: 'dm-backlink', href: this.opts.backUrl, title: 'Zurück zur Webseite' }, '← ' + (this.opts.backLabel || 'Webseite')) : null,
          h('span', { class: 'dm-logo' }, '◆'), this.elTitle),
        h('div', { class: 'dm-actions' },
          this.btnUndo, this.btnRedo,
          h('span', { class: 'dm-sep' }),
          h('button', { class: 'dm-btn ghost', onclick: () => this.showShoppingList() }, 'Einkaufsliste'),
          h('button', { class: 'dm-btn ghost', onclick: () => this.renderImage() }, 'Foto-Rendering'),
          h('button', { class: 'dm-btn ghost', onclick: () => this.showStart() }, 'Neuer Raum'),
          this.elStatus,
        ),
      ),
      h('div', { class: 'dm-main' }, h('div', { class: 'dm-stage' }, this.elCanvas, this.elToolbar, this.elPop, this.elDock)),
      this.elOverlay,
      this.elCaption,
    );
    this.viewer = new Viewer(this.elCanvas, {
      onSelect: (sel) => this.select(sel),
      onObjectMoved: (id, pos, rot) => this.objectMoved(id, pos, rot),
      onMeasured: () => this.renderMenu(),
      onRoomPick: (i) => this.switchRoom(i),
    });
    this.renderDock();
    new ResizeObserver(() => this.updateShift()).observe(this.root);
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
      // Produktliste ist optional (ältere Plugin-Versionen haben sie nicht)
      this.api.products().then((r) => {
        this.products = r.products ?? [];
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
    } else if (this.menu && !this.elPop.hidden) {
      const r = this.elPop.getBoundingClientRect();
      sy = Math.min(Math.max(0, (stage.bottom - r.top) / 2), stage.height * 0.3);
    }
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
      this.viewer.setHome(this.home, 0, false);
      this.hideOverlay();
      this.select(null);
      this.setStatus('Gespeichert');
    } catch (err) {
      this.showError((err as Error).message);
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

  private async addObject(category: Category, opt: NewObjectOptions = {}): Promise<void> {
    const next = clone(this.scene!);
    // Wandobjekte an die ausgewählte Wand hängen
    const sel = this.selection;
    const wall = sel?.kind === 'wall' ? wallIndex(next, sel.id) : sel?.kind === 'panel' ? findPanel(next, sel.id)?.wallIndex : undefined;
    const obj = newObject(next, this.catalog, category, { wall: wall ?? this.viewer.facingWall(), ...opt });
    next.objects.push(obj);
    await this.apply(next, true);
    this.viewer.setSelection({ kind: 'object', id: obj.id }, true);
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
    this.selection = sel;
    this.renderMenu();
    this.renderFloating();
  }

  /** Früherer Name, wird an vielen Stellen nach Änderungen aufgerufen. */
  private renderPanel(): void {
    this.renderMenu();
    this.renderFloating();
  }

  private toggleMenu(id: MenuId): void {
    this.menu = this.menu === id ? null : id;
    this.renderMenu();
  }

  private openMenu(id: MenuId): void {
    this.menu = id;
    this.renderMenu();
  }

  private renderDock(): void {
    this.elDock.replaceChildren(...MENUS.map((m) =>
      h('button', {
        class: `dm-dock-btn${this.menu === m.id ? ' active' : ''}`,
        title: m.label,
        onclick: () => this.toggleMenu(m.id),
      }, icon(m.icon), h('span', {}, m.label))));
  }

  private renderMenu(): void {
    const s = this.scene;
    if (s) this.elTitle.textContent = s.room.name || 'Raumplaner';
    this.renderDock();
    this.elPop.replaceChildren();
    this.elPop.hidden = !this.menu || !s;
    if (!this.menu || !s) {
      this.updateShift();
      return;
    }
    const def = MENUS.find((m) => m.id === this.menu)!;
    const body: Child[] = {
      view: () => this.viewMenu(),
      room: () => this.roomMenu(),
      select: () => this.selectMenu(),
      remove: () => this.removeMenu(),
      color: () => this.colorMenu(),
      furniture: () => this.furnitureMenu(),
      style: () => this.styleMenu(),
    }[this.menu]();
    requestAnimationFrame(() => this.updateShift());
    this.elPop.append(
      h('div', { class: 'dm-pop-head' },
        h('strong', {}, def.label),
        h('button', { class: 'dm-btn ghost small', title: 'Schließen', onclick: () => this.toggleMenu(this.menu!) }, '✕')),
      h('div', { class: 'dm-pop-body' }, body),
    );
  }

  // ------------------------------------------------------------------ Ansicht

  private setView(mode: ViewMode): void {
    if (this.tool === 'measure') this.setTool('select');
    this.viewer.setMode(mode);
    if (mode === 'walk') this.menu = null;
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
    const mode = (gm: 'translate' | 'rotate', label: string) =>
      h('button', { class: `dm-tab${this.gizmoMode === gm ? ' active' : ''}`, onclick: () => this.setGizmo(gm) }, label);
    return [
      obj
        ? h('div', {},
          h('p', {}, h('strong', {}, obj.label || this.catalog.categories[obj.category]?.label), ' ist ausgewählt.'),
          this.viewer.viewMode === 'walk'
            ? h('p', { class: 'dm-muted small' }, 'Zum Bewegen und Drehen in die 3D-Ansicht wechseln.')
            : h('div', { class: 'dm-tabs' }, mode('translate', '✥ Bewegen'), mode('rotate', '⟳ Drehen')),
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
        apply: (c) => this.recolor(o.id, c, (n) => (n.objects.find((x) => x.id === o.id)!.color = c)) };
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
    return [
      h('p', {}, 'Farbe für ', h('strong', {}, t.name), sel ? '' : ' (oder tippe etwas im Bild an)'),
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

  private productCard(p: Product): HTMLElement {
    return h('div', { class: 'dm-product' },
      p.image ? h('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'dm-product-ph' }, SHOP_LABEL[p.source]?.[0] ?? '·'),
      h('div', { class: 'dm-product-text' },
        h('strong', {}, p.name || 'Produkt'),
        h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.price != null ? euro(p.price) : ''].filter(Boolean).join(' · '))),
      h('a', { class: 'dm-btn small', href: this.shopLink(p.url), target: '_blank', rel: 'sponsored noopener' }, 'Zum Shop'));
  }

  private productSection(): Child[] {
    const out: Child[] = [h('h4', { style: 'margin-top:0' }, 'Produkte (IKEA, Amazon …)')];
    if (this.products.length) {
      const search = h('input', { class: 'dm-input', type: 'search', placeholder: 'Suchen, z. B. Regal oder IKEA', value: this.productQuery }) as HTMLInputElement;
      search.addEventListener('input', () => {
        this.productQuery = search.value;
        const body = this.elPop.querySelector('.dm-product-list');
        body?.replaceWith(this.productList());
      });
      out.push(search, this.productList());
    } else {
      out.push(h('p', { class: 'dm-muted small' }, this.opts.demo
        ? 'Auf der Webseite erscheinen hier die empfohlenen Produkte. In der Demo kannst du ein Produkt per Link einfügen.'
        : 'Noch keine empfohlenen Produkte hinterlegt. Du kannst ein Produkt per Link einfügen.'));
    }
    out.push(h('div', { class: 'dm-row', style: 'margin-top:8px' },
      h('button', { class: 'dm-btn small', onclick: () => this.showAddByLink() }, '+ Produkt per Link'),
      h('button', { class: 'dm-btn small ghost', onclick: () => this.showShoppingList() }, 'Einkaufsliste')));
    return out;
  }

  private productList(): HTMLElement {
    const q = this.productQuery.trim().toLowerCase();
    const list = this.products.filter((p) => !q || `${p.name} ${SHOP_LABEL[p.source]} ${this.catalog.categories[p.category]?.label}`.toLowerCase().includes(q));
    return h('div', { class: 'dm-product-list' },
      list.length ? list.map((p) => h('button', { class: 'dm-product pick', title: 'In den Raum setzen', onclick: () => this.addProduct(p) },
        p.image ? h('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'dm-product-ph' }, SHOP_LABEL[p.source]?.[0] ?? '·'),
        h('div', { class: 'dm-product-text' },
          h('strong', {}, p.name),
          h('span', { class: 'dm-muted small' }, [SHOP_LABEL[p.source], p.size.map((v) => Math.round(v * 100)).join(' × ') + ' cm', p.price != null ? euro(p.price) : ''].filter(Boolean).join(' · '))),
        h('span', { class: 'dm-product-add' }, '+')))
        : h('p', { class: 'dm-muted small' }, 'Nichts gefunden.'));
  }

  private addProduct(p: ShopProduct): void {
    this.addObject(p.category, {
      label: p.name,
      size: [...p.size] as [number, number, number],
      color: p.color,
      product: { source: p.source, name: p.name, url: p.url, sku: '', image: p.image || undefined, price: p.price, catalog_id: p.id },
    });
    this.toast(`${p.name} eingefügt`);
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
          this.addObject(cat.value as Category, {
            label, color: color.value,
            size: [val(w, 0), val(d, 1), val(hh, 2)],
            product: { source: shopOf(link), name: label, url: link, sku: '', price: price.value ? Number(price.value) : null },
          });
        } }, 'Einfügen')),
    ));
  }

  /** Alle verlinkten Produkte der Wohnung mit Summe. */
  private showShoppingList(): void {
    if (!this.home) return;
    const rows: { room: string; o: SceneObject }[] = [];
    this.home.rooms.forEach((r, i) => {
      for (const o of r.scene.objects) if (o.product?.url) rows.push({ room: r.scene.room.name || `Raum ${i + 1}`, o });
    });
    const total = rows.reduce((sum, r) => sum + (r.o.product?.price ?? 0), 0);
    const missing = rows.filter((r) => r.o.product?.price == null).length;
    const amazon = rows.some((r) => r.o.product?.source === 'amazon');
    this.showOverlay(h('div', { class: 'dm-card' },
      h('h2', {}, 'Einkaufsliste'),
      rows.length
        ? h('div', { class: 'dm-shoplist' }, rows.map(({ room, o }) => h('div', {},
          this.productCard({ ...o.product!, name: o.label || o.product!.name }),
          h('span', { class: 'dm-muted small dm-shoplist-room' }, room))))
        : h('p', { class: 'dm-muted' }, 'Noch keine Produkte im Raum. Unter „Möbel“ findest du Produkte oder fügst eines per Link ein.'),
      rows.length > 0 && h('p', { class: 'dm-shoplist-total' }, h('strong', {}, `Summe: ${euro(total)}`),
        missing ? h('span', { class: 'dm-muted small' }, ` (ohne ${missing} Produkt${missing > 1 ? 'e' : ''} ohne Preis)`) : ''),
      rows.length > 0 && h('p', { class: 'dm-muted small' }, 'Preise wie beim Einfügen angegeben, der aktuelle Preis steht im Shop.'),
      amazon && this.amazonTag && h('p', { class: 'dm-muted small' }, 'Als Amazon-Partner verdienen wir an qualifizierten Verkäufen.'),
      h('div', { class: 'dm-row end' }, h('button', { class: 'dm-btn primary', onclick: () => this.hideOverlay() }, 'Schließen'))));
  }

  // ------------------------------------------------------------------ Möbel anpassen

  private furnitureMenu(): Child[] {
    const s = this.scene!;
    const sel = this.selection;
    const o = sel?.kind === 'object' ? s.objects.find((x) => x.id === sel.id) : undefined;
    const cats = Object.keys(this.catalog.categories) as Category[];
    const chips = (list: Category[]) => h('div', { class: 'dm-grid' }, list.map((c) =>
      h('button', { class: 'dm-chip', onclick: () => this.addObject(c) }, '+ ', this.catalog.categories[c].label)));
    const add = [
      h('h4', { style: o ? '' : 'margin-top:0' }, o ? 'Weiteres Möbel hinzufügen' : 'Möbel hinzufügen'),
      chips(cats.filter((c) => this.catalog.categories[c].group !== 'deko')),
      h('h4', {}, 'Deko'),
      chips(cats.filter((c) => this.catalog.categories[c].group === 'deko')),
      h('p', { class: 'dm-muted small' }, 'Bilder, Spiegel und Vorhänge kommen an die ausgewählte Wand, sonst an die Wand gegenüber der Kamera.'),
    ];
    const shop = this.productSection();
    if (!o) return [...shop, ...add];
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
      o.product?.url && this.productCard(o.product),
      field('Produkt-Link (IKEA, Amazon …)', h('input', {
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
      ...add,
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
    if (sel && s) {
      const btn = (label: string | Node, onclick: () => void, cls = '') => h('button', { class: `dm-btn small ${cls}`, onclick }, label);
      let name = '';
      const items: Child[] = [];
      if (sel.kind === 'object') {
        const o = s.objects.find((x) => x.id === sel.id);
        name = o?.label || 'Möbel';
        if (this.viewer.viewMode !== 'walk') {
          items.push(
            btn('✥', () => this.setGizmo('translate'), this.gizmoMode === 'translate' ? 'primary' : ''),
            btn('⟳', () => this.setGizmo('rotate'), this.gizmoMode === 'rotate' ? 'primary' : ''));
        }
        items.push(btn('Farbe', () => this.openMenu('color')), btn('Maße', () => this.openMenu('furniture')), btn(icon(TRASH), () => this.deleteObject(sel.id), 'danger icon'));
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

  private async renderImage(): Promise<void> {
    const demo = this.opts.demo;
    if (demo?.renderUrl) {
      this.showOverlay(h('div', { class: 'dm-card wide' },
        h('img', { src: demo.renderUrl, class: 'dm-render', alt: 'Gerendertes Bild des Raums' }),
        h('p', { class: 'dm-muted small' }, 'Vorab gerendertes Beispielbild, zeigt den Raum vor deinen Änderungen. Das KI-Rendering der aktuellen Ansicht ist in Arbeit.'),
        h('div', { class: 'dm-row end' },
          h('button', { class: 'dm-btn primary', onclick: () => this.hideOverlay() }, 'Schließen'))));
      return;
    }
    this.demoNotice('Das fotorealistische KI-Rendering der aktuellen Ansicht ist in Arbeit.');
  }

  // ================================================================== Hilfen

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
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

type MenuId = 'view' | 'room' | 'select' | 'remove' | 'color' | 'furniture' | 'style';

const TRASH = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>';

const MENUS: { id: MenuId; label: string; icon: string }[] = [
  { id: 'view', label: 'Ansicht', icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>' },
  { id: 'room', label: 'Raum', icon: '<path d="M4 4h16v16H4z"/><path d="M4 13h7v7M14 4v6h6"/>' },
  { id: 'select', label: 'Auswahl', icon: '<path d="M6 3l12 7-5.5 1.5L10 17z"/><path d="M13 13l5 6"/>' },
  { id: 'remove', label: 'Entfernen', icon: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>' },
  { id: 'color', label: 'Farbe', icon: '<path d="M12 3a9 9 0 100 18c1.4 0 2-.9 2-1.8 0-1.4-1-1.9 0-2.9s3 0 4.2-1.1C20.5 14 21 13 21 11c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1.1"/><circle cx="10" cy="7.5" r="1.1"/><circle cx="15" cy="7.5" r="1.1"/>' },
  { id: 'furniture', label: 'Möbel', icon: '<path d="M5 11V8a2 2 0 012-2h10a2 2 0 012 2v3"/><path d="M3 12a2 2 0 014 0v2h10v-2a2 2 0 014 0v5H3z"/><path d="M5 17v2M19 17v2"/>' },
  { id: 'style', label: 'Style', icon: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>' },
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
