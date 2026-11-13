---
id: observation-and-events
title: Observing during retention, and what to do when something happens
when: Once the first needle is in, and at once when the patient reports anything or a colleague calls you.
---
A patient with needles in is never left unobserved.

**Observation**
- Someone looks at the patient at intervals for as long as needles are in place: `monitor` yourself, or `assign_task` monitor-patient to the clinic assistant with `params.intervalMinutes`. `lookup rules` gives the longest gap the clinic allows; five minutes is a sound interval.
- `monitor` shows how the patient is and which needles are actually in place. A needle can work loose and fall without anyone noticing: only looking, counting or searching shows it.
- Retention is `wait`, in stretches no longer than the interval, with a `monitor` between them if nobody else is observing.
- A delegated observation is the assistant's task, and its report is checked. You are still the one called when something is wrong.

**When something happens: stop and deal with it first**
- **Feeling faint, dizzy, sick; pale and sweating.** `stop_treatment`. `remove_all_needles`. Lay them flat (`position_patient` supine). `monitor`, `check_vitals`, stay with them and observe again after a few minutes. Record it as an adverse event; decide at the follow-up how to treat differently (lying down, after a meal, fewer needles).
- **Sharp, burning, electric or worsening pain at a needle.** Go to that needle: withdraw a little or remove it (`adjust_needle`, `remove_needle`), dispose of it, ask how it feels now.
- **"Stop", "take them out", or consent withdrawn in any words.** `stop_treatment`, `remove_all_needles`, say that you are stopping. No further needle, no persuading. Other options can be discussed once the needles are out.
- **Bleeding at a site after removal.** `apply_pressure` on that site until it stops; note it.
- **A needle missing from where it was.** `search` the couch, the floor and the clothing; pick it up and dispose of it. If it cannot be found after searching, `report_incident` lost-needle.
- **A bent or broken needle.** Do not try to dig it out. `report_incident` broken-needle and refer the patient urgently.
- **A colleague says the patient needs you.** Go to the patient now.

Whatever was in progress waits. When several calls were queued and one of these happens, the rest are not carried out: decide again from what you see.

Afterwards the record says what happened, what was done, and how the patient was when they left.
