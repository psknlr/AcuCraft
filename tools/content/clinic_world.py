"""The simulated TCM clinic as a navigable world (authoring script; the JSON it writes is the content).

Writes, in ClinicalCraft's own formats (docs/FACILITIES.md in ClinicalCraft), so that ClinicalCraft's front-ends can
load the clinic through `contentDirs` and AcuCraft's engine plans walks through the same rooms:

  content/world/catalogs/acucraft-tcm.json          clinicalcraft/equipment-catalog@1   TCM equipment types and materials
  content/world/templates/acu-*.json                clinicalcraft/room-template@1       consultation, treatment, preparation, skills
  content/world/facilities/sg-tcm-outpatient.json   clinicalcraft/facility@1            the clinic
  content/world/facilities/sg-tcm-skills-room.json  clinicalcraft/facility@1            the skills room (needling stations)
  content/sg/clinic.json                            acucraft/clinic@1                   rooms, fixtures → placements

Units are metres; +Z is south; an equipment type's front faces +Z at `rot: 0`. The navigation grid has 0.5 m cells
from the facility bounds (whole numbers here), and a cell is free when its centre is 0.38 m clear of every solid
footprint. The treatment couch is 0.7 m wide and centred on a grid line so that the cells beside it are free: the
practitioner stands 0.75 m from its centre line on either side (docs/WORLD.md).

**The clinic's solid furniture is the engine's floor plan.** Nothing solid may be added to, moved in or taken from
the clinic's three rooms without the walks of every reference trajectory being planned again: what this script adds
to them is drawn only (`solid: False`), and people are never obstacles.

Each type's voxel parts are its fallback drawing and what ClinicalCraft's floor-plan tools read (the part named
`mattress` or `seat` is where a patient lies or sits); the world draws the type's model — built in Blender by
tools/blender/build.py, whose references (tools/blender/models.json) this script puts into the catalog
(docs/MODELS.md). The two needling stations have a body the world draws with its own figure kit (`manikin`) and a
look for each step of the drill (`behavior.states.<id>.look`).

    python3 tools/content/clinic_world.py
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import ROOT, dump

WORLD = os.path.join(ROOT, "content", "world")
MODELS = os.path.join(ROOT, "tools", "blender", "models.json")
FACILITY_ID = "sg-tcm-outpatient"
SKILLS_ID = "sg-tcm-skills-room"

def L(en, zh):
    return {"zh-CN": zh, "en": en}

def part(m, p, s, **extra):
    o = {"m": m, "p": [round(x, 4) for x in p], "s": [round(x, 4) for x in s]}
    o.update(extra)
    return o

# ---------------------------------------------------------------------------------------------------------
# Materials of the pack (ClinicalCraft's palette has the rest: wood, steel, chrome, paper, rubber …)
# ---------------------------------------------------------------------------------------------------------

def M(id, color, pattern="flat", variance=0.03, **extra):
    return {"id": id, "color": color, "pattern": pattern, "variance": variance, **extra}

MATERIALS = [
    M("acu-jade", "#7fae9b", roughness=0.55),                                  # the vinyl of the couch and the chairs
    M("acu-beech", "#c9a877", "plank", 0.05, roughness=0.6),                   # couch and chair frames
    M("acu-rosewood", "#5c3526", "plank", 0.06, roughness=0.5),                # the herb cabinet, pedestals, scroll rods
    M("acu-walnut", "#7b5237", "plank", 0.05, roughness=0.55),                 # drawer fronts
    M("acu-brass", "#c7a558", roughness=0.35, metalness=0.9),                  # drawer pulls, scroll knobs
    M("acu-bronze", "#a26f3b", variance=0.05, roughness=0.42, metalness=0.85), # the acupuncture figure
    M("acu-copper", "#b9733f", roughness=0.4, metalness=0.9),                  # a needle's wound handle
    M("acu-vermilion", "#b53a2b", roughness=0.7),                              # the pulse cushion, seals, point dots
    M("acu-ink", "#2a2826", variance=0.02, roughness=0.8),                     # ink lines of a chart
    M("acu-linen", "#efe9d8", roughness=0.9),                                  # scroll paper, pillow covers
    M("acu-silk", "#c9b88a", roughness=0.65),                                  # a scroll's mount
    M("acu-terry", "#f3f1ea", variance=0.04, roughness=0.95),                  # towels
    M("acu-marker", "#5a3c8e", variance=0.02, roughness=0.7),                  # a skin marker's violet
    M("acu-sharps", "#efc531", roughness=0.5),                                 # a sharps container
    M("acu-heat", "#3a2622", variance=0.02, roughness=0.85, emissive="#ff5a2a", emissiveIntensity=0.35),  # a heat lamp's plate
    M("acu-timber", "#c2a47c", "plank", 0.03, roughness=0.7, castShadow=False),  # a warm floor
    M("acu-dado", "#a9c3b6", variance=0.025, roughness=0.8),                   # the painted lower course of a wall
    M("acu-ceiling", "#eceee6", "tile", 0.02, roughness=0.9),                  # ceiling tiles
]

# ---------------------------------------------------------------------------------------------------------
# Equipment (voxel parts: `p` the box centre, `s` its size; origin = footprint centre on the floor)
# ---------------------------------------------------------------------------------------------------------

COUCH_TOP = 0.67          # the upholstery's top: where a body lies (the part named "mattress")
FACE_HOLE_Z = -0.765      # the middle of the breathing hole, from the couch's middle (the head end is −Z)

def couch_parts(pillow=True):
    """A wooden treatment couch 0.7 × 1.9 m: four legs, an apron, a shelf for towels, the padded top in two
    sections — the head section with the breathing hole — and a paper sheet."""
    parts = []
    for sx in (0.29, -0.29):
        for sz in (0.80, -0.80):
            parts.append(part("acu-beech", [sx, 0.28, sz], [0.06, 0.52, 0.06]))
            parts.append(part("rubber", [sx, 0.01, sz], [0.05, 0.02, 0.05]))
    parts += [
        part("acu-beech", [0.29, 0.535, 0], [0.03, 0.09, 1.54]), part("acu-beech", [-0.29, 0.535, 0], [0.03, 0.09, 1.54]),
        part("acu-beech", [0, 0.535, 0.80], [0.52, 0.09, 0.03]), part("acu-beech", [0, 0.535, -0.80], [0.52, 0.09, 0.03]),
        part("acu-beech", [0, 0.2, 0], [0.56, 0.02, 1.56]),
        part("acu-terry", [0, 0.27, 0.42], [0.34, 0.12, 0.3]),
        part("acu-jade", [0, 0.625, 0.175], [0.7, 0.09, 1.55], name="mattress"),
        # the head section, with the breathing hole a prone patient's face rests over
        part("acu-jade", [0.2125, 0.625, -0.78], [0.275, 0.09, 0.34]), part("acu-jade", [-0.2125, 0.625, -0.78], [0.275, 0.09, 0.34]),
        part("acu-jade", [0, 0.625, -0.9], [0.15, 0.09, 0.1]), part("acu-jade", [0, 0.625, -0.645], [0.15, 0.09, 0.07]),
        part("coal", [0, 0.6, FACE_HOLE_Z], [0.15, 0.04, 0.17]),
        part("paper", [0, 0.6715, 0.19], [0.56, 0.003, 1.5]),
    ]
    if pillow:
        parts.append(part("acu-linen", [0, 0.7, -0.59], [0.4, 0.055, 0.22]))
    return parts

def couch():
    return {
        "id": "acu-treatment-couch", "name": L("Acupuncture couch", "针灸治疗床"), "category": "furniture",
        "description": L("A padded treatment couch 0.7 m wide on a beech frame, with a breathing hole in its head section, a paper cover and a shelf of towels: narrow enough to work from either side.", "榉木架软垫针灸治疗床，宽 0.7 米，头段带呼吸孔，铺一次性床单，下层搁放毛巾：两侧均可操作。"),
        "usage": L("The patient lies supine, prone or on one side with the head at the end with the breathing hole. Stand at the side you are needling: a point on the far side of the body is out of arm's reach.", "患者头朝呼吸孔一端，仰卧、俯卧或侧卧。站在所针刺的一侧操作：对侧的穴位够不着。"),
        "capabilities": [], "footprint": {"w": 0.7, "d": 1.9, "h": 0.75}, "solid": True, "parts": couch_parts(),
        "interaction": {"kind": "bed", "prompt": L("E · Acupuncture couch", "E · 针灸治疗床")}, "screen": "none",
        "tags": ["bed", "patient-support", "acupuncture", "tcm"],
    }

def trolley():
    parts = []
    for sx in (0.27, -0.27):
        for sz in (0.195, -0.195):
            parts.append(part("chrome", [sx, 0.47, sz], [0.03, 0.82, 0.03]))
            parts.append(part("rubber", [sx, 0.03, sz], [0.06, 0.06, 0.06]))
    parts += [
        part("steel", [0, 0.3, 0], [0.56, 0.03, 0.41]),
        part("steel", [0, 0.88, 0], [0.58, 0.03, 0.43]),
        part("chrome", [0, 0.92, 0.2075], [0.58, 0.05, 0.015]),
        part("chrome", [0, 0.92, -0.2075], [0.58, 0.05, 0.015]),
        # the tray an opened pack's needles lie on, and sealed packs
        part("chrome", [-0.02, 0.905, -0.08], [0.2, 0.02, 0.13]),
        part("blue", [-0.2, 0.915, 0.08], [0.1, 0.04, 0.14]),
        part("white", [-0.08, 0.915, 0.08], [0.1, 0.04, 0.14]),
        part("paper", [0.05, 0.905, 0.1], [0.12, 0.02, 0.1]),
        # the sharps box, at the point of use
        part("acu-sharps", [0.2, 0.975, -0.09], [0.15, 0.16, 0.16]),
        part("biohazard", [0.2, 1.065, -0.09], [0.16, 0.02, 0.17]),
        part("black", [0.2, 1.0775, -0.08], [0.07, 0.005, 0.05]),
        part("white", [0.2, 0.935, 0.12], [0.07, 0.08, 0.07]),
        part("mint", [-0.12, 0.345, 0.02], [0.2, 0.06, 0.14]),
        part("white", [0.14, 0.355, -0.03], [0.16, 0.08, 0.2]),
    ]
    return {
        "id": "acu-needle-trolley", "name": L("Needle trolley", "针具治疗车"), "category": "therapy",
        "description": L("A stainless treatment trolley at the foot of the couch: the tray for an opened pack of needles, sealed packs, a jar of cotton balls, forceps, hand rub, and a sharps box at the point of use.", "治疗床尾的不锈钢治疗车：放置已开封针具的托盘、未开封的针具、棉球罐、镊子筒、手消毒液，以及随用随弃的锐器盒。"),
        "usage": L("Open a sealed pack onto its tray, take one needle at a time, and drop every withdrawn or unused opened needle into its sharps box.", "在托盘上开封针具，逐根取用；起出的针和已开封未用的针一律投入锐器盒。"),
        "capabilities": [], "footprint": {"w": 0.6, "d": 0.45, "h": 1.1}, "solid": True, "parts": parts,
        "interaction": {"kind": "storage", "prompt": L("E · Needle trolley", "E · 针具治疗车")}, "screen": "none",
        "tags": ["trolley", "sharps", "acupuncture", "tcm"],
    }

def shelf():
    parts = [part("white", [0, 0.95, -0.21], [1.2, 1.9, 0.03]), part("white", [0.585, 0.95, 0], [0.03, 1.9, 0.45]), part("white", [-0.585, 0.95, 0], [0.03, 1.9, 0.45])]
    for y in (0.1, 0.55, 1.0, 1.45, 1.885):
        parts.append(part("white", [0, y, 0.005], [1.14, 0.03, 0.42]))
    for i, m in enumerate(["blue", "white", "blue", "paper", "mint"]):
        parts.append(part(m, [-0.4 + 0.2 * i, 0.635, 0.04], [0.16, 0.14, 0.2]))
    for i, m in enumerate(["white", "blue", "white", "mint"]):
        parts.append(part(m, [-0.36 + 0.24 * i, 1.085, 0.04], [0.2, 0.14, 0.22]))
    for i, m in enumerate(["glass", "glass", "white"]):
        parts.append(part(m, [-0.3 + 0.3 * i, 1.54, 0.05], [0.12, 0.15, 0.12]))
    parts.append(part("beige", [0.05, 0.19, 0.03], [0.5, 0.15, 0.3]))
    return {
        "id": "acu-supply-shelf", "name": L("Needle and supply shelf", "针具耗材架"), "category": "storage",
        "description": L("Open shelving for sealed packs of single-use sterile needles, alcohol swabs, cotton balls, gloves and plasters.", "开放式耗材架：一次性无菌针灸针（未开封）、酒精棉片、棉球、手套和敷贴。"),
        "usage": L("Fetch sealed packs here, with clean hands; check the expiry date on the label before opening one.", "手卫生后在此取未开封的针具；开封前核对包装上的有效期。"),
        "capabilities": [], "footprint": {"w": 1.2, "d": 0.45, "h": 1.9}, "solid": True, "parts": parts,
        "interaction": {"kind": "storage", "prompt": L("E · Supply shelf", "E · 耗材架")}, "screen": "none",
        "tags": ["storage", "supplies", "acupuncture", "tcm"],
    }

def herb_cabinet():
    parts = [part("acu-rosewood", [0, 0.87, -0.015], [1.6, 1.74, 0.42]), part("acu-rosewood", [0, 0.04, 0], [1.6, 0.08, 0.45])]
    for row in range(6):
        y = 0.3 + row * 0.24
        for col in range(7):
            parts.append(part("acu-walnut", [-0.63 + col * 0.21, y, 0.205], [0.19, 0.2, 0.02]))
        parts.append(part("acu-brass", [0, y, 0.2185], [1.3, 0.02, 0.012]))
    parts += [part("white", [-0.5, 1.82, 0], [0.16, 0.16, 0.16]), part("blue", [0.0, 1.81, 0], [0.14, 0.14, 0.14]), part("white", [0.5, 1.82, 0], [0.16, 0.16, 0.16])]
    return {
        "id": "acu-herb-cabinet", "name": L("Herbal medicine cabinet", "中药百子柜"), "category": "storage",
        "description": L("A traditional rosewood cabinet of small labelled drawers for dried herbs, with storage jars on top.", "传统红木中药饮片柜（百子柜），抽屉分格存放饮片，柜顶放药罐。"),
        "capabilities": [], "footprint": {"w": 1.6, "d": 0.45, "h": 1.9}, "solid": True, "parts": parts,
        "interaction": {"kind": "storage", "prompt": L("E · Herb cabinet", "E · 百子柜")}, "screen": "none",
        "tags": ["storage", "tcm", "decor"],
    }

def meridian_chart():
    z = -0.02
    parts = [
        part("acu-rosewood", [0, 2.0, z], [0.86, 0.04, 0.03]), part("acu-rosewood", [0, 0.86, z], [0.86, 0.04, 0.03]),
        part("acu-silk", [0, 1.43, z - 0.008], [0.82, 1.12, 0.008]),
        part("acu-linen", [0, 1.43, z - 0.003], [0.72, 1.0, 0.006]),
        part("skin", [-0.18, 1.83, z + 0.004], [0.07, 0.09, 0.004]), part("skin", [-0.18, 1.6, z + 0.004], [0.15, 0.32, 0.004]),
        part("skin", [-0.215, 1.22, z + 0.004], [0.06, 0.44, 0.004]), part("skin", [-0.145, 1.22, z + 0.004], [0.06, 0.44, 0.004]),
        part("skin", [0.18, 1.83, z + 0.004], [0.07, 0.09, 0.004]), part("skin", [0.18, 1.6, z + 0.004], [0.15, 0.32, 0.004]),
        part("skin", [0.145, 1.22, z + 0.004], [0.06, 0.44, 0.004]), part("skin", [0.215, 1.22, z + 0.004], [0.06, 0.44, 0.004]),
        part("acu-vermilion", [-0.18, 1.56, z + 0.008], [0.006, 0.36, 0.003]), part("blue", [0.18, 1.56, z + 0.008], [0.006, 0.36, 0.003]),
    ]
    return {
        "id": "acu-meridian-chart", "name": L("Meridian and acupoint chart", "经络腧穴挂图"), "category": "teaching",
        "description": L("A hanging scroll of the channels and their points, the body drawn from the front and from the back. A schematic drawing: it does not locate a point.", "经络与腧穴挂轴，绘有人体正面与背面。示意图，不能据此定位腧穴。"),
        "capabilities": [], "footprint": {"w": 0.9, "d": 0.05, "h": 2.05}, "solid": False, "parts": parts,
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["wall", "tcm", "teaching", "decor"],
    }

def meridian_model():
    parts = [
        part("acu-rosewood", [0, 0.25, 0], [0.36, 0.5, 0.36]), part("acu-brass", [0, 0.51, 0], [0.3, 0.02, 0.3]),
        part("acu-bronze", [0.05, 0.75, 0], [0.07, 0.46, 0.08]), part("acu-bronze", [-0.05, 0.75, 0], [0.07, 0.46, 0.08]),
        part("acu-bronze", [0, 1.13, 0], [0.2, 0.32, 0.12]), part("acu-bronze", [0.14, 1.1, 0], [0.05, 0.36, 0.06]), part("acu-bronze", [-0.14, 1.1, 0], [0.05, 0.36, 0.06]),
        part("acu-bronze", [0, 1.37, 0], [0.11, 0.14, 0.12]),
    ]
    for (x, y) in [(0.04, 1.2), (-0.04, 1.2), (0.0, 1.05), (0.05, 0.85), (-0.05, 0.85), (0.05, 0.65), (-0.05, 0.65)]:
        parts.append(part("acu-vermilion", [x, y, 0.065 if y > 0.95 else 0.045], [0.02, 0.02, 0.01]))
    return {
        "id": "acu-meridian-model", "name": L("Acupuncture model figure", "针灸铜人模型"), "category": "teaching",
        "description": L("A bronze figure marked with the channels and their points, on a rosewood pedestal. A teaching ornament: it does not locate a point.", "标有经络与腧穴的铜人模型，置于红木座上。教学陈设，不能据此定位腧穴。"),
        "capabilities": [], "footprint": {"w": 0.4, "d": 0.4, "h": 1.5}, "solid": True, "parts": parts,
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["tcm", "teaching", "decor"],
    }

def patient_chair():
    parts = [
        part("acu-beech", [0.205, 0.215, 0.175], [0.05, 0.43, 0.05]), part("acu-beech", [-0.205, 0.215, 0.175], [0.05, 0.43, 0.05]),
        part("acu-beech", [0.205, 0.44, -0.215], [0.05, 0.88, 0.05]), part("acu-beech", [-0.205, 0.44, -0.215], [0.05, 0.88, 0.05]),
        part("acu-jade", [0, 0.465, 0.02], [0.48, 0.07, 0.44], name="seat"), part("acu-jade", [0, 0.73, -0.2175], [0.36, 0.26, 0.035]),
        part("acu-beech", [0, 0.22, -0.215], [0.36, 0.04, 0.03]),
        part("acu-beech", [0.225, 0.62, 0.0], [0.04, 0.03, 0.4]), part("acu-beech", [-0.225, 0.62, 0.0], [0.04, 0.03, 0.4]),
    ]
    return {
        "id": "acu-patient-chair", "name": L("Patient's chair", "患者座椅"), "category": "furniture",
        "description": L("An upright beech chair with armrests and a padded seat: where the patient sits for the consultation, or for needling when lying down is not possible.", "带扶手的榉木软垫靠背椅：问诊时患者就座，无法卧位时亦可坐位针刺。"),
        "usage": L("Speak with and examine the seated patient from beside the chair. A patient treated sitting is more likely to faint than one lying down.", "在椅旁与就座的患者交谈、查体。坐位针刺比卧位更容易晕针。"),
        "capabilities": [], "footprint": {"w": 0.5, "d": 0.5, "h": 0.9}, "solid": True, "parts": parts,
        "interaction": {"kind": "bed", "prompt": L("E · Patient's chair", "E · 患者座椅")}, "screen": "none",
        "tags": ["seating", "patient-support", "tcm"],
    }

def pulse_cushion():
    return {
        "id": "acu-pulse-cushion", "name": L("Pulse cushion", "脉枕"), "category": "decor",
        "description": L("A small firm cushion the patient's wrist rests on while the pulse is taken.", "诊脉时垫在患者腕下的小枕。"),
        "capabilities": [], "footprint": {"w": 0.22, "d": 0.12, "h": 0.07}, "solid": False,
        "parts": [part("acu-vermilion", [0, 0.032, 0], [0.2, 0.06, 0.11]), part("acu-brass", [0, 0.032, 0], [0.012, 0.064, 0.114])],
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["tcm", "desk", "decor"],
    }

def heat_lamp():
    parts = [
        part("coal", [0, 0.05, -0.1], [0.5, 0.04, 0.5]), part("chrome", [0, 0.62, -0.2], [0.04, 1.1, 0.04]),
        part("white", [0, 0.86, -0.17], [0.12, 0.16, 0.08]), part("chrome", [0, 1.2, 0.04], [0.03, 0.03, 0.5]),
        part("white", [0, 1.17, 0.29], [0.19, 0.07, 0.19]), part("acu-heat", [0, 1.13, 0.29], [0.15, 0.012, 0.15]),
    ]
    for (x, z) in [(0.23, 0.1), (-0.23, 0.1), (0.14, -0.33), (-0.14, -0.33), (0, 0.14)]:
        parts.append(part("rubber", [x, 0.02, z], [0.05, 0.04, 0.05]))
    return {
        "id": "acu-heat-lamp", "name": L("Heat lamp (TDP)", "特定电磁波治疗灯（TDP）"), "category": "therapy",
        "description": L("An infrared heat lamp on a wheeled stand, as stands beside many treatment couches. It is furniture here: no encounter of this release uses it, and nothing is simulated of its heat.", "带轮支架的远红外治疗灯，许多治疗床旁都有。在这里只是陈设：本版本的接诊不使用它，也不模拟其热效应。"),
        "capabilities": [], "footprint": {"w": 0.55, "d": 0.75, "h": 1.3}, "solid": True, "parts": parts,
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["tcm", "lamp", "decor"],
    }

# ---------------------------------------------------------------------------------------------------------
# The needling stations: a couch with a body the world draws (ClinicalCraft docs/FACILITIES.md "A body drawn with
# equipment") and a look for each step of the drill ("A look for each state"). The body is a patient simulator, never
# a case's patient. Its sites — where the marks and the needles of the model stand — are measured on the pinned
# figure kit's body by tools/figure-fit.mts (tools/blender/fit/<type>.json), which tools/blender/models.py reads.
# ---------------------------------------------------------------------------------------------------------

SIMULATOR = {"skin": "#dcb999", "hair": "#2b2420", "build": "average", "presentation": "neutral"}

#: What each station's simulator is and where it lies on the couch (the type's frame; the head towards −Z).
STATIONS = {
    "acu-needling-station-prone": {
        "name": L("Needling practice station: the lower back", "针刺练习台：腰部"),
        "description": L(
            "A treatment couch with a full-body patient simulator lying face down under a towel, the face over the breathing hole, the arms beside the trunk. The drill uses the lumbar points of this pack's low-back-pain family — BL23 and BL25 on both sides and GV3 — step by step: the points located and marked, hands clean and the skin prepared, the needles in, the simulator watched while they are retained, the needles out, counted and in the sharps box. What stands on its skin follows the step. The sites are placed by proportion on the simulator's own body: a schematic, unreviewed, and no guide to locating a point on a person.",
            "治疗床上俯卧着一具全身模拟人，腰臀部盖一条毛巾，面部置于呼吸孔，双臂置于躯干两侧。练习内容取自本内容包腰痛病例族所用的腰部腧穴——双侧肾俞（BL23）、双侧大肠俞（BL25）和腰阳关（GV3）——按步骤进行：定位并标记腧穴，手卫生并消毒皮肤，进针，留针期间观察模拟人，起针、清点并投入锐器盒。模拟人皮肤上的标记和针随步骤变化。各部位按比例置于模拟人自身的身体上：仅为示意，未经审核，不能作为在人体上定位腧穴的依据。"),
        "manikin": {"posture": "prone", "cover": "towels", "breathing": "both", "x": 0, "z": -0.15, "y": COUCH_TOP, "rot": 0, "appearance": {**SIMULATOR, "hairStyle": "bun"}},
        "pillow": False, "h": 0.95,
        "sites": "BL23 and BL25 on both sides, GV3",
    },
    "acu-needling-station-supine": {
        "name": L("Needling practice station: the limbs", "针刺练习台：四肢"),
        "description": L(
            "A treatment couch with a full-body patient simulator lying on its back under towels, the head on a pillow, the arms beside the trunk with the palms up. The drill uses limb points of this pack's nausea and insomnia families — PC6, ST36 and SP6 on both sides — step by step: the points located and marked, hands clean and the skin prepared, the needles in, the simulator watched while they are retained, the needles out, counted and in the sharps box. What stands on its skin follows the step. The sites are placed by proportion on the simulator's own body: a schematic, unreviewed, and no guide to locating a point on a person.",
            "治疗床上仰卧着一具全身模拟人，盖两条毛巾，头枕小枕，双臂置于躯干两侧、掌心向上。练习内容取自本内容包恶心与失眠病例族所用的四肢腧穴——双侧内关（PC6）、足三里（ST36）和三阴交（SP6）——按步骤进行：定位并标记腧穴，手卫生并消毒皮肤，进针，留针期间观察模拟人，起针、清点并投入锐器盒。模拟人皮肤上的标记和针随步骤变化。各部位按比例置于模拟人自身的身体上：仅为示意，未经审核，不能作为在人体上定位腧穴的依据。"),
        "manikin": {"posture": "lying", "cover": "towels", "breathing": "both", "x": 0, "z": -0.05, "y": COUCH_TOP, "rot": 0, "appearance": {**SIMULATOR, "hairStyle": "short"}},
        "pillow": False, "h": 0.95,
        "sites": "PC6, ST36 and SP6 on both sides",
    },
}

#: The layers of a station's model (tools/blender/models.py builds them) and the steps that show them.
STATION_LAYERS = {
    "marks": "each site marked on the skin with a ring of skin marker",
    "needles": "a needle standing in each site",
    "timer": "a timer by the head, running while the needles are retained",
}

def look(*layers):
    assert all(layer in STATION_LAYERS for layer in layers), layers
    return {"layers": list(layers)}

STATION_STATES = {
    "ready": (L("ready: the simulator lies covered", "待练习：模拟人已就位并遮盖"), look()),
    "located": (L("points located and marked", "腧穴已定位并标记"), look("marks")),
    "prepared": (L("hands clean, pack opened, skin prepared", "已手卫生、开封针具并消毒皮肤"), look("marks")),
    "needled": (L("needles in", "已进针"), look("marks", "needles")),
    "retained": (L("needles retained: the simulator watched, the response asked about", "留针：已观察并询问针感"), look("marks", "needles", "timer")),
    "removed": (L("needles out, counted and in the sharps box", "已起针、清点并投入锐器盒"), look("marks")),
}
assert sorted({layer for _, lk in STATION_STATES.values() for layer in lk["layers"]}) == sorted(STATION_LAYERS), "a layer of the model that no step shows"

NEEDLERS = ["clinician", "attending"]   # the learner, a TCM physician: the simulated clinic's assistants do not needle (content/sg/roles.json)

def op(en, zh, frm, to, seconds, roles=NEEDLERS):
    return {"name": L(en, zh), "from": frm, "to": to, "durationSeconds": seconds, "roles": roles}

STATION_OPERATIONS = {
    "locate_points": op("Locate each point from its landmarks and proportional measurement, and mark it", "按体表标志和骨度分寸逐一定位腧穴并做标记", ["ready"], "located", 120),
    "prepare": op("Clean your hands, open a sealed pack onto the tray, and prepare the skin at each mark", "手卫生，在托盘上开封针具，逐一消毒标记处皮肤", ["located"], "prepared", 90),
    "insert_needles": op("Insert a needle at each prepared site, one needle to a site, to the planned depth and direction", "在每个已消毒的部位各进一针，按计划的深度和方向", ["prepared"], "needled", 120),
    "check_response": op("Watch the simulator and ask about the sensation at each needle; set the timer for the retention", "观察模拟人，逐针询问针感；设定留针计时", ["needled"], "retained", 60),
    "remove_needles": op("Withdraw every needle, press each site, count the needles and drop them into the sharps box", "逐一起针并按压针孔，清点针数，投入锐器盒", ["needled", "retained"], "removed", 90),
    "reset": op("Wipe the marks off and cover the simulator for the next learner", "擦去标记，为下一位学员盖好模拟人", ["located", "prepared", "removed"], "ready", 30, ["clinician", "attending", "nurse"]),
}

def station(type_id):
    spec = STATIONS[type_id]
    return {
        "id": type_id, "name": spec["name"], "category": "teaching", "description": spec["description"],
        "usage": L("Work through the steps in order at the station, from the side you are needling. It rehearses the sequence and its safety points — one needle to a site, every needle counted out — not the feel of tissue, and not the location of a point on a person.",
                   "站在所针刺的一侧，按顺序完成各步骤。练习的是流程和安全要点——一穴一针、起针后逐一清点——不是针下手感，也不是在人体上的腧穴定位。"),
        "capabilities": [], "footprint": {"w": 0.7, "d": 1.9, "h": spec["h"]}, "solid": True,
        # (the fallback when the model is not loaded; the body is the world's own figure either way)
        "parts": couch_parts(pillow=False),
        "interaction": {"kind": "device", "prompt": L("E · Needling practice", "E · 针刺练习")}, "screen": "none",
        "tags": ["simulation", "acupuncture", "tcm", "trainer", "teaching"],
        "interactionPoints": [{"x": 0.75, "z": 0.25}, {"x": -0.75, "z": 0.25}],
        "manikin": spec["manikin"],
        "behavior": {"initial": "ready", "states": {sid: {"name": name, "look": lk} for sid, (name, lk) in STATION_STATES.items()}, "operations": STATION_OPERATIONS},
    }

EQUIPMENT = [couch(), patient_chair(), trolley(), shelf(), herb_cabinet(), meridian_chart(), meridian_model(), pulse_cushion(), heat_lamp(),
             station("acu-needling-station-prone"), station("acu-needling-station-supine")]

def with_models(equipment):
    """Each type with its model's catalog reference (tools/blender/models.json, written by tools/blender/build.py)."""
    refs = json.load(open(MODELS, encoding="utf-8")) if os.path.exists(MODELS) else {}
    unknown = sorted(set(refs) - {e["id"] for e in equipment})
    assert not unknown, f"tools/blender/models.json names types the catalog does not have: {unknown}"
    return [{**e, **({"model": refs[e["id"]]} if e["id"] in refs else {})} for e in equipment]

