"""
Build AcuCraft's equipment models (docs/MODELS.md): every type of the pack's catalog is built in an empty
Blender scene, in its own frame, by its builder in models.py, and exported with ClinicalCraft's Blender bridge
(scripts/blender in the pinned checkout) to content/world/assets/models/<type>.glb. The catalog references
(sha256, offset, licence, source, use status) go to tools/blender/models.json, which
tools/content/clinic_world.py puts into the catalog.

    blender -b -P tools/blender/build.py [-- <type id> …]
    python3 tools/blender/build.py [<type id> …]        # a Python with the `bpy` module (Blender 4.1+)

then `python3 tools/content/clinic_world.py`. ClinicalCraft is found at $CLINICALCRAFT_DIR, else in
.deps/clinicalcraft (`npm run bootstrap`). A needling station is built round the body the world draws on
its couch: run `npx tsx tools/figure-fit.mts` first (tools/blender/fit/<type>.json).

The same scene gives the same file: tools/check.sh compares what is on disk with the catalog's hashes, and a
rebuild that changes nothing leaves the tree clean.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CLINICALCRAFT = Path(os.environ.get("CLINICALCRAFT_DIR") or REPO / ".deps" / "clinicalcraft").resolve()
if not (CLINICALCRAFT / "scripts" / "blender" / "clinicalcraft_shapes.py").is_file():
    raise SystemExit(f"no ClinicalCraft checkout at {CLINICALCRAFT}: run `npm run bootstrap`, or set CLINICALCRAFT_DIR")
sys.path[:0] = [str(CLINICALCRAFT / "scripts" / "blender"), str(HERE)]

import bpy  # noqa: E402

import clinicalcraft_blender as cc  # noqa: E402
from clinicalcraft_shapes import Kit  # noqa: E402
from models import MODELS  # noqa: E402

CONTENT = REPO / "content" / "world"
OUT = CONTENT / "assets" / "models"
MANIFEST = HERE / "models.json"
CATALOG = CONTENT / "catalogs" / "acucraft-tcm.json"
#: Licence of the models (the same as AcuCraft's code); they are AcuCraft's own work.
LICENSE = "MIT"
ATTRIBUTION = {
    "zh-CN": "AcuCraft 贡献者，在 Blender 中按该设备类型的占位与体素部件程序化建模（tools/blender）",
    "en": "AcuCraft contributors, modelled procedurally in Blender from the type's footprint and voxel parts (tools/blender)",
}


def build(type_id: str) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    eq = cc.load_type(type_id, content=[CONTENT])
    builder = MODELS.get(type_id)
    if builder is None:
        raise SystemExit(f"{type_id}: no builder in tools/blender/models.py (every type of the pack has its own)")
    k = Kit(eq)
    builder(k, eq)
    layers = k.triangles()
    ob = k.finish()
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    ref = cc.export_model(
        eq, OUT / f"{type_id}.glb", license=LICENSE, use="cleared", attribution=ATTRIBUTION,
        source={"name": "AcuCraft tools/blender", "url": "https://github.com/psknlr/AcuCraft",
                "version": f"Blender {bpy.app.version_string}", "changes": "modelled procedurally from the type's footprint and voxel parts"},
    )
    # a model in layers (drawn by state: ClinicalCraft docs/BLENDER.md "Layers"): what is always drawn, and each layer
    shown = "".join(f" + {name} {n}" for name, n in layers.items() if name)
    print(f"{type_id}: {tris} triangles{shown}, {len(ob.data.materials)} materials, {(OUT / f'{type_id}.glb').stat().st_size} B")
    return ref


def main(argv: list[str]) -> None:
    types = sorted(e["id"] for e in json.loads(CATALOG.read_text(encoding="utf-8"))["equipment"])
    ids = argv or types
    unknown = [i for i in ids if i not in types]
    if unknown:
        raise SystemExit(f"not in the pack's catalog: {', '.join(unknown)}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    for type_id in ids:
        manifest[type_id] = build(type_id)
    manifest = {k: manifest[k] for k in sorted(manifest) if k in types}
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(ids)} model(s) to {OUT.relative_to(REPO)} and {MANIFEST.relative_to(REPO)}")


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ([] if bpy.app.binary_path and Path(sys.argv[0]).name.startswith("blender") else sys.argv[1:])
    main(args)
