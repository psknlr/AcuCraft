"""Writes the acupoint library: every point of the WHO standard (2008, 361 points on 14 channels) and the 48 extra
points of the WHO standard nomenclature (1991), one file per channel in content/acupoints/.

    python3 tools/content/acupoints.py

Sources merged, in order:
  points_arm.py, points_leg.py, points_mid.py   names, body area and a paraphrased location for every point
  acupoint_detail.json                          hand-written detail of the points first authored for the families
                                                (their text, localisation, tolerance, cautions and notes win)
  LOCALISE, PREGNANCY, NOTES below              placements on the modelled regions, risk-factor cautions and
                                                safety notes for points without hand-written detail

Every entry is an unreviewed, AI-assisted paraphrase: check it against the standard before teaching use. Points
outside the modelled regions are definitions only: they can be looked up, planned and discussed, but not needled
until their region is modelled.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import ROOT, dump  # noqa: E402
from points_arm import ARM  # noqa: E402
from points_leg import LEG  # noqa: E402
from points_mid import EX, MID  # noqa: E402

VERSION = "0.2.0"
WHO2008 = "who-wpro-2008"
WHO1991 = "who-1991-nomenclature"
GBT = "gb-t-12346-2021"
ORDER = ["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR", "GV", "CV"]
# older or alternative channel abbreviations, kept as aliases (TE5 = SJ5)
ALT = {"TE": "SJ", "LR": "LIV", "GV": "DU", "CV": "REN"}

PROVENANCE = {
    "sources": [{"title": "WHO Standard Acupuncture Point Locations in the Western Pacific Region (2008)", "publisher": "WHO WPRO", "verified": False, "note": "Location paraphrased; check against the standard."}],
    "review": {"status": "unreviewed", "reviewers": [], "notes": "AI-assisted paraphrase; requires review by a qualified acupuncture educator."},
}
PROVENANCE_EX = {
    "sources": [{"title": "A Proposed Standard International Acupuncture Nomenclature (WHO, 1991): extra points", "publisher": "WHO", "verified": False, "note": "Extra-point code and name; location paraphrased from common usage, check against GB/T 40997-2021 or the reviewer's reference."}],
    "review": PROVENANCE["review"],
}

# ---------------------------------------------------------------------------------------------------------------
# Placements on the modelled regions (content/regions), for points without hand-written detail. Each follows the
# standard's construction from landmarks the region already models; nothing here adds a landmark.
# ---------------------------------------------------------------------------------------------------------------

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

def cm(x):
    return {"cm": x}

def cun(x, segment):
    return {"cun": x, "segment": segment}

LEG_SEG = "seg.knee-ankle-lateral"      # ST35 to the lateral malleolus: 16 B-cun
TIB_SEG = "seg.sp9-medial-malleolus"    # SP9 to the medial malleolus: 13 B-cun
ARM_SEG = "seg.wrist-elbow"             # palmar wrist crease to cubital crease: 12 B-cun
BACK_SEG = "seg.scapulae"               # medial borders of the scapulae: 6 B-cun

LOCALISE = {
    # leg, stomach channel: on the ST35-ST41 line
    "ST37": ("knee-leg", along("st35-depression", "ankle-anterior-midpoint", 6, LEG_SEG), cun(0.4, LEG_SEG)),
    "ST38": ("knee-leg", along("st35-depression", "ankle-anterior-midpoint", 8, LEG_SEG), cun(0.4, LEG_SEG)),
    "ST39": ("knee-leg", along("st35-depression", "ankle-anterior-midpoint", 9, LEG_SEG), cun(0.4, LEG_SEG)),
    "ST41": ("knee-leg", landmark("ankle-anterior-midpoint"), cm(0.6)),
    "EX-LE7": ("knee-leg", along("st35-depression", "ankle-anterior-midpoint", 5, LEG_SEG), cun(0.5, LEG_SEG)),
    # leg, gallbladder channel: along the fibula from the lateral malleolus; on this chart anterior to the fibula is
    # 'medial' (towards the tibial crest) and posterior is 'lateral' (further round the limb)
    "GB35": ("knee-leg", along("lateral-malleolus", "fibular-head", 7, LEG_SEG, lateral=cm(0.8)), cun(0.5, LEG_SEG)),
    "GB36": ("knee-leg", along("lateral-malleolus", "fibular-head", 7, LEG_SEG, medial=cm(0.6)), cun(0.5, LEG_SEG)),
    "GB37": ("knee-leg", along("lateral-malleolus", "fibular-head", 5, LEG_SEG, medial=cm(0.6)), cun(0.4, LEG_SEG)),
    "GB38": ("knee-leg", along("lateral-malleolus", "fibular-head", 4, LEG_SEG, medial=cm(0.6)), cun(0.4, LEG_SEG)),
    "GB39": ("knee-leg", along("lateral-malleolus", "fibular-head", 3, LEG_SEG, medial=cm(0.6)), cun(0.4, LEG_SEG)),
    # leg, spleen and liver channels: the line from the medial malleolus to SP9 follows the medial border of the
    # tibia; posterior to it is 'medial', the medial surface of the tibia 'lateral' (towards the crest)
    "SP7": ("knee-leg", along("medial-malleolus", "medial-condyle-inferior", 6, TIB_SEG, medial=cm(0.5)), cun(0.4, TIB_SEG)),
    "SP8": ("knee-leg", along("medial-condyle-inferior", "medial-malleolus", 3, TIB_SEG, medial=cm(0.5)), cun(0.4, TIB_SEG)),
    "LR5": ("knee-leg", along("medial-malleolus", "medial-condyle-inferior", 5, TIB_SEG, lateral=cm(2.5)), cun(0.5, TIB_SEG)),
    "LR6": ("knee-leg", along("medial-malleolus", "medial-condyle-inferior", 7, TIB_SEG, lateral=cm(2.5)), cun(0.5, TIB_SEG)),
    # lumbar region
    "BL24": ("lumbar", landmark("l3-spinous", lateral=cun(1.5, BACK_SEG)), cun(0.4, BACK_SEG)),
    "EX-B5": ("lumbar", landmark("l3-spinous", caudal=cm(0.6)), cm(0.6)),
    "EX-B6": ("lumbar", landmark("l4-spinous", lateral=cun(3, BACK_SEG)), cun(0.5, BACK_SEG)),
    "EX-B7": ("lumbar", landmark("l4-spinous", lateral=cun(3.5, BACK_SEG)), cun(0.5, BACK_SEG)),
    # forearm: between the palmaris longus and flexor carpi radialis tendons, from the wrist crease
    "PC7": ("forearm", landmark("pl-fcr-wrist"), cm(0.5)),
    "PC5": ("forearm", along("pl-fcr-wrist", "cubital-crease-mid", 3, ARM_SEG), cun(0.3, ARM_SEG)),
    "PC4": ("forearm", along("pl-fcr-wrist", "cubital-crease-mid", 5, ARM_SEG), cun(0.3, ARM_SEG)),
    # dorsum of the hand: proximal is 'cranial'
    "LI3": ("hand-dorsum", landmark("mc2-head", cranial=cm(0.5)), cm(0.5)),
    # back of the neck
    "GV16": ("neck-shoulder", {"method": "between", "a": "gb20-depression-left", "b": "gb20-depression-right", "fraction": 0.5}, cm(0.6)),
    "EX-B1": ("neck-shoulder", landmark("c7-spinous", caudal=cm(1.0), lateral=cun(0.5, BACK_SEG)), cm(0.5)),
}

# ---------------------------------------------------------------------------------------------------------------
# Cautions by risk factor. Pregnancy: the points traditionally avoided (LI4, SP6, BL60, BL67, GB21), the lower
# abdomen (at and below the umbilicus) and the lumbosacral region (from L2 down), following the choices already made
# for the families. Local practice and the obstetric team decide; the engine flags needling at these locations.
# ---------------------------------------------------------------------------------------------------------------

DISTAL = ["LI4", "SP6", "BL60", "BL67", "GB21"]
LOWER_ABDOMEN = ["CV2", "CV3", "CV4", "CV5", "CV6", "CV7", "ST25", "ST26", "ST27", "ST28", "ST29", "ST30", "KI11", "KI12", "KI13", "KI14", "KI15", "KI16", "SP13", "SP14", "SP15", "GB26", "GB27", "GB28", "EX-CA1"]
LUMBOSACRAL = [f"BL{n}" for n in range(23, 36)] + ["BL52", "BL53", "BL54", "GV2", "GV3", "GV4", "EX-B5", "EX-B6", "EX-B7", "EX-B8", "EX-B9"]
PREGNANCY = {**{p: "Traditionally avoided in pregnancy." for p in DISTAL},
             **{p: "Lower abdominal points: traditionally avoided in pregnancy." for p in LOWER_ABDOMEN},
             **{p: "Lumbosacral points: follow local practice in pregnancy." for p in LUMBOSACRAL}}

# ---------------------------------------------------------------------------------------------------------------
# Safety notes (public teaching knowledge: what lies beneath, what is not needled). Depths are deliberately not
# given: safe depth depends on the patient's build and must come from reviewed teaching.
# ---------------------------------------------------------------------------------------------------------------

LUNG = "The pleura and lung lie beneath: needle obliquely or transversely and shallowly; deep perpendicular needling risks pneumothorax, especially in slim patients."
SPINE = "The spinal canal lies deep to the interspinous space: needle obliquely upward and shallowly."
NECK = "The carotid sheath and the great vessels of the neck lie close: needle shallowly and avoid the pulsating artery."
EYE = "Between the eyeball and the orbit: needle slowly along the orbital margin without lifting, thrusting or rotating; risk of haematoma and of injury to the eye. Requires specific training."
MEDULLA = "The medulla oblongata lies deep: never needle deeply or upward; direct the needle towards the chin."
SCIATIC = "The sciatic nerve lies deep: an electric sensation down the leg means the needle has reached it."
KIDNEY = "The kidney lies deep: no deep perpendicular needling."
BLADDER = "The bladder lies beneath: ask the patient to empty it first."
FEMORAL = "The femoral vessels lie close: palpate and avoid the artery."

NOTES = {
    **{p: LUNG for p in ["LU1", "LU2", "ST12", "ST13", "ST14", "ST15", "ST16", "ST18", "SP17", "SP18", "SP19", "SP20", "SP21", "KI22", "KI23", "KI24", "KI25", "KI26", "KI27", "PC1", "GB22", "GB23", "GB24", "LR14", "SI13", "SI14", "SI15", "TE15", "EX-B3"]
         + [f"BL{n}" for n in range(11, 22)] + [f"BL{n}" for n in range(41, 51)]},
    **{p: SPINE for p in ["GV5", "GV6", "GV7", "GV8", "GV9", "GV10", "GV11", "GV12", "GV13", "EX-B5", "EX-B8"]},
    **{p: NECK for p in ["ST10", "ST11", "LI17", "LI18", "SI16", "SI17", "TE16"]},
    **{p: EYE for p in ["ST1", "BL1", "EX-HN7"]},
    **{p: SCIATIC for p in ["GB30", "BL36", "BL54"]},
    **{p: KIDNEY for p in ["BL22", "BL51", "GB25", "EX-B4"]},
    **{p: BLADDER for p in ["CV2", "CV3"]},
    **{p: FEMORAL for p in ["ST30", "SP11", "SP12", "LR10", "LR11", "LR12"]},
    "ST9": "Over the common carotid artery: displace the artery and needle shallowly; never deep.",
    "ST17": "Used as a landmark only: not needled.",
    "ST42": "Over the dorsalis pedis artery: palpate and avoid it.",
    "LU8": "The radial artery lies just ulnar: palpate and avoid it.",
    "LU9": "Beside the radial artery: palpate and avoid it.",
    "HT1": "Over the axillary artery: palpate and avoid it.",
    "PC3": "The brachial artery lies just medial to the biceps tendon: palpate and avoid it.",
    "PC7": "The median nerve lies directly beneath: an electric sensation means the needle has reached it.",
    "SI8": "Over the ulnar nerve in its groove: an electric sensation means the needle has reached it.",
    "BL10": "The medulla and the vertebral artery lie deep and medial: never needle deeply, medially or upward.",
    "GV15": MEDULLA,
    "GV16": MEDULLA,
    "GV1": "Needle between the tip of the coccyx and the rectum, close to the sacrum; do not puncture the rectum.",
    "GV22": "Not needled in infants before the anterior fontanelle has closed.",
    "CV1": "A perineal point: rarely needled; requires explicit consent and a chaperone.",
    "CV8": "Not needled: moxibustion only (traditionally on salt or ginger).",
    "CV14": "The liver lies beneath (and the heart above it): no deep needling, particularly with an enlarged liver.",
    "CV15": "Just below the xiphoid process: deep or upward needling may reach the liver or the heart.",
    "CV17": "A congenital sternal foramen may lie beneath: needle transversely only.",
    "CV22": "The trachea lies beneath and the great vessels behind the manubrium: needle shallowly; deeper insertion, downward behind the manubrium, requires specific training.",
    "LR13": "An enlarged spleen or liver may lie beneath: no deep needling.",
    "LI16": "Deep needling directed medially may reach the apex of the lung.",
    "EX-B1": "The spinal canal lies medial and the apex of the lung lateral and deep: needle shallowly, never medially.",
    "EX-B2": "At thoracic levels the pleura lies lateral and the spinal canal medial: needle shallowly and never towards the midline.",
    "EX-HN9": "On the nasal mucosa: traditionally pricked, not retained.",
    "EX-HN10": "Traditionally pricked, not retained.",
    "EX-HN11": "Traditionally pricked, not retained.",
    "EX-HN12": "Traditionally pricked to bleed, not retained.",
    "EX-HN13": "Traditionally pricked to bleed, not retained.",
    "EX-UE11": "Traditionally pricked to bleed (for example in fever), not retained.",
    "EX-LE12": "Traditionally pricked, not retained.",
    "HT2": "Over the brachial artery and the median nerve in the medial bicipital groove: palpate and avoid them.",
    "LI5": "The radial artery crosses the floor of the anatomical snuffbox: palpate and avoid it.",
    "EX-UE4": "Over the joint, a few millimetres below the skin: traditionally a moxibustion point.",
    "EX-UE5": "Over the joint, a few millimetres below the skin: traditionally a moxibustion point.",
    "EX-UE6": "Over the joint, a few millimetres below the skin: traditionally a moxibustion point.",
    "ST5": "Over the facial artery at the front of the masseter: palpate and avoid it.",
    "SI19": "In front of the temporomandibular joint: needled with the mouth open; angling forward and deep enters the joint.",
    "TE21": "Above the temporomandibular joint, beside the superficial temporal artery: needled with the mouth open.",
    "GB2": "In front of the temporomandibular joint: needled with the mouth open.",
    "TE17": "The facial nerve leaves the skull just deep to it, and the carotid sheath lies deeper still: no deep needling.",
}

# ---------------------------------------------------------------------------------------------------------------

# Placements contributed per body area (tools/content/localise_*.py): each module defines LOCALISE in the same form
# as above, with an optional fourth item, the configuration the standard locates the point in.
def extra_placements():
    """Placements and group-point sites contributed per body area (localise_*.py: LOCALISE, and SITES for group points
    located site by site: {id: (region, [(site, label, region or None, localisation, tolerance[, configuration])])})."""
    import glob, importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    merged, sites = {}, {}
    for path in sorted(glob.glob(os.path.join(here, "localise_*.py"))):
        spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for pid, entry in mod.LOCALISE.items():
            assert pid not in merged and pid not in LOCALISE, f"{pid} placed twice ({os.path.basename(path)})"
            merged[pid] = entry
        for pid, entry in getattr(mod, "SITES", {}).items():
            assert pid not in merged and pid not in LOCALISE and pid not in sites, f"{pid} placed twice ({os.path.basename(path)})"
            sites[pid] = entry
    return merged, sites

def meridian_rows():
    tables = {**ARM, **LEG, **MID}
    for ch in ORDER:
        for (n, pinyin, hanzi, en, area, text) in tables[ch]:
            yield ch, f"{ch}{n}", n, pinyin, hanzi, en, area, text, ch not in ("GV", "CV"), None

def extra_rows():
    for (code, pinyin, hanzi, en, area, text, bilateral, sites) in EX:
        yield "EX", code, None, pinyin, hanzi, en, area, text, bilateral, sites

def build():
    detail = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "acupoint_detail.json")))["points"]
    extra, group_sites = extra_placements()
    placements = {**LOCALISE, **extra}
    by_file = {}
    seen = set()
    for ch, code, n, pinyin, hanzi, en, area, text, bilateral, sites in [*meridian_rows(), *extra_rows()]:
        pid = "Yintang" if code == "EX-HN3" else code  # the families' id for EX-HN3 (reclassified as GV29 in GB/T 12346-2021)
        d = detail.get(pid, {})
        if ch == "EX":
            codes = [{"edition": WHO1991, "code": code, "relation": "same"}, {"edition": WHO2008, "code": code, "relation": "absent", "note": "Extra point: outside the 2008 standard's 361 meridian points."}]
            edition = WHO1991
        else:
            codes = [{"edition": WHO2008, "code": code, "relation": "same"}, {"edition": GBT, "code": code, "relation": "same"}]
            edition = WHO2008
        aliases = list(d.get("aliases", []))
        if ch in ALT:
            aliases.append(f"{ALT[ch]}{n}")
        if pid != code:
            aliases.append(code)
        p = {
            "id": pid,
            "names": d.get("names", {"pinyin": pinyin, "hanzi": hanzi, "en": en}),
            "channel": ch,
            "codes": d.get("codes", codes),
            "aliases": sorted(set(aliases)),
            "location": d.get("location", {"edition": edition, "text": text, "paraphrased": True}),
            "area": area,
        }
        if sites:
            p["sites"] = sites
        if "localisation" in d:
            for k in ("region", "localisation", "configuration"):
                if k in d:
                    p[k] = d[k]
            p["tolerance"] = d["tolerance"]
        elif pid in group_sites:
            region, entries = group_sites[pid]
            assert sites == len(entries), f"{pid}: {sites} sites, {len(entries)} located"
            p["region"] = region
            p["siteLocalisations"] = []
            for site, label, site_region, loc, tol, *rest in entries:
                e = {"id": site, "label": label}
                if site_region and site_region != region:
                    e["region"] = site_region
                e["localisation"], e["tolerance"] = loc, tol
                if rest and rest[0]:
                    e["configuration"] = rest[0]
                p["siteLocalisations"].append(e)
            p["tolerance"] = entries[0][4]
        elif pid in placements:
            region, loc, tol, *rest = placements[pid]
            p["region"], p["localisation"], p["tolerance"] = region, loc, tol
            if rest and rest[0]:
                p["configuration"] = rest[0]
        elif "tolerance" in d:
            p["tolerance"] = d["tolerance"]
        p["bilateral"] = d.get("bilateral", bilateral)
        cautions = list(d.get("cautions", []))
        if pid in PREGNANCY and not any(c["when"] == "pregnancy" for c in cautions):
            cautions.append({"id": f"{pid}-pregnancy", "when": "pregnancy", "text": PREGNANCY[pid], "severity": "major"})
        p["cautions"] = cautions
        note = d.get("notes") or NOTES.get(pid)
        if note:
            p["notes"] = note
        p["provenance"] = PROVENANCE_EX if ch == "EX" else PROVENANCE
        assert pid not in seen, pid
        seen.add(pid)
        by_file.setdefault(ch, []).append(p)
    missing = set(detail) - seen
    assert not missing, f"detail for unknown points: {missing}"
    unknown = (set(placements) | set(group_sites) | set(PREGNANCY) | set(NOTES)) - seen
    assert not unknown, f"unknown points: {unknown}"
    return by_file

def main():
    by_file = build()
    out = os.path.join(ROOT, "content", "acupoints")
    old = os.path.join(out, "core.json")
    if os.path.exists(old):
        os.remove(old)
    for ch, points in by_file.items():
        dump(os.path.join(out, f"{ch.lower()}.json"), {"schema": "acucraft/acupoints@1", "id": f"acucraft-points-{ch.lower()}", "version": VERSION, "points": points})
    total = sum(len(v) for v in by_file.values())
    localised = sum(1 for v in by_file.values() for p in v if "localisation" in p or "siteLocalisations" in p)
    groups = [p for v in by_file.values() for p in v if "siteLocalisations" in p]
    print(f"{total} points in {len(by_file)} files ({localised} localised on the modelled regions; {len(groups)} groups by site: {sum(len(p['siteLocalisations']) for p in groups)} sites)")

if __name__ == "__main__":
    main()