CATALOG = {
    "schema": "clinicalcraft/equipment-catalog@1", "id": "acucraft-tcm", "name": L("AcuCraft TCM clinic equipment", "AcuCraft 中医诊所设备"),
    "materials": MATERIALS, "equipment": with_models(EQUIPMENT),
}

# ---------------------------------------------------------------------------------------------------------
# Room templates (template-local coordinates: origin at the room centre, door on the south side)
# ---------------------------------------------------------------------------------------------------------

DESK_TOP = 0.76   # the top of ClinicalCraft's `desk`

# The people of the clinic as the world's figure kit draws them (ClinicalCraft docs/FACILITIES.md "Staff in the 3D
# world"): a role wears its uniform — a clinic assistant a tunic and trousers (the `nurse` role's scrubs, in the
# clinic's jade), reception a shirt, a tutor a white coat — and the appearance says the rest. Looks only: who may do
# what is content/sg/roles.json.
ASSISTANT = {"skin": "#b98a66", "hair": "#1f1a17", "hairStyle": "bun", "shirt": "#5f9f92", "pants": "#3f4a4c", "build": "average", "presentation": "feminine"}
RECEPTIONIST = {"skin": "#dcb999", "hair": "#2a2522", "hairStyle": "short", "shirt": "#e6dfcb", "pants": "#354442", "build": "average", "presentation": "masculine"}
TUTOR = {"skin": "#e0bf9f", "hair": "#3a3330", "hairStyle": "bob", "shirt": "#7fae9b", "pants": "#3d4450", "build": "slim", "presentation": "feminine"}

