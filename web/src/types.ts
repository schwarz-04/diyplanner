// Szenenformat (Version 1). Koordinaten in Metern, Grundriss in der x/y-Ebene, z nach oben.

export type Category =
  | 'sofa' | 'armchair' | 'chair' | 'dining_table' | 'coffee_table' | 'side_table' | 'desk'
  | 'bed' | 'wardrobe' | 'shelf' | 'sideboard' | 'tv' | 'lamp' | 'plant' | 'rug' | 'box'
  | 'dresser' | 'nightstand' | 'pouf' | 'wall_shelf'
  | 'cushion' | 'vase' | 'table_lamp' | 'basket' | 'picture' | 'mirror' | 'curtain' | 'pendant';

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
  /** Produktbild (URL) */
  image?: string;
  /** Preis in Euro, wie bei der Auswahl angegeben */
  price?: number | null;
  /** Eintrag aus der Produktliste der Webseite */
  catalog_id?: string;
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
  categories: Record<Category, {
    label: string; size: [number, number, number]; color: string;
    /** deko = Dekoration, sonst Möbel */
    group?: 'deko';
    /** wall: hängt an der Wand, ceiling: hängt von der Decke */
    mount?: 'wall' | 'ceiling';
    /** Standardhöhe über dem Boden (Unterkante) */
    z?: number;
  }>;
  panels: Record<Panel['type'], { label: string; height: number; color: string }>;
  floor_materials: Record<string, { label: string; color: string }>;
}

/** Eintrag der Produktliste der Webseite (WordPress: Raumplaner-Produkte). Maße in Metern. */
export interface ShopProduct {
  id: string;
  name: string;
  url: string;
  source: Product['source'];
  image: string;
  price: number | null;
  category: Category;
  size: [number, number, number];
  color: string;
}

export type Selection =
  | { kind: 'object'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'panel'; id: string }
  | { kind: 'floor' }
  | { kind: 'ceiling' }
  | null;
