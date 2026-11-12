"""Placements of the head and face points on the regional models face, scalp, head-lateral and neck-shoulder
(content/regions). Merged by tools/content/acupoints.py; each entry is (region, localisation, tolerance[, configuration]).

Every construction follows the point's paraphrased standard location with the landmarks and proportional measurements
(B-cun) of its region. Where the standard uses a finger-breadth (F-cun) or a relation the methods cannot express (the
level of one landmark on the vertical line of another), the offset is given in centimetres on the reference adult and
says so below. Unreviewed, AI-assisted placements: check them against the standard before teaching use.

Chart conventions (docs/ANATOMY.md and each region's chart description):
  face          midline; u from the anterior median line (+ left), v cranial from the glabella
  scalp         midline; u along the transverse arc (+ left), v along the median arc from the anterior hairline,
                positive backwards over the vertex ('cranial' = away from the forehead)
  head-lateral  bilateral; u from the tragus, positive POSTERIOR ('lateral' = backwards, 'medial' = towards the face),
                v cranial from the level of the tragus
  neck-shoulder midline, seen from behind; 'medial' is towards the posterior median line, so 'posterior to the
                mastoid' is medial and 'anterior to the mastoid' (round the side of the neck) is lateral

Not placed: EX-HN9 to EX-HN13 and GV28 lie on mucosa (nose, tongue, mouth), which is not modelled.
"""


def along(frm, toward, distance, **offset):
    loc = {"method": "along", "from": frm, "toward": toward, "distance": distance}
    if offset:
        loc["offset"] = offset
    return loc


def landmark(lm, **offset):
    loc = {"method": "landmark", "landmark": lm}
    if offset:
        loc["offset"] = offset
    return loc


def between(a, b, fraction, **offset):
    loc = {"method": "between", "a": a, "b": b, "fraction": round(fraction, 4)}
    if offset:
        loc["offset"] = offset
    return loc


def cm(x):
    return {"cm": x}


def cun(x, segment):
    return {"cun": round(x, 4), "segment": segment}


FACE_SEG = "seg.glabella-hairline"   # glabella to the anterior hairline: 3 B-cun (face and head-lateral)
SAG = "seg.hairlines"                # anterior to posterior hairline over the vertex: 12 B-cun (scalp)
TRANS = "seg.st8"                    # between the two corners of the forehead (ST8): 9 B-cun (scalp)
MASTOIDS = "seg.mastoids"            # between the mastoid processes: 9 B-cun (neck-shoulder)
NAPE = "seg.hairline-c7"             # posterior hairline to the C7 spinous process: 3 B-cun (neck-shoulder)
BACK = "seg.scapulae"                # between the medial borders of the scapulae: 6 B-cun (neck-shoulder)

AH, PH = "anterior-hairline", "posterior-hairline"


def scalp_median(n):
    """A point on the anterior median line, n B-cun behind the anterior hairline."""
    return ("scalp", along(AH, PH, cun(n, SAG)), cun(0.3, SAG))


def scalp_posterior_median(n):
    """A point on the posterior median line, n B-cun above the posterior hairline."""
    return ("scalp", along(PH, AH, cun(n, SAG)), cun(0.3, SAG))


def bladder_line(n):
    """BL4 to BL8: n B-cun behind the anterior hairline, 1.5 B-cun lateral to the median line."""
    return ("scalp", landmark(AH, lateral=cun(1.5, TRANS), cranial=cun(n, SAG)), cun(0.3, SAG))


def pupil_line(n):
    """GB15 to GB18 and EX-HN2: n B-cun behind the anterior hairline, directly above the pupil."""
    return ("scalp", landmark("anterior-hairline-pupil-{side}", cranial=cun(n, SAG)), cun(0.3, SAG))


def st8_gb7(f):
    """GB4 to GB6: a fraction f of the line from ST8 (0.5 B-cun inside the corner of the forehead) to GB7, drawn as
    the straight chord on the chart: between the corner and GB7, raised by the remaining share of ST8's 0.5 B-cun."""
    return ("head-lateral", between("frontal-hairline-corner", "temporal-hairline-posterior", f, cranial=cun((1 - f) * 0.5, FACE_SEG)), cun(0.3, FACE_SEG))


def gb9_gb12(f):
    """GB10, GB11: a fraction f of the line from GB9 (2 B-cun above the posterior border of the auricular root) down to
    GB12 (the depression posteroinferior to the mastoid process)."""
    return ("head-lateral", between("auricular-root-posterior", "mastoid-posteroinferior-depression", f, cranial=cun((1 - f) * 2, FACE_SEG)), cun(0.3, FACE_SEG))


def te17_te20(f, bow):
    """TE18, TE19: a fraction f of the curved line from TE17 (behind the ear lobe) to TE20 (0.4 cm above the auricular
    apex) along the auricular root; the line bows backwards round the root by `bow` cm."""
    return ("head-lateral", between("earlobe-depression", "auricular-apex", f, lateral=cm(bow), cranial=cm(round(0.4 * f, 2))), cm(0.5))


