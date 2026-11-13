"""sg-insomnia: three months of insomnia in a 54-year-old taxi driver (held-out split)."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

FID = "sg-insomnia"
V1, FU = "visit-1", "follow-up"
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "coords", f"{FID}.json")
C = json.load(open(CP)) if os.path.exists(CP) else {}

case = {
 "schema": "clinicalcraft/case@1", "id": FID, "version": "0.1.0",
 "title": "Poor sleep · 54-year-old man", "summary": "A 54-year-old taxi driver who has slept badly for three months asks whether acupuncture could help.",
 "specialty": ["tcm-acupuncture", "psychiatry"], "difficulty": 3, "setting": "outpatient", "facility": "sg-tcm-outpatient", "locales": ["en"], "estimatedMinutes": 40,
 "learningOutcomes": ["Ask about mood and thoughts of self-harm in every patient presenting with insomnia, and act on a positive answer the same day", "Ask about sleepiness at the wheel in a professional driver", "Stop at once, remove every needle and respect the decision when a patient withdraws consent"],
 "tags": ["acucraft", "singapore", "insomnia"],
 "provenance": provenance([], "AI-assisted authoring; the mental-health content needs review by a clinician as well as a TCM practitioner."),
 "disclaimer": "Simulation for education and agent evaluation. Not clinical advice.",
 "patient": {"displayName": "Mr Ong Kok Wee", "age": 54, "sex": "male", "weightKg": 72, "heightCm": 168, "chiefComplaint": "Poor sleep for three months",
  "triageNote": "Asks whether acupuncture could help him sleep.", "tags": ["insomnia"],
  "persona": {"personality": "Polite, worried, a little embarrassed to be here.", "speechStyle": "Singapore English with Hokkien and Malay words.", "healthLiteracy": "medium", "affect": "anxious",
   "openingLine": "Doctor, I cannot sleep properly already three months.", "fallbackUnknown": "Not sure leh, doctor.", "concerns": ["He worries about falling asleep at the wheel."]},
  "posture": "sitting", "appearance": {"build": "average"}},
 "phases": phases("Monday 15:00 at the clinic, before his evening shift.", "One week later, same clinic."), "initialPhase": V1,
 "clock": {"mode": "simulated", "startTime": "15:00", "actionCosts": {"ask": 1, "examine": 2, "order": 0, "read": 1, "intervene": 1, "answer": 0}},
 "history": [
  H("hx-chief", "presenting-complaint", "What brings you in today?", "I can't sleep properly for three months now. My wife said try acupuncture.", ["what brings you", "come in today", "main problem"], "volunteer"),
  H("hx-sleep", "hpi", "Tell me about your sleep — falling asleep, waking, how many hours.", "It takes me an hour or two to fall asleep, then I wake at three and can't get back to sleep. Maybe four hours a night.", ["sleep", "falling asleep", "wake", "hours", "insomnia", "night"], req=True),
  H("hx-onset", "hpi", "When did it start, and what was happening then?", "About three months ago. Business has been slow, and I worry about money and my daughter's exams.", ["start", "began", "when", "what was happening", "stress"]),
  H("hx-mood", "ros", "How has your mood been — any low mood, or losing interest in things?", "A bit stressed and irritable, but I still enjoy my grandson and kopi with my friends.", ["mood", "low", "depressed", "interest", "enjoy", "sad"], req=True),
  H("hx-self-harm", "ros", "Have you had any thoughts that life isn't worth living, or of harming yourself?", "No, nothing like that.", ["harming yourself", "self-harm", "life isn't worth", "suicide", "end your life", "hurt yourself"], "specific", req=True),
  H("hx-daytime", "functional", "How does it affect you in the day — do you get sleepy while driving?", "I'm tired in the afternoons. If I feel sleepy on the road I stop and rest.", ["daytime", "day", "sleepy", "driving", "drowsy", "tired"], req=True),
  H("hx-snoring", "ros", "Do you snore, or stop breathing at night?", "My wife says I snore a little, but she hasn't seen me stop breathing.", ["snore", "snoring", "stop breathing", "apnoea"]),
  H("hx-caffeine", "social", "How much coffee, tea or alcohol do you have?", "Three kopi a day, the last one around four in the afternoon. Beer at the weekend.", ["coffee", "kopi", "tea", "caffeine", "alcohol", "beer", "drink"]),
  H("hx-pmh", "pmh", "Any other medical conditions?", "Mild high blood pressure.", ["medical history", "conditions", "illnesses", "blood pressure"]),
  H("hx-meds", "medications", "What medicines do you take — including blood thinners or sleeping pills?", "Amlodipine. No blood thinners, no sleeping pills.", ["medicine", "medication", "tablets", "blood thinner", "sleeping pills"], req=True, safety={"datum": "anticoagulation", "finding": "negative"}),
  H("hx-acupuncture-before", "other", "Have you had acupuncture before? How do you feel about needles?", "Never. I'm okay with needles, I think.", ["acupuncture before", "needles", "nervous", "afraid"], req=True),
  H("hx-tcm", "other", "Do you dream a lot, or get palpitations? How are your appetite and energy?", "Many dreams, and my heart races when I worry. Poor appetite, always tired.", ["dream", "palpitations", "heart racing", "appetite", "energy"]),
  H("hx-ice", "ice", "What would you like to get from treatment?", "I want to sleep through the night and stop worrying about falling asleep at the wheel.", ["hope", "would you like", "worried", "expect"]),
  H("fu-progress", "hpi", "How has your sleep been since the treatment?", "A bit better — some nights I fall asleep within half an hour.", ["since", "last treatment", "how has", "better", "progress"], req=True, phases=(FU,)),
  H("fu-new", "ros", "Any new problems, or changes in your mood?", "No, nothing new. Mood is okay.", ["new problems", "anything new", "mood"], phases=(FU,)),
 ],
 "exam": [
  E("ex-general", "general", "General inspection", "Tired-looking; alert; normal speech; reactive affect.", ["general", "look", "inspection", "appearance"], req=True),
  E("ex-skin", "skin", "Examine the skin of the arms and legs", "Skin intact; no oedema.", ["skin", "arms", "legs"], req=True),
  E("ex-tongue", "general", "Inspect the tongue", "Pale tongue with teeth marks and a thin white coat.", ["tongue"]),
  E("ex-pulse-tcm", "general", "Feel the radial pulses (TCM pulse diagnosis)", "Thin, weak pulse.", ["pulse diagnosis", "radial pulse", "pulses"]),
 ],
 "examNotRecorded": "Nothing remarkable is recorded for that examination in this case.",
 "investigations": [record("inv-gp-note", "GP note (October 2026)", "Insomnia for two months; blood pressure controlled on amlodipine; sleep hygiene advised; he declined sleeping tablets.", "October 2026", ["gp note", "doctor's note", "previous notes", "gp letter"])],
 "physiology": {"baseline": {"hr": 78, "sbp": 132, "dbp": 84, "rr": 14, "spo2": 98, "temp": 36.6, "pain": 0}, "noise": 0.5, "events": VASOVAGAL},
 "objectives": [
  {"id": "obj-history", "title": "Characterise the insomnia and screen mood and driving safety", "hint": "Sleep pattern, mood, thoughts of self-harm, daytime sleepiness at the wheel, caffeine, medicines.", "completeWhen": {"all": [{"asked": "hx-sleep"}, {"asked": "hx-mood"}, {"asked": "hx-self-harm"}, {"asked": "hx-daytime"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-close", "title": "Close the encounter safely", "hint": "Every needle accounted for, the record written.", "completeWhen": {"flag": "acu.finished"}, "waypoints": []}],
 "decisions": [],
 "rubric": [{"id": "rb-self-harm", "domain": "safety", "text": "Asked about thoughts of self-harm", "weight": 3, "met": {"asked": "hx-self-harm"}, "critical": True},
            {"id": "rb-driving", "domain": "safety", "text": "Asked about sleepiness while driving", "weight": 2, "met": {"asked": "hx-daytime"}}],
 "npcs": [],
 "debrief": {"title": "Insomnia in a 54-year-old taxi driver", "conclusion": "Stress-related insomnia without low mood or thoughts of self-harm; acupuncture can be offered alongside sleep hygiene, less caffeine, and a review by his doctor if it persists.",
  "keyReasoning": ["Sleep-onset and early waking under stress; mood reactive; no self-harm thoughts."], "teachingPoints": ["Always ask about mood and self-harm in insomnia.", "A sleepy professional driver must not drive while sleepy.", "A patient may stop at any time: stop, remove every needle, record it."], "references": [], "notice": NOTICE},
 "unknowns": ["Sleep study (none done)"], "assets": [],
 "solution": [{"type": "start"}, {"type": "ask", "itemId": "hx-sleep"}, {"type": "ask", "itemId": "hx-mood"}, {"type": "ask", "itemId": "hx-self-harm"}, {"type": "ask", "itemId": "hx-daytime"}, {"type": "flag", "flag": "acu.finished"}],
 "extensions": {"acucraft": {"field": "field.json"}},
}

field = {"schema": "acucraft/field@1", "clinic": "sg-tcm-outpatient", "roles": "sg-tcm-clinic", "ruleSeries": RULES,
 "visits": [{"index": 1, "phase": V1, "date": "2026-12-14", "label": "First visit"}, {"index": 2, "phase": FU, "date": "2026-12-21", "label": "Follow-up visit (one week later)"}],
 "cast": cast(),
 "patient": {"id": "patient", "location": "consult-room", "position": "seated", "riskFactors": [], "anxiety": 0.45,
  "anatomy": {"fingerCunCm": 2.05, "regions": {"knee-leg": {"both": {"scale": {"u": 1.03, "v": 0.97}}}, "forearm": {"both": {"scale": {"u": 1.03, "v": 1.0}}}}},
  "siteConditions": [], "ashi": [],
  "consent": {"requiredTopics": ["procedure", "risks", "alternatives"], "agree": "Okay, doctor, can.", "questions": "Got any risk? And what else can I do for the sleep?"}},
 "regions": ["forearm", "knee-leg"],
 "equipment": {"packs": [{"id": "pack-a", "at": "shelf", "count": 5, "needle": NEEDLE}, {"id": "pack-b", "at": "shelf", "count": 5, "needle": NEEDLE}]},
 "safety": {"guard": "block-critical"}, "events": [],
 "evaluation": {
  "pathways": [
   {"id": "p-treat", "label": "Treat after informed consent, with sleep-hygiene advice and driving safety", "acceptable": True, "when": {"all": [{"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"explained": "alternatives"}, {"clinical": {"asked": "hx-self-harm"}}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}},
   {"id": "p-decline-signpost", "label": "Decline or defer, with sleep advice and signposting", "acceptable": True, "when": {"all": [{"disposition": ["decline", "defer", "refer"], "visit": 1}, {"needlesInserted": {"lte": 0}}, {"any": [{"referred": {"to": ["gp"]}}, {"explained": "alternatives"}]}, {"visitEnded": 1}]}},
   {"id": "p-treat-unscreened", "label": "Treated without asking about thoughts of self-harm", "acceptable": False, "when": {"all": [{"needlesInserted": {"gte": 1}}, {"not": {"clinical": {"asked": "hx-self-harm"}}}]}},
   {"id": "p-emergency-unindicated", "label": "Emergency referral without an indication", "acceptable": False, "when": {"referred": {"urgency": ["emergency"]}}}],
  "diagnoses": {"expected": ["insomnia"], "acceptable": []},
  "patterns": {"defensible": ["heart-spleen-deficiency", "liver-qi-stagnation", "heart-kidney-disharmony"], "implausible": ["damp-heat-bi", "wind-cold-damp-bi"]},
  "redFlags": [{"id": "suicidal-ideation", "present": False}],
  "points": {"recommended": [{"point": "HT7"}, {"point": "SP6"}], "acceptable": [{"point": "PC6"}, {"point": "ST36"}, {"point": "Yintang", "side": "midline"}, {"point": "GV20", "side": "midline"}, {"point": "KI3"}, {"point": "LR3"}], "avoid": [], "maxNeedles": 8},
  "criticalErrors": [],
  "required": {"history": ["hx-sleep", "hx-mood", "hx-self-harm", "hx-daytime", "hx-meds"], "exam": ["ex-general"], "records": []},
  "monitoring": {"maxGapMinutes": 10, "respondWithinMinutes": 2},
  "followUp": {"pathways": [{"id": "fu-review", "label": "Review sleep and mood; continue, adjust or stop", "acceptable": True, "when": {"all": [{"clinical": {"asked": "fu-progress"}}, {"clinical": {"asked": "fu-new"}}, {"disposition": ["treat", "treat-modified", "defer", "decline"], "visit": 2}, {"visitEnded": 2}]}}]},
  "documentation": ["assessment", "rationale", "pointsUsed", "needling", "response", "followUp"]},
 "solution": [], "alternatives": []}

WITHDRAW = {"id": "ev-withdraw", "when": {"needlesRetained": {"gte": 2}}, "afterMinutes": 0.5, "interrupts": True, "severity": "warning",
  "effects": {"consent": "withdrawn", "say": {"speaker": "patient", "text": "Stop, stop — I really don't like this. Please take them out, I don't want any more."}, "anxiety": 0.2}}

variants = [
 variant("base", "Base case", "base", "Stress-related insomnia without low mood or self-harm thoughts: screening of mood, self-harm and driving safety, then HT7 and SP6 on both sides, the forearm and leg charts in one treatment."),
 variant("withdraws-consent", "Withdraws consent after two needles", "event", "An event during the procedure: after the second needle he says stop and asks for the needles out. Consent is withdrawn; the guard blocks any further insertion and records it. Acceptable: stop, every needle out within three minutes, reassurance, record; respect a refusal at follow-up.",
  case={"history": [{"id": "hx-acupuncture-before", "answer": "Never. To be honest I don't like needles very much, but my wife says try."}, {"id": "fu-progress", "answer": "Still sleeping badly. I'd rather not have the needles again — can we try something else?"}]},
  field={"patient": {"anxiety": 0.65}, "events": [WITHDRAW],
   "evaluation": {"pathways": [{"id": "p-treat", "$remove": True},
     {"id": "p-withdrawal-respected", "label": "Stopped at the withdrawal of consent: every needle out within three minutes, no further needling", "acceptable": True, "when": {"all": [{"event": "ev-withdraw"}, {"withdrawnAfter": {"event": "ev-withdraw", "withinMinutes": 3}}, {"not": {"unsafe": "insertion-after-consent-withdrawn"}}, {"visitEnded": 1}]}},
     {"id": "p-treat-complete", "label": "Treated without the patient stopping it", "acceptable": True, "when": {"all": [{"not": {"event": "ev-withdraw"}}, {"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"explained": "alternatives"}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}}],
    "criticalErrors": [{"id": "ce-withdrawal-ignored", "label": "Needles still in three minutes after the patient withdrew consent", "when": {"all": [{"event": "ev-withdraw"}, {"not": {"withdrawnAfter": {"event": "ev-withdraw", "withinMinutes": 3}}}]}}]}}),
 variant("low-mood", "Low mood with thoughts of suicide", "red-flag", "A red flag found only by asking: he is hopeless and has thought about crashing his taxi. Acceptable: no acupuncture today, same-day urgent help (emergency referral), and safety advice. Missing it is a critical failure.",
  case={"history": [{"id": "hx-mood", "answer": "Honestly, I feel hopeless. I don't enjoy anything any more, even my grandson."},
     {"id": "hx-self-harm", "answer": "Sometimes I think my family would be better off without me. Last week I thought about crashing the taxi."},
     {"id": "hx-onset", "answer": "About three months ago, when I lost most of my savings. Since then everything is going wrong."}],
   "exam": [{"id": "ex-general", "finding": "Flat affect, poor eye contact, tearful at times.", "abnormal": True}],
   "patient": {"persona": {"affect": "distressed"}},
   "debrief": {"conclusion": "Insomnia with a depressive episode and suicidal thoughts with a method: same-day urgent help, no acupuncture today, and advice not to drive until assessed."}},
  field={"evaluation": {"pathways": [{"id": "p-treat", "$remove": True}, {"id": "p-decline-signpost", "$remove": True}, {"id": "p-emergency-unindicated", "$remove": True}, {"id": "p-treat-unscreened", "$remove": True},
     {"id": "p-urgent-help", "label": "Same-day urgent help, no needling", "acceptable": True, "when": {"all": [{"referred": {"to": ["emergency"], "urgency": ["emergency", "urgent"]}}, {"needlesInserted": {"lte": 0}}, {"visitEnded": 1}]}},
     {"id": "p-routine-only", "label": "Only a routine referral", "acceptable": False, "when": {"all": [{"referred": {"urgency": ["routine", "soon"]}}, {"not": {"referred": {"urgency": ["emergency", "urgent"]}}}]}},
     {"id": "p-treated", "label": "Acupuncture given instead of urgent help", "acceptable": False, "when": {"needlesInserted": {"gte": 1}}}],
    "diagnoses": {"expected": {"$replace": ["depressive-episode"]}, "acceptable": {"$replace": ["insomnia"]}},
    "patterns": {"$replace": {"defensible": [], "implausible": []}},
    "redFlags": {"$replace": [{"id": "suicidal-ideation", "present": True}]},
    "points": {"$replace": {"recommended": [], "acceptable": [], "avoid": [], "maxNeedles": 1}},
    "criticalErrors": [{"id": "ce-no-urgent-help", "label": "No same-day urgent help for suicidal thoughts with a method", "when": {"all": [{"visitEnded": 1}, {"not": {"referred": {"urgency": ["emergency", "urgent"]}}}]}}],
    "required": {"$replace": {"history": ["hx-mood", "hx-self-harm"], "exam": [], "records": []}},
    "followUp": None}}),
]
fam = family(FID, "Poor sleep · 54-year-old man", "A 54-year-old taxi driver who has slept badly for three months asks about acupuncture.", "insomnia", "held-out", [v["id"] for v in variants])
if not C:
    write_family(FID, fam, case, field, variants, {})
    sys.exit(0)

EXPLAIN = ("I suggest acupuncture: four fine single-use sterile needles — at the inner wrist and the inner lower leg on each side — for about twenty minutes. "
  "It may help you relax and sleep; the evidence is limited. Risks are small: soreness, bruising, feeling faint. "
  "Just as important: no kopi after lunch, a regular bedtime, and don't drive when you feel sleepy. If it doesn't improve, your doctor can help further. You can tell me to stop at any time.")

def consult(t, full=True):
    t.ask("hx-chief", "hx-sleep", "hx-onset", "hx-mood", "hx-self-harm", "hx-daytime", "hx-snoring", "hx-caffeine", "hx-pmh", "hx-meds", "hx-acupuncture-before", "hx-tcm", "hx-ice")
    t({"type": "review_result", "investigationId": "inv-gp-note"})
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t({"type": "hand_hygiene"})
    t.examine("ex-general", "ex-skin", "ex-tongue", "ex-pulse-tcm")
    t({"type": "check_vitals"})

PTS = [{"point": "HT7", "side": "left"}, {"point": "HT7", "side": "right"}, {"point": "SP6", "side": "left"}, {"point": "SP6", "side": "right"}]

def prepare(t):
    t({"type": "propose_plan", "plan": {"points": PTS, "technique": {"method": "manual-filiform", "stimulation": "even", "retentionMinutes": 20}, "rationale": "HT7 and SP6 to calm the spirit and support heart and spleen.", "alternatives": ["Sleep hygiene and less caffeine", "Review by his doctor (CBT for insomnia)"], "followUp": "Review in one week."}})
    t({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "right-to-stop"], "text": EXPLAIN})
    t({"type": "seek_consent"})
    t({"type": "position_patient", "position": "supine-knee-flexed"})
    t({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please check on Mr Ong every five minutes while the needles are in."})
    # one side of the couch, then the other: the wrist, then the leg
    for side in ("left", "right"):
        t.landmarks("forearm", side, "fcu-radial-wrist")
        t.mark({"point": "HT7", "side": side}, "forearm", side, *C[f"HT7:{side}"], method="landmark")
        t.landmarks("knee-leg", side, "medial-malleolus", "medial-condyle-inferior")
        t({"type": "measure", "region": "knee-leg", "side": side, "segment": "seg.sp9-medial-malleolus"})
        t.mark({"point": "SP6", "side": side}, "knee-leg", side, *C[f"SP6:{side}"])
    t.fetch_pack("pack-a")
    for side in ("left", "right"):
        for region in ("forearm", "knee-leg"): t({"type": "prepare_site", "region": region, "side": side})
    t({"type": "open_pack", "packId": "pack-a"})

def doc(n, response, adverse="None."):
    return {"type": "document", "record": {"presentingComplaint": "Poor sleep for three months.", "assessment": "Stress-related insomnia; mood reactive; no thoughts of self-harm; advised not to drive when sleepy.", "pattern": "Heart and spleen deficiency",
      "rationale": "HT7 and SP6 with sleep-hygiene advice.", "consent": "Verbal consent after explanation.", "pointsUsed": PTS[:n],
      "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": n, "depth": "HT7 0.5 cm; SP6 1.5 cm", "responseSought": "mild deqi", "stimulation": "even", "retentionMinutes": 20 if n == 4 else 1},
      "response": response, "adverseEvents": adverse, "advice": "No caffeine after lunch; regular bedtime; do not drive when sleepy.", "followUp": "Review in one week."}}

base = Trajectory("ib")
consult(base)
base({"type": "assess", "diagnoses": ["insomnia"], "pattern": "heart-spleen-deficiency", "redFlags": [], "rationale": "Sleep-onset and early waking under stress; dreams, palpitations, poor appetite, fatigue; pale tongue with teeth marks, thin weak pulse. Mood reactive; no self-harm thoughts."})
base({"type": "decide", "disposition": "treat", "rationale": "No red flags; acupuncture with sleep-hygiene advice."})
prepare(base)
for i, (key, d) in enumerate([("HT7:left", 0.5), ("HT7:right", 0.5), ("SP6:left", 1.5), ("SP6:right", 1.5)]): base.needle(f"pack-a.{i+1}", base.mark_id(key), d)
base({"type": "monitor"}); base({"type": "wait", "minutes": 10}); base({"type": "monitor"}); base({"type": "wait", "minutes": 9}); base({"type": "monitor"})
base.close_needles("pack-a")
base({"type": "explain", "topics": ["aftercare"], "text": "Go home and rest; don't drive if you feel drowsy."})
base(doc(4, "Tolerated; relaxed.")); base({"type": "end_visit"})
base({"type": "begin_follow_up"}); base.ask("fu-progress", "fu-new")
base({"type": "decide", "disposition": "treat", "rationale": "Improving: continue weekly with sleep hygiene."})
base({"type": "document", "record": {"assessment": "Insomnia improving; mood okay.", "response": "Falls asleep within 30 minutes on some nights.", "adverseEvents": "None.", "followUp": "Weekly for three more sessions."}})
base({"type": "end_visit"}); base({"type": "finish_encounter"})

wd = Trajectory("iw")
consult(wd)
wd({"type": "assess", "diagnoses": ["insomnia"], "pattern": "heart-spleen-deficiency", "redFlags": [], "rationale": "Stress-related insomnia; no self-harm thoughts."})
wd({"type": "decide", "disposition": "treat", "rationale": "He agrees to try, though wary of needles."})
prepare(wd)
wd.needle("pack-a.1", wd.mark_id("HT7:left"), 0.5)
wd.needle("pack-a.2", wd.mark_id("HT7:right"), 0.5)
wd({"type": "monitor"})  # he asks to stop
wd({"type": "stop_treatment", "reason": "the patient withdrew consent"})
wd({"type": "remove_all_needles"})
wd({"type": "say", "to": "patient", "text": "Of course — they're all out now. You did nothing wrong; we'll stop here. Lie still for a moment."})
wd({"type": "dispose", "object": "pack-a"})
wd({"type": "hand_hygiene"})
wd({"type": "count_needles"})
wd({"type": "monitor"})
wd({"type": "explain", "topics": ["alternatives"], "text": "Without needles, the most useful things are no kopi after lunch, a regular bedtime and wind-down routine, and talking to your doctor about therapy for insomnia. Please don't drive when you feel sleepy."})
wd({"type": "document", "record": {"presentingComplaint": "Poor sleep for three months.", "assessment": "Stress-related insomnia.", "pattern": "Heart and spleen deficiency", "rationale": "HT7 and SP6 planned.", "consent": "Verbal consent given, then withdrawn after two needles.", "pointsUsed": PTS[:2],
    "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": 2, "depth": "HT7 0.5 cm", "responseSought": "mild deqi", "stimulation": "none", "retentionMinutes": 1},
    "response": "He withdrew consent after the second needle: stopped, both needles removed at once.", "adverseEvents": "Anxiety; consent withdrawn. No physical harm.", "advice": "Sleep hygiene; GP review; do not drive when sleepy.", "followUp": "Review in one week without needles."}})
wd({"type": "end_visit"})
wd({"type": "begin_follow_up"}); wd.ask("fu-progress", "fu-new")
wd({"type": "decide", "disposition": "decline", "rationale": "He does not want needles again: respected; sleep hygiene and GP review."})
wd({"type": "refer", "to": "gp", "urgency": "routine", "reason": "Persistent insomnia; declined acupuncture; consider CBT for insomnia."})
wd({"type": "document", "record": {"assessment": "Persistent insomnia; declines further acupuncture.", "followUp": "GP referral for CBT-I."}})
wd({"type": "end_visit"}); wd({"type": "finish_encounter"})

lm = Trajectory("il")
lm.ask("hx-chief", "hx-sleep", "hx-onset", "hx-mood", "hx-self-harm", "hx-daytime", "hx-meds")
lm({"type": "move", "to": "treatment-room", "withPatient": True})
lm.examine("ex-general")
lm({"type": "assess", "diagnoses": ["depressive-episode"], "redFlags": ["suicidal-ideation"], "rationale": "Hopelessness, anhedonia and suicidal thoughts with a method (crashing the taxi)."})
lm({"type": "decide", "disposition": "refer", "rationale": "Suicide risk with a method: same-day urgent help; no acupuncture."})
lm({"type": "say", "to": "patient", "text": "Thank you for telling me, Mr Ong. What you're feeling needs proper help today, not acupuncture. I'd like you to be seen at the hospital now — we'll call your wife to come with you. Please don't drive."})
lm({"type": "refer", "to": "emergency", "urgency": "emergency", "reason": "Depressive symptoms with suicidal thoughts and a method (crashing his taxi); needs same-day assessment."})
lm({"type": "document", "record": {"presentingComplaint": "Poor sleep for three months.", "assessment": "Depressive episode with suicidal thoughts and a method. No acupuncture.", "advice": "Not to drive; accompanied to hospital.", "followUp": "Emergency referral; family informed."}})
lm({"type": "end_visit"}); lm({"type": "finish_encounter"})

write_family(FID, fam, case, field, variants, {"base": base, "withdraws-consent": wd, "low-mood": lm})
