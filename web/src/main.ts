import './style.css';
import { App, type DemoData } from './app';

/**
 * Einstieg. Sucht ein Element mit data-diy-mamis (WordPress-Shortcode) oder #app (Entwicklung).
 * data-api: Adresse des Backends, z. B. https://app.example.de (leer = gleiche Domain).
 */
async function boot(): Promise<void> {
  const el = document.querySelector<HTMLElement>('[data-diy-mamis]') ?? document.getElementById('app');
  if (!el) return;
  const apiBase = el.dataset.api ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  // data-demo: Ordner mit scene.json, catalog.json, room.glb, library.glb (und optional render.png).
  // data-room / data-library: andere Dateinamen, z. B. eingebettetes glTF als .json für Hosts ohne .glb.
  const demoDir = el.dataset.demo;
  let demo: DemoData | undefined;
  if (demoDir !== undefined) {
    const base = demoDir.replace(/\/?$/, '/');
    const [scene, catalog] = await Promise.all(
      ['scene.json', 'catalog.json'].map((f) => fetch(base + f).then((r) => r.json())));
    demo = {
      title: el.dataset.title ?? scene.room?.name ?? 'Raumplaner',
      scene, catalog,
      glbUrl: base + (el.dataset.room ?? 'room.glb'),
      libraryUrl: base + (el.dataset.library ?? 'library.glb'),
      renderUrl: el.dataset.render ?? base + 'render.png',
    };
  }
  new App(el, { apiBase, demo }).start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
