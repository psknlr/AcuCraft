"""Placements on the trunk regions derived from the HuBMAP reference body (tools/anatomy/build_trunk.py): chest,
abdomen and groin, upper back, sacrum and buttocks, the front of the neck, and the lumbar points the lumbar region
gains (T12, L1 and L5). Same form as LOCALISE in acupoints.py: point id -> (region, localisation, tolerance).

ST17 (the nipple: a landmark, not needled) and CV8 (the umbilicus: moxibustion only) are deliberately not placed.
"""

def along(frm, toward, cun, segment, **offset):
    loc = {"method": "along", "from": frm, "toward": toward, "distance": {"cun": cun, "segment": segment}}
    if offset:
        loc["offset"] = offset
    return loc

def landmark(lm, **offset):
    loc = {"method": "landmark", "landmark": lm}
    if offset:
        loc["offset"] = offset
    return loc

def between(a, b, fraction, **offset):
    loc = {"method": "between", "a": a, "b": b, "fraction": fraction}
    if offset:
        loc["offset"] = offset
    return loc

def cm(x):
    return {"cm": x}

def cun(x, segment):
    return {"cun": x, "segment": segment}

LOCALISE = {}

# chest: intercostal spaces on the 2, 4 and 6 B-cun lines and the mid-axillary line; the sternum in the midline
CHEST_TOL = cun(0.3, "seg.nipples")
for pid, lm in {
    "KI22": "ics5-2cun", "KI23": "ics4-2cun", "KI24": "ics3-2cun", "KI25": "ics2-2cun", "KI26": "ics1-2cun", "KI27": "clavicle-inf-2cun",
    "ST13": "clavicle-inf-4cun", "ST14": "ics1-4cun", "ST15": "ics2-4cun", "ST16": "ics3-4cun", "ST18": "ics5-4cun",
    "SP17": "ics5-6cun", "SP18": "ics4-6cun", "SP19": "ics3-6cun", "SP20": "ics2-6cun", "SP21": "ics6-mal",
    "PC1": "ics4-5cun", "LU1": "ics1-6cun", "LU2": "clavicle-inf-6cun",
    "GB22": "ics4-mal", "GB23": "ics4-mal-ant1", "GB24": "ics7-4cun", "LR14": "ics6-4cun",
}.items():
    LOCALISE[pid] = ("chest", landmark(f"{lm}-{{side}}"), CHEST_TOL)
STERNUM_TOL = cun(0.3, "seg.sternum")
LOCALISE.update({
    "CV16": ("chest", landmark("xiphisternal-junction"), STERNUM_TOL),
    "CV17": ("chest", landmark("midline-ics4"), STERNUM_TOL),
    "CV18": ("chest", landmark("midline-ics3"), STERNUM_TOL),
    "CV19": ("chest", landmark("midline-ics2"), STERNUM_TOL),
    "CV20": ("chest", landmark("midline-ics1"), STERNUM_TOL),
    "CV21": ("chest", along("suprasternal-notch", "xiphisternal-junction", 1, "seg.sternum"), STERNUM_TOL),
})

# abdomen: proportional measurement from the umbilicus (8 B-cun up to the xiphisternal junction, 5 down to the pubic
# symphysis), lateral distances on the mid-clavicular (nipple) scale of 4 B-cun each side
UP, DOWN, LAT = "seg.epigastric", "seg.hypogastric", "seg.mcl"
def above(n, lateral=None):
    return along("umbilicus", "xiphisternal-junction", n, UP, **({"lateral": cun(lateral, LAT)} if lateral else {}))
def below(n, lateral=None):
    return along("umbilicus", "pubic-symphysis", n, DOWN, **({"lateral": cun(lateral, LAT)} if lateral else {}))
def at_umbilicus(lateral):
    return landmark("umbilicus", lateral=cun(lateral, LAT))
UP_TOL, DOWN_TOL = cun(0.3, UP), cun(0.3, DOWN)
for n, pid in [(4, "CV3"), (3, "CV4"), (2, "CV5"), (1.5, "CV6"), (1, "CV7")]:
    LOCALISE[pid] = ("abdomen", below(n), DOWN_TOL)
for n, pid in [(1, "CV9"), (2, "CV10"), (3, "CV11"), (4, "CV12"), (5, "CV13"), (6, "CV14")]:
    LOCALISE[pid] = ("abdomen", above(n), UP_TOL)
LOCALISE["CV2"] = ("abdomen", landmark("pubic-symphysis"), DOWN_TOL)
LOCALISE["CV15"] = ("abdomen", along("xiphisternal-junction", "umbilicus", 1, UP), UP_TOL)
for n, pid in [(5, "KI11"), (4, "KI12"), (3, "KI13"), (2, "KI14"), (1, "KI15")]:
    LOCALISE[pid] = ("abdomen", below(n, 0.5), DOWN_TOL)
