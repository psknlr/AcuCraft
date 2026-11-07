"""Builds the trunk's regional models from the HuBMAP Human Reference Atlas Visible Human Male united body.

    python3 tools/anatomy/fetch_hra.py          # once: downloads the pinned reference body (CC BY 4.0)
    python3 tools/anatomy/build_trunk.py        # writes content/regions/{chest,abdomen,upper-back,sacrum-buttock,neck-anterior}.json
                                                #   and tools/anatomy/derived/vh-male.json (the measurements used)

What comes from the reference body (imaging-derived, Visible Human Male): the skin's cross-sections (hence the
charts' u and v), the vertebral levels and spinous processes, the pelvis and femora, the larynx and trachea, and the
depths below the skin of the lungs (the pleura), heart, liver, spleen, kidneys, bowel, bladder, bones, aorta, venae
cavae, carotid and spinal cord, sampled by rays cast inward from the skin on a grid. What is schematic (absent from the
reference body or not separable in it): the ribs and intercostal spaces (placed from the sternal levels by standard
surface anatomy), the sternum, the scapulae, the split of the body wall into subcutaneous fat and muscle, the nerves,
the internal thoracic, femoral and inferior epigastric vessels, the jugular veins and the thyroid gland.
"""
import json
import math
import os
import sys

import numpy as np
from shapely.geometry import Point

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hra import Body, Section, r2, ray_hits, vertebra  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
CACHE = os.path.join(HERE, ".cache")
GLB = os.path.join(CACHE, "VH_M_United.glb")

HRA_SOURCE = {
    "title": "HuBMAP Human Reference Atlas 3D reference organs: Visible Human Male united body (CCF release v1.3)",
    "publisher": "HuBMAP consortium; data from the Visible Human Project (US National Library of Medicine)",
    "url": "https://github.com/hubmapconsortium/ccf-releases/tree/b036a91aaf7234f462b1249d4a5f4fb0e982f412/v1.3/models",
    "verified": True,
    "note": "CC BY 4.0. Kristen Browne, Heidi Schlehlein, Bruce W. Herr II, Ellen Quardokus, Andreas Bueckle, Katy Börner. HuBMAP CCF 3D Reference Object Library (humanatlas.io/3d-reference-library). Skin, vertebrae, pelvis, femora, larynx, trachea, lungs, heart, liver, spleen, kidneys, bowel, bladder, great vessels and spinal cord sampled from it.",
}
SCHEMATIC_SOURCE = {
    "title": "General regional and surface anatomy (standard anatomy texts)",
    "verified": False,
    "note": "For what the reference body does not contain (ribs and intercostal spaces, sternum, scapulae, nerves, peripheral vessels, the fat/muscle split of the body wall): topography only, no third-party geometry or images.",
}
REVIEW = {
    "status": "unreviewed",
    "reviewers": [],
    "notes": "Depths below the skin of the lungs, organs, bones and great vessels are measured on one reference body (a 38-year-old man of about 90 kg) and scaled to each patient by height and BMI; the rest is schematic. Not a guide to safe depths in real patients. Anatomical expert review is required before any teaching use.",
}
REFERENCE = {"heightCm": 183, "bmi": 27.8, "sex": "male", "body": "Visible Human Male (HuBMAP HRA v1.3 united body; reported 180 cm, about 90 kg; mesh height 183 cm)"}
LICENCE = "CC BY 4.0 (derived from the HuBMAP Human Reference Atlas: attribution required, see provenance); schematic parts CC0-1.0"

B = None
V = {}
X_MID = 0.0
M = {}
SKIN_NEIGHBOURS = []  # for each skin face, the faces sharing an edge with it


def load():
    global B, X_MID
    B = Body(GLB, "VH_M_")
    for n in ["cervical_vertebra_%d" % i for i in range(1, 8)] + ["thoracic_vertebra_%d" % i for i in range(1, 13)] + ["lumbar_vertebra_%d" % i for i in range(1, 6)]:
        V[n] = vertebra(B, n)
    X_MID = float(np.median([v["x"] for v in V.values()]))
    pats = {
        "skin": r"^skin$",
        "lung": r"bronchopulmonary_segment$",
        "heart": r"^heart_(left|right)_ventricle$|cardiac_atrium$",
        "liver": r"^liver_capsule$",
        "spleen": r"_surface_of_spleen$|^hilum_of_spleen$",
        "kidney": r"^kidney_capsule_[LR]$",
        "bowel": r"^(jejunum|ileum|caecum|ascending_colon|transverse_colon|descending_colon|sigmoid_colon|hepatic_flexure_of_colon|splenic_flexure_of_colon|duodenum_\w+|rectum)$",
        "bladder": r"^fundus_of_urinary_bladder_(dome|base1)$",
        "pancreas": r"^(head|neck|body|tail)_of_pancreas$|^uncinate_process_of_the_pancreas$",
        "aorta": r"^(ascending_aorta|aortic_arch|descending_aorta_[ab])$",
        "cava": r"^(inferior_vena_cava_[ab]|superior_vena_cava|brachiocephalic_vein_[LR])$",
        "vertebrae": r"_vertebra_\d+$|^sacrum$|^coccyx$",
        "pelvis": r"^(ilium|ischium|pubis)_compact_bone_[LR]$|^femur_[LR]$",
        "trachea": r"^trachea$",
        "larynx": r"^(thyroid_cartilage|cricoid_cartilage|hyoid)$",
        "carotid": r"^left_common_carotid_artery_[ab]$|^brachiocephalic_artery_[ab]$|^left_subclavian_artery_[ab]$",
        "cord": r"spinal_cord_segment$|segment_of_cervical_spinal_cord$",
    }
    for k, p in pats.items():
        M[k] = B.union(p)
    nb = [[] for _ in range(len(M["skin"].faces))]
    for a, b in M["skin"].face_adjacency:
        nb[a].append(b)
        nb[b].append(a)
    SKIN_NEIGHBOURS[:] = nb


def spine_z(y):
    pts = sorted((v["body_y"], v["body_z"]) for v in V.values())
    ys, zs = zip(*pts)
    return float(np.interp(y, ys, zs))


def trunk_clip(y):
    """Half-width (m) of the trunk where the arms touch it: the lungs' lateral extent plus the chest wall."""
    if y < 0.42:
        return None
    v = M["lung"].vertices
    band = v[np.abs(v[:, 1] - y) < 0.01]
    half = float(np.max(np.abs(band[:, 0] - X_MID))) if len(band) else 0.06
    return max(0.11, half + 0.06)


def level(name):
    return V[name]["body_y"]


def disc(a, b):
    return (V[a]["body_y"] + V[b]["body_y"]) / 2


