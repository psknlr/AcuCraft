# Anatomy, localisation and needle paths

> **Every regional model in this pack is unreviewed.** The trunk and the front of the neck (`chest`, `abdomen`,
> `upper-back`, `sacrum-buttock`, `neck-anterior`) are derived from one imaging-based reference body, the Visible Human
> Male of the HuBMAP Human Reference Atlas (CC BY 4.0, §8); the head, the limbs and the older regions are schematic.
> Positions and depths are for simulation: they are not a guide to safe needling in real patients, and they need
> anatomical expert review before any teaching use.

## 1. Charts

A region (`acucraft/region@1`, `content/regions/*.json`) is a surface chart with depth, in centimetres:

- `u` runs across the body surface; `v` along it, cranial positive; `d` is the depth below the skin along the inward
  normal.
- In a **bilateral** region (knee and leg, forearm, hand) the chart is mirrored per side and `u` is positive towards
  lateral on either side.
- In a **midline** region (neck and shoulders, lower back) one chart covers both sides and `u` is positive towards the
  patient's **left**; side-specific landmarks carry the side in their id (`acromion-lateral-left`), and a point
  construction may refer to `acromion-lateral-{side}`.

Regions in the pack, eighteen, covering the whole body:

| area | regions | source |
|---|---|---|
| head and face | `face`, `scalp`, `head-lateral` | schematic (§6) |
| neck | `neck-anterior` (front and sides), `neck-shoulder` (nape, occiput, tops of the shoulders) | reference body; schematic |
| trunk | `chest`, `abdomen` (with the groin), `upper-back`, `lumbar`, `sacrum-buttock` (with the hips) | reference body (§8); `lumbar` schematic |
| upper limb | `upper-arm` (shoulder, axilla, arm, elbow), `forearm`, `hand-dorsum`, `hand-palm` | schematic |
| lower limb | `thigh`, `knee-leg` (knee, leg, ankle and heel), `foot`, `sole` | schematic (§7) |

**The whole body is modelled in every encounter.** Every region applies to every patient: a scenario's `regions` list
names those where its patient's build is authored (`patient.anatomy.regions`); in every other region the build is
derived from the patient's height, weight and sex against the region's reference body (`region.reference`, default
170 cm and BMI 22.5): length scales with height, girth with height and BMI, subcutaneous fat with BMI, and muscle
with height, BMI and — against a reference body of the other sex — sex. A patient without a recorded weight is taken
as BMI 22.5.

The upper limb has four bilateral charts. `upper-arm` (shoulder, axilla, arm and elbow) and `forearm` are unrolled round
the limb from its anterior (palmar) midline, `u` positive lateral and on round the back of the limb, so each chart's two
ends meet on the ulnar (posteromedial) side; beyond the lateral midline `lateral` (+u) points towards the anatomically
medial side (towards the ulna on the dorsal forearm). `v` runs from the cubital crease (arm) or the palmar wrist crease
(forearm); above the acromion the arm chart continues over the top of the shoulder, and both charts cover the elbow.
`hand-dorsum` and `hand-palm` share their axes (`u` from the third metacarpal, radial positive; `v` proximal from the
knuckles, negative along the fingers). Segments: `seg.arm` (end of the anterior axillary fold to the cubital crease,
9 B-cun), `seg.wrist-elbow` (12) and `seg.forearm-dorsal` (dorsal wrist crease to the olecranon, 12); the hands have
none, and finger-cun offsets are written in cm. A group point (Erbai, Yaotongdian, Baxie, Sifeng, Shixuan) is placed at
its first site only.

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
- `subcutaneousScale`, `muscleScale` — build; deeper layers move with the soft tissue, and a structure by the change
  in the fat and muscle above it;
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
and must come from reviewed teaching. 399 of the 409 points carry a *localisation* on a regional model and can be
needled; ten are definitions only, deliberately: the mucosal points that are pricked, not needled (EX-HN9–EX-HN13,
GV28), the perineal points (CV1, GV1), the nipple (ST17, a landmark) and the umbilicus (CV8, moxibustion only). The tables are generated (`python3 tools/content/acupoints.py`) from `tools/content/points_*.py`, the
hand-written detail of the family points (`acupoint_detail.json`), the placements of each body area
(`tools/content/localise_{trunk,head,upper_limb,lower_limb}.py`) and the cautions and notes in the script.
Every entry is an unreviewed, AI-assisted paraphrase.

