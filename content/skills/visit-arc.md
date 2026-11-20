---
id: visit-arc
title: The arc of a visit
when: At the start of an encounter, and whenever you are unsure what the visit still owes before it can end.
---
A visit moves through these stages. Each leaves something on the record that the next one rests on; none is skipped because it seems obvious.

1. **Consultation.** Hear the presenting complaint, then ask: onset and course, site and spread, what makes it better or worse, what has been tried, other conditions, medicines (blood thinners included), bleeding or bruising, pregnancy where it can apply, previous acupuncture and how they feel about needles, what they hope for. Ask the questions that would change what you do. One or two things at a time.
2. **Existing records.** Read what the patient has (`review_result`): reports, blood results, letters. A report can change the decision on its own.
3. **Examination.** Take the patient to the treatment room when you need the couch (`move` with `withPatient`). Examine the part that hurts and what the complaint calls for; look at the tongue and feel the pulse if you will differentiate a pattern; take vital signs when the state of the patient matters.
4. **Assessment and decision.** `assess` (diagnoses, pattern with its evidence, red flags), then `decide`. Read `red-flags-and-referral` before deciding to treat, and `pattern-differentiation` before naming a pattern.
5. **Plan, explanation, consent.** `propose_plan`, `explain` in the patient's words, `seek_consent`. Answer their questions and ask again. A patient may decline: that is an outcome, not a failure.
6. **Position.** The position that gives access to the points and that this patient can hold. Ask a colleague to observe during retention (`assign_task` monitor-patient) before you start.
7. **Localise and mark.** `point-location`.
8. **Needle.** `clean-needle-technique`, `depth-and-direction`, `needle-response`.
9. **Retain and observe.** `observation-and-events`.
10. **Close.** `closing-a-visit`: needles out, into the sharps container, counted; aftercare; the record; `end_visit`.
11. **Follow-up.** If the encounter has a second visit: `begin_follow_up`, ask how they have been and whether anything is new, decide again on what you hear, record it, `end_visit`. Then `finish_encounter`.

When the decision is not to needle — a referral, a deferral, the patient declining — the visit still owes: telling the patient plainly what you found and what happens next, the referral itself (`refer`), the record, and `end_visit`.

Work in the order the clinic is laid out, not the order you thought of things: consult in the consultation room, wash where there is a sink, fetch packs from where they are kept on your way to the couch. `lookup floorplan` shows the rooms.
