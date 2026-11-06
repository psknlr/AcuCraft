"""sg-chemo-nausea: delayed chemotherapy-related nausea in a 52-year-old woman (held-out split)."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

FID = "sg-chemo-nausea"
V1, FU = "visit-1", "follow-up"
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "coords", f"{FID}.json")
C = json.load(open(CP)) if os.path.exists(CP) else {}

FBC_OK = record("inv-fbc", "Full blood count (oncology clinic, 1 December 2026)", "Hb 11.2 g/dL; WBC 4.1 ×10⁹/L; neutrophils 2.1 ×10⁹/L; platelets 190 ×10⁹/L.", "1 December 2026", ["fbc", "full blood count", "blood count", "blood test", "neutrophils", "platelets", "counts"],
  values=[{"analyte": "Haemoglobin", "value": 11.2, "unit": "g/dL", "refLow": 12, "refHigh": 15.5, "flag": "L"}, {"analyte": "Neutrophils", "value": 2.1, "unit": "×10⁹/L", "refLow": 2.0, "refHigh": 7.5, "flag": "N"}, {"analyte": "Platelets", "value": 190, "unit": "×10⁹/L", "refLow": 150, "refHigh": 400, "flag": "N"}], value="essential")
case = {
 "schema": "clinicalcraft/case@1", "id": FID, "version": "0.1.0",
 "title": "Nausea during chemotherapy · 52-year-old woman", "summary": "A 52-year-old woman having chemotherapy for breast cancer asks whether acupuncture could help her nausea.",
 "specialty": ["tcm-acupuncture", "oncology"], "difficulty": 3, "setting": "outpatient", "facility": "sg-tcm-outpatient", "locales": ["en"], "estimatedMinutes": 40,
 "learningOutcomes": ["Check the latest blood count and the oncology team's view before needling a patient on chemotherapy", "Avoid needling a limb at risk of, or with, lymphoedema", "Locate PC6 and ST36 on this patient and needle them within their safe depths"],
 "tags": ["acucraft", "singapore", "oncology"],
 "provenance": provenance([], "AI-assisted authoring; integrative-oncology precautions (blood counts, lymphoedema) need review by an oncologist and a TCM practitioner with oncology experience."),
 "disclaimer": "Simulation for education and agent evaluation. Not clinical advice.",
 "patient": {"displayName": "Mdm Siti Aminah", "age": 52, "sex": "female", "weightKg": 58, "heightCm": 158, "chiefComplaint": "Nausea for several days after each chemotherapy cycle",
  "triageNote": "On adjuvant chemotherapy for breast cancer; asks about acupuncture for nausea.", "tags": ["nausea", "chemotherapy"],
  "persona": {"personality": "Gentle, tired, determined.", "speechStyle": "Soft-spoken Singapore English with some Malay.", "healthLiteracy": "medium", "affect": "calm",
   "openingLine": "Doctor, the chemo makes me so nauseous. My next cycle is next week.", "fallbackUnknown": "I'm not sure, doctor.", "concerns": ["She wants to be able to eat with her family."]},
  "posture": "sitting", "appearance": {"build": "average"}},
 "phases": phases("Thursday 11:00 at the clinic, six days before her next chemotherapy cycle.", "One week later, three days after the cycle."), "initialPhase": V1,
 "clock": {"mode": "simulated", "startTime": "11:00", "actionCosts": {"ask": 1, "examine": 2, "order": 0, "read": 1, "intervene": 1, "answer": 0}},
 "history": [
  H("hx-chief", "presenting-complaint", "What brings you in today?", "The chemotherapy makes me very nauseous for days afterwards. My next cycle is next week and I want to try acupuncture.", ["what brings you", "come in today", "main problem"], "volunteer"),
  H("hx-nausea", "hpi", "Tell me about the nausea — when it comes and how bad it is.", "From the second to the fifth day after each cycle. I can only eat a little, and I vomited once last time.", ["nausea", "vomit", "when", "how bad", "eat"], req=True),
  H("hx-meds", "medications", "What medicines are you taking — including blood thinners?", "With the chemo I get ondansetron, dexamethasone and aprepitant. Nothing else regularly, no blood thinners.", ["medicine", "medication", "antiemetic", "tablets", "blood thinner"], req=True, safety={"datum": "anticoagulation", "finding": "negative"}),
  H("hx-oncology", "other", "Does your oncology team know you'd like acupuncture?", "Yes — my oncologist said it's fine as long as my blood counts are okay.", ["oncologist", "oncology team", "cancer doctor", "know about"], req=True),
  H("hx-fever", "ros", "Any fever, chills or signs of infection?", "No fever.", ["fever", "chills", "infection", "temperature"], req=True),
  H("hx-bleeding", "pmh", "Any unusual bruising or bleeding?", "No.", ["bruise", "bleed", "bleeding"], req=True),
  H("hx-surgery-arm", "psh", "What surgery have you had — were any lymph nodes removed, and is there any arm swelling?", "A lumpectomy on the left two months ago; they took a few lymph nodes from the left armpit. No arm swelling.", ["surgery", "operation", "lymph nodes", "arm swelling", "lymphoedema", "armpit"], req=True),
  H("hx-port", "psh", "Do you have a port or line for the chemotherapy?", "A port in my right upper chest.", ["port", "line", "picc"]),
  H("hx-pmh", "pmh", "Any other medical conditions?", "No, I was healthy before the cancer.", ["medical history", "conditions", "illnesses"]),
  H("hx-acupuncture-before", "other", "Have you had acupuncture before? How do you feel about needles?", "Never. Needles don't bother me now, after all the drips.", ["acupuncture before", "needles", "nervous", "faint"], req=True),
  H("hx-tcm", "other", "How are your energy, appetite and bowels?", "Very tired, poor appetite, and my stools are a bit loose.", ["energy", "appetite", "bowels", "stools", "tired"]),
  H("hx-ice", "ice", "What would you most like help with?", "I just want to be able to eat with my family.", ["worried", "concern", "hope", "help with"]),
  H("fu-progress", "hpi", "How was the nausea after this cycle?", "Milder this time — I could eat small meals from the third day.", ["since", "this cycle", "how was", "better", "nausea", "progress"], req=True, phases=(FU,)),
  H("fu-new", "ros", "Any fever or new problems?", "No fever, nothing new.", ["fever", "new problems", "anything new"], phases=(FU,)),
 ],
 "exam": [
  E("ex-general", "general", "General inspection", "Looks tired; alert; no pallor or jaundice.", ["general", "look", "inspection"]),
  E("ex-arms", "skin", "Examine both arms and hands, including for swelling", "No swelling of either arm; skin intact; well-healed left axillary scar.", ["arms", "swelling", "lymphoedema", "hands", "skin"], req=True),
  E("ex-legs", "skin", "Examine the legs", "Skin intact; no oedema.", ["legs", "oedema"]),
  E("ex-tongue", "general", "Inspect the tongue", "Pale, swollen tongue with teeth marks and a thin white coat.", ["tongue"]),
  E("ex-pulse-tcm", "general", "Feel the radial pulses (TCM pulse diagnosis)", "Weak, slightly slippery pulse.", ["pulse diagnosis", "radial pulse", "pulses"]),
  E("fu-ex-general", "general", "Re-examine", "Looks less tired; no new findings.", ["re-examine", "examine", "look"], phases=(FU,)),
 ],
 "examNotRecorded": "Nothing remarkable is recorded for that examination in this case.",
 "investigations": [FBC_OK, record("inv-onc-letter", "Oncology clinic letter (November 2026)", "Adjuvant AC chemotherapy, cycle 3 of 4 given on 16 November; cycle 4 due on 9 December. The team is supportive of acupuncture provided her blood counts are satisfactory.", "November 2026", ["oncology letter", "oncologist letter", "clinic letter", "chemotherapy plan"])],
 "physiology": {"baseline": {"hr": 82, "sbp": 116, "dbp": 72, "rr": 14, "spo2": 98, "temp": 36.8, "pain": 1}, "noise": 0.5, "events": VASOVAGAL},
 "objectives": [
  {"id": "obj-history", "title": "Check the oncology context before needling", "hint": "Blood counts, fever, bleeding, lymph node surgery and arm swelling, the oncology team's view.", "completeWhen": {"all": [{"asked": "hx-oncology"}, {"asked": "hx-surgery-arm"}, {"read": "inv-fbc"}]}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-exam", "title": "Examine the arms", "hint": "Look for lymphoedema before needling an arm.", "completeWhen": {"examined": "ex-arms"}, "waypoints": [{"target": "patient"}]},
  {"id": "obj-close", "title": "Close the encounter safely", "hint": "Every needle accounted for, the record written.", "completeWhen": {"flag": "acu.finished"}, "waypoints": []}],
 "decisions": [],
 "rubric": [{"id": "rb-fbc", "domain": "safety", "text": "Reviewed the latest blood count", "weight": 2, "met": {"read": "inv-fbc"}, "critical": True},
            {"id": "rb-arms", "domain": "examination", "text": "Examined the arms for lymphoedema", "weight": 2, "met": {"examined": "ex-arms"}}],
 "npcs": [],
 "debrief": {"title": "Nausea during chemotherapy", "conclusion": "Delayed chemotherapy-related nausea with satisfactory counts and the oncology team's support: PC6 and ST36 are reasonable as an adjunct to her antiemetics.",
  "keyReasoning": ["Counts satisfactory; no fever; no lymphoedema."], "teachingPoints": ["Always check the latest blood count during chemotherapy.", "Do not needle a limb with, or at high risk of, lymphoedema.", "Acupuncture is an adjunct: the antiemetics stay."], "references": [], "notice": NOTICE},
 "unknowns": ["Evidence summary for this indication (not yet authored in the pack)"], "assets": [],
 "solution": [{"type": "start"}, {"type": "ask", "itemId": "hx-oncology"}, {"type": "ask", "itemId": "hx-surgery-arm"}, {"type": "order", "investigationId": "inv-fbc"}, {"type": "read", "investigationId": "inv-fbc"}, {"type": "examine", "findingId": "ex-arms"}, {"type": "flag", "flag": "acu.finished"}],
 "extensions": {"acucraft": {"field": "field.json"}},
}

field = {"schema": "acucraft/field@1", "clinic": "sg-tcm-outpatient", "roles": "sg-tcm-clinic", "ruleSeries": RULES,
 "visits": [{"index": 1, "phase": V1, "date": "2026-12-03", "label": "First visit"}, {"index": 2, "phase": FU, "date": "2026-12-12", "label": "Follow-up visit (after the next cycle)"}],
 "cast": cast(),
 "patient": {"id": "patient", "location": "consult-room", "position": "seated", "riskFactors": ["chemotherapy"], "anxiety": 0.3,
  "anatomy": {"fingerCunCm": 1.8, "regions": {"knee-leg": {"both": {"scale": {"u": 0.98, "v": 0.93}}}, "forearm": {"both": {"scale": {"u": 0.95, "v": 0.94}}}}},
  "siteConditions": [], "ashi": [],
  "consent": {"requiredTopics": ["procedure", "risks", "alternatives"], "agree": "Okay, doctor. Thank you.", "questions": "Is it safe with the chemo? Is there anything else I can do instead?"}},
 "regions": ["forearm", "knee-leg"],
 "equipment": {"packs": [{"id": "pack-a", "at": "shelf", "count": 5, "needle": NEEDLE}, {"id": "pack-b", "at": "shelf", "count": 5, "needle": NEEDLE}]},
 "safety": {"guard": "block-critical"}, "events": [],
 "evaluation": {
  "pathways": [
   {"id": "p-treat", "label": "Treat as an adjunct after checking the counts and the oncology team's view", "acceptable": True, "when": {"all": [{"disposition": ["treat", "treat-modified"], "visit": 1}, {"needlesInserted": {"gte": 1}}, {"clinical": {"read": "inv-fbc"}}, {"explained": "alternatives"}, {"not": {"unsafe": "insertion-without-consent"}}, {"visitEnded": 1}]}},
   {"id": "p-defer", "label": "Defer and liaise with the oncology team", "acceptable": True, "when": {"all": [{"disposition": ["defer", "refer", "decline"], "visit": 1}, {"needlesInserted": {"lte": 0}}, {"visitEnded": 1}]}},
   {"id": "p-treat-unchecked", "label": "Needled without checking the blood count", "acceptable": False, "when": {"all": [{"needlesInserted": {"gte": 1}}, {"not": {"clinical": {"read": "inv-fbc"}}}]}}],
  "diagnoses": {"expected": ["chemotherapy-nausea"], "acceptable": []},
  "patterns": {"defensible": ["spleen-stomach-deficiency", "stomach-qi-rebellion"], "implausible": ["liver-yang-rising", "damp-heat-bi"]},
  "redFlags": [{"id": "fever-on-chemotherapy", "present": False}],
  "points": {"recommended": [{"point": "PC6", "side": "right"}, {"point": "PC6", "side": "left"}, {"point": "ST36"}], "acceptable": [{"point": "CV12", "side": "midline"}, {"point": "SP6"}, {"point": "LI4"}], "avoid": [], "maxNeedles": 8},
  "criticalErrors": [],
  "required": {"history": ["hx-nausea", "hx-meds", "hx-oncology", "hx-fever", "hx-bleeding", "hx-surgery-arm"], "exam": ["ex-arms"], "records": ["inv-fbc"]},
  "monitoring": {"maxGapMinutes": 10, "respondWithinMinutes": 2},
  "followUp": {"pathways": [{"id": "fu-review-continue", "label": "Review after the cycle; continue around chemotherapy or stop", "acceptable": True, "when": {"all": [{"clinical": {"asked": "fu-progress"}}, {"clinical": {"asked": "fu-new"}}, {"disposition": ["treat", "treat-modified", "defer"], "visit": 2}, {"visitEnded": 2}]}}]},
  "documentation": ["assessment", "rationale", "pointsUsed", "needling", "response", "followUp"]},
 "solution": [], "alternatives": []}

EXPLAIN = ("I suggest acupuncture alongside — not instead of — your anti-sickness medicines: four fine single-use sterile needles, at the inner wrist and below the knee on each side, for about twenty minutes. "
  "Your blood count is satisfactory and your oncologist is supportive. Risks are small: soreness, bruising, feeling faint, and a small risk of infection, which is why we check your counts. "
  "Alternatives are an acupressure wristband at the same wrist point, small frequent meals, and telling your oncologist if the medicines aren't working. You can tell me to stop at any time.")

def consult(t):
    t.ask("hx-chief", "hx-nausea", "hx-meds", "hx-oncology", "hx-fever", "hx-bleeding", "hx-surgery-arm", "hx-port", "hx-pmh", "hx-acupuncture-before", "hx-tcm", "hx-ice")
    t({"type": "review_result", "investigationId": "inv-onc-letter"})
    t({"type": "review_result", "investigationId": "inv-fbc"})
    t({"type": "move", "to": "treatment-room", "withPatient": True})
    t({"type": "hand_hygiene"})
    t.examine("ex-general", "ex-arms", "ex-legs", "ex-tongue", "ex-pulse-tcm")
    t({"type": "check_vitals"})

def treat(t, pts, prefix_marks, explain=EXPLAIN):
    t({"type": "propose_plan", "plan": {"points": pts, "technique": {"method": "manual-filiform", "stimulation": "even", "retentionMinutes": 20}, "rationale": "PC6 and ST36 for nausea from spleen–stomach deficiency with rebellious stomach qi, as an adjunct to antiemetics.", "alternatives": ["Acupressure wristband at PC6", "Small, frequent meals", "Antiemetic review with her oncologist"], "followUp": "After the next cycle."}})
    t({"type": "explain", "topics": ["procedure", "benefits", "risks", "alternatives", "right-to-stop"], "text": explain})
    t({"type": "seek_consent"})
    t({"type": "position_patient", "position": "supine-knee-flexed"})
    t({"type": "assign_task", "to": "assistant", "kind": "monitor-patient", "params": {"intervalMinutes": 5}, "note": "Please check on Mdm Siti every five minutes while the needles are in."})
    for (target, region, side, method) in prefix_marks:
        key = f"{target['point']}:{side}"
        if region == "forearm": t.landmarks("forearm", side, "pl-fcr-wrist", "cubital-crease-mid")
        else: t.landmarks("knee-leg", side, "st35-depression", "ankle-anterior-midpoint", "lateral-malleolus")
        t.mark(target, region, side, *C[key], method=method)
    t.fetch_pack("pack-a")
    for region, side in sorted({(r, s) for (_, r, s, _) in prefix_marks}):
        t({"type": "prepare_site", "region": region, "side": side})
    t({"type": "open_pack", "packId": "pack-a"})
    depth = {"PC6": 1.0, "ST36": 2.0}
    for i, (target, region, side, _) in enumerate(prefix_marks):
        t.needle(f"pack-a.{i+1}", f"m{i+1}", depth[target["point"]])
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 10})
    t({"type": "monitor"})
    t({"type": "wait", "minutes": 9})
    t({"type": "monitor"})
    t.close_needles("pack-a")
    t({"type": "explain", "topics": ["aftercare"], "text": "Rest a little before you go; keep taking your anti-sickness medicines as prescribed."})

def doc(pts, n):
    return {"type": "document", "record": {"presentingComplaint": "Delayed nausea after chemotherapy cycles.", "assessment": "Chemotherapy-related nausea; counts satisfactory (1 Dec); oncology supportive.", "pattern": "Spleen–stomach deficiency with rebellious stomach qi",
      "rationale": "PC6 and ST36 as an adjunct to antiemetics.", "consent": "Verbal consent after explanation.", "pointsUsed": pts,
      "needling": {"needleType": "0.25 × 40 mm single-use sterile filiform", "needleCount": n, "depth": "PC6 1.0 cm; ST36 2.0 cm", "responseSought": "mild deqi", "stimulation": "even", "retentionMinutes": 20},
      "response": "Tolerated.", "adverseEvents": "None.", "advice": "Continue antiemetics; small frequent meals.", "followUp": "After the next cycle."}}

def follow_up(t):
    t({"type": "begin_follow_up"})
    t.ask("fu-progress", "fu-new")
    t({"type": "decide", "disposition": "treat", "rationale": "Milder nausea this cycle: continue around the last cycle, checking counts first."})
    t({"type": "document", "record": {"assessment": "Nausea milder after cycle 4.", "response": "Eating small meals from day 3.", "adverseEvents": "None.", "followUp": "One more session; check counts first."}})
    t({"type": "end_visit"})
    t({"type": "finish_encounter"})

def assess(t, extra_rationale=""):
    t({"type": "assess", "diagnoses": ["chemotherapy-nausea"], "pattern": "stomach-qi-rebellion", "redFlags": [], "rationale": "Delayed nausea after each cycle; tired, poor appetite, loose stools; pale swollen tongue." + extra_rationale})

MARKS_BOTH = [({"point": "PC6", "side": "right"}, "forearm", "right", "proportional"), ({"point": "PC6", "side": "left"}, "forearm", "left", "proportional"), ({"point": "ST36", "side": "right"}, "knee-leg", "right", "proportional"), ({"point": "ST36", "side": "left"}, "knee-leg", "left", "proportional")]
MARKS_RIGHT_ARM = [m for m in MARKS_BOTH if not (m[1] == "forearm" and m[2] == "left")]
PTS_BOTH = [m[0] for m in MARKS_BOTH]
PTS_RIGHT_ARM = [m[0] for m in MARKS_RIGHT_ARM]

variants = [
 variant("base", "Base case", "base", "Counts satisfactory, oncology supportive, no lymphoedema: PC6 and ST36 on both sides as an adjunct; the forearm and the leg charts in one treatment."),
 variant("lymphoedema", "Left arm lymphoedema", "anatomy", "A local site condition: an axillary clearance on the left and a lymphoedematous left arm. The left forearm is not to be needled; PC6 on the right and ST36 on both sides remain.",
  case={"history": [{"id": "hx-surgery-arm", "answer": "A lumpectomy on the left and they removed all the lymph nodes from my left armpit. My left arm has been swollen since — I wear a compression sleeve."}],
        "exam": [{"id": "ex-arms", "finding": "Left forearm and hand swollen, skin tight (lymphoedema); right arm normal.", "abnormal": True}]},
  field={"patient": {"riskFactors": ["chemotherapy", "lymphoedema"], "siteConditions": [{"id": "lymphoedema-left-arm", "region": "forearm", "side": "left", "kind": "avoid", "label": "lymphoedema of the left arm", "revealedBy": "ex-arms"}]},
   "evaluation": {"points": {"recommended": {"$replace": [{"point": "PC6", "side": "right"}, {"point": "ST36"}]}, "avoid": [{"point": "PC6", "side": "left", "reason": "lymphoedematous arm", "severity": "critical"}]},
    "criticalErrors": [{"id": "ce-lymphoedema", "label": "Needled the lymphoedematous arm", "when": {"unsafe": "insertion-on-avoided-site"}}]}}),
 variant("neutropenic", "Low neutrophils and platelets", "red-flag", "A risk found only in the record: the latest blood count shows neutrophils 0.6 and platelets 48 ×10⁹/L. Acupuncture is deferred and the oncology team contacted; needling is a critical error.",
  case={"investigations": [{"id": "inv-fbc", "results": {p: {"text": "Hb 10.4 g/dL; WBC 1.6 ×10⁹/L; neutrophils 0.6 ×10⁹/L (low); platelets 48 ×10⁹/L (low).", "values": {"$replace": [{"analyte": "Haemoglobin", "value": 10.4, "unit": "g/dL", "refLow": 12, "refHigh": 15.5, "flag": "L"}, {"analyte": "Neutrophils", "value": 0.6, "unit": "×10⁹/L", "refLow": 2.0, "refHigh": 7.5, "flag": "LL"}, {"analyte": "Platelets", "value": 48, "unit": "×10⁹/L", "refLow": 150, "refHigh": 400, "flag": "LL"}]}} for p in [V1, FU]}}],
        "debrief": {"conclusion": "Neutropenia and thrombocytopenia on the latest count: defer acupuncture and contact the oncology team; offer non-invasive measures (acupressure band) meanwhile."}},
  field={"evaluation": {"diagnoses": {"acceptable": ["neutropenia"]}, "pathways": [{"id": "p-treat", "$remove": True},
     {"id": "p-defer", "label": "Defer and liaise with the oncology team", "acceptable": True, "when": {"all": [{"disposition": ["defer", "refer", "decline"], "visit": 1}, {"needlesInserted": {"lte": 0}}, {"referred": {"to": ["oncology"]}}, {"visitEnded": 1}]}},
     {"id": "p-treated-neutropenic", "label": "Needled despite neutropenia and thrombocytopenia", "acceptable": False, "when": {"needlesInserted": {"gte": 1}}}],
    "redFlags": {"$replace": [{"id": "fever-on-chemotherapy", "present": True}]},
    "points": {"$replace": {"recommended": [], "acceptable": [], "avoid": [], "maxNeedles": 1}},
    "criticalErrors": [{"id": "ce-needled-neutropenic", "label": "Needled with neutrophils 0.6 and platelets 48", "when": {"needlesInserted": {"gte": 1}}}],
    "followUp": None}}),
]
fam = family(FID, "Nausea during chemotherapy · 52-year-old woman", "A 52-year-old woman having chemotherapy asks whether acupuncture could help her nausea.", "chemotherapy-nausea", "held-out", [v["id"] for v in variants])
if not C:
    write_family(FID, fam, case, field, variants, {})
    sys.exit(0)

base = Trajectory("cb")
consult(base); assess(base)
base({"type": "decide", "disposition": "treat", "rationale": "Counts satisfactory, no fever or lymphoedema, oncology supportive."})
treat(base, PTS_BOTH, MARKS_BOTH)
base(doc(PTS_BOTH, 4)); base({"type": "end_visit"}); follow_up(base)

ly = Trajectory("cl")
consult(ly); assess(ly, " Left arm lymphoedema after axillary clearance.")
ly({"type": "decide", "disposition": "treat-modified", "rationale": "No needling of the lymphoedematous left arm: PC6 right and ST36 on both sides."})
treat(ly, PTS_RIGHT_ARM, MARKS_RIGHT_ARM, EXPLAIN.replace("four fine single-use sterile needles, at the inner wrist and below the knee on each side", "three fine single-use sterile needles — your right inner wrist and below each knee; none in your left arm because of the lymphoedema"))
ly(doc(PTS_RIGHT_ARM, 3)); ly({"type": "end_visit"}); follow_up(ly)

ne = Trajectory("cn")
consult(ne)
ne({"type": "assess", "diagnoses": ["chemotherapy-nausea", "neutropenia"], "pattern": "spleen-stomach-deficiency", "redFlags": ["fever-on-chemotherapy"], "rationale": "Neutrophils 0.6 and platelets 48 on the latest count: infection and bleeding risk."})
ne({"type": "decide", "disposition": "defer", "rationale": "Defer needling until the counts recover; contact the oncology team."})
ne({"type": "explain", "topics": ["risks", "alternatives"], "text": "Your latest blood test shows low white cells and platelets, so needles would carry a risk of infection and bleeding. Let's not needle today. You could use an acupressure wristband on the inner wrist, eat small frequent meals, and I'll let your oncology team know. If you get a fever, go to the hospital straight away."})
ne({"type": "refer", "to": "oncology", "urgency": "soon", "reason": "Neutrophils 0.6 and platelets 48 ×10⁹/L on 1 Dec; persistent delayed nausea; acupuncture deferred."})
ne({"type": "document", "record": {"presentingComplaint": "Delayed chemotherapy-related nausea.", "assessment": "Neutropenia (0.6) and thrombocytopenia (48) on 1 Dec FBC; acupuncture deferred.", "advice": "Acupressure wristband; small frequent meals; seek urgent care for fever.", "followUp": "Oncology team informed; reconsider once counts recover."}})
ne({"type": "end_visit"}); ne({"type": "finish_encounter"})

write_family(FID, fam, case, field, variants, {"base": base, "lymphoedema": ly, "neutropenic": ne})
