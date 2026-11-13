"""Szenenformat (Version 1).

Die Szene ist die einzige Quelle der Wahrheit. Der Browser-Editor baut daraus mit three.js
das 3D-Modell (web/src/build.ts) und ändert sie. Koordinaten in Metern, Grundriss in der
x/y-Ebene, z zeigt nach oben.

- room.polygon: Innenkontur des Raums (Ecken gegen den Uhrzeigersinn).
- walls[i] gehört zur Kante polygon[i] -> polygon[i+1].
- objects: Möbel. position = Mittelpunkt der Grundfläche (x, y) + Höhe über Boden (z).
  size = [Breite, Tiefe, Höhe], rotation = Drehung um die Hochachse in Grad.
"""
from __future__ import annotations

import json
import math
import uuid
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

CATALOG_PATH = Path(__file__).resolve().parents[2] / "shared" / "catalog.json"
CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

Category = Literal[
    "sofa", "armchair", "chair", "dining_table", "coffee_table", "side_table", "desk",
    "bed", "wardrobe", "shelf", "sideboard", "tv", "lamp", "plant", "rug", "box",
]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


class Opening(BaseModel):
    id: str = Field(default_factory=lambda: new_id("op"))
    type: Literal["door", "window"]
    offset: float  # Abstand vom Wandanfang bis zur Öffnungsmitte (m)
    width: float
    height: float
    sill: float = 0.0  # Brüstungshöhe (Tür: 0)


class Panel(BaseModel):
    id: str = Field(default_factory=lambda: new_id("pn"))
    type: Literal["slats", "wainscot", "flat"] = "slats"
    offset: float = 0.0  # Start ab Wandanfang (m)
    width: Optional[float] = None  # None = ganze Wand
    height: float = 2.4
    bottom: float = 0.0
    color: str = "#9c7650"


class Wall(BaseModel):
    id: str = Field(default_factory=lambda: new_id("wall"))
    color: str = "#efede8"
    thickness: float = 0.12
    openings: list[Opening] = []
    panels: list[Panel] = []


class Product(BaseModel):
    source: Literal["ikea", "amazon", "other"] = "other"
    name: str = ""
    url: str = ""
    sku: str = ""


class SceneObject(BaseModel):
    id: str = Field(default_factory=lambda: new_id("obj"))
    category: Category = "box"
    label: str = ""
    position: list[float] = [0.0, 0.0, 0.0]
    rotation: float = 0.0
    size: list[float] = []  # leer = Standardmaß der Kategorie
    color: str = ""  # leer = Standardfarbe der Kategorie
    product: Optional[Product] = None


class Surface(BaseModel):
    material: str = "plain"
    color: str = "#ffffff"


class Room(BaseModel):
    name: str = "Raum"
    height: float = 2.6
    polygon: list[list[float]]


class Meta(BaseModel):
    source: Literal["video", "photos", "floorplan", "manual", "demo"] = "manual"
    notes: str = ""
    dimensions_confirmed: bool = False