def P(id, type, x, z, rot=0, label=None, **extra):
    o = {"id": id, "type": type, "x": round(x, 4), "z": round(z, 4)}
    if rot: o["rot"] = rot
    if label: o["label"] = label
    o.update(extra)
    return o

# The finish of the walls: a painted dado under plain cream, a pale tiled ceiling (looks only: where a wall stands
# is the room's rect and its openings).
WALLS = {"height": 3.2, "base": "acu-dado", "body": "cream", "top": "cream", "thickness": 0.35}
ROOF = {"material": "acu-ceiling"}

def walls(door_offset, door_width=1.3):
    side = lambda s, **extra: {"side": s, "base": "acu-dado", **extra}
    return [side("n"), side("w"), side("e"),
            side("s", openings=[{"kind": "door", "width": door_width, "height": 2.4, "offset": door_offset}])]

CONSULT = {
    "schema": "clinicalcraft/room-template@1", "id": "acu-consult-room", "name": L("TCM consultation room", "中医诊室"),
    "description": L("A TCM consulting room: the physician's desk with a pulse cushion and the records terminal, the patient's chair, a herbal cabinet and a hand-rub dispenser by the door.", "中医诊室：诊桌、脉枕与病历终端，患者座椅，百子柜，门旁的免洗手消毒液。"),
    "kind": "consult", "size": {"w": 6, "d": 5}, "floor": "acu-timber", "partitions": walls(1.75),
    "sign": {"text": L("Consultation", "诊室"), "side": "n"}, "lights": [{"x": -1, "z": -0.5}, {"x": 1.5, "z": 0.8}],
    "placements": [
        # the desk on the north wall with the pulse cushion at the patient's end; the patient sits at the physician's left
        P("desk", "desk", -0.5, -1.8, 0, L("Physician's desk", "诊桌")),
        P("pulse-cushion", "acu-pulse-cushion", -1.0, -1.64, 0, L("Pulse cushion", "脉枕"), y=DESK_TOP),
        P("records", "records-terminal", -1.75, -1.85, 0, L("Records terminal", "病历终端")),
        P("patient-chair", "acu-patient-chair", -2.25, -0.75, 90, L("Patient's chair", "患者座椅")),
        P("physician-chair", "office-chair", -0.4, -0.8, 180),
        P("hand-rub", "hand-sanitizer", 2.55, 1.3, 270, L("Hand-rub dispenser", "免洗手消毒液")),
        P("herb-cabinet", "acu-herb-cabinet", 1.7, -2.05, 0),
        P("chart", "acu-meridian-chart", 2.78, -0.4, 270),
        P("plant", "potted-plant", -2.4, 1.9),
    ],
    "patientSlots": [{"id": "slot", "x": -2.25, "z": -0.75, "rot": 90, "posture": "sitting", "bed": "patient-chair", "accepts": ["outpatient"]}],
    "capabilities": ["records"], "tags": ["outpatient", "tcm"],
}

