# Evidence: pattern differentiation and deqi

> Status: the contract for `engine/evidence.ts` and the evidence parts of the evaluator. If the code and this page
> disagree, fix one of them in the same change. The signs, the criteria of each pattern and the model of the needle's
> response are **AI-assisted teaching simplifications, unreviewed**: paraphrases of general textbook teaching, not a
> validated diagnostic rule and not physiology. Review them with a TCM educator before any teaching use.

Two conclusions of an acupuncture encounter are easy to assert and hard to check: *which pattern this is* (辨证) and
*whether qi arrived at a needle* (得气). AcuCraft links both to evidence, by the rules ClinicalCraft and SurgeryCraft
keep for a diagnosis and for a critical view of safety:

1. **What is obtained enters a ledger under a stable id, once.** An answer, an examination finding, a record, a set of
   vital signs, what was seen of the patient, what the patient said they feel at a needle, what the operator felt on
   working one.
2. **A conclusion names the evidence it rests on.** A pattern differentiation names findings; a recorded needle
   response names evidence of that needle. An id that was never obtained is refused: nothing enters the record on
   evidence that does not exist.
3. **What a conclusion is worth is read from the field, never from the claim.** A pattern is read from what its named
   findings show — the scenario's own, hidden reading of each finding. A needle response is read from what the tissue
   did. The claim is kept beside that and the two are compared afterwards.
4. **Nothing obtained is nothing known.** A tongue nobody looked at is not a normal tongue; a needle nobody asked
   about has no response on record, not an unremarkable one.

## 1. The ledger

`state.evidence` holds one `EvidenceItem` for everything obtained: `id`, `kind`, `ref` (the case item, investigation
or needle), `visit`, `at` (the minute), `by`, `text` (what was seen or heard — never what it means).

| kind | obtained by | id |
|---|---|---|
| `history` | `ask` (by item id or free text), a question in `say` | the history item's own id: `hx-weather` |
| `exam` | `examine` | the finding's own id: `ex-tongue`, `ex-pulse-tcm` |
| `record` | `review_result` | `<investigation>.<phase>`: `inv-xray.visit-1` |
| `vitals` | `check_vitals` | `vitals-1`, `vitals-2` … |
| `observation` | `observe` | `obs-1` … |
| `sensation` | `check_sensation`, a question that names the needle's point, or what the patient says unasked | `sense-1` … |
| `needle-feel` | `adjust_needle` with a technique (what the operator feels in the needle) | `feel-1` … |

