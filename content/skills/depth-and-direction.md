---
id: depth-and-direction
title: Depth, angle and direction for this patient
when: Before you insert a needle anywhere a structure lies near the point, and for any patient who is slim, frail, pregnant or bleeds easily.
---
A depth quoted for a point assumes an average adult. The needle meets this patient's tissue.

**What decides the depth**
- **What lies beneath.** The point's cautions and notes (`lookup point`) and the region's description (`lookup region`) say what is under it: lung and pleura under the chest, the upper back and the top of the shoulder; vessels and nerves at the wrist, the elbow, the groin and behind the knee; a joint cavity; an organ. Over these, shallow and oblique or transverse, directed away from the structure.
- **Build.** A slim patient has less tissue over every structure: depths that are safe in an average build are not safe in them. A heavy build has more subcutaneous tissue before muscle is reached. Look at the patient and adjust — less depth for the slim, never "the same as the book".
- **Where the tip should rest.** In muscle for most points on the limbs and the back; superficially over bone, on the scalp and the face; never in a vessel, a nerve, a joint cavity or a body cavity.
- **The patient's state.** Someone on anticoagulants or who bruises easily: fewer needles, shallower, no manipulation, pressure on each site after removal. A frail or anxious patient: fewer needles, gentler.

**Angle and direction**
`angleDeg` 0 is perpendicular to the skin; about 45 is oblique; 75 to 90 lies along the skin. `azimuthDeg` is the direction the tip travels across the chart: 0 cranial, 90 towards +u, 180 caudal, 270 towards −u (on a bilateral chart +u is lateral; on a midline chart +u is the patient's left). `depthCm` is measured along the shaft, so an oblique needle of the same length reaches less deep.

**When the engine answers**
- **Blocked.** The simulation guard stopped a path that would have reached a critical structure. The attempt is on the record. Do not try again deeper, or the same; reconsider the point, the angle and the depth, or leave the point out.
- **Stopped by bone.** The needle went as far as bone and stopped short of what you asked: the result gives the depth reached.
- **A sharp, burning or electric sensation.** Withdraw a little (`adjust_needle` with a smaller depth) or take the needle out. Do not work it.

A shallow needle that cannot hurt is always available. A deep needle is a decision you can give reasons for.