TREATMENT = {
    "schema": "clinicalcraft/room-template@1", "id": "acu-treatment-room", "name": L("Acupuncture treatment room", "针灸治疗室"),
    "description": L("An acupuncture treatment room: a couch that can be walked round, the needle trolley with its sharps box at the foot of the couch, a chair, a hand-wash sink and a privacy curtain.", "针灸治疗室：可绕行的治疗床，床尾带锐器盒的针具治疗车，座椅、洗手池和隔帘。"),
    "kind": "consult", "size": {"w": 6, "d": 5}, "floor": "lino", "partitions": walls(2.25),
    "sign": {"text": L("Treatment", "治疗室"), "side": "n"}, "lights": [{"x": 0, "z": -0.6}, {"x": 2, "z": 1.2}],
    "placements": [
        # the couch centre lies on a grid line: the cells 0.75 m either side of it are free (see the module note)
        P("couch", "acu-treatment-couch", 0.0, -0.4, 0, L("Treatment couch", "治疗床")),
        P("trolley", "acu-needle-trolley", 0.0, 0.825, 0, L("Needle trolley and sharps box", "针具治疗车与锐器盒")),
        P("patient-chair", "acu-patient-chair", -2.25, 0.75, 90, L("Treatment chair", "治疗椅")),
        P("sink", "sink", 2.2, -2.05, 0, L("Hand-wash sink", "洗手池")),
        P("curtain", "privacy-curtain", 1.5, 1.6, 0, L("Privacy curtain", "隔帘")),
        P("chart", "acu-meridian-chart", -1.6, -2.3, 0),
        P("model", "acu-meridian-model", -2.5, -2.0, 0),
        P("clock", "wall-clock", 2.77, 0.2, 270),
    ],
    "patientSlots": [{"id": "slot", "x": 0.0, "z": -0.4, "rot": 0, "posture": "lying", "bed": "couch", "accepts": ["outpatient"]}],
    "staff": [{"id": "assistant", "role": "nurse", "position": "ward-nurse", "name": L("Ms Nur Aisyah (clinic assistant)", "努尔·艾莎女士（诊所助理）"), "x": 1.75, "z": 0.75, "rot": 270,
               "appearance": ASSISTANT,
               "greeting": L("The couch is ready. Tell me if you want me to stay with the patient.", "治疗床已备好。需要我陪着患者就说一声。")}],
    "capabilities": [], "tags": ["outpatient", "tcm", "acupuncture"],
}

