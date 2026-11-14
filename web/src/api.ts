import type { AnalysisInput } from './analysis';
import type { Catalog, Home, Project, ProjectSummary, Scene, ShopProduct } from './types';

/**
 * Schnittstelle zum WordPress-Plugin (REST-Namespace dm3d/v1, siehe wordpress-plugin/).
 * base ist z. B. https://example.de/wp-json/dm3d/v1, nonce der WordPress-REST-Nonce.
 */
export class Api {
  constructor(private base: string, private nonce = '') {
    this.base = base.replace(/\/$/, '');
  }

  url(path: string): string {
    return path.startsWith('http') ? path : this.base + path;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.nonce) headers.set('X-WP-Nonce', this.nonce);
    const res = await fetch(this.url(path), { ...init, headers, credentials: 'same-origin' });
    if (!res.ok) {
      let message = `Fehler ${res.status}`;
      try {
        const body = await res.json();
        const detail = body?.message ?? body?.detail;
        if (detail) message = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch {
        /* keine JSON-Antwort */
      }
      throw new Error(message);
    }
    return res.json() as Promise<T>;
  }

  private json<T>(path: string, method: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  products() {
    return this.request<{ products: ShopProduct[]; amazon_tag: string }>('/api/products');
  }

  demoScene() {
    return this.request<Scene>('/api/demo-scene');
  }

  health() {
    return this.request<{ ok: boolean; analysis_available: boolean; can_create: boolean; login_url?: string; version?: string }>('/api/health');
  }

  catalog() {
    return this.request<Catalog>('/api/catalog');
  }

  project(id: string) {
    return this.request<Project>(`/api/projects/${id}`);
  }

  createProject(kind: string, input: AnalysisInput | null, hint: string) {
    return this.json<{ id: string }>('/api/projects', 'POST', { kind, hint, ...(input ?? {}) });
  }

  /** Startet die KI-Analyse. Kann bis zu ein paar Minuten dauern, der Stand ist auch per project() abrufbar. */
  analyze(id: string) {
    return this.request<Project>(`/api/projects/${id}/analyze`, { method: 'POST' });
  }

  saveScene(id: string, scene: Scene | Home) {
    return this.json<Project>(`/api/projects/${id}/scene`, 'PUT', scene);
  }

  /** Name und Vorschaubild speichern („Speichern“). */
  saveMeta(id: string, meta: { name?: string; thumb?: string }) {
    return this.json<Project>(`/api/projects/${id}/meta`, 'POST', meta);
  }

  copyProject(id: string, name: string) {
    return this.json<{ id: string }>(`/api/projects/${id}/copy`, 'POST', { name });
  }

  deleteProject(id: string) {
    return this.request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });
  }

  /** Eigene Projekte (angemeldet) und die im Browser gemerkten. */
  myProjects(ids: string[]) {
    // Basis kann schon ?rest_route=… enthalten (WordPress ohne schöne Permalinks)
    const sep = this.base.includes('?') ? '&' : '?';
    return this.request<{ projects: ProjectSummary[] }>(`/api/my-projects${sep}ids=${encodeURIComponent(ids.join(','))}`);
  }
}