`pointInstance(scenario, point, side, configuration)` constructs the hidden reference location of a point from its
definition (`acucraft/acupoints@1`): `landmark` (+ offset), `between` two landmarks at a fraction, or `along` a line a
distance in cun or cm, then offsets `lateral`/`medial`/`cranial`/`caudal`. An anchor may also be another point,
`point:<id>`, wherever that point is placed on this patient (LR11 is "2 B-cun distal to ST30": `point:ST30`, caudal
2 B-cun). Its tolerance is the definition's (cm or cun). The evaluator compares each needle's actual entry with
the instance in the configuration the needle went in under.

**Seams.** Where two charts meet, a region declares a seam (`seams[]`): the other region, and pairs of landmarks that
are the same skin point on both charts. For a patient and side, `seamMap(scenario, from, to, side, configuration)`
fits the similarity (scale, rotation, translation, no reflection) that best carries the pairs' positions on `from`
onto `to`, with both charts turned so that `u` points lateral, and reports each pair's residual. A `point:` anchor on
a neighbouring chart is carried across it. The fit is made the way the seam is declared, and the other direction is
its exact inverse. The reference library lists each region's seams (which landmarks are shared, not where), so an
agent palpates the pairs on both charts and makes the same fit from its own observations.

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

## 7. Lower limb

`thigh`, `knee-leg`, `foot` and `sole` are bilateral (`tools/content/localise_lower_limb.py`). The thigh and the leg
are unrolled round the limb from the anterior midline, `u` positive lateral and on round the back of the limb, so the
posterior midline is reached round the lateral side (the popliteal fossa and the calf at large positive `u`); round
the tibial side `medial` (−u) points posterior. The ankle and heel stay on `knee-leg` with the malleoli; `foot` covers
the dorsum and the sides of the foot from the line of the second metatarsal, `sole` the plantar surface. Segments:
pubic symphysis to the medial epicondyle 18 B-cun, greater trochanter to the popliteal crease 19, gluteal fold to the
popliteal crease 14, popliteal crease to the lateral malleolus 16, medial condyle of the tibia to the medial malleolus
13, medial malleolus to the sole 3. The thigh meets the abdomen at a seam in the groin (§3, §8). Critical: the femoral
and deep femoral arteries, the popliteal artery, the posterior tibial and dorsalis pedis arteries; cautions: the
sciatic, tibial, common fibular and sural nerves, the saphenous veins, the ankle capsule and the plantar bundles.

## 8. The trunk from a reference body

The trunk regions are generated from the **HuBMAP Human Reference Atlas** 3D reference organs, **Visible Human Male
united body** (CCF release v1.3; CC BY 4.0; data from the Visible Human Project of the US National Library of Medicine;
Kristen Browne, Heidi Schlehlein, Bruce W. Herr II, Ellen Quardokus, Andreas Bueckle, Katy Börner, *HuBMAP CCF 3D
Reference Object Library*, humanatlas.io/3d-reference-library). It was chosen because it is open with attribution only,
anatomist-reviewed, and places the skin, vertebrae, pelvis, femora, larynx, trachea, lungs, heart, liver, spleen,
kidneys, bowel, bladder, great vessels and spinal cord of one body in one frame. BodyParts3D and Z-Anatomy, which also
model the ribs, scapulae, nerves and limb vessels, are share-alike (CC BY-SA): content derived from them would have to
be released under that licence.

