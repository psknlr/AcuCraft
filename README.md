# AcuCraft · Singapore

**An acupuncture simulation and evaluation environment built on [ClinicalCraft](https://github.com/psknlr/ClinicalCraft).**
A practitioner — a human learner or an AI agent — conducts a whole encounter in a simulated outpatient TCM clinic in
Singapore: consultation, examination, records, pattern differentiation, evidence, a clinical decision (treatment,
deferral and referral are all valid outcomes), consent, localisation on this patient, virtual needling, monitoring,
completion, documentation and a follow-up visit. An independent evaluator scores the complete trajectory.

> **Status: first implementation milestone of the design proposal.** The engine, the evaluator and a pilot content pack
> (4 case families × 3 variants) are implemented and tested. **All clinical, anatomical and regulatory content is
> AI-assisted and unreviewed**: the regional anatomy is schematic, the Singapore rule encodings have not been checked
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

Play the practitioner yourself (`help` inside; `--mode teaching` shows reference locations):

```bash
npm run acu -- play sg-knee-oa/base --mode teaching
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
| `packages/core` — `@acucraft/core` | schemas; scenario resolution (family + variant overlays); patient-specific anatomy, proportional (B-cun) localisation and needle path assessment; the deterministic encounter engine over ClinicalCraft's clinical session; needle lifecycle and invariants; roles, versioned rules and the simulation guard; consent; delegation and NPC policies; field events; replay; the agent view |
| `packages/bench` — `@acucraft/bench` | content loader; the independent evaluator (primary endpoint, five tracks, critical errors, unsafe attempts executed/blocked, adjudication, STRICTA-informed documentation); agents (reference oracle, rule-based protocol, Claude); runner; suites; statistics; reports |
| `packages/cli` — `acucraft` | `validate`, `list`, `show`, `locate`, `run`, `play`, `replay`, `evaluate`, `bench`, `export-clinicalcraft` |
| `content/` | 3 standard editions, 41 versioned point definitions (21 localised), 5 regional models, Singapore roles, 3 rule-set series, the clinic, vocabulary, guideline evidence, 4 families, the pilot suite |
| `tools/` | `bootstrap.sh` (the pinned engine), `check.sh` (what CI runs), `locate.ts`, `content/` (family authoring scripts) |

### The case families

| family | split | variants |
|---|---|---|
| `sg-knee-oa` — knee pain, 63 | dev | base (a needle starts to burn during retention) · on warfarin with varicose veins over SP9 · hot swollen knee with fever after an injection (emergency referral) |
| `sg-low-back-pain` — 34, office worker | dev | base (dated 2027: the newer TCMPB advisory version is in force) · cauda equina (emergency referral) · 24 weeks pregnant (no prone positioning, cautioned points) |
| `sg-tension-headache` — 29, accountant | dev | base · declines to lie face down, hasn't eaten, faints when treated sitting · very slim build (the pleura under GB21 within 2 cm) |
| `sg-chemo-nausea` — 52, on chemotherapy | held-out | base · lymphoedematous left arm · neutropenia and thrombocytopenia on the latest count (defer, liaise with oncology) |

Every variant has a reference trajectory that reaches an acceptable pathway, and each family's base course fails every
other variant of the family (both are tested).

## Design proposal coverage

| proposal | implemented | not yet |
|---|---|---|
| §2 built on ClinicalCraft, content-pack structure | each scenario's consultation is a ClinicalCraft case run by `@clinicalcraft/core` (pinned); `.clinicalcraft/settings.json` and `export-clinicalcraft` for ClinicalCraft's front-ends | a ClinicalCraft facility and world-runtime integration (3D clinic); ClinicalCraft agent runtime and MCP |
| §3 Singapore roles, consent, records, rule versions with effective dates | role permissions incl. supervised learners; consent to plan versions, refusal, withdrawal; investigation access by role; rule series with versions in force by visit date ([SINGAPORE.md](docs/SINGAPORE.md)) | verification of the TCMPB texts; encoding of the 2027 advisory; Mandarin dialogue |
| §4 the complete encounter | consultation (one or two questions at a time), assessment, decision, planning, preparation, procedure, observation, completion, follow-up | |
| §5 versioned definitions; definition / patient instance / actual entry; cun per patient; regional models; separate localisation and path assessment | yes ([ANATOMY.md](docs/ANATOMY.md)); WHO 2008 vs GB/T 12346-2021 recorded | reviewed, atlas- or imaging-derived anatomy |
| §6 needle identity, lifecycle, contamination, invariants, lost and broken needles, distinct sensation records | yes; invariants checked after every step in tests and CI | |
| §7 shared action system for all characters; observable delegation; deterministic control; seeded events; replay from recorded outputs; four records per request | yes ([ARCHITECTURE.md](docs/ARCHITECTURE.md)) | LLM-voiced patient and assistant (the patient answers from authored facts) |
| §8 fixed case state, investigation sequence, "not provided or not modelled" | yes (ClinicalCraft records and turnaround) | |
| §9 primary endpoint, separate reports, five tracks, multiple pathways, adjudication, family splits, clustering | yes ([EVALUATION.md](docs/EVALUATION.md)) | expert review; the four experiments need live-model runs |
| §10 MVP: ~40 families, 120 instances, 30–40 points, 4–6 regions | 4 families, 12 instances; 41 points (21 localised); 5 regions; practitioner, patient and support roles; the clinic; interruptions, abnormal sensations, bleeding, a syncope-like event, a dropped needle (tests); UI (CLI), action API, case format, replay, reports | 36 more families; a graphical UI |
| §13 release acceptance criteria | each one is an executable test (`packages/bench/src/acceptance.test.ts`) | |

Electroacupuncture, moxibustion and haptics are out of scope for this release, as the proposal plans.

## Baseline result

`npm run bench -- --agent protocol` (pilot-v1, seed 1): **11/12** encounters succeed (dev 8/9, held-out 3/3). The one
failure is designed. On the slim-build headache variant the agent's textbook GB21 depth would reach the pleura. The
guard blocks it and the blocked attempt counts as a critical error. The reference oracle succeeds on 12/12. There are no live-model results: this release was built without API access, and the Claude agent's loop is tested against a mock client.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — packages, the encounter engine, needles, roles and rules, NPCs, the agent view, replay
- [docs/ANATOMY.md](docs/ANATOMY.md) — charts, configurations, patient-specific instances and cun, tissue, needle paths
- [docs/EVALUATION.md](docs/EVALUATION.md) — endpoint, tracks, agents, statistics, the baseline
- [docs/SINGAPORE.md](docs/SINGAPORE.md) — roles, rule sets and versions, what remains to verify
- [docs/CONTENT.md](docs/CONTENT.md) — authoring families, variants, fields, conditions and reference trajectories

## Licence

Not yet chosen: the package manifests declare MIT (as ClinicalCraft does) and the regional models are marked CC0-1.0
original schematic geometry, but there is no LICENSE file yet — add one to settle it. Point location texts are
paraphrases written for this pack and must be checked against the cited standards.
