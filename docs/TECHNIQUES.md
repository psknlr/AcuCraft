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

These legacy gestures do not provide a reviewed model of tissue deformation, force, shaft elasticity, haptic feedback or therapeutic effects. Clinical findings and the patient's response continue to come from the deterministic encounter model, independently of the visual animation.

## The 36-entry performance catalogue

`perform_technique` adds a separate, presentation-only action for the revised working vocabulary: 24 named maneuvers, 10 compound demonstrations, and bu/xie. Operator controls, the server's GPT/MiniMax/Claude loop, and MCP clients all use this action and the same strict parameter schema. It records an accepted performance without changing the retained depth, needle lifecycle, tissue response, evidence ledger, or clinical clock. Use `insert_needle`, `adjust_needle.depthCm`, and `remove_needle` for actual encounter state changes.

`lookup { "topic": "techniques" }` returns the catalogue, per-technique defaults, available controls, the motion schema and parameter descriptors. Each entry includes Chinese and English labels, an operating context, an explicit phase recipe, and an authored, unreviewed provenance. These are reproducible demonstrations, not a claim that all traditional variants or GB/T procedures have been clinically validated.

| Context | Catalogue IDs | Required target |
|---|---|---|
| Surface contact | `chuai` 揣, `zhua` 爪, `xun` 循, `she` 摄, `an` 按 | A current mark, explicit regional chart coordinates, or a needle's recorded site |
| Retained needle | `yao` 摇, `pan` 盘, `nian` 捻, `cuo` 搓, `jin` 进, `tui-withdraw` 退, `ti` 提, `cha` 插, `gua` 刮, `tan` 弹, `fei` 飞, `mo` 摩, `dong` 动, `tui-push` 推, `chan` 颤, `nu` 弩, `sou` 搜, `bo` 拨 | A needle actually retained in this visit |
| Post-removal contact | `men` 扪 | A needle withdrawn in this visit; its recorded entry anchors the surface contact |
| Compound demonstrations | `shao-shan-huo`, `tou-tian-liang`, `qing-long-bai-wei`, `bai-hu-yao-tou`, `cang-gui-tan-xue`, `chi-feng-ying-yuan`, `long-hu-jiao-zhan`, `zi-wu-dao-jiu`, `yang-zhong-yin-yin`, `yin-zhong-yin-yang` | A retained needle; the catalogue lists each authored phase |
| Bu/xie demonstrations | `bu` 补, `xie` 泻 | A retained needle |

Compound sequences reorganize the same deterministic motor primitives; their phase names and timing are visible in playback. Source-dependent names such as She, Dong, Nu, Sou and Bo retain their Chinese labels and explicit illustrative status instead of asserting one universally correct traditional definition.

```json
{
  "type": "perform_technique",
  "technique": "gua",
  "needleId": "pack-a.1",
  "motion": {
    "durationMs": 3200,
    "cycles": 4,
    "grip": "two-finger",
    "support": "none",
    "hand": "right",
    "gripApertureMm": 2,
    "contactIntensity": 0.4
  }
}
```

For an LLM/MCP tool call, omit `type` and use the tool name `perform_technique`; MCP also requires `session_id`. An operator's Execute button submits the same fields through the hub. Unknown keys, non-finite values and out-of-range inputs are rejected before they enter the action log.

