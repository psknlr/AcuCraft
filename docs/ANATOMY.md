# Anatomy, localisation and needle paths

> **Every regional model in this pack is schematic and unreviewed.** Positions and depths approximate a reference adult
> for simulation; they are not measurements, not an atlas, and not a guide to safe needling in real patients. They need
> anatomical expert review — and licensed anatomical assets where geometry matters — before any teaching use.

## 1. Charts

A region (`acucraft/region@1`, `content/regions/*.json`) is a surface chart with depth, in centimetres:

- `u` runs across the body surface; `v` along it, cranial positive; `d` is the depth below the skin along the inward
  normal.
- In a **bilateral** region (knee and leg, forearm, hand) the chart is mirrored per side and `u` is positive towards
  lateral on either side.
- In a **midline** region (neck and shoulders, lower back) one chart covers both sides and `u` is positive towards the
  patient's **left**; side-specific landmarks carry the side in their id (`acromion-lateral-left`), and a point
  construction may refer to `acromion-lateral-{side}`.

Regions in the pack: `knee-leg`, `forearm`, `hand-dorsum`, `neck-shoulder`, `lumbar`.

## 2. Configurations, positions and access

A region has **configurations** (the knee flexed or extended; the back prone, side-lying or flexed forward). The
patient's **position** decides whether a region and side can be reached and in which configuration
(`region.access`): the anterior knee with the patient prone cannot be reached; side-lying on the left, only the right
side is. Landmarks (and structures) may move between configurations (`landmarks[].configurations`). When the patient
moves into another configuration, every point instance follows, and skin marks made before become **stale** (they move
with the skin, approximately with the nearest landmark): an insertion at a stale mark is recorded.

## 3. Patient-specific instances

`patientRegion(scenario, region, side, configuration)` builds the patient's region from the reference chart and the
scenario's `patient.anatomy.regions[region]` (`both`, with `left`/`right` differences):

- `scale.u`, `scale.v` — girth and limb length;
- `subcutaneousScale`, `muscleScale` — build; deeper layers and structures move with the soft tissue;
- `landmarks`, `structures` — individual shifts (anatomical variation).

**Cun is the patient's own**: one B-cun of a segment is the patient's segment length (measured in the region's default
configuration) divided by the segment's cun (`segments[]`, e.g. knee to lateral malleolus = 16 B-cun). It is never a
fixed number of centimetres; the finger cun (`fingerCunCm`) is a separate measurement, kept apart (`measure` with
`fingerCun: true`; `mark_point` records the method used).

The library (`content/acupoints/`, one file per channel) defines every point of the WHO standard (2008): 361 points on
the 14 channels, plus the 48 extra points of the WHO standard nomenclature (1991). Each has its names, codes per
edition (and older channel codes as aliases: SJ for TE, LIV for LR, DU for GV, REN for CV), a paraphrased location, a
body area, cautions by risk factor (pregnancy: LI4, SP6, BL60, BL67, GB21, the lower abdomen and the lumbosacral
region) and notes on what lies beneath hazardous points. No needling depths are given: safe depth depends on the build
and must come from reviewed teaching. Only points that lie on a modelled region carry a *localisation* (45 of them);
the rest are definitions only, which can be looked up, planned and discussed but not needled until their region is
modelled. The tables are generated (`python3 tools/content/acupoints.py`) from `tools/content/points_*.py`, the
hand-written detail of the family points (`acupoint_detail.json`) and the placements, cautions and notes in the script.
Every entry is an unreviewed, AI-assisted paraphrase.

`pointInstance(scenario, point, side, configuration)` constructs the hidden reference location of a point from its
definition (`acucraft/acupoints@1`): `landmark` (+ offset), `between` two landmarks at a fraction, or `along` a line a
distance in cun or cm, then offsets `lateral`/`medial`/`cranial`/`caudal`. Its tolerance is the definition's (cm or
cun). The evaluator compares each needle's actual entry with the instance in the configuration the needle went in
under.

