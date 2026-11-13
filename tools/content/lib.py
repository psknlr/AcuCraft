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

# ---------------------------------------------------------------------------------------------------------
# Reference trajectories
# ---------------------------------------------------------------------------------------------------------

BODY_MAP = json.load(open(os.path.join(ROOT, "content", "regions", "body-map.json")))["regions"]
# where the clinic's fixtures are (content/sg/clinic.json, written by clinic_world.py)
SINKS = {"consult-room": "consult-sink", "treatment-room": "treat-sink", "prep-area": "prep-sink", "reception": "reception-hand-rub"}
ROOM_OF = {"consult-sink": "consult-room", "consult-terminal": "consult-room", "consult-chair": "consult-room", "treat-sink": "treatment-room", "trolley-1": "treatment-room",
           "sharps-1": "treatment-room", "couch-1": "treatment-room", "treat-chair": "treatment-room", "prep-sink": "prep-area", "shelf": "prep-area", "sharps-prep": "prep-area", "worktop": "prep-area"}
TROLLEY, SHARPS, SHELF = "trolley-1", "sharps-1", "shelf"
# regions whose standing spots beside the couch are within reach of the needle trolley at its foot (replaying a
# trajectory checks this: an act out of reach is refused)
NEAR_TROLLEY = {"knee-leg", "foot", "sole"}
LYING = {"supine", "supine-knee-flexed", "prone", "side-lying-left", "side-lying-right"}

# what each action needs of where the practitioner stands (docs/WORLD.md)
TALK = {"ask", "explain", "seek_consent"}
CONTACT = {"examine", "check_vitals", "position_patient", "search", "remove_all_needles"}
SITE = {"identify_landmark", "measure", "mark_point", "prepare_site"}
NEEDLE_SITE = {"adjust_needle", "remove_needle", "apply_pressure"}

