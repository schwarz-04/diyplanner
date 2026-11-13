import { Api } from './api';
import { analysisToScene, prepareInput } from './analysis';
import { Viewer } from './viewer';
import {
  clone, cm, findPanel, m, newObject, newPanel, roomArea, setWallLength, uid, wallIndex, wallLength,
} from './edits';
import type { Catalog, Category, Panel, Project, Scene, SceneObject, Selection } from './types';

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
  private scene: Scene | null = null;
  private selection: Selection = null;
  private undoStack: Scene[] = [];
  private redoStack: Scene[] = [];
  private saveTimer: number | undefined;
  private saveChain: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private analysisAvailable = false;
  private canCreate = true;
  private loginUrl = '';
  private proportional = false;
  private gizmoMode: 'translate' | 'rotate' = 'translate';

  // DOM
  private elStatus = h('span', { class: 'dm-status' });
  private elTitle = h('span', { class: 'dm-title' }, 'Raumplaner');
  private elPanel = h('aside', { class: 'dm-panel' });
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
        h('div', { class: 'dm-brand' }, h('span', { class: 'dm-logo' }, '◆'), this.elTitle),
        h('div', { class: 'dm-actions' },
          this.btnUndo, this.btnRedo,
          h('span', { class: 'dm-sep' }),
          h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.setMode('orbit') }, '3D'),
          h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.setMode('top') }, 'Draufsicht'),
          h('button', { class: 'dm-btn ghost', onclick: () => this.renderImage() }, 'Foto-Rendering'),
          h('button', { class: 'dm-btn ghost', onclick: () => this.showStart() }, 'Neuer Raum'),
          this.elStatus,
        ),
      ),
      h('div', { class: 'dm-main' }, h('div', { class: 'dm-stage' }, this.elCanvas, this.elToolbar), this.elPanel),
      this.elOverlay,
    );
    this.viewer = new Viewer(this.elCanvas, {
      onSelect: (sel) => this.select(sel),
      onObjectMoved: (id, pos, rot) => this.objectMoved(id, pos, rot),
    });
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
      this.scene = d.scene;
      this.viewer.setScene(d.scene, false);
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

  private async openProject(id: string): Promise<void> {
    this.showProgress('Projekt wird geladen');
    try {
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
      this.project = p;
      this.scene = p.scene;
      this.undoStack = [];
      this.redoStack = [];
      const url = new URL(location.href);
      url.searchParams.set(this.opts.projectParam ?? 'projekt', id);
      history.replaceState(null, '', url);
      this.viewer.setScene(p.scene, false);
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
    if (!this.scene) return;
    this.undoStack.push(this.scene);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.show(next, rebuild);
  }

  private show(next: Scene, rebuild: boolean): void {
    this.scene = next;
    if (rebuild) {
      this.viewer.setScene(next, true);
      this.renderPanel();
    } else {
      this.viewer.updateData(next);
    }
    this.updateButtons();
    this.scheduleSave();
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
    const snapshot = this.scene!;
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
    if (!prev || !this.scene) return;
    this.redoStack.push(this.scene);
    this.show(prev, true);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next || !this.scene) return;
    this.undoStack.push(this.scene);
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

  private async addObject(category: Category): Promise<void> {
    const next = clone(this.scene!);
    const obj = newObject(next, this.catalog, category);
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

  // ================================================================== Seitenleiste

  private select(sel: Selection): void {
    this.selection = sel;
    this.renderPanel();
    this.renderToolbar();
  }

  private renderPanel(): void {
    const s = this.scene;
    this.elPanel.replaceChildren();
    if (!s) return;
    this.elTitle.textContent = s.room.name || 'Raumplaner';
    const sel = this.selection;
    if (sel?.kind === 'object') {
      const o = s.objects.find((x) => x.id === sel.id);
      if (o) return this.fill(this.objectPanel(o));
    }
    if (sel?.kind === 'wall') {
      const i = wallIndex(s, sel.id);
      if (i >= 0) return this.fill(this.wallPanel(i));
    }
    if (sel?.kind === 'panel') {
      const found = findPanel(s, sel.id);
      if (found) return this.fill(this.panelPanel(found.panel, found.wallIndex));
    }
    if (sel?.kind === 'floor') return this.fill(this.floorPanel());
    if (sel?.kind === 'ceiling') return this.fill(this.ceilingPanel());
    this.fill(this.roomPanel());
  }

  private fill(nodes: Child[]): void {
    for (const n of nodes) if (n) this.elPanel.append(n);
  }

  private roomPanel(): Child[] {
    const s = this.scene!;
    const heightInput = numberInput(cm(s.room.height), 180, 600, (v) =>
      this.rebuildWith((n) => (n.room.height = m(v))));
    const walls = s.walls.map((w, i) =>
      h('div', { class: 'dm-wallrow' },
        h('button', {
          class: 'dm-link',
          onclick: () => this.viewer.setSelection({ kind: 'wall', id: w.id }, true),
        }, `Wand ${i + 1}`),
        numberInput(cm(wallLength(s, i)), 30, 3000, (v) =>
          this.apply(setWallLength(s, i, m(v), this.proportional), true), 'cm'),
      ));
    const proportional = h('input', {
      type: 'checkbox', checked: this.proportional,
      onchange: (e: Event) => (this.proportional = (e.target as HTMLInputElement).checked),
    });
    return [
      h('h3', {}, 'Raum'),
      field('Name', h('input', {
        class: 'dm-input', value: s.room.name,
        onchange: (e: Event) => this.apply({ ...clone(s), room: { ...clone(s.room), name: (e.target as HTMLInputElement).value } }, false)
          .then(() => this.renderPanel()),
      })),
      h('p', { class: 'dm-muted' }, `${roomArea(s).toFixed(1).replace('.', ',')} m² · ${s.objects.length} Möbel`),
      field('Deckenhöhe', heightInput),
      h('h4', {}, 'Wandmaße'),
      h('p', { class: 'dm-muted small' }, s.meta.dimensions_confirmed
        ? 'Maße wurden angepasst.'
        : 'Die Maße sind geschätzt. Trage gemessene Werte ein, der Raum passt sich an.'),
      ...walls,
      h('label', { class: 'dm-check' }, proportional, 'Ganzen Raum proportional skalieren'),
      h('h4', {}, 'Möbel hinzufügen'),
      h('div', { class: 'dm-grid' },
        (Object.keys(this.catalog.categories) as Category[]).map((c) =>
          h('button', { class: 'dm-chip', onclick: () => this.addObject(c) }, this.catalog.categories[c].label))),
      h('h4', {}, 'Aktionen'),
      h('div', { class: 'dm-col' },
        h('button', { class: 'dm-btn', onclick: () => this.emptyRoom(), disabled: !s.objects.length }, 'Raum leeren (alle Möbel entfernen)'),
        h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.setSelection({ kind: 'floor' }, true) }, 'Boden bearbeiten'),
        h('button', { class: 'dm-btn ghost', onclick: () => this.viewer.setSelection({ kind: 'ceiling' }, true) }, 'Decke bearbeiten'),
      ),
      s.meta.notes && h('details', { class: 'dm-notes' }, h('summary', {}, 'Hinweise der KI'), h('pre', {}, s.meta.notes)),
      h('p', { class: 'dm-muted small' }, 'Tipp: Klicke auf ein Möbelstück, eine Wand oder den Boden, um es zu bearbeiten.'),
    ];
  }

  private objectPanel(o: SceneObject): Child[] {
    const s = this.scene!;
    const update = (mutate: (x: SceneObject) => void, rebuild: boolean) => {
      const next = clone(s);
      mutate(next.objects.find((x) => x.id === o.id)!);
      return this.apply(next, rebuild);
    };
    const sizeInput = (axis: 0 | 1 | 2) =>
      numberInput(cm(o.size[axis]), 1, 1000, (v) => update((x) => (x.size[axis] = m(v)), true), 'cm');
    return [
      backLink(() => this.viewer.setSelection(null, true)),
      h('h3', {}, o.label || this.catalog.categories[o.category]?.label),
      field('Bezeichnung', h('input', {
        class: 'dm-input', value: o.label,
        onchange: (e: Event) => update((x) => (x.label = (e.target as HTMLInputElement).value), false).then(() => this.renderPanel()),
      })),
      field('Farbe', colorInput(o.color, (c) => this.recolor(o.id, c, (n) => (n.objects.find((x) => x.id === o.id)!.color = c)))),
      h('h4', {}, 'Maße'),
      h('div', { class: 'dm-row three' },
        field('Breite', sizeInput(0)), field('Tiefe', sizeInput(1)), field('Höhe', sizeInput(2))),
      h('div', { class: 'dm-row three' },
        field('Drehung', numberInput(Math.round(o.rotation), -360, 720, (v) => update((x) => (x.rotation = ((v % 360) + 360) % 360), true), '°')),
        field('Über Boden', numberInput(cm(o.position[2]), 0, 300, (v) => update((x) => (x.position[2] = m(v)), true), 'cm')),
      ),
      h('h4', {}, 'Produkt'),
      h('p', { class: 'dm-muted small' }, 'Später: echtes Möbel von IKEA oder Amazon verknüpfen. Die Maße werden dann übernommen.'),
      field('Link', h('input', {
        class: 'dm-input', type: 'url', placeholder: 'https://…', value: o.product?.url ?? '',
        onchange: (e: Event) => update((x) => {
          const url = (e.target as HTMLInputElement).value.trim();
          const source = url.includes('ikea.') ? 'ikea' : url.includes('amazon.') ? 'amazon' : 'other';
          x.product = url ? { source, name: x.label, url, sku: '' } : null;
        }, false),
      })),
      h('div', { class: 'dm-col' },
        h('button', { class: 'dm-btn', onclick: () => this.duplicateObject(o.id) }, 'Duplizieren'),
        h('button', { class: 'dm-btn danger', onclick: () => this.deleteObject(o.id) }, 'Löschen'),
      ),
    ];
  }

  private wallPanel(i: number): Child[] {
    const s = this.scene!;
    const w = s.walls[i];
    let panelType: Panel['type'] = 'slats';
    const typeSelect = h('select', {
      class: 'dm-input',
      onchange: (e: Event) => (panelType = (e.target as HTMLSelectElement).value as Panel['type']),
    }, (Object.keys(this.catalog.panels) as Panel['type'][]).map((t) => h('option', { value: t }, this.catalog.panels[t].label)));
    return [
      backLink(() => this.viewer.setSelection(null, true)),
      h('h3', {}, `Wand ${i + 1}`),
      field('Wandfarbe', colorInput(w.color, (c) => this.recolor(w.id, c, (n) => (n.walls[i].color = c)))),
      h('div', { class: 'dm-swatches' }, WALL_COLORS.map((c) =>
        h('button', {
          class: 'dm-swatch', style: `background:${c}`, title: c,
          onclick: () => { this.recolor(w.id, c, (n) => (n.walls[i].color = c)); this.renderPanel(); },
        }))),
      field('Länge (gemessen)', numberInput(cm(wallLength(s, i)), 30, 3000, (v) =>
        this.apply(setWallLength(s, i, m(v), this.proportional), true), 'cm')),
      h('h4', {}, 'Wandpaneele'),
      ...w.panels.map((p) =>
        h('div', { class: 'dm-wallrow' },
          h('button', { class: 'dm-link', onclick: () => this.viewer.setSelection({ kind: 'panel', id: p.id }, true) },
            this.catalog.panels[p.type]?.label ?? p.type),
          h('button', { class: 'dm-btn small danger', onclick: () => this.rebuildWith((n) => {
            n.walls[i].panels = n.walls[i].panels.filter((x) => x.id !== p.id);
          }) }, 'Entfernen'))),
      h('div', { class: 'dm-row' }, typeSelect,
        h('button', { class: 'dm-btn primary', onclick: () => this.rebuildWith((n) => {
          n.walls[i].panels.push(newPanel(this.catalog, panelType, n.room.height));
        }) }, 'Hinzufügen')),
      w.openings.length > 0 && h('h4', {}, 'Fenster & Türen'),
      ...w.openings.map((op) =>
        h('div', { class: 'dm-wallrow' },
          h('span', {}, `${op.type === 'door' ? 'Tür' : 'Fenster'} · ${cm(op.width)} × ${cm(op.height)} cm`),
          h('button', { class: 'dm-btn small danger', onclick: () => this.rebuildWith((n) => {
            n.walls[i].openings = n.walls[i].openings.filter((x) => x.id !== op.id);
          }) }, 'Entfernen'))),
      h('div', { class: 'dm-row' },
        h('button', { class: 'dm-btn small', onclick: () => this.rebuildWith((n) => {
          n.walls[i].openings.push({ id: uid('op'), type: 'window', offset: wallLength(n, i) / 2, width: 1.2, height: 1.3, sill: 0.9 });
        }) }, '+ Fenster'),
        h('button', { class: 'dm-btn small', onclick: () => this.rebuildWith((n) => {
          n.walls[i].openings.push({ id: uid('op'), type: 'door', offset: Math.min(0.8, wallLength(n, i) / 2), width: 0.86, height: 2.01, sill: 0 });
        }) }, '+ Tür'),
      ),
    ];
  }

  private panelPanel(p: Panel, wi: number): Child[] {
    const update = (mutate: (x: Panel) => void, rebuild: boolean) => {
      const next = clone(this.scene!);
      mutate(next.walls[wi].panels.find((x) => x.id === p.id)!);
      return this.apply(next, rebuild);
    };
    return [
      backLink(() => this.viewer.setSelection({ kind: 'wall', id: this.scene!.walls[wi].id }, true), 'Zur Wand'),
      h('h3', {}, this.catalog.panels[p.type]?.label ?? 'Paneel'),
      field('Farbe', colorInput(p.color, (c) => this.recolor(p.id, c, (n) => (n.walls[wi].panels.find((x) => x.id === p.id)!.color = c)))),
      field('Art', h('select', {
        class: 'dm-input',
        onchange: (e: Event) => update((x) => (x.type = (e.target as HTMLSelectElement).value as Panel['type']), true),
      }, (Object.keys(this.catalog.panels) as Panel['type'][]).map((t) =>
        h('option', { value: t, selected: t === p.type }, this.catalog.panels[t].label)))),
      h('div', { class: 'dm-row three' },
        field('Höhe', numberInput(cm(p.height), 20, 600, (v) => update((x) => (x.height = m(v)), true), 'cm')),
        field('Start', numberInput(cm(p.offset), 0, 3000, (v) => update((x) => (x.offset = m(v)), true), 'cm')),
        field('Breite', numberInput(p.width ? cm(p.width) : 0, 0, 3000, (v) => update((x) => (x.width = v > 0 ? m(v) : null), true), 'cm')),
      ),
      h('p', { class: 'dm-muted small' }, 'Breite 0 = über die ganze Wand. Fenster und Türen werden ausgespart.'),
      h('button', { class: 'dm-btn danger', onclick: () => {
        this.rebuildWith((n) => { n.walls[wi].panels = n.walls[wi].panels.filter((x) => x.id !== p.id); });
        this.viewer.setSelection({ kind: 'wall', id: this.scene!.walls[wi].id }, true);
      } }, 'Paneel entfernen'),
    ];
  }

  private floorPanel(): Child[] {
    const s = this.scene!;
    return [
      backLink(() => this.viewer.setSelection(null, true)),
      h('h3', {}, 'Boden'),
      field('Material', h('select', {
        class: 'dm-input',
        onchange: (e: Event) => {
          const mat = (e.target as HTMLSelectElement).value;
          const color = this.catalog.floor_materials[mat]?.color ?? s.floor.color;
          this.recolor('floor', color, (n) => { n.floor.material = mat; n.floor.color = color; });
          this.renderPanel();
        },
      }, Object.entries(this.catalog.floor_materials).map(([k, v]) =>
        h('option', { value: k, selected: k === s.floor.material }, v.label)))),
      field('Farbe', colorInput(s.floor.color, (c) => this.recolor('floor', c, (n) => (n.floor.color = c)))),
    ];
  }

  private ceilingPanel(): Child[] {
    const s = this.scene!;
    return [
      backLink(() => this.viewer.setSelection(null, true)),
      h('h3', {}, 'Decke'),
      field('Farbe', colorInput(s.ceiling.color, (c) => this.recolor('ceiling', c, (n) => (n.ceiling.color = c)))),
      h('p', { class: 'dm-muted small' }, 'Die Decke ist nur sichtbar, wenn die Kamera im Raum ist.'),
    ];
  }

  private renderToolbar(): void {
    const sel = this.selection;
    this.elToolbar.replaceChildren();
    this.elToolbar.hidden = sel?.kind !== 'object';
    if (sel?.kind !== 'object') return;
    const mk = (mode: 'translate' | 'rotate', label: string) =>
      h('button', {
        class: `dm-btn small${this.gizmoMode === mode ? ' primary' : ''}`,
        onclick: () => { this.gizmoMode = mode; this.viewer.setGizmoMode(mode); this.renderToolbar(); },
      }, label);
    this.viewer.setGizmoMode(this.gizmoMode);
    this.elToolbar.append(
      mk('translate', 'Verschieben'),
      mk('rotate', 'Drehen'),
      h('button', { class: 'dm-btn small danger', onclick: () => this.deleteObject(sel.id) }, 'Löschen'),
    );
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
    else if (e.key === 'r' && this.selection?.kind === 'object') { this.gizmoMode = 'rotate'; this.renderToolbar(); }
    else if (e.key === 'g' && this.selection?.kind === 'object') { this.gizmoMode = 'translate'; this.renderToolbar(); }
    else if (e.key === 'Escape') this.viewer.setSelection(null, true);
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

function backLink(onClick: () => void, label = 'Zum Raum'): HTMLElement {
  return h('button', { class: 'dm-link back', onclick: onClick }, `← ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
