import './style.css';
import { App } from './app';

/**
 * Einstieg. Sucht ein Element mit data-diy-mamis (WordPress-Shortcode) oder #app (Entwicklung).
 * data-api: Adresse des Backends, z. B. https://app.example.de (leer = gleiche Domain).
 */
function boot(): void {
  const el = document.querySelector<HTMLElement>('[data-diy-mamis]') ?? document.getElementById('app');
  if (!el) return;
  const apiBase = el.dataset.api ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  new App(el, { apiBase }).start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
