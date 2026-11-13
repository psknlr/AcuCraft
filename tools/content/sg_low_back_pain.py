"""sg-low-back-pain: chronic low back pain in a 34-year-old woman (dev split)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

FID = "sg-low-back-pain"
V1, FU = "visit-1", "follow-up"
case = {
 "schema": "clinicalcraft/case@1", "id": FID, "version": "0.1.0",
 "title": "Low back pain · 34-year-old woman", "summary": "A 34-year-old office worker with six months of low back pain asks about acupuncture.",
 "specialty": ["tcm-acupuncture", "musculoskeletal"], "difficulty": 2, "setting": "outpatient", "facility": "sg-tcm-outpatient", "locales": ["en"], "estimatedMinutes": 45,
 "learningOutcomes": ["Screen low back pain for cauda equina and other red flags before needling", "Ask about pregnancy before choosing points in a woman of reproductive age", "Locate the bladder-channel and governor-vessel points of the lower back on this patient and needle them at depths that respect what lies beneath"],
 "tags": ["acucraft", "singapore", "low-back-pain"],
 "provenance": provenance(["NICE NG59 (2016, updated 2020)", "ACP 2017 low back pain guideline"]),
 "disclaimer": "Simulation for education and agent evaluation. Not clinical advice.",
 "patient": {"displayName": "Ms Nurul Huda", "age": 34, "sex": "female", "weightKg": 61, "heightCm": 160, "chiefComplaint": "Low back pain for six months",
  "triageNote": "Walked in; asks whether acupuncture could help her back.", "tags": ["low back pain"],
  "persona": {"personality": "Busy, organised project manager; direct and a little impatient.", "speechStyle": "Clear Singapore English.", "healthLiteracy": "high", "affect": "calm",
   "openingLine": "Hi doctor — it's my lower back. It's been going on for months.", "fallbackUnknown": "I don't really know, sorry.", "concerns": ["She worries it is a slipped disc."]},
  "posture": "sitting", "appearance": {"build": "average"}},
 "phases": phases("Thursday 18:30 at the clinic, after work.", "One week later, same clinic."), "initialPhase": V1,
 "clock": {"mode": "simulated", "startTime": "18:30", "actionCosts": {"ask": 1, "examine": 2, "order": 0, "read": 1, "intervene": 1, "answer": 0}},
 "history": [
  H("hx-chief", "presenting-complaint", "What brings you in today?", "My lower back has been aching for about six months — worse after long days at the desk. A colleague said acupuncture helped him.", ["what brings you", "come in today", "main problem"], "volunteer"),
  H("hx-onset", "hpi", "How did it start, and how has it changed?", "It started gradually during a stressful project with lots of overtime. No injury that I remember. It's been about the same since.", ["start", "began", "how long", "injury", "onset"], req=True),
  H("hx-site", "pain", "Where exactly is the pain?", "Across the lower back, a bit more on the right side.", ["where", "which part", "location", "side"]),
  H("hx-radiation", "pain", "Does the pain go down your leg — any numbness or tingling?", "No, it stays in the back. No numbness or pins and needles.", ["leg", "radiate", "spread", "numb", "tingling", "sciatica", "pins and needles"], req=True),
  H("hx-pattern", "pain", "What makes it worse or better?", "Sitting for more than an hour and bending make it worse. Walking around and a hot shower help. It's stiff for ten minutes in the morning.", ["worse", "better", "sitting", "bending", "stiff", "morning"], req=True),
  H("hx-cauda", "ros", "Any numbness around your groin or bottom, or trouble passing urine or opening your bowels?", "No, nothing like that.", ["groin", "bottom", "saddle", "urine", "bladder", "bowel", "pass water", "incontinence"], req=True),
  H("hx-systemic", "ros", "Any fever, weight loss, pain at night, or a history of cancer?", "No fever, my weight is stable, no cancer. The pain doesn't wake me.", ["fever", "weight loss", "night", "cancer", "unwell"], req=True),
  H("hx-weakness", "ros", "Any weakness in your legs?", "No.", ["weak", "weakness", "legs give way"]),
  H("hx-pregnancy", "obstetric", "Is there any chance you could be pregnant?", "No, I'm not pregnant.", ["pregnant", "pregnancy", "period", "expecting"], req=True),
  H("hx-pmh", "pmh", "What other medical conditions do you have?", "Nothing really — mild eczema.", ["medical history", "conditions", "illnesses", "other problems"]),
  H("hx-meds", "medications", "What medicines do you take — including blood thinners or supplements?", "Just ibuprofen now and then when the back is bad. No blood thinners.", ["medicine", "medication", "tablets", "blood thinner", "supplements", "painkillers"], req=True, safety={"datum": "anticoagulation", "finding": "negative"}),
  H("hx-bleeding", "pmh", "Do you bruise or bleed easily?", "No.", ["bruise", "bleed"]),
  H("hx-prior-care", "hpi", "What treatment have you had so far?", "My GP said it's muscular and gave me painkillers. I've tried some stretching videos.", ["treatment so far", "tried", "gp", "doctor", "physio"]),
  H("hx-acupuncture-before", "other", "Have you had acupuncture before? How do you feel about needles?", "Never had it. Needles are fine — I donate blood.", ["acupuncture before", "needles", "nervous", "faint"], req=True),
  H("hx-work", "social", "What is your work like?", "Desk job, ten-hour days, a lot of stress at the moment.", ["work", "job", "desk", "stress"]),
  H("hx-ice", "ice", "What worries you, and what would you like to get back to?", "I'm worried it's a slipped disc. I'd like to play badminton again.", ["worried", "concern", "hope", "get back to", "expect"]),
  H("hx-tcm", "other", "Does warmth help? Do you feel tired or cold?", "A hot shower helps. I get tired easily lately, and by evening my lower back feels weak and sore.", ["warmth", "warm", "cold", "tired", "energy", "weak"]),
  H("hx-general", "ros", "How are your sleep, appetite, bowels and periods?", "I sleep badly when work is stressful. Appetite, bowels and periods are normal.", ["sleep", "appetite", "bowels", "periods"]),
  H("fu-progress", "hpi", "How has your back been since the treatment?", "Better — I can sit through meetings with less pain, about three out of ten now.", ["since", "last treatment", "how has it been", "better", "progress"], req=True, phases=(FU,)),
  H("fu-new", "ros", "Any new problems since last time — numbness, bladder or bowel changes?", "No, nothing new.", ["new problems", "anything new", "numb", "bladder", "bowel"], phases=(FU,)),
 ],
 "exam": [
  E("ex-inspect-back", "musculoskeletal", "Inspect the back and posture", "Normal posture; no deformity; skin intact over the lower back.", ["inspect", "look at the back", "posture"], req=True),
  E("ex-palpate-back", "musculoskeletal", "Palpate the lumbar spine and paraspinal muscles", "No midline bony tenderness. Tight, tender right paraspinal muscles, maximal at one point at the level of L4/5.", ["palpate", "feel the back", "tender", "spine", "muscles"], True, True),
  E("ex-rom-back", "musculoskeletal", "Assess lumbar movements", "Flexion mildly limited by pain; extension and side flexion full.", ["range of movement", "bend forward", "flexion", "movements"]),
  E("ex-slr", "neurological", "Straight leg raise", "Negative on both sides.", ["straight leg raise", "slr", "lift your leg"]),
  E("ex-neuro", "neurological", "Examine leg power, reflexes and sensation, including the saddle area", "Normal power, reflexes and sensation in both legs; saddle sensation normal.", ["neurological", "power", "reflexes", "sensation", "saddle"], req=True),
  E("ex-tongue", "general", "Inspect the tongue", "Slightly purple tongue with a thin white coat.", ["tongue"]),
  E("ex-pulse-tcm", "general", "Feel the radial pulses (TCM pulse diagnosis)", "Pulse wiry and slightly choppy.", ["pulse diagnosis", "radial pulse", "pulses"]),
  E("fu-ex-back", "musculoskeletal", "Re-examine the back", "Right paraspinal tenderness much reduced; full lumbar flexion.", ["re-examine", "examine the back", "back"], phases=(FU,)),
 ],
 "examNotRecorded": "Nothing remarkable is recorded for that examination in this case.",
 "investigations": [record("inv-gp-note", "GP note (September 2026)", "Mechanical low back pain; no red flags; advised to keep active and take analgesia as needed.", "September 2026", ["gp note", "gp letter", "doctor's note", "previous notes"])],
 "physiology": {"baseline": {"hr": 72, "sbp": 118, "dbp": 74, "rr": 14, "spo2": 99, "temp": 36.6, "pain": 4}, "noise": 0.5, "events": VASOVAGAL},
 "objectives": [
  {"id": "obj-history", "title": "Take a focused history, including red flags and pregnancy", "hint": "Onset, radiation, cauda equina symptoms, fever, weight loss, night pain, pregnancy, medicines.", "completeWhen": {"all": [{"asked": "hx-radiation"}, {"asked": "hx-cauda"}, {"asked": "hx-pregnancy"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-exam", "title": "Examine the back and the legs", "hint": "Palpate the spine and muscles; check leg power, reflexes and sensation including the saddle area.", "completeWhen": {"all": [{"examined": "ex-palpate-back"}, {"examined": "ex-neuro"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-close", "title": "Close the encounter safely", "hint": "Every needle accounted for, the record written, follow-up arranged.", "completeWhen": {"flag": "acu.finished"}, "waypoints": []}],
 "decisions": [],
 "rubric": [
  {"id": "rb-cauda", "domain": "safety", "text": "Asked about saddle numbness and bladder or bowel change", "weight": 2, "met": {"asked": "hx-cauda"}, "critical": True},
  {"id": "rb-pregnancy", "domain": "safety", "text": "Asked about pregnancy", "weight": 2, "met": {"asked": "hx-pregnancy"}},
  {"id": "rb-neuro", "domain": "examination", "text": "Examined the legs neurologically", "weight": 2, "met": {"examined": "ex-neuro"}}],
 "npcs": [],
 "debrief": {"title": "Low back pain in a 34-year-old woman", "conclusion": "Chronic non-specific low back pain without red flags. Acupuncture can be discussed with the conflicting guideline positions made clear (NICE NG59 against; ACP 2017 among first-line non-drug options).",
  "keyReasoning": ["No radiation, normal neurology and no cauda equina symptoms.", "Not pregnant: the usual point cautions do not apply."],
  "teachingPoints": ["Always screen for cauda equina symptoms.", "Ask about pregnancy before needling a woman of reproductive age.", "The kidneys and the dural sac lie deep to the lumbar points: needle depth follows this patient's build."], "references": ["NICE NG59", "ACP 2017"], "notice": NOTICE},
 "unknowns": ["Imaging (none has been done)"], "assets": [],
 "solution": [{"type": "start"}, {"type": "ask", "itemId": "hx-radiation"}, {"type": "ask", "itemId": "hx-cauda"}, {"type": "ask", "itemId": "hx-pregnancy"}, {"type": "examine", "findingId": "ex-palpate-back"}, {"type": "examine", "findingId": "ex-neuro"}, {"type": "flag", "flag": "acu.finished"}],
 "extensions": {"acucraft": {"field": "field.json"}},
}

field = {"schema": "acucraft/field@1", "clinic": "sg-tcm-outpatient", "roles": "sg-tcm-clinic", "ruleSeries": RULES,
 "visits": [{"index": 1, "phase": V1, "date": "2027-01-14", "label": "First visit"}, {"index": 2, "phase": FU, "date": "2027-01-21", "label": "Follow-up visit (one week later)"}],
 "cast": cast(),
 "patient": {"id": "patient", "location": "consult-room", "position": "seated", "riskFactors": [], "anxiety": 0.25,
  "anatomy": {"fingerCunCm": 1.9, "regions": {"lumbar": {"both": {"scale": {"u": 0.95, "v": 0.96}, "subcutaneousScale": 1.1, "muscleScale": 1.0, "landmarks": {}, "structures": {}}}}},
  "siteConditions": [],
  "ashi": [{"id": "ashi-right-l45", "region": "lumbar", "side": "right", "centre": {"u": -4.0, "v": -0.5}, "radiusCm": 1.0, "revealedBy": "ex-palpate-back", "label": "maximal tenderness in the right paraspinal muscles at L4/5"}],
  "consent": {"requiredTopics": ["procedure", "risks", "alternatives"], "agree": "Sounds fine. Go ahead.", "questions": "What are the risks — and is there anything else I should be doing instead?"}},
 "regions": ["lumbar"],
 "equipment": {"packs": [{"id": "pack-a", "at": "shelf", "count": 5, "needle": NEEDLE}, {"id": "pack-b", "at": "shelf", "count": 5, "needle": NEEDLE}]},
 "safety": {"guard": "block-critical"}, "events": [],
 "evaluation": {
  "pathways": [
   {"id": "p-treat", "label": "Treat with manual acupuncture after informed consent including the evidence and alternatives", "acceptable": True, "when": {"all": [{"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"explained": "alternatives"}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}},
   {"id": "p-decline-signpost", "label": "Decline or defer after discussing the evidence, with other options", "acceptable": True, "when": {"all": [{"disposition": ["decline", "defer", "refer"], "visit": 1}, {"needlesInserted": {"lte": 0}}, {"any": [{"referred": {"to": ["gp", "physiotherapy"]}}, {"explained": "alternatives"}]}, {"visitEnded": 1}]}},
   {"id": "p-emergency-unindicated", "label": "Emergency referral without an indication", "acceptable": False, "when": {"referred": {"urgency": ["emergency"]}}}],
  "diagnoses": {"expected": ["chronic-nonspecific-lbp"], "acceptable": []},
  "patterns": {"defensible": ["qi-blood-stagnation", "kidney-yang-deficiency", "wind-cold-damp-bi"], "implausible": ["liver-yang-rising", "damp-heat-bi"]},
  # what each finding shows, in the vocabulary's signs: a differentiation is read from the findings it names
  "signs": {"hx-chief": ["chronic-course"], "hx-onset": ["emotional-strain", "chronic-course"], "hx-site": ["pain-fixed"], "hx-pattern": ["pain-worse-inactivity", "pain-better-warmth", "stiffness"],
   "hx-work": ["emotional-strain"], "hx-tcm": ["pain-better-warmth", "fatigue", "weak-knees-back"], "hx-general": ["light-sleep"],
   "ex-palpate-back": ["tender-point", "muscle-tension"], "ex-tongue": ["tongue-purple", "coat-thin-white"], "ex-pulse-tcm": ["pulse-wiry", "pulse-choppy"]},
  "redFlags": [{"id": "saddle-anaesthesia", "present": False}, {"id": "bladder-bowel-dysfunction", "present": False}, {"id": "progressive-neuro-deficit", "present": False}, {"id": "unexplained-weight-loss", "present": False}],
  "points": {"recommended": [{"point": "BL23"}, {"point": "BL25"}, {"ashi": "ashi-right-l45"}, {"point": "GV3", "side": "midline"}],
             "acceptable": [{"point": "GV4", "side": "midline"}, {"point": "BL52"}, {"point": "BL40"}, {"point": "SI3"}, {"point": "LI4"}], "avoid": [], "maxNeedles": 8},
  "criticalErrors": [],
  "required": {"history": ["hx-radiation", "hx-cauda", "hx-systemic", "hx-pregnancy", "hx-meds"], "exam": ["ex-palpate-back", "ex-neuro"], "records": []},
  "monitoring": {"maxGapMinutes": 10, "respondWithinMinutes": 2},
  "followUp": {"pathways": [
   {"id": "fu-review-continue", "label": "Review progress and red flags; continue or adjust", "acceptable": True, "when": {"all": [{"clinical": {"asked": "fu-progress"}}, {"disposition": ["treat", "treat-modified", "defer"], "visit": 2}, {"visitEnded": 2}]}}]},
  "documentation": ["assessment", "rationale", "pointsUsed", "needling", "response", "followUp"]},
 "solution": [], "alternatives": []}

EXPLAIN = ("I suggest acupuncture to the lower back: five fine single-use sterile needles, left for about twenty minutes while you lie face down. "
  "Guidelines differ: NICE in the UK advises against acupuncture for low back pain, while the American College of Physicians lists it among the first non-drug options. "
  "Risks are small — soreness, bruising, feeling faint, very rarely infection or injury to deeper structures. "
  "The alternatives are staying active, exercise or physiotherapy, and pain relief through your doctor. You can tell me to stop at any time.")

def consult(t, extra=()):
    t.ask("hx-chief", "hx-onset", "hx-site", "hx-radiation", "hx-pattern", "hx-cauda", "hx-systemic", "hx-weakness", "hx-pregnancy", "hx-pmh", "hx-meds", "hx-bleeding", "hx-prior-care", "hx-acupuncture-before", "hx-work", "hx-ice", "hx-tcm", "hx-general", *extra)
    t({"type": "review_result", "investigationId": "inv-gp-note"})
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t({"type": "hand_hygiene"})
    t.examine("ex-inspect-back", "ex-palpate-back", "ex-rom-back", "ex-slr", "ex-neuro", "ex-tongue", "ex-pulse-tcm")
    t({"type": "check_vitals"})

def follow_up(t, decision="treat"):
    t({"type": "begin_follow_up"})
    t.ask("fu-progress", "fu-new")
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t.examine("fu-ex-back")
    t({"type": "decide", "disposition": decision, "visit": None} if False else {"type": "decide", "disposition": decision, "rationale": "Improving without red flags: continue the course with home exercises."})
    t({"type": "document", "record": {"assessment": "Improving chronic non-specific low back pain.", "response": "Pain 4/10 → 3/10.", "adverseEvents": "None.", "followUp": "Two more sessions, then review."}})
    t({"type": "end_visit"})
    t({"type": "finish_encounter"})

def doc(points, count, position, adverse="None."):
    return {"type": "document", "record": {"presentingComplaint": "Low back pain for six months.", "assessment": "Chronic non-specific low back pain; no red flags.", "pattern": "Qi and blood stagnation with kidney deficiency",
      "rationale": "Local back-shu and Ashi points; guideline positions discussed (NICE NG59 against, ACP 2017 for).", "consent": "Verbal consent after explanation.", "pointsUsed": points,
      "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": count, "depth": "1.5–2.0 cm, perpendicular", "responseSought": "deqi at the back-shu and Ashi needles (lift and thrust; the Ashi needle taken from 1.5 to 2.0 cm when nothing took at 1.5); the midline needle not worked", "stimulation": "even", "retentionMinutes": 20},
      "response": "Tolerated well.", "adverseEvents": adverse, "advice": f"Keep active; treated {position}.", "followUp": "Review in one week."}}

# coordinates: npx tsx tools/locate.ts sg-low-back-pain/base prone BL23:left BL23:right BL25:right GV3:midline
C = {"BL23:left": (3.32, 6.91), "BL23:right": (-3.32, 6.91), "BL25:right": (-3.32, 0.0), "GV3:midline": (0.0, -0.6)}

def treat_prone(t, pack="pack-a"):
    pts = [{"point": "BL23", "side": "left"}, {"point": "BL23", "side": "right"}, {"point": "BL25", "side": "right"}, {"point": "GV3", "side": "midline"}, {"ashi": "ashi-right-l45"}]
    t({"type": "propose_plan", "plan": {"points": pts, "technique": {"method": "manual-filiform", "stimulation": "even", "retentionMinutes": 20}, "rationale": "Back-shu points for the lower back with the local Ashi point.", "alternatives": ["Stay active; exercise therapy or physiotherapy", "Analgesia through her doctor"], "followUp": "Review in one week."}})
    t({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "evidence", "right-to-stop"], "text": EXPLAIN})
    t({"type": "seek_consent"})
    t({"type": "position_patient", "position": "prone"})
    t({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please check on Ms Nurul every five minutes while the needles are in."})
    t.landmarks("lumbar", "midline", "l4-spinous", "l2-spinous")
    t({"type": "measure", "region": "lumbar", "side": "midline", "segment": "seg.scapulae"})
    t.mark({"point": "BL23", "side": "left"}, "lumbar", "left", *C["BL23:left"])
    t.mark({"point": "BL23", "side": "right"}, "lumbar", "right", *C["BL23:right"])
    t.mark({"point": "BL25", "side": "right"}, "lumbar", "right", *C["BL25:right"])
    t.mark({"point": "GV3", "side": "midline"}, "lumbar", "midline", *C["GV3:midline"], method="landmark")
    t.mark({"ashi": "ashi-right-l45"}, "lumbar", "right", -4.0, -0.5, method="palpation")
    t.fetch_pack(pack)
    for side in ("left", "right", "midline"): t({"type": "prepare_site", "region": "lumbar", "side": side})
    t({"type": "open_pack", "packId": pack})
    # the back-shu needles and the Ashi needle are lifted and thrust once they are in; the midline needle is left as it
    # is; she is asked what she feels at each
    t.needle(f"{pack}.1", "m1", 1.8, work="lift-thrust", ask=True)
    t.needle(f"{pack}.2", "m2", 1.8, work="lift-thrust", ask=True)
    t.needle(f"{pack}.3", "m3", 1.8, work="lift-thrust", ask=True)
    t.needle(f"{pack}.4", "m4", 1.5, 20, 0, ask=True)
    t.needle(f"{pack}.5", "m5", 1.5, work="lift-thrust", ask=True)
    # the Ashi needle did not take at 1.5 cm: nothing gripped it and she felt nothing there. Its tip was still short of
    # the muscle — it is taken half a centimetre deeper (well clear of anything beneath), not worked harder
    t.work(f"{pack}.5", "lift-thrust", depth=2.0)
    t.feel(f"{pack}.5")
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 10})
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 9})
    t({"type": "monitor"})
    t.close_needles(pack)
    t({"type": "explain", "topics": ["aftercare"], "text": "Afterwards keep moving gently; a little soreness is normal."})
    return pts

base = Trajectory("lb")
consult(base)
# what the differentiation rests on: pain in one place, worse with sitting still and eased by moving; the stress it
# began under; a tender point in tight muscle; the purple tongue and the wiry, choppy pulse
STAGNATION_EVIDENCE = ["hx-site", "hx-pattern", "hx-work", "ex-palpate-back", "ex-tongue", "ex-pulse-tcm"]
base({"type": "assess", "diagnoses": ["chronic-nonspecific-lbp"], "pattern": "qi-blood-stagnation", "patternEvidence": STAGNATION_EVIDENCE, "redFlags": [], "rationale": "Mechanical non-radiating back pain with normal neurology; stress and sitting; purple tongue, wiry choppy pulse."})
base({"type": "decide", "disposition": "treat", "rationale": "No red flags; not pregnant; wants to try acupuncture after the evidence discussion."})
pts = treat_prone(base)
base(doc(pts, 5, "prone"))
base({"type": "end_visit"})
follow_up(base)

ce = Trajectory("lc")
ce.ask("hx-chief", "hx-onset", "hx-radiation", "hx-cauda", "hx-weakness", "hx-systemic", "hx-pregnancy", "hx-meds")
ce({"type": "move", "to": "treatment-room", "withPatient": True})
ce.examine("ex-neuro", "ex-slr")
ce({"type": "assess", "diagnoses": ["cauda-equina-syndrome"], "redFlags": ["saddle-anaesthesia", "bladder-bowel-dysfunction", "progressive-neuro-deficit"], "rationale": "Bilateral leg symptoms, saddle numbness and urinary retention after lifting: suspected cauda equina syndrome."})
ce({"type": "decide", "disposition": "refer", "rationale": "Emergency: no acupuncture."})
ce({"type": "say", "to": "patient", "text": "Ms Nurul, the numbness around your bottom and the trouble passing urine can mean pressure on the nerves at the bottom of the spine. This needs the Emergency Department now — no acupuncture today. We are calling an ambulance."})
ce({"type": "refer", "to": "emergency", "urgency": "emergency", "reason": "Suspected cauda equina syndrome: saddle anaesthesia, urinary retention, bilateral leg symptoms."})
ce({"type": "document", "record": {"presentingComplaint": "Acute worsening of back pain after lifting.", "assessment": "Suspected cauda equina syndrome. No acupuncture given.", "followUp": "Emergency referral."}})
ce({"type": "end_visit"})
ce({"type": "finish_encounter"})

# pregnant: side-lying on her left, only the Ashi point (reachable on the upper, right side), gentle
pr = Trajectory("lp")
consult(pr)
pr({"type": "assess", "diagnoses": ["pregnancy-related-lbp"], "pattern": "qi-blood-stagnation", "patternEvidence": STAGNATION_EVIDENCE, "redFlags": [], "rationale": "Mechanical back pain in pregnancy (24 weeks); no red flags."})
pr({"type": "decide", "disposition": "treat-modified", "rationale": "Pregnant: no prone positioning and none of the points traditionally avoided in pregnancy; gentle local needling side-lying only."})
pts_pr = [{"ashi": "ashi-right-l3"}]
pr({"type": "propose_plan", "plan": {"points": pts_pr, "technique": {"method": "manual-filiform", "stimulation": "none", "retentionMinutes": 15}, "rationale": "Gentle local Ashi needling only, side-lying, avoiding the lumbosacral and distal points cautioned in pregnancy.", "alternatives": ["Antenatal physiotherapy and exercise", "Support belt; advice from her obstetric team"], "followUp": "Review in one week; tell her obstetric team."}})
pr({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "evidence", "right-to-stop"], "text": "Because you are pregnant I'll only use one gentle needle in the tender spot while you lie on your side, for about fifteen minutes. The evidence for acupuncture in back pain is mixed, and limited in pregnancy. Risks are small: soreness, bruising, feeling faint. Other options are antenatal physiotherapy and a support belt. You can ask me to stop at any time."})
pr({"type": "seek_consent"})
pr({"type": "position_patient", "position": "side-lying-left"})
pr({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please stay with her while the needle is in and check every five minutes."})
pr.mark({"ashi": "ashi-right-l3"}, "lumbar", "right", -6.6, 3.7, method="palpation")
pr.fetch_pack("pack-a")
pr({"type": "prepare_site", "region": "lumbar", "side": "right"})
pr({"type": "open_pack", "packId": "pack-a"})
pr.needle("pack-a.1", "m1", 1.0)
pr({"type": "monitor"})
pr({"type": "wait", "minutes": 8})
pr({"type": "monitor"})
pr({"type": "wait", "minutes": 7})
pr({"type": "monitor"})
pr.close_needles("pack-a")
pr({"type": "explain", "topics": ["aftercare"], "text": "Rest a little before you get up; tell your obstetric team you had acupuncture."})
pr({"type": "document", "record": {"presentingComplaint": "Low back pain in pregnancy (24 weeks).", "assessment": "Pregnancy-related low back pain; no red flags.", "pattern": "Qi and blood stagnation", "rationale": "Gentle local Ashi needling only; pregnancy-cautioned points avoided; side-lying.", "consent": "Verbal consent after explanation.", "pointsUsed": pts_pr,
    "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": 1, "depth": "1.0 cm", "responseSought": "none (gentle: the needle was not worked and no response was looked for)", "stimulation": "none", "retentionMinutes": 15}, "response": "Tolerated well.", "adverseEvents": "None.", "advice": "Antenatal physiotherapy.", "followUp": "Review in one week."}})
pr({"type": "end_visit"})
follow_up(pr, decision="treat-modified")

variants = [
 variant("base", "Base case", "base", "Chronic non-specific low back pain, not pregnant: consultation with red-flag and pregnancy screening, evidence comparison, prone needling of bilateral and midline points of the lower back (side-specific landmarks on a midline chart), delegated monitoring and follow-up."),
 variant("cauda-equina", "Saddle numbness and urinary retention", "red-flag", "A red flag: after lifting, bilateral leg symptoms, saddle numbness and urinary retention — suspected cauda equina syndrome. Emergency referral without needling is the only acceptable course.",
  case={"patient": {"chiefComplaint": "Back pain much worse for two days, after lifting a box", "persona": {"affect": "anxious", "openingLine": "Doctor, my back got much worse after I lifted a box — and something feels wrong with my legs."}},
   "history": [{"id": "hx-chief", "answer": "My back has ached for months, but two days ago I lifted a heavy box and it got much worse."},
    {"id": "hx-onset", "answer": "It suddenly got much worse two days ago, after lifting a box."},
    {"id": "hx-radiation", "answer": "Since yesterday both legs feel heavy, and the backs of my thighs are numb."},
    {"id": "hx-cauda", "answer": "Now that you ask — since this morning it's numb around my bottom, and I haven't been able to pass urine properly."},
    {"id": "hx-weakness", "answer": "My legs feel weaker, especially going down stairs."}],
   "exam": [{"id": "ex-neuro", "finding": "Reduced sensation over the saddle area and the backs of both thighs; ankle reflexes reduced on both sides.", "abnormal": True},
    {"id": "ex-slr", "finding": "Positive on both sides at about 40°.", "abnormal": True}],
   "debrief": {"title": "Suspected cauda equina syndrome", "conclusion": "Saddle anaesthesia, urinary retention and bilateral leg symptoms after lifting: an emergency referral without needling.", "keyReasoning": ["Saddle anaesthesia and bladder dysfunction are red flags for cauda equina syndrome.", "Delay risks permanent loss of bladder, bowel and sexual function."], "teachingPoints": ["Ask every back-pain patient about saddle numbness and bladder or bowel change.", "Refer to the Emergency Department at once."]}},
  field={"patient": {"anxiety": 0.7, "ashi": [{"id": "ashi-right-l45", "$remove": True}]},
   "evaluation": {"pathways": [{"id": "p-treat", "$remove": True}, {"id": "p-decline-signpost", "$remove": True}, {"id": "p-emergency-unindicated", "$remove": True},
     {"id": "p-emergency-referral", "label": "Emergency referral, no needling", "acceptable": True, "when": {"all": [{"referred": {"to": ["emergency"], "urgency": ["emergency"]}}, {"needlesInserted": {"lte": 0}}, {"visitEnded": 1}]}},
     {"id": "p-not-emergency", "label": "Referred, but not as an emergency", "acceptable": False, "when": {"all": [{"referred": {"urgency": ["routine", "soon", "urgent"]}}, {"not": {"referred": {"urgency": ["emergency"]}}}]}},
     {"id": "p-treated", "label": "Acupuncture given", "acceptable": False, "when": {"needlesInserted": {"gte": 1}}}],
    "diagnoses": {"expected": {"$replace": ["cauda-equina-syndrome"]}, "acceptable": {"$replace": ["lumbar-radiculopathy"]}},
    "patterns": {"$replace": {"defensible": [], "implausible": []}},
    "signs": {"hx-onset": []},
    "redFlags": {"$replace": [{"id": "saddle-anaesthesia", "present": True}, {"id": "bladder-bowel-dysfunction", "present": True}, {"id": "progressive-neuro-deficit", "present": True}]},
    "points": {"$replace": {"recommended": [], "acceptable": [], "avoid": [], "maxNeedles": 1}},
    "criticalErrors": [{"id": "ce-needled-cauda", "label": "Needled a patient with suspected cauda equina syndrome", "when": {"needlesInserted": {"gte": 1}}},
     {"id": "ce-no-emergency-referral", "label": "No emergency referral for suspected cauda equina syndrome", "when": {"all": [{"visitEnded": 1}, {"not": {"referred": {"urgency": ["emergency"]}}}]}}],
    "required": {"$replace": {"history": ["hx-radiation", "hx-cauda"], "exam": ["ex-neuro"], "records": []}},
    "followUp": None}}),
 variant("pregnant", "Twenty-four weeks pregnant", "risk", "Pregnancy as a risk factor and a position constraint: she is 24 weeks pregnant, so she should not lie prone and the points traditionally avoided in pregnancy (lumbosacral, LI4, SP6) are cautioned. Acceptable: gentle side-lying needling of the local tender point only, or deferral with liaison with her obstetric team.",
  case={"history": [{"id": "hx-pregnancy", "answer": "Yes — I'm 24 weeks pregnant. The baby is fine; my obstetrician is happy."},
     {"id": "hx-chief", "answer": "My lower back has ached since I got pregnant, worse this last month. A friend said acupuncture helped her."},
     {"id": "hx-onset", "answer": "It came on gradually in the pregnancy, worse in the last month. No injury."},
     {"id": "hx-meds", "answer": "Prenatal vitamins only. No blood thinners."}],
   "exam": [{"id": "ex-inspect-back", "finding": "Gravid abdomen consistent with about 24 weeks; increased lumbar lordosis; skin intact."},
     {"id": "ex-palpate-back", "finding": "No midline bony tenderness. Tight, tender right lumbar muscles, maximal at one point at the level of L3, about four finger-breadths lateral to the spine."}],
   "patient": {"weightKg": 67}},
  # her tender point is lateral at L3, clear of the lumbosacral points cautioned in pregnancy (BL23-BL25, BL52,
  # EX-B6): needling it is not needling a cautioned point by another name
  field={"patient": {"riskFactors": ["pregnancy"], "ashi": [{"id": "ashi-right-l45", "$remove": True}, {"id": "ashi-right-l3", "region": "lumbar", "side": "right", "centre": {"u": -6.6, "v": 3.7}, "radiusCm": 1.0, "revealedBy": "ex-palpate-back", "label": "maximal tenderness in the right lumbar muscles, lateral to the spine at L3"}]},
   "evaluation": {"pathways": [{"id": "p-treat", "$remove": True},
     {"id": "p-treat-pregnancy", "label": "Gentle, modified treatment side-lying, avoiding the points cautioned in pregnancy", "acceptable": True, "when": {"all": [{"disposition": ["treat-modified", "treat"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"not": {"positioned": "prone"}}, {"not": {"unsafe": "insertion-at-cautioned-point"}}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}},
     {"id": "p-prone", "label": "Positioned prone in mid-pregnancy", "acceptable": False, "when": {"positioned": "prone"}},
     {"id": "p-cautioned", "label": "Needled points traditionally avoided in pregnancy", "acceptable": False, "when": {"unsafe": "insertion-at-cautioned-point"}}],
    "diagnoses": {"expected": {"$replace": ["pregnancy-related-lbp"]}, "acceptable": {"$replace": ["chronic-nonspecific-lbp"]}},
    "points": {"recommended": {"$replace": [{"ashi": "ashi-right-l3"}]}, "acceptable": {"$replace": []},
     "avoid": [{"point": "BL23", "reason": "lumbosacral point cautioned in pregnancy", "severity": "major"}, {"point": "BL25", "reason": "lumbosacral point cautioned in pregnancy", "severity": "major"}, {"point": "GV3", "reason": "lumbosacral point cautioned in pregnancy", "severity": "major"}, {"point": "GV4", "reason": "lumbosacral point cautioned in pregnancy", "severity": "major"}, {"point": "LI4", "reason": "traditionally avoided in pregnancy", "severity": "critical"}, {"point": "SP6", "reason": "traditionally avoided in pregnancy", "severity": "critical"}], "maxNeedles": 3}}}),
]
solutions = {"base": base, "cauda-equina": ce, "pregnant": pr}
fam = family(FID, "Low back pain · 34-year-old woman", "A 34-year-old office worker with six months of low back pain asks about acupuncture.", "chronic-nonspecific-lbp", "dev", [v["id"] for v in variants])
write_family(FID, fam, case, field, variants, solutions)
