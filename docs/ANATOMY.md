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