class Chart:
    """A trunk chart from the anterior or posterior midline, with v = 0 at height y0 (m)."""

    def __init__(self, y0, anterior, inside=None, clip=None):
        self.y0 = y0
        self.anterior = anterior
        self.inside = inside
        self.clip = clip
        self._sections = {}

    def section(self, y):
        key = round(y, 4)
        if key not in self._sections:
            inside = self.inside(y) if self.inside else (X_MID, spine_z(y) + 0.04)
            s = Section(M["skin"], y, inside, self.clip(y) if self.clip else None)
            to_u, from_u = s.chart(X_MID, self.anterior)
            self._sections[key] = (s, to_u, from_u)
        return self._sections[key]

    def at(self, u_cm, v_cm):
        """The skin point at (u, v) and the inward normal of the skin there (in 3D: a perpendicular needle's path)."""
        y = self.y0 + v_cm / 100
        s, _, from_u = self.section(y)
        p, n = s.point_normal(from_u(u_cm / 100))
        point = np.array([p[0], y, p[1]])
        horizontal = np.array([n[0], 0.0, n[1]])
        _, _, tri = M["skin"].nearest.on_surface([point])
        normal = -M["skin"].face_normals[tri[0]]
        if np.dot(normal, horizontal) < 0:
            normal = -normal
        # average the face normal with its neighbours' for a smooth direction
        nb = SKIN_NEIGHBOURS[tri[0]]
        if nb:
            avg = -M["skin"].face_normals[[tri[0], *nb]].mean(axis=0)
            if np.dot(avg, horizontal) > 0:
                normal = avg
        normal = normal / np.linalg.norm(normal)
        if np.dot(normal, horizontal) < 0.5:  # a cut edge or a fold: keep to the section's normal
            normal = horizontal
        return point, normal

    def uv(self, x, y, z, axial=False):
        """Chart coordinates (cm) of a body point: its nearest skin point on this chart's half (or, `axial`, the skin
        straight in front of or behind it, as it is palpated), and the depth."""
        try:
            s, to_u, from_u = self.section(y)
        except (ValueError, IndexError):
            return None  # below the fork of the legs or outside the trunk: not on this chart
        if axial:
            sd, p = s._midline(x, self.anterior)
            return {"u": r2(to_u(sd) * 100, 0.1), "v": r2((y - self.y0) * 100, 0.1), "d": r2(abs(p[1] - z) * 100, 0.1)}
        best = None
        for k in range(0, 400):
            u = (k - 200) / 400 * s.length
            if abs(u) > s.length * 0.3:
                continue
            p, n = s.point_normal(from_u(u))
            d = math.hypot(p[0] - x, p[1] - z)
            if (best is None or d < best[0]) and np.dot([x - p[0], z - p[1]], n) > 0:
                best = (d, u)
        if best is None:
            return None  # no skin point of this section faces it
        d, u = best
        return {"u": r2(u * 100, 0.1), "v": r2((y - self.y0) * 100, 0.1), "d": r2(d * 100, 0.1)}

    def width(self, v_cm):
        """Half-circumference (cm) at a level: the farthest u on this chart."""
        s, _, _ = self.section(self.y0 + v_cm / 100)
        return s.length * 50

    def lateral_u(self, v_cm, sign):
        """u (cm) of the mid-axillary line: the most lateral skin point at a level."""
        s, to_u, _ = self.section(self.y0 + v_cm / 100)
        xs = np.array(s.poly.exterior.coords)
        i = int(np.argmax(xs[:, 0] * sign))
        return to_u(s.ring.project(Point(*xs[i]))) * 100


ORGANS = [
    # (mesh key, tissue, label, hazard, priority when several begin at the same depth)
    ("lung", "lung", "lung", None),
    ("heart", "organ", "heart", "critical"),
    ("liver", "organ", "liver", "critical"),
    ("spleen", "organ", "spleen", "critical"),
    ("kidney", "organ", "kidney", "critical"),
    ("aorta", "organ", "aorta", "critical"),
    ("cava", "organ", "vena cava", "critical"),
    ("cord", "organ", "spinal canal", "critical"),
    ("pancreas", "organ", "pancreas", "critical"),
    ("bowel", "organ", "peritoneal cavity and bowel", "caution"),
    ("bladder", "organ", "urinary bladder", "caution"),
    ("trachea", "organ", "trachea", "caution"),
    ("larynx", "organ", "larynx", "caution"),
    ("vertebrae", "bone", "vertebra", None),
    ("pelvis", "bone", "bone", None),
]


SAMPLES = [(0, 0), (0.6, 0), (-0.6, 0), (0, 0.6), (0, -0.6)]


_HITS = {}


def hits_at(chart, u, v, keys=None, max_cm=14):
    """Organs met along the inward normal: five rays round (u, v), the shallowest entry kept for each organ (a ray
    slipping between two meshes never hides an organ its neighbours meet)."""
    key_ = (id(chart), u, v, tuple(sorted(keys)) if keys else None, max_cm)
    if key_ in _HITS:
        return _HITS[key_]
    best = {}
    for du, dv in SAMPLES:
        try:
            origin, normal = chart.at(u + du, v + dv)
        except Exception:
            continue
        origin = origin + normal * 1e-4
        for key, tissue, label, hazard in ORGANS:
            if keys is not None and key not in keys:
                continue
            spans = ray_hits(M[key], origin, normal, max_cm)
            if spans and (key not in best or spans[0][0] < best[key]["from"]):
                best[key] = {"key": key, "tissue": tissue, "label": label, "hazard": hazard, "from": spans[0][0], "to": spans[0][1]}
    _HITS[key_] = sorted(best.values(), key=lambda h: h["from"])
    return _HITS[key_]


def median_wall(chart, us, vs, below):
    """The median measured body-wall thickness (cm) over a grid: the depth of the first organ met, where it is met
    within `below` cm. What a miss falls back on."""
    walls = []
    for v in vs:
        for u in us:
            try:
                h = hits_at(chart, u, v)
            except Exception:
                continue
            if h and h[0]["from"] < below:
                walls.append(h[0]["from"])
    return float(np.median(walls)) if walls else below / 2


CAVITY = {
    "lung": {"key": "lung", "tissue": "lung", "label": "lung", "hazard": None},
    "abdomen": {"key": "bowel", "tissue": "organ", "label": "peritoneal cavity and bowel", "hazard": "caution"},
}


