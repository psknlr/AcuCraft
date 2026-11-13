# AcuCraft — architecture and contracts

> Status: the contract for the packages in this repository. If the code and this page disagree, fix one of them in
> the same change.

AcuCraft is an acupuncture content pack and field extension built on the
[ClinicalCraft](https://github.com/psknlr/ClinicalCraft) engine, pinned to commit
`7362f5e92940041383c1f1699f8dba3ea645a5f1` (`tools/clinicalcraft.rev`). ClinicalCraft runs the consultation; AcuCraft
adds what an acupuncture encounter needs on top of it.

```
 content/ (data)            standards · acupoints · regions · sg/ (roles, rule sets, clinic, vocabulary, evidence)
                            world/ (the clinic's floor plan: a ClinicalCraft facility, room templates, a catalog)
                            families/<id>/ case.json (ClinicalCraft) + field.json (AcuCraft) + variants/ + solutions/
        │
 @acucraft/core (pure)      schemas · scenario resolution (family + variant overlay) · patient-specific anatomy
        │                   and localisation · needle path assessment · the encounter engine (step, replay)
        │                   · the clinic as a walkable world (stances, planned walks, reach) · the evidence ledger,
        │                   pattern support and the needle's response · field events · roles and rules · NPC
        │                   policies · invariants · the agent view
        │   uses
 @clinicalcraft/core        the clinical session: history, examination, records with turnaround, physiology and
        │                   vitals, flags, phases, clock (reduce, matchHistory, matchExam, matchOrders, vitalsAt);
        │                   facility, room-template and catalog schemas, compilation and checks
 @clinicalcraft/world       the static world of a facility, headless: collision model, semantic registry,
        │                   navigation grid and planner, line of sight
        │
 @acucraft/agent            who plays the practitioner: the Agent interface · the reference and rule-based agents
        │                   · the runtime of a language-model practitioner (one typed tool per action, read-only
        │                   tools, standing instructions, skills, model providers, the loop) · the session
        │
 @acucraft/bench (Node)     content loader (with the skills) · independent evaluator · episode runner · suites
        │                   · statistics · reports · the HTML viewer
 @acucraft/mcp              encounters served to an MCP client: another program's agent as the practitioner
 @acucraft/cli              acucraft validate | list | points | show | map | vocabulary | locate | run | play
                            | replay | evaluate | view | bench | export-clinicalcraft | skills | tools | prompt | mcp
```

## 1. Relationship to ClinicalCraft

| ClinicalCraft package | What AcuCraft uses | What AcuCraft adds alongside |
|---|---|---|
| `@clinicalcraft/core` | `CaseSchema` (each scenario's consultation is a `clinicalcraft/case@1` case), `reduce`, `createSession`, `evaluate` (conditions), the matchers, `resultFor`, `vitalsAt`, `verifyCase`, `createRng`/`seedFrom`, `t` | the acupuncture field (`acucraft/field@1`), the encounter state that wraps the clinical session, needling, roles, rules |
| `@clinicalcraft/world` | the static layer of the clinic's facility, headless and pure: `buildCollisionModel`, `buildRegistry`, `GridAStarBackend` (navigation grid and planner, no clock), the visibility model ([WORLD.md](WORLD.md)) | who stands where in an encounter, the patient's body on the couch, the reach rule of every act; the dynamic world runtime and the 3D renderer are not used — the encounter engine stays a pure function |
| `@clinicalcraft/agent` | its design, not its code: typed tools with a read/act split, a model provider behind neutral types, a loop that never throws, skills as data, an MCP server ([AGENT.md](AGENT.md)) | `@acucraft/agent` and `@acucraft/mcp`: one practitioner in one clinic, on AcuCraft's own action interface and `AgentView` |
| `@clinicalcraft/bench` | the conventions (scenario files, Wilson intervals, held-out splits) | `@acucraft/bench` |

The engine is consumed from source: `tools/bootstrap.sh` fetches the pinned revision into `.deps/clinicalcraft`
(git-ignored) and vitest, `tsc` and `tsx` resolve `@clinicalcraft/core` and `@clinicalcraft/world` there
(`vitest.config.ts`, `tsconfig.json` `paths`). AcuCraft provides zod; `@clinicalcraft/core` has no other runtime dependency. `npm run export:clinicalcraft`
writes every scenario instance's case as a plain ClinicalCraft case, so ClinicalCraft's own front-ends can load them
through `.clinicalcraft/settings.json` (`contentDirs`, which also lists `content/world`: the clinic's facility).

Conventions follow ClinicalCraft: TypeScript, ESM, `NodeNext` (relative imports end in `.js`), zod schemas as the source
of truth, `Issue {path, message, severity}`, and **no `Date.now()` or unseeded `Math.random()` in `@acucraft/core`**.

## 2. Scenarios

A **family** (`acucraft/family@1`) is one patient and presentation; a **variant** (`acucraft/variant@1`) changes one
purposeful thing (risk, anatomy, position, an event, a red flag). `resolveScenario(bundle, source, variantId)` lays the
variant's patches over the family's `case.json` and `field.json` with an id-aware merge (`applyPatch`: objects merge;
arrays of objects with `id` merge by id, `"$remove": true` deletes, new ids append; `{"$replace": …}` replaces; `null`
deletes a key), parses the case with ClinicalCraft's `parseCase` and `checkCaseIntegrity`, parses the field, resolves the
rule sets in force on each visit's date and checks every reference (`checkField`). The case id of an instance is
`<family>.<variant>`; the scenario id is `<family>/<variant>`. See [CONTENT.md](CONTENT.md).

## 3. The encounter

`createEncounter(scenario, {seed, mode})` starts the ClinicalCraft session and builds the field state
(`acucraft/encounter@2`, `schema/state.ts`). `step(scenario, state, request, {strict})` is pure: it never mutates its
input and returns the new state with the attempt records the request produced.

**Requests** (`ActionRequest`): `requestId`, `actor`, `patient`, `action` (one of the actions in
`schema/actions.ts`), `expectedVersion`. A repeated `requestId` returns the first outcome and changes nothing; a request
decided on another state version is rejected `stale-version` (optimistic concurrency: two actors cannot both act on the
same needle).

**Pipeline** for each request: parse → finished? → actor and patient known? → version → permission (the actor's role
in the scenario's role configuration, `engine/rules.ts`) → the action's handler → commit (`version + 1`) → the action's
simulated time is spent minute by minute (`spend`), firing field events and giving NPCs their turn at each minute →
attempt record. A handler either completes, completes partially (an interrupted compound action), or throws a
`Rejection`; a rejection restores the state exactly and records the attempt as `rejected`, or `blocked` when a
protective intervention stopped it.

**The four records** (proposal §7.3) of every `AttemptRecord`: the request as submitted; what was executed (which may
differ — a needle stopped by bone, a removal interrupted after two needles); any protective intervention (by the
simulation guard, a rule set, or the role configuration); and the resulting state version. Unsafe codes
(`UNSAFE_CODES`) and rule violations are on the record whether the act was executed or blocked.

**Effects commit at their own execution events**: `remove_all_needles` removes needles one at a time, spending time
between them; an interrupting event (a faint) stops it and the removals already made stay.

**The clock** is ClinicalCraft's simulated clock. ClinicalCraft charges its own actions (asking 1 min, examining 2 min);
AcuCraft charges field actions (an insertion 0.5 min, a removal 0.25 min, documentation 2 min …) and `wait` advances it.
NPC actions take no time: the support team works alongside the practitioner.

**Field facts are mirrored into ClinicalCraft flags** (`acu.needles-in`, `acu.lying`, `acu.fainted`, `acu.referred`,
`acu.visit-N`, `acu.finished` …), so a case's physiology events can follow them: a vasovagal reaction is a field event
that sets `acu.vasovagal`, and the case's own physiology event drops the pulse and pressure; lying flat with the needles
out sets off its recovery event.

### Standing somewhere

Everyone in the encounter has a stance on the clinic's floor plan, and an act is done only from where it can be
reached: a handler first asks the world whether the patient is in earshot, at the actor's side or in view, whether a
body site is within an arm's reach as the patient lies now, whether a sink, the shelf, the trolley or a sharps
container is within its reach. If not, the request is rejected (`not-at-patient`, `not-in-reach`, `no-route`) with the
`move` that would make it possible; `move` plans a path on ClinicalCraft's navigation grid and takes the time the path
takes. The world is built once per clinic from its facility and does not depend on the state. See [WORLD.md](WORLD.md).

### Evidence

What is obtained — an answer, a finding, a record, vital signs, an observation, what the patient feels at a needle,
what the operator feels on working one — enters `state.evidence` under a stable id. The two TCM conclusions of an
encounter name the ids they rest on, and an id that was never obtained is refused: `assess` with a `pattern` gives
`patternEvidence`; a recorded needle response (`document`: `needling.responses`) names evidence of that needle. What
they are worth is read from the field afterwards — a pattern from what its named findings show (the scenario's hidden
`evaluation.signs`), a needle response from what the tissue did (`needle.response`) — and never shown to the
practitioner. See [EVIDENCE.md](EVIDENCE.md).

### Visits

A field lists its visits (index, case phase, date). `end_visit` requires every needle out and accounted for (an engine
invariant) and applies the end-of-visit rules in force (count, records, observation). `begin_follow_up` moves to the
next visit (the case's phase, by `acu.visit-2`), resets the per-visit state (consent, marks, hand hygiene) and keeps the
patient's history. `finish_encounter` requires the current visit to have ended.

## 4. Needles

Every needle has an identity, a pack, a specification and an event history. Its location is one of `pack`, `tray`,
`hand` (one actor), `patient` (region, side, entry, depth, angle, target, mark), `sharps`, `floor` (hidden or found),
`broken-in-patient`. `checkInvariants` (run after every step in strict mode, which the tests and CI use) checks:

- one holder per object, and a needle in a hand is in that actor's holding;
- a single-use needle never returns to an unused state, is inserted at most once (reuse is blocked by the guard);
- retained ⇔ inserted and not withdrawn, dropped or broken — from the needle's own history;
- withdrawal and disposal are separate events, in that order; a needle in sharps has a disposal event;
- the encounter cannot finish with needles in the patient;
- every evidence item is in the ledger once; an assessment's pattern names evidence, all of it obtained before the
  assessment; a recorded needle response names evidence of that needle, or none when nothing was sought.

A lost needle (`dropped-hidden`) or a broken one stays an explicit unresolved object: `end_visit` refuses until it is
found and disposed of, or the incident is reported after a search made since it fell (lost), or reported and the
patient referred (broken). A needle that fell unseen is still listed in the agent's view where it was placed: only
looking (`monitor` lists the needles actually in place), a count or a search shows that it is gone.

### What a needle was for

An insertion records two targets. The *claimed* target is what the operator named (or the mark they needled) and is
what the agent sees back. The *effective* target is the point the entry actually lies on in this patient's hidden
anatomy: the claim if it holds (within twice its tolerance), otherwise the nearest modelled point or Ashi point,
planned points first. Rules, the guard and the evaluator use the effective target, so naming a point "Ashi" does not
make it a different point: a needle at the location of a point cautioned for one of the patient's risk factors is
`insertion-at-cautioned-point` whatever it is called.

## 5. Roles, rules and the guard

The role configuration (`acucraft/roles@1`) grants each role permissions, some only with a supervisor present or after
the supervisor approved the plan; `ACTION_PERMISSIONS` names the permission each action needs. An unauthorised
clinical act (insertion, removal, manipulation, opening a pack, preparing a site) is blocked and recorded
`unauthorised-act`.

Rule sets (`acucraft/ruleset@1`) are versioned by series with `effectiveFrom`/`effectiveUntil`; the version in force on a
visit's date applies. Each rule has a machine-checkable `check` (`RuleCheckSchema`), a severity and an enforcement:
`record` (executed, the violation recorded) or `block` (refused, a protective intervention). See
[SINGAPORE.md](SINGAPORE.md).

The **simulation guard** (`field.safety.guard: "block-critical"`, the default) blocks an insertion whose path would
reach a critical structure or the pleura, a reused needle, needling a patient who has fainted, and needling after
consent was withdrawn. `record-only` lets such insertions happen, so their consequences unfold.

## 6. NPCs

`engine/npc.ts` holds deterministic policies for cast members that are not under test (`support-default`: the clinic
assistant; `supervisor-default`). They act only through requests, from the state as it is, after every external action
and at every simulated minute — and they walk like anyone else: to the shelf to fetch, to the patient to watch over
them, to a sharps container to dispose. Delegation is observable: `assign_task` → `acknowledge_task` → the work (actions) →
`report_task`; a report is checked against the state (`taskUnmet`), so a task is completed only when its criteria hold.
A spoken commitment ("I'll keep an eye on her") creates a self-assigned task; a spoken claim of completion is recorded
with whether the state supports it and changes nothing.

## 7. What an agent sees

`observeAs(scenario, state, actor)` builds the `AgentView` (`acucraft/view@2`) from an allow-list of the state:
`space` — where the actor stands, every fixture with its distance and whether it is within reach, the patient
(distance, in earshot, at their side, in view, which way they lie, the body sites within reach and the others with
their distance) and the team; the patient's presentation, position and appearance; the conversation; the record so far
— questions asked and answered, examinations done, reports read, vital signs, observations, **each with its evidence
id** — and the sites and tender points found; the latest assessment with the evidence its pattern names; each needle
of the visit with the evidence of its response and what is recorded of it; the landmarks the actor palpated and the
measurements they took, their marks, the plan and consent, equipment, team, tasks, counts, the rules in force and the
outcome of their last request. `referenceLibrary(scenario)` is the public knowledge: point definitions and
constructions, regional charts without patient geometry, the vocabulary (with the signs, each pattern's criteria, the
needle sensations and deqi), the clinic and its floor plan, roles, rules and guideline evidence. Neither contains the
evaluation, the pathways, future events, the variant, undisclosed risk factors, unexamined findings,
patient-specific geometry, which finding shows which sign, or how the tissue answered a needle (checked by the
acceptance and evidence tests). Teaching mode adds the reference locations of planned points and anatomical notes on
each insertion.

Palpation is precise to 2.5 mm and tape measurement to 1.5 %, with a seeded error per patient, landmark and position.

How a language model is given this view and the action interface — one typed tool per action, what each result
tells it, the skills it can read, and the same tools over MCP — is in [AGENT.md](AGENT.md).

## 8. Replay

An `EncounterLog` (`acucraft/log@1`) holds the scenario id and version, the engine versions, the seed, the mode and the
external requests in order, with the digest of the final state. `replayLog` reproduces the state exactly: NPC acts and
seeded events are regenerated deterministically, and a language model's outputs are inside the recorded requests (and
the agent transcript in `meta`), so a replay never calls the model again. `acucraft replay <log.json>` checks the digest.
