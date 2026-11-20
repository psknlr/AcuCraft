---
id: clean-needle-technique
title: Clean needle technique, from clean hands to the sharps container
when: Before the first needle of a visit, and whenever you are unsure what comes next between consent and insertion.
---
Every needle is sterile, single-use and accounted for from the moment its pack is opened.

**Before the needles**
1. Consent to the current plan is given (`view` patient: consent). The patient is in position; someone is set to observe during retention.
2. The points are located and marked.
3. Hand hygiene (`hand_hygiene`, at a sink or dispenser within reach).
4. Fetch a sealed pack from where the packs are kept (`fetch`). Read its label in `view` equipment: needle size, sterile, single-use, and whether the label shows it has expired. An expired or damaged pack is not opened; take another.
5. Clean the skin of each site you will needle (`prepare_site`, region and side), and let nothing touch it afterwards. Palpating or marking a cleaned site means cleaning it again.
6. Open the pack onto the needle trolley by the couch (`open_pack`): its needles lie on the tray.

**Each needle**
7. Clean hands. If you have touched the patient, the couch or anything used since the last hand hygiene, clean them again before sterile needles.
8. `pick_up` one needle from the tray; `insert_needle` at its mark. One needle, one insertion: a needle that has been in the skin, has touched anything, or has fallen is never inserted again.
9. A needle that will not be used after all, or that was contaminated, goes into the sharps container (`dispose`), not back on the tray.

**Order of work**
Needle one side of the couch, then the other: the needles for the points within reach in hand, in, then walk round. The trolley and its sharps container stand at the foot of the couch.

**If something goes wrong**
- A needle falls: say so, find it (`search`), pick it up, dispose of it. It is not used.
- You are pricked by a used needle: stop, `report_incident` needlestick.
- A pack turns out to be unsuitable after opening: its needles are disposed of, and counted as opened.

Every opened needle will be counted at the end. Knowing where each one is at every moment is what makes the count work.
