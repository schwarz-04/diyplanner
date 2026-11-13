"""KI-Analyse: Video, Fotos oder Grundriss -> Szenenbeschreibung.

Ablauf:
1. Eingaben vorbereiten: aus einem Video werden gleichmäßig verteilte Einzelbilder gezogen
   (ffmpeg), Fotos und Grundrisse werden verkleinert, PDFs gehen direkt an das Modell.
2. Claude bekommt die Bilder und liefert eine strukturierte Raumbeschreibung
   (Structured Outputs, validiert gegen ``RoomAnalysis``).
3. Die Antwort wird in das Szenenformat übersetzt und normalisiert.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, Optional

import anthropic
from PIL import Image
from pydantic import BaseModel, Field

from .scene import CATALOG, Meta, Opening, Room, Scene, SceneObject, Surface, Wall

log = logging.getLogger(__name__)

MODEL = os.environ.get("DM_MODEL", "claude-opus-5-5")
MAX_IMAGES = int(os.environ.get("DM_MAX_IMAGES", "16"))
IMAGE_MAX_SIDE = 1568

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


# --------------------------------------------------------------------------- Antwortformat


class AOpening(BaseModel):
    type: Literal["door", "window"]
    offset_m: float = Field(description="Abstand vom Wandanfang bis zur Mitte der Öffnung")
    width_m: float
    height_m: float
    sill_m: float = Field(description="Brüstungshöhe, bei Türen 0")


class AWall(BaseModel):
    color_hex: str = Field(description="Wandfarbe als #rrggbb")
    openings: list[AOpening]


class AObject(BaseModel):
    category: Literal[
        "sofa", "armchair", "chair", "dining_table", "coffee_table", "side_table", "desk",
        "bed", "wardrobe", "shelf", "sideboard", "tv", "lamp", "plant", "rug", "box",
    ]
    label_de: str = Field(description="Kurze deutsche Bezeichnung, z. B. 'Ecksofa grau'")
    x_m: float = Field(description="Mittelpunkt der Grundfläche, x im Grundriss")
    y_m: float = Field(description="Mittelpunkt der Grundfläche, y im Grundriss")
    elevation_m: float = Field(description="Abstand der Unterkante zum Boden, meist 0")
    rotation_deg: float = Field(description="Drehung um die Hochachse; 0 = Vorderseite zeigt nach -y")
    width_m: float
    depth_m: float
    height_m: float
    color_hex: str


class RoomAnalysis(BaseModel):
    room_name: str
    ceiling_height_m: float
    corners: list[list[float]] = Field(
        description="Innenecken des Raums im Grundriss [[x, y], ...] in Metern, gegen den Uhrzeigersinn, "
                    "erste Ecke bei [0, 0]")
    walls: list[AWall] = Field(description="Eine Wand pro Kante corners[i] -> corners[i+1]")
    floor_material: Literal["wood", "tile", "carpet", "concrete"]
    floor_color_hex: str
    ceiling_color_hex: str
    objects: list[AObject]
    scale_reference: str = Field(description="Woran die Maße geschätzt wurden (z. B. Türhöhe 2,01 m)")
    confidence: Literal["low", "medium", "high"]
    notes_de: str = Field(description="Unsicherheiten und Annahmen, kurz auf Deutsch")


SYSTEM_PROMPT = """Du rekonstruierst Innenräume für eine Interior-Design-App. Aus Bildern eines Raums \
(Einzelbilder aus einem Rundum-Video, Fotos oder einen Grundriss) erstellst du eine maßstäbliche, \
vereinfachte 3D-Beschreibung: Raumkontur, Wände mit Türen und Fenstern, Boden, Decke und alle \
Möbel als Objekte aus der vorgegebenen Kategorienliste.

Koordinaten: Meter, Grundriss in der x/y-Ebene, Raumecken gegen den Uhrzeigersinn, erste Ecke bei \
[0, 0]. Wand i verläuft von Ecke i zu Ecke i+1 (die letzte zurück zur ersten). Der Raum liegt links \
der Laufrichtung jeder Wand. Möbel: Position ist die Mitte der Grundfläche; rotation_deg = 0 heißt, \
die Vorderseite (Sitzfläche, Türen, Bildschirm) zeigt in Richtung -y; 90 heißt Richtung +x, \
180 Richtung +y, 270 Richtung -x. Möbel an einer Wand stehen mit der Rückseite zur Wand.

Maße schätzen: Nutze bekannte Größen als Referenz (Innentüren meist 2,01 m hoch und 0,86 m breit, \
Steckdosen 0,30 m über Boden, Arbeitsplatten 0,90 m, Sitzhöhe 0,45 m, Deckenhöhe in Wohnungen \
meist 2,50 bis 2,70 m). Bei einem Grundriss: Maßketten und Beschriftungen lesen, Flächenangaben \
(m²) zur Kontrolle nutzen. Bei mehreren Räumen im Grundriss den größten Wohnraum nehmen, \
außer der Hinweis des Nutzers sagt etwas anderes.

Möbel: Erfasse jedes sichtbare größere Möbelstück einzeln, mit realistischen Maßen und der \
erkennbaren Hauptfarbe. Kleinkram (Bücher, Deko) weglassen. Was in keine Kategorie passt, als \
"box" mit passender Größe. Möbel dürfen sich nicht mit Wänden oder untereinander überschneiden \
(Ausnahme: Teppich unter Tisch/Sofa). Bei einem Grundriss ohne eingezeichnete Möbel: objects leer.

