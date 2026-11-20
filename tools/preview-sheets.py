#!/usr/bin/env python3
"""The reference sheets of docs/img, drawn by ClinicalCraft's own previewer (scripts/preview/render.mjs in a
checkout with its dependencies installed): the pack's models as the world draws them, the needling stations in the
states of their drill, the floor plans, and the people — the staff of both facilities and each family's patient.

    python3 tools/preview-sheets.py [--cc <ClinicalCraft checkout>] [--out docs/img]

The previewer draws; this script only runs it and, for the people, sets its sheets side by side (Pillow). The
pictures taken inside the 3D world itself are tools/world-shots.mjs.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORLD = ROOT / "content" / "world"
STATIONS = "acu-needling-station-prone,acu-needling-station-supine"
FAMILIES = ["sg-low-back-pain", "sg-knee-oa", "sg-insomnia", "sg-chemo-nausea", "sg-tension-headache"]
CELL = 420


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cc", default=os.environ.get("CLINICALCRAFT_DIR") or str(ROOT.parent / "ClinicalCraft"))
    ap.add_argument("--out", default=str(ROOT / "docs" / "img"))
    args = ap.parse_args()
    cc, out = Path(args.cc).resolve(), Path(args.out).resolve()
    if not (cc / "scripts" / "preview" / "render.mjs").is_file() or not (cc / "node_modules").is_dir():
        sys.exit(f"no ClinicalCraft checkout with its dependencies installed at {cc} (--cc, or CLINICALCRAFT_DIR)")
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        # the pack on the previewer's content path (a facility's room templates are found there)
        home = Path(tmp) / "home"
        home.mkdir()
        (home / "settings.json").write_text(json.dumps({"contentDirs": [str(WORLD)]}), encoding="utf-8")
        env = {**os.environ, "CLINICALCRAFT_HOME": str(home)}

        def render(mode: str, *options: str, to: Path) -> None:
            done = subprocess.run(["node", "scripts/preview/render.mjs", mode, *options, "--out", str(to)], cwd=cc, env=env, capture_output=True, text=True)
            last = (done.stdout.strip().splitlines() or [""])[-1]
            if done.returncode != 0 or '"ok":true' not in last:
                sys.exit(f"{mode} {' '.join(options)}:\n{done.stdout}\n{done.stderr}")
            print(f"{to.relative_to(ROOT) if to.is_relative_to(ROOT) else to.name}")

        materials = cc / "packages" / "content" / "catalogs" / "materials.json"
        catalogs = ",".join(str(p) for p in (materials, cc / "packages/content/catalogs/core-furniture.json", cc / "packages/content/catalogs/core-clinical.json", WORLD / "catalogs" / "acucraft-tcm.json"))
        models = ["--catalogs", f"{materials},{WORLD / 'catalogs' / 'acucraft-tcm.json'}", "--assets", f"{cc / 'packages/content/assets'},{WORLD / 'assets'}"]
        types = [e["id"] for e in json.loads((WORLD / "catalogs" / "acucraft-tcm.json").read_text(encoding="utf-8"))["equipment"]]
        furniture = ",".join(t for t in types if "station" not in t)
        render("models", *models, "--only", furniture, "--view", "iso", "--cell", "400", "--cols", "5", to=out / "models.png")
        render("models", *models, "--only", STATIONS, "--states", "ready,located,needled,retained", "--view", "iso", "--cell", "480", "--cols", "4", to=out / "station-states.png")
        for facility, name in (("sg-tcm-outpatient", "clinic-plan-clinicalcraft"), ("sg-tcm-skills-room", "skills-plan-clinicalcraft")):
            render("facility", "--facility", str(WORLD / "facilities" / f"{facility}.json"), "--catalogs", catalogs, to=out / f"{name}.png")

        # the people: each facility's staff, and each family's patient as the case seats them
        sheets = []
        for facility in ("sg-tcm-outpatient", "sg-tcm-skills-room"):
            sheets.append((Path(tmp) / f"staff-{facility}.png", None))
            render("people", "--facility", str(WORLD / "facilities" / f"{facility}.json"), "--cell", str(CELL), to=sheets[-1][0])
        for family in FAMILIES:
            sheets.append((Path(tmp) / f"patient-{family}.png", 1))
            render("people", "--case", str(ROOT / "content" / "families" / family / "case.json"), "--cell", str(CELL), to=sheets[-1][0])
        try:
            from PIL import Image
        except ImportError:
            sys.exit("the people sheet is set side by side with Pillow: pip install pillow")
        cells = []
        for path, take in sheets:
            im = Image.open(path).convert("RGB")
            count = im.width // CELL
            # (a case's sheet is its patient standing, sitting and in bed: the one sitting, as the consultation starts)
            for i in ([take] if take is not None else range(count)):
                cells.append(im.crop((i * CELL, 0, (i + 1) * CELL, im.height)))
        sheet = Image.new("RGB", (CELL * len(cells), cells[0].height), "white")
        for i, cell in enumerate(cells):
            sheet.paste(cell, (i * CELL, 0))
        sheet.thumbnail((2400, 2400), Image.LANCZOS)
        sheet.save(out / "people.png", optimize=True)
        print("docs/img/people.png" if out == ROOT / "docs" / "img" else "people.png")


if __name__ == "__main__":
    main()
