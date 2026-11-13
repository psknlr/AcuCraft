# AcuCraft · Singapore

**An acupuncture simulation and evaluation environment built on [ClinicalCraft](https://github.com/psknlr/ClinicalCraft).**
A practitioner — a human learner or an AI agent — conducts a whole encounter in a simulated outpatient TCM clinic in
Singapore: consultation, examination, records, pattern differentiation, evidence, a clinical decision (treatment,
deferral and referral are all valid outcomes), consent, localisation on this patient, virtual needling, monitoring,
completion, documentation and a follow-up visit. An independent evaluator scores the complete trajectory.

Two things make the encounter more than a transcript:

- **The clinic is a place.** Its floor plan is a ClinicalCraft facility; the practitioner has a body in it, walks along
  planned paths, and can only do what is within reach of where they stand — a point on the far side of the couch means
  walking round it ([docs/WORLD.md](docs/WORLD.md)).
- **Conclusions rest on evidence.** A pattern differentiation names the findings it rests on and is read from what
  those findings show; a recorded deqi names what was observed at that needle and is compared with what the tissue did.
  Nothing can be cited that was not obtained, and stronger stimulation is never rewarded
  ([docs/EVIDENCE.md](docs/EVIDENCE.md)).

![The treatment room of the simulated clinic in ClinicalCraft's 3D world: the couch, the needle trolley, the patient's chair, the screen](docs/img/clinic-3d-treatment-room.png)

*The clinic's facility rendered by ClinicalCraft's own 3D world. AcuCraft's engine is headless: it reasons about the
same building — where one can stand, walk and reach — without drawing it.*

> **Status: first implementation milestone of the design proposal.** The engine, the evaluator and a pilot content pack
> (5 case families × 3 variants) are implemented and tested. **All clinical, anatomical and regulatory content is
> AI-assisted and unreviewed**: the regional anatomy is schematic for the head and limbs and derived from one reference body for the trunk, the Singapore rule encodings have not been checked
> against the source documents, and no institution is involved. Scores are teaching-script measures for simulation
> research — not validated competency scores and not evidence of clinical effectiveness.

## Quick start

Node 22. The ClinicalCraft engine is fetched at the pinned revision (`tools/clinicalcraft.rev`) into `.deps/`.

```bash
npm install
```

```bash
npm run bootstrap
```

```bash
npm test
```

```bash
npm run validate
```

Run one encounter with the rule-based baseline agent, then replay it:

```bash
npm run acu -- run sg-knee-oa/base --agent protocol --verbose
```

```bash
npm run acu -- replay runs/sg-knee-oa--base--protocol--s1/log.json
```

Play the practitioner yourself (`help` inside: `go`, `where`, `map`, `feel`, `evidence`; `--mode teaching` shows
reference locations and how each differentiation reads):

```bash
npm run acu -- play sg-knee-oa/base --mode teaching
```

The clinic's floor plan, and what each pattern is recognised by:

```bash
npm run acu -- map sg-knee-oa/base
```

```bash
npm run acu -- vocabulary
```

An HTML view of a run — the floor plan with every walk, the charts, the evidence links and the timeline:

```bash
npm run acu -- view runs/sg-knee-oa--base--protocol--s1/log.json
```

Browse the point library: counts by channel, one channel, body area or region, or one point in full:

```bash
npm run acu -- points
```

```bash
npm run acu -- points forearm
```

```bash
npm run acu -- points ST36
```

Run the pilot benchmark (dev and held-out splits, Wilson and family-cluster intervals):

```bash
npm run bench -- --agent protocol
```

Run it with a live model (needs Anthropic API credentials; default `claude-opus-5-5`, effort `high`, server-side refusal
fallback on):

```bash
npm run bench -- --agent claude --split dev
```

## What is in it

| | |
|---|---|
| `packages/core` — `@acucraft/core` | schemas; scenario resolution (family + variant overlays); patient-specific anatomy, proportional (B-cun) localisation and needle path assessment; the deterministic encounter engine over ClinicalCraft's clinical session; the clinic as a walkable world over ClinicalCraft's world layer (stances, planned walks, reach); the evidence ledger, pattern support and the needle's response; needle lifecycle and invariants; roles, versioned rules and the simulation guard; consent; delegation and NPC policies; field events; replay; the agent view |
| `packages/bench` — `@acucraft/bench` | content loader; the independent evaluator (primary endpoint, five tracks, critical errors, unsafe attempts executed/blocked, the evidence links, adjudication, STRICTA-informed documentation); agents (reference oracle, rule-based protocol, Claude); runner; suites; statistics; reports; the HTML viewer |
| `packages/cli` — `acucraft` | `validate`, `list`, `points`, `show`, `map` (the floor plan), `vocabulary` (signs, pattern criteria, deqi), `locate`, `run`, `play`, `replay`, `evaluate`, `view` (an HTML encounter viewer: the floor plan with every walk, charts with landmarks, structures, reference locations and entries, the evidence links and the timeline), `bench`, `export-clinicalcraft` |
| `content/` | 3 standard editions, the full point library (409: the WHO 2008 standard's 361 meridian points and the WHO 1991 nomenclature's 48 extra points; 399 localised and needleable), 18 regional models covering the whole body (the trunk and front of the neck derived from the HuBMAP Visible Human Male reference body, CC BY 4.0, see THIRD_PARTY.md; the head and limbs schematic) and where each lies on the body, Singapore roles, 3 rule-set series, the clinic and its floor plan (a ClinicalCraft facility with three room templates and an equipment catalog), the vocabulary (diagnoses, 66 signs, 13 patterns with their criteria, needle sensations, deqi), guideline evidence, 5 families, the pilot suite |
| `tools/` | `bootstrap.sh` (the pinned engine), `check.sh` (what CI runs), `locate.ts`, `finish-solutions.ts` (replays the reference trajectories: drops idle walks, writes the needle responses from the evidence), `content/` (authoring scripts: families, the clinic's world, the vocabulary) |

### The case families

| family | split | variants |
|---|---|---|
| `sg-knee-oa` — knee pain, 63 | dev | base (a needle starts to burn during retention) · on warfarin with varicose veins over SP9 · hot swollen knee with fever after an injection (emergency referral) |
| `sg-low-back-pain` — 34, office worker | dev | base (dated 2027: the newer TCMPB advisory version is in force) · cauda equina (emergency referral) · 24 weeks pregnant (no prone positioning, cautioned points) |
| `sg-tension-headache` — 29, accountant | dev | base · declines to lie face down, hasn't eaten, faints when treated sitting · very slim build (the pleura under GB21 within 2 cm) |
| `sg-chemo-nausea` — 52, on chemotherapy | held-out | base · lymphoedematous left arm · neutropenia and thrombocytopenia on the latest count (defer, liaise with oncology) |
| `sg-insomnia` — 54, taxi driver | held-out | base · withdraws consent after two needles · low mood with suicidal thoughts (same-day urgent help) |

Every variant has a reference trajectory that reaches an acceptable pathway, and each family's base course fails every
other variant of the family (both are tested).

## Design proposal coverage

| proposal | implemented | not yet |
|---|---|---|
| §2 built on ClinicalCraft, content-pack structure | each scenario's consultation is a ClinicalCraft case run by `@clinicalcraft/core` (pinned); the clinic is a ClinicalCraft facility, and the encounter runs on `@clinicalcraft/world`'s collision, navigation and sight — people stand somewhere, walk planned paths and act within reach ([WORLD.md](docs/WORLD.md)); `.clinicalcraft/settings.json` and `export-clinicalcraft` for ClinicalCraft's front-ends | the encounter played inside ClinicalCraft's 3D renderer (the engine is headless: the world is used as geometry, not drawn); ClinicalCraft agent runtime and MCP |
| §3 Singapore roles, consent, records, rule versions with effective dates | role permissions incl. supervised learners; consent to plan versions, refusal, withdrawal; investigation access by role; rule series with versions in force by visit date ([SINGAPORE.md](docs/SINGAPORE.md)) | verification of the TCMPB texts; encoding of the 2027 advisory; Mandarin dialogue |
| §4 the complete encounter | consultation (one or two questions at a time), assessment, decision, planning, preparation, procedure, observation, completion, follow-up; pattern differentiation and deqi linked to evidence — a ledger with stable ids, conclusions that name what they rest on, read from the field and never from the claim ([EVIDENCE.md](docs/EVIDENCE.md)) | expert review of the signs, the criteria of each pattern and the needle-response model |
| §5 versioned definitions; definition / patient instance / actual entry; cun per patient; regional models; separate localisation and path assessment | yes ([ANATOMY.md](docs/ANATOMY.md)); WHO 2008 vs GB/T 12346-2021 recorded; the whole body modelled in 18 regions, the trunk imaging-derived (HuBMAP Visible Human Male) | expert review; imaging-derived limbs and head (open data with attribution-only licences lacks nerves and limb vessels); per-patient imaging |
| §6 needle identity, lifecycle, contamination, invariants, lost and broken needles, distinct sensation records | yes; invariants checked after every step in tests and CI | |
| §7 shared action system for all characters; observable delegation; deterministic control; seeded events; replay from recorded outputs; four records per request | yes ([ARCHITECTURE.md](docs/ARCHITECTURE.md)) | LLM-voiced patient and assistant (the patient answers from authored facts) |
| §8 fixed case state, investigation sequence, "not provided or not modelled" | yes (ClinicalCraft records and turnaround) | |
| §9 primary endpoint, separate reports, five tracks, multiple pathways, adjudication, family splits, clustering | yes ([EVALUATION.md](docs/EVALUATION.md)) | expert review; the four experiments need live-model runs |
| §10 MVP: ~40 families, 120 instances, 30–40 points, 4–6 regions | 5 families (3 dev, 2 held-out), 15 instances; all 409 standard points defined (399 localised); 18 regions covering the whole body; practitioner, patient and support roles; the clinic; interruptions, abnormal sensations, bleeding, a syncope-like event, consent withdrawn mid-procedure, a dropped needle (tests); UI (CLI), action API, case format, replay, reports | 35 more families; a graphical UI |
| §13 release acceptance criteria | each one is an executable test (`packages/bench/src/acceptance.test.ts`) | |

Electroacupuncture, moxibustion and haptics are out of scope for this release, as the proposal plans.

## Baseline result

`npm run bench -- --agent protocol` (pilot-v1, seed 1): **14/15** encounters succeed (dev 8/9, held-out 6/6). The one
failure is designed. On the slim-build headache variant the agent's textbook GB21 depth would reach the pleura. The
guard blocks it and the blocked attempt counts as a critical error. The reference oracle succeeds on 15/15.

The evidence links say more than the endpoint. The baseline's keyword differentiation rests on the findings it names
in 9 of 11 encounters (in the knee family it never asks about the weather and settles on a pattern one tender point
cannot carry); it records a response for all 47 needles and none as deqi without evidence of it; it walks about 69 m
an encounter. There are no live-model results: this release was built without API access, and the Claude agent's loop is tested against a mock client.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — packages, the encounter engine, needles, roles and rules, NPCs, the agent view, replay
- [docs/WORLD.md](docs/WORLD.md) — the clinic as a ClinicalCraft facility, standing and walking, what each act needs within reach, the body on the couch
- [docs/EVIDENCE.md](docs/EVIDENCE.md) — the evidence ledger, pattern differentiation read from its findings, the needle's response and how a recorded deqi is checked
- [docs/ANATOMY.md](docs/ANATOMY.md) — charts, configurations, patient-specific instances and cun, tissue, needle paths
- [docs/EVALUATION.md](docs/EVALUATION.md) — endpoint, tracks, agents, statistics, the baseline
- [docs/SINGAPORE.md](docs/SINGAPORE.md) — roles, rule sets and versions, what remains to verify
- [docs/CONTENT.md](docs/CONTENT.md) — authoring families, variants, fields, conditions and reference trajectories

## Licence

Not yet chosen: the package manifests declare MIT (as ClinicalCraft does) and the regional models are marked CC0-1.0
original schematic geometry, but there is no LICENSE file yet — add one to settle it. Point location texts are
paraphrases written for this pack and must be checked against the cited standards.
