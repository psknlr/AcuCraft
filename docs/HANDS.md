# Practitioner hand asset

`content/world/assets/models/acu-practitioner-hand.glb` is original procedural
geometry generated in Blender by `tools/blender/build_hand.py`. The geometry and
its animation are dedicated to the public domain under CC0-1.0; there are no
downloaded meshes, textures, external add-ons or patient data. It is a schematic
animation asset, without anatomical or clinical validation.

Rebuild with Blender 4.3 or newer:

```bash
blender -b -P tools/blender/build_hand.py
```

The builder also writes `tools/blender/hand.json`, including the binary's hash,
triangle count, dimensions, joint names, moving contact anchors, and measured
contact positions in each authored pose. The exported hand
has 4,340 triangles, 39 mesh primitives and two PBR materials, `hand_skin` and
`hand_nails`. The renderer can recolor them to match a practitioner's appearance.
The asset is separate from the static equipment catalog because its articulated
nodes are animated by the encounter renderer.

## Coordinate and animation contract

The GLB uses metres and Y up. Its root is `acu_practitioner_hand`; +Y follows the
needle's outward shaft, and +X runs from the pinch toward the wrist. Align this
root with the needle's frame, then place its origin at the desired grip point
on the handle. `pinch` is an empty at the origin and `wrist` is an empty at
`[0.162, 0.004, 0]`. The parent may mirror Z to use the other hand.

The neutral pose is a thumb/index precision pinch. The fingertip centers are
`thumb_tip = [0, 0, -0.006]` and `index_tip = [0, 0, 0.006]`, with their facing
pads leaving approximately 2 mm for the deliberately enlarged visualization of a
needle. `thumb_contact` and `index_contact` mark the gap at Z ±0.001 m. Each
finger has three nested rotation nodes:

| Digit | Nodes, from palm toward fingertip |
| --- | --- |
| Thumb | `thumb_proximal`, `thumb_middle`, `thumb_distal` |
| Index | `index_proximal`, `index_middle`, `index_distal` |
| Middle | `middle_proximal`, `middle_middle`, `middle_distal` |
| Ring | `ring_proximal`, `ring_middle`, `ring_distal` |
| Little | `little_proximal`, `little_middle`, `little_distal` |

The legacy names remain available for saved clips. Each has an anatomically named
parent at the same joint pivot: thumb `CMC`, `MCP`, `IP`; the other fingers `MCP`,
`PIP`, `DIP` (for example `thumb_CMC` and `index_PIP`). The anatomical parent carries
the joint translation; its legacy child has zero translation and carries the base
clip rotation. This allows independent joint adjustments above a clip without
moving the rotation pivot or overwriting its sampled motion. The thumb names do
not imply three interphalangeal joints. These are schematic control landmarks,
not a calibrated model of each anatomical joint's degrees of freedom.

Every distal node has a `<digit>_tip`, `<digit>_pad_contact`, and
`<digit>_nail_contact` attachment. The pad and nail contacts are fitted to the
actual mesh surfaces and move with their phalanx. Their local **+Y axis points
along the outward contact normal**. `<digit>_pad` is a compatibility alias for the
pad contact. `palm_contact` and `support_contact` provide palmar attachment frames.
The old root-level `thumb_contact` and `index_contact` remain fixed reference
points; controllers should use the moving contacts for articulated poses.

The asset contains five independently sampled clips. Each runs from 0 to 1 second
and begins at the neutral precision pinch:

| Clip | Pose and timing |
| --- | --- |
| `hand_open` | Pinch to loose open grasp; 15 rotation channels. |
| `hand_support` | Pinch to an extended, spread-finger supporting pose. |
| `hand_three_finger` | Moves the middle finger's real pad to `[0, -0.010, 0.001]` beside the handle, retaining all segment lengths. |
| `hand_scrape` | Positions the index nail at `[0.012, 0.005, 0.001]`; align the moving nail anchor with the handle rather than assuming it shares the pinch origin. |
| `hand_flick` | Loads the index at 0.4 s, releases at 16/30 s, and returns to pinch at 1 s. |

Sample one base clip per hand, then apply bounded anatomical-parent adjustments.
Unchanged neutral channels may be omitted by the glTF exporter. None of the clips
moves the root or wrist. The renderer aligns the selected actual contact anchor
with its target, and the other hand can supply stabilization during nail contact.
The manifest records the evaluated contact positions for pinch, open, support,
tripod, scraping, and both flick phases. These attachments make contact observable
without pretending that a rendered fingertip supplies measured force.

The mesh is sized for a roughly 17 cm adult hand. Model scale, finger shape and
pad compression are rendering choices and do not prescribe needling technique.

## Contact control in the encounter renderer

Each hand samples its own base clip and independent anatomical joint adjustments.
For precision grips, `gripApertureMm` is a geometric target for the separation of
the moving thumb and index pad anchors. A bounded rotational solve adjusts the
thumb CMC and index MCP controls; it does not scale the hand, translate a finger,
or change a phalanx length. Scene-graph tests cover 0, 2, 6 and 12 mm for both
mirrored hands. When a needle is held, a minimum 1.5 mm visual clearance accommodates
the enlarged handle; zero means closed contact rather than interpenetration.
The pinch midpoint remains attached to the handle after each joint adjustment.
Aperture is a grip control, not a measure of palmar contact or grip force.

For scraping and flicking, the moving index nail contact is aligned to the actual
external handle. Supporting-hand stabilization, stretching, pinching and pressing
use a separate hand and target. Skin contacts align the selected moving pad or
nail outward normal against the skin normal, with the wrist direction fixing
the remaining orientation. Needle grips retain their shaft-aligned frame. Both
arm targets are registered before either
wrist attachment is drawn, so both hands use the same final torso pose.

The encounter renderer joins each wrist to the practitioner's own sleeve with
two-bone inverse kinematics. A target outside the arm's reach is clamped rather
than stretching either bone. A presentation-only turn on the spot faces the work,
then a shared hip hinge shifts the upper body only as far as needed, up to 30 cm
forward and 20 cm down in the figure's metre frame. The feet stay at the
engine-authorized floor position; walking cancels these temporary targets.
These bounds are authored choreography, not validated anatomical limits.

The low-back reference is tested with its actual 160 cm patient figure and the
practitioner's recorded stance: both hands reach their contacts, the pad midpoint
meets the needle handle, and the supporting pad stays beside the entry while the
feet remain fixed. An unreachable target hides the affected detail hand and emits
a playback message asking the operator to move closer, rather than drawing a hand
separated from its sleeve.

Catalogue performances support local pause and speed control. A labelled local
preview also supports deterministic seeking; recorded actions cannot be sought
backwards or replaced by a draft preview. Preview is refused while accepted
actions are queued or playing. Stopping it restores the needle's recorded visual
state, and a newer authoritative encounter update cancels it.