def stack(hits, sub_fraction, default_wall=6.0, bone_cm=1.5, wall_label="muscle", cap=None, cavity=None, fill=None):
    """A layer stack from the skin to the first hit and beyond: skin, subcutaneous, wall muscle, then the organs.

    `cap`: the body wall is no thicker than this (where the reference body's posture or arms distort it, the organs
    are moved up to the cap); `cavity`: what lies under the wall when no ray met anything (the lung in the thorax,
    the peritoneal cavity in the abdomen) — the conservative reading of a miss."""
    if not hits and cavity:
        at = fill or cap or default_wall
        hits = [{**CAVITY[cavity], "from": at, "to": at + 5}]
    elif hits and cap and hits[0]["from"] > cap:
        if cavity and hits[0]["key"] == CAVITY[cavity]["key"]:
            hits = [{**hits[0], "from": cap}] + hits[1:]  # the cavity met first: it begins under the capped wall
        elif cavity:
            # the cavity begins under the capped wall; the organs stay at their measured depths
            hits = [{**CAVITY[cavity], "from": cap, "to": hits[0]["from"]}] + hits
        else:
            shift = hits[0]["from"] - cap
            hits = [{**h, "from": h["from"] - shift, "to": h["to"] - shift} for h in hits]
    first = hits[0]["from"] if hits else default_wall
    wall = max(0.6, first)
    sub = min(max(0.3, sub_fraction * (wall - 0.2)), wall - 0.45)
    layers = [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": r2(sub)}, {"tissue": "muscle", "thicknessCm": r2(max(0.2, wall - 0.2 - sub)), "label": wall_label}]
    depth = wall
    for h in hits[:3]:
        if h["from"] < depth - 0.05:
            continue
        if h["from"] > depth + 0.05:
            layers.append({"tissue": "fascia" if h["key"] in ("bowel", "bladder") else "muscle", "thicknessCm": r2(h["from"] - depth), "label": "deep tissue"})
            depth = h["from"]
        if h["tissue"] == "bone":
            layers.append({"tissue": "bone", "thicknessCm": bone_cm, "label": h["label"]})
            return layers
        if h["tissue"] == "lung":
            if any(l["tissue"] == "lung" for l in layers):
                continue
            layers.append({"tissue": "pleura", "thicknessCm": 0.05, "label": "parietal pleura"})
            layers.append({"tissue": "lung", "thicknessCm": r2(max(0.5, h["to"] - h["from"] - 0.05)), "label": "lung"})
            depth = h["to"]
            continue
        layer = {"tissue": h["tissue"], "thicknessCm": r2(max(0.5, h["to"] - h["from"])), "label": h["label"]}
        if h["hazard"]:
            layer["hazard"] = h["hazard"]
        layers.append(layer)
        depth = h["to"]
        if h["hazard"] == "critical":
            return layers
    return layers


def fill_gaps(chart, zones):
    """A zone whose rays met nothing, among neighbours that met the pleura, takes the shallowest neighbour's stack."""
    by = {(z["centre"]["u"], z["centre"]["v"]): z for z in zones}
    step_u = sorted({k[0] for k in by})
    step = min(b - a for a, b in zip(step_u, step_u[1:])) if len(step_u) > 1 else 2
    def pleura_depth(z):
        top = 0
        for l in z["layers"]:
            if l["tissue"] == "pleura" or l.get("hazard") == "critical":
                return top
            top += l["thicknessCm"]
        return None
    for (u, v), z in by.items():
        if pleura_depth(z) is not None or z["layers"][-1]["tissue"] == "bone" or hits_at(chart, u, v):
            continue
        around = [by.get((u + du * step, v + dv * step)) for du in (-1, 0, 1) for dv in (-1, 0, 1) if du or dv]
        deep = [n for n in around if n is not None and pleura_depth(n) is not None]
        if len(deep) >= 4:
            z["layers"] = min(deep, key=pleura_depth)["layers"]
    return zones


def grid_zones(chart, us, vs, rule, radius):
    zones = []
    for v in vs:
        for u in us:
            try:
                layers = rule(chart, u, v)
            except Exception:
                continue
            if layers is None:
                continue
            zones.append({"id": f"g{u:+g}{v:+g}".replace("+", "p").replace("-", "m").replace(".", "_"), "centre": {"u": u, "v": v}, "radiusCm": radius, "layers": layers})
    return fill_gaps(chart, zones)


def tube(chart, points3d, label, sid, kind, hazard, radius, consequence, uncertainty=0.4):
    path = [chart.uv(*p) for p in points3d]
    path = [p for p in path if p is not None]
    return {"id": sid, "label": label, "kind": kind, "hazard": hazard, "path": path, "radiusCm": radius, "uncertaintyCm": uncertainty, "consequence": consequence}


def centreline(mesh, y_from, y_to, n=6):
    pts = []
    for y in np.linspace(y_from, y_to, n):
        v = mesh.vertices[np.abs(mesh.vertices[:, 1] - y) < 0.004]
        if len(v) > 3:
            pts.append(v.mean(axis=0).tolist())
    return pts


ORDINAL = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh"}


def lm(id_, u, v, label, palpation=None):
    d = {"id": id_, "label": label, "at": {"u": r2(u, 0.1), "v": r2(v, 0.1)}}
    if palpation:
        d["palpation"] = palpation
    return d


def region(id_, title, chart_desc, urange, vrange, configurations, access, landmarks, segments, default_layers, zones, structures, description, notes):
    return {
        "schema": "acucraft/region@1",
        "id": id_,
        "version": "0.1.0",
        "title": title,
        "laterality": "midline",
        "chart": {"description": chart_desc, "uRange": urange, "vRange": vrange},
        "reference": REFERENCE,
        "configurations": configurations,
        "defaultConfiguration": configurations[0]["id"],
        "access": access,
        "landmarks": landmarks,
        "segments": segments,
        "tissue": {"layers": default_layers, "zones": zones},
        "structures": structures,
        "description": description,
        "provenance": {"kind": "imaging-derived", "sources": [HRA_SOURCE, SCHEMATIC_SOURCE], "licence": LICENCE, "review": REVIEW, "notes": notes},
    }


def seg(id_, label, a, b, cun):
    return {"id": id_, "label": label, "from": a, "to": b, "cun": cun, "source": {"title": "WHO Standard Acupuncture Point Locations in the Western Pacific Region (2008): proportional bone measurement", "verified": False}}


def write(obj):
    path = os.path.join(ROOT, "content", "regions", f"{obj['id']}.json")
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.relpath(path, ROOT)}: {len(obj['landmarks'])} landmarks, {len(obj['tissue']['zones'])} zones, {len(obj['structures'])} structures")


FRONT_ACCESS = [
    {"position": "supine", "configuration": "supine", "sides": ["left", "right", "midline"]},
    {"position": "supine-knee-flexed", "configuration": "supine", "sides": ["left", "right", "midline"]},
    {"position": "seated", "configuration": "upright", "sides": ["left", "right", "midline"]},
    {"position": "side-lying-left", "configuration": "supine", "sides": ["right", "midline"]},
    {"position": "side-lying-right", "configuration": "supine", "sides": ["left", "midline"]},
]
FRONT_CONFIGS = [{"id": "supine", "label": "lying on the back"}, {"id": "upright", "label": "sitting upright"}]
BACK_ACCESS = [
    {"position": "prone", "configuration": "prone", "sides": ["left", "right", "midline"]},
    {"position": "seated-forward", "configuration": "seated-forward", "sides": ["left", "right", "midline"]},
    {"position": "side-lying-left", "configuration": "side-lying", "sides": ["right", "midline"]},
    {"position": "side-lying-right", "configuration": "side-lying", "sides": ["left", "midline"]},
]
BACK_CONFIGS = [{"id": "prone", "label": "prone, a pillow under the abdomen"}, {"id": "seated-forward", "label": "seated, leaning forward"}, {"id": "side-lying", "label": "side-lying, hips and knees flexed"}]


def pair(id_, u, v, label, palpation=None):
    return [lm(f"{id_}-left", u, v, f"{label} (left)", palpation), lm(f"{id_}-right", -u, v, f"{label} (right)", palpation)]


# ---------------------------------------------------------------------------------------------------------------
# chest: v = 0 at the xiphisternal junction (the level of the body of T9), u from the anterior midline
# ---------------------------------------------------------------------------------------------------------------

