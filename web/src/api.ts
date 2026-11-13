import type { Catalog, Project, Scene } from './types';

export class Api {
  constructor(private base: string) {
    this.base = base.replace(/\/$/, '');
  }

  url(path: string): string {
    return path.startsWith('http') ? path : this.base + path;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), init);
    if (!res.ok) {
      let message = `Fehler ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* keine JSON-Antwort */
      }
      throw new Error(message);
    }
    return res.json() as Promise<T>;
  }

  health() {
    return this.request<{ ok: boolean; analysis_available: boolean }>('/api/health');
  }

  catalog() {
    return this.request<Catalog>('/api/catalog');
  }

  project(id: string) {
    return this.request<Project>(`/api/projects/${id}`);
  }

  createProject(kind: string, files: File[], hint: string) {
    const form = new FormData();
    form.append('kind', kind);
    form.append('hint', hint);
    for (const f of files) form.append('files', f, f.name);
    return this.request<{ id: string }>('/api/projects', { method: 'POST', body: form });
  }

  saveScene(id: string, scene: Scene) {
    return this.request<Project>(`/api/projects/${id}/scene`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scene),
    });
  }
}
