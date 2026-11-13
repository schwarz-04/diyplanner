"""Baut eine Vorlagen-Bibliothek (ein Möbelstück je Kategorie in Standardgröße) für den Demo-Modus.

Aufruf: python tools/build_library.py library.glb
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "blender"))
import bpy, build_scene as b
cat = json.load(open(Path(__file__).resolve().parent.parent / "shared" / "catalog.json"))["categories"]
objs = [{"id": f"tpl_{k}", "category": k, "label": v["label"], "position": [i*3.0, 0, 0], "rotation": 0,
         "size": v["size"], "color": v["color"]} for i, (k, v) in enumerate(cat.items())]
bpy.ops.wm.read_factory_settings(use_empty=True)
b._material_cache.clear()
b.build_objects({"objects": objs})
bpy.ops.export_scene.gltf(filepath=sys.argv[1], export_format="GLB", export_extras=True, export_yup=True,
                          export_apply=True, export_lights=False, export_cameras=False)
