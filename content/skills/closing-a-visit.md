---
id: closing-a-visit
title: Closing a visit, from the last minute of retention to end_visit
when: When the retention time is up, or the treatment has been stopped.
---
A visit ends when every needle is accounted for and the record is written — not when the last needle comes out.

1. **Remove.** `remove_all_needles` (it walks round the couch), or `remove_needle` one by one when you want to look at each site. Check the sites: `apply_pressure` where one bleeds, and on every site for a patient who bleeds easily.
2. **Dispose.** Needles in your hand go into the sharps container (`dispose` with the needle id). The opened needles that were never used are disposed of too (`dispose` with the pack id): nothing goes back to the tray or the shelf.
3. **Hand hygiene.**
4. **Count** (`count_needles`), where the needles are: in the treatment room with the patient in sight, and where the tray is. The count names every opened needle as in the sharps container, in the patient, in hand, on the tray, found, or reported. It must reconcile. A colleague can count for you (`assign_task` count-needles) and report.
5. **If the count does not reconcile.** A needle is missing. `monitor` (is it still in the patient?), `search` the couch, the floor, the clothing, the tray. Found: pick it up, dispose of it, count again. Not found after searching: `report_incident` lost-needle, then count again.
6. **The patient.** Help them up when they are ready (not straight after a faint). Aftercare in words (`explain` with the aftercare topic): what to expect, what to watch for, when to come back or seek help.
7. **The record** (`document`): presenting complaint, the relevant history and examination, the assessment and the pattern, the rationale, consent, the points actually used, the needling (needle type and number, depths, the response sought and found at each needle — see `needle-response` —, stimulation, retention), how the patient responded, adverse events (or none), advice, follow-up. The record agrees with what was done: the points needled, the number of needles, anything that went wrong.
8. **`end_visit`.** It is refused while a needle is in the patient or unaccounted for, and the rules in force at the end of a visit apply (`lookup rules`): if it is refused, the message says what is missing.

A visit that ended in referral or deferral closes the same way from step 6: what the patient was told, the referral, the record, `end_visit`.