def build_chest(out):
    y0 = level("thoracic_vertebra_9")
    ch = Chart(y0, anterior=True, clip=trunk_clip)
    notch = (disc("thoracic_vertebra_2", "thoracic_vertebra_3") - y0) * 100
    angle = (disc("thoracic_vertebra_4", "thoracic_vertebra_5") - y0) * 100
    cart = {1: notch - 2.2, **{k: angle - (k - 2) * angle / 5 for k in range(2, 8)}}
    ics_sternal = {k: (cart[k] + cart[k + 1]) / 2 for k in range(1, 7)}
    ics_sternal[7] = cart[7] - 2.0
    circ = 2 * ch.width(-2.0)  # below the axillae, where the arms are free of the trunk
    nipple_u = 0.105 * circ  # the nipple line (4 B-cun); the inter-nipple distance is about 21 % of the chest's circumference
    cun = nipple_u / 4
    out["chest"] = {"notch_v": notch, "angle_v": angle, "ics_sternal": ics_sternal, "circumference_cm": circ, "nipple_u": nipple_u, "cun_cm": cun}

    def ics_v(k, u):
        slope = 0.05 + 0.05 * (k - 1)
        return ics_sternal[k] - slope * max(0.0, abs(u) - 2.0)

    lines = {"2cun": 2 * cun, "4cun": 4 * cun, "5cun": 5 * cun, "6cun": 6 * cun}
    landmarks = [
        lm("xiphisternal-junction", 0, 0, "xiphisternal junction (sternocostal angle)", "The lower end of the body of the sternum, where the costal margins meet."),
        lm("suprasternal-notch", 0, notch, "suprasternal notch (jugular notch)", "The notch at the top of the manubrium, between the sternal ends of the clavicles."),
        lm("sternal-angle", 0, angle, "sternal angle", "The ridge between manubrium and body of the sternum; the second costal cartilage joins here."),
    ]
    for k in range(1, 7):
        landmarks.append(lm(f"midline-ics{k}", 0, ics_sternal[k], f"anterior median line at the level of the {ORDINAL[k]} intercostal space"))
    for k in range(1, 8):
        for name, u in lines.items():
            if k == 7 and name != "4cun":
                continue
            landmarks += pair(f"ics{k}-{name}", u, ics_v(k, u), f"{ORDINAL[k]} intercostal space, {name.replace('cun', ' B-cun')} lateral", "Count the ribs down from the second costal cartilage at the sternal angle.")
    for k in (4, 6):
        mal = ch.lateral_u(ics_v(k, 14), 1)
        landmarks += pair(f"ics{k}-mal", abs(mal), ics_v(k, abs(mal)), f"{ORDINAL[k]} intercostal space on the mid-axillary line")
        landmarks += pair(f"ics{k}-mal-ant1", abs(mal) - cun, ics_v(k, abs(mal) - cun), f"{ORDINAL[k]} intercostal space, 1 B-cun anterior to the mid-axillary line")
    landmarks += pair("nipple", nipple_u, ics_v(4, nipple_u), "nipple (in men; in women use the mid-clavicular line)")
    for name, u in lines.items():
        if name == "5cun":
            continue
        landmarks += pair(f"clavicle-inf-{name}", u, notch - (2.6 if name == "6cun" else 1.8), "inferior border of the clavicle" if name != "6cun" else "infraclavicular fossa, medial to the coracoid process")
    landmarks.sort(key=lambda l: l["id"])

    def rule(chart, u, v):
        if abs(u) <= 2.0 and -1 <= v <= notch:
            return [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 0.6}, {"tissue": "bone", "thicknessCm": 1.2, "label": "sternum"}]
        thoracic = v < notch - 0.5 and abs(u) < 24
        return stack(hits_at(chart, u, v), 0.4, wall_label="pectoral and intercostal muscles", cap=5.0, cavity="lung" if thoracic else None, fill=fill)

    us = [x for x in range(-24, 25, 2)]
    vs = [x for x in range(-8, int(notch) + 3, 2)]
    fill = median_wall(ch, us, vs, 5.0)
    out["chest"]["median_wall_cm"] = fill
    zones = grid_zones(ch, us, vs, rule, 1.5)
    ita = []
    for side, sign in (("left", 1), ("right", -1)):
        path = []
        for v in (notch - 1, angle, ics_sternal[4], ics_sternal[6], -1):
            h = hits_at(ch, sign * 3.0, v, keys={"lung", "heart"})
            wall = h[0]["from"] if h else 3.0
            path.append({"u": r2(sign * 3.0, 0.1), "v": r2(v, 0.1), "d": r2(max(1.2, wall - 0.4), 0.1)})
        ita.append({"id": f"internal-thoracic-artery-{side}", "label": f"internal thoracic artery and veins ({side})", "kind": "artery", "hazard": "critical", "path": path, "radiusCm": 0.2, "uncertaintyCm": 0.4, "consequence": "bleeding"})
    aorta = tube(ch, centreline(M["aorta"], level("thoracic_vertebra_4"), level("thoracic_vertebra_8"), 5), "ascending aorta and arch (behind the sternum)", "aorta", "artery", "critical", 1.3, "bleeding")
    default = [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 1.2}, {"tissue": "muscle", "thicknessCm": 2.0}, {"tissue": "pleura", "thicknessCm": 0.05}, {"tissue": "lung", "thicknessCm": 5}]
    write(region(
        "chest", "chest (anterior and lateral thorax)",
        "The front and sides of the thorax unrolled round a horizontal section of the skin. u: arc length (cm) from the anterior median line, positive towards the patient's LEFT, as far as the mid-axillary lines. v: height (cm) above the xiphisternal junction. d: depth below the skin along the inward normal (cm).",
        [-26, 26], [-9, round(notch + 4)], FRONT_CONFIGS, FRONT_ACCESS, landmarks,
        [seg("seg.sternum", "suprasternal notch to xiphisternal junction", "suprasternal-notch", "xiphisternal-junction", 9), seg("seg.nipples", "between the nipples", "nipple-right", "nipple-left", 8)],
        default, zones, ita + [aorta],
        "The anterior chest wall is skin, subcutaneous fat and breast tissue, pectoral and intercostal muscles over the ribs; the parietal pleura lies just inside it, closest in the intercostal spaces and where the wall is thin (slim build, laterally). Left of the lower sternum the heart lies directly behind the wall (the cardiac notch); low on the right the liver lies under the diaphragm behind the costodiaphragmatic recess. The internal thoracic vessels run about a finger's breadth lateral to the sternal edge. The sternum stops a perpendicular needle; a congenital sternal foramen may lie under CV17.",
        "Depth grid (2 cm): skin-to-pleura and skin-to-organ distances measured by rays on the reference body; the fat/muscle split of the wall, the sternum and the intercostal-space levels are schematic. Ribs are not modelled: every non-sternal location is treated as an intercostal space (the conservative case).",
    ))
    return ch


# ---------------------------------------------------------------------------------------------------------------
# abdomen: v = 0 at the centre of the umbilicus, u from the anterior midline
# ---------------------------------------------------------------------------------------------------------------

def symmetric(pair_):
    """A reference chart is symmetric: a bilateral landmark takes the mean of the two sides' |u| and v."""
    u = (abs(pair_["left"]["u"]) + abs(pair_["right"]["u"])) / 2
    v = (pair_["left"]["v"] + pair_["right"]["v"]) / 2
    d = (pair_["left"]["d"] + pair_["right"]["d"]) / 2
    return {"left": {"u": r2(u, 0.1), "v": r2(v, 0.1), "d": r2(d, 0.1)}, "right": {"u": r2(-u, 0.1), "v": r2(v, 0.1), "d": r2(d, 0.1)}}


def bone_point(pattern, key):
    v = B.union(pattern).vertices
    return v[np.argmax(key(v))]


