# Manipulation gestures in the simulator

`adjust_needle` accepts `lift`, `thrust`, `lift-thrust`, `twist`, `rotate`, `bu` and `xie`, as well as `none` for a depth change without manipulation. Existing `lift-thrust` and `rotate` actions and saved trajectories retain their meaning. Insertion remains `insert_needle`; withdrawal remains `remove_needle`.

Every name uses the same engine path: an inserted needle, the actor's reach and permission, the patient's consent and condition, and the requested depth are checked before any state change. The action records the gesture and produces evidence of what the operator felt. `lift`, `thrust`, `bu` and `xie` use the existing lift-thrust simulation stimulus; `twist` uses the existing rotation stimulus. Bu (tonification) and xie (sedation) receive no special efficacy multiplier or score. Their opposite timing is an illustrative visual convention, not expert-reviewed clinical instruction.

An action may include optional presentation settings:

```json
{
  "type": "adjust_needle",
  "needleId": "pack-a.1",
  "technique": "bu",
  "motion": { "cycles": 3, "durationMs": 2400, "strokeMm": 1.5, "rotationDeg": 90 }
}
```

| Setting | Unit | Range | Default |
|---|---|---|---|
| `cycles` | displayed cycles over the whole animation | 1–8, integer | 3 |
| `durationMs` | milliseconds for the whole animation | 400–8000, integer | 1800 |
| `strokeMm` | outward travel from the approved depth | 0–3 mm | 1.5 mm |
| `rotationDeg` | maximum displayed twist amplitude | 0–180° | 90° |

These settings tune playback, not clinical dosing: one action remains one simulation manipulation. They do not change the retained depth, tissue response or simulated duration of the action. A different depth must be requested with `depthCm` and passes the anatomy guard. Settings are retained in the action log so presentation can be replayed.

`techniqueMotion(technique, elapsedMs, motion?)` is the shared pure sampler for the browser and 3D authoring. It returns `withdrawalMm` (outwards along the shaft), `rotationRad`, `durationMs` and `complete`. A renderer must clamp the outward stroke to the currently retained depth, so the needle neither leaves the skin nor travels deeper than its approved path. Every cycle starts and ends at the resting pose with smooth phase transitions; rotation also returns to its original orientation. `resolveNeedleMotion` exposes the defaults and bounds.

This simulation has no reviewed model of tissue deformation, force, needle bending, haptic feedback or therapeutic effects of these gestures. Clinical findings and the patient's response continue to come from the existing deterministic encounter model, independently of the visual animation.