Farben als #rrggbb, so wie sie im Raum wirken (weiße Wände eher #efede8 als #ffffff)."""


# --------------------------------------------------------------------------- Eingaben


def _encode_image(img: Image.Image) -> dict:
    img = img.convert("RGB")
    img.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(buf.getvalue()).decode()}}


def video_frames(path: Path, count: int) -> list[Image.Image]:
    """Zieht ``count`` gleichmäßig verteilte Einzelbilder aus einem Video."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True)
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    frames = []
    with tempfile.TemporaryDirectory() as tmp:
        for k in range(count):
            t = duration * (k + 0.5) / count
            out = Path(tmp) / f"f{k:03d}.jpg"
            subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1",
                            "-vf", f"scale='min({IMAGE_MAX_SIDE},iw)':-2", "-q:v", "3", str(out)],
                           check=True)
            if out.exists():
                frames.append(Image.open(out).copy())
    return frames


def load_image(path: Path) -> Image.Image:
    if path.suffix.lower() in {".heic", ".heif"}:
        try:
            from pillow_heif import register_heif_opener
            register_heif_opener()
        except ImportError as exc:  # pragma: no cover
            raise ValueError("HEIC-Bilder werden noch nicht unterstützt, bitte als JPG hochladen.") from exc
    return Image.open(path)


def build_content(files: list[Path], kind: str, hint: str) -> list[dict]:
    content: list[dict] = []
    videos = [f for f in files if f.suffix.lower() in VIDEO_EXT]
    images = [f for f in files if f.suffix.lower() in IMAGE_EXT]
    pdfs = [f for f in files if f.suffix.lower() == ".pdf"]

    per_video = max(4, MAX_IMAGES // max(1, len(videos))) if videos else 0
    for v in videos:
        for img in video_frames(v, per_video):
            content.append(_encode_image(img))
    for f in images[: max(0, MAX_IMAGES - len(content))]:
        content.append(_encode_image(load_image(f)))
    for f in pdfs[:2]:
        content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                       "data": base64.standard_b64encode(f.read_bytes()).decode()}})
    if not content:
        raise ValueError("Keine verwertbaren Dateien gefunden (Video, Foto oder Grundriss).")

    intro = {
        "video": f"Die {len(content)} Bilder sind Einzelbilder aus einem Rundum-Video eines Raums, in zeitlicher Reihenfolge.",
        "photos": f"Die {len(content)} Bilder sind Fotos desselben Raums aus verschiedenen Blickwinkeln.",
        "floorplan": "Das ist ein Grundriss. Rekonstruiere den Raum daraus.",
    }.get(kind, "Rekonstruiere den Raum aus diesen Bildern.")
    text = intro + " Erstelle die Raumbeschreibung."
    if hint:
        text += f"\n\nHinweis des Nutzers: {hint}"
    content.append({"type": "text", "text": text})
    return content


# --------------------------------------------------------------------------- Analyse


def _api_key() -> str | None:
    # DM_ANTHROPIC_API_KEY lets the key be stored under a project-specific name,
    # e.g. in hosted environments that reserve ANTHROPIC_API_KEY for themselves.
    return os.environ.get("DM_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")


def analyze(files: list[Path], kind: str, hint: str = "") -> Scene:
    key = _api_key()
    client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    content = build_content(files, kind, hint)
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": content}],
        output_format=RoomAnalysis,
        # Falls ein Sicherheitsfilter ablehnt, versucht die API automatisch ein Ersatzmodell.
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Die KI hat die Analyse abgelehnt. Bitte andere Bilder versuchen.")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise RuntimeError("Die KI-Antwort war unvollständig. Bitte erneut versuchen.")
    log.info("Analyse: %s Eingabe- / %s Ausgabe-Tokens", response.usage.input_tokens, response.usage.output_tokens)
    return to_scene(response.parsed_output, kind)


def to_scene(a: RoomAnalysis, kind: str) -> Scene:
    walls = [Wall(color=w.color_hex, openings=[
        Opening(type=o.type, offset=o.offset_m, width=o.width_m, height=o.height_m, sill=o.sill_m)
        for o in w.openings]) for w in a.walls]
    objects = [SceneObject(category=o.category, label=o.label_de,
                           position=[o.x_m, o.y_m, o.elevation_m], rotation=o.rotation_deg,
                           size=[o.width_m, o.depth_m, o.height_m], color=o.color_hex)
               for o in a.objects]
    notes = f"{a.notes_de}\nMaßstab: {a.scale_reference}\nSicherheit: {a.confidence}"
    scene = Scene(
        room=Room(name=a.room_name, height=a.ceiling_height_m, polygon=a.corners),
        walls=walls,
        floor=Surface(material=a.floor_material, color=a.floor_color_hex),
        ceiling=Surface(color=a.ceiling_color_hex),
        objects=objects,
        meta=Meta(source=kind if kind in ("video", "photos", "floorplan") else "manual", notes=notes),
    )
    return scene.normalized()


def available() -> bool:
    return bool(_api_key() or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


