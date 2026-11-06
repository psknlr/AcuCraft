# AcuCraft — architecture and contracts

> Status: the contract for the packages in this repository. If the code and this page disagree, fix one of them in
> the same change.

AcuCraft is an acupuncture content pack and field extension built on the
[ClinicalCraft](https://github.com/psknlr/ClinicalCraft) engine, pinned to commit
`4569808889ca5d5e837657918cc2a821df212474` (`tools/clinicalcraft.rev`). ClinicalCraft runs the consultation; AcuCraft
adds what an acupuncture encounter needs on top of it.

```
 content/ (data)            standards · acupoints · regions · sg/ (roles, rule sets, clinic, vocabulary, evidence)
                            families/<id>/ case.json (ClinicalCraft) + field.json (AcuCraft) + variants/ + solutions/
        │
 @acucraft/core (pure)      schemas · scenario resolution (family + variant overlay) · patient-specific anatomy
        │                   and localisation · needle path assessment · the encounter engine (step, replay)
        │                   · field events · roles and rules · NPC policies · invariants · the agent view
        │   uses
 @clinicalcraft/core        the clinical session: history, examination, records with turnaround, physiology and
        │                   vitals, flags, phases, clock (reduce, matchHistory, matchExam, matchOrders, vitalsAt)
        │
 @acucraft/bench (Node)     content loader · independent evaluator · agents (reference, protocol, Claude)
        │                   · episode runner · suites · statistics · reports
 @acucraft/cli              acucraft validate | list | show | locate | run | play | replay | evaluate | bench
                            | export-clinicalcraft
```

## 1. Relationship to ClinicalCraft

| ClinicalCraft package | What AcuCraft uses | What AcuCraft adds alongside |
|---|---|---|
| `@clinicalcraft/core` | `CaseSchema` (each scenario's consultation is a `clinicalcraft/case@1` case), `reduce`, `createSession`, `evaluate` (conditions), the matchers, `resultFor`, `vitalsAt`, `verifyCase`, `createRng`/`seedFrom`, `t` | the acupuncture field (`acucraft/field@1`), the encounter state that wraps the clinical session, needling, roles, rules |
| `@clinicalcraft/world` | not yet | AcuCraft's own clinic model (rooms, fixtures, couches, sinks, sharps containers) and patient positions; a ClinicalCraft facility for the 3D world is future work |
| `@clinicalcraft/agent` | not yet | `@acucraft/bench` agents and the `AgentView` |
| `@clinicalcraft/bench` | the conventions (scenario files, Wilson intervals, held-out splits) | `@acucraft/bench` |

The engine is consumed from source: `tools/bootstrap.sh` fetches the pinned revision into `.deps/clinicalcraft`
(git-ignored) and vitest, `tsc` and `tsx` resolve `@clinicalcraft/core` there (`vitest.config.ts`, `tsconfig.json`
`paths`). AcuCraft provides zod; `@clinicalcraft/core` has no other runtime dependency. `npm run export:clinicalcraft`
writes every scenario instance's case as a plain ClinicalCraft case, so ClinicalCraft's own front-ends can load them
through `.clinicalcraft/settings.json` (`contentDirs`).

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
(`acucraft/encounter@1`, `schema/state.ts`). `step(scenario, state, request, {strict})` is pure: it never mutates its
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
- the encounter cannot finish with needles in the patient.

A lost needle (`dropped-hidden`) or a broken one stays an explicit unresolved object: `end_visit` refuses until it is
found and disposed of, or the incident is reported after a search (lost), or reported and the patient referred
(broken).

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
and at every simulated minute. Delegation is observable: `assign_task` → `acknowledge_task` → the work (actions) →
`report_task`; a report is checked against the state (`taskUnmet`), so a task is completed only when its criteria hold.
A spoken commitment ("I'll keep an eye on her") creates a self-assigned task; a spoken claim of completion is recorded
with whether the state supports it and changes nothing.

## 7. What an agent sees

`observeAs(scenario, state, actor)` builds the `AgentView` from an allow-list of the state: the patient's presentation,
position and appearance, the conversation, the record so far (questions asked and answered, examinations done, reports
read, sites and tender points found), the landmarks the actor palpated and the measurements they took, their marks,
the plan and consent, equipment, team, tasks, counts, the rules in force and the outcome of their last request.
`referenceLibrary(scenario)` is the public knowledge: point definitions and constructions, regional charts without
patient geometry, vocabulary, clinic, roles, rules and guideline evidence. Neither contains the evaluation, the
pathways, future events, the variant, undisclosed risk factors, unexamined findings or patient-specific geometry
(checked by the acceptance tests). Teaching mode adds the reference locations of planned points and anatomical notes on
each insertion.

Palpation is precise to 2.5 mm and tape measurement to 1.5 %, with a seeded error per patient, landmark and position.

## 8. Replay

An `EncounterLog` (`acucraft/log@1`) holds the scenario id and version, the engine versions, the seed, the mode and the
external requests in order, with the digest of the final state. `replayLog` reproduces the state exactly: NPC acts and
seeded events are regenerated deterministically, and a language model's outputs are inside the recorded requests (and
the agent transcript in `meta`), so a replay never calls the model again. `acucraft replay <log.json>` checks the digest.