PREP = {
    "schema": "clinicalcraft/room-template@1", "id": "acu-prep-room", "name": L("Preparation area", "准备间"),
    "description": L("A clean preparation area: the shelf of sealed needle packs and supplies, a worktop, a hand-wash sink and a sharps container.", "清洁准备间：存放未开封针具和耗材的货架、操作台、洗手池和锐器盒。"),
    "kind": "storage", "size": {"w": 4, "d": 5}, "floor": "lino", "partitions": walls(0.25),
    "sign": {"text": L("Preparation", "准备间"), "side": "n"}, "lights": [{"x": 0, "z": 0}],
    "placements": [
        P("shelf", "acu-supply-shelf", 0.0, -2.1, 0, L("Supply shelf", "耗材架")),
        P("sink", "sink", 1.5, 0.0, 270, L("Hand-wash sink", "洗手池")),
        P("sharps", "sharps-bin", -1.55, -2.05, 0, L("Sharps container", "锐器盒")),
        P("worktop", "instrument-table", -1.45, 0.2, 90, L("Worktop", "操作台")),
        P("gloves", "glove-dispenser", 1.78, 1.4, 270),
        P("bin", "trash-bin", -1.55, 1.9),
    ],
    "capabilities": [], "tags": ["tcm", "clean-utility"],
}

