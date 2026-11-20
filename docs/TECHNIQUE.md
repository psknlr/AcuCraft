# Needling technique

What the operator's hands do with a needle once the point is found — how it goes in, how it is worked, how it comes
out — is part of the encounter as **parameters**: the engine executes them, records them, lets the operator feel
their result, and the evaluator compares what was done with what was planned.

The numbers on this page are a teaching simplification of textbook technique. They are **unreviewed**: they exist to
make "how much stimulation" a quantity, so that the lesson of the response model (docs/EVIDENCE.md) holds for every
technique — *depth and place decide whether qi arrives; force only decides how soon the patient has had enough*.

Everything here is public knowledge (`lookup techniques`, `referenceLibrary(sc).techniques`): it is what a
practitioner knows and does. What the patient's tissue is stays hidden (docs/ARCHITECTURE.md §7).

## 1. Putting a needle in

`insert_needle` takes, besides the place (`mark`, or `region`/`side`/`at` with the `target` it is meant for):

| field | values | meaning |
| --- | --- | --- |
| `angleDeg` | 0–90 | from the perpendicular: 0–30 *perpendicular* 直刺, 30–65 *oblique* 斜刺, 65–90 *transverse* 平刺 |
| `azimuthDeg` | 0–360 | the direction the tip travels across the chart: 0 towards the head (+v), 90 towards +u |
| `depthCm` | ≤ 10 | along the shaft (a needle is never inserted to its hilt: 90 % of its length at most) |
| `method` | `single-hand` 单手 · `fingernail-press` 指切 · `pinching` 夹持 · `stretching` 舒张 · `pinch-up` 提捏 · `tube` 管针 | how it is put through the skin; recorded with the insertion |
| `speed` | `swift` · `slow` | through the skin in one movement, or slowly — the patient feels the prick of a slow insertion unless a guide tube is used |

The result says what the fingers **feel**: the tissues the shaft passed, in order, and what the tip lies in — in words
for touch (*loose tissue*, *springy tissue*, *something hard*, *a sudden give, then emptiness*), never in anatomical
names. The insertion itself counts as a stimulation of **0.45**.

## 2. Working a needle

`adjust_needle` moves a needle to another depth (`depthCm`) and/or works it (`technique`):

| technique | parameters (range · default) | stimulation at the defaults |
| --- | --- | --- |
| `lift-thrust` 提插 | `amplitudeMm` 0.5–10 · 3; `frequencyPerMin` 20–240 · 60; `durationSec` 2–120 · 10; `emphasis` even · thrust · lift | 0.35 |
| `rotate` 捻转 | `arcDeg` 30–720 · 180; `frequencyPerMin` 20–240 · 80; `durationSec` 2–120 · 10; `direction` both · clockwise · counter-clockwise | 0.30 |
| `scrape` 刮 | `durationSec` | 0.10 |
| `flick` 弹 | — | 0.08 |
| `shake` 摇 | `durationSec` | 0.15 |
| `tremble` 震颤 | `durationSec` | 0.20 |

Lifting and thrusting moves the tip between the depth set and a little above it: it never goes deeper than the depth
set. A parameter that is left out takes its default.

**How much.** One act gives the technique's stimulation scaled by the square root of each parameter's ratio to its
default — twice the amplitude is not twice the stimulus — and at most 1:

```
dose = base × √(amplitude/3 mm) × √(rate/default) × √(duration/10 s)        (lift-thrust; arc/180° for rotate)
```

A needle's stimulation is the sum: 0.45 for the insertion and each act's dose. What the patient feels of it is that
sum times their sensitivity (`patient.needleSensitivity`; a quarter more when they are anxious): past **1.5** a
working is too strong — the patient says so, and the sensation is no longer deqi. Working a needle takes simulated time: the seconds it is worked and twenty more to take hold of it.

**How it reads.** Each working of a needle is read as *reinforcing* 补, *reducing* 泻 or *even* 平补平泻 by the
textbook contrasts: small, slow, short, forceful on the thrust reinforces; large, fast, long, forceful on the lift
reduces.

| contrast | reinforcing | reducing |
| --- | --- | --- |
| lift-thrust amplitude | under 2.5 mm | over 4.5 mm |
| lift-thrust rate | under 50 /min | over 100 /min |
| lift-thrust emphasis (counts twice) | thrust | lift |
| twirling arc | under 150° | over 270° |
| twirling rate | under 60 /min | over 120 /min |
| duration | under 6 s | over 30 s |

Two contrasts one way make the character; anything else is even. Auxiliary techniques have none.

**What is felt.** After every working, the operator feels the needle: gripped, or turning free. That is an item of
evidence of the needle's response (`feel-N`, docs/EVIDENCE.md §3), exactly like the patient's answer to
`check_sensation`.

## 3. A stuck needle

Twirling **one way** winds the tissue round the shaft: the turns add up (clockwise positive). At **360°** of net
winding the needle is *stuck* 滞针: it is bound tight, the patient feels a sharp pain, and the operator feels it.

A stuck needle is never pulled. While it is bound:

- `remove_needle` is refused (`stuck-needle`), and `remove_all_needles` leaves it in place;
- moving it to another depth, lifting and thrusting it, or trembling it is blocked;
- each such attempt is recorded as unsafe (`forced-stuck-needle`).

It is released by turning it **back** (twirling the other way until the net winding is under 180°), or by loosening
the tissue round it: `flick`, `scrape` or `shake` each let go of 90°. The operator then feels it turn free, and it can
be withdrawn.

## 4. Taking a needle out

`remove_needle` takes `speed` (`quick` · `slow`) and `press` (a dry swab held on the hole as the needle leaves: a site
that would bleed does not). Both are recorded with the needle.

## 5. What the record and the evaluator make of it

A needle's view entry (`needling[]`) carries how it went in (`method`, `angleDeg`, `azimuthDeg`, `depthCm`), what the
tip is felt to lie in (`feel`), whether it is `stuck`, every working as it was done (`worked[]`: parameters, `dose`,
`character`, a one-line `summary`, the `evidence` id of what was felt), and the `stimulation` it has had in all.

The evaluator (docs/EVALUATION.md §4, procedure track) adds:

| item | weight | met when |
| --- | --- | --- |
| `no-overstimulation` | 1 | no needle was worked beyond what the patient tolerated |
| `stimulation-as-planned:v<N>` | 1 | the workings of the visit read as the plan's `technique.stimulation` states: `even` — every basic working reads even; `reinforcing` or `reducing` — at least one reads so and none reads the opposite; `none` — no needle was worked at all. Not scored when the plan states a stimulation and no basic working was done |
| `stuck-needle-released` | 2 | no attempt was made to pull or drive a stuck needle |

and its report lists, per needle, how it went in, each working and its character, the total stimulation, whether it
was ever stuck, and how it was withdrawn.

## 6. Working a needle by hand

In the studio (docs/STUDIO.md) a needle can be taken hold of in the needling field and worked with the pointer:
a drag along the needle's line lifts and thrusts it, a drag across it twirls it. The gesture is **measured** — mean
stroke, rate, which stroke was the quicker; arc, rate, or the whole turn and its direction — and sent as the
`adjust_needle` it amounts to. A language model sends the same action with the same parameters. Either way the engine
decides what the tissue answers.

## 7. Limits

- The dose formula, the tolerance and the character thresholds are schematic and unreviewed.
- The insertion `method` is recorded and shown; apart from the guide tube sparing the prick of a slow insertion it
  does not change the outcome.
- Bending and breaking a needle, moxibustion on the needle, electro-acupuncture and warm needling are not modelled.
