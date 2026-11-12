"""Placements of the lower-limb points on the regional models (merged by tools/content/acupoints.py).

    LOCALISE = {"POINTID": (region, localisation, tolerance[, configuration]), ...}

Regions (content/regions/):
  thigh     the thigh unrolled round the limb; u from the anterior line (femoral pulse to the middle of the patella),
            positive lateral, the back of the thigh reached round the lateral side; v cranial from the base of the
            patella (knee extended). Cun: seg.symphysis-medial-epicondyle (18 B-cun) for the anterior and medial
            thigh, seg.trochanter-popliteal (19) for the lateral thigh, seg.gluteal-popliteal (14) for the back.
  knee-leg  the knee, leg and ankle round the whole limb (the anterior chart, extended): the posterior midline is
            reached round the lateral (fibular) side, the posteromedial knee and calf round the medial side. Cun:
            seg.popliteal-lateral-malleolus (16) for the back of the leg, seg.sp9-medial-malleolus (13) for the medial
            leg, seg.knee-ankle-lateral (16) for the lateral leg, seg.medial-malleolus-sole (3) below the malleoli.
  foot      the foot distal to the ankle, unrolled round its long axis (dorsum, borders, toes); no B-cun segment:
            depressions, joints and webs are landmarks, short offsets are in cm (0.1 F-cun is taken as 0.15 cm
            proximal and 0.15 cm to the side).
  sole      the sole and the plantar surface of the toes.

Offsets keep each chart's sense: 'lateral' is +u and 'medial' -u whatever the anatomy. On the back of the knee and
leg (reached round the lateral side) 'lateral' therefore means further round, towards the posterior midline; on the
medial side 'medial' means further round, posterior to the tibia, and 'lateral' anterior. On the side of the foot,
'lateral'/'medial' point towards the sole; 'cranial' is proximal on the foot and the sole.

Group points (sites > 1): the first site of the group is placed (EX-LE1 lateral, EX-LE5 medial, EX-LE10 between the
first and second toes, EX-LE12 the great toe); the other sites are not modelled as separate instances.

Every placement is an unreviewed, AI-assisted reading of the paraphrased standard location (WHO 2008; extra points
WHO 1991): check it against the standard before teaching use.
"""


def along(frm, toward, cun, segment, **offset):
    loc = {"method": "along", "from": frm, "toward": toward, "distance": {"cun": cun, "segment": segment}}
    if offset:
        loc["offset"] = offset
    return loc


def between(a, b, fraction, **offset):
    loc = {"method": "between", "a": a, "b": b, "fraction": fraction}
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


SYM = "seg.symphysis-medial-epicondyle"  # upper border of the pubic symphysis to the medial epicondyle: 18 B-cun
TRO = "seg.trochanter-popliteal"         # greater trochanter to the popliteal crease: 19 B-cun
GLU = "seg.gluteal-popliteal"            # gluteal fold to the popliteal crease: 14 B-cun
POP = "seg.popliteal-lateral-malleolus"  # popliteal crease to the lateral malleolus: 16 B-cun
LEG = "seg.knee-ankle-lateral"           # ST35 to the lateral malleolus: 16 B-cun (existing)
TIB = "seg.sp9-medial-malleolus"         # SP9 to the medial malleolus: 13 B-cun (existing)
MAL = "seg.medial-malleolus-sole"        # medial malleolus to the sole: 3 B-cun
NAIL = dict(cranial=cm(0.15))            # 0.1 F-cun proximal to the nail corner (and 0.15 cm to the side)