# The skills room. The prone station's lumbar region lies 0.27 m towards the head from the couch's middle (the
# simulator's soles are 0.80 m towards the foot, its lumbar spine 1.07 m up a standing adult): the heat lamp stands
# beside it there, its head towards the couch.
SKILLS = {
    "schema": "clinicalcraft/room-template@1", "id": "acu-skills-room", "name": L("Acupuncture skills room", "针灸技能实训室"),
    "description": L("A skills room: two needling practice stations — a patient simulator face down for the points of the lower back, another on its back for the points of the limbs — each with a needle trolley and a stool, a heat lamp, the bronze figure and the charts, a supply shelf, a hand-wash sink and a whiteboard.",
                     "技能实训室：两个针刺练习台——一具模拟人俯卧练习腰部腧穴，另一具仰卧练习四肢腧穴——各配针具治疗车和圆凳，另有治疗灯、铜人与挂图、耗材架、洗手池和白板。"),
    "kind": "teaching", "size": {"w": 9, "d": 7}, "floor": "lino", "partitions": walls(0, 1.6),
    "sign": {"text": L("Skills room", "实训室"), "side": "n"}, "lights": [{"x": -2, "z": -0.75}, {"x": 1.5, "z": -0.75}, {"x": 0, "z": 2}],
    "placements": [
        P("station-prone", "acu-needling-station-prone", -2.0, -0.75, 0, L("Needling station: lower back", "针刺练习台：腰部")),
        P("station-supine", "acu-needling-station-supine", 1.5, -0.75, 0, L("Needling station: limbs", "针刺练习台：四肢")),
        P("trolley-prone", "acu-needle-trolley", -2.0, 0.65, 0, L("Needle trolley and sharps box", "针具治疗车与锐器盒")),
        P("trolley-supine", "acu-needle-trolley", 1.5, 0.65, 0, L("Needle trolley and sharps box", "针具治疗车与锐器盒")),
        P("heat-lamp", "acu-heat-lamp", -2.75, -1.02, 90, L("Heat lamp", "治疗灯")),
        P("stool-prone", "stool", -1.1, -0.9),
        P("stool-supine", "stool", 2.4, -0.9),
        P("model", "acu-meridian-model", -0.25, -3.0, 0),
        P("chart-west", "acu-meridian-chart", -2.0, -3.3, 0),
        P("chart-east", "acu-meridian-chart", 1.5, -3.3, 0),
        P("shelf", "acu-supply-shelf", 4.05, -1.8, 270, L("Supply shelf", "耗材架")),
        P("sink", "sink", 4.0, 0.6, 270, L("Hand-wash sink", "洗手池")),
        P("hand-rub", "hand-sanitizer", 1.5, 3.1, 180, L("Hand-rub dispenser", "免洗手消毒液")),
        P("whiteboard", "whiteboard", -4.24, 0.4, 90),
        P("clock", "wall-clock", 4.27, 2.3, 270),
        P("bin", "trash-bin", -4.0, 3.0),
        P("plant", "potted-plant", 4.0, 3.0),
    ],
    "staff": [{"id": "tutor", "role": "attending", "position": "educator", "name": L("Dr Lim Siew Hoon (clinical tutor)", "林秀云医师（带教）"), "x": -0.25, "z": 1.1, "rot": 0,
               "appearance": TUTOR,
               "greeting": L("Take a station. Mark your points before you open a pack, and count every needle out.", "选一个练习台。先标好穴位再开封针具，起针后逐一清点。")}],
    "capabilities": [], "tags": ["tcm", "teaching", "simulation"],
}