A case item is evidence once: asked again, it is the same item. The practitioner sees every item with its id —
`record` (history, examination, results, vitals, observations) and `needling` (each needle's evidence) in the agent
view — and only what is listed there can be named. A scenario's history, examination and record ids are distinct and
none looks like a numbered id (checked when the scenario is resolved).

## 2. Pattern differentiation

### What a pattern is recognised by (public)

`content/sg/vocabulary.json` (written by `tools/content/vocabulary.py`) holds

- **signs** — 66 of them, each with the examination that finds it (`inquiry`, `inspection`, `tongue`, `pulse`,
  `palpation`, `listening`): *pain worse in cold or damp weather*, *a pale tongue*, *a wiry pulse* …;
- for each of the 13 **patterns**, its `criteria`: `key` signs (its defining manifestations), `supporting` signs (what
  goes with it: tongue, pulse, general signs) and signs that speak `against` it;
- the rule (`differentiation`): a differentiation **rests on its evidence** when the findings it names show at least
  **1 key sign** and **3 signs in all**, and the findings obtained do not show **2 signs against** it.

This is reference knowledge: `lookup pattern` for an agent, `npm run acu -- vocabulary` on the command line.

### What a finding shows (hidden)

Which finding of a case shows which sign is the scenario's own reading — `evaluation.signs` in the field, hidden like
the rest of the evaluation:

```json
"signs": {
  "hx-weather": ["pain-worse-cold-damp", "pain-better-warmth", "heaviness"],
  "ex-tongue": ["tongue-pale", "coat-white-greasy"],
  "ex-pulse-tcm": ["pulse-deep", "pulse-slow", "pulse-slippery"]
}
```

A variant overlays it like anything else: in the hot-knee variant `hx-swelling` shows `joint-hot-red-swollen` and
`hx-systemic` shows `fever`. A finding that is not listed shows no sign. The practitioner reads *"It's worse on rainy
days and in the air-conditioning; a warm towel helps. The knee feels heavy."* and has to see what it means; the
mapping is never in the view or the library (tested).

### The act

```json
{ "type": "assess", "diagnoses": ["knee-osteoarthritis"], "pattern": "wind-cold-damp-bi",
  "patternEvidence": ["hx-weather", "hx-general-tcm", "ex-tongue", "ex-pulse-tcm"] }
```

| refused with | when |
|---|---|
| `no-evidence` | a pattern with no `patternEvidence` |
| `evidence-not-obtained` | an id that is not in the ledger — the tongue was never looked at |
| `invalid` | `patternEvidence` without a pattern; an id outside the vocabulary |

An accepted assessment is recorded as claimed, with the ids it names. **The engine gives no verdict**: whether the
differentiation holds is not shown to the practitioner. Teaching mode adds the reading as observations (which signs
the named findings show, what speaks against it, whether that is enough).

### The reading

`patternSupport(scenario, pattern, cited, obtained)`:

- `key`, `supporting` — the pattern's signs that the **named** findings show, each with the evidence that shows it;
- `against` — signs against the pattern shown by anything **obtained by then**, named or not: leaving a contrary
  finding out of the citation does not remove it;
- `idle` — named findings that show none of the pattern's signs;
- `methods` — the examinations the named signs were found by;
- `sufficient` (enough key signs and enough in all), `contradicted` (enough signs against), and `supported`:
  sufficient and not contradicted.

Evidence obtained after an assessment does not count against it; a later assessment is read on what was known then.

### Scenario lists are held to the same reading

When a scenario is resolved, every pattern it lists as `defensible` must be supportable from the case's own findings,
and every pattern it lists as `implausible` must not be. This already corrected one list: the insomnia family called
*disharmony of heart and kidney* defensible, but the patient's pale, tooth-marked tongue speaks against it.

### In the evaluation

Three items of the reasoning track, apart from each other:

| item | weight | asks |
|---|---|---|
| `pattern` | 1 | is the pattern among those the scenario lists as defensible? (the conclusion; an unlisted pattern goes to adjudication) |
| `pattern-evidence` | 2 | does the differentiation rest on the findings it names? (the link) |
| `four-examinations` | 1 | where the case's tongue or pulse bears on the pattern, does the differentiation draw on it as well as on the history? |

A right name on findings that do not show it scores the first and not the second. `report.evidence.pattern` has the
whole reading; the encounter report and the HTML viewer print it as a table of sign, role and the finding that shows
it. None of this is a critical error: it is reasoning, not safety.

## 3. Deqi

### What it is (public)

The vocabulary's `deqi` block gives the definition, what counts as evidence of it, and its sources; `sensations` lists
what a patient may feel at a needle and which of it is deqi — soreness 酸, numbness 麻, heaviness 重, distension 胀,
warmth, a sensation spreading from the needle — and which is not: sharp pain, burning, an electric shooting
sensation. `lookup deqi` for an agent.

### The field: how the tissue answers

Each needle in the patient has a hidden `response` (`NeedleResponse`), recomputed when it is inserted, moved or worked:

```
response = tissue at the tip × min(1, stimulation) × the patient's sensitivity × variation of the site
```

| term | value |
|---|---|
| tissue at the tip | muscle 1.0 · fascia 0.9 · tendon, ligament, fat pad 0.7 · periosteum, bone 0.4 · joint space, subcutaneous 0.3 · skin 0.1 |
| stimulation | the insertion 0.45; each lift-and-thrust +0.35; each rotation +0.3 — and beyond 1 it adds nothing to the response |
| the patient's sensitivity | `patient.needleSensitivity` in the field (0.5–1.5, default 1) |
| variation of the site | 0.8–1.2, fixed for this patient at this site (half a centimetre apart is another site). It is part of the patient, like their anatomy: the same in every encounter and every variant of the family, whatever the encounter's seed |

**Qi has arrived when the response reaches 0.5.** What follows from the numbers is what a teacher would say:

- an insertion alone seldom brings it; a needle with its tip in a muscle belly is usually held after being worked once;
- a tip still in the subcutaneous layer is not held however it is worked — **depth, not force**, is what was missing,
  and depth is governed by the anatomy beneath (the same model that stops a needle over the lung);
- **stimulation past what the patient tolerates** (1.5 in all — a fourth lift-and-thrust; sooner in a sensitive or an
  anxious patient) brings no more response: it hurts, the patient says so (`too-strong`, an abnormal reaction), and
  the needle is from then on a painful one;
- a nerve met by the shaft gives an electric sensation and a tendon a sharp one: sensations that are **not deqi**,
  whatever the response of the tissue.

### What is observed

| act | evidence |
|---|---|
| `check_sensation { needleId }` — or a question to the patient that names the needle or its point (*"What do you feel at ST36?"*) | `sense-N`: the patient's words and the qualities they name (`aching`, `heaviness` …; none when they feel little) |
| `adjust_needle` with `technique` `lift-thrust` or `rotate` | `feel-N`: what the operator feels — the needle gripped, heavy and tight; a slight drag; or moving freely |
| nothing: the patient speaks unasked — a shock, a sharp pain, *too strong*, or a strong response (0.8 and over) | `sense-N`, marked unasked |

*"How does it feel?"* is answered about the needles in general and is evidence of no needle. Inserting a needle,
moving it to another depth (`technique: "none"`) and watching the patient are not evidence of its response either.
Whether an item shows deqi is for the practitioner to judge from the vocabulary: the view gives the words, the
qualities and the grip — never the response, and never a verdict.

### What is recorded

```json
{ "type": "document", "record": { "needling": { "responses": [
  { "needle": "pack-a.3", "response": "deqi", "evidence": ["feel-3", "sense-3"] },
  { "needle": "pack-a.5", "response": "none", "evidence": ["sense-6"] },
  { "needle": "pack-a.1", "response": "not-sought", "evidence": [] } ] } } }
```

`deqi` and `none` are conclusions about one needle and name evidence of that needle; `not-sought` says no response
was looked for and names none. Refused: a `deqi` or `none` without evidence (`no-evidence`), an id never obtained
(`evidence-not-obtained`), evidence of another needle or not of a needle at all (`evidence-mismatch`), a needle that
was not inserted in this visit (`unknown-id`), a needle recorded twice or a `not-sought` with evidence (`invalid`).

A record that passes is kept as claimed. `needleAudit` then sets, for every needle, the field beside what was
observed and what was recorded:

| verdict | meaning |
|---|---|
| `supported` | `deqi` on evidence of that needle that shows it; or `none` on a check that showed none, with nothing since |
| `overclaimed` | `deqi` recorded on evidence that does not show it |
| `contradicted` | `none` or `not-sought` recorded while the practitioner's own evidence of that needle shows deqi |
| `out-of-date` | `none` recorded on a check made before the needle was moved or worked: qi arrived after it, unobserved |
| `not-sought` | nothing looked for, and recorded so |
| `unrecorded` | no response on record for the needle |

A spoken or written claim is checked the same way: *"deqi obtained at ST36"* in `say`, or in a record's `response`
text, is the claim `deqi-obtained`, supported when evidence of a needle of this visit shows deqi (*"no deqi"*,
*"deqi was not sought"* are not claims).

### In the evaluation

Items of the procedure track:

| item | weight | asks |
|---|---|---|
| `needle-responses-recorded` | 1 | is the response at every needle on record — deqi, none, or not sought? |
| `deqi-evidence` | 2 | is no deqi recorded without evidence of it at that needle? |
| `needle-responses-true` | 1 | does what is recorded of each needle agree with what was observed there? |
| `no-overstimulation` | 1 | was no needle worked beyond what the patient tolerated? (only when a needle was worked) |

**Deqi is never required and never rewarded.** No item gives credit for obtaining it: a needle that was not worked,
and recorded so, loses nothing; an honest `none` scores exactly as a `deqi`. What costs points is a response claimed
without evidence, a record that contradicts what was observed, and stimulation the patient could not tolerate.
`report.evidence.needles` has the audit; the encounter report and the viewer print it needle by needle.

## 4. Reference trajectories

Each family's authoring script says where a response is looked for — `needle(..., work="lift-thrust", ask=True)` —
and names the findings of each differentiation (`patternEvidence`). `tools/finish-solutions.ts` replays the trajectory
and writes each treatment record's `needling.responses` from the evidence it had obtained: `deqi` on the items that
show it, `none` on the latest check that did not, `not-sought` where nothing was looked for. Between them the
references show all three: needles in muscle that are held, shallow needles at the wrist and at a joint line that are
not, a needle over the apex of the lung that is asked about and not worked, and a pregnant patient's single needle
with nothing sought. In the low back family the Ashi needle is not held at 1.5 cm — its tip is short of the muscle —
and is taken to 2.0 cm rather than worked harder.

## 5. Sources and limits

| source | status |
|---|---|
| STRICTA 2010 (MacPherson et al., *PLoS Medicine* 7(6): e1000261), item 2d: "Response sought (e.g. de qi or muscle twitch response)" | wording checked against the published checklist. It is a reporting standard: it asks that the response sought be reported, not that deqi be obtained |
| Kong et al. 2007, *J Altern Complement Med* 13(10): 1059–70 (the MGH Acupuncture Sensation Scale) | the paper was confirmed to exist; the descriptors follow later reviews of the scale; the full text was not read — `verified: false` |
| WHO international standard terminologies on traditional Chinese medicine (2022) | the publication was confirmed to exist; its entries were not read — `verified: false` |
| ICD-11 traditional medicine chapter; GB/T 16751.2-2021 | cited as the classifications that name patterns; not consulted for the criteria — `verified: false` |

- The criteria are a short list of signs per pattern with one threshold for all: a teaching device for making a
  differentiation answerable to its findings, not a diagnostic instrument. Real differentiation weighs findings
  against each other; here they are counted.
- The reading of each finding is the author's. A finding can be read differently; a different, defensible reading
  goes to adjudication like an unlisted pattern.
- The needle response is a deterministic rule over tissue, stimulation and a seeded variation. It makes the claim
  checkable and the lesson (depth, not force; no response without evidence) concrete. It says nothing about what deqi
  is or whether it matters to outcome, and no score depends on obtaining it.
- Evidence of a needle is faithful to the field at the moment it is obtained: the patient reports what the model
  holds and the operator feels it. There is no unreliable witness yet.