LOCALISE = {
    # --- scalp: anterior median line (GV), bladder line (1.5 B-cun) and pupil line -------------------------------
    "GV24": scalp_median(0.5),
    "GV23": scalp_median(1),
    "GV22": scalp_median(2),
    "GV21": scalp_median(3.5),
    "GV20": scalp_median(5),
    "GV19": scalp_posterior_median(5.5),
    "GV18": scalp_posterior_median(4),
    # EX-HN1 is four sites, 1 B-cun anterior, posterior and to either side of GV20. The engine holds one reference
    # location per point, so the group is localised at its centre with a tolerance that admits each of the four sites
    # (and, unavoidably, GV20 itself): the needles still go 1 B-cun from it, as the location text says.
    "BL3": ("scalp", landmark("anterior-hairline-brow-medial-{side}", cranial=cun(0.5, SAG)), cun(0.3, SAG)),
    "BL4": bladder_line(0.5),
    "BL5": bladder_line(1),
    "BL6": bladder_line(2.5),
    "BL7": bladder_line(4),
    "BL8": bladder_line(5.5),
    "GB13": ("scalp", landmark(AH, lateral=cun(3, TRANS), cranial=cun(0.5, SAG)), cun(0.3, SAG)),
    "GB15": pupil_line(0.5),
    "EX-HN2": pupil_line(1),
    "GB16": pupil_line(1.5),
    "GB17": pupil_line(2.5),
    "GB18": pupil_line(4),
    "ST8": ("scalp", landmark("frontal-hairline-corner-{side}", cranial=cun(0.5, SAG)), cun(0.3, SAG)),

    # --- face ------------------------------------------------------------------------------------------------------
    "Yintang": ("face", between("eyebrow-medial-left", "eyebrow-medial-right", 0.5), cm(0.5)),
    "BL2": ("face", landmark("eyebrow-medial-{side}"), cm(0.4)),
    "EX-HN4": ("face", landmark("eyebrow-middle-{side}"), cm(0.4)),
    "GB14": ("face", landmark("eyebrow-middle-{side}", cranial=cun(1, FACE_SEG)), cun(0.3, FACE_SEG)),
    "TE23": ("face", landmark("eyebrow-lateral-{side}"), cm(0.4)),
    "GB1": ("face", landmark("canthus-outer-{side}", lateral=cun(0.5, FACE_SEG)), cm(0.4)),
    # one finger-breadth behind the midpoint between the end of the eyebrow and the outer canthus: about 1.8 cm
    "EX-HN5": ("face", between("eyebrow-lateral-{side}", "canthus-outer-{side}", 0.5, lateral=cm(1.8)), cm(0.6)),
    # orbital points: in the orbit, a few millimetres from the eyeball (see the EYE note in acupoints.py)
    "BL1": ("face", landmark("canthus-inner-{side}", medial=cm(0.2), cranial=cm(0.2)), cm(0.3)),
    "ST1": ("face", landmark("infraorbital-margin-pupil-{side}", cranial=cm(0.25)), cm(0.3)),
    "EX-HN7": ("face", between("infraorbital-margin-medial-{side}", "infraorbital-margin-lateral-{side}", 0.75), cm(0.35)),
    "ST2": ("face", landmark("infraorbital-foramen-{side}"), cm(0.4)),
    # directly below the pupil at the level of the lower border of the ala: 3.95 cm below the pupil on the reference
    # adult (the methods cannot take the level of one landmark on the vertical line of another)
    "ST3": ("face", landmark("pupil-{side}", caudal=cm(3.95)), cm(0.5)),
    "SI18": ("face", landmark("zygoma-lower-border-{side}", caudal=cm(0.4)), cm(0.5)),
    "EX-HN8": ("face", landmark("nasal-bone-lower-end-{side}"), cm(0.4)),
    "LI20": ("face", landmark("ala-lateral-{side}", lateral=cm(0.5)), cm(0.4)),
    "GV25": ("face", landmark("nose-tip"), cm(0.3)),
    "GV26": ("face", between("subnasale", "philtrum-lower", 1 / 3), cm(0.3)),
    # level with GV26, below the lateral margin of the nostril (about 1 cm from the median line)
    "LI19": ("face", between("subnasale", "philtrum-lower", 1 / 3, lateral=cm(1.05)), cm(0.4)),
    "GV27": ("face", landmark("upper-lip-tubercle"), cm(0.3)),
    # 0.4 F-cun lateral to the angle of the mouth: about 0.8 cm
    "ST4": ("face", landmark("mouth-angle-{side}", lateral=cm(0.8)), cm(0.4)),
    "CV24": ("face", landmark("mentolabial-sulcus"), cm(0.4)),

    # --- side of the head: in front of the ear (found with the mouth open), the cheek and the jaw ---------------------
    "SI19": ("head-lateral", landmark("tragus", medial=cm(0.5)), cm(0.4)),
    "TE21": ("head-lateral", landmark("supratragic-notch", medial=cm(0.65)), cm(0.4)),
    "GB2": ("head-lateral", landmark("intertragic-notch", medial=cm(0.75)), cm(0.4)),
    "ST7": ("head-lateral", between("zygomatic-arch-midpoint", "mandibular-notch", 0.6), cm(0.5)),
    "GB3": ("head-lateral", landmark("zygomatic-arch-midpoint", cranial=cm(0.8)), cm(0.5)),
    # one finger-breadth (middle finger) anterosuperior to the angle of the mandible: about 1.3 cm forwards and up
    "ST6": ("head-lateral", landmark("mandibular-angle", medial=cm(1.3), cranial=cm(1.3)), cm(0.6)),
    "ST5": ("head-lateral", landmark("masseter-anterior-border"), cm(0.5)),
    "TE22": ("head-lateral", landmark("auricular-root-anterior", medial=cm(0.6)), cm(0.4)),
    # --- side of the head: the temple and round the ear ----------------------------------------------------------------
    "GB7": ("head-lateral", landmark("temporal-hairline-posterior"), cm(0.5)),
    "GB4": st8_gb7(0.25),
    "GB5": st8_gb7(0.5),
    "GB6": st8_gb7(0.75),
    "TE20": ("head-lateral", landmark("auricular-apex", cranial=cm(0.4)), cm(0.4)),
    "EX-HN6": ("head-lateral", landmark("auricular-apex"), cm(0.3)),
    "GB8": ("head-lateral", landmark("auricular-apex", cranial=cun(1.5, FACE_SEG)), cun(0.3, FACE_SEG)),
    "GB9": ("head-lateral", landmark("auricular-root-posterior", cranial=cun(2, FACE_SEG)), cun(0.3, FACE_SEG)),
    "GB10": gb9_gb12(1 / 3),
    "GB11": gb9_gb12(2 / 3),
    "TE19": te17_te20(2 / 3, 0.9),
    "TE18": te17_te20(1 / 3, 0.7),

    # --- neck-shoulder: the occiput, the nape and behind the ear (seen from behind) ----------------------------------
    "GV17": ("neck-shoulder", landmark("occipital-protuberance-superior", cranial=cm(0.5)), cm(0.5)),
    "BL9": ("neck-shoulder", landmark("occipital-protuberance-superior", lateral=cun(1.3, MASTOIDS)), cm(0.6)),
    # directly above GB20 at the level of the superior border of the external occipital protuberance: 3.3 cm above
    # GB20 on the reference adult
    "GB19": ("neck-shoulder", landmark("gb20-depression-{side}", cranial=cm(3.3)), cm(0.6)),
    "GV15": ("neck-shoulder", landmark("c2-spinous", cranial=cm(0.5)), cm(0.5)),
    # level with the upper border of the C2 spinous process, lateral to trapezius: 1.3 B-cun from the median line
    "BL10": ("neck-shoulder", landmark("c2-spinous", lateral=cun(1.3, MASTOIDS)), cm(0.6)),
    "GB12": ("neck-shoulder", landmark("mastoid-{side}", medial=cm(1.0), caudal=cm(0.5)), cm(0.5)),
    "TE17": ("neck-shoulder", landmark("earlobe-depression-{side}"), cm(0.5)),
    "EX-HN14": ("neck-shoulder", landmark("earlobe-depression-{side}", medial=cun(1, MASTOIDS)), cun(0.3, MASTOIDS)),
    "EX-HN15": ("neck-shoulder", landmark("c7-spinous", cranial=cun(2, NAPE), lateral=cun(1, BACK)), cun(0.4, BACK)),
}


# Group points located site by site (each its own target; never at the centre of the group). On the midline scalp chart
# `lateral` points to the patient's left and `medial` to the right.
SITE_TOL = cun(0.3, SAG)
SITES = {
    # Sishencong: 1 B-cun anterior, posterior and either side of GV20 (5 B-cun behind the anterior hairline)
    "EX-HN1": ("scalp", [
        ("anterior", "1 B-cun anterior to GV20", None, along(AH, PH, cun(4, SAG)), SITE_TOL),
        ("posterior", "1 B-cun posterior to GV20", None, along(AH, PH, cun(6, SAG)), SITE_TOL),
        ("left", "1 B-cun to the left of GV20", None, along(AH, PH, cun(5, SAG), lateral=cun(1, SAG)), SITE_TOL),
        ("right", "1 B-cun to the right of GV20", None, along(AH, PH, cun(5, SAG), medial=cun(1, SAG)), SITE_TOL),
    ]),
}