# ---------------------------------------------------------------------------------------------------------
# The facilities
# ---------------------------------------------------------------------------------------------------------

FACILITY = {
    "schema": "clinicalcraft/facility@1", "id": FACILITY_ID, "name": L("Simulated outpatient TCM clinic, Singapore", "模拟中医门诊（新加坡）"),
    "description": L("A simulated outpatient TCM clinic on one floor: reception and waiting area, a corridor, a consultation room, an acupuncture treatment room and a preparation area. Illustrative, not a real institution.", "单层模拟中医门诊：前台候诊区、走廊、诊室、针灸治疗室和准备间。仅作示意，并非真实机构。"),
    "bounds": {"minX": -10, "maxX": 10, "minZ": -8, "maxZ": 10},
    "spawn": {"x": 0, "z": 8.25, "yaw": 0},
    "catalogs": ["materials", "core-furniture", "core-clinical", "acucraft-tcm"],
    "terrain": {"ground": "grass",
                "paths": [{"x": 0, "z": 8, "w": 8, "d": 4, "material": "stone"}],
                "trees": [{"x": -8.5, "z": 8.5, "h": 4}, {"x": 8.5, "z": 8.5, "h": 5}, {"x": -9, "z": -7, "h": 5}, {"x": 9, "z": -7, "h": 4}],
                "flowers": {"count": 40, "seed": 7103, "exclude": [{"x": 0, "z": 0, "w": 17, "d": 13}, {"x": 0, "z": 8, "w": 8, "d": 4}]}},
    "buildings": [{
        "id": "clinic", "name": L("TCM clinic", "中医诊所"), "rect": {"x": 0, "z": 0, "w": 16, "d": 12}, "floor": "floor",
        "walls": WALLS, "roof": ROOF,
        "openings": [
            {"side": "s", "offset": 0, "width": 2.4, "height": 2.6, "kind": "double-door"},
            {"side": "s", "offset": -5, "width": 2.4, "height": 1.4, "kind": "window", "sill": 1.0},
            {"side": "s", "offset": 5, "width": 2.4, "height": 1.4, "kind": "window", "sill": 1.0},
            {"side": "n", "offset": -6.4, "width": 1.6, "height": 1.2, "kind": "window", "sill": 1.3},
            {"side": "n", "offset": 1.0, "width": 1.4, "height": 1.0, "kind": "window", "sill": 1.6},
            {"side": "w", "offset": 3.5, "width": 2.0, "height": 1.4, "kind": "window", "sill": 1.0},
            {"side": "e", "offset": 3.5, "width": 2.0, "height": 1.4, "kind": "window", "sill": 1.0},
        ],
        "sign": {"text": L("TCM Clinic · Acupuncture", "中医诊所 · 针灸"), "side": "s"},
    }],
    "rooms": [
        {"id": "corridor", "name": L("Corridor", "走廊"), "kind": "corridor", "building": "clinic", "rect": {"x": 0, "z": 0, "w": 16, "d": 2}, "floor": "lino",
         "lights": [{"x": -5, "z": 0}, {"x": 0, "z": 0}, {"x": 5, "z": 0}]},
        {"id": "reception", "name": L("Reception and waiting area", "前台与候诊区"), "kind": "reception", "building": "clinic", "rect": {"x": 0, "z": 3.5, "w": 16, "d": 5}, "floor": "acu-timber",
         "partitions": [{"side": "n", "base": "acu-dado", "openings": [{"kind": "opening", "width": 6, "height": 2.6, "offset": 1}]}],
         "sign": {"text": L("Reception", "前台"), "side": "n"}, "lights": [{"x": -4, "z": 3.5}, {"x": 4, "z": 3.5}]},
    ],
    "instances": [
        {"id": "consult-room", "template": "acu-consult-room", "x": -5, "z": -3.5, "building": "clinic"},
        {"id": "treatment-room", "template": "acu-treatment-room", "x": 1, "z": -3.5, "building": "clinic"},
        {"id": "prep-area", "template": "acu-prep-room", "x": 6, "z": -3.5, "building": "clinic"},
    ],
    "placements": [
        P("reception-desk", "reception-desk", -5.0, 3.1, 0, L("Reception", "前台"), room="reception"),
        P("reception-records", "records-terminal", -7.2, 2.0, 90, L("Reception records terminal", "前台病历终端"), room="reception"),
        P("waiting-chairs-1", "waiting-chairs", 4.2, 5.4, 180, room="reception"),
        P("waiting-chairs-2", "waiting-chairs", 6.6, 5.4, 180, room="reception"),
        P("waiting-chairs-3", "waiting-chairs", 7.4, 3.0, 270, room="reception"),
        P("water", "water-dispenser", 2.4, 5.5, 180, room="reception"),
        P("reception-plant", "potted-plant", -7.3, 5.3, room="reception"),
        P("reception-hand-rub", "hand-sanitizer", 1.8, 1.65, 0, L("Hand-rub dispenser", "免洗手消毒液"), room="reception"),
        P("reception-chart", "acu-meridian-chart", 6.0, 1.22, 0, room="reception"),
    ],
    "staff": [{"id": "receptionist", "role": "receptionist", "position": "receptionist", "name": L("Mr Tan (reception)", "陈先生（前台）"), "room": "reception", "x": -5.0, "z": 1.95, "rot": 0,
               "appearance": RECEPTIONIST,
               "greeting": L("Good morning. The consultation room is the first door on the left along the corridor.", "早上好。沿走廊左手第一间是诊室。")}],
    "signs": [],
    "outdoorRegion": L("Clinic forecourt", "诊所门前"),
}

