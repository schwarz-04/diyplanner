// Szenenformat (Version 1). Koordinaten in Metern, Grundriss in der x/y-Ebene, z nach oben.

export type Category =
  | 'sofa' | 'armchair' | 'chair' | 'dining_table' | 'coffee_table' | 'side_table' | 'desk'
  | 'bed' | 'wardrobe' | 'shelf' | 'sideboard' | 'tv' | 'lamp' | 'plant' | 'rug' | 'box'
  | 'dresser' | 'nightstand' | 'pouf' | 'wall_shelf'
  | 'cushion' | 'vase' | 'table_lamp' | 'basket' | 'picture' | 'mirror' | 'curtain' | 'pendant'
  | 'board' | 'batten' | 'caster' | 'foot' | 'diy';

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
  /** Farbe aus dem Shop (Wandfarbe, Lack …), Farbton in variant */
  paint?: Product;
}

export interface Wall {
  id: string;
  color: string;
  /** Farbe aus dem Shop (Wandfarbe, Lack …), Farbton in variant */
  paint?: Product;
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
  /** Farbvarianten aus der Produktliste */
  variants?: ProductVariant[];
  /** Gewählte Variante (Name) */
  variant?: string;
}

export interface ProductVariant { name: string; color: string }

export interface SceneObject {
  id: string;
  category: Category;
  label: string;
  position: [number, number, number];
  rotation: number;
  size: [number, number, number];
  color: string;
  /** Farbe aus dem Shop (Wandfarbe, Lack …), Farbton in variant */
  paint?: Product;
  product?: Product | null;
  /** Aus der Einkaufsliste genommen (z. B. schon vorhanden) */
  skipShop?: boolean;
  /** DIY-Möbel: Einzelteile, Lage relativ zur Mitte der Grundfläche (z ab Unterkante) */
  parts?: SceneObject[];
  /** DIY-Möbel: zugehöriger Bauplan (Home.builds[].id) */
  diyId?: string;
}

export interface Surface {
  material: string;
  color: string;
  /** Farbe aus dem Shop (Wandfarbe, Lack …), Farbton in variant */
  paint?: Product;
}

export interface Scene {
  version: number;
  room: { name: string; height: number; polygon: [number, number][] };
  walls: Wall[];
  floor: Surface;
  ceiling: Surface;
  objects: SceneObject[];
  meta: { source: string; notes: string; dimensions_confirmed: boolean };
  /** Werkbank des DIY-Bereichs: keine Wände, keine Decke */
  diy?: boolean;
  /** Werkbank: Verbindungen, die nicht verschraubt werden sollen ("idA|idB") */
  diyOff?: string[];
  /** Werkbank: zusätzlich gewählte Verbindungen und Beschläge (Winkel, Scharniere, Griffe …) */
  diyHardware?: { product: Product; count: number; sub?: string }[];
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
  /** Selbst gebaute Möbel (DIY-Bereich) */
  builds?: DiyBuild[];
  /** Farben, die aus der Einkaufsliste genommen wurden (Produktlink|Farbton) */
  skipPaints?: string[];
}

/** Bauplan eines DIY-Möbels: die Teile liegen als Objekte in einer Werkbank-Szene. */
export interface DiyBuild {
  id: string;
  name: string;
  scene: Scene;
}

export interface Project {
  id: string;
  state: 'queued' | 'analyzing' | 'ready' | 'error' | 'unknown';
  step: string;
  error: string | null;
  version: number;
  kind?: string;
  /** Vom Nutzer vergebener Projektname */
  name?: string;
  /** Version 1: ein Raum (Scene), Version 2: Wohnung (Home). */
  scene: Scene | Home | null;
  /** Rohantwort der KI, solange daraus noch keine Szene gebaut wurde. */
  analysis?: import('./analysis').RoomAnalysis | null;
}

export interface Catalog {
  categories: Record<Category, {
    label: string; size: [number, number, number]; color: string;
    /** deko = Dekoration, sonst Möbel */
    group?: 'deko' | 'bauteil';
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
  variants?: ProductVariant[];
  /** Bereich im Möbel-Menü (Spalte Kategorie der Produkttabelle) */
  group?: 'regale' | 'moebel' | 'deko' | 'werkzeug' | 'verbindung' | 'farbe';
  /** Farben: Unterkategorie, Hersteller, Farbton, Farbcode */
  paint?: PaintInfo;
  /** Verbindungen (Schrauben, Winkel, Scharniere …): Angaben aus der Produkttabelle */
  conn?: ConnInfo;
}

export interface PaintInfo { sub: string; maker: string; shade: string; hex: string; /** Produktname ohne Farbton */ product?: string }

export interface ConnInfo {
  sub: string;
  kind: string;
  length: string;
  diameter: string;
  material: string;
  finish: string;
  pack: string;
}

export type Selection =
  | { kind: 'object'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'panel'; id: string }
  | { kind: 'floor' }
  | { kind: 'ceiling' }
  | null;

export interface ProjectSummary {
  id: string;
  name: string;
  rooms: number;
  room_names: string[];
  /** Unix-Zeit */
  updated: number;
  /** JPEG als data:-URL oder leer */
  thumb: string;
}