LOCALISE["KI16"] = ("abdomen", at_umbilicus(0.5), UP_TOL)
for n, pid in [(2, "KI17"), (3, "KI18"), (4, "KI19"), (5, "KI20"), (6, "KI21")]:
    LOCALISE[pid] = ("abdomen", above(n, 0.5), UP_TOL)
for n, pid in [(6, "ST19"), (5, "ST20"), (4, "ST21"), (3, "ST22"), (2, "ST23"), (1, "ST24")]:
    LOCALISE[pid] = ("abdomen", above(n, 2), UP_TOL)
LOCALISE["ST25"] = ("abdomen", at_umbilicus(2), UP_TOL)
for n, pid in [(1, "ST26"), (2, "ST27"), (3, "ST28"), (4, "ST29")]:
    LOCALISE[pid] = ("abdomen", below(n, 2), DOWN_TOL)
LOCALISE.update({
    "ST30": ("abdomen", landmark("pubic-symphysis", lateral=cun(2, LAT)), DOWN_TOL),
    "LR12": ("abdomen", landmark("pubic-symphysis", lateral=cun(2.5, LAT)), DOWN_TOL),
    "SP12": ("abdomen", landmark("inguinal-crease-{side}", lateral=cm(1.0)), cm(0.8)),
    "SP13": ("abdomen", below(4.3, 4), DOWN_TOL),
    "SP14": ("abdomen", below(1.3, 4), DOWN_TOL),
    "SP15": ("abdomen", at_umbilicus(4), UP_TOL),
    "SP16": ("abdomen", above(3, 4), UP_TOL),
    "EX-CA1": ("abdomen", below(4, 3), DOWN_TOL),
    "GB25": ("abdomen", landmark("rib12-tip-{side}", caudal=cm(1.0)), cm(1.0)),
    "GB26": ("abdomen", landmark("lateral-umbilical-{side}"), cm(1.0)),
    "GB27": ("abdomen", landmark("asis-{side}", medial=cm(1.5), caudal=cm(1.0)), cm(1.0)),
    "GB28": ("abdomen", landmark("asis-{side}", medial=cm(2.5), caudal=cm(2.0)), cm(1.0)),
    "LR13": ("abdomen", landmark("rib11-tip-{side}", caudal=cm(0.8)), cm(1.0)),
})

# upper back: the spinous processes (inferior borders) and the scapulae; 1.5 and 3 B-cun lines on the scapular scale
BACK = "seg.scapulae"
BACK_TOL = cun(0.4, BACK)
inner = {"BL11": 1, "BL12": 2, "BL13": 3, "BL14": 4, "BL15": 5, "BL16": 6, "BL17": 7, "BL18": 9, "BL19": 10, "BL20": 11, "BL21": 12, "EX-B3": 8}
outer = {"BL41": 2, "BL42": 3, "BL43": 4, "BL44": 5, "BL45": 6, "BL46": 7, "BL47": 9, "BL48": 10, "BL49": 11, "BL50": 12}
for pid, t in inner.items():
    LOCALISE[pid] = ("upper-back", landmark(f"t{t}-spinous", lateral=cun(1.5, BACK)), BACK_TOL)
for pid, t in outer.items():
    LOCALISE[pid] = ("upper-back", landmark(f"t{t}-spinous", lateral=cun(3, BACK)), BACK_TOL)
for pid, t in {"GV6": 11, "GV7": 10, "GV8": 9, "GV9": 7, "GV10": 6, "GV11": 5, "GV12": 3, "GV13": 1}.items():
    LOCALISE[pid] = ("upper-back", landmark(f"t{t}-spinous", caudal=cm(0.6)), cm(0.6))
LOCALISE.update({
    "TE15": ("upper-back", landmark("scapula-superior-angle-{side}", cranial=cm(0.8)), cm(1.0)),
    "SI11": ("upper-back", between("scapula-spine-mid-{side}", "scapula-inferior-angle-{side}", 1 / 3), cm(1.0)),
    "SI12": ("upper-back", landmark("scapula-spine-mid-{side}", cranial=cm(1.5)), cm(1.0)),
    "SI13": ("upper-back", landmark("scapula-spine-medial-{side}", cranial=cm(1.0)), cm(1.0)),
    "SI14": ("upper-back", landmark("t1-spinous", lateral=cun(3, BACK)), BACK_TOL),
    "SI15": ("upper-back", landmark("c7-spinous", lateral=cun(2, BACK), caudal=cm(0.8)), BACK_TOL),
})

