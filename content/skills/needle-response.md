---
id: needle-response
title: The needle's response and how it is recorded
when: After the needles are in, before you record anything about deqi.
---
Deqi is the arrival of qi at a needle: the patient feels soreness, numbness, heaviness, distension or warmth at it, sometimes spreading; the operator feels the needle gripped, heavy and tight. `lookup deqi` has the sensations, which of them count, and what counts as evidence. It is observed at one needle at a time, and it is never required.

**Finding out**
- `check_sensation` with a needle id: the patient says what they feel there. Their words and the qualities they name are evidence of that needle.
- `adjust_needle` with `technique` lift-thrust or rotate: what you feel in the needle as you work it is evidence of that needle.
- "How does it feel?" asked of the patient in general is about all the needles and is evidence of none.

Each piece of evidence gets an id; `view` needling lists every needle with its evidence. Whether an item shows deqi is yours to judge from the vocabulary: you are not told.

**Not chasing it**
Stronger stimulation is never the aim. One gentle lift and thrust is a way of finding out; repeating it harder is not. If nothing is felt, the tip may lie too shallow to be in muscle: a little deeper — only where depth is safe — tells you more than more force. Sharp pain, burning or an electric shock is not deqi: withdraw a little or remove the needle. For a patient you have decided to treat gently (bleeding risk, frailty, their own wish), do not work the needles at all.

**Recording**
`document`, `needling.responses`: one entry for each needle inserted in the visit.
- `deqi`, naming evidence of that needle that shows it;
- `none`, naming the check that showed nothing — a check made after the needle was last moved or worked;
- `not-sought`, with no evidence, for a needle you did not look for a response at.

Record what you observed and no more. A needle recorded as deqi on evidence that does not show it is an overclaim; a needle whose response was never looked for and is recorded so loses nothing.