LOCALISE = {
    # ---- thigh, anterior: the stomach channel on the line from the lateral end of the patellar base to the ASIS ----
    "ST31": ("thigh", landmark("st31-depression"), cun(0.5, SYM)),
    "ST32": ("thigh", along("patella-base-lateral", "asis", 6, SYM), cun(0.5, SYM)),
    "ST33": ("thigh", along("patella-base-lateral", "asis", 3, SYM), cun(0.4, SYM)),
    "ST34": ("thigh", along("patella-base-lateral", "asis", 2, SYM), cun(0.4, SYM)),
    # group point (2 sites): 1.5 B-cun lateral and medial to ST34; the first (lateral) site is placed
    "EX-LE1": ("thigh", along("patella-base-lateral", "asis", 2, SYM, lateral=cun(1.5, SYM)), cun(0.4, SYM)),
    # ---- thigh, medial: spleen and liver channels ---------------------------------------------------------------
    "SP10": ("thigh", landmark("patella-base-medial", cranial=cun(2, SYM)), cun(0.4, SYM)),
    "EX-LE3": ("thigh", landmark("patella-base-medial", cranial=cun(3, SYM)), cun(0.4, SYM)),
    # 4 B-cun above the base, in the groove between sartorius and gracilis: about 8 cm round the medial side
    "LR9": ("thigh", landmark("patella-base-medial", cranial=cun(4, SYM), medial=cm(8.0)), cun(0.5, SYM)),
    # junction of the upper third and lower two thirds of the line from the medial end of the patellar base to SP12
    "SP11": ("thigh", between("patella-base-medial", "point:SP12", 0.6667), cun(0.5, SYM)),
    "LR11": ("thigh", landmark("point:ST30", caudal=cun(2, SYM)), cun(0.4, SYM)),  # ST30 where the abdomen places it, across the seam
    "LR10": ("thigh", landmark("point:ST30", caudal=cun(3, SYM)), cun(0.4, SYM)),
    # ---- thigh, lateral: gallbladder channel behind the iliotibial band, measured up from the popliteal crease ----
    "GB32": ("thigh", along("popliteal-crease-lateral", "greater-trochanter", 7, TRO), cun(0.5, TRO)),
    # the middle-finger-tip point; 9 B-cun above the popliteal crease, 2 B-cun above GB32
    "GB31": ("thigh", along("popliteal-crease-lateral", "greater-trochanter", 9, TRO), cun(0.6, TRO)),
    # ---- thigh, posterior: bladder channel on the line from the middle of the gluteal fold to BL40 ---------------
    "BL36": ("thigh", landmark("gluteal-fold-mid"), cm(0.8)),
    "BL37": ("thigh", along("gluteal-fold-mid", "popliteal-crease-mid", 6, GLU), cun(0.4, GLU)),

    # ---- knee ----------------------------------------------------------------------------------------------------
    "GB33": ("knee-leg", landmark("lateral-supracondylar-depression"), cm(0.7)),
    # group point (2 sites): the knee eyes; the first (medial) site is placed, the lateral one coincides with ST35
    "EX-LE5": ("knee-leg", landmark("medial-knee-eye"), cm(0.6), "knee-flexed"),
    "BL39": ("knee-leg", landmark("popliteal-crease-lateral"), cm(0.6)),
    "BL38": ("knee-leg", landmark("popliteal-crease-lateral", cranial=cun(1, POP)), cun(0.3, POP)),
    "BL40": ("knee-leg", landmark("popliteal-crease-mid"), cm(0.7)),
    "KI10": ("knee-leg", landmark("popliteal-crease-medial"), cm(0.6)),
    "LR8": ("knee-leg", landmark("medial-popliteal-depression"), cm(0.6), "knee-flexed"),
    # ---- leg ---------------------------------------------------------------------------------------------------
    # 1 B-cun posterior to SP9 ('medial' on this chart is posterior on the tibial side)
    "LR7": ("knee-leg", landmark("medial-condyle-inferior", medial=cun(1, TIB)), cun(0.4, TIB)),
    # 2 B-cun below GB34 (GB34 is 1.5 cm, about 0.65 B-cun, below the fibular head and 1.3 cm in front of it)
    "EX-LE6": ("knee-leg", landmark("fibular-head", medial=cm(1.3), caudal=cun(2.65, LEG)), cun(0.5, LEG)),
    "BL55": ("knee-leg", along("popliteal-crease-mid", "gastrocnemius-tendon-junction", 2, POP), cun(0.4, POP)),
    "BL56": ("knee-leg", along("popliteal-crease-mid", "gastrocnemius-tendon-junction", 5, POP), cun(0.4, POP)),
    "BL57": ("knee-leg", landmark("gastrocnemius-tendon-junction"), cm(0.8)),
    # the lower border of the lateral head of gastrocnemius at the calcaneal tendon, about 7 B-cun above BL60
    "BL58": ("knee-leg", landmark("gastrocnemius-lateral-lower-border"), cun(0.5, POP)),
    "BL59": ("knee-leg", between("lateral-malleolus", "calcaneal-tendon-lateral", 0.5, cranial=cun(3, POP)), cun(0.4, POP)),
    # anterior to the calcaneal tendon ('lateral' on the tibial side of this chart is anterior)
    "KI7": ("knee-leg", landmark("calcaneal-tendon-medial", cranial=cun(2, TIB), lateral=cm(0.8)), cun(0.4, TIB)),
    # posterior to the medial border of the tibia, as SP6 (0.5 cm behind the border)
    "KI8": ("knee-leg", along("medial-malleolus", "medial-condyle-inferior", 2, TIB, medial=cm(0.5)), cun(0.4, TIB)),
    "KI9": ("knee-leg", landmark("calcaneal-tendon-medial", cranial=cun(5, TIB)), cun(0.5, TIB)),
    # ---- ankle and heel (knee-leg chart, below and behind the malleoli) ------------------------------------------
    "KI3": ("knee-leg", between("medial-malleolus", "calcaneal-tendon-medial", 0.5), cm(0.6)),
    # just anterior to the medial border of the calcaneal tendon, above the calcaneus
    "KI4": ("knee-leg", between("medial-malleolus", "calcaneal-tendon-medial", 0.8, caudal=cun(0.5, MAL)), cm(0.6)),
    "KI5": ("knee-leg", between("medial-malleolus", "calcaneal-tendon-medial", 0.5, caudal=cun(1, MAL)), cun(0.3, MAL)),
    "KI6": ("knee-leg", along("medial-malleolus", "sole-below-medial-malleolus", 1, MAL), cun(0.3, MAL)),
    "EX-LE8": ("knee-leg", landmark("medial-malleolus"), cm(0.5)),
    "EX-LE9": ("knee-leg", landmark("lateral-malleolus"), cm(0.5)),
    "BL60": ("knee-leg", between("lateral-malleolus", "calcaneal-tendon-lateral", 0.5), cm(0.6)),
    "BL61": ("knee-leg", landmark("heel-lateral-red-white"), cm(0.6)),
    # the depression between the lower border of the lateral malleolus and the calcaneus
    "BL62": ("knee-leg", landmark("lateral-malleolus-tip", caudal=cm(0.6)), cm(0.5)),
    "GB40": ("knee-leg", landmark("lateral-malleolus-anteroinferior-depression"), cm(0.6)),
    # the depression anterior to the medial malleolus, just medial to the tibialis anterior tendon
    "LR4": ("knee-leg", between("medial-malleolus", "tibialis-anterior-tendon-ankle", 0.6), cm(0.6)),
    "SP5": ("knee-leg", between("navicular-tuberosity", "medial-malleolus", 0.5), cm(0.6)),

    # ---- foot: dorsum --------------------------------------------------------------------------------------------
    "LR3": ("foot", landmark("mt1-mt2-base-junction", caudal=cm(1.0)), cm(0.6)),
    "ST42": ("foot", landmark("mt2-cuneiform-joint"), cm(0.5)),
    "GB41": ("foot", landmark("mt4-mt5-base-junction", caudal=cm(1.2)), cm(0.6)),
    "ST43": ("foot", between("mtp2", "mtp3", 0.5, cranial=cm(1.5)), cm(0.6)),
    "GB42": ("foot", between("mtp4", "mtp5", 0.5, cranial=cm(1.5)), cm(0.6)),
    # web points: just proximal to the web margin, at the border of the red and white skin
    "LR2": ("foot", landmark("web-1-2", cranial=cm(0.3)), cm(0.4)),
    "ST44": ("foot", landmark("web-2-3", cranial=cm(0.3)), cm(0.4)),
    "GB43": ("foot", landmark("web-4-5", cranial=cm(0.3)), cm(0.4)),
    # group point (4 sites): proximal to the four web margins; the first site (between the first and second toes,
    # where LR2 lies) is placed
    "EX-LE10": ("foot", landmark("web-1-2", cranial=cm(0.3)), cm(0.4)),
    # ---- foot: medial border ('medial' is further round, towards the sole) -------------------------------------
    "SP2": ("foot", landmark("mtp1-medial", caudal=cm(0.9)), cm(0.5)),
    "SP3": ("foot", landmark("mtp1-medial", cranial=cm(1.2)), cm(0.5)),
    "SP4": ("foot", landmark("mt1-base-medial", caudal=cm(0.8), medial=cm(1.4)), cm(0.6)),
    "KI2": ("foot", landmark("navicular-tuberosity", medial=cm(2.5)), cm(0.6)),
    # ---- foot: lateral border ('lateral' is further round, towards the sole) ---------------------------------
    "BL63": ("foot", landmark("cuboid-inferior-depression"), cm(0.6)),
    "BL64": ("foot", landmark("mt5-tuberosity", caudal=cm(1.0)), cm(0.5)),
    "BL65": ("foot", landmark("mtp5-lateral", cranial=cm(1.2)), cm(0.5)),
    "BL66": ("foot", landmark("mtp5-lateral", caudal=cm(0.8)), cm(0.5)),
    # ---- toes: 0.1 F-cun proximal and to the side of the nail corner --------------------------------------------
    "SP1": ("foot", landmark("great-toe-nail-medial-corner", medial=cm(0.15), **NAIL), cm(0.3)),
    "LR1": ("foot", landmark("great-toe-nail-lateral-corner", lateral=cm(0.15), **NAIL), cm(0.3)),
    "ST45": ("foot", landmark("toe2-nail-lateral-corner", lateral=cm(0.15), **NAIL), cm(0.3)),
    "GB44": ("foot", landmark("toe4-nail-lateral-corner", lateral=cm(0.15), **NAIL), cm(0.3)),
    "BL67": ("foot", landmark("toe5-nail-lateral-corner", lateral=cm(0.15), **NAIL), cm(0.3)),
    # group point (5 sites): the tips of the toes; the first site (the great toe) is placed
    "EX-LE12": ("foot", landmark("great-toe-tip"), cm(0.3)),

    # ---- sole --------------------------------------------------------------------------------------------------
    "KI1": ("sole", landmark("sole-depression"), cm(0.6)),
    "EX-LE11": ("sole", landmark("toe2-dip-crease-plantar"), cm(0.3)),
}