# lumbar: the levels the lumbar region gains (L1, L5)
LOCALISE.update({
    "BL22": ("lumbar", landmark("l1-spinous", lateral=cun(1.5, BACK)), BACK_TOL),
    "BL26": ("lumbar", landmark("l5-spinous", lateral=cun(1.5, BACK)), BACK_TOL),
    "BL51": ("lumbar", landmark("l1-spinous", lateral=cun(3, BACK)), BACK_TOL),
    "EX-B4": ("lumbar", landmark("l1-spinous", lateral=cun(3.5, BACK)), cun(0.5, BACK)),
    "GV5": ("lumbar", landmark("l1-spinous", caudal=cm(0.6)), cm(0.6)),
    "EX-B8": ("lumbar", landmark("l5-spinous", caudal=cm(0.6)), cm(0.6)),
})

# sacrum and buttocks
SAC = "seg.back"
SAC_TOL = cun(0.4, SAC)
for k, pid in [(1, "BL31"), (2, "BL32"), (3, "BL33"), (4, "BL34")]:
    LOCALISE[pid] = ("sacrum-buttock", landmark(f"s{k}-foramen-{{side}}"), cm(0.6))
for k, pid in [(1, "BL27"), (2, "BL28"), (3, "BL29"), (4, "BL30")]:
    LOCALISE[pid] = ("sacrum-buttock", landmark(f"sacral-crest-s{k}", lateral=cun(1.5, SAC)), SAC_TOL)
LOCALISE.update({
    "BL53": ("sacrum-buttock", landmark("sacral-crest-s2", lateral=cun(3, SAC)), SAC_TOL),
    "BL54": ("sacrum-buttock", landmark("sacral-crest-s4", lateral=cun(3, SAC)), SAC_TOL),
    "BL35": ("sacrum-buttock", landmark("coccyx-tip", lateral=cun(0.5, SAC)), cm(0.6)),
    "GV2": ("sacrum-buttock", landmark("sacral-hiatus"), cm(0.6)),
    "EX-B9": ("sacrum-buttock", along("coccyx-tip", "sacral-crest-s1", 2, SAC), cm(0.8)),
    "GB30": ("sacrum-buttock", between("greater-trochanter-{side}", "sacral-hiatus", 1 / 3), cm(1.5)),
    "GB29": ("sacrum-buttock", between("asis-{side}", "greater-trochanter-{side}", 0.5), cm(1.2)),
})

# front of the neck
NECK_TOL = cm(0.6)
LOCALISE.update({
    "ST9": ("neck-anterior", landmark("scm-anterior-thyroid-{side}"), NECK_TOL),
    "ST10": ("neck-anterior", landmark("scm-anterior-cricoid-{side}"), NECK_TOL),
    "ST11": ("neck-anterior", landmark("scm-heads-{side}"), NECK_TOL),
    "ST12": ("neck-anterior", landmark("greater-supraclavicular-fossa-{side}"), cm(0.8)),
    "LI18": ("neck-anterior", between("scm-anterior-thyroid-{side}", "scm-posterior-thyroid-{side}", 0.5), NECK_TOL),
    "LI17": ("neck-anterior", landmark("scm-posterior-cricoid-{side}"), NECK_TOL),
    "SI16": ("neck-anterior", landmark("scm-posterior-thyroid-{side}", lateral=cm(0.5)), NECK_TOL),
    "SI17": ("neck-anterior", landmark("mandible-angle-{side}", lateral=cm(1.0), caudal=cm(0.5)), NECK_TOL),
    "TE16": ("neck-anterior", landmark("scm-posterior-angle-{side}"), NECK_TOL),
    "CV22": ("neck-anterior", landmark("suprasternal-notch", cranial=cm(0.5)), NECK_TOL),
    "CV23": ("neck-anterior", landmark("hyoid", cranial=cm(0.8)), NECK_TOL),
})


# Group points located site by site. Jiaji: 0.5 B-cun lateral to the lower border of each spinous process from T1 to L5
# (T1-T12 on the upper back, L1-L5 on the lumbar chart; the back's B-cun from between the medial scapular borders).
SITES = {
    "EX-B2": ("upper-back", [
        *[(f"t{n}", f"level of T{n}", None, landmark(f"t{n}-spinous", lateral=cun(0.5, BACK)), cm(0.5)) for n in range(1, 13)],
        *[(f"l{n}", f"level of L{n}", "lumbar", landmark(f"l{n}-spinous", lateral=cun(0.5, BACK)), cm(0.5)) for n in range(1, 6)],
    ]),
}
