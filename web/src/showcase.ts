import { clone } from './edits';
import { toHome } from './home';
import type { Home, Scene, SceneObject } from './types';
import type { Viewer } from './viewer';

/**
 * Hintergrund der Startseite: Die Demo-Wohnung wird Raum für Raum wie von Geisterhand eingerichtet,
 * während sich die Kamera langsam um die ganze Wohnung dreht. Zeigt in Kurzform, was man mit dem Raumplaner macht.
 */

interface Step { caption: string; wait: number; room: number; run: (s: Scene) => { rebuild: boolean; added?: string; fade?: [string, string][] } }

const ORDER = ['rug', 'sofa', 'bed', 'coffee_table', 'dining_table', 'armchair', 'chair', 'sideboard', 'wardrobe', 'tv', 'shelf', 'lamp', 'plant'];

export class Showcase {
  private timer: number | undefined;
  private running = false;
  private home!: Home;
  private base: Home;

  constructor(private viewer: Viewer, base: Scene | Home, private onCaption: (text: string) => void) {
    this.base = toHome(base);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.viewer.measure.setRoomVisible(false);
    this.viewer.controls.autoRotate = true;
    this.viewer.controls.autoRotateSpeed = 0.7;
    this.loop();
  }

  stop(): void {
    this.running = false;
    window.clearTimeout(this.timer);
    this.viewer.controls.autoRotate = false;
    this.viewer.measure.setRoomVisible(true);
    this.onCaption('');
  }

  private loop(): void {
    this.home = clone(this.base);
    for (const r of this.home.rooms) {
      r.scene.objects = [];
      for (const w of r.scene.walls) { w.color = '#f1efea'; w.panels = []; }
    }
    const main = Math.max(0, this.base.rooms.findIndex((r) => /wohn/i.test(r.scene.room.name)));
    this.home.rooms[main].scene.floor.color = '#cfc6b8';
    this.viewer.setHome(clone(this.home), main, false);
    this.viewer.setMode('orbit');

    const many = this.home.rooms.length > 1;
    const steps: Step[] = [{ caption: many ? 'Wohnung aus deinem Grundriss erkannt' : 'Raum aus deinem Video erkannt', wait: 1800, room: main, run: () => ({ rebuild: false }) }];
    // Wohnzimmer zuerst, dann die anderen Räume
    const order = [main, ...this.base.rooms.map((_, i) => i).filter((i) => i !== main)];
    for (const ri of order) {
      const name = this.base.rooms[ri].scene.room.name;
      const furniture = [...this.base.rooms[ri].scene.objects].sort((a, b) => rank(a) - rank(b));
      for (const o of furniture) {
        steps.push({
          caption: many ? `${name}: ${o.label || 'Möbel'}` : `${o.label || 'Möbel'} hinzufügen`, wait: many ? 480 : 750, room: ri,
          run: (s) => { s.objects.push(clone(o)); return { rebuild: true, added: o.id }; },
        });
      }
    }
    const living = this.home.rooms[main].scene;
    const wall = living.walls[1] ?? living.walls[0];
    const sofa = this.base.rooms[main].scene.objects.find((o) => o.category === 'sofa');
    steps.push(
      { caption: 'Wandfarbe ändern', wait: 1500, room: main, run: (s) => {
        const w = s.walls.find((x) => x.id === wall.id)!;
        w.color = '#a9b9a6';
        return { rebuild: false, fade: [[w.id, w.color]] };
      } },
      { caption: 'Holzpaneele an die Wand', wait: 1500, room: main, run: (s) => {
        s.walls.find((x) => x.id === wall.id)!.panels.push({
          id: 'pn_showcase', type: 'slats', offset: 0.4, width: 1.8, height: Math.min(2.4, s.room.height), bottom: 0, color: '#9c7650',
        });
        return { rebuild: true };
      } },
      { caption: 'Boden wählen', wait: 1500, room: main, run: (s) => {
        s.floor.color = this.base.rooms[main].scene.floor.color || '#b48a60';
        return { rebuild: false, fade: [['floor', s.floor.color]] };
      } },
    );
    if (sofa) {
      steps.push({ caption: 'Sofa umfärben', wait: 2600, room: main, run: (s) => {
        const o = s.objects.find((x) => x.id === sofa.id);
        if (!o) return { rebuild: false };
        o.color = '#c98f7a';
        return { rebuild: false, fade: [[o.id, o.color]] };
      } });
    }
    let i = 0;
    let shown = main;
    const next = () => {
      if (!this.running) return;
      if (i >= steps.length) {
        this.timer = window.setTimeout(() => this.running && this.loop(), 1500);
        return;
      }
      const step = steps[i++];
      const res = step.run(this.home.rooms[step.room].scene);
      // Neu aufbauen, wenn sich etwas geändert hat oder ein anderer Raum dran ist (Kamera bleibt)
      if (res.rebuild || step.room !== shown) {
        this.viewer.setHome(clone(this.home), step.room, true);
        shown = step.room;
      }
      if (res.added) this.viewer.animateIn(res.added);
      for (const [key, hex] of res.fade ?? []) this.viewer.fadeColor(key, hex, 900);
      this.onCaption(step.caption);
      this.timer = window.setTimeout(next, step.wait);
    };
    this.timer = window.setTimeout(next, 400);
  }
}

function rank(o: SceneObject): number {
  const i = ORDER.indexOf(o.category);
  return i < 0 ? ORDER.length : i;
}