class Scene(BaseModel):
    version: int = 1
    room: Room
    walls: list[Wall] = []
    floor: Surface = Surface(material="wood", color="#b48a60")
    ceiling: Surface = Surface(color="#ffffff")
    objects: list[SceneObject] = []
    meta: Meta = Meta()

    def normalized(self) -> "Scene":
        """Bringt die Szene in einen konsistenten Zustand (Ecken gegen den
        Uhrzeigersinn, eine Wand pro Kante, sinnvolle Mindestwerte)."""
        poly = [list(map(float, p[:2])) for p in self.room.polygon]
        if len(poly) < 3:
            raise ValueError("Der Raum braucht mindestens drei Ecken.")
        while len(self.walls) < len(poly):
            self.walls.append(Wall())
        self.walls = self.walls[: len(poly)]
        if signed_area(poly) < 0:
            # Umlaufrichtung umdrehen: Ecke 0 bleibt, Wand j wird zur alten Wand n-1-j
            # und läuft rückwärts, also Öffnungen und Paneele spiegeln.
            n = len(poly)
            old_lengths = [edge_length(poly, i) for i in range(n)]
            poly = [poly[0]] + poly[:0:-1]
            self.walls = list(reversed(self.walls))
            for j, wall in enumerate(self.walls):
                length = old_lengths[n - 1 - j]
                for op in wall.openings:
                    op.offset = length - op.offset
                for pn in wall.panels:
                    width = pn.width if pn.width else length - pn.offset
                    pn.offset = max(0.0, length - pn.offset - width)
        self.room.polygon = poly
        self.room.height = clamp(self.room.height, 1.8, 6.0)
        for i, wall in enumerate(self.walls):
            length = edge_length(poly, i)
            for op in wall.openings:
                op.width = clamp(op.width, 0.3, max(0.3, length - 0.1))
                op.offset = clamp(op.offset, op.width / 2, max(op.width / 2, length - op.width / 2))
                op.height = clamp(op.height, 0.3, self.room.height - 0.05)
                op.sill = 0.0 if op.type == "door" else clamp(op.sill, 0.0, self.room.height - op.height)
        for obj in self.objects:
            cat = CATALOG["categories"].get(obj.category, CATALOG["categories"]["box"])
            if not obj.label:
                obj.label = cat["label"]
            if not obj.color:
                obj.color = cat["color"]
            obj.size = [max(0.01, float(v)) for v in (obj.size + cat["size"])[:3]]
            obj.position = [float(v) for v in (obj.position + [0.0, 0.0, 0.0])[:3]]
            obj.rotation = float(obj.rotation) % 360
        return self


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(v)))


def signed_area(poly: list[list[float]]) -> float:
    return 0.5 * sum(
        poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
        for i in range(len(poly))
    )


def edge_length(poly: list[list[float]], i: int) -> float:
    a, b = poly[i], poly[(i + 1) % len(poly)]
    return math.hypot(b[0] - a[0], b[1] - a[1])


def demo_scene() -> Scene:
    """Ein Wohnzimmer zum Ausprobieren, solange keine KI-Analyse läuft."""
    return Scene(
        room=Room(name="Wohnzimmer (Demo)", height=2.6, polygon=[[0, 0], [5.2, 0], [5.2, 4.0], [0, 4.0]]),
        walls=[
            Wall(),
            Wall(openings=[Opening(type="door", offset=0.8, width=0.9, height=2.05)]),
            Wall(color="#e8e1d5"),
            Wall(openings=[Opening(type="window", offset=2.0, width=1.6, height=1.4, sill=0.9)]),
        ],
        objects=[
            SceneObject(category="sofa", position=[2.6, 3.45, 0], rotation=0, size=[2.2, 0.95, 0.82], color="#7d8590"),
            SceneObject(category="coffee_table", position=[2.6, 2.3, 0], size=[1.1, 0.6, 0.42]),
            SceneObject(category="rug", position=[2.6, 2.4, 0], size=[2.4, 1.7, 0.01]),
            SceneObject(category="tv", position=[2.6, 0.12, 0.75], rotation=180, size=[1.45, 0.06, 0.84]),
            SceneObject(category="sideboard", position=[2.6, 0.25, 0], rotation=180, size=[1.8, 0.42, 0.6]),
            SceneObject(category="armchair", position=[0.8, 2.0, 0], rotation=90, color="#b5a48c"),
            SceneObject(category="lamp", position=[0.45, 3.55, 0]),
            SceneObject(category="plant", position=[4.75, 3.6, 0]),
            SceneObject(category="shelf", position=[5.0, 1.9, 0], rotation=270, size=[0.8, 0.35, 1.8]),
        ],
        meta=Meta(source="demo", notes="Demo-Szene"),
    ).normalized()
