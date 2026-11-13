import { clone } from './edits';
import type { Scene, SceneObject } from './types';
import type { Viewer } from './viewer';

/**
 * Hintergrund der Startseite: Der Demo-Raum wird wie von Geisterhand eingerichtet,
 * während sich die Kamera langsam dreht. Zeigt in Kurzform, was man mit dem Raumplaner macht.
 */

interface Step { caption: string; wait: number; run: (s: Scene) => { rebuild: boolean; added?: string; fade?: [string, string][] } }

const ORDER = ['rug', 'sofa', 'coffee_table', 'armchair', 'sideboard', 'tv', 'shelf', 'lamp', 'plant'];

export class Showcase {
  private timer: number | undefined;
  private running = false;
  private scene!: Scene;

  constructor(private viewer: Viewer, private base: Scene, private onCaption: (text: string) => void) {}

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
    const furniture = [...this.base.objects].sort((a, b) => rank(a) - rank(b));
    this.scene = clone(this.base);
    this.scene.objects = [];
    for (const w of this.scene.walls) { w.color = '#f1efea'; w.panels = []; }
    this.scene.floor.color = '#cfc6b8';
    this.viewer.setScene(this.scene, false);
    this.viewer.setMode('orbit');

    const steps: Step[] = [{ caption: 'Raum aus deinem Video erkannt', wait: 1800, run: () => ({ rebuild: false }) }];
    for (const o of furniture) {
      steps.push({
        caption: `${o.label || 'Möbel'} hinzufügen`, wait: 750,
        run: (s) => { s.objects.push(clone(o)); return { rebuild: true, added: o.id }; },
      });
    }
    const wall = this.scene.walls[1] ?? this.scene.walls[0];
    const sofa = furniture.find((o) => o.category === 'sofa');
    steps.push(
      { caption: 'Wandfarbe ändern', wait: 1500, run: (s) => {
        const w = s.walls.find((x) => x.id === wall.id)!;
        w.color = '#a9b9a6';
        return { rebuild: false, fade: [[w.id, w.color]] };
      } },
      { caption: 'Holzpaneele an die Wand', wait: 1500, run: (s) => {
        s.walls.find((x) => x.id === wall.id)!.panels.push({
          id: 'pn_showcase', type: 'slats', offset: 0.4, width: 1.8, height: Math.min(2.4, s.room.height), bottom: 0, color: '#9c7650',
        });
        return { rebuild: true };
      } },
      { caption: 'Boden wählen', wait: 1500, run: (s) => {
        s.floor.color = '#b48a60';
        return { rebuild: false, fade: [['floor', s.floor.color]] };
      } },
    );
    if (sofa) {
      steps.push({ caption: 'Sofa umfärben', wait: 2600, run: (s) => {
        const o = s.objects.find((x) => x.id === sofa.id);
        if (!o) return { rebuild: false };
        o.color = '#c98f7a';
        return { rebuild: false, fade: [[o.id, o.color]] };
      } });
    }
    let i = 0;
    const next = () => {
      if (!this.running) return;
      if (i >= steps.length) {
        this.timer = window.setTimeout(() => this.running && this.loop(), 1500);
        return;
      }
      const step = steps[i++];
      const res = step.run(this.scene);
      if (res.rebuild) this.viewer.setScene(clone(this.scene), true);
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
