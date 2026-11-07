"""Placements of the upper-limb points on the regional models (merged by tools/content/acupoints.py).

    LOCALISE = { "POINTID": (region, localisation, tolerance[, configuration]), ... }

Regions (content/regions):
  upper-arm    shoulder, axilla, arm and elbow; u round the limb from the anterior midline of the arm, positive
               lateral and on round the back of the arm (olecranon about +13.7, ulnar groove about +18.4),
               negative medial (axilla); v cranial from the cubital crease.
  forearm      u round the forearm from the palmar midline, positive radial and on round the dorsum to the ulnar
               border; v proximal from the palmar wrist crease.
  hand-dorsum  u from the axis of the third metacarpal, positive radial; v proximal from the knuckles, negative
               along the dorsal fingers.
  hand-palm    the same axes on the palm, palmar fingers and fingertips.

Offsets follow the chart's sign convention: 'lateral' is +u, 'medial' is -u, 'cranial' is +v (proximal). Beyond the
lateral midline of a limb chart +u runs on round the back of the limb, so there 'lateral' points towards the
anatomically medial side (on the dorsal forearm, towards the ulna) and 'medial' towards the radius; on the lateral
elbow 'medial' (-u) is anterior. Each placement follows the point's paraphrased WHO (2008) location text.

Group points (one code, several sites): the first, canonical site is placed and the rest are definitions only:
  EX-UE2   the site on the ulnar side of the flexor carpi radialis tendon (between it and palmaris longus)
  EX-UE7   the site between the second and third metacarpals
  EX-UE9   the site in the web between the thumb and the index finger
  EX-UE10  the index finger
  EX-UE11  the thumb

Every placement is an unreviewed, AI-assisted construction on a schematic model: check it against the standard
before teaching use.
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

ARM = "seg.arm"                  # end of the anterior axillary fold to the cubital crease: 9 B-cun (upper-arm)
FA = "seg.wrist-elbow"           # palmar wrist crease to cubital crease: 12 B-cun (forearm)
FAD = "seg.forearm-dorsal"       # dorsal wrist crease to the prominence of the olecranon: 12 B-cun (forearm)

# The finger cun (0.1 F-cun at the nail corners) is written in cm: about 2 mm on the reference adult.
F01 = cm(0.2)

LOCALISE = {
    # ---------------------------------------------------------------------------------------------------------
    # shoulder and axilla (upper-arm)
    # ---------------------------------------------------------------------------------------------------------
    "LI15": ("upper-arm", between("acromion-anterior", "greater-tubercle", 0.5), cm(0.8)),
    "TE14": ("upper-arm", between("acromial-angle", "greater-tubercle", 0.5), cm(0.8)),
    "LI16": ("upper-arm", landmark("clavicle-spine-notch"), cm(0.7)),
    # posterior shoulder: straight up from the end of the posterior axillary fold
    "SI9": ("upper-arm", landmark("posterior-axillary-fold", cranial=cun(1, ARM)), cun(0.4, ARM)),
    "SI10": ("upper-arm", landmark("scapular-spine-lower-border", caudal=cm(0.6)), cm(0.8)),
    # the axillary fossa opens with the arm abducted
    "HT1": ("upper-arm", landmark("axillary-fossa-centre"), cm(0.8), "arm-abducted"),
    # ---------------------------------------------------------------------------------------------------------
    # arm (upper-arm)
    # ---------------------------------------------------------------------------------------------------------
    # lung channel: down the lateral border of biceps from the level of the anterior axillary fold
    "LU3": ("upper-arm", along("biceps-lateral-border-fold-level", "biceps-tendon-lateral-crease", 3, ARM), cun(0.4, ARM)),
    "LU4": ("upper-arm", along("biceps-lateral-border-fold-level", "biceps-tendon-lateral-crease", 4, ARM), cun(0.4, ARM)),
    # pericardium channel: between the heads of biceps, from the end of the anterior axillary fold
    "PC2": ("upper-arm", along("anterior-axillary-fold", "cubital-crease-mid", 2, ARM), cun(0.4, ARM)),
    # large intestine channel: on the line LI11 (the lateral cubital depression) to LI15 (the anterior acromial depression)
    "LI13": ("upper-arm", along("lateral-cubital-depression", "acromion-anterior-depression", 3, ARM), cun(0.4, ARM)),
    "LI14": ("upper-arm", along("lateral-cubital-depression", "acromion-anterior-depression", 7, ARM), cun(0.5, ARM)),
    # heart channel: 3 B-cun above the medial end of the crease, towards the biceps (anterior is +u on the medial arm)
    "HT2": ("upper-arm", landmark("cubital-crease-medial-end", cranial=cun(3, ARM), lateral=cm(1.0)), cun(0.4, ARM)),
    # triple energizer channel: on the line from the olecranon to the acromial angle
    "TE11": ("upper-arm", along("olecranon", "acromial-angle", 2, ARM), cun(0.4, ARM)),
    "TE12": ("upper-arm", along("olecranon", "acromial-angle", 5, ARM), cun(0.5, ARM)),
    "TE13": ("upper-arm", along("acromial-angle", "olecranon", 3, ARM), cun(0.5, ARM)),
    # ---------------------------------------------------------------------------------------------------------
    # elbow (upper-arm)
    # ---------------------------------------------------------------------------------------------------------
    "LU5": ("upper-arm", landmark("biceps-tendon-lateral-crease"), cm(0.6)),
    "PC3": ("upper-arm", landmark("biceps-tendon-medial-crease"), cm(0.6)),
    "LI11": ("upper-arm", between("biceps-tendon-lateral-crease", "lateral-epicondyle", 0.5), cm(0.7)),
    # 1 B-cun above the lateral epicondyle, in front of the supracondylar ridge (on the lateral elbow, anterior is -u)
    "LI12": ("upper-arm", landmark("lateral-epicondyle", cranial=cun(1, ARM), medial=cm(0.8)), cm(0.7)),
    # the midpoint of the medial end of the crease and the medial epicondyle: just anterior to the epicondyle
    "HT3": ("upper-arm", between("cubital-crease-medial-end", "medial-epicondyle", 0.5), cm(0.7)),
    "SI8": ("upper-arm", landmark("ulnar-groove"), cm(0.5)),
    # with the elbow flexed: the olecranon tip, and the hollow of the olecranon fossa 1 B-cun above it
    "EX-UE1": ("upper-arm", landmark("olecranon"), cm(0.6), "elbow-flexed"),
    "TE10": ("upper-arm", landmark("olecranon", cranial=cun(1, ARM)), cm(0.7), "elbow-flexed"),
    # ---------------------------------------------------------------------------------------------------------
    # forearm, palmar and ulnar side
    # ---------------------------------------------------------------------------------------------------------
    # lung channel: the line LU9 (radial-styloid-scaphoid depression) to LU5 (lateral to the biceps tendon)
    "LU9": ("forearm", landmark("radial-styloid-scaphoid-depression"), cm(0.5)),
    "LU8": ("forearm", along("radial-styloid-scaphoid-depression", "biceps-tendon-lateral-crease", 1, FA), cm(0.5)),
    "LU6": ("forearm", along("radial-styloid-scaphoid-depression", "biceps-tendon-lateral-crease", 7, FA), cun(0.4, FA)),
    # EX-UE2, canonical site: between palmaris longus and flexor carpi radialis, on the pericardium line
    "EX-UE2": ("forearm", along("pl-fcr-wrist", "cubital-crease-mid", 4, FA), cun(0.3, FA)),
    # heart channel: radial to the flexor carpi ulnaris tendon, from HT7 towards the medial end of the cubital crease
    "HT6": ("forearm", along("fcu-radial-wrist", "cubital-crease-medial-end", 0.5, FA), cun(0.25, FA)),
    "HT5": ("forearm", along("fcu-radial-wrist", "cubital-crease-medial-end", 1, FA), cun(0.25, FA)),
    "HT4": ("forearm", along("fcu-radial-wrist", "cubital-crease-medial-end", 1.5, FA), cun(0.25, FA)),
    # ---------------------------------------------------------------------------------------------------------
    # forearm, radial and dorsal side
    # ---------------------------------------------------------------------------------------------------------
    # large intestine channel: the line LI5 (snuffbox) to LI11 (the radial end of the cubital crease, its position
    # with the elbow flexed); distances from the wrist for LI6-LI7, from the cubital crease for LI8-LI10
    "LI5": ("forearm", landmark("anatomical-snuffbox"), cm(0.6)),
    "LI6": ("forearm", along("anatomical-snuffbox", "radial-border-elbow", 3, FA), cun(0.4, FA)),
    "LI7": ("forearm", along("anatomical-snuffbox", "radial-border-elbow", 5, FA), cun(0.4, FA)),
    "LI8": ("forearm", along("radial-border-elbow", "anatomical-snuffbox", 4, FA), cun(0.4, FA)),
    "LI9": ("forearm", along("radial-border-elbow", "anatomical-snuffbox", 3, FA), cun(0.4, FA)),
    "LI10": ("forearm", along("radial-border-elbow", "anatomical-snuffbox", 2, FA), cun(0.4, FA)),
    # dorsal wrist crease, either side of the extensor digitorum tendons
    "EX-UE3": ("forearm", landmark("edc-radial-wrist"), cm(0.5)),
    "TE4": ("forearm", landmark("edc-ulnar-wrist"), cm(0.5)),
    # triple energizer channel: between the radius and the ulna, on the line from the middle of the dorsal wrist
    # crease to the olecranon; TE7 just radial to the ulna ('lateral', +u, on the dorsum is towards the ulna)
    "TE5": ("forearm", along("dorsal-wrist-crease-mid", "olecranon", 2, FAD), cun(0.4, FAD)),
    "TE6": ("forearm", along("dorsal-wrist-crease-mid", "olecranon", 3, FAD), cun(0.4, FAD)),
    "TE7": ("forearm", along("dorsal-wrist-crease-mid", "olecranon", 3, FAD, lateral=cm(1.0)), cun(0.4, FAD)),
    "TE8": ("forearm", along("dorsal-wrist-crease-mid", "olecranon", 4, FAD), cun(0.4, FAD)),
    "TE9": ("forearm", along("olecranon", "dorsal-wrist-crease-mid", 5, FAD), cun(0.5, FAD)),
    # small intestine channel along the ulna: SI5 between the ulnar styloid and the triquetrum; SI6 radial to the
    # head of the ulna ('medial', -u, on the dorsum is towards the radius); SI7 just past the posterior border of
    # the ulna, between it and flexor carpi ulnaris ('lateral', +u)
    "SI5": ("forearm", between("ulnar-styloid", "triquetrum", 0.5), cm(0.5)),
    "SI6": ("forearm", along("ulnar-styloid", "olecranon", 1, FAD, medial=cm(1.9)), cm(0.6)),
    "SI7": ("forearm", along("ulnar-styloid", "olecranon", 5, FAD, lateral=cm(1.8)), cun(0.5, FAD)),
    # ---------------------------------------------------------------------------------------------------------
    # dorsum of the hand and fingers (hand-dorsum): proximal is 'cranial'
    # ---------------------------------------------------------------------------------------------------------
    "SI4": ("hand-dorsum", between("mc5-base", "triquetrum", 0.5), cm(0.5)),
    "LI2": ("hand-dorsum", landmark("mc2-head", caudal=cm(0.9)), cm(0.5)),
    "SI2": ("hand-dorsum", landmark("mc5-mcp-ulnar", caudal=cm(0.8)), cm(0.5)),
    "TE3": ("hand-dorsum", landmark("cleft-4-5", cranial=cm(0.9)), cm(0.5)),
    "TE2": ("hand-dorsum", landmark("web-4-5", cranial=cm(0.3)), cm(0.5)),
    # EX-UE7, canonical site: in the second intermetacarpal space, midway between the wrist crease and the knuckles
    "EX-UE7": ("hand-dorsum", between("cleft-2-3", "wrist-dorsal-crease", 0.5, lateral=cm(0.5)), cm(0.6)),
    # about 0.5 B-cun (about 1 cm on the reference adult; the hand has no proportional segment) above the knuckles
    "EX-UE8": ("hand-dorsum", landmark("cleft-2-3", cranial=cm(1.0)), cm(0.5)),
    # EX-UE9, canonical site: the web between the thumb and the index finger
    "EX-UE9": ("hand-dorsum", landmark("web-margin", cranial=cm(0.3)), cm(0.5)),
    "EX-UE4": ("hand-dorsum", landmark("pip-3-dorsal"), cm(0.4)),
    "EX-UE5": ("hand-dorsum", landmark("ip-1-dorsal"), cm(0.4)),
    "EX-UE6": ("hand-dorsum", landmark("pip-5-dorsal"), cm(0.4)),
    # jing-well points: 0.1 F-cun proximal and to the side of the nail corner (radial is +u, ulnar is -u)
    "LU11": ("hand-dorsum", landmark("nail-1-radial-corner", cranial=F01, lateral=F01), cm(0.4)),
    "LI1": ("hand-dorsum", landmark("nail-2-radial-corner", cranial=F01, lateral=F01), cm(0.4)),
    "HT9": ("hand-dorsum", landmark("nail-5-radial-corner", cranial=F01, lateral=F01), cm(0.4)),
    "TE1": ("hand-dorsum", landmark("nail-4-ulnar-corner", cranial=F01, medial=F01), cm(0.4)),
    "SI1": ("hand-dorsum", landmark("nail-5-ulnar-corner", cranial=F01, medial=F01), cm(0.4)),
    # ---------------------------------------------------------------------------------------------------------
    # palm, palmar fingers and fingertips (hand-palm)
    # ---------------------------------------------------------------------------------------------------------
    # at the border of the red and white skin, radial to the midpoint of the first metacarpal
    "LU10": ("hand-palm", between("mc1-base", "mc1-head", 0.5, lateral=cm(1.2)), cm(0.6)),
    "PC8": ("hand-palm", landmark("proximal-palmar-crease-2-3"), cm(0.5)),
    "HT8": ("hand-palm", landmark("distal-palmar-crease-4-5"), cm(0.5)),
    # EX-UE10, canonical site: the index finger
    "EX-UE10": ("hand-palm", landmark("pip-crease-2"), cm(0.4)),
    # EX-UE11, canonical site: the thumb
    "EX-UE11": ("hand-palm", landmark("tip-1"), cm(0.4)),
    "PC9": ("hand-palm", landmark("tip-3"), cm(0.4)),
}
