// Szenenformat (Version 1). Koordinaten in Metern, Grundriss in der x/y-Ebene, z nach oben.

export type Category =
  | 'sofa' | 'armchair' | 'chair' | 'dining_table' | 'coffee_table' | 'side_table' | 'desk'
  | 'bed' | 'wardrobe' | 'shelf' | 'sideboard' | 'tv' | 'lamp' | 'plant' | 'rug' | 'box';

export interface Opening {
  id: string;
  type: 'door' | 'window';
  offset: number;
  width: number;
  height: number;
  sill: number;
}

export interface Panel {
  id: string;
  type: 'slats' | 'wainscot' | 'flat';
  offset: number;
  width: number | null;
  height: number;
  bottom: number;
  color: string;
}

export interface Wall {
  id: string;
  color: string;
  thickness: number;
  openings: Opening[];
  panels: Panel[];
}

export interface Product {
  source: 'ikea' | 'amazon' | 'other';
  name: string;
  url: string;
  sku: string;
}

export interface SceneObject {
  id: string;
  category: Category;
  label: string;
  position: [number, number, number];
  rotation: number;
  size: [number, number, number];
  color: string;
  product?: Product | null;
}

export interface Surface {
  material: string;
  color: string;
}

export interface Scene {
  version: number;
  room: { name: string; height: number; polygon: [number, number][] };
  walls: Wall[];
  floor: Surface;
  ceiling: Surface;
  objects: SceneObject[];
  meta: { source: string; notes: string; dimensions_confirmed: boolean };
}

/** Ein Raum der Wohnung mit seiner Lage im gemeinsamen Grundriss (Drehung in Grad, gegen den Uhrzeigersinn). */
export interface PlacedRoom {
  id: string;
  position: [number, number];
  rotation: number;
  scene: Scene;
}

/** Wohnung: mehrere Räume, die über Türen verbunden sind (Format Version 2). */
export interface Home {
  version: 2;
  rooms: PlacedRoom[];
}

export interface Project {
  id: string;
  state: 'queued' | 'analyzing' | 'ready' | 'error' | 'unknown';
  step: string;
  error: string | null;
  version: number;
  kind?: string;
  /** Version 1: ein Raum (Scene), Version 2: Wohnung (Home). */
  scene: Scene | Home | null;
  /** Rohantwort der KI, solange daraus noch keine Szene gebaut wurde. */
  analysis?: import('./analysis').RoomAnalysis | null;
}

export interface Catalog {
  categories: Record<Category, { label: string; size: [number, number, number]; color: string }>;
  panels: Record<Panel['type'], { label: string; height: number; color: string }>;
  floor_materials: Record<string, { label: string; color: string }>;
}

export type Selection =
  | { kind: 'object'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'panel'; id: string }
  | { kind: 'floor' }
  | { kind: 'ceiling' }
  | null;