| Motion setting | Allowed values / range | Meaning |
|---|---|---|
| `durationMs` | 400–30000, integer | Duration of the entire performance, not a clinical treatment duration |
| `cycles` | 1–12, integer | Movement cycles per primitive phase; `durationMs` still covers the whole performance |
| `phaseCycles` | One integer from 1 to 12 per compound phase | Optional repeat counts in catalogue phase order. These override `cycles` for that performance. |
| `strokeMm` | 0–3 mm | Outward axial displacement, additionally clamped to retained depth |
| `rotationDeg` | 0–180° | Peak angular excursion for Nian, Cuo, Bu and Xie |
| `lateralMm` | 0–4 mm | Surface tracing or external shaft/handle deflection |
| `tiltDeg` | 0–8° | External shaft/handle tilt, not internal-tip redirection |
| `tempoBias` | 0.2–0.8 | Relative timing of the two parts of a movement cycle |
| `direction` | `alternating`, `clockwise`, `counterclockwise` | Primary excursion viewed from the handle toward the tip. Each cycle returns to rest. |
| `grip` | `two-finger`, `three-finger` | Thumb/index holding by default; optional middle-finger support |
| `gripStyle` | `tip-pinch`, `side-pinch` | Compact terminal-pulp holding, or a more proximal index contact with its tip extending below the grip |
| `wristElevationDeg` | degrees, two-finger 35–70 / default 55; three-finger 44–51 / default 48; Gua/Tan 50–60 / default 55 | Actual hand/wrist elevation; use `handProfiles` and the technique's `parameterBounds`, independent of clinical insertion angle |
| `idleFingerPose` | `curled`, `relaxed` | Graduated poses of digits not participating in holding or nail work |
| `support` | `none`, `stabilize`, `stretch`, `pinch`, `press` | Supporting-hand contact pattern |
| `hand` | `auto`, `left`, `right` | Primary hand selection |
| `gripApertureMm` | 0–12 mm | Approach/release opening, with minimum disengagement clearance; for Gua, index-nail clearance from the handle while the thumb separately clears the tail |
| `contactIntensity` | 0–1 | Normalized cosmetic contact intensity; no unit of force |

Defaults and relevant controls differ by technique. Read them from the catalogue rather than assuming every setting visibly affects every primitive. None of these bounds is a clinical dose or an anatomical limit.

In the catalogue animation, alternating Nian and Cuo reach the requested angle on
both sides of neutral. A directional turn reaches that angle on its chosen side
and returns. Ti and Cha reach the requested outward excursion in each cycle,
subject to the retained-depth limit. The authored Bu and Xie combine the same
axial stroke with an earlier or later twist respectively. Pan follows a circle in
the plane perpendicular to the shaft. Its diameter equals the requested lateral
excursion before the exposed shaft's length constraint. Alternating Pan reverses
the path on successive cycles. Fei closes the thumb/index pair, rolls the handle while
the pads are engaged, and settles the handle before the fingers reopen.

For skin contact, Zhua uses the distal edge of the index nail with the other fingers
curled clear of the surface. She uses a short trace with that edge, following the
nail-scraping variant in the supplied reference. Changing the supporting hand
preserves the working digit and its path. With `support: "pinch"`, the other
hand brings the thumb and index together on the neighboring skin. The animation
tracks two points on the fingertips as the hand closes and the patient breathes.

Ordinary retained-needle holding defaults to the thumb/index pair. Choosing three-finger support explicitly adds middle volar-pulp support beside that pair; it does not replace the index finger. Fei and ordinary compound holding phases preserve the chosen grip. The authored nail-work variants have separate roles: Gua braces the needle tail with the thumb and scrapes the handle with the index nail edge; Tan prepares the index against the thumb, releases the thumb, and makes index-nail contact followed by recoil.

The reference-based hand uses a raised wrist and a curled index with a shorter,
broader thumb. `gripStyle` is advertised for ordinary holding; Gua/Tan keep their
fixed nail-work roles. The **手部 Grip** camera cycles through complete hand views
for checking the palm, thumb origin and needle together. See
[the reference-pose guide](REFERENCE-POSES.md) for the image groups and controls.

For a compound performance, the catalogue divides its total duration into stages. In **Set repeat counts by phase**, an operator can set each stage independently. For **阳中隐阴** (`yang-zhong-yin-yin`), `"motion": { "durationMs": 6000, "phaseCycles": [1, 3] }` animates one Bu cycle in the first three seconds and three Xie cycles in the last three. Omitting `phaseCycles` uses the shared `cycles` value throughout. Rotation settles at each stage boundary.

## Admission, records and replay

The engine checks permission, current patient position, chart bounds, reach, target consistency and needle lifecycle. Performances other than post-removal Men also require current-plan consent and a patient whose condition permits continued treatment. Men remains available as aftercare following withdrawal of consent or an interruption; it does not reinsert or reuse the removed needle.