class Trajectory:
    """A reference trajectory: practitioner requests with stable ids.

    The practitioner has a body: an act is refused unless they stand where it can be done. The helper keeps track of
    where they stand and walks them there first (`move`), so a family script says what is done and the walking
    follows: to the sink before hand hygiene, to the patient's side to examine, to the side of the couch a point is
    on to mark and needle it, to the shelf for a pack, to the trolley for a needle. Needles asked for one after
    another are picked up together at the trolley and put in side by side, left then right, to save walking round
    the couch.
    """
    def __init__(self, prefix):
        self._steps, self.prefix = [], prefix
        self._pending = []          # needles waiting to be picked up and inserted: (needle, mark, depth, angle, azimuth)
        self._start_visit()
        self.marks = {}             # mark id → (region, side)
        self.mark_ids = {}          # "ST36:right" / "ashi:<id>" → mark id
        self.needles_at = {}        # needle id → (region, side)
        self.trays = {}             # pack id → fixture its tray is on

    def _start_visit(self):
        self.room, self.where, self.patient_room, self.lying = "consult-room", ("patient",), "consult-room", False

    # ---- raw requests -------------------------------------------------------------------------------------
    @property
    def steps(self):
        self._flush()
        return self._steps

    def _emit(self, action, actor="practitioner"):
        self._steps.append({"requestId": f"{self.prefix}-{len(self._steps)+1:03d}", "actor": actor, "patient": "patient", "action": action})

    def __call__(self, action, actor="practitioner"):
        self._flush()
        if actor == "practitioner": self._place(action)
        self._emit(action, actor)
        if actor == "practitioner": self._after(action)
        return self

    # ---- where the practitioner stands --------------------------------------------------------------------
    def _site_token(self, region, side):
        if not self.lying: return ("patient",)                       # seated or standing: every site is at the body
        return ("site", region, side)

    def _go(self, to, token, room):
        if self.where == token: return
        self._emit({"type": "move", "to": to})
        self.where, self.room = token, room

    def at_patient(self):
        if self.where[0] in ("patient", "site") and self.room == self.patient_room: return
        self._go({"person": "patient"}, ("patient",), self.patient_room)

    def at_site(self, region, side):
        token = self._site_token(region, side)
        if token == ("patient",): return self.at_patient()
        self._go({"region": region, "side": side}, token, self.patient_room)

    def at_fixture(self, fixture):
        if fixture in (TROLLEY, SHARPS) and self.where[0] == "site" and self.where[1] in NEAR_TROLLEY: return
        if fixture in (TROLLEY, SHARPS) and self.where in (("fixture", TROLLEY), ("fixture", SHARPS)): return
        self._go({"fixture": fixture}, ("fixture", fixture), ROOM_OF[fixture])

    def _place(self, a):
        t = a["type"]
        if t in TALK: self.at_patient()
        elif t in CONTACT: self.at_patient()
        elif t in SITE: self.at_site(a["region"], a["side"])
        elif t in NEEDLE_SITE: self.at_site(*self.needles_at[a["needleId"]])
        elif t == "insert_needle": self.at_site(*self.marks[a["mark"]])
        elif t == "hand_hygiene":
            if not (self.where[0] == "fixture" and self.where[1] == SINKS[self.room]): self.at_fixture(SINKS[self.room])
        elif t == "fetch": self.at_fixture(SHELF)
        elif t == "open_pack": self.at_fixture(TROLLEY)
        elif t == "pick_up": self.at_fixture(self.trays[a["object"].rsplit(".", 1)[0]])
        elif t == "dispose": self.at_fixture(SHARPS)

    def _after(self, a):
        t = a["type"]
        if t == "move":
            to = a["to"]
            if a.get("withPatient"):
                self.room = self.patient_room = to if isinstance(to, str) else to["room"]
                self.where, self.lying = ("patient",), False
            elif isinstance(to, str) or "room" in to: self.room, self.where = (to if isinstance(to, str) else to["room"]), ("room",)
        elif t == "position_patient":
            # the patient moves (onto the couch, or sits up): sites are somewhere else now. A refused position changes
            # nothing, and the script positions again
            self.lying = a["position"] in LYING
            self.where = ("patient",) if not self.lying else ("room",)
        elif t == "mark_point":
            mid = f"m{len(self.marks)+1}"
            self.marks[mid] = (a["region"], a["side"])
            key = f"ashi:{a['target']['ashi']}" if "ashi" in a["target"] else f"{a['target']['point']}:{a['target']['side']}"
            self.mark_ids[key] = mid
        elif t == "insert_needle": self.needles_at[a["needleId"]] = self.marks[a["mark"]]
        elif t == "open_pack": self.trays[a["packId"]] = TROLLEY
        elif t == "remove_all_needles":
            # the compound action walks from needle to needle in the order they went in: it ends at the last one
            last = list(self.needles_at.values())[-1] if self.needles_at else None
            self.where = self._site_token(*last) if last else ("room",)
        elif t == "begin_follow_up":
            self._start_visit()
            self.marks, self.mark_ids = dict(self.marks), dict(self.mark_ids)

    # ---- helpers ------------------------------------------------------------------------------------------
    def ask(self, *ids):
        for i in ids: self({"type": "ask", "itemId": i})
    def examine(self, *ids):
        for i in ids: self({"type": "examine", "findingId": i})
    def landmarks(self, region, side, *ids):
        for i in ids: self({"type": "identify_landmark", "region": region, "side": side, "landmark": i})
    def mark(self, target, region, side, u, v, method="proportional"):
        self({"type": "mark_point", "target": target, "region": region, "side": side, "at": {"u": u, "v": v}, "method": method})
    def mark_id(self, key):
        return self.mark_ids[key]
    def needle(self, nid, mark, depth, angle=0, azimuth=0):
        """Queue a needle: the batch is picked up at the trolley and inserted site by site (see `_flush`)."""
        self._pending.append((nid, mark, depth, angle, azimuth))
    def _flush(self):
        batch, self._pending = self._pending, []
        if not batch: return
        insert = lambda n: {"type": "insert_needle", "needleId": n[0], "mark": n[1], "angleDeg": n[3], "azimuthDeg": n[4], "depthCm": n[2]}
        tokens = [self._site_token(*self.marks[n[1]]) for n in batch]
        if all(tok == ("patient",) or (tok[0] == "site" and tok[1] in NEAR_TROLLEY) for tok in tokens) and len(set(tokens)) == 1 and tokens[0] != ("patient",):
            # the trolley is within reach of where these go in: one needle at a time
            self.at_site(*self.marks[batch[0][1]])
            for n in batch:
                self._emit({"type": "pick_up", "object": n[0]})
                self._emit(insert(n))
                self.needles_at[n[0]] = self.marks[n[1]]
            return
        # pick the batch up at the trolley, then put the needles in site by site: one side of the couch, then the other
        self.at_fixture(TROLLEY)
        for n in batch: self._emit({"type": "pick_up", "object": n[0]})
        # a site near the midline is reached from either side of the couch: it goes with whichever side comes first
        side_of = lambda tok: (tok[2] if BODY_MAP[tok[1]]["lateral"] > 0.05 else "*") if tok[0] == "site" else "*"
        order, sides = [], []
        for n, tok in zip(batch, tokens):
            if side_of(tok) not in sides: sides.append(side_of(tok))
        for side in sides:
            for n, tok in zip(batch, tokens):
                if side_of(tok) == side: order.append(n)
        for n in order:
            self.at_site(*self.marks[n[1]])
            self._emit(insert(n))
            self.needles_at[n[0]] = self.marks[n[1]]
    def fetch_pack(self, *packs):
        """Clean hands and the sealed packs from the shelf in the preparation area."""
        self.at_fixture(SINKS["prep-area"])
        self({"type": "hand_hygiene"})
        for p in packs: self({"type": "fetch", "item": p})
    def close_needles(self, *packs, pressure=()):
        self({"type": "remove_all_needles"})
        for n in pressure: self({"type": "apply_pressure", "needleId": n})
        for p in packs: self({"type": "dispose", "object": p})
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
    if solutions: prune_moves(fid)

def prune_moves(fid):
    """Drop the walks that cover no ground (the helper cannot see the floor plan): tools/prune-moves.ts replays each
    trajectory on the engine and rewrites the solution files."""
    import subprocess
    subprocess.run(["npx", "tsx", "tools/prune-moves.ts", fid], check=True, cwd=ROOT)
