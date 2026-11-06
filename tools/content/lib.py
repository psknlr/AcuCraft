"""Shared helpers for the family authoring scripts in tools/content/ (each writes one family's JSON files).

The JSON they write is the content: the scripts exist so that a family's case, field, variants and reference
trajectories can be regenerated together. Mark coordinates come from `npx tsx tools/locate.ts`.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")

def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")

def family_dir(fid):
    return os.path.join(ROOT, "content", "families", fid)

def H(id, topic, q, a, kw=(), disc="on-ask", req=False, phases=("visit-1",), **extra):
    o = {"id": id, "topic": topic, "question": q, "answer": a, "keywords": list(kw), "disclosure": disc, "required": req, "phases": list(phases)}
    o.update(extra)
    return o

def E(id, system, man, finding, kw=(), abnormal=False, req=False, phases=("visit-1",)):
    return {"id": id, "system": system, "maneuver": man, "keywords": list(kw), "finding": finding, "abnormal": abnormal, "required": req, "phases": list(phases)}

def record(id, name, text, date, aliases=(), values=(), value="useful", phases=("visit-1", "follow-up")):
    return {"id": id, "name": name, "category": "record" if not values else "lab", "aliases": list(aliases), "requires": [], "turnaroundMinutes": 0, "risk": "none", "performedAt": "records", "value": value,
            "results": {p: {"available": True, "date": date, "text": text, "values": list(values), "figures": [], "critical": False} for p in phases}, "availability": {"historical": True}}

def phases(v1_desc, fu_desc):
    return [{"id": "visit-1", "label": "First visit", "description": v1_desc, "learnerSwitchable": False},
            {"id": "follow-up", "label": "Follow-up visit", "description": fu_desc, "learnerSwitchable": False, "enterWhen": {"flag": "acu.visit-2"}}]

VASOVAGAL = [
    {"id": "pe-vasovagal", "when": {"flag": "acu.vasovagal"}, "setVitals": {"hr": 48, "sbp": 82, "dbp": 50}, "severity": "warning", "speaker": "narrator", "message": "The patient has gone pale and sweaty and says they feel faint."},
    {"id": "pe-recovered", "when": {"all": [{"flag": "acu.vasovagal"}, {"flag": "acu.lying"}, {"not": {"flag": "acu.needles-in"}}]}, "setVitals": {"hr": 70, "sbp": 116, "dbp": 72}, "severity": "info", "speaker": "narrator", "message": "Lying flat with the needles out, the patient's colour is returning."},
]

def provenance(guidelines, notes="AI-assisted authoring; not reviewed by a TCM practitioner or a clinician. Review before teaching use."):
    return {"kind": "synthetic", "authors": ["AcuCraft content team"], "license": "MIT", "notes": "A fictional teaching case. The name and every detail are invented.",
            "review": {"status": "unreviewed", "reviewers": [], "guidelines": guidelines, "notes": notes}}

NOTICE = "Teaching-script measure, not a validated competency score."
NEEDLE = {"diameterMm": 0.25, "lengthMm": 40, "singleUse": True, "sterile": True}
NEEDLE_SHORT = {"diameterMm": 0.25, "lengthMm": 25, "singleUse": True, "sterile": True}

def cast(practitioner_location="consult-room"):
    return [{"id": "practitioner", "role": "tcm-physician", "name": "TCM physician (you)", "agent": "under-test", "location": practitioner_location},
            {"id": "assistant", "role": "clinic-assistant", "name": "Ms Nur Aisyah (clinic assistant)", "agent": "npc", "policy": "support-default", "location": "treatment-room"}]

RULES = ["sg-tcmpb-acupuncture-advisory", "acucraft-sg-clinic-protocol", "sg-tcmpb-acupuncture-treatment-methods"]

def family(fid, title, summary, condition, split, variants):
    return {"schema": "acucraft/family@1", "id": fid, "version": "0.1.0", "title": title, "summary": summary, "condition": condition, "split": split,
            "provenance": {"kind": "synthetic", "authors": ["AcuCraft content team"], "review": {"status": "unreviewed", "reviewers": [], "notes": "Clinical, anatomical and regulatory content to be reviewed by TCM, anatomy and Singapore practice experts."}},
            "case": "case.json", "field": "field.json", "variants": [{"id": v} for v in variants]}

def variant(id, title, kind, purpose, case=None, field=None):
    o = {"schema": "acucraft/variant@1", "id": id, "title": title, "kind": kind, "purpose": purpose}
    if case: o["case"] = case
    if field: o["field"] = field
    return o

class Trajectory:
    """A reference trajectory: practitioner requests with stable ids."""
    def __init__(self, prefix):
        self.steps, self.prefix = [], prefix
    def __call__(self, action, actor="practitioner"):
        self.steps.append({"requestId": f"{self.prefix}-{len(self.steps)+1:03d}", "actor": actor, "patient": "patient", "action": action})
        return self
    def ask(self, *ids):
        for i in ids: self({"type": "ask", "itemId": i})
    def examine(self, *ids):
        for i in ids: self({"type": "examine", "findingId": i})
    def landmarks(self, region, side, *ids):
        for i in ids: self({"type": "identify_landmark", "region": region, "side": side, "landmark": i})
    def mark(self, target, region, side, u, v, method="proportional"):
        self({"type": "mark_point", "target": target, "region": region, "side": side, "at": {"u": u, "v": v}, "method": method})
    def needle(self, nid, mark, depth, angle=0, azimuth=0):
        self({"type": "pick_up", "object": nid})
        self({"type": "insert_needle", "needleId": nid, "mark": mark, "angleDeg": angle, "azimuthDeg": azimuth, "depthCm": depth})
    def fetch_pack(self, pack):
        self({"type": "move", "to": "prep-area"})
        self({"type": "hand_hygiene"})
        self({"type": "fetch", "item": pack})
        self({"type": "move", "to": "treatment-room"})
    def close_needles(self, pack, pressure=()):
        self({"type": "remove_all_needles"})
        for n in pressure: self({"type": "apply_pressure", "needleId": n})
        self({"type": "dispose", "object": pack})
        self({"type": "hand_hygiene"})
        self({"type": "count_needles"})

def write_family(fid, fam, case, field, variants, solutions):
    d = family_dir(fid)
    dump(os.path.join(d, "family.json"), fam)
    dump(os.path.join(d, "case.json"), case)
    dump(os.path.join(d, "field.json"), field)
    for v in variants: dump(os.path.join(d, "variants", f"{v['id']}.json"), v)
    for name, t in solutions.items(): dump(os.path.join(d, "solutions", f"{name}.json"), t.steps)
    print(fid, {k: len(t.steps) for k, t in solutions.items()})
