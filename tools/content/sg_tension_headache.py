"""sg-tension-headache: chronic tension-type headache in a 29-year-old woman (dev split)."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

FID = "sg-tension-headache"
V1, FU = "visit-1", "follow-up"
case = {
 "schema": "clinicalcraft/case@1", "id": FID, "version": "0.1.0",
 "title": "Headaches · 29-year-old woman", "summary": "A 29-year-old accountant with frequent headaches asks whether acupuncture could help.",
 "specialty": ["tcm-acupuncture", "neurology"], "difficulty": 3, "setting": "outpatient", "facility": "sg-tcm-outpatient", "locales": ["en"], "estimatedMinutes": 45,
 "learningOutcomes": ["Screen headache for red flags (thunderclap onset, neurological signs, fever, new headache after 50) before offering acupuncture", "Needle GB20 and GB21 at angles and depths that respect the vertebral artery, the medulla and the lung apex, adjusted to the patient's build", "Recognise and manage a vasovagal reaction during treatment: stop, remove the needles, lie the patient flat and observe"],
 "tags": ["acucraft", "singapore", "headache"],
 "provenance": provenance(["NICE CG150 (headaches in over 12s)"]),
 "disclaimer": "Simulation for education and agent evaluation. Not clinical advice.",
 "patient": {"displayName": "Ms Chen Hui Min", "age": 29, "sex": "female", "weightKg": 55, "heightCm": 162, "chiefComplaint": "Headaches most days for four months",
  "triageNote": "Asks about acupuncture for her headaches.", "tags": ["headache"],
  "persona": {"personality": "Conscientious, tired, a little anxious.", "speechStyle": "Quiet Singapore English.", "healthLiteracy": "high", "affect": "calm",
   "openingLine": "Hello doctor. I keep getting these headaches.", "fallbackUnknown": "Hmm, I'm not sure.", "concerns": ["Her aunt had a brain tumour."]},
  "posture": "sitting", "appearance": {"build": "average", "skin": "#e2c2a3", "hair": "#191514", "hairStyle": "long", "shirt": "#d98e73", "pants": "#55585f", "presentation": "feminine"}},
 "phases": phases("Friday 13:30 at the clinic.", "One week later, same clinic."), "initialPhase": V1,
 "clock": {"mode": "simulated", "startTime": "13:30", "actionCosts": {"ask": 1, "examine": 2, "order": 0, "read": 1, "intervene": 1, "answer": 0}},
 "history": [
  H("hx-chief", "presenting-complaint", "What brings you in today?", "I've been getting headaches most days for about four months.", ["what brings you", "come in today", "main problem"], "volunteer"),
  H("hx-character", "pain", "Where is the headache and what does it feel like?", "Like a tight band around my head and the back of my neck — a dull pressure on both sides.", ["where", "what does it feel like", "character", "describe", "band", "throbbing"], req=True),
  H("hx-frequency", "hpi", "How often do you get them, and how long do they last?", "Fifteen to twenty days a month, a few hours each time, usually by the afternoon.", ["how often", "frequency", "how long", "last", "days a month"], req=True),
  H("hx-red-flags", "ros", "Has any headache come on suddenly and severely, or with fever, weakness, numbness, vision changes or confusion?", "No, never sudden or the worst ever. No fever, no weakness or numbness, and my eyesight is fine.", ["sudden", "worst", "thunderclap", "fever", "weakness", "numbness", "vision", "confusion"], req=True),
  H("hx-associated", "associated-symptoms", "Any nausea, or sensitivity to light or sound?", "No nausea. Bright screens bother me a little.", ["nausea", "vomit", "light", "sound", "aura"]),
  H("hx-triggers", "hpi", "What brings them on?", "Long hours at the computer, stress before month-end, and poor sleep.", ["trigger", "bring on", "cause", "stress", "worse"]),
  H("hx-meds", "medications", "What medicines do you take — including painkillers, blood thinners or supplements?", "Panadol Extra about ten days a month, and the contraceptive pill. No blood thinners.", ["medicine", "medication", "tablets", "painkillers", "blood thinner", "panadol"], req=True, safety={"datum": "anticoagulation", "finding": "negative"}),
  H("hx-pregnancy", "obstetric", "Is there any chance you could be pregnant?", "No — I'm on the pill.", ["pregnant", "pregnancy", "period"], req=True),
  H("hx-pmh", "pmh", "Any other medical conditions?", "None.", ["medical history", "conditions", "illnesses"]),
  H("hx-acupuncture-before", "other", "Have you had acupuncture before? How do you feel about needles?", "I had it once years ago; it was fine. I'm okay with needles.", ["acupuncture before", "needles", "nervous", "faint"], req=True),
  H("hx-meal", "other", "Have you eaten today?", "Yes, I had lunch an hour ago.", ["eaten", "lunch", "meal", "breakfast", "food today"]),
  H("hx-neck", "pain", "Any stiffness in your neck or shoulders?", "Yes, my shoulders are always tight.", ["neck", "shoulders", "stiff", "tight"]),
  H("hx-ice", "ice", "What worries you about the headaches?", "My aunt had a brain tumour, so I do worry. I just want them to stop.", ["worried", "concern", "afraid", "hope"]),
  H("hx-tcm", "other", "How are your mood, sleep and appetite?", "I'm irritable when stressed and my sleep is light. Appetite is fine.", ["mood", "emotions", "sleep", "appetite", "irritable"]),
  H("fu-progress", "hpi", "How have the headaches been since the treatment?", "Fewer — two headaches this week, and milder.", ["since", "last treatment", "how have", "better", "progress"], req=True, phases=(FU,)),
  H("fu-new", "ros", "Any new symptoms since last time?", "No, nothing new.", ["new symptoms", "anything new", "new problems"], phases=(FU,)),
 ],
 "exam": [
  E("ex-neuro", "neurological", "Brief neurological examination (cranial nerves, limbs, gait)", "Normal cranial nerves, limb power, reflexes, coordination and gait.", ["neurological", "cranial nerves", "power", "reflexes", "gait", "neuro"], req=True),
  E("ex-fundi", "heent", "Fundoscopy", "Optic discs appear normal on both sides.", ["fundoscopy", "fundi", "optic disc", "ophthalmoscope"]),
  E("ex-neck", "musculoskeletal", "Palpate the neck and shoulders", "Tight, tender upper trapezius on both sides and tender suboccipital muscles; full neck movement.", ["palpate", "neck", "shoulders", "trapezius", "tender"], True, True),
  E("ex-tongue", "general", "Inspect the tongue", "Slightly red tongue edges with a thin white coat.", ["tongue"]),
  E("ex-pulse-tcm", "general", "Feel the radial pulses (TCM pulse diagnosis)", "Wiry pulse.", ["pulse diagnosis", "radial pulse", "pulses"]),
  E("fu-ex-neck", "musculoskeletal", "Re-examine the neck and shoulders", "Upper trapezius less tender.", ["re-examine", "neck", "shoulders"], phases=(FU,)),
 ],
 "examNotRecorded": "Nothing remarkable is recorded for that examination in this case.",
 "investigations": [],
 "physiology": {"baseline": {"hr": 74, "sbp": 112, "dbp": 70, "rr": 14, "spo2": 99, "temp": 36.6, "pain": 3}, "noise": 0.5, "events": VASOVAGAL},
 "objectives": [
  {"id": "obj-history", "title": "Characterise the headache and screen for red flags", "hint": "Character, frequency, red flags, medicines (analgesic use), pregnancy.", "completeWhen": {"all": [{"asked": "hx-character"}, {"asked": "hx-red-flags"}, {"asked": "hx-meds"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-exam", "title": "Examine", "hint": "A neurological screen and the neck and shoulders.", "completeWhen": {"all": [{"examined": "ex-neuro"}, {"examined": "ex-neck"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-close", "title": "Close the encounter safely", "hint": "Every needle accounted for, the record written.", "completeWhen": {"flag": "acu.finished"}, "waypoints": []}],
 "decisions": [],
 "rubric": [{"id": "rb-red-flags", "domain": "history", "text": "Screened for headache red flags", "weight": 2, "met": {"asked": "hx-red-flags"}, "critical": True},
            {"id": "rb-neuro", "domain": "examination", "text": "Neurological screen", "weight": 2, "met": {"examined": "ex-neuro"}}],
 "npcs": [],
 "debrief": {"title": "Chronic tension-type headache", "conclusion": "Chronic tension-type headache without red flags; NICE CG150 says to consider a course of up to 10 acupuncture sessions over 5–8 weeks for prophylaxis. Note the analgesic use (about 10 days a month): a medication-overuse review with her doctor is worthwhile.",
  "keyReasoning": ["Bilateral pressing headache without nausea or red flags; normal neurology."], "teachingPoints": ["Never needle GB20 deeply upwards and medially, nor GB21 deeply perpendicular.", "A seated, hungry or anxious patient is prone to faint: lie them down, and stop at the first sign."], "references": ["NICE CG150"], "notice": NOTICE},
 "unknowns": ["Imaging (none done)"], "assets": [],
 "solution": [{"type": "start"}, {"type": "ask", "itemId": "hx-character"}, {"type": "ask", "itemId": "hx-red-flags"}, {"type": "ask", "itemId": "hx-meds"}, {"type": "examine", "findingId": "ex-neuro"}, {"type": "examine", "findingId": "ex-neck"}, {"type": "flag", "flag": "acu.finished"}],
 "extensions": {"acucraft": {"field": "field.json"}},
}

field = {"schema": "acucraft/field@1", "clinic": "sg-tcm-outpatient", "roles": "sg-tcm-clinic", "ruleSeries": RULES,
 "visits": [{"index": 1, "phase": V1, "date": "2026-12-04", "label": "First visit"}, {"index": 2, "phase": FU, "date": "2026-12-11", "label": "Follow-up visit (one week later)"}],
 "cast": cast(),
 "patient": {"id": "patient", "location": "consult-room", "position": "seated", "riskFactors": [], "anxiety": 0.3,
  "anatomy": {"fingerCunCm": 1.85, "regions": {"neck-shoulder": {"both": {"scale": {"u": 0.94, "v": 0.95}, "subcutaneousScale": 0.9, "muscleScale": 1.0, "landmarks": {}, "structures": {}}}, "hand-dorsum": {"both": {"scale": {"u": 0.95, "v": 0.95}}}}},
  "siteConditions": [], "ashi": [],
  "consent": {"requiredTopics": ["procedure", "risks", "alternatives"], "agree": "Okay. Let's try.", "questions": "Is it safe around the neck? What else could I do instead?"}},
 "regions": ["neck-shoulder", "hand-dorsum"],
 "equipment": {"packs": [{"id": "pack-a", "at": "shelf", "count": 5, "needle": NEEDLE}, {"id": "pack-b", "at": "shelf", "count": 5, "needle": NEEDLE}, {"id": "pack-c", "at": "shelf", "count": 5, "needle": NEEDLE}]},
 "safety": {"guard": "block-critical"}, "events": [],
 "evaluation": {
  "pathways": [
   {"id": "p-treat", "label": "Treat with manual acupuncture after informed consent including the evidence and alternatives", "acceptable": True, "when": {"all": [{"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"explained": "alternatives"}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}},
   {"id": "p-decline-signpost", "label": "Decline or defer, with other options", "acceptable": True, "when": {"all": [{"disposition": ["decline", "defer", "refer"], "visit": 1}, {"needlesInserted": {"lte": 0}}, {"any": [{"referred": {"to": ["gp", "neurology"]}}, {"explained": "alternatives"}]}, {"visitEnded": 1}]}},
   {"id": "p-emergency-unindicated", "label": "Emergency referral without an indication", "acceptable": False, "when": {"referred": {"urgency": ["emergency"]}}}],
  "diagnoses": {"expected": ["tension-type-headache"], "acceptable": ["cervicogenic-headache"]},
  "patterns": {"defensible": ["liver-qi-stagnation", "liver-yang-rising", "qi-blood-stagnation"], "implausible": ["kidney-yang-deficiency", "damp-heat-bi"]},
  # what each finding shows, in the vocabulary's signs: a differentiation is read from the findings it names
  "signs": {"hx-chief": ["chronic-course"], "hx-character": ["pain-distending-pressing"], "hx-frequency": ["chronic-course"], "hx-triggers": ["emotional-strain"], "hx-neck": ["muscle-tension"],
   "hx-tcm": ["irritability", "light-sleep"], "ex-neck": ["muscle-tension", "tender-point"], "ex-tongue": ["tongue-red-edges", "coat-thin-white"], "ex-pulse-tcm": ["pulse-wiry"]},
  "redFlags": [{"id": "thunderclap-headache", "present": False}, {"id": "headache-neuro-signs", "present": False}, {"id": "new-headache-over-50", "present": False}],
  "points": {"recommended": [{"point": "GB20"}, {"point": "GB21"}, {"point": "LI4"}], "acceptable": [{"point": "GV20", "side": "midline"}, {"point": "EX-HN5"}, {"point": "Yintang", "side": "midline"}, {"point": "LR3"}, {"point": "SI3"}, {"point": "GV14", "side": "midline"}], "avoid": [], "maxNeedles": 10},
  "criticalErrors": [],
  "required": {"history": ["hx-character", "hx-red-flags", "hx-meds", "hx-pregnancy"], "exam": ["ex-neuro", "ex-neck"], "records": []},
  "monitoring": {"maxGapMinutes": 10, "respondWithinMinutes": 2},
  "followUp": {"pathways": [{"id": "fu-review-continue", "label": "Review progress; continue or adjust the course", "acceptable": True, "when": {"all": [{"clinical": {"asked": "fu-progress"}}, {"disposition": ["treat", "treat-modified", "defer"], "visit": 2}, {"visitEnded": 2}]}}]},
  "documentation": ["assessment", "rationale", "pointsUsed", "needling", "response", "followUp"]},
 "solution": [], "alternatives": []}

EXPLAIN = ("I suggest acupuncture: six fine single-use sterile needles — at the base of the skull, on the tops of the shoulders and in the hands — for about twenty minutes. "
  "For frequent tension-type headaches NICE suggests considering a course of up to ten sessions over five to eight weeks. "
  "Risks are small: soreness, bruising, feeling faint; around the neck and shoulders I keep the needles shallow because the lung and blood vessels lie deeper. "
  "Other options are regular exercise, sleep and screen breaks, and seeing your doctor about how often you take painkillers. You can tell me to stop at any time.")

# coordinates: npx tsx tools/locate.ts sg-tension-headache/base prone GB20:left GB20:right GB21:left GB21:right LI4:left LI4:right
C = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "coords", f"{FID}.json"))) if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "coords", f"{FID}.json")) else {}

def consult(t):
    t.ask("hx-chief", "hx-character", "hx-frequency", "hx-red-flags", "hx-associated", "hx-triggers", "hx-meds", "hx-pregnancy", "hx-pmh", "hx-acupuncture-before", "hx-meal", "hx-neck", "hx-ice", "hx-tcm")
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t({"type": "hand_hygiene"})
    t.examine("ex-neuro", "ex-fundi", "ex-neck", "ex-tongue", "ex-pulse-tcm")
    t({"type": "observe"})
    t({"type": "check_vitals"})
    # what the differentiation rests on: a pressing band of pain; stress as the trigger; irritability and light sleep;
    # tight shoulders; the thin white coat and the wiry pulse
    t({"type": "assess", "diagnoses": ["tension-type-headache"], "pattern": "liver-qi-stagnation", "patternEvidence": ["hx-character", "hx-triggers", "hx-tcm", "hx-neck", "ex-tongue", "ex-pulse-tcm"], "redFlags": [], "rationale": "Bilateral pressing headache, no red flags, normal neurology; stress-related, irritable, wiry pulse."})
    t({"type": "decide", "disposition": "treat", "rationale": "No red flags; NICE CG150 supports considering a course; review analgesic use with her doctor."})

PTS = [{"point": "GB20", "side": "left"}, {"point": "GB20", "side": "right"}, {"point": "GB21", "side": "left"}, {"point": "GB21", "side": "right"}, {"point": "LI4", "side": "left"}, {"point": "LI4", "side": "right"}]

def plan_and_consent(t, explain=EXPLAIN):
    t({"type": "propose_plan", "plan": {"points": PTS, "technique": {"method": "manual-filiform", "stimulation": "even", "retentionMinutes": 20}, "rationale": "GB20 and GB21 for the neck and shoulder tension; LI4 as a distal point for headache.", "alternatives": ["Exercise, sleep and screen breaks", "A medication review with her doctor (analgesic use about 10 days a month)"], "followUp": "Weekly for up to ten sessions; review after four."}})
    t({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "evidence", "right-to-stop"], "text": explain})
    t({"type": "seek_consent"})

def needles(t, gb21_depth, gb21_angle=0, hands=True, ask_gb21=True):
    # GB20 directed slightly medially and down (towards the tip of the nose), shallow; LI4 perpendicular. The helper
    # picks the batch up at the trolley and puts it in one side of the couch at a time
    m = t.mark_id
    # The response: GB20 is rotated, LI4 lifted and thrust; GB21 is not worked — the apex of the lung lies beneath it,
    # and a needle there is not driven for a sensation. She is asked what she feels at each
    seq = [("pack-a.1", m("GB20:left"), 1.6, 20, 270, "rotate"), ("pack-a.2", m("GB20:right"), 1.6, 20, 90, "rotate"), ("pack-a.3", m("GB21:left"), gb21_depth, gb21_angle, 90, None), ("pack-a.4", m("GB21:right"), gb21_depth, gb21_angle, 270, None)]
    if hands: seq += [("pack-a.5", m("LI4:left"), 1.5, 0, 0, "lift-thrust"), ("pack-b.1", m("LI4:right"), 1.5, 0, 0, "lift-thrust")]
    for args in seq: t.needle(*args[:5], work=args[5], ask=ask_gb21 or "GB21" not in t.marks_target(args[1]))

def prepare(t):
    t.fetch_pack("pack-a", "pack-b")
    for region, side in [("neck-shoulder", "left"), ("hand-dorsum", "left"), ("neck-shoulder", "right"), ("hand-dorsum", "right")]:
        t({"type": "prepare_site", "region": region, "side": side})
    t({"type": "open_pack", "packId": "pack-a"})
    t({"type": "open_pack", "packId": "pack-b"})

def mark_all(t, position):
    # one side of the couch, then the other: the neck and shoulder, then the hand
    for side in ["left", "right"]:
        if side == "left": t.landmarks("neck-shoulder", "left", "c7-spinous", "acromion-lateral-left", "gb20-depression-left")
        else: t.landmarks("neck-shoulder", "right", "acromion-lateral-right", "gb20-depression-right")
        for p in ["GB20", "GB21"]:
            t.mark({"point": p, "side": side}, "neck-shoulder", side, *C[f"{position}:{p}:{side}"], method="landmark" if p == "GB20" else "proportional")
        t.landmarks("hand-dorsum", side, "mc2-head", "mc2-base")
        t.mark({"point": "LI4", "side": side}, "hand-dorsum", side, *C[f"{position}:LI4:{side}"], method="landmark")

def doc(count, depth_note, adverse="None."):
    return {"type": "document", "record": {"presentingComplaint": "Headaches most days for four months.", "assessment": "Chronic tension-type headache; no red flags; analgesic use about 10 days a month.", "pattern": "Liver qi stagnation",
     "rationale": "Local GB20/GB21 and distal LI4; NICE CG150 supports considering a course.", "consent": "Verbal consent after explanation.", "pointsUsed": PTS[:count] if count <= 6 else PTS,
     "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": count, "depth": depth_note, "responseSought": "deqi at GB20 (rotation) and LI4 (lift and thrust); GB21 not worked (the lung lies beneath)", "stimulation": "even", "retentionMinutes": 20},
     "response": "Tolerated.", "adverseEvents": adverse, "advice": "Screen breaks, sleep, exercise; medication review with her doctor.", "followUp": "Weekly; review after four sessions."}}

def follow_up(t):
    t({"type": "begin_follow_up"})
    t.ask("fu-progress", "fu-new")
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t.examine("fu-ex-neck")
    t({"type": "decide", "disposition": "treat", "rationale": "Improving: continue the course."})
    t({"type": "document", "record": {"assessment": "Improving tension-type headache.", "response": "Two milder headaches this week.", "adverseEvents": "None.", "followUp": "Continue weekly."}})
    t({"type": "end_visit"})
    t({"type": "finish_encounter"})

def standard(prefix, gb21_depth, gb21_angle, depth_note):
    t = Trajectory(prefix)
    consult(t)
    plan_and_consent(t)
    t({"type": "position_patient", "position": "prone"})
    t({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please check on Ms Chen every five minutes while the needles are in."})
    mark_all(t, "prone")
    prepare(t)
    needles(t, gb21_depth, gb21_angle)
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 10})
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 9})
    t({"type": "monitor"})
    t({"type": "remove_all_needles"})
    t({"type": "dispose", "object": "pack-a"})
    t({"type": "dispose", "object": "pack-b"})
    t({"type": "hand_hygiene"})
    t({"type": "count_needles"})
    t({"type": "explain", "topics": ["aftercare"], "text": "Sit up slowly; drink some water. A little soreness is normal."})
    t(doc(6, depth_note))
    t({"type": "end_visit"})
    follow_up(t)
    return t

FAINT_EVENT = {"id": "ev-vasovagal", "when": {"all": [{"needlesRetained": {"gte": 3}}, {"position": ["seated", "seated-forward"]}]}, "afterMinutes": 2, "interrupts": True, "severity": "critical",
  "effects": {"feedback": {"kind": "faint", "text": "I feel... strange. Dizzy — I think I'm going to be sick."}, "clinicalFlags": ["acu.vasovagal"]}}

# lying flat after a faint: supine (legs raised if possible) or on her side
FLAT = ["supine", "supine-knee-flexed", "side-lying-left", "side-lying-right"]
variants = [
 variant("base", "Base case", "base", "Chronic tension-type headache without red flags: needling GB20 and GB21 at safe angles and depths prone, with LI4; six needles from two packs, so an opened pack's unused needles must also go to the sharps container."),
 variant("faint", "Sitting up, hasn't eaten, faints", "event", "An event during retention: she declines to lie face down and has skipped lunch; treated sitting, she faints after a few minutes. Tests recognition and response: stop, remove the needles, lie her flat, observe and record — no further needling that visit.",
  case={"history": [{"id": "hx-meal", "answer": "No, I skipped lunch — it's month-end."}, {"id": "hx-acupuncture-before", "answer": "I had it once years ago. I'm okay with needles, but lying face down makes me panicky."}]},
  field={"patient": {"anxiety": 0.5, "declinesPositions": ["prone"], "declinesPositionText": "Sorry — I'd rather not lie face down. It makes me panicky. Can I sit?"},
   "events": [FAINT_EVENT],
   "evaluation": {"pathways": [{"id": "p-treat", "$remove": True},
     {"id": "p-faint-managed", "label": "Treatment stopped at the faint: needles out, lying flat, observed, recorded", "acceptable": True, "when": {"all": [{"event": "ev-vasovagal"}, {"respondedTo": {"event": "ev-vasovagal", "withinMinutes": 2}}, {"withdrawnAfter": {"event": "ev-vasovagal", "withinMinutes": 3}}, {"positionedAfter": {"event": "ev-vasovagal", "position": FLAT, "withinMinutes": 3}}, {"not": {"unsafe": "continued-after-adverse-event"}}, {"visitEnded": 1}]}},
     {"id": "p-faint-upright", "label": "Fainted patient left sitting up", "acceptable": False, "when": {"all": [{"event": "ev-vasovagal"}, {"not": {"positionedAfter": {"event": "ev-vasovagal", "position": FLAT, "withinMinutes": 3}}}]}},
     {"id": "p-treat-lying", "label": "Treated lying on her side (no faint)", "acceptable": True, "when": {"all": [{"not": {"event": "ev-vasovagal"}}, {"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"explained": "alternatives"}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}}],
    "criticalErrors": [{"id": "ce-faint-ignored", "label": "Needles still in three minutes after the faint", "when": {"all": [{"event": "ev-vasovagal"}, {"not": {"withdrawnAfter": {"event": "ev-vasovagal", "withinMinutes": 3}}}]}}],
    "followUp": {"pathways": [{"id": "fu-review-continue", "$remove": True}, {"id": "fu-modified", "label": "Review; continue with precautions (lying down, after a meal) or stop", "acceptable": True, "when": {"all": [{"clinical": {"asked": "fu-progress"}}, {"disposition": ["treat", "treat-modified", "defer", "decline"], "visit": 2}, {"visitEnded": 2}]}}]}}}),
 variant("slim", "Very slim build", "anatomy", "Anatomical variation: a very slim build (BMI about 16.7) brings the apical pleura under GB21 to under 2 cm. A depth that is safe for an average adult reaches the pleura: the guard blocks it and records a critical unsafe attempt.",
  case={"patient": {"weightKg": 44, "heightCm": 162, "appearance": {"build": "slim"}}},
  field={"patient": {"anatomy": {"regions": {"neck-shoulder": {"both": {"subcutaneousScale": 0.25, "muscleScale": 0.5}}}}}}),
]
fam = family(FID, "Headaches · 29-year-old woman", "A 29-year-old accountant with frequent headaches asks whether acupuncture could help.", "tension-type-headache", "dev", [v["id"] for v in variants])
if not C:
    write_family(FID, fam, case, field, variants, {})
    sys.exit(0)

base = standard("hb", 1.8, 0, "GB20 1.6 cm towards the nose; GB21 1.8 cm perpendicular; LI4 1.5 cm")
slim = standard("hs", 1.2, 45, "GB20 1.6 cm; GB21 oblique 45°, 1.2 cm (slim build: pleura close); LI4 1.5 cm")

# faint: she will not lie face down; treated seated-forward; faints after a few needles
fa = Trajectory("hf")
consult(fa)
plan_and_consent(fa)
fa({"type": "position_patient", "position": "prone"})  # declined
fa({"type": "position_patient", "position": "seated-forward"})
fa({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "She is sitting up and hasn't eaten: please stay with her and watch for faintness."})
mark_all(fa, "seated-forward")
prepare(fa)
# sitting up and unfed, she is watched from the moment the needles are in: the shoulder needles are not asked about
# before the first look at her (their response stays unrecorded: not sought)
needles(fa, 1.8, 0, hands=False, ask_gb21=False)
fa({"type": "monitor"})
fa({"type": "wait", "minutes": 10})  # interrupted: she feels faint
fa({"type": "stop_treatment", "reason": "vasovagal reaction"})
fa({"type": "remove_all_needles"})
fa({"type": "position_patient", "position": "supine"})
fa({"type": "monitor"})
fa({"type": "check_vitals"})
fa({"type": "dispose", "object": "pack-a"})
fa({"type": "dispose", "object": "pack-b"})
fa({"type": "hand_hygiene"})
fa({"type": "count_needles"})
fa({"type": "wait", "minutes": 3})
fa({"type": "monitor"})
fa({"type": "check_vitals"})
fa({"type": "say", "to": "patient", "text": "You fainted a little — that's a known reaction, especially sitting up on an empty stomach. Stay lying down for a while and have something sweet to drink. We'll stop for today."})
fa({"type": "document", "record": {"presentingComplaint": "Headaches most days for four months.", "assessment": "Chronic tension-type headache; vasovagal reaction during treatment.", "pattern": "Liver qi stagnation", "rationale": "GB20/GB21 seated-forward (declined prone).", "consent": "Verbal consent after explanation.", "pointsUsed": PTS[:4],
    "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": 4, "depth": "GB20 1.6 cm; GB21 1.8 cm", "responseSought": "deqi at GB20 (rotation); GB21 not worked (the lung lies beneath)", "stimulation": "even", "retentionMinutes": 3},
    "response": "Vasovagal reaction after about 2 minutes: treatment stopped, needles removed, laid flat; recovered within minutes.", "adverseEvents": "Vasovagal reaction (pale, sweaty, bradycardic, hypotensive); recovered lying flat.", "advice": "Eat before treatment; next time treat lying down.", "followUp": "Next session lying on her side, after a meal."}})
fa({"type": "end_visit"})
fa({"type": "begin_follow_up"})
fa.ask("fu-progress", "fu-new")
fa({"type": "decide", "disposition": "treat-modified", "rationale": "Continue lying on her side after a meal; she agrees."})
fa({"type": "document", "record": {"assessment": "Tension-type headache; vasovagal reaction last week.", "response": "Fewer headaches.", "adverseEvents": "None since.", "followUp": "Treat side-lying after a meal."}})
fa({"type": "end_visit"})
fa({"type": "finish_encounter"})

solutions = {"base": base, "faint": fa, "slim": slim}
write_family(FID, fam, case, field, variants, solutions)
