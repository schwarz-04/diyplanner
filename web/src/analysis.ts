/**
 * Alles rund um die KI-Analyse, was im Browser passiert:
 * 1. Eingaben vorbereiten: Einzelbilder aus dem Video schneiden, Fotos verkleinern, PDF einlesen.
 *    So muss der Server weder ffmpeg noch große Videos verarbeiten.
 * 2. Die Antwort der KI (Format: shared/room-analysis.schema.json) in eine Szene umwandeln.
 */
import { uid } from './edits';
import type { Catalog, Category, Scene } from './types';

export const IMAGE_MAX_SIDE = 1280;
export const MAX_IMAGES = 16;

export interface AnalysisInput {
  images: { media_type: 'image/jpeg'; data: string }[];
  pdf: string | null;
}

// ------------------------------------------------------------------ Eingaben

function toJpeg(source: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
}

/** Zieht `count` gleichmäßig verteilte Einzelbilder aus einem Video. */
export async function videoFrames(file: File, count: number, onProgress?: (k: number) => void): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Das Video lässt sich in diesem Browser nicht öffnen. Bitte als MP4 oder MOV hochladen.'));
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Die Videolänge konnte nicht gelesen werden.');
    const frames: string[] = [];
    for (let k = 0; k < count; k++) {
      video.currentTime = (duration * (k + 0.5)) / count;
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
      frames.push(toJpeg(video, video.videoWidth, video.videoHeight));
      onProgress?.(k + 1);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function photo(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} lässt sich nicht lesen. Bitte als JPG oder PNG hochladen.`);
  });
  const data = toJpeg(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return data;
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function prepareInput(files: File[], onStep: (text: string) => void): Promise<AnalysisInput> {
  const videos = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => !videos.includes(f) && !pdfs.includes(f));
  const out: AnalysisInput = { images: [], pdf: null };

  const perVideo = videos.length ? Math.max(4, Math.floor(MAX_IMAGES / videos.length)) : 0;
  for (const v of videos) {
    const frames = await videoFrames(v, perVideo, (k) => onStep(`Einzelbilder aus dem Video: ${k} von ${perVideo}`));
    out.images.push(...frames.map((data) => ({ media_type: 'image/jpeg' as const, data })));
  }
  for (const f of images.slice(0, Math.max(0, MAX_IMAGES - out.images.length))) {
    onStep(`Foto wird vorbereitet: ${f.name}`);
    out.images.push({ media_type: 'image/jpeg', data: await photo(f) });
  }
  if (pdfs[0]) {
    if (pdfs[0].size > 20 * 1024 * 1024) throw new Error('Das PDF ist größer als 20 MB.');
    out.pdf = await base64(pdfs[0]);
  }
  if (!out.images.length && !out.pdf) throw new Error('Keine verwertbaren Dateien gefunden (Video, Foto oder Grundriss).');
  return out;
}

// ------------------------------------------------------------------ Antwort -> Szene

export interface RoomAnalysis {
  room_name: string;
  ceiling_height_m: number;
  corners: number[][];
  walls: { color_hex: string; openings: { type: 'door' | 'window'; offset_m: number; width_m: number; height_m: number; sill_m: number }[] }[];
  floor_material: string;
  floor_color_hex: string;
  ceiling_color_hex: string;
  objects: {
    category: Category; label_de: string; x_m: number; y_m: number; elevation_m: number;
    rotation_deg: number; width_m: number; depth_m: number; height_m: number; color_hex: string;
  }[];
  scale_reference: string;
  confidence: string;
  notes_de: string;
}

export function analysisToScene(a: RoomAnalysis, kind: string, catalog: Catalog): Scene {
  const scene: Scene = {
    version: 1,
    room: { name: a.room_name, height: a.ceiling_height_m, polygon: a.corners.map((p) => [p[0], p[1]]) },
    walls: a.walls.map((w) => ({
      id: uid('wall'),
      color: w.color_hex,
      thickness: 0.12,
      openings: w.openings.map((o) => ({
        id: uid('op'), type: o.type, offset: o.offset_m, width: o.width_m, height: o.height_m, sill: o.sill_m,
      })),
      panels: [],
    })),
    floor: { material: a.floor_material, color: a.floor_color_hex },
    ceiling: { material: 'plain', color: a.ceiling_color_hex },
    objects: a.objects.map((o) => ({
      id: uid('obj'),
      category: o.category,
      label: o.label_de,
      position: [o.x_m, o.y_m, o.elevation_m],
      rotation: o.rotation_deg,
      size: [o.width_m, o.depth_m, o.height_m],
      color: o.color_hex,
      product: null,
    })),
    meta: {
      source: ['video', 'photos', 'floorplan'].includes(kind) ? kind : 'manual',
      notes: `${a.notes_de}\nMaßstab: ${a.scale_reference}\nSicherheit: ${a.confidence}`,
      dimensions_confirmed: false,
    },
  };
  return normalizeScene(scene, catalog);
}

// ------------------------------------------------------------------ Normalisieren

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));

function signedArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const edgeLength = (p: [number, number][], i: number) => {
  const a = p[i];
  const b = p[(i + 1) % p.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

/**
 * Bringt die Szene in einen konsistenten Zustand: Ecken gegen den Uhrzeigersinn, eine Wand pro
 * Kante, Öffnungen innerhalb der Wand, Möbel mit Maßen und Farbe.
 */
export function normalizeScene(s: Scene, catalog: Catalog): Scene {
  let poly = s.room.polygon.map((p) => [Number(p[0]), Number(p[1])] as [number, number]);
  if (poly.length < 3) throw new Error('Der Raum braucht mindestens drei Ecken.');
  while (s.walls.length < poly.length) {
    s.walls.push({ id: uid('wall'), color: '#efede8', thickness: 0.12, openings: [], panels: [] });
  }
  s.walls = s.walls.slice(0, poly.length);
  if (signedArea(poly) < 0) {
    // Umlaufrichtung umdrehen: Ecke 0 bleibt, Wand j wird zur alten Wand n-1-j und läuft
    // rückwärts, also Öffnungen und Paneele spiegeln.
    const n = poly.length;
    const oldLengths = poly.map((_, i) => edgeLength(poly, i));
    poly = [poly[0], ...poly.slice(1).reverse()];
    s.walls.reverse();
    s.walls.forEach((wall, j) => {
      const length = oldLengths[n - 1 - j];
      for (const op of wall.openings) op.offset = length - op.offset;
      for (const pn of wall.panels) {
        const width = pn.width || length - pn.offset;
        pn.offset = Math.max(0, length - pn.offset - width);
      }
    });
  }
  s.room.polygon = poly;
  s.room.height = clamp(s.room.height, 1.8, 6);
  s.walls.forEach((wall, i) => {
    const length = edgeLength(poly, i);
    for (const op of wall.openings) {
      op.width = clamp(op.width, 0.3, Math.max(0.3, length - 0.1));
      op.offset = clamp(op.offset, op.width / 2, Math.max(op.width / 2, length - op.width / 2));
      op.height = clamp(op.height, 0.3, s.room.height - 0.05);
      op.sill = op.type === 'door' ? 0 : clamp(op.sill, 0, s.room.height - op.height);
    }
  });
  for (const o of s.objects) {
    const cat = catalog.categories[o.category] ?? catalog.categories.box;
    if (!catalog.categories[o.category]) o.category = 'box';
    o.label ||= cat.label;
    o.color ||= cat.color;
    const size = [...(o.size ?? []), ...cat.size].slice(0, 3).map((v) => Math.max(0.01, Number(v)));
    o.size = size as [number, number, number];
    o.position = [...(o.position ?? []), 0, 0, 0].slice(0, 3).map(Number) as [number, number, number];
    o.rotation = ((Number(o.rotation) % 360) + 360) % 360;
  }
  return s;
}