def build_abdomen(out, chest):
    # the reference skin is smoothed (no navel): the umbilicus is placed at the level of the L3/L4 disc
    y_umb = disc("lumbar_vertebra_3", "lumbar_vertebra_4")
    ch = Chart(y_umb, anterior=True)
    xiph = (level("thoracic_vertebra_9") - y_umb) * 100
    pv = B.union(r"^pubis_compact_bone_[LR]$").vertices
    near = pv[np.abs(pv[:, 0] - X_MID) < 0.01]
    pub = near[np.argmax(near[:, 1])]
    pub_v = (pub[1] - y_umb) * 100
    asis = {s: bone_point(rf"^ilium_compact_bone_{c}$", lambda v: v[:, 2] * 3 + v[:, 1]) for s, c in (("left", "L"), ("right", "R"))}
    asis_uv = symmetric({s: ch.uv(*asis[s]) for s in asis})
    mcl = chest["nipple_u"]
    out["abdomen"] = {"umbilicus_y": y_umb, "xiphisternal_v": xiph, "pubic_v": pub_v, "asis": asis_uv, "mcl_u": mcl}
    l2 = (level("lumbar_vertebra_2") - y_umb) * 100
    landmarks = [
        lm("umbilicus", 0, 0, "centre of the umbilicus"),
        lm("xiphisternal-junction", 0, xiph, "xiphisternal junction"),
        lm("pubic-symphysis", 0, pub_v, "superior border of the pubic symphysis", "Feel down the midline to the upper edge of the pubic bones."),
        *pair("midclavicular", mcl, xiph, "mid-clavicular line at the costal margin"),
    ]
    for s, sign in (("left", 1), ("right", -1)):
        a = asis_uv[s]
        landmarks.append(lm(f"asis-{s}", a["u"], a["v"], f"anterior superior iliac spine ({s})", "The front end of the iliac crest."))
        landmarks.append(lm(f"mid-inguinal-{s}", a["u"] / 2 + sign * 1.5, (a["v"] + pub_v) / 2 - 1.5, f"mid-inguinal point at the inguinal crease ({s}), over the femoral artery", "Midway between the anterior superior iliac spine and the pubic symphysis; the femoral pulse."))
        mal = abs(ch.lateral_u(0, sign))
        landmarks.append(lm(f"rib11-tip-{s}", sign * (mal - 2), l2 + 2, f"free extremity of the eleventh rib ({s})"))
        landmarks.append(lm(f"rib12-tip-{s}", sign * (mal + 5), l2 - 1, f"free extremity of the twelfth rib ({s})"))
        landmarks.append(lm(f"lateral-umbilical-{s}", sign * (mal - 2), 0, f"lateral abdomen at the level of the umbilicus, below the eleventh rib ({s})"))
    landmarks.sort(key=lambda l: l["id"])

    def rule(chart, u, v):
        return stack(hits_at(chart, u, v), 0.5, wall_label="abdominal wall muscles", cap=wall, cavity="abdomen", fill=wall)

    us = [x * 2.5 for x in range(-12, 13)]
    vs = [x * 2.5 for x in range(int(pub_v // 2.5) - 1, int(xiph // 2.5) + 2)]
    # the peritoneal cavity begins under the wall: where no viscus is met at once (the stomach is absent from the
    # reference body), the wall is taken as the median measured over the abdomen
    wall = median_wall(ch, us, vs, 8.0)
    out["abdomen"]["median_wall_cm"] = wall
    zones = grid_zones(ch, us, vs, rule, 1.9)
    structures = [tube(ch, centreline(M["aorta"], level("lumbar_vertebra_4"), level("thoracic_vertebra_12"), 6), "abdominal aorta", "aorta", "artery", "critical", 1.1, "bleeding")]
    for s, sign in (("left", 1), ("right", -1)):
        mi = next(l for l in landmarks if l["id"] == f"mid-inguinal-{s}")["at"]
        structures.append({"id": f"femoral-artery-{s}", "label": f"femoral artery ({s})", "kind": "artery", "hazard": "critical", "path": [{"u": mi["u"], "v": mi["v"] + 1.5, "d": 3.0}, {"u": mi["u"], "v": mi["v"] - 1.0, "d": 2.2}], "radiusCm": 0.4, "uncertaintyCm": 0.4, "consequence": "bleeding"})
        structures.append({"id": f"femoral-vein-{s}", "label": f"femoral vein ({s})", "kind": "vein", "hazard": "critical", "path": [{"u": mi["u"] - sign * 1.2, "v": mi["v"] + 1.5, "d": 3.2}, {"u": mi["u"] - sign * 1.2, "v": mi["v"] - 1.0, "d": 2.4}], "radiusCm": 0.5, "uncertaintyCm": 0.4, "consequence": "bleeding"})
        structures.append({"id": f"femoral-nerve-{s}", "label": f"femoral nerve ({s})", "kind": "nerve", "hazard": "caution", "path": [{"u": mi["u"] + sign * 1.2, "v": mi["v"] + 1.5, "d": 3.2}, {"u": mi["u"] + sign * 1.2, "v": mi["v"] - 1.0, "d": 2.4}], "radiusCm": 0.3, "uncertaintyCm": 0.4, "consequence": "electric-sensation"})
        structures.append({"id": f"inferior-epigastric-{s}", "label": f"inferior epigastric artery ({s})", "kind": "artery", "hazard": "caution", "path": [{"u": mi["u"] - sign * 1.0, "v": mi["v"] + 2.0, "d": 3.0}, {"u": sign * 5.0, "v": 0.0, "d": 2.8}, {"u": sign * 4.0, "v": 8.0, "d": 2.5}], "radiusCm": 0.15, "uncertaintyCm": 0.5, "consequence": "haematoma"})
    default = [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 2.0}, {"tissue": "muscle", "thicknessCm": 1.5}, {"tissue": "organ", "thicknessCm": 5, "label": "peritoneal cavity and bowel", "hazard": "caution"}]
    write(region(
        "abdomen", "abdomen and groin",
        "The front and sides of the abdomen unrolled round a horizontal section of the skin. u: arc length (cm) from the anterior median line, positive towards the patient's LEFT, round to the posterior axillary lines. v: height (cm) above the centre of the umbilicus. d: depth below the skin along the inward normal (cm).",
        [-32, 32], [round(pub_v) - 4, round(xiph) + 3], FRONT_CONFIGS, FRONT_ACCESS, landmarks,
        [seg("seg.epigastric", "xiphisternal junction to the centre of the umbilicus", "xiphisternal-junction", "umbilicus", 8), seg("seg.hypogastric", "centre of the umbilicus to the superior border of the pubic symphysis", "umbilicus", "pubic-symphysis", 5), seg("seg.mcl", "between the mid-clavicular lines (the nipples)", "midclavicular-right", "midclavicular-left", 8)],
        default, zones, structures,
        "The abdominal wall is skin, a variable layer of subcutaneous fat and the rectus sheath and flat muscles; deep to it lies the peritoneal cavity with the bowel. Under the right costal margin the liver, under the left the spleen and stomach; behind the bowel, in the midline, the aorta and inferior vena cava; above the pubis a full bladder. In the groin the femoral nerve, artery and vein lie side by side (lateral to medial) under the inguinal crease, the artery at the mid-inguinal point; the inferior epigastric vessels run up behind the rectus muscles.",
        "Depth grid (2.5 cm): the wall's thickness and the depths of liver, spleen, kidneys, bowel, bladder, aorta and venae cavae are measured by rays on the reference body; the fat/muscle split of the wall and the groin vessels, nerve and inferior epigastric artery are schematic. The stomach is absent from the reference body: under the upper abdomen the first viscus measured may be the liver, pancreas or colon.",
    ))
    return ch


# ---------------------------------------------------------------------------------------------------------------
# upper back: v = 0 at the tip of the C7 spinous process, u from the posterior midline
# ---------------------------------------------------------------------------------------------------------------

def build_upper_back(out):
    c7 = V["cervical_vertebra_7"]
    y0 = c7["tip"][1]
    ch = Chart(y0, anterior=False, clip=trunk_clip)
    sp = {}
    for i in range(1, 13):
        sp[i] = (V[f"thoracic_vertebra_{i}"]["spinous_inferior_y"] - y0) * 100
    l1 = (V["lumbar_vertebra_1"]["spinous_inferior_y"] - y0) * 100
    out["upper_back"] = {"c7_tip_y": y0, "spinous_inferior_v": sp, "l1_v": l1}
    med = 7.0
    landmarks = [lm("c7-spinous", 0, 0, "tip of the spinous process of C7", "The most prominent spinous process at the base of the neck; it moves when the neck is flexed and extended.")]
    for i in range(1, 13):
        landmarks.append(lm(f"t{i}-spinous", 0, sp[i], f"inferior border of the spinous process of T{i}", "Count down from C7; T3 lies level with the medial ends of the scapular spines and T7 with the inferior angles of the scapulae (arms at the sides)."))
    landmarks += pair("scapula-medial", med, sp[4], "medial border of the scapula", "With the arms by the sides.")
    landmarks += pair("scapula-spine-medial", med + 0.5, sp[3], "medial end of the spine of the scapula")
    landmarks += pair("scapula-spine-mid", med + 6.5, sp[3] + 1.5, "midpoint of the spine of the scapula")
    landmarks += pair("scapula-inferior-angle", med + 2.5, sp[7], "inferior angle of the scapula")
    landmarks += pair("scapula-superior-angle", med + 0.8, sp[2] + 1.0, "superior angle of the scapula")
    landmarks.sort(key=lambda l: l["id"])

    def in_scapula(u, v):
        a, b, c = (med + 0.8, sp[2] + 1.0), (med + 2.5, sp[7]), (med + 10.0, sp[2] + 2.0)
        p = (abs(u), v)
        def side(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1, d2, d3 = side(p, a, b), side(p, b, c), side(p, c, a)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

    def rule(chart, u, v):
        hits = hits_at(chart, u, v)
        if abs(u) <= 1.2:
            cord = [h for h in hits if h["key"] == "cord"]
            canal = (cord[0]["from"] - 0.6) if cord else 5.0
            return [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 0.6}, {"tissue": "ligament", "thicknessCm": r2(max(1.0, canal - 0.8)), "label": "supraspinous and interspinous ligaments"}, {"tissue": "organ", "thicknessCm": 1.5, "label": "spinal canal (dura and spinal cord)", "hazard": "critical"}]
        layers = stack(hits, 0.25, wall_label="trapezius / rhomboids / erector spinae", cap=6.5, cavity="lung" if v > sp[12] + 2 and abs(u) < 20 else None, fill=fill)
        if in_scapula(u, v):
            first = sum(l["thicknessCm"] for l in layers[:3])
            bone_at = min(first - 0.3, 3.0)
            sub = layers[1]["thicknessCm"]
            return [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": sub}, {"tissue": "muscle", "thicknessCm": r2(max(0.4, bone_at - 0.2 - sub)), "label": "trapezius / infraspinatus / supraspinatus"}, {"tissue": "bone", "thicknessCm": 0.5, "label": "scapula"}]
        return layers

    us = list(range(-22, 23, 2))
    vs = list(range(int(sp[12]) - 2, 3, 2))
    fill = median_wall(ch, [u for u in us if abs(u) > 4], vs, 6.5)
    out["upper_back"]["median_wall_cm"] = fill
    zones = grid_zones(ch, us, vs, rule, 1.5)
    cord_pts = centreline(M["cord"], level("thoracic_vertebra_12"), level("thoracic_vertebra_1"), 8)
    structures = [
        tube(ch, cord_pts, "spinal cord in its dural sac", "spinal-cord", "organ", "critical", 0.9, "electric-sensation", 0.3),
        tube(ch, centreline(M["aorta"], level("thoracic_vertebra_12"), level("thoracic_vertebra_5"), 5), "descending thoracic aorta", "aorta-descending", "artery", "critical", 1.1, "bleeding"),
    ]
    default = [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 1.0}, {"tissue": "muscle", "thicknessCm": 3.5}, {"tissue": "pleura", "thicknessCm": 0.05}, {"tissue": "lung", "thicknessCm": 5}]
    write(region(
        "upper-back", "upper back (thoracic region)",
        "The back from the base of the neck to the twelfth thoracic vertebra, unrolled round a horizontal section of the skin. u: arc length (cm) from the posterior median line, positive towards the patient's LEFT. v: height (cm) above the tip of the C7 spinous process (negative below it). d: depth below the skin along the inward normal (cm).",
        [-24, 24], [round(sp[12]) - 3, 3], BACK_CONFIGS, BACK_ACCESS, landmarks,
        [seg("seg.scapulae", "between the medial borders of the scapulae", "scapula-medial-right", "scapula-medial-left", 6)],
        default, zones, structures,
        "Over the thoracic spine the skin, subcutaneous fat, trapezius, rhomboids and the erector spinae cover the laminae and transverse processes; lateral to them the ribs and intercostal spaces lie over the pleura and lung, which are reached at a few centimetres in a slim patient. The scapula covers the upper lateral back with the arms at the sides. In the midline, between the spinous processes, the ligaments lead to the spinal canal and the spinal cord. Points of the inner and outer bladder lines are needled obliquely towards the spine.",
        "Depth grid (2 cm): depths of the lungs, vertebrae, kidneys and spinal cord measured by rays on the reference body; the fat/muscle split, the ribs (not modelled: treated as intercostal spaces) and the scapula (a schematic bony plate) are schematic. Midline zones lead through the interspinous ligaments to the spinal canal (critical).",
    ))
    return ch


# ---------------------------------------------------------------------------------------------------------------
# sacrum and buttock: v = 0 at the level of the posterior superior iliac spines (S2), u from the posterior midline
# ---------------------------------------------------------------------------------------------------------------

def build_sacrum(out):
    psis = {}
    for s, c in (("left", "L"), ("right", "R")):
        v = B.parts[f"ilium_compact_bone_{c}"].vertices
        near = v[np.abs(v[:, 0] - X_MID) < 0.06]
        psis[s] = near[np.argmin(near[:, 2] - 0.3 * near[:, 1])]
    y0 = float((psis["left"][1] + psis["right"][1]) / 2)
    sac = B.parts["sacrum"].vertices
    coc = B.parts["coccyx"].vertices

    def inside(y):
        return (X_MID, float(sac[:, 2].mean()) + 0.06)

    ch = Chart(y0, anterior=False, inside=inside)
    mid = sac[np.abs(sac[:, 0] - X_MID) < 0.006]
    hiatus = mid[np.argmin(mid[:, 1])]
    tip = coc[np.argmin(coc[:, 1])]
    gt = {s: bone_point(rf"^femur_{c}$", (lambda sign: lambda v: sign * v[:, 0] + 2 * v[:, 1])(1 if c == "L" else -1)) for s, c in (("left", "L"), ("right", "R"))}
    asis = {s: bone_point(rf"^ilium_compact_bone_{c}$", lambda v: v[:, 2] * 3 + v[:, 1]) for s, c in (("left", "L"), ("right", "R"))}
    tub = {s: bone_point(rf"^ischium_compact_bone_{c}$", lambda v: -v[:, 1] - 0.5 * v[:, 2]) for s, c in (("left", "L"), ("right", "R"))}
    P = {"psis": symmetric({s: ch.uv(*psis[s], axial=True) for s in psis}), "hiatus": ch.uv(*hiatus, axial=True), "coccyx": ch.uv(*tip, axial=True), "trochanter": symmetric({s: ch.uv(*gt[s]) for s in gt}), "tuberosity": symmetric({s: ch.uv(*tub[s], axial=True) for s in tub})}
    out["sacrum"] = {"psis_y": y0, **P}
    hv = P["hiatus"]["v"]
    foramina = {1: (2.6, 2.4), 2: (2.4, 0.0), 3: (2.1, -2.2), 4: (1.8, -4.2)}
    back = 7.0  # the outer bladder line: 3 B-cun, as on the upper back (the medial borders of the scapulae are 6 B-cun apart)
    landmarks = [lm("sacral-hiatus", 0, hv, "sacral hiatus", "The gap at the lower end of the median sacral crest, between the sacral cornua."), lm("coccyx-tip", 0, P["coccyx"]["v"], "tip of the coccyx")]
    for k, (fu, fv) in foramina.items():
        landmarks.append(lm(f"sacral-crest-s{k}", 0, fv, f"median sacral crest at the level of the {ORDINAL[k]} posterior sacral foramen"))
        landmarks += pair(f"s{k}-foramen", fu, fv, f"{ORDINAL[k]} posterior sacral foramen", "Felt as a depression lateral to the median sacral crest; the second lies level with the posterior superior iliac spine.")
    landmarks += pair("outer-line-s1", back, foramina[1][1], "outer bladder line (3 B-cun lateral) at the level of the first sacral foramen")
    for s, sign in (("left", 1), ("right", -1)):
        for key, name, label in (("psis", "psis", "posterior superior iliac spine"), ("trochanter", "greater-trochanter", "prominence of the greater trochanter"), ("tuberosity", "ischial-tuberosity", "ischial tuberosity")):
            p = P[key][s]
            landmarks.append(lm(f"{name}-{s}", p["u"], p["v"], f"{label} ({s})"))
    asis_uv = symmetric({s: ch.uv(*asis[s]) for s in asis})
    for s in ("left", "right"):
        landmarks.append(lm(f"asis-{s}", asis_uv[s]["u"], asis_uv[s]["v"], f"anterior superior iliac spine ({s}), round the hip"))
    landmarks.sort(key=lambda l: l["id"])
    out["sacrum"]["asis"] = asis_uv

    def rule(chart, u, v):
        if abs(u) <= 5.0 and v <= 1.0:
            # the reference body lay supine: its buttocks are flattened and fused over the lower sacrum and coccyx,
            # so the midline from S2 down is schematic (thin tissue over the bone)
            return [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 0.9}, {"tissue": "ligament", "thicknessCm": 0.6, "label": "posterior sacral ligaments"}, {"tissue": "bone", "thicknessCm": 1.5, "label": "sacrum and coccyx"}]
        return stack(hits_at(chart, u, v), 0.45, wall_label="gluteal muscles and the posterior sacral ligaments", cap=7.0)

    us = list(range(-34, 35, 2))
    vs = list(range(int(P["coccyx"]["v"]) - 4, 9, 2))
    zones = grid_zones(ch, us, vs, rule, 1.5)
    for k, (fu, fv) in foramina.items():
        for sign, s in ((1, "left"), (-1, "right")):
            h = hits_at(ch, sign * fu, fv, keys={"vertebrae", "pelvis"})
            bone = min(h[0]["from"] if h else 2.5, 3.0) if k == 1 else 1.7
            zones.append({"id": f"s{k}-foramen-{s}", "centre": {"u": r2(sign * fu, 0.1), "v": fv}, "radiusCm": 0.6, "layers": [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": r2(max(0.4, 0.45 * (bone - 0.2)))}, {"tissue": "ligament", "thicknessCm": r2(max(0.3, 0.55 * (bone - 0.2))), "label": "posterior sacroiliac ligaments"}, {"tissue": "fascia", "thicknessCm": 2.0, "label": "posterior sacral foramen (sacral nerve root)"}, {"tissue": "organ", "thicknessCm": 3.0, "label": "pelvic cavity", "hazard": "caution"}]})
    structures = []
    def bone_depth(u, v):
        z = min(zones, key=lambda z: (z["centre"]["u"] - u) ** 2 + (z["centre"]["v"] - v) ** 2)
        top = 0
        for l in z["layers"]:
            if l["tissue"] == "bone":
                return top
            top += l["thicknessCm"]
        return top
    for s, sign in (("left", 1), ("right", -1)):
        g, t = gt[s], tub[s]
        a = (g + t) / 2 + np.array([0, 0, -0.012])
        notch = a + np.array([-sign * 0.02, 0.06, 0.0])
        low = a + np.array([0, -0.035, -0.003])
        nerve = tube(ch, [notch.tolist(), a.tolist(), low.tolist()], f"sciatic nerve ({s})", f"sciatic-nerve-{s}", "nerve", "caution", 0.6, "electric-sensation", 0.6)
        # it lies on the back of the ischium and the hip joint: a centimetre superficial to the bone of its zone
        nerve["path"] = [{**p, "d": r2(max(3.0, bone_depth(p["u"], p["v"]) - 1.0), 0.1)} for p in nerve["path"]]
        structures.append(nerve)
    default = [{"tissue": "skin", "thicknessCm": 0.2}, {"tissue": "subcutaneous", "thicknessCm": 2.0}, {"tissue": "muscle", "thicknessCm": 4.0, "label": "gluteal muscles"}, {"tissue": "bone", "thicknessCm": 1.5}]
    write(region(
        "sacrum-buttock", "sacrum, buttocks and hips",
        "The sacrum, buttocks and the sides of the hips unrolled round a horizontal section of the skin. u: arc length (cm) from the posterior median line, positive towards the patient's LEFT, round to the front of the hips. v: height (cm) above the level of the posterior superior iliac spines. d: depth below the skin along the inward normal (cm).",
        [-36, 36], [round(P["coccyx"]["v"]) - 6, 10], BACK_CONFIGS, BACK_ACCESS, landmarks,
        [seg("seg.back", "between the outer bladder lines (3 B-cun each side, as between the medial borders of the scapulae)", "outer-line-s1-right", "outer-line-s1-left", 6)],
        default, zones, structures,
        "Over the sacrum the skin and a thin layer of fat and ligaments lie on bone, with the four posterior sacral foramina in two rows either side of the median sacral crest (the second level with the posterior superior iliac spines); a needle in a foramen passes towards the sacral nerve roots and the pelvis. Lateral to the sacrum the thick gluteal muscles cover the ilium and the hip; the sciatic nerve leaves the pelvis below piriformis and runs down midway between the greater trochanter and the ischial tuberosity, several centimetres deep.",
        "Depth grid (2 cm): depths of the sacrum, ilium, femur, bowel and bladder measured by rays on the reference body; the sacral foramina (small zones), the fat/ligament split and the course of the sciatic nerve (anchored to the measured greater trochanter and ischial tuberosity) are schematic.",
    ))
    return ch


# ---------------------------------------------------------------------------------------------------------------
# front of the neck: v = 0 at the suprasternal notch, u from the anterior midline
# ---------------------------------------------------------------------------------------------------------------

def build_neck(out, chest):
    y0 = disc("thoracic_vertebra_2", "thoracic_vertebra_3")
    ch = Chart(y0, anterior=True)
    th = B.parts["thyroid_cartilage"].vertices
    prom = th[np.argmax(th[:, 2] - 2 * np.abs(th[:, 0] - X_MID))]
    cri = B.parts["cricoid_cartilage"].vertices
    cric = cri[np.argmax(cri[:, 2])]
    hy = B.parts["hyoid"].vertices
    hyo = hy[np.argmax(hy[:, 2] - 2 * np.abs(hy[:, 0] - X_MID))]
    P = {"prominence": ch.uv(*prom, axial=True), "cricoid": ch.uv(*cric, axial=True), "hyoid": ch.uv(*hyo, axial=True)}
    out["neck"] = {"notch_y": y0, **P}
    tv, cv, hv = P["prominence"]["v"], P["cricoid"]["v"], P["hyoid"]["v"]
    # the mandible is absent from the reference body: its angle is placed 3.5 cm above the body of the hyoid, and
    # the points "level with the angle of the mandible" share that one level
    jaw_v = hv + 3.5
    # the common carotid runs under the anterior border of sternocleidomastoid: the border follows the measured artery
    car_pts = [ch.uv(*p) for p in centreline(M["carotid"], y0 + 0.01, y0 + (tv + 1) / 100, 5) if p[0] > X_MID]
    car_pts = [p for p in car_pts if p]
    def carotid_u(v):
        pts = sorted((p["v"], abs(p["u"])) for p in car_pts)
        return float(np.interp(v, [a for a, _ in pts], [b for _, b in pts]))
    scm_t, scm_c = carotid_u(tv), carotid_u(cv)
    out["neck"]["carotid_u"] = {"thyroid": scm_t, "cricoid": scm_c}
    mcl = chest["nipple_u"]
    landmarks = [
        lm("suprasternal-notch", 0, 0, "suprasternal notch"),
        lm("thyroid-cartilage-superior", 0, tv, "superior border of the thyroid cartilage (laryngeal prominence)", "The Adam's apple; its upper notch."),
        lm("cricoid", 0, cv, "cricoid cartilage", "The firm ring below the thyroid cartilage."),
        lm("hyoid", 0, hv, "body of the hyoid bone"),
        *pair("midclavicular", mcl, 0.0, "mid-clavicular line at the clavicle"),
        *pair("scm-anterior-thyroid", scm_t, tv, "anterior border of sternocleidomastoid at the level of the thyroid cartilage, over the carotid pulse", "Turn the head against resistance to outline the muscle; the carotid pulse lies under its anterior border."),
        *pair("scm-posterior-thyroid", scm_t + 3.6, tv, "posterior border of sternocleidomastoid at the level of the thyroid cartilage"),
        *pair("scm-anterior-cricoid", scm_c, cv, "anterior border of sternocleidomastoid at the level of the cricoid"),
        *pair("scm-posterior-cricoid", scm_c + 3.6, cv, "posterior border of sternocleidomastoid at the level of the cricoid"),
        *pair("scm-heads", 2.6, 0.8, "lesser supraclavicular fossa between the sternal and clavicular heads of sternocleidomastoid"),
        *pair("greater-supraclavicular-fossa", mcl, 1.4, "greater supraclavicular fossa above the clavicle on the mid-clavicular line"),
        *pair("mandible-angle", 6.0, jaw_v, "angle of the mandible"),
        *pair("scm-posterior-angle", 8.4, jaw_v, "posterior border of sternocleidomastoid at the level of the angle of the mandible"),
    ]
    landmarks.sort(key=lambda l: l["id"])

    def rule(chart, u, v):
        return stack(hits_at(chart, u, v), 0.35, wall_label="platysma / strap muscles / sternocleidomastoid")

    us = [x * 1.5 for x in range(-9, 10)]
    vs = [x * 1.5 for x in range(-2, int(jaw_v // 1.5) + 2)]
    zones = grid_zones(ch, us, vs, rule, 1.1)
    car = centreline(M["carotid"], y0 + 0.01, y0 + (tv + 1) / 100, 5)
    car = [p for p in car if p[0] > X_MID]
    left = tube(ch, car, "common carotid artery (left)", "carotid-left", "artery", "critical", 0.4, "bleeding")
    # above the thyroid cartilage the carotid divides and the internal carotid runs up, deeper, to the skull base
    # (schematic continuation to the angle of the mandible)
    left["path"].append({"u": 4.2, "v": r2(jaw_v + 0.5, 0.1), "d": 3.2})
    left["label"] = "common and internal carotid artery (left)"
    right = {**left, "id": "carotid-right", "label": "common and internal carotid artery (right; mirrored from the left)", "path": [{**p, "u": -p["u"]} for p in left["path"]]}
    structures = [left, right]
    for s, sign in (("left", 1), ("right", -1)):
        src = left if s == "left" else right
        structures.append({"id": f"internal-jugular-{s}", "label": f"internal jugular vein ({s})", "kind": "vein", "hazard": "critical", "path": [{**p, "u": r2(p["u"] + sign * 1.1, 0.1)} for p in src["path"]], "radiusCm": 0.6, "uncertaintyCm": 0.4, "consequence": "bleeding"})
        structures.append({"id": f"thyroid-lobe-{s}", "label": f"thyroid gland, lateral lobe ({s})", "kind": "organ", "hazard": "caution", "path": [{"u": sign * 1.6, "v": 1.5, "d": 1.4}, {"u": sign * 1.8, "v": cv, "d": 1.3}], "radiusCm": 0.8, "uncertaintyCm": 0.4, "consequence": "bleeding"})
    structures.append(tube(ch, centreline(M["trachea"], y0 - 0.01, y0 + (cv - 0.5) / 100, 5), "trachea", "trachea", "organ", "critical", 0.9, "none", 0.3))
    default = [{"tissue": "skin", "thicknessCm": 0.15}, {"tissue": "subcutaneous", "thicknessCm": 0.5}, {"tissue": "muscle", "thicknessCm": 1.5}, {"tissue": "organ", "thicknessCm": 2.0, "label": "visceral column of the neck", "hazard": "caution"}]
    write(region(
        "neck-anterior", "front and sides of the neck",
        "The front of the neck unrolled round a horizontal section of the skin. u: arc length (cm) from the anterior median line, positive towards the patient's LEFT, back to the posterior border of sternocleidomastoid. v: height (cm) above the suprasternal notch. d: depth below the skin along the inward normal (cm).",
        [-14, 14], [-3, round(jaw_v) + 3], FRONT_CONFIGS, FRONT_ACCESS, landmarks,
        [seg("seg.neck-mcl", "between the mid-clavicular lines (as between the nipples)", "midclavicular-right", "midclavicular-left", 8)],
        default, zones, structures,
        "In the midline the trachea lies a centimetre or two below the skin above the suprasternal notch, with the thyroid isthmus over its upper rings and the great vessels behind the manubrium below. Either side, under the anterior border of sternocleidomastoid, the common carotid artery (pulsating) and lateral to it the internal jugular vein lie in the carotid sheath. Above the medial clavicle the dome of the pleura rises into the root of the neck.",
        "Depth grid (1.5 cm): depths of the trachea, larynx, cervical vertebrae, lung apices and great vessels measured by rays on the reference body; the left common carotid artery is measured and the right mirrored from it; the jugular veins, thyroid lobes and the borders of sternocleidomastoid are schematic.",
    ))
    return ch


def main():
    if not os.path.exists(GLB):
        sys.exit("reference body missing: run python3 tools/anatomy/fetch_hra.py first")
    load()
    out = {"body": REFERENCE["body"], "vertebrae": {k: {kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in V.items()}, "x_mid": X_MID}
    build_chest(out)
    build_abdomen(out, out["chest"])
    build_upper_back(out)
    build_sacrum(out)
    build_neck(out, out["chest"])
    os.makedirs(os.path.join(HERE, "derived"), exist_ok=True)
    with open(os.path.join(HERE, "derived", "vh-male.json"), "w") as f:
        json.dump(out, f, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    print("wrote tools/anatomy/derived/vh-male.json")


if __name__ == "__main__":
    main()
