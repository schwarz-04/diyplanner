"""Baut aus einer Szenenbeschreibung (JSON, siehe backend/app/scene.py) eine Blender-Szene
und exportiert sie als glTF (.glb) für den Browser-Editor. Optional wird ein Bild gerendert.

Läuft headless, entweder als Python-Modul (``pip install bpy``) oder mit Blender selbst:

    python build_scene.py scene.json out.glb [--render out.png] [--blend out.blend]
    blender -b -P build_scene.py -- scene.json out.glb

Jedes erzeugte Objekt bekommt benutzerdefinierte Eigenschaften (dm_id, dm_type, ...),
die im glTF als "extras" landen. Der Editor erkennt daran Wände, Böden und Möbel.
Die Hauptfarbe jedes Elements liegt in einem eigenen Material "<id>_main", damit der
Editor sie einzeln umfärben kann.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy  # muss vor bmesh/mathutils importiert werden
import bmesh
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------- Materialien

_material_cache: dict[tuple, bpy.types.Material] = {}


def hex_to_rgba(value: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    value = (value or "#999999").lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))

    def lin(c: float) -> float:  # sRGB -> linear, so wie Blender Farben intern führt
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (lin(r), lin(g), lin(b), alpha)


def material(name: str, color: str, roughness: float = 0.7, metallic: float = 0.0,
             alpha: float = 1.0, shared: bool = True) -> bpy.types.Material:
    key = (name, color, roughness, metallic, alpha)
    if shared and key in _material_cache:
        return _material_cache[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_to_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
    mat.diffuse_color = hex_to_rgba(color, alpha)
    if shared:
        _material_cache[key] = mat
    return mat


# --------------------------------------------------------------------------- Geometrie


def add_box(bm: bmesh.types.BMesh, x0, x1, y0, y1, z0, z1, mat_index: int = 0) -> None:
    """Quader mit achsenparallelen Grenzen in ein BMesh einfügen."""
    if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
        return
    res = bmesh.ops.create_cube(bm, size=1.0)
    m = Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)) @ Matrix.Diagonal(
        (x1 - x0, y1 - y0, z1 - z0, 1.0))
    bmesh.ops.transform(bm, matrix=m, verts=res["verts"])
    for f in {f for v in res["verts"] for f in v.link_faces}:
        f.material_index = mat_index


def add_cylinder(bm, cx, cy, z0, z1, r_bottom, r_top=None, segments=24, mat_index=0) -> None:
    r_top = r_bottom if r_top is None else r_top
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r_bottom,
                                radius2=r_top, depth=z1 - z0)
    bmesh.ops.translate(bm, vec=(cx, cy, (z0 + z1) / 2), verts=res["verts"])
    for f in {f for v in res["verts"] for f in v.link_faces}:
        f.material_index = mat_index
        f.smooth = True


def add_sphere(bm, cx, cy, cz, rx, ry, rz, mat_index=0) -> None:
    res = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    m = Matrix.Translation((cx, cy, cz)) @ Matrix.Diagonal((rx, ry, rz, 1.0))
    bmesh.ops.transform(bm, matrix=m, verts=res["verts"])
    for f in {f for v in res["verts"] for f in v.link_faces}:
        f.material_index = mat_index


def mesh_object(name: str, bm: bmesh.types.BMesh, materials: list, props: dict,
                matrix: Matrix | None = None) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    for mat in materials:
        mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if matrix is not None:
        obj.matrix_world = matrix
    for k, v in props.items():
        obj[k] = v
    return obj


# --------------------------------------------------------------------------- Raum


def build_floor_and_ceiling(scene: dict) -> None:
    poly = scene["room"]["polygon"]
    height = scene["room"]["height"]
    for kind, z, flip in (("floor", 0.0, False), ("ceiling", height, True)):
        bm = bmesh.new()
        verts = [bm.verts.new((p[0], p[1], z)) for p in poly]
        face = bm.faces.new(verts)
        if flip:
            face.normal_flip()
        surf = scene.get(kind, {})
        default = "#b48a60" if kind == "floor" else "#ffffff"
        mat = material(f"{kind}_main", surf.get("color", default),
                       roughness=0.55 if kind == "floor" else 0.9, shared=False)
        mesh_object(kind.capitalize(), bm, [mat], {"dm_id": kind, "dm_type": kind,
                                                     "dm_material": surf.get("material", "plain")})


def interval_subtract(start: float, end: float, cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    parts = [(start, end)]
    for c0, c1 in cuts:
        nxt = []
        for p0, p1 in parts:
            if c1 <= p0 or c0 >= p1:
                nxt.append((p0, p1))
                continue
            if c0 > p0:
                nxt.append((p0, c0))
            if c1 < p1:
                nxt.append((c1, p1))
        parts = nxt
    return [p for p in parts if p[1] - p[0] > 0.01]


def build_walls(scene: dict) -> None:
    poly = scene["room"]["polygon"]
    height = scene["room"]["height"]
    n = len(poly)
    glass = material("glass", "#cfe6f2", roughness=0.05, alpha=0.25)
    frame = material("window_frame", "#f4f4f2", roughness=0.4)

    for i, wall in enumerate(scene["walls"]):
        a, b = Vector((*poly[i], 0)), Vector((*poly[(i + 1) % n], 0))
        length = (b - a).length
        if length < 0.05:
            continue
        angle = math.atan2(b.y - a.y, b.x - a.x)
        to_world = Matrix.Translation(a) @ Matrix.Rotation(angle, 4, "Z")
        t = wall.get("thickness", 0.12)

        # Lokales Wandsystem: x entlang der Wand, y > 0 zeigt in den Raum, z nach oben.
        # Die Wand liegt außerhalb der Raumkontur (y in [-t, 0]) und wird an beiden
        # Enden um t verlängert, damit die Ecken geschlossen sind.
        openings = sorted(wall.get("openings", []), key=lambda o: o["offset"])
        bm = bmesh.new()
        cursor = -t
        for op in openings:
            o0, o1 = op["offset"] - op["width"] / 2, op["offset"] + op["width"] / 2
            sill, top = op.get("sill", 0.0), op.get("sill", 0.0) + op["height"]
            add_box(bm, cursor, o0, -t, 0, 0, height)
            add_box(bm, o0, o1, -t, 0, 0, sill)
            add_box(bm, o0, o1, -t, 0, top, height)
            cursor = max(cursor, o1)
        add_box(bm, cursor, length + t, -t, 0, 0, height)
        nx, ny = math.sin(angle), -math.cos(angle)  # Außennormale im Grundriss
        mesh_object(f"Wall_{i}", bm, [material(f"{wall['id']}_main", wall.get("color", "#efede8"),
                                                roughness=0.9, shared=False)],
                    {"dm_id": wall["id"], "dm_type": "wall", "dm_index": i,
                     "dm_nx": nx, "dm_ny": ny, "dm_length": length}, to_world)

        # Fenster: Rahmen + Glas, Türen: schlichte Zarge
        for op in openings:
            o0, o1 = op["offset"] - op["width"] / 2, op["offset"] + op["width"] / 2
            sill, top = op.get("sill", 0.0), op.get("sill", 0.0) + op["height"]
            bm = bmesh.new()
            f = 0.05
            add_box(bm, o0, o0 + f, -t, 0, sill, top)
            add_box(bm, o1 - f, o1, -t, 0, sill, top)
            add_box(bm, o0, o1, -t, 0, top - f, top)
            if op["type"] == "window":
                add_box(bm, o0, o1, -t, 0, sill, sill + f)
                add_box(bm, (o0 + o1) / 2 - f / 2, (o0 + o1) / 2 + f / 2, -t * 0.6, -t * 0.4, sill, top)
                add_box(bm, o0 + f, o1 - f, -t * 0.52, -t * 0.48, sill + f, top - f, mat_index=1)
            mesh_object(f"{op['type'].capitalize()}_{op['id']}", bm, [frame, glass],
                        {"dm_id": op["id"], "dm_type": op["type"], "dm_wall": wall["id"]}, to_world)

        for panel in wall.get("panels", []):
            build_panel(panel, wall, length, height, to_world)


def build_panel(panel: dict, wall: dict, length: float, room_height: float, to_world: Matrix) -> None:
    start = max(0.0, panel.get("offset", 0.0))
    width = panel.get("width") or (length - start)
    end = min(length, start + width)
    bottom = panel.get("bottom", 0.0)
    top = min(room_height, bottom + panel.get("height", 2.4))
    # Öffnungen aussparen, sofern sie das Paneel in der Höhe berühren
    cuts = []
    for op in wall.get("openings", []):
        o_bottom, o_top = op.get("sill", 0.0), op.get("sill", 0.0) + op["height"]
        if o_top > bottom and o_bottom < top:
            cuts.append((op["offset"] - op["width"] / 2 - 0.02, op["offset"] + op["width"] / 2 + 0.02))
    bm = bmesh.new()
    kind = panel.get("type", "slats")
    for s0, s1 in interval_subtract(start, end, cuts):
        if kind == "slats":
            add_box(bm, s0, s1, 0, 0.012, bottom, top, mat_index=1)  # dunkler Filz dahinter
            slat, gap = 0.03, 0.015
            x = s0 + gap / 2
            while x + slat <= s1:
                add_box(bm, x, x + slat, 0.012, 0.032, bottom, top)
                x += slat + gap
        elif kind == "wainscot":
            add_box(bm, s0, s1, 0, 0.015, bottom, top)
            add_box(bm, s0, s1, 0, 0.035, top - 0.04, top)  # Abschlussleiste
            n = max(1, round((s1 - s0) / 0.6))
            field = (s1 - s0) / n
            for k in range(n):
                fx0, fx1 = s0 + k * field + 0.07, s0 + (k + 1) * field - 0.07
                add_box(bm, fx0, fx1, 0.015, 0.025, bottom + 0.1, top - 0.14)
        else:
            add_box(bm, s0, s1, 0, 0.018, bottom, top)
    main = material(f"{panel['id']}_main", panel.get("color", "#9c7650"), roughness=0.6, shared=False)
    felt = material("panel_felt", "#2b2b2b", roughness=1.0)
    mesh_object(f"Panel_{panel['id']}", bm, [main, felt],
                {"dm_id": panel["id"], "dm_type": "panel", "dm_wall": wall["id"]}, to_world)


# --------------------------------------------------------------------------- Möbel
# Jede Funktion baut ein Möbelstück im lokalen System: Grundfläche zentriert um (0, 0),
# Unterkante bei z = 0, Vorderseite zeigt nach -y. Materialindex 0 = Hauptfarbe,
# 1 = dunkles Holz/Metall (Beine, Griffe), 2 = helles Textil, 3 = Grün, 4 = Keramik.

ACCENT, LIGHT, GREEN, CERAMIC = 1, 2, 3, 4


def legs(bm, w, d, z1, inset=0.05, size=0.04, mat=ACCENT):
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * (w / 2 - inset), sy * (d / 2 - inset)
            add_box(bm, cx - size / 2, cx + size / 2, cy - size / 2, cy + size / 2, 0, z1, mat)


def f_sofa(bm, w, d, h):
    arm = min(0.2, w * 0.12)
    leg = 0.1
    seat = max(0.38, h * 0.5)
    legs(bm, w, d, leg, inset=0.08)
    # Teile überlappen nicht flächengleich, sonst flackert es beim Rendern
    add_box(bm, -w / 2 + arm, w / 2 - arm, -d / 2, d / 2 - 0.22, leg, seat - 0.12)  # Sockel
    add_box(bm, -w / 2 + arm + 0.01, w / 2 - arm - 0.01, -d / 2 + 0.02, d / 2 - 0.23, seat - 0.12, seat)  # Sitzkissen
    add_box(bm, -w / 2, w / 2, d / 2 - 0.22, d / 2, leg, h)  # Rücken
    for s in (-1, 1):
        x0, x1 = sorted((s * w / 2, s * (w / 2 - arm)))
        add_box(bm, x0, x1, -d / 2, d / 2 - 0.22, leg, seat + 0.14)


def f_chair(bm, w, d, h):
    seat = min(0.47, h * 0.55)
    legs(bm, w, d, seat - 0.04, inset=0.03, size=0.035)
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, seat - 0.04, seat)
    add_box(bm, -w / 2, w / 2, d / 2 - 0.04, d / 2, seat, h)


def f_table(bm, w, d, h):
    top = 0.04
    legs(bm, w, d, h - top, inset=0.06, size=0.05, mat=0)
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, h - top, h)


def f_coffee_table(bm, w, d, h):
    legs(bm, w, d, h - 0.04, inset=0.05, size=0.035)
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, h - 0.04, h)
    add_box(bm, -w / 2 + 0.05, w / 2 - 0.05, -d / 2 + 0.05, d / 2 - 0.05, 0.08, 0.1)


def f_bed(bm, w, d, h):
    frame = 0.32
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, 0.05, frame)
    legs(bm, w, d, 0.05, inset=0.06, size=0.06)
    add_box(bm, -w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.03, d / 2 - 0.1, frame, frame + 0.22, LIGHT)
    add_box(bm, -w / 2, w / 2, d / 2 - 0.08, d / 2, 0.05, h)  # Kopfteil
    pw = (w - 0.2) / 2
    for s in (-1, 1):
        cx = s * (pw / 2 + 0.03)
        add_box(bm, cx - pw / 2, cx + pw / 2, d / 2 - 0.5, d / 2 - 0.12, frame + 0.22, frame + 0.34, LIGHT)


def f_cabinet(bm, w, d, h, doors=2, plinth=0.0, leg_height=0.0):
    z0 = max(plinth, leg_height)
    if leg_height:
        legs(bm, w, d, leg_height, inset=0.06, size=0.03)
    elif plinth:
        add_box(bm, -w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.05, d / 2, 0, plinth, ACCENT)
    add_box(bm, -w / 2, w / 2, -d / 2 + 0.02, d / 2, z0, h)
    gap = 0.004
    dw = w / doors
    for k in range(doors):
        x0, x1 = -w / 2 + k * dw + gap, -w / 2 + (k + 1) * dw - gap
        add_box(bm, x0, x1, -d / 2, -d / 2 + 0.02, z0 + gap, h - gap)
        hx = x1 - 0.06 if k % 2 == 0 else x0 + 0.06
        hz = z0 + (h - z0) * (0.5 if h > 1.2 else 0.75)
        add_box(bm, hx - 0.008, hx + 0.008, -d / 2 - 0.025, -d / 2, hz - 0.1, hz + 0.1, ACCENT)


def f_shelf(bm, w, d, h):
    t = 0.02
    add_box(bm, -w / 2, -w / 2 + t, -d / 2, d / 2, 0, h)
    add_box(bm, w / 2 - t, w / 2, -d / 2, d / 2, 0, h)
    add_box(bm, -w / 2, w / 2, d / 2 - 0.01, d / 2, 0, h)
    n = max(2, round(h / 0.36))
    for k in range(n + 1):
        z = min(h - t, k * (h - t) / n)
        add_box(bm, -w / 2 + t, w / 2 - t, -d / 2, d / 2, z, z + t)


def f_tv(bm, w, d, h):
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, 0, h)
    add_box(bm, -w / 2 + 0.01, w / 2 - 0.01, -d / 2 - 0.002, -d / 2, 0.01, h - 0.01, ACCENT)


def f_lamp(bm, w, d, h):
    r = min(w, d) / 2
    add_cylinder(bm, 0, 0, 0, 0.03, r * 0.6, mat_index=ACCENT)
    add_cylinder(bm, 0, 0, 0.03, h - 0.3, 0.012, mat_index=ACCENT)
    add_cylinder(bm, 0, 0, h - 0.32, h, r, r * 0.7)


def f_plant(bm, w, d, h):
    r = min(w, d) / 2
    pot = min(0.4, h * 0.3)
    add_cylinder(bm, 0, 0, 0, pot, r * 0.55, r * 0.7, mat_index=CERAMIC)
    add_sphere(bm, 0, 0, pot + (h - pot) * 0.5, r, r, (h - pot) / 2, mat_index=0)


def f_rug(bm, w, d, h):
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, 0, max(h, 0.01))


def f_box(bm, w, d, h):
    add_box(bm, -w / 2, w / 2, -d / 2, d / 2, 0, h)


FURNITURE = {
    "sofa": f_sofa,
    "armchair": f_sofa,
    "chair": f_chair,
    "dining_table": f_table,
    "desk": f_table,
    "side_table": f_table,
    "coffee_table": f_coffee_table,
    "bed": f_bed,
    "wardrobe": lambda bm, w, d, h: f_cabinet(bm, w, d, h, doors=max(2, round(w / 0.5)), plinth=0.06),
    "sideboard": lambda bm, w, d, h: f_cabinet(bm, w, d, h, doors=max(2, round(w / 0.45)), leg_height=0.12),
    "shelf": f_shelf,
    "tv": f_tv,
    "lamp": f_lamp,
    "plant": f_plant,
    "rug": f_rug,
    "box": f_box,
}


def build_objects(scene: dict) -> None:
    accent = material("accent", "#2f2a26", roughness=0.5)
    light = material("textile_light", "#f3f1ec", roughness=0.95)
    green = material("leaf", "#4f7a46", roughness=0.8)
    ceramic = material("ceramic", "#e9e6e0", roughness=0.35)
    for obj in scene.get("objects", []):
        w, d, h = obj["size"]
        bm = bmesh.new()
        FURNITURE.get(obj["category"], f_box)(bm, w, d, h)
        main = material(f"{obj['id']}_main", obj.get("color", "#9a9a9a"), roughness=0.75, shared=False)
        # Pflanzen: Hauptfarbe ist das Laub
        mats = [main, accent, light, green, ceramic]
        x, y, z = obj["position"]
        m = Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.radians(obj.get("rotation", 0)), 4, "Z")
        props = {"dm_id": obj["id"], "dm_type": "object", "dm_category": obj["category"],
                 "dm_label": obj.get("label", "")}
        mesh_object(f"{obj['category']}_{obj['id']}", bm, mats, props, m)


# --------------------------------------------------------------------------- Rendern


def setup_render(scene: dict, out_png: str, samples: int = 48) -> None:
    poly = scene["room"]["polygon"]
    height = scene["room"]["height"]
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2

    # Licht: Flächenlicht unter der Decke + Welthelligkeit
    light_data = bpy.data.lights.new("CeilingLight", type="AREA")
    light_data.energy = 12 * (max(xs) - min(xs)) * (max(ys) - min(ys))
    light_data.size = min(max(xs) - min(xs), max(ys) - min(ys)) * 0.6
    light = bpy.data.objects.new("CeilingLight", light_data)
    light.location = (cx, cy, height - 0.05)
    bpy.context.scene.collection.objects.link(light)
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    bpy.context.scene.world = world

    # Kamera in der Ecke, die am weitesten vom ersten Möbel entfernt ist, Blick zur Raummitte
    corner = max(poly, key=lambda p: math.hypot(p[0] - cx, p[1] - cy))
    pos = Vector((corner[0] + (cx - corner[0]) * 0.08, corner[1] + (cy - corner[1]) * 0.08, height * 0.62))
    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 16
    cam = bpy.data.objects.new("Camera", cam_data)
    cam.location = pos
    direction = Vector((cx, cy, 0.9)) - pos
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.render.filepath = out_png
    sc.view_settings.view_transform = "AgX" if "AgX" in [
        i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"


# --------------------------------------------------------------------------- Einstieg


def build(scene: dict, out_glb: str | None = None, render_png: str | None = None,
          blend_path: str | None = None, samples: int = 48) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _material_cache.clear()
    build_floor_and_ceiling(scene)
    build_walls(scene)
    build_objects(scene)
    if out_glb:
        Path(out_glb).parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(out_glb), export_format="GLB", export_extras=True,
                                  export_yup=True, export_apply=True, export_lights=False,
                                  export_cameras=False)
    if blend_path:
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    if render_png:
        setup_render(scene, str(render_png), samples)
        bpy.ops.render.render(write_still=True)


def main(argv: list[str]) -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("scene")
    parser.add_argument("out_glb", nargs="?")
    parser.add_argument("--render")
    parser.add_argument("--blend")
    parser.add_argument("--samples", type=int, default=48)
    args = parser.parse_args(argv)
    scene = json.loads(Path(args.scene).read_text(encoding="utf-8"))
    build(scene, args.out_glb, args.render, args.blend, args.samples)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    main(argv)