SKILLS_FACILITY = {
    "schema": "clinicalcraft/facility@1", "id": SKILLS_ID, "name": L("Simulated acupuncture skills room, Singapore", "模拟针灸技能实训室（新加坡）"),
    "description": L("A simulated skills room beside the clinic's own floor plan: a lobby and one room with two needling practice stations, each a treatment couch with a patient simulator. Nobody here is a patient, and no encounter of this release is played here. Illustrative, not a real institution.",
                     "诊所平面之外的模拟技能实训室：门厅和一间实训室，内有两个针刺练习台，各为一张治疗床和一具模拟人。这里没有患者，本版本的接诊也不在这里进行。仅作示意，并非真实机构。"),
    "bounds": {"minX": -8, "maxX": 8, "minZ": -7, "maxZ": 9},
    "spawn": {"x": 0, "z": 7.25, "yaw": 0},
    "catalogs": ["materials", "core-furniture", "core-clinical", "acucraft-tcm"],
    "terrain": {"ground": "grass",
                "paths": [{"x": 0, "z": 7, "w": 6, "d": 4, "material": "stone"}],
                "trees": [{"x": -6.5, "z": 7.5, "h": 4}, {"x": 6.5, "z": 7.5, "h": 5}, {"x": -6.5, "z": -5.5, "h": 5}, {"x": 6.5, "z": -5.5, "h": 4}],
                "flowers": {"count": 30, "seed": 7104, "exclude": [{"x": 0, "z": 0.5, "w": 10, "d": 10}, {"x": 0, "z": 7, "w": 6, "d": 4}]}},
    "buildings": [{
        "id": "skills", "name": L("Skills room", "技能实训室"), "rect": {"x": 0, "z": 0.5, "w": 9, "d": 9}, "floor": "floor",
        "walls": WALLS, "roof": ROOF,
        "openings": [
            {"side": "s", "offset": 0, "width": 2.0, "height": 2.6, "kind": "double-door"},
            {"side": "s", "offset": -3, "width": 1.6, "height": 1.4, "kind": "window", "sill": 1.0},
            {"side": "s", "offset": 3, "width": 1.6, "height": 1.4, "kind": "window", "sill": 1.0},
            {"side": "w", "offset": -2.5, "width": 2.0, "height": 1.2, "kind": "window", "sill": 1.4},
            {"side": "e", "offset": 2.5, "width": 1.6, "height": 1.2, "kind": "window", "sill": 1.4},
        ],
        "sign": {"text": L("Acupuncture skills room", "针灸技能实训室"), "side": "s"},
    }],
    "rooms": [
        {"id": "lobby", "name": L("Lobby", "门厅"), "kind": "entrance", "building": "skills", "rect": {"x": 0, "z": 4, "w": 9, "d": 2}, "floor": "floor",
         "lights": [{"x": -2.5, "z": 4}, {"x": 2.5, "z": 4}]},
    ],
    "instances": [
        {"id": "skills-room", "template": "acu-skills-room", "x": 0, "z": -0.5, "building": "skills"},
    ],
    "placements": [
        P("lobby-chairs", "waiting-chairs", -3.0, 4.4, 180, room="lobby"),
        P("lobby-hand-rub", "hand-sanitizer", 2.2, 3.35, 0, L("Hand-rub dispenser", "免洗手消毒液"), room="lobby"),
        P("lobby-plant", "potted-plant", 3.9, 4.4, room="lobby"),
    ],
    "staff": [],
    "signs": [],
    "outdoorRegion": L("Forecourt", "门前"),
}

# ---------------------------------------------------------------------------------------------------------
# The AcuCraft clinic: rooms and fixtures (what the engine reasons about), each on a placement of the facility
# ---------------------------------------------------------------------------------------------------------

def F(id, kind, label, placement):
    return {"id": id, "kind": kind, "label": label, "placement": placement}

CLINIC = {
    "schema": "acucraft/clinic@1", "id": "sg-tcm-outpatient", "version": "0.2.0", "title": "Simulated outpatient TCM clinic, Singapore", "jurisdiction": "SG",
    "languages": {"primary": "en", "secondary": ["zh-CN"]},
    "facility": FACILITY_ID,
    "rooms": [
        {"id": "reception", "label": "reception", "kind": "reception", "home": {"x": -5.75, "z": 1.75}, "fixtures": [
            F("desk", "records-terminal", "reception desk and records", "reception-records"),
            F("reception-hand-rub", "hand-hygiene", "hand rub dispenser", "reception-hand-rub")]},
        {"id": "corridor", "label": "corridor", "kind": "corridor", "home": {"x": 0.25, "z": -0.25}, "fixtures": []},
        {"id": "consult-room", "label": "consultation room", "kind": "consult", "home": {"x": -6.25, "z": -4.25}, "fixtures": [
            F("consult-chair", "chair", "patient chair", "consult-room.patient-chair"),
            F("consult-terminal", "records-terminal", "records terminal", "consult-room.records"),
            F("consult-sink", "hand-hygiene", "hand rub dispenser", "consult-room.hand-rub")]},
        {"id": "treatment-room", "label": "treatment room", "kind": "treatment", "home": {"x": 2.75, "z": -2.75}, "fixtures": [
            F("couch-1", "couch", "treatment couch", "treatment-room.couch"),
            F("treat-chair", "chair", "treatment chair", "treatment-room.patient-chair"),
            F("treat-sink", "hand-hygiene", "hand-wash sink and hand rub", "treatment-room.sink"),
            F("trolley-1", "trolley", "needle trolley", "treatment-room.trolley"),
            F("sharps-1", "sharps-container", "sharps box on the needle trolley", "treatment-room.trolley"),
            F("screen-1", "screen", "privacy curtain", "treatment-room.curtain")]},
        {"id": "prep-area", "label": "preparation area", "kind": "preparation", "home": {"x": 6.25, "z": -4.25}, "fixtures": [
            F("shelf", "supplies", "supply shelf", "prep-area.shelf"),
            F("prep-sink", "hand-hygiene", "hand-wash sink", "prep-area.sink"),
            F("sharps-prep", "sharps-container", "sharps container", "prep-area.sharps"),
            F("worktop", "trolley", "worktop", "prep-area.worktop")]},
    ],
    "supplies": [{"id": "alcohol-swabs", "label": "alcohol skin swabs", "at": "shelf"}, {"id": "cotton-balls", "label": "sterile cotton balls", "at": "shelf"},
                 {"id": "gloves", "label": "examination gloves", "at": "shelf"}, {"id": "plasters", "label": "plasters", "at": "shelf"}],
    "referralTargets": [
        {"id": "emergency", "label": "Emergency Department (ambulance 995)", "kind": "emergency"}, {"id": "gp", "label": "Polyclinic / family physician", "kind": "medical"},
        {"id": "orthopaedics", "label": "Orthopaedic clinic", "kind": "specialist"}, {"id": "oncology", "label": "Treating oncology team", "kind": "specialist"},
        {"id": "obstetrics", "label": "Obstetric team", "kind": "specialist"}, {"id": "neurology", "label": "Neurology", "kind": "specialist"},
        {"id": "physiotherapy", "label": "Physiotherapy", "kind": "allied-health"}, {"id": "senior-tcm", "label": "Senior TCM physician", "kind": "tcm"}],
    "notes": "A simulated clinic: rooms, fixtures and referral targets are illustrative, not a real institution. Its floor plan is the ClinicalCraft facility of the same id (content/world).",
}

if __name__ == "__main__":
    dump(os.path.join(WORLD, "catalogs", "acucraft-tcm.json"), CATALOG)
    for t in (CONSULT, TREATMENT, PREP, SKILLS):
        dump(os.path.join(WORLD, "templates", f"{t['id']}.json"), t)
    dump(os.path.join(WORLD, "facilities", f"{FACILITY_ID}.json"), FACILITY)
    dump(os.path.join(WORLD, "facilities", f"{SKILLS_ID}.json"), SKILLS_FACILITY)
    dump(os.path.join(ROOT, "content", "sg", "clinic.json"), CLINIC)
    modelled = sum(1 for e in CATALOG["equipment"] if "model" in e)
    print(f"{len(CATALOG['equipment'])} equipment types ({modelled} with a model), {len(CATALOG['materials'])} materials, 4 room templates, "
          f"facilities {FACILITY_ID} and {SKILLS_ID}, clinic with {sum(len(r['fixtures']) for r in CLINIC['rooms'])} fixtures")
