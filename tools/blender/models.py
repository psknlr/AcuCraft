"""
AcuCraft's equipment models, written in each type's own frame (ClinicalCraft's
scripts/blender/clinicalcraft_shapes.py: metres, x right, y up, z front, origin at the footprint centre on
the floor) from its footprint and voxel parts: the surfaces a body lies or sits on, and what things stand on,
stay where the world expects them. Every type of the pack has its builder here; `build.py` runs them.

The two needling stations are built round a body the world draws on their couch (the type's `manikin`): where
its skin is at each site comes from tools/blender/fit/<type>.json, which tools/figure-fit.mts measures on the
pinned figure kit. What stands on the skin is in layers, drawn by the station's state.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import bpy  # first: with the `bpy` module, bmesh is importable only once bpy is
import bmesh
from mathutils import Vector

import clinicalcraft_blender as cc
from clinicalcraft_shapes import Kit, rrect

HERE = Path(__file__).resolve().parent

#: type id -> builder(kit, equipment)
MODELS = {}


def model(type_id):
    def register(fn):
        MODELS[type_id] = fn
        return fn
    return register


# ------------------------------------------------------------------------------------------------
# shapes the kit does not have
# ------------------------------------------------------------------------------------------------

def add_mesh(k: Kit, bm, m: str) -> None:
    """Append a mesh built here (its vertices in Blender's axes: `cc.to_blender`) to what the kit is building —
    the model's own mesh or the layer being built — painted `m`."""
    if m not in k.slots:
        k.slots.append(m)
    index = k.slots.index(m)
    for f in bm.faces:
        f.material_index = index
    me = bpy.data.meshes.new("acu-shape")
    bm.to_mesh(me)
    bm.free()
    k.bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def loft(k: Kit, rings, m: str, caps=(True, True)) -> None:
    """A skin over `rings` — lists of points of the frame, as many in each, going the same way round."""
    bm = bmesh.new()
    vs = [[bm.verts.new(cc.to_blender(p)) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if caps[0]:
        bm.faces.new(list(reversed(vs[0])))
    if caps[1]:
        bm.faces.new(vs[-1])
    add_mesh(k, bm, m)


def oval(cx: float, y: float, cz: float, rx: float, front: float, back: float | None = None, n: int = 20, power: float = 2.3):
    """A ring of a body's section at height `y`: half-width `rx`, `front` deep in front of (cx, cz) and `back`
    behind it — a superellipse, a little squarer than an ellipse, as a trunk is."""
    back = front if back is None else back
    e = 2 / power
    ring = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        ring.append((cx + math.copysign(abs(s) ** e, s) * rx, y, cz + math.copysign(abs(c) ** e, c) * (front if c >= 0 else back)))
    return ring


def limb(path, radii, n: int = 12):
    """The rings of a round limb along `path` (a ring at each point, of that point's radius, carried along
    without twisting) and, for what is drawn on its surface, each ring's frame: (centre, front, side)."""
    pts = [Vector(p) for p in path]
    dirs = [(b - a).normalized() for a, b in zip(pts, pts[1:])]
    tangents = [dirs[0]] + [(a + b).normalized() for a, b in zip(dirs, dirs[1:])] + [dirs[-1]]
    front = Vector((0, 0, 1))
    frames = []
    for p, t in zip(pts, tangents):
        front = (front - t * front.dot(t)).normalized()
        frames.append((p, front.copy(), t.cross(front)))
    rings = [[tuple(p + (f * math.cos(2 * math.pi * j / n) + s * math.sin(2 * math.pi * j / n)) * r) for j in range(n)] for (p, f, s), r in zip(frames, radii)]
    return rings, frames


def on_limb(frames, radii, i: int, angle: float, proud: float = 0.0):
    """A point of a limb's surface at its `i`-th ring, `angle` radians round from its front."""
    p, f, s = frames[i]
    return tuple(p + (f * math.cos(angle) + s * math.sin(angle)) * (radii[i] + proud))


def plate_with_hole(k: Kit, outline, hole, y0: float, thickness: float, m: str, r: float = 0.0, r_hole: float = 0.0, seg: int = 2) -> None:
    """A flat piece with a hole through it: `outline` (x, z) seen from above, and `hole` = (cx, cz, rx, rz) an
    oval inside it; from height y0 up by `thickness`; `r` rounds its outer rims and `r_hole` the hole's."""
    cx, cz, rx, rz = hole
    # more points along the straight runs, so that the spokes to the hole are even
    pts = []
    for a, b in zip(outline, outline[1:] + outline[:1]):
        steps = max(1, round(math.dist(a, b) / 0.05))
        pts += [(a[0] + (b[0] - a[0]) * t / steps, a[1] + (b[1] - a[1]) * t / steps) for t in range(steps)]
    inner = []
    for x, z in pts:
        a = math.atan2((z - cz) / rz, (x - cx) / rx)
        inner.append((cx + rx * math.cos(a), cz + rz * math.sin(a)))
    n = len(pts)
    bm = bmesh.new()
    ring = lambda outline_, y: [bm.verts.new(cc.to_blender((x, y, z))) for x, z in outline_]  # noqa: E731
    ob, ot, ib, it = ring(pts, y0), ring(pts, y0 + thickness), ring(inner, y0), ring(inner, y0 + thickness)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ot[i], ot[j], it[j], it[i]))
        bm.faces.new((ob[j], ob[i], ib[i], ib[j]))
        bm.faces.new((ob[i], ob[j], ot[j], ot[i]))
        bm.faces.new((ib[j], ib[i], it[i], it[j]))
    rim = lambda vs: [e for e in bm.edges if e.verts[0] in vs and e.verts[1] in vs]  # noqa: E731
    outer_rims, hole_rims = rim(set(ot)) + rim(set(ob)), rim(set(it)) + rim(set(ib))
    if r > 0:
        bmesh.ops.bevel(bm, geom=outer_rims, offset=min(r, 0.45 * thickness), segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    if r_hole > 0:
        bmesh.ops.bevel(bm, geom=[e for e in hole_rims if e.is_valid], offset=min(r_hole, 0.45 * thickness), segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    add_mesh(k, bm, m)


def moved(outline, dx: float = 0.0, dz: float = 0.0):
    """An outline shifted."""
    return [(x + dx, z + dz) for x, z in outline]


# ------------------------------------------------------------------------------------------------
# the treatment couch (the clinic's, and the couch of each needling station)
# ------------------------------------------------------------------------------------------------

COUCH_TOP = 0.67       # the upholstery's top: the part named "mattress" in the catalog
FACE_HOLE_Z = -0.765   # the middle of the breathing hole


def couch_base(k: Kit, pillow: bool = True, paper: bool = True) -> None:
    """A treatment couch 0.7 × 1.9 m: a beech frame — four legs, an apron, a slatted shelf with rolled towels —
    and a padded top in two sections, the head section with its breathing hole; a paper sheet off the roll at
    the foot end; a small pillow."""
    wood, pad = "acu-beech", "acu-jade"
    for x in (-0.29, 0.29):
        for z in (-0.80, 0.80):
            k.box((x, 0.29, z), (0.058, 0.54, 0.058), wood, r=0.008, seg=1)
            k.cyl((x, 0.011, z), 0.024, 0.022, "rubber", seg=10)
    # the apron under the top, and the stretchers the shelf lies on
    for x in (-0.29, 0.29):
        k.box((x, 0.527, 0), (0.026, 0.075, 1.542), wood, r=0.004, seg=1)
        k.box((x, 0.2, 0), (0.026, 0.045, 1.542), wood, r=0.004, seg=1)
    for z in (-0.80, 0.80):
        k.box((0, 0.527, z), (0.522, 0.075, 0.026), wood, r=0.004, seg=1)
        k.box((0, 0.2, z), (0.522, 0.045, 0.026), wood, r=0.004, seg=1)
    # the shelf: slats, and what is kept on it — rolled towels, a folded blanket
    for i in range(7):
        k.box((-0.21 + 0.07 * i, 0.229, 0), (0.052, 0.012, 1.56), wood, r=0.003, seg=1)
    for x, y, z in ((-0.11, 0.29, 0.45), (0.0, 0.29, 0.45), (0.11, 0.29, 0.45), (-0.055, 0.382, 0.45), (0.055, 0.382, 0.45)):
        k.cyl((x, y, z), 0.054, 0.32, "acu-terry", axis="z", seg=12, bevel=0.014)
        k.cyl((x, y, z + 0.161), 0.02, 0.002, "white", axis="z", seg=8)
    k.box((0, 0.275, -0.25), (0.4, 0.08, 0.34), "mint", r=0.03, seg=2)
    k.box((0, 0.335, -0.25), (0.39, 0.04, 0.33), "acu-linen", r=0.018, seg=2)
    # the board under the padding, then the padding: the long section, and the head section with the breathing hole
    k.slab(rrect(0.69, 1.89, 0.05), 0.562, 0.02, wood, r=0.004)
    k.slab(rrect(0.70, 1.55, 0.055), 0.58, COUCH_TOP - 0.58, pad, at=(0, 0, 0.175), r=0.024, seg=3)
    plate_with_hole(k, moved(rrect(0.70, 0.335, 0.055), dz=-0.7825), (0, FACE_HOLE_Z, 0.062, 0.085), 0.58, COUCH_TOP - 0.58, pad, r=0.024, r_hole=0.016, seg=3)
    # (the hole goes through the board: dark below)
    k.slab(rrect(0.16, 0.2, 0.03), 0.5815, 0.002, "black", at=(0, 0, FACE_HOLE_Z))
    # piping along the seam of each section
    k.slab(rrect(0.704, 1.554, 0.057), 0.622, 0.004, "acu-linen", at=(0, 0, 0.175))
    if paper:
        # the sheet off the roll: over the long section, down over the foot end to the roll under it
        k.slab(rrect(0.56, 1.5, 0.004), COUCH_TOP + 0.0006, 0.0016, "paper", at=(0, 0, 0.19))
        k.box((0, COUCH_TOP - 0.045, 0.954), (0.56, 0.096, 0.0016), "paper")
        k.cyl((0, 0.5, 0.905), 0.046, 0.54, "paper", axis="x", seg=14, bevel=0.004)
        k.cyl((0, 0.5, 0.905), 0.014, 0.6, "chrome", axis="x", seg=8)
        for x in (-0.292, 0.292):
            k.box((x, 0.5, 0.86), (0.006, 0.03, 0.1), "chrome")
    if pillow:
        pillow_at(k, -0.59, COUCH_TOP + 0.002, 0.055)


def pillow_at(k: Kit, z: float, y0: float, thick: float, width: float = 0.4, depth: float = 0.22) -> None:
    """A small pillow in a paper cover, its underside at y0."""
    k.box((0, y0 + thick / 2, z), (width, thick, depth), "acu-linen", r=min(0.024, thick * 0.45), seg=3)
    k.slab(rrect(width * 0.82, depth + 0.006, 0.01), y0 + thick - 0.0005, 0.0012, "paper", at=(0, 0, z))


@model("acu-treatment-couch")
def treatment_couch(k: Kit, eq):
    """The clinic's couch, made up for the next patient: fresh paper, the pillow below the breathing hole."""
    couch_base(k)


# ------------------------------------------------------------------------------------------------
# the patient's chair
# ------------------------------------------------------------------------------------------------

@model("acu-patient-chair")
def patient_chair(k: Kit, eq):
    """An upright beech armchair: a padded seat (its top at 0.50 m, where a patient sits) and back pad."""
    wood, pad = "acu-beech", "acu-jade"
    for x in (-0.21, 0.21):
        k.box((x, 0.31, 0.2), (0.042, 0.62, 0.042), wood, r=0.007, seg=1)
        k.box((x, 0.445, -0.215), (0.042, 0.89, 0.042), wood, r=0.007, seg=1)
        # side rails under the seat, a stretcher low down, the armrest
        k.box((x, 0.4, -0.008), (0.024, 0.06, 0.39), wood, r=0.004, seg=1)
        k.box((x, 0.16, -0.008), (0.022, 0.03, 0.39), wood, r=0.004, seg=1)
        k.slab(rrect(0.056, 0.46, 0.02), 0.62, 0.026, wood, at=(x * 1.02, 0, -0.005), r=0.008)
    for z in (0.2, -0.215):
        k.box((0, 0.4, z), (0.39, 0.06, 0.024), wood, r=0.004, seg=1)
    k.box((0, 0.16, -0.215), (0.39, 0.03, 0.022), wood, r=0.004, seg=1)
    k.slab(rrect(0.45, 0.43, 0.045), 0.43, 0.07, pad, at=(0, 0, 0.012), r=0.022, seg=3)
    # the back: a top rail, a lower rail, the pad between them
    k.box((0, 0.868, -0.215), (0.39, 0.05, 0.03), wood, r=0.01, seg=2)
    k.box((0, 0.575, -0.215), (0.39, 0.03, 0.024), wood, r=0.004, seg=1)
    k.panel([(x, 0.712 + y) for x, y in rrect(0.35, 0.22, 0.035)], -0.228, 0.042, pad, r=0.014, seg=2)


# ------------------------------------------------------------------------------------------------
# the needle trolley
# ------------------------------------------------------------------------------------------------

#: A filiform needle of 1.5 cun: 40 mm of shaft below a wound handle of 24 mm. Drawn two to four times as thick as
#: life (a shaft of 0.25 mm is under a pixel at arm's length); its lengths are true.
NEEDLE_SHAFT, NEEDLE_HANDLE = 0.040, 0.024


def needle(k: Kit, tip, head, shaft: str = "chrome", handle: str = "acu-copper", seg: int = 5) -> None:
    """A filiform needle from its tip to the end of its handle: the shaft, the wound handle, the ring at its end."""
    a, b = Vector(tip), Vector(head)
    d = (b - a).normalized()
    neck = b - d * NEEDLE_HANDLE
    k.tube(tuple(a), tuple(neck), 0.0005, shaft, seg=seg)
    k.tube(tuple(neck), tuple(b), 0.0013, handle, seg=seg + 1)
    k.ball(tuple(b + d * 0.0014), 0.0021, handle, seg=6)


@model("acu-needle-trolley")
def needle_trolley(k: Kit, eq):
    """A stainless treatment trolley: two shelves with rails on four posts and casters, a push handle. On top
    (0.895 m) the tray for an opened pack with its needles, sealed packs, a jar of cotton balls, a forceps
    jar, a pump bottle of hand rub and the sharps box; below, gloves, a kidney dish, towels."""
    top = 0.895
    for x in (-0.262, 0.262):
        for z in (-0.187, 0.187):
            k.caster(x, z, r=0.036, stem=0.022, lite=True)
            k.tube((x, 0.094, z), (x, top + 0.058, z), 0.0105, "chrome", seg=10)
            k.ball((x, top + 0.058, z), 0.0125, "chrome", seg=8)
    for y in (0.3, top - 0.016):
        k.slab(rrect(0.56, 0.41, 0.018), y, 0.016, "steel", r=0.004)
        # the rail round each shelf, open at the front of the top one
        rail = y + 0.052
        back = [(-0.262, rail, 0.187), (-0.262, rail, -0.187), (0.262, rail, -0.187), (0.262, rail, 0.187)]
        k.pipe(back, 0.005, "chrome", bend=0.012, seg=6)
        if y < 0.5:
            k.tube((-0.262, rail, 0.187), (0.262, rail, 0.187), 0.005, "chrome", seg=6)
    # the push handle, at one end
    k.pipe([(-0.262, top + 0.02, -0.15), (-0.325, top + 0.045, -0.15), (-0.325, top + 0.045, 0.15), (-0.262, top + 0.02, 0.15)], 0.008, "chrome", bend=0.025, seg=8)

    # the tray, an opened blister of needles on it, a swab
    k.slab(rrect(0.23, 0.15, 0.022), top, 0.004, "chrome", at=(-0.045, 0, -0.085))
    k.pipe([(-0.158, top + 0.012, -0.158), (0.068, top + 0.012, -0.158), (0.068, top + 0.012, -0.012), (-0.158, top + 0.012, -0.012), (-0.158, top + 0.012, -0.158)], 0.0045, "chrome", bend=0.016, seg=6)
    k.box((-0.07, top + 0.006, -0.085), (0.125, 0.003, 0.085), "paper", r=0.001, seg=1)
    for i in range(5):
        x = -0.118 + i * 0.024
        needle(k, (x, top + 0.0085, -0.052), (x, top + 0.0085, -0.118), seg=4)
    k.box((0.03, top + 0.008, -0.07), (0.04, 0.008, 0.04), "white", r=0.003, seg=1)
    # sealed packs of needles: boxes with a band in the colour of their gauge
    for i, (band, dy) in enumerate((("blue", 0), ("acu-vermilion", 0), ("blue", 0.052))):
        x, y = (-0.205 + 0.0 * i if dy else -0.205 + 0.118 * i), top + 0.026 + dy
        k.box((x, y, 0.105), (0.108, 0.05, 0.075), "white", r=0.003, seg=1)
        k.box((x, y, 0.105), (0.03, 0.0505, 0.0755), band)
    # a glass jar of cotton balls with a steel lid; a forceps jar; hand rub
    k.cyl((0.045, top + 0.045, 0.115), 0.042, 0.09, "glass", seg=16)
    for dx, dz, dy in ((-0.014, -0.01, 0.022), (0.016, 0.008, 0.024), (0.0, -0.004, 0.052), (-0.012, 0.014, 0.05), (0.014, -0.012, 0.062)):
        k.ball((0.045 + dx, top + dy, 0.115 + dz), 0.02, "acu-terry", seg=7)
    k.cyl((0.045, top + 0.094, 0.115), 0.044, 0.008, "steel", seg=16, bevel=0.002)
    k.ball((0.045, top + 0.104, 0.115), 0.009, "steel", seg=8)
    k.cyl((0.132, top + 0.05, 0.14), 0.023, 0.1, "steel", seg=12, bevel=0.002)
    for dx, lean in ((-0.006, -4), (0.006, 5)):
        k.box((0.132 + dx, top + 0.125, 0.14), (0.005, 0.11, 0.003), "chrome", rot=(0, 0, lean))
    k.cyl((-0.215, top + 0.06, -0.095), 0.028, 0.12, "plastic", seg=12, bevel=0.006)
    k.cyl((-0.215, top + 0.133, -0.095), 0.009, 0.03, "white", seg=8)
    k.box((-0.215, top + 0.152, -0.078), (0.014, 0.008, 0.05), "white", r=0.002, seg=1)
    k.box((-0.215, top + 0.06, -0.0665), (0.036, 0.05, 0.001), "blue")
    # the sharps box at the point of use: a yellow body, a lid with its opening, a label
    k.box((0.19, top + 0.085, -0.085), (0.15, 0.17, 0.15), "acu-sharps", r=0.014, seg=2)
    k.box((0.19, top + 0.182, -0.085), (0.156, 0.026, 0.156), "biohazard", r=0.008, seg=2)
    k.cyl((0.19, top + 0.1955, -0.075), 0.034, 0.002, "black", seg=14)
    k.box((0.19, top + 0.09, -0.0095), (0.085, 0.07, 0.001), "white")
    k.box((0.19, top + 0.1, -0.009), (0.05, 0.03, 0.001), "biohazard")
    # below: a box of gloves, a kidney dish, folded towels
    k.box((-0.15, 0.352, 0.02), (0.23, 0.072, 0.125), "blue", r=0.004, seg=1)
    k.box((-0.15, 0.3885, 0.02), (0.11, 0.001, 0.035), "white")
    k.lathe([(0.062, 0), (0.07, 0.006), (0.074, 0.032), (0.07, 0.034), (0.064, 0.008)], (0.13, 0.316, -0.06), "chrome", seg=14)
    for i in range(3):
        k.box((0.12, 0.332 + 0.03 * i, 0.105), (0.2, 0.028, 0.13), "acu-terry", r=0.012, seg=2)


# ------------------------------------------------------------------------------------------------
# storage: the supply shelf, the herb cabinet
# ------------------------------------------------------------------------------------------------

@model("acu-supply-shelf")
def supply_shelf(k: Kit, eq):
    """Open shelving for the clinic's consumables: boxes of single-use needles by gauge, swabs, cotton, gloves,
    plasters, bottles of hand rub and alcohol, paper rolls."""
    for x in (-0.585, 0.585):
        for z in (-0.2, 0.2):
            k.box((x, 0.95, z), (0.03, 1.9, 0.03), "white", r=0.004, seg=1)
        for y in (0.3, 0.775, 1.2, 1.63):
            k.box((x, y, 0), (0.012, 0.03, 0.4), "white")
    levels = (0.12, 0.55, 0.98, 1.41, 1.84)
    for y in levels:
        k.box((0, y - 0.01, 0), (1.17, 0.02, 0.43), "white")
        k.box((0, y + 0.012, 0.208), (1.14, 0.024, 0.006), "steel")
    k.box((0, 0.95, -0.215), (1.16, 1.86, 0.008), "plastic")
    # bottom: crates of paper rolls
    for x, m in ((-0.3, "beige"), (0.3, "beige")):
        k.box((x, 0.12 + 0.11, 0.0), (0.5, 0.22, 0.34), m, r=0.012, seg=2)
        for i in range(3):
            k.cyl((x - 0.15 + 0.15 * i, 0.12 + 0.245, 0.02), 0.058, 0.25, "paper", axis="z", seg=12)
    # boxes of needles, two high, a band in the colour of each gauge
    bands = ("blue", "acu-vermilion", "yellow", "green", "purple", "blue", "acu-vermilion", "green")
    for i, band in enumerate(bands):
        for row in range(2 if i % 3 else 3):
            x, y = -0.49 + i * 0.14, 0.55 + 0.036 + row * 0.072
            k.box((x, y, 0.07), (0.118, 0.07, 0.19), "white", r=0.003, seg=1)
            k.box((x, y, 0.166), (0.118, 0.022, 0.0012), band)
    # gloves (three sizes), swabs, plasters
    for i, m in enumerate(("blue", "blue", "blue")):
        k.box((-0.42 + i * 0.27, 0.98 + 0.04, 0.05), (0.24, 0.08, 0.13), m, r=0.004, seg=1)
        k.box((-0.42 + i * 0.27, 0.98 + 0.0805, 0.05), (0.1, 0.001, 0.04), "white")
        k.box((-0.42 + i * 0.27, 0.98 + 0.12, 0.05), (0.24, 0.08, 0.13), "white", r=0.004, seg=1)
    for i in range(2):
        k.box((0.4, 0.98 + 0.035 + i * 0.07, 0.06), (0.16, 0.07, 0.2), "mint", r=0.004, seg=1)
    # bottles of alcohol and hand rub, jars of cotton balls
    for i in range(4):
        x = -0.48 + i * 0.1
        k.cyl((x, 1.41 + 0.085, 0.08), 0.036, 0.17, "plastic", seg=10, bevel=0.008)
        k.cyl((x, 1.41 + 0.185, 0.08), 0.014, 0.034, "blue" if i < 2 else "white", seg=8)
        k.box((x, 1.41 + 0.08, 0.1165), (0.046, 0.07, 0.001), "blue" if i < 2 else "mint")
    for i in range(3):
        x = 0.02 + i * 0.13
        k.cyl((x, 1.41 + 0.06, 0.07), 0.052, 0.12, "glass", seg=14)
        for dx, dz, dy in ((-0.016, -0.01, 0.026), (0.018, 0.01, 0.028), (0.0, 0.0, 0.062), (-0.016, 0.012, 0.09), (0.016, -0.012, 0.094)):
            k.ball((x + dx, 1.41 + dy, 0.07 + dz), 0.024, "acu-terry", seg=5)
        k.cyl((x, 1.41 + 0.125, 0.07), 0.054, 0.01, "steel", seg=14, bevel=0.002)
    k.box((0.46, 1.41 + 0.05, 0.05), (0.14, 0.1, 0.24), "white", r=0.004, seg=1)
    k.box((0.46, 1.41 + 0.05, 0.171), (0.08, 0.04, 0.001), "acu-vermilion")
    # top: folded couch covers
    for x, m in ((-0.3, "acu-linen"), (0.22, "mint")):
        k.box((x, 1.84 + 0.022, 0.0), (0.4, 0.044, 0.3), m, r=0.012, seg=2)


@model("acu-herb-cabinet")
def herb_cabinet(k: Kit, eq):
    """A rosewood herb cabinet: a plinth, the carcase, six rows of seven drawers each with a paper label and a
    brass pull, a cornice, and three storage jars on top."""
    k.box((0, 0.045, -0.02), (1.56, 0.09, 0.38), "acu-rosewood", r=0.004, seg=1)
    k.box((0, 0.905, -0.025), (1.6, 1.63, 0.4), "acu-rosewood", r=0.006, seg=1)
    k.slab(rrect(1.64, 0.45, 0.012), 1.72, 0.04, "acu-rosewood", r=0.012, seg=2)
    k.slab(rrect(1.6, 0.42, 0.008), 1.7, 0.02, "acu-walnut")
    cols, rows = 7, 6
    x0, x1, y0, y1 = -0.765, 0.765, 0.13, 1.68
    w, h = (x1 - x0) / cols, (y1 - y0) / rows
    for row in range(rows):
        for col in range(cols):
            x, y = x0 + (col + 0.5) * w, y0 + (row + 0.5) * h
            k.box((x, y, 0.184), (w - 0.018, h - 0.018, 0.02), "acu-walnut")
            # the label: what the drawer's compartments hold
            k.box((x, y + 0.045, 0.1946), (w * 0.52, 0.05, 0.0012), "acu-linen")
            for i in (-1, 1):
                k.box((x + i * w * 0.11, y + 0.045, 0.1954), (0.007, 0.034, 0.0006), "acu-ink")
            k.cyl((x, y - 0.04, 0.2), 0.0095, 0.014, "acu-brass", axis="z", seg=6)
            k.cyl((x, y - 0.04, 0.1955), 0.017, 0.003, "acu-brass", axis="z", seg=6)
    # the jars: white porcelain with a blue band and a lid
    for x in (-0.52, 0.0, 0.52):
        k.lathe([(0.04, 0), (0.066, 0.018), (0.074, 0.06), (0.066, 0.1), (0.046, 0.118), (0.05, 0.126)], (x, 1.76, -0.02), "white", seg=14)
        k.cyl((x, 1.76 + 0.062, -0.02), 0.0752, 0.02, "navy", seg=14)
        k.lathe([(0.052, 0), (0.05, 0.008), (0.02, 0.016), (0.012, 0.03), (0.0, 0.034)], (x, 1.76 + 0.124, -0.02), "navy", seg=14)


# ------------------------------------------------------------------------------------------------
# the hanging chart
# ------------------------------------------------------------------------------------------------

#: Half the outline of a standing figure seen from the front, arms a little out, as (x, height) of a figure one
#: unit tall: from the crown down the right side to the crotch.
FIGURE_HALF = [
    (0.0, 1.0), (0.034, 0.99), (0.052, 0.962), (0.056, 0.925), (0.046, 0.89), (0.03, 0.872), (0.028, 0.85), (0.06, 0.836), (0.105, 0.822), (0.128, 0.8),
    (0.142, 0.72), (0.158, 0.62), (0.178, 0.52), (0.192, 0.475), (0.206, 0.44), (0.2, 0.4), (0.186, 0.386), (0.174, 0.41), (0.169, 0.45), (0.166, 0.475),
    (0.142, 0.6), (0.127, 0.635), (0.11, 0.72), (0.099, 0.775), (0.092, 0.7), (0.083, 0.62), (0.098, 0.54), (0.103, 0.5), (0.098, 0.4), (0.076, 0.285),
    (0.079, 0.22), (0.053, 0.07), (0.07, 0.02), (0.065, 0.0), (0.03, 0.0), (0.028, 0.06), (0.037, 0.2), (0.032, 0.28), (0.022, 0.42), (0.0, 0.47),
]

#: The channels drawn on the chart, schematic: for each view of the body, lines as (colour, points (x, height) on a
#: figure one unit tall, drawn on both sides unless on the midline) — and no more than a drawing of where they run.
CHART_FRONT = [
    ("acu-vermilion", [(0.0, 0.49), (0.0, 0.6), (0.0, 0.72), (0.0, 0.8), (0.0, 0.86)]),
    ("navy", [(0.022, 0.925), (0.03, 0.86), (0.045, 0.8), (0.04, 0.7), (0.03, 0.6), (0.05, 0.5), (0.068, 0.4), (0.057, 0.285), (0.052, 0.15), (0.05, 0.03)]),
    ("green", [(0.085, 0.795), (0.122, 0.71), (0.142, 0.615), (0.165, 0.515), (0.183, 0.425)]),
    ("acu-ink", [(0.034, 0.03), (0.035, 0.2), (0.04, 0.3), (0.03, 0.44), (0.04, 0.55), (0.055, 0.74)]),
]
CHART_BACK = [
    ("acu-vermilion", [(0.0, 0.5), (0.0, 0.62), (0.0, 0.75), (0.0, 0.86), (0.0, 0.94), (0.0, 0.99)]),
    ("navy", [(0.02, 0.94), (0.024, 0.83), (0.028, 0.7), (0.03, 0.56), (0.055, 0.45), (0.056, 0.285), (0.05, 0.12), (0.058, 0.03)]),
    ("navy", [(0.052, 0.8), (0.054, 0.68), (0.056, 0.57)]),
    ("green", [(0.1, 0.812), (0.138, 0.71), (0.158, 0.61), (0.184, 0.51), (0.196, 0.415)]),
    ("acu-ink", [(0.046, 0.95), (0.088, 0.76), (0.09, 0.62), (0.1, 0.5), (0.086, 0.3), (0.066, 0.08)]),
]


@model("acu-meridian-chart")
def meridian_chart(k: Kit, eq):
    """A hanging scroll on its cord: a silk mount between two rosewood rods with brass ends, and on the paper
    the body from the front and from the back with the channels drawn in colour and their points as dots."""
    back = -0.034
    for y, r in ((2.0, 0.013), (0.86, 0.017)):
        k.cyl((0, y, back + 0.02), r, 0.86, "acu-rosewood", axis="x", seg=10)
        for x in (-0.44, 0.44):
            k.lathe([(r, 0), (r + 0.006, 0.006), (r + 0.006, 0.014), (0.0, 0.022)], (x - 0.006 if x < 0 else x - 0.016, y, back + 0.02), "acu-brass", axis="x", seg=10)
    k.hose([(-0.24, 2.008, back + 0.02), (-0.1, 2.032, back + 0.006), (0.0, 2.042, back + 0.002), (0.1, 2.032, back + 0.006), (0.24, 2.008, back + 0.02)], 0.0022, "acu-vermilion", seg=4, steps=2)
    k.cyl((0, 2.042, back + 0.006), 0.006, 0.012, "acu-brass", axis="z", seg=8)
    k.box((0, 1.43, back + 0.0125), (0.8, 1.125, 0.003), "acu-silk")
    k.box((0, 1.425, back + 0.0145), (0.7, 0.97, 0.002), "acu-linen")
    paper = back + 0.0155
    tone = k.paint("acu-figure", "acu-linen", color="#e2c8a4")
    height, base = 0.76, 1.0
    for cx, lines in ((-0.172, CHART_FRONT), (0.172, CHART_BACK)):
        outline = [(cx + x * height, base + y * height) for x, y in FIGURE_HALF] + [(cx - x * height, base + y * height) for x, y in reversed(FIGURE_HALF[1:-1])]
        k.panel(outline, paper, 0.0012, tone)
        z = paper + 0.0018
        for colour, pts in lines:
            for side in ((1,) if all(abs(x) < 1e-9 for x, _ in pts) else (1, -1)):
                line = [(cx + side * x * height, base + y * height, z) for x, y in pts]
                k.hose(line, 0.0017, colour, seg=3, steps=2)
                # the points along it
                for a, b in zip(line, line[1:]):
                    for t in (0.0, 0.5):
                        p = [a[i] + (b[i] - a[i]) * t for i in range(3)]
                        k.tube((p[0], p[1], z - 0.0006), (p[0], p[1], z + 0.0022), 0.0042, colour, seg=4)
    # the title down the right-hand edge — a column of characters, each a few brush strokes — and the seal under it;
    # a note down the left
    def character(x, y, size, strokes):
        for dx, dy, w, h in strokes:
            k.box((x + dx * size, y + dy * size, paper + 0.0004), (w * size, h * size, 0.0008), "acu-ink")

    kinds = (((0, 0.32, 0.9, 0.14), (0, -0.05, 0.7, 0.14), (0, -0.4, 1.0, 0.14), (0, -0.05, 0.14, 0.9)),
             ((-0.3, 0, 0.14, 1.0), (0.12, 0.3, 0.6, 0.14), (0.12, -0.1, 0.6, 0.14), (0.38, -0.05, 0.14, 0.8)),
             ((0, 0.38, 1.0, 0.14), (-0.25, -0.1, 0.14, 0.8), (0.25, -0.1, 0.14, 0.8), (0, -0.42, 0.8, 0.14)))
    for i in range(8):
        character(0.325, 1.86 - i * 0.036, 0.024, kinds[i % 3])
    k.box((0.325, 1.86 - 8 * 0.036 - 0.004, paper + 0.0004), (0.026, 0.026, 0.0008), "acu-vermilion")
    for i in range(7):
        character(-0.325, 1.19 - i * 0.022, 0.014, kinds[(i + 1) % 3])


# ------------------------------------------------------------------------------------------------
# the bronze figure
# ------------------------------------------------------------------------------------------------

@model("acu-meridian-model")
def meridian_model(k: Kit, eq):
    """A bronze acupuncture figure, half life-size, on a rosewood pedestal: standing, the arms a little out with
    the palms forward, a topknot; the channels engraved on it and their points picked out."""
    # the pedestal: a plinth, the shaft with a panel on each face, a top with a brass plate under the feet
    k.slab(rrect(0.4, 0.4, 0.012), 0.0, 0.07, "acu-rosewood", r=0.012, seg=2)
    k.box((0, 0.27, 0), (0.33, 0.4, 0.33), "acu-rosewood", r=0.006, seg=1)
    k.box((0, 0.27, 0), (0.23, 0.3, 0.336), "acu-walnut")
    k.box((0, 0.27, 0), (0.336, 0.3, 0.23), "acu-walnut")
    k.slab(rrect(0.39, 0.39, 0.012), 0.47, 0.04, "acu-rosewood", r=0.012, seg=2)
    k.slab(rrect(0.28, 0.28, 0.01), 0.51, 0.008, "acu-brass", r=0.002)
    k.box((0, 0.31, 0.169), (0.12, 0.05, 0.002), "acu-brass")

    bronze = "acu-bronze"
    dark = k.paint("acu-bronze-dark", "acu-bronze", color="#70491f", roughness=0.55)
    s, y0 = 0.5, 0.518           # half life-size, standing on the brass plate
    P = lambda x, y, z=0.0: (x * s, y0 + y * s, z * s)  # noqa: E731  (a point of a figure 1.72 m tall, feet at the origin)

    # the trunk, from the crotch to the root of the neck: (height, half-width, front, back), the shoulders its widest
    trunk = [(0.80, 0.07, 0.06, 0.07), (0.85, 0.14, 0.095, 0.1), (0.92, 0.17, 0.11, 0.118), (1.0, 0.158, 0.106, 0.104), (1.08, 0.142, 0.1, 0.094),
             (1.18, 0.152, 0.108, 0.1), (1.28, 0.172, 0.118, 0.108), (1.36, 0.19, 0.11, 0.108), (1.415, 0.198, 0.09, 0.098), (1.45, 0.14, 0.072, 0.085), (1.475, 0.062, 0.058, 0.066)]
    loft(k, [[(x * s, y0 + y * s, z * s) for x, y, z in oval(0, yy, 0, rx, fr, bk, n=20)] for yy, rx, fr, bk in trunk], bronze)
    # the neck and the head: a nose, ears, the hair drawn up into a topknot with a band round it
    loft(k, [[(x * s, y0 + y * s, z * s) for x, y, z in oval(0, yy, 0.004, r, r, r, n=12, power=2)] for yy, r in ((1.455, 0.052), (1.52, 0.047), (1.56, 0.05))], bronze)
    k.ball(P(0, 1.632, 0.008), 0.1 * s, bronze, seg=16, squash=(0.78, 1.05, 0.92))
    k.ball(P(0, 1.662, -0.008), 0.1 * s, dark, seg=14, squash=(0.8, 0.84, 0.94))
    k.ball(P(0, 1.62, 0.094), 0.014 * s, bronze, seg=8, squash=(0.75, 1.5, 1.0))
    for x in (-1, 1):
        k.ball(P(x * 0.078, 1.625, 0.004), 0.022 * s, bronze, seg=8, squash=(0.38, 1.3, 0.8))
    k.ball(P(0, 1.765, -0.02), 0.034 * s, dark, seg=10, squash=(1.0, 0.9, 1.0))
    k.cyl(P(0, 1.738, -0.018), 0.023 * s, 0.014 * s, "acu-brass", seg=10)

    lines = []      # what is inlaid: lines of points on the skin
    dots = []       # the points picked out: (point on the skin, outward direction)

    def draw_on(frames, radii, angle, stops):
        lines.append([on_limb(frames, radii, i, angle, 0.0003) for i in range(len(frames))])
        for i in stops:
            p, f, sd = frames[i]
            n = (f * math.cos(angle) + sd * math.sin(angle)).normalized()
            dots.append((on_limb(frames, radii, i, angle), tuple(n)))

    for side in (-1, 1):
        # a leg: ankle, calf, knee, thigh, hip — and a foot
        path = [P(side * 0.086, 0.07, 0.0), P(side * 0.087, 0.2, -0.004), P(side * 0.089, 0.34, -0.008), P(side * 0.091, 0.48, 0.004), P(side * 0.094, 0.6, 0.006), P(side * 0.096, 0.74, 0.004), P(side * 0.095, 0.86, 0.0)]
        radii = [r * s for r in (0.037, 0.047, 0.058, 0.052, 0.066, 0.08, 0.082)]
        rings, frames = limb(path, radii, n=14)
        loft(k, rings, bronze)
        k.ball(P(side * 0.09, 0.034, 0.05), 0.05 * s, bronze, seg=10, squash=(0.82, 0.62, 2.3))
        # (angles round a limb from its front towards the figure's left: `side` turns them to the outside)
        draw_on(frames, radii, side * 0.75, (0, 1, 2, 3, 5))          # down the front of the leg, to the outside
        draw_on(frames, radii, side * 1.6, (1, 3, 4, 6))              # down its side
        draw_on(frames, radii, math.pi, (1, 2, 3, 5))                 # down the back
        draw_on(frames, radii, side * -0.7, (0, 2, 4))                # up the inside, in front
        draw_on(frames, radii, side * -1.5, (0, 1, 3, 5))             # up the inside
        # an arm: shoulder, elbow, wrist — and the hand, the palm forward
        k.ball(P(side * 0.2, 1.385, 0.0), 0.058 * s, bronze, seg=10, squash=(0.9, 1.15, 0.95))
        path = [P(side * 0.205, 1.385, 0.0), P(side * 0.222, 1.25, -0.006), P(side * 0.245, 1.1, -0.01), P(side * 0.265, 0.97, 0.004), P(side * 0.285, 0.85, 0.02)]
        radii = [r * s for r in (0.05, 0.046, 0.04, 0.042, 0.029)]
        rings, frames = limb(path, radii, n=12)
        loft(k, rings, bronze)
        k.ball(P(side * 0.293, 0.757, 0.03), 0.05 * s, bronze, seg=12, squash=(0.8, 1.9, 0.32))
        k.tube(P(side * 0.322, 0.825, 0.03), P(side * 0.345, 0.765, 0.04), 0.012 * s, bronze, seg=6, r2=0.008 * s)
        draw_on(frames, radii, 0.0, (1, 2, 3, 4))                     # down the palmar side
        draw_on(frames, radii, side * 0.8, (1, 3, 4))
        draw_on(frames, radii, math.pi, (1, 2, 3, 4))                 # down the back of the arm
        draw_on(frames, radii, math.pi - side * 0.8, (1, 3, 4))

    # the lines of the trunk: on the midline in front and behind, and beside it
    def trunk_line(angle, y_from, y_to, stops):
        line = []
        for i in range(11):
            y = y_from + (y_to - y_from) * i / 10
            row = next(j for j in range(len(trunk) - 1) if trunk[j][0] <= y <= trunk[j + 1][0])
            a, b = trunk[row], trunk[row + 1]
            t = (y - a[0]) / (b[0] - a[0])
            rx, fr, bk = (a[q] + (b[q] - a[q]) * t for q in (1, 2, 3))
            e = 2 / 2.3
            c, sn = math.cos(angle), math.sin(angle)
            p = (math.copysign(abs(sn) ** e, sn) * (rx + 0.001), y, math.copysign(abs(c) ** e, c) * ((fr if c >= 0 else bk) + 0.001))
            line.append(P(*p))
            if i in stops:
                dots.append((P(*p), (sn, 0.0, c)))
        lines.append(line)

    trunk_line(0.0, 0.88, 1.44, (0, 2, 4, 6, 8, 10))
    trunk_line(math.pi, 0.9, 1.44, (0, 2, 4, 6, 8, 10))
    for side in (-1, 1):
        trunk_line(side * 0.38, 0.9, 1.4, (1, 3, 5, 7, 9))
        trunk_line(side * 0.8, 0.92, 1.36, (2, 5, 8))
        trunk_line(math.pi + side * 0.3, 0.9, 1.42, (1, 3, 5, 7, 9))
        trunk_line(math.pi + side * 0.62, 0.92, 1.38, (2, 5, 8))

    gilt = k.paint("acu-gilt", "acu-brass", color="#e6c877", metalness=0.25, roughness=0.5)
    for line in lines:
        k.hose(line, 0.0009, gilt, seg=3, steps=1)
    for p, n in dots:
        a, b = Vector(p) - Vector(n) * 0.001, Vector(p) + Vector(n) * 0.0014
        k.tube(tuple(a), tuple(b), 0.003, "acu-vermilion", seg=4)


# ------------------------------------------------------------------------------------------------
# on the desk, beside the couch
# ------------------------------------------------------------------------------------------------

@model("acu-pulse-cushion")
def pulse_cushion(k: Kit, eq):
    """A pulse cushion: a small firm pillow of red silk with gold piping and a roundel."""
    k.box((0, 0.033, 0), (0.205, 0.062, 0.108), "acu-vermilion", r=0.027, seg=3)
    k.slab(rrect(0.2075, 0.1105, 0.03), 0.0305, 0.005, "acu-brass", r=0.002)
    k.cyl((0, 0.0642, 0), 0.02, 0.0012, "acu-brass", seg=12)
    k.cyl((0, 0.0648, 0), 0.013, 0.0012, "acu-vermilion", seg=12)


@model("acu-heat-lamp")
def heat_lamp(k: Kit, eq):
    """A heat lamp on a wheeled stand: a five-star base on casters, a telescopic column with its clamp, the
    control box with a timer dial, the arm, and the round head with its plate, turned down and forwards."""
    cx, cz = 0.0, -0.1
    for i in range(5):
        a = math.radians(90 + i * 72)
        dx, dz = math.cos(a), math.sin(a)
        k.box((cx + dx * 0.125, 0.085, cz + dz * 0.125), (0.036, 0.026, 0.25), "coal", r=0.006, seg=1, rot=(0, 90 - math.degrees(a), 0))
        k.caster(cx + dx * 0.232, cz + dz * 0.232, r=0.026, stem=0.014, lite=True)
    k.cyl((cx, 0.1, cz), 0.045, 0.06, "coal", seg=14, bevel=0.008)
    k.cyl((cx, 0.58, cz), 0.019, 0.92, "chrome", seg=14)
    k.cyl((cx, 1.045, cz), 0.027, 0.045, "coal", seg=12, bevel=0.005)
    k.cyl((cx + 0.04, 1.045, cz), 0.007, 0.04, "chrome", axis="x", seg=8)
    k.ball((cx + 0.066, 1.045, cz), 0.013, "coal", seg=8)
    k.cyl((cx, 1.15, cz), 0.013, 0.2, "chrome", seg=12)
    # the control box on the column: a timer dial, a rocker switch, a lamp
    k.box((cx, 0.84, cz + 0.05), (0.13, 0.17, 0.07), "plastic", r=0.012, seg=2)
    k.cyl((cx - 0.02, 0.87, cz + 0.088), 0.03, 0.008, "white", axis="z", seg=16)
    k.cyl((cx - 0.02, 0.87, cz + 0.096), 0.02, 0.012, "coal", axis="z", seg=12, bevel=0.002)
    k.box((cx - 0.02, 0.882, cz + 0.1025), (0.004, 0.016, 0.002), "white")
    k.box((cx + 0.036, 0.875, cz + 0.087), (0.018, 0.028, 0.006), "ambulance-red", r=0.002, seg=1)
    k.cyl((cx + 0.036, 0.83, cz + 0.086), 0.005, 0.004, "led-green", axis="z", seg=8)
    k.box((cx - 0.02, 0.8, cz + 0.0855), (0.07, 0.022, 0.001), "paper")
    k.hose([(cx, 0.76, cz + 0.06), (cx + 0.03, 0.6, cz + 0.07), (cx + 0.02, 0.3, cz + 0.04), (cx + 0.06, 0.12, cz + 0.02), (cx + 0.12, 0.06, cz - 0.04)], 0.0042, "coal", seg=6, steps=3)
    # the arm, and the head on its yoke
    k.pipe([(cx, 1.235, cz), (cx, 1.27, cz + 0.03), (cx, 1.25, 0.2), (cx, 1.2, 0.235)], 0.0105, "chrome", bend=0.04, seg=8)
    k.ball((cx, 1.25, cz + 0.0), 0.016, "coal", seg=8)
    tilt = 24
    c, s = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
    hx, hy, hz = cx, 1.172, 0.27
    k.cyl((hx, hy, hz), 0.096, 0.07, "plastic", seg=24, bevel=0.012, rot=(tilt, 0, 0))
    k.cyl((hx, hy + 0.04 * c, hz + 0.04 * s), 0.05, 0.022, "plastic", seg=14, bevel=0.006, rot=(tilt, 0, 0))
    # (the head's own axis: down and forwards)
    down = (0.0, -c, -s)
    k.torus((hx + down[0] * 0.036, hy + down[1] * 0.036, hz + down[2] * 0.036), 0.092, 0.006, "chrome", seg=24, ring=6, rot=(tilt, 0, 0))
    k.cyl((hx + down[0] * 0.034, hy + down[1] * 0.034, hz + down[2] * 0.034), 0.08, 0.006, "acu-heat", seg=20, rot=(tilt, 0, 0))
    for off in (-0.045, 0.0, 0.045):
        half = math.sqrt(0.09 ** 2 - off ** 2)
        k.tube((hx + off, hy + down[1] * 0.043 - half * s, hz + down[2] * 0.043 + half * c), (hx + off, hy + down[1] * 0.043 + half * s, hz + down[2] * 0.043 - half * c), 0.0016, "chrome", seg=4)
    k.pipe([(hx - 0.05, hy + 0.05 * c, hz + 0.05 * s + 0.02), (hx - 0.05, hy + 0.085, hz + 0.05), (hx + 0.05, hy + 0.085, hz + 0.05), (hx + 0.05, hy + 0.05 * c, hz + 0.05 * s + 0.02)], 0.005, "coal", bend=0.015, seg=6)


# ------------------------------------------------------------------------------------------------
# the needling stations: a couch round a body the world draws, and what each step puts on its skin
# ------------------------------------------------------------------------------------------------

#: How far above the skin a mark lies: a body on a treatment couch breathes a millimetre deep (ClinicalCraft's
#: `breathOf`), and what the model puts on its skin does not move with it.
PROUD = 0.0013


def body_fit(type_id: str) -> dict:
    """Where the station's body is, as the pinned figure kit draws it (tools/figure-fit.mts): its sites on the
    skin, its head, how far it reaches."""
    path = HERE / "fit" / f"{type_id}.json"
    if not path.is_file():
        raise SystemExit(f"{type_id}: no tools/blender/fit/{type_id}.json — run `npx tsx tools/figure-fit.mts` first")
    return json.loads(path.read_text(encoding="utf-8"))


def skin_frame(site: dict):
    """A site's frame: where it is, the way out of the skin, the way up the body, the way across it."""
    p, n, up = Vector(site["p"]), Vector(site["n"]).normalized(), Vector(site["up"]).normalized()
    return p, n, up, n.cross(up).normalized()


def mark(k: Kit, site: dict) -> None:
    """A ring of skin marker round a site, 9 mm across, lying on the skin."""
    p, n, up, across = skin_frame(site)
    centre = p + n * PROUD
    ring = [centre + (up * math.cos(a) + across * math.sin(a)) * 0.0045 for a in (2 * math.pi * i / 10 for i in range(10))]
    k.hose([tuple(q) for q in ring + ring[:1]], 0.0007, "acu-marker", seg=4, steps=1)


def needle_in(k: Kit, site: dict) -> None:
    """A needle standing in a site — square to the skin, or tilted towards the head by the site's angle — as deep
    as its prescription says: what is left of the shaft above the skin, then the handle."""
    p, n, up, _ = skin_frame(site)
    tilt = math.radians(site.get("tiltDeg", 0))
    d = (n * math.cos(tilt) + up * math.sin(tilt)).normalized()
    out = NEEDLE_SHAFT - site["depthCm"] / 100
    # (the shaft starts under the skin: the skin moves a millimetre with each breath)
    needle(k, tuple(p - d * 0.004), tuple(p + d * (out + NEEDLE_HANDLE)))


def timer(k: Kit, x: float, z: float) -> None:
    """A small timer lying on the couch: a white body, its display lit, two buttons."""
    y = COUCH_TOP
    k.box((x, y + 0.011, z), (0.07, 0.022, 0.07), "plastic", r=0.008, seg=2)
    k.box((x, y + 0.0224, z - 0.012), (0.052, 0.001, 0.026), "screen-dark")
    for i in (-1.5, -0.5, 0.5, 1.5):
        k.box((x + i * 0.0105, y + 0.0232, z - 0.012), (0.006, 0.0008, 0.014), "led-green")
    for dx, m in ((-0.016, "blue"), (0.016, "ambulance-red")):
        k.cyl((x + dx, y + 0.0235, z + 0.018), 0.008, 0.003, m, seg=10)


def station(k: Kit, eq) -> None:
    """A needling station: the couch as the clinic's, without its own pillow — a pillow where this body's head
    lies if it is on its back — and, in layers the station's steps show, what stands on the body's skin: a
    mark round each site, a needle in each, a timer by the head while the needles are retained."""
    fit = body_fit(eq.id)
    couch_base(k, pillow=False)
    if fit["manikin"]["posture"] == "lying":
        low, z = fit["head"]["lowest"]
        # the head sinks a little into it
        pillow_at(k, z + 0.02, COUCH_TOP + 0.002, low + 0.006 - (COUCH_TOP + 0.002), depth=0.26)
    sites = fit["sites"].values()
    with k.layer("marks"):
        for site in sites:
            mark(k, site)
    with k.layer("needles"):
        for site in sites:
            needle_in(k, site)
    with k.layer("timer"):
        timer(k, 0.27, -0.875)


for _station in ("acu-needling-station-prone", "acu-needling-station-supine"):
    MODELS[_station] = station