An agent never sees these instances (outside teaching mode). It palpates landmarks (`identify_landmark`, precise to
about 2.5 mm), measures segments (`measure`, about 1.5 %), constructs the point from the public definition
(`referenceLibrary`) and marks it (`mark_point`).

## 4. Tissue and structures

`tissue.layers` is the default stack below the skin (skin, subcutaneous, muscle, … bone); `tissue.zones` override it
inside a circle (the infrapatellar fat pad and joint space under the knee eyes; the subcutaneous tibia; the apical
pleura under GB21; the interspinous ligaments in the midline). `structures` are tubes (a polyline and a radius) with a
hazard (`critical`, `caution`) and a consequence.

| consequence | effect when a needle reaches the structure |
|---|---|
| `electric-sensation` | the patient reports an electric, shooting sensation (`nerve-contact`) |
| `bleeding` / `haematoma` | the site bleeds at withdrawal until pressure is applied |
| `joint-penetration` | flagged; scored by the evaluator |
| `pneumothorax-risk` | flagged (pleura); critical |
| `tendon-pain` | sharp pain |

## 5. Needle paths

`assessPath(frame, entry, angleDeg, azimuthDeg, depthCm, needle)`: angle 0 is perpendicular; azimuth 0 points cranial
(+v), 90 to +u. The shaft never goes in to its hilt (90 % of its length at most). Layers are read at the entry; bone
stops the tip (the executed depth differs from the requested one, and the patient feels pressure on the bone); the
pleura layer is critical; each structure's clearance is the shortest distance between the shaft and its centreline,
less its radius and the needle's; contact is clearance ≤ 0, `near` within the structure's positional uncertainty.

With the guard on (`block-critical`), a path that reaches a critical structure or the pleura is refused before the
needle touches the skin — the needle stays unused and sterile in the hand — and the attempt is recorded as an unsafe,
blocked act. Manipulation (`adjust_needle` with a technique) with the tip in muscle or fascia produces deqi.

## 6. Head and face

Four charts cover the head (`tools/content/localise_head.py` places its points on them):

- `face` (midline): u from the anterior median line, positive to the left; v cranial from the glabella. The eyeballs
  are critical structures a few millimetres from ST1, EX-HN7 and BL1, whose zones run through the orbital fat to a
  critical orbital apex; glabella to anterior hairline is 3 B-cun.
- `scalp` (midline): u along the transverse arc from the median line, positive to the left; v along the median arc
  from the anterior hairline, positive **backwards over the vertex**, so a `cranial` offset points away from the
  forehead ("superior to the anterior hairline"); points measured from the posterior hairline are built `along` the
  line towards the anterior hairline. Anterior to posterior hairline is 12 B-cun, between the corners of the
  forehead (ST8) 9 B-cun. The skull stops a needle within about a centimetre.
- `head-lateral` (bilateral): u from the anterior border of the tragus, positive **posterior**: as on the leg chart, a
  `lateral` offset points backwards (further round from the face) and a `medial` one forwards; v cranial from the
  tragus. Its anterior edge reaches the forehead, where glabella to anterior hairline (3 B-cun) gives the cun used on
  the side of the head (GB8, GB9, ST8 to GB7). The jaw is shown closed: GB2, SI19 and TE21 are marked in the
  depressions that open in front of the tragus, over the temporomandibular joint.
- `neck-shoulder` reaches up over the occiput (GV17, BL9, GB19) and round to behind the ear lobe (TE17, EX-HN14,
  GB12), with the mastoid processes (9 B-cun) and posterior hairline to C7 (3 B-cun); GV15 and BL10 lie over the
  spinal canal and the vertebral artery, which only deep, upward or medial needling reaches.

Limits of the engine as used here: a point has one reference location, so the four sites of EX-HN1 share a reference
at their centre (GV20) with a tolerance of 1.3 B-cun; a configuration follows the patient's position only, so "with
the mouth open" is described, not modelled; access is per region and side (supine reaches the whole scalp, including
the occiput on the pillow). Where the standard uses a finger-breadth, or the level of one landmark on the vertical of
another (ST3, GB19), the offset is in centimetres on the reference adult.
