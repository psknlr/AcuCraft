# The Singapore edition

> "Singapore" names the proposed implementation setting. No institution participates in, endorses or accredits this
> content. Every rule encoding, role permission and clinical detail below is a simulation assumption **pending review by
> Singapore practice and regulatory experts**.

## Setting

A simulated outpatient TCM clinic (`content/sg/clinic.json`): reception, a consultation room, a treatment room with a
couch, hand-wash sink and sharps container, and a preparation area with the supply shelf (needle packs, swabs, cotton
balls). Referral targets: the Emergency Department (ambulance 995), polyclinic or family physician, orthopaedics,
oncology, obstetrics, neurology, physiotherapy, a senior TCM physician. English first; point names carry pinyin and
hanzi, and the vocabulary carries Mandarin pattern names (`content/sg/vocabulary.json`) — both unreviewed. Patient
dialogue is English only in this release. All cases are synthetic, with invented names and details.

## Professional roles (`content/sg/roles.json`)

The proposal records that practising TCM practitioners in Singapore register with the Traditional Chinese Medicine
Practitioners Board (TCMPB) and hold a valid practising certificate, and that the Board distinguishes TCM physicians and
registered acupuncturists. The role configuration models:

| role | needling | notes |
|---|---|---|
| TCM physician | insert, manipulate, remove | cannot order new investigations in this configuration: existing reports are read, new tests come through referral |
| Registered acupuncturist | insert, manipulate, remove | as above |
| Supervising TCM physician | as a physician, plus `supervise` (approve a learner's plan) | |
| Supervised TCM learner | only with a supervisor present | delegable support tasks |
| Clinic assistant | none | position, fetch, observe, record vitals, count, dispose of unused opened needles, search, report |
| Registered nurse | none | as the assistant, plus applying pressure |

Which role may insert, remove, delegate or supervise is configuration, not a statement of Singapore law: confirm each
grant against the TCMPB's requirements and the clinic's own procedures.

## Rule sets and versions

| series | version | effective | encoding | source checked? |
|---|---|---|---|---|
| `sg-tcmpb-acupuncture-advisory` | General Advisory on Acupuncture and Other Related Treatment (June 2021) | 2021-06-01 (taken as the publication month) | partial: single-use sterile needles; sharps disposal; hand hygiene; site preparation; consent; treatment records; no abdominal or lumbosacral needling after the first trimester of pregnancy (§4.1.4, as cited by the November 2026 audit) | **no** |
| `sg-tcmpb-acupuncture-treatment-methods` | Advisory on Acupuncture Treatment Methods (announced 2026-11-01) | 2027-01-01 | **not encoded** (metadata only) | **no** |
| `acucraft-sg-clinic-protocol` | simulated clinic protocol 1.0 | 2026-01-01 | encoded: a reconciled needle count before the visit ends (blocking); observation at least every 10 minutes during retention | n/a (AcuCraft's own) |

Neither TCMPB document could be retrieved while this release was built: the session had no network access to gov.sg,
and a web search found no copy of the 2026 announcement. The 2021 rules encode the proposal's summary of the advisory,
and each must be checked clause by clause against its text. The 2027 version exists so that scenarios dated from
1 January 2027 name it. The low-back-pain family is dated January 2027 and shows it in force (not encoded); the other
families are dated before it, so it is listed as not yet in force.

Each scenario names its rule series; the version in force on each visit's date applies (`ruleSetInForce`), and the agent
view lists the versions and rule titles in force. A rule's enforcement is `record` (the violation is kept on the
attempt) or `block` (the action is refused: a protective intervention).

The pregnancy provision is a rule check of kind `avoid-regions` (risk factor `pregnancy`, from gestational week 13;
regions `abdomen`, `lumbar` and `sacrum-buttock`, the buttocks and hips included conservatively). It is judged by
where the needle goes, so a named point, an Ashi point and a bare chart position in those regions are the same act; it
records the critical unsafe act `insertion-in-avoided-region`. The reference library lists each rule's check, so an
agent can keep its plan out of the regions. The 2027 rule set is selected for encounters dated from 1 January 2027 (a
test shows it), but none of its provisions can be tested until they are encoded and reviewed.

## Investigations

Practitioners read existing reports (`performedAt: "records"` investigations: a polyclinic X-ray, an INR from the
anticoagulation clinic, an oncology blood count) and refer for anything new; `order_investigation` is refused for the
TCM roles in this configuration. An unsupported request returns "Not provided or not modelled for this case."
Repeated reads return the same report; the follow-up visit's phase may carry a later record.

## Consent

Consent is to a plan version: the patient agrees once the procedure, risks and alternatives (the scenario's required
topics) have been explained in the visit; a wider plan needs consent again (a narrower one keeps it); a patient may
decline or withdraw. Insertion without consent to the current plan is a critical error; insertion after withdrawal is
blocked.

## What remains to verify

- The 2021 advisory's text, for each encoded rule, its wording, severity and enforcement; anything it requires that is
  not encoded.
- The 2026–27 advisory: its existence, date, effective date and provisions, then encoding.
- Role permissions (removal and delegation in particular) with the TCMPB and practising clinics.
- Mandarin terminology and dialogue with bilingual TCM educators.
- Every case family's clinical content, and every regional model's anatomy (see [ANATOMY.md](ANATOMY.md)).
