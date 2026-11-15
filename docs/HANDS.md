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
triangle count, dimensions, joint names and attachment points. The exported hand
has 4,100 triangles, 37 mesh primitives and two PBR materials, `hand_skin` and
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

Every distal node has a `<digit>_tip` attachment empty. Nodes have identity
rotations in the pinch pose, allowing procedural finger adjustment without
changing mesh data. The `hand_open` clip runs from the pinch at time zero to a
loose open grasp at one second. A paused, clamped animation action can sample any
intermediate release amount; time zero restores the grip. The clip has 15 rotation
channels and does not move the root or the wrist.

The mesh is sized for a roughly 17 cm adult hand. Model scale, finger shape and
pad compression are rendering choices and do not prescribe needling technique.

The encounter renderer joins the wrist to the practitioner's own sleeve with
two-bone inverse kinematics. A target outside the arm's reach is clamped rather
than stretching either bone. For low targets, a hip hinge shifts the upper body
only as far as needed, up to 16 cm toward the hand and 12 cm downward in the
figure's metre frame; the feet remain planted. These bounds define illustrative
choreography, rather than anatomical limits or clinical technique. The standard
low-back reference insertion is tested against the actual patient figure and
the practitioner's engine-authorized stance.
