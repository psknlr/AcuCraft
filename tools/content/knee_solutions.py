"""Write the reference trajectories of the sg-knee-oa family (authoring script; the JSON it writes is the source).

Mark coordinates are the patient-specific references printed by `npx tsx tools/locate.ts <scenario> <position> ...`
for the variant's patient, rounded to 0.01 cm.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import Trajectory as T, prune_moves
FAM = os.path.join(HERE, "..", "..", "content", "families", "sg-knee-oa")

def ask(t, *ids):
    for i in ids: t({"type": "ask", "itemId": i})
def ex(t, *ids):
    for i in ids: t({"type": "examine", "findingId": i})
def lm(t, *ids, side="right", region="knee-leg"):
    for i in ids: t({"type": "identify_landmark", "region": region, "side": side, "landmark": i})
def mark(t, target, u, v, method, side="right", region="knee-leg"):
    t({"type": "mark_point", "target": target, "region": region, "side": side, "at": {"u": u, "v": v}, "method": method})
def needle(t, nid, mark_id, depth, angle=0, az=0):
    t({"type": "pick_up", "object": nid})
    t({"type": "insert_needle", "needleId": nid, "mark": mark_id, "angleDeg": angle, "azimuthDeg": az, "depthCm": depth})

EXPLAIN = ("I'd suggest a course of acupuncture: five fine, single-use sterile needles around your right knee and leg, left in for about twenty minutes. "
  "It may ease the pain; the evidence is mixed — the UK NICE guideline advises against acupuncture for osteoarthritis, while the American College of Rheumatology guideline conditionally recommends it. "
  "The risks are small: soreness, a little bleeding or bruising, feeling faint, and very rarely infection. "
  "The alternatives are strengthening exercises and keeping active, physiotherapy, and pain relief through your doctor — exercise matters whatever we decide. "
  "You can ask me to stop at any time.")

def consult(t, extra_history=(), records=("inv-xray",)):
    ask(t, "hx-chief", "hx-onset", "hx-site", "hx-pattern", "hx-swelling", "hx-systemic", "hx-mechanical", "hx-pmh", "hx-meds", "hx-bleeding", "hx-prior-care", "hx-acupuncture-before", "hx-weather", "hx-general-tcm", "hx-ice", *extra_history)
    for r in records: t({"type": "review_result", "investigationId": r})
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t({"type": "hand_hygiene"})
    ex(t, "ex-inspect", "ex-legs-skin", "ex-palpate", "ex-effusion", "ex-rom", "ex-tongue", "ex-pulse-tcm")
    t({"type": "check_vitals"})

def treatment(t, points, marks, needles, plan_rationale, alternatives, burning=True, pressure=()):
    t({"type": "propose_plan", "plan": {"points": points, "technique": {"method": "manual-filiform", "stimulation": "even", "retentionMinutes": 20}, "rationale": plan_rationale, "alternatives": alternatives, "followUp": "Review in one week."}})
    t({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "evidence", "right-to-stop"], "text": EXPLAIN})
    t({"type": "seek_consent"})
    t({"type": "position_patient", "position": "supine-knee-flexed"})
    t({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please stay with Mdm Lim and check on her every five minutes while the needles are in; tell me at once if anything changes."})
    lm(t, "st35-depression", "medial-knee-eye", "ankle-anterior-midpoint", "lateral-malleolus", "medial-condyle-inferior")
    t({"type": "measure", "region": "knee-leg", "side": "right", "segment": "seg.knee-ankle-lateral"})
    for (target, u, v, method) in marks: mark(t, target, u, v, method)
    t.fetch_pack("pack-a")
    t({"type": "prepare_site", "region": "knee-leg", "side": "right"})
    t({"type": "open_pack", "packId": "pack-a"})
    for args in needles: needle(t, *args)
    t({"type": "adjust_needle", "needleId": "pack-a.3", "technique": "lift-thrust"})
    t({"type": "monitor"})
    used = [n[0] for n in needles]
    if burning:
        t({"type": "wait", "minutes": 10})  # interrupted when the needle starts to burn
        t({"type": "monitor"})
        t({"type": "remove_needle", "needleId": used[-1]})
        t({"type": "dispose", "object": used[-1]})
        t({"type": "say", "to": "patient", "text": "I've taken out the needle that was burning. How does the knee feel now?"})
        t({"type": "wait", "minutes": 8})
    else:
        t({"type": "wait", "minutes": 10})
        t({"type": "monitor"})
        t({"type": "wait", "minutes": 8})
    t({"type": "monitor"})
    t({"type": "remove_all_needles"})
    for n in pressure: t({"type": "apply_pressure", "needleId": n})
    t({"type": "dispose", "object": "pack-a"})
    t({"type": "hand_hygiene"})
    t({"type": "count_needles"})
    t({"type": "explain", "topics": ["aftercare"], "text": "Afterwards rest the knee for the day; a little soreness or a small bruise can happen. Keep up the exercises and call us if anything worries you."})

def record(points, count, adverse, pattern="Wind-cold-damp Bi (cold-damp predominant)"):
    return {"type": "document", "record": {
        "presentingComplaint": "Right knee pain for eight months.",
        "assessment": "Mild medial compartment osteoarthritis of the right knee (X-ray March 2025); no red flags.",
        "pattern": pattern,
        "rationale": "Local and distal points for knee Bi; guideline positions discussed (NICE NG226 against, ACR/AF 2019 conditional for).",
        "consent": "Verbal consent after explanation of procedure, risks, alternatives and the evidence.",
        "pointsUsed": points,
        "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": count, "depth": "0.8–2.0 cm", "responseSought": "deqi at ST36", "stimulation": "even", "retentionMinutes": 20},
        "response": "Tolerated; deqi at ST36.",
        "adverseEvents": adverse,
        "advice": "Rest the knee today; continue exercises.",
        "followUp": "Review in one week."}}

def follow_up(t, decision="treat", extra=()):
    t({"type": "begin_follow_up"})
    ask(t, "fu-progress", "fu-new", "fu-exercises", *extra)
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    ex(t, "fu-ex-knee")
    t({"type": "decide", "disposition": decision, "rationale": "Improving with minor bruising only: continue the course and the exercises; review after three more sessions."})
    t({"type": "document", "record": {"assessment": "Improving knee osteoarthritis; small bruise resolved.", "response": "Pain 7/10 → 5/10 on stairs.", "adverseEvents": "Minor bruising after the first session.", "followUp": "Continue the course; review after three sessions."}})
    t({"type": "end_visit"})
    t({"type": "finish_encounter"})

ALTS = ["Exercise therapy and weight management (first line)", "Physiotherapy", "Pain relief through her doctor"]

# ---- base -----------------------------------------------------------------------------------------------
base = T("kb")
consult(base)
base({"type": "assess", "diagnoses": ["knee-osteoarthritis"], "pattern": "wind-cold-damp-bi", "redFlags": [], "rationale": "Gradual mechanical medial knee pain, short morning stiffness, joint-line tenderness, X-ray changes; worse with cold and damp, heaviness, pale tongue with a white greasy coat."})
base({"type": "decide", "disposition": "treat", "rationale": "No red flags; she wants to try acupuncture after hearing the evidence and alternatives."})
pts = [{"point": "ST35", "side": "right"}, {"point": "EX-LE4", "side": "right"}, {"point": "ST36", "side": "right"}, {"point": "SP9", "side": "right"}, {"ashi": "ashi-medial-joint-line"}]
marks = [({"point": "ST35", "side": "right"}, 2.24, -1.42, "landmark"), ({"point": "EX-LE4", "side": "right"}, -2.24, -1.42, "landmark"), ({"point": "ST36", "side": "right"}, 2.01, -8.01, "proportional"), ({"point": "SP9", "side": "right"}, -6.62, -5.97, "landmark"), ({"ashi": "ashi-medial-joint-line"}, -4.6, -0.8, "palpation")]
needles = [("pack-a.1", "m1", 1.5, 30, 270), ("pack-a.2", "m2", 1.5, 30, 90), ("pack-a.3", "m3", 2.0), ("pack-a.4", "m4", 1.8), ("pack-a.5", "m5", 0.8)]
treatment(base, pts, marks, needles, "Local knee points (the knee eyes, SP9, the Ashi point) with ST36 for cold-damp Bi.", ALTS)
base(record(pts, 5, "Burning at the Ashi needle after 6 minutes: needle removed, settled."))
base({"type": "end_visit"})
follow_up(base)

# ---- anticoagulated -------------------------------------------------------------------------------------
ac = T("ka")
consult(ac, records=("inv-xray", "inv-inr"))
ac({"type": "assess", "diagnoses": ["knee-osteoarthritis"], "pattern": "wind-cold-damp-bi", "redFlags": [], "rationale": "Osteoarthritis as before; on warfarin with INR 2.6 in range; varicose veins over the medial right knee and upper calf."})
ac({"type": "decide", "disposition": "treat-modified", "rationale": "INR in range and no bleeding history beyond easy bruising: fewer points, none over the varicosities, firm pressure after removal."})
pts_ac = [{"point": "ST35", "side": "right"}, {"point": "EX-LE4", "side": "right"}, {"point": "ST36", "side": "right"}, {"ashi": "ashi-medial-joint-line"}]
marks_ac = [({"point": "ST35", "side": "right"}, 2.24, -1.42, "landmark"), ({"point": "EX-LE4", "side": "right"}, -2.24, -1.42, "landmark"), ({"point": "ST36", "side": "right"}, 2.01, -8.01, "proportional"), ({"ashi": "ashi-medial-joint-line"}, -4.6, -0.8, "palpation")]
needles_ac = [("pack-a.1", "m1", 1.2, 30, 270), ("pack-a.2", "m2", 1.2, 30, 90), ("pack-a.3", "m3", 1.8), ("pack-a.4", "m4", 0.6)]
treatment(ac, pts_ac, marks_ac, needles_ac, "Fewer, shallower points away from the varicose veins because she is anticoagulated.", ALTS, burning=True, pressure=("pack-a.1", "pack-a.2", "pack-a.3"))
ac(record(pts_ac, 4, "Burning at the Ashi needle: removed. Firm pressure after every removal (warfarin)."))
ac({"type": "end_visit"})
follow_up(ac, decision="treat-modified")

# ---- hot knee (red flag) --------------------------------------------------------------------------------
hk = T("kh")
ask(hk, "hx-chief", "hx-onset", "hx-swelling", "hx-systemic", "hx-prior-care", "hx-meds", "hx-pmh")
hk({"type": "check_vitals"})
ex(hk, "ex-inspect", "ex-effusion")
hk({"type": "assess", "diagnoses": ["septic-arthritis"], "redFlags": ["hot-swollen-joint-fever", "unable-to-bear-weight"], "rationale": "Hot, swollen, very painful knee with fever five days after an intra-articular injection: septic arthritis until proven otherwise."})
hk({"type": "decide", "disposition": "refer", "rationale": "Emergency: no acupuncture; same-day hospital assessment."})
hk({"type": "say", "to": "patient", "text": "Mdm Lim, your knee may be infected after the injection. This needs to be seen at the Emergency Department today — I'm not going to do acupuncture. We'll call an ambulance for you."})
hk({"type": "refer", "to": "emergency", "urgency": "emergency", "reason": "Suspected septic arthritis of the right knee: fever 38.4 °C, hot swollen joint, unable to bear weight, five days after an intra-articular injection."})
hk({"type": "document", "record": {"presentingComplaint": "Right knee pain, much worse for two days.", "assessment": "Suspected septic arthritis (fever, hot swollen knee, recent injection). No acupuncture given.", "consent": "Not applicable: no treatment given.", "followUp": "Emergency referral; review after hospital assessment."}})
hk({"type": "end_visit"})
hk({"type": "finish_encounter"})

for name, t in [("base", base), ("anticoagulated", ac), ("hot-knee", hk)]:
    path = os.path.join(FAM, "solutions", f"{name}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(t.steps, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")
    print(name, len(t.steps))
prune_moves("sg-knee-oa")