Surface contact uses the existing contact semantics: it soils the actor's hands and invalidates the prepared skin at the touched region/side. A later insertion still has to satisfy the normal hygiene and site-preparation rules. Choosing a supporting hand is not a shortcut around those checks.

Accepted performances appear in `view.performances` (the latest 64) with their resolved parameters, site, patient position, actor, visit, request ID and provenance. The request ID ties playback to the correct timeline event when several actors act quickly. Refused gestures do not append a performance. The authoritative action log retains all accepted requests for deterministic replay. The optional history is created only by the new action, so historical trajectories without performances retain their previous digest and can still be restored.

The provenance says `kind: illustrative`, `source: acucraft-authored-demonstration-v1`, `review: unreviewed`, and `forces: not-modelled`. It contains executed chart coordinates, not hidden anatomical findings, inferred therapeutic effects or measured force values.

## Preview and fine 3D control

The manipulation panel selects a target and technique, exposes the applicable parameters, and keeps edits as an operator draft. Preview changes only local animation; Execute records an action after engine validation. Preview requires a compatible visible body site or retained needle, and does not create a performance, alter patient state, or advance the clinical clock.

Local playback supports pause, speed adjustment and preview seeking. Valid parameter edits update an active preview in place while retaining its normalized progress, pause state and speed; changing the target or technique cancels that preview. Recorded performances retain their accepted parameter values; their clinical record is not rewound by playback controls. A newer authoritative state cancels an obsolete preview, and a recorded gesture takes precedence over starting a new local preview.

The hand controller uses the Blender rig's moving pad/nail anchors, separate finger poses, grip changes and supporting-hand contacts. During ordinary needle holding, the opposing thumb/index pads meet the actual handle surface; `gripApertureMm` controls opening during approach and release. An explicitly chosen three-finger grip adds middle volar-pulp support. Gua's opening controls the index nail's release gap from the handle, with at least 1.5 mm clearance; the thumb separately clears the needle tail by 1.5 mm. Tan uses thumb/index skin contact during preparation and a separate index-nail contact/recoil cycle, and does not advertise an aperture control.

The pure `sampleTechnique` output separates `gripEngagement` (local thumb/index contact, independent of approach/release) from the legacy `grip` envelope. A renderer that already supplies approach, grasp, release and retreat timing applies its envelope once and uses `gripEngagement` only for intentional local changes such as Fei. Normal holding remains engaged at motion endpoints and compound phase boundaries, avoiding an extra open/close jump as the manipulation starts or stops.

Needle axial strokes remain within the executed depth. Lateral motion and bending affect the exposed shaft/handle geometry only; they do not move the skin entry or redirect the internal needle tip. The display does not claim to solve tissue deformation, internal shaft elasticity, contact force or haptics.

These bounds describe `perform_technique` and legacy `motion` presentation settings. Explicit top-level `adjust_needle` stroke, frequency, rotation and duration parameters use the separately checked clinical envelope described in [CHARACTER-CONTROL.md](CHARACTER-CONTROL.md). The two APIs retain their own units and timing semantics, and both use the same articulated hands.

Insertion remains a clinical `insert_needle` action. Its optional `presentation` field selects `durationMs` (400–8000), `grip`, `support`, `hand` and `gripApertureMm` (0–12) for the approach/grip/insertion animation. Angle, azimuth and depth remain the existing validated clinical inputs, and the renderer uses the executed result when insertion is partial. The Studio **Skin contact** slider sets when the tip first touches skin during that movement (20–80%, default 45%). Models send the same value as `presentation.skinContactFraction` (0.2–0.8). The clock starts once the practitioner has approached and secured the needle. During insertion the tip meets the moving skin at the chosen fraction, then settles at the recorded endpoint. On a breathing torso, the nail used for Zhua or She follows the same point on the skin as the torso moves.

[Studio insertion at 70% contact](img/studio-insertion-contact.png) · [Compound Studio playback](img/technique-compound-studio.mp4) · [Studio phase controls](img/technique-compound-controls.png) · [Validation measurements](TECHNIQUE-MOTION-VALIDATION.json)
