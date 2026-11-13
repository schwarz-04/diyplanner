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
  // data-demo: Ordner mit scene.json und catalog.json; data-render: optional ein vorab gerendertes Bild.
  const demoDir = el.dataset.demo;
  let demo: DemoData | undefined;
  if (demoDir !== undefined) {
    const base = demoDir.replace(/\/?$/, '/');
    const [scene, catalog] = await Promise.all(
      ['scene.json', 'catalog.json'].map((f) => fetch(base + f).then((r) => r.json())));
    demo = {
      title: el.dataset.title ?? scene.room?.name ?? 'Raumplaner',
      scene, catalog,
      renderUrl: el.dataset.render,
    };
  }
  new App(el, { apiBase, nonce: el.dataset.nonce, demo }).start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
