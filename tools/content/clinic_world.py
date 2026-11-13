"""The simulated TCM clinic as a navigable world (authoring script; the JSON it writes is the content).

Writes, in ClinicalCraft's own formats (docs/FACILITIES.md in ClinicalCraft), so that ClinicalCraft's front-ends can
load the clinic through `contentDirs` and AcuCraft's engine plans walks through the same rooms:

  content/world/catalogs/acucraft-tcm.json        clinicalcraft/equipment-catalog@1   TCM equipment types
  content/world/templates/acu-*.json              clinicalcraft/room-template@1       consultation, treatment, preparation
  content/world/facilities/sg-tcm-outpatient.json clinicalcraft/facility@1            the clinic
  content/sg/clinic.json                          acucraft/clinic@1                   rooms, fixtures → placements

Units are metres; +Z is south; an equipment type's front faces +Z at `rot: 0`. The navigation grid has 0.5 m cells
from the facility bounds (whole numbers here), and a cell is free when its centre is 0.38 m clear of every solid
footprint. The treatment couch is 0.7 m wide and centred on a grid line so that the cells beside it are free: the
practitioner stands 0.75 m from its centre line on either side (docs/WORLD.md).

    python3 tools/content/clinic_world.py
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import ROOT, dump

WORLD = os.path.join(ROOT, "content", "world")
FACILITY_ID = "sg-tcm-outpatient"

def L(en, zh):
    return {"zh-CN": zh, "en": en}

def part(m, p, s, **extra):
    o = {"m": m, "p": [round(x, 4) for x in p], "s": [round(x, 4) for x in s]}
    o.update(extra)
    return o

# ---------------------------------------------------------------------------------------------------------
# Equipment (voxel parts: `p` the box centre, `s` its size; origin = footprint centre on the floor)
# ---------------------------------------------------------------------------------------------------------

def couch():
    parts = []
    for sx in (0.29, -0.29):
        for sz in (0.82, -0.82):
            parts.append(part("steel", [sx, 0.27, sz], [0.06, 0.54, 0.06]))
            parts.append(part("rubber", [sx, 0.02, sz], [0.08, 0.04, 0.08]))
    parts += [
        part("steel", [0, 0.16, 0], [0.04, 0.04, 1.64]),
        part("steel", [0, 0.16, 0.82], [0.58, 0.04, 0.04]),
        part("steel", [0, 0.16, -0.82], [0.58, 0.04, 0.04]),
        part("steel", [0, 0.555, 0], [0.68, 0.05, 1.86]),
        part("mattress", [0, 0.625, 0.14], [0.7, 0.09, 1.6]),
        # the head section, with the breathing hole a prone patient's face rests over
        part("mattress", [0.24, 0.625, -0.8], [0.22, 0.09, 0.3]),
        part("mattress", [-0.24, 0.625, -0.8], [0.22, 0.09, 0.3]),
        part("mattress", [0, 0.625, -0.91], [0.26, 0.09, 0.08]),
        part("coal", [0, 0.6, -0.76], [0.26, 0.04, 0.22]),
        part("paper", [0, 0.672, 0.14], [0.52, 0.004, 1.5]),
        part("white", [0, 0.7, -0.5], [0.4, 0.05, 0.24]),
        part("chrome", [0.32, 0.5, 0.86], [0.02, 0.1, 0.02]),
    ]
    return {
        "id": "acu-treatment-couch", "name": L("Acupuncture couch", "针灸治疗床"), "category": "furniture",
        "description": L("A padded treatment couch 0.7 m wide with a breathing hole at its head end and a paper cover: narrow enough to work from either side.", "带呼吸孔的软垫针灸治疗床，宽 0.7 米，铺一次性床单：两侧均可操作。"),
        "usage": L("The patient lies supine, prone or on one side with the head at the end with the breathing hole. Stand at the side you are needling: a point on the far side of the body is out of arm's reach.", "患者头朝呼吸孔一端，仰卧、俯卧或侧卧。站在所针刺的一侧操作：对侧的穴位够不着。"),
        "capabilities": [], "footprint": {"w": 0.7, "d": 1.9, "h": 0.75}, "solid": True, "parts": parts,
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
        part("white", [0, 0.3, 0], [0.56, 0.03, 0.41]),
        part("steel", [0, 0.88, 0], [0.58, 0.03, 0.43]),
        part("chrome", [0, 0.92, 0.2075], [0.58, 0.05, 0.015]),
        part("chrome", [0, 0.92, -0.2075], [0.58, 0.05, 0.015]),
        # the tray an opened pack's needles lie on, and sealed packs
        part("chrome", [-0.02, 0.905, -0.08], [0.2, 0.02, 0.13]),
        part("blue", [-0.2, 0.915, 0.08], [0.1, 0.04, 0.14]),
        part("white", [-0.08, 0.915, 0.08], [0.1, 0.04, 0.14]),
        part("paper", [0.05, 0.905, 0.1], [0.12, 0.02, 0.1]),
        # the sharps box, at the point of use
        part("yellow", [0.2, 0.975, -0.09], [0.15, 0.16, 0.16]),
        part("biohazard", [0.2, 1.065, -0.09], [0.16, 0.02, 0.17]),
        part("black", [0.2, 1.0775, -0.08], [0.07, 0.005, 0.05]),
        part("white", [0.2, 0.935, 0.12], [0.07, 0.08, 0.07]),
        part("mint", [-0.12, 0.345, 0.02], [0.2, 0.06, 0.14]),
        part("white", [0.14, 0.355, -0.03], [0.16, 0.08, 0.2]),
    ]
    return {
        "id": "acu-needle-trolley", "name": L("Needle trolley", "针具治疗车"), "category": "therapy",
        "description": L("A treatment trolley at the foot of the couch: the tray for an opened pack of needles, swabs and cotton, and a sharps box at the point of use.", "治疗床尾的治疗车：放置已开封针具的托盘、棉签棉球，以及随用随弃的锐器盒。"),
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
    parts = [part("darkwood", [0, 0.95, -0.015], [1.6, 1.9, 0.42]), part("darkwood", [0, 0.04, 0], [1.6, 0.08, 0.45])]
    for row in range(6):
        y = 0.3 + row * 0.27
        for col in range(5):
            parts.append(part("wood", [-0.6 + col * 0.3, y, 0.205], [0.26, 0.22, 0.02]))
        parts.append(part("gold", [0, y, 0.2185], [1.24, 0.025, 0.012]))
    return {
        "id": "acu-herb-cabinet", "name": L("Herbal medicine cabinet", "中药百子柜"), "category": "storage",
        "description": L("A traditional cabinet of small labelled drawers for dried herbs.", "传统中药饮片柜（百子柜），抽屉分格存放饮片。"),
        "capabilities": [], "footprint": {"w": 1.6, "d": 0.45, "h": 1.9}, "solid": True, "parts": parts,
        "interaction": {"kind": "storage", "prompt": L("E · Herb cabinet", "E · 百子柜")}, "screen": "none",
        "tags": ["storage", "tcm", "decor"],
    }

def meridian_chart():
    z = -0.02
    parts = [
        part("darkwood", [0, 2.0, z], [0.86, 0.04, 0.03]), part("darkwood", [0, 0.86, z], [0.86, 0.04, 0.03]),
        part("paper", [0, 1.43, z - 0.005], [0.8, 1.12, 0.012]),
        part("skin", [0, 1.86, z + 0.004], [0.1, 0.12, 0.006]), part("skin", [0, 1.59, z + 0.004], [0.22, 0.4, 0.006]),
        part("skin", [0.16, 1.58, z + 0.004], [0.06, 0.4, 0.006]), part("skin", [-0.16, 1.58, z + 0.004], [0.06, 0.4, 0.006]),
        part("skin", [0.06, 1.16, z + 0.004], [0.09, 0.46, 0.006]), part("skin", [-0.06, 1.16, z + 0.004], [0.09, 0.46, 0.006]),
        part("red", [0.03, 1.56, z + 0.008], [0.008, 0.42, 0.003]), part("blue", [-0.03, 1.56, z + 0.008], [0.008, 0.42, 0.003]),
        part("red", [0.06, 1.16, z + 0.008], [0.008, 0.44, 0.003]), part("blue", [-0.06, 1.16, z + 0.008], [0.008, 0.44, 0.003]),
        part("red", [0.16, 1.58, z + 0.008], [0.008, 0.38, 0.003]), part("blue", [-0.16, 1.58, z + 0.008], [0.008, 0.38, 0.003]),
    ]
    return {
        "id": "acu-meridian-chart", "name": L("Meridian and acupoint chart", "经络腧穴挂图"), "category": "teaching",
        "description": L("A wall chart of the channels and their points.", "经络与腧穴挂图。"),
        "capabilities": [], "footprint": {"w": 0.9, "d": 0.08, "h": 2.05}, "solid": False, "parts": parts,
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["wall", "tcm", "teaching", "decor"],
    }

def meridian_model():
    parts = [
        part("darkwood", [0, 0.22, 0], [0.36, 0.44, 0.36]), part("gold", [0, 0.455, 0], [0.3, 0.03, 0.3]),
        part("gold", [0.06, 0.7, 0], [0.07, 0.46, 0.08]), part("gold", [-0.06, 0.7, 0], [0.07, 0.46, 0.08]),
        part("gold", [0, 1.1, 0], [0.22, 0.36, 0.13]), part("gold", [0.15, 1.08, 0], [0.05, 0.36, 0.06]), part("gold", [-0.15, 1.08, 0], [0.05, 0.36, 0.06]),
        part("gold", [0, 1.36, 0], [0.12, 0.14, 0.12]),
    ]
    for (x, y) in [(0.04, 1.2), (-0.04, 1.2), (0.0, 1.05), (0.06, 0.8), (-0.06, 0.8), (0.06, 0.6), (-0.06, 0.6)]:
        parts.append(part("red", [x, y, 0.07 if y > 0.95 else 0.045], [0.02, 0.02, 0.01]))
    return {
        "id": "acu-meridian-model", "name": L("Acupuncture model figure", "针灸铜人模型"), "category": "teaching",
        "description": L("A bronze-coloured figure marked with the points, on a wooden pedestal.", "标有腧穴的铜人模型，置于木座上。"),
        "capabilities": [], "footprint": {"w": 0.4, "d": 0.4, "h": 1.5}, "solid": True, "parts": parts,
        "interaction": {"kind": "none"}, "screen": "none", "tags": ["tcm", "teaching", "decor"],
    }

def patient_chair():
    parts = [
        part("darkwood", [0.205, 0.215, 0.175], [0.05, 0.43, 0.05]), part("darkwood", [-0.205, 0.215, 0.175], [0.05, 0.43, 0.05]),
        part("darkwood", [0.205, 0.44, -0.215], [0.05, 0.88, 0.05]), part("darkwood", [-0.205, 0.44, -0.215], [0.05, 0.88, 0.05]),
        part("mint", [0, 0.465, 0.02], [0.48, 0.07, 0.44]), part("mint", [0, 0.73, -0.2175], [0.36, 0.26, 0.035]),
        part("darkwood", [0, 0.22, -0.215], [0.36, 0.04, 0.03]),
        part("darkwood", [0.225, 0.62, 0.0], [0.04, 0.03, 0.4]), part("darkwood", [-0.225, 0.62, 0.0], [0.04, 0.03, 0.4]),
    ]
    return {
        "id": "acu-patient-chair", "name": L("Patient's chair", "患者座椅"), "category": "furniture",
        "description": L("An upright chair with armrests: where the patient sits for the consultation, or for needling when lying down is not possible.", "带扶手的靠背椅：问诊时患者就座，无法卧位时亦可坐位针刺。"),
        "usage": L("Speak with and examine the seated patient from beside the chair. A patient treated sitting is more likely to faint than one lying down.", "在椅旁与就座的患者交谈、查体。坐位针刺比卧位更容易晕针。"),
        "capabilities": [], "footprint": {"w": 0.5, "d": 0.5, "h": 0.9}, "solid": True, "parts": parts,
        "interaction": {"kind": "bed", "prompt": L("E · Patient's chair", "E · 患者座椅")}, "screen": "none",
        "tags": ["seating", "patient-support", "tcm"],
    }

CATALOG = {
    "schema": "clinicalcraft/equipment-catalog@1", "id": "acucraft-tcm", "name": L("AcuCraft TCM clinic equipment", "AcuCraft 中医诊所设备"),
    "materials": [], "equipment": [couch(), patient_chair(), trolley(), shelf(), herb_cabinet(), meridian_chart(), meridian_model()],
}

# ---------------------------------------------------------------------------------------------------------
# Room templates (template-local coordinates: origin at the room centre, door on the south side)
# ---------------------------------------------------------------------------------------------------------

def P(id, type, x, z, rot=0, label=None, **extra):
    o = {"id": id, "type": type, "x": round(x, 4), "z": round(z, 4)}
    if rot: o["rot"] = rot
    if label: o["label"] = label
    o.update(extra)
    return o

def walls(door_offset, door_width=1.3):
    return [{"side": "n"}, {"side": "w"}, {"side": "e"},
            {"side": "s", "openings": [{"kind": "door", "width": door_width, "height": 2.4, "offset": door_offset}]}]

CONSULT = {
    "schema": "clinicalcraft/room-template@1", "id": "acu-consult-room", "name": L("TCM consultation room", "中医诊室"),
    "description": L("A TCM consulting room: the physician's desk with a pulse cushion and the records terminal, the patient's chair, a herbal cabinet and a hand-rub dispenser by the door.", "中医诊室：诊桌、脉枕与病历终端，患者座椅，百子柜，门旁的免洗手消毒液。"),
    "kind": "consult", "size": {"w": 6, "d": 5}, "floor": "floor", "partitions": walls(1.75),
    "sign": {"text": L("Consultation", "诊室"), "side": "n"}, "lights": [{"x": -1, "z": -0.5}, {"x": 1.5, "z": 0.8}],
    "placements": [
        # the desk on the north wall with the pulse cushion at the patient's end; the patient sits at the physician's left
        P("desk", "desk", -0.5, -1.8, 0, L("Physician's desk", "诊桌"), extraParts=[part("red", [-0.5, 0.785, 0.16], [0.2, 0.05, 0.12])]),
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
    "staff": [{"id": "assistant", "role": "nurse", "name": L("Ms Nur Aisyah (clinic assistant)", "努尔·艾莎女士（诊所助理）"), "x": 1.75, "z": 0.75, "rot": 270,
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

# ---------------------------------------------------------------------------------------------------------
# The facility
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
        "walls": {"height": 3.2, "base": "teal", "body": "cream", "top": "wood", "thickness": 0.35},
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
        {"id": "reception", "name": L("Reception and waiting area", "前台与候诊区"), "kind": "reception", "building": "clinic", "rect": {"x": 0, "z": 3.5, "w": 16, "d": 5}, "floor": "floor",
         "partitions": [{"side": "n", "openings": [{"kind": "opening", "width": 6, "height": 2.6, "offset": 1}]}],
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
    "staff": [{"id": "receptionist", "role": "receptionist", "name": L("Mr Tan (reception)", "陈先生（前台）"), "room": "reception", "x": -5.0, "z": 1.95, "rot": 0,
               "greeting": L("Good morning. The consultation room is the first door on the left along the corridor.", "早上好。沿走廊左手第一间是诊室。")}],
    "signs": [],
    "outdoorRegion": L("Clinic forecourt", "诊所门前"),
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
    for t in (CONSULT, TREATMENT, PREP):
        dump(os.path.join(WORLD, "templates", f"{t['id']}.json"), t)
    dump(os.path.join(WORLD, "facilities", f"{FACILITY_ID}.json"), FACILITY)
    dump(os.path.join(ROOT, "content", "sg", "clinic.json"), CLINIC)
    print(f"{len(CATALOG['equipment'])} equipment types, 3 room templates, facility {FACILITY_ID}, clinic with {sum(len(r['fixtures']) for r in CLINIC['rooms'])} fixtures")