```bash
pip install -r tools/anatomy/requirements.txt
```

```bash
python3 tools/anatomy/fetch_hra.py
```

```bash
python3 tools/anatomy/build_trunk.py
```

`fetch_hra.py` downloads the pinned body (a fixed commit of `hubmapconsortium/ccf-releases`, checked by SHA-256)
into `tools/anatomy/.cache/`; `build_trunk.py` writes the five regions and the measurements it used
(`tools/anatomy/derived/vh-male.json`). Each trunk chart unrolls the skin round a horizontal section from the anterior
or posterior midline (`u` positive towards the patient's left; `v` height above a stated level). Its tissue is a grid of
zones (every 1.5–2.5 cm): from each zone's skin point five rays are cast along the skin's inward normal (the path of a
perpendicular needle), and the shallowest depth at which each organ is met becomes the layer stack — body wall, then
the pleura and lung, or the peritoneal cavity, or bone, and critical layers for the heart, liver, spleen, kidneys,
pancreas, great vessels and the spinal canal.

Measured on the reference body: the charts, vertebral levels and spinous processes, the iliac spines, trochanters and
ischial tuberosities, the larynx, the depths of every organ above, and the courses of the aorta, venae cavae, trachea,
left carotid artery and spinal cord. Schematic, because the reference body lacks them or cannot separate them: the
ribs (every non-sternal chest and back location is treated as an intercostal space — the conservative case), the
intercostal-space levels (from the sternal angle and xiphisternal junction by standard surface anatomy), the sternum,
the scapulae, the split of the body wall into fat and muscle, the umbilicus (at the L3/L4 disc: the reference skin is
smoothed), the right carotid (mirrored), the jugular veins, thyroid, internal thoracic, femoral and inferior epigastric
vessels, the femoral and sciatic nerves, and the sacral foramina. The reference man (about 90 kg; BMI 27.8) lay
supine with his arms at his sides: where his arms or his flattened buttocks distort the body wall, its thickness is
capped (chest 5 cm, upper back 6.5 cm, buttocks 7 cm), the lower sacral midline is schematic, and a zone whose rays
meet nothing takes the median measured wall (chest 3.9 cm, abdomen 4.3 cm, upper back 5.0 cm) with the lung or
peritoneal cavity under it — never a deeper safe margin than the body measured. Patients are scaled from this
reference by height and BMI (§1).

The groin is stitched: `thigh` declares a seam with `abdomen` on the upper border of the pubic symphysis, the
anterior superior iliac spine and the femoral pulse at the inguinal crease (§3). On the abdomen the mid-inguinal point
lies midway between the measured iliac spine and symphysis, where the femoral artery passes under the inguinal
ligament, and the crease 2 cm below it; the thigh's schematic groin is placed to agree. ST30, LR12, SP12 and SP13
lie on `abdomen`; LR11 and LR10 are measured down the thigh from ST30, and SP11 from SP12, wherever the abdomen places
them for that patient. Tests check, for every patient and side, that the three pairs agree within 1 cm (about
0.3 cm), that the femoral artery of the abdomen runs on into the thigh's, and that ST30 lands level with the thigh's
pubic symphysis. The thigh's groin is about 22 % smaller than the abdomen's: the abdomen's arc lengths come from a
heavier reference body (BMI 27.8) and its derived build narrows only weakly with BMI, while the thigh's are drawn for
a slim adult. The fitted scale absorbs the difference; other charts meet without a seam.

The left common carotid artery of the reference body lies about 1.1 cm below the skin (to its axis) at the level of
the thyroid cartilage, shallower than imaging of living subjects reports under ST9. It is kept as measured: a
structure moves with the fat and muscle above it, so in a slim patient (BMI below about 24) the wall of the carotid
under ST9, and of the internal jugular vein under LI18, comes within 5 mm of the skin, and the guard stops a
perpendicular needle there — the teaching is to palpate the pulse and keep the needle off the artery.
