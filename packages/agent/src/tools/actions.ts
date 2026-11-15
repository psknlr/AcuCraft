import { ActionSchema, type ActionInput, type ActionType } from "@acucraft/core";
import type { z, ZodTypeAny } from "zod";
import { objectSchemaOf, type FieldNotes } from "./schema.js";
import type { ActionTool } from "./types.js";

/**
 * The action interface as tools: one tool per action type, named after it, its input the action without `type`.
 * Schemas come from the engine's zod schemas (`ActionSchema`); the descriptions say what the act is for, what it
 * needs within reach (docs/WORLD.md) and what it leaves on the record — what a practitioner new to this clinic would
 * be told, no more: nothing here depends on a scenario.
 */

interface ActionDoc {
  does: string;
  fields?: FieldNotes;
}

const POINT_TARGET = "A standard point with its side ({ point, side }; a group point also names one `site`), or an Ashi point found on examination ({ ashi }).";
const CHART_AT = "Chart position in centimetres: u across the body, v along it (cranial positive).";

export const ACTION_DOCS: Record<ActionType, ActionDoc> = {
  /* communication and consultation */
  say: {
    does: "Say something aloud, to the patient (default) or to a colleague (`to`: their id): reassurance, instructions, anything that is not a history question, the explanation of a plan or a task. Speech changes nothing by itself. A commitment you voice is recorded as your task, and a claim that something is done is checked against the state. The patient hears only within earshot.",
  },
  ask: {
    does: "Ask the patient one focused history question in your own words (one or two things at a time). The answer enters record.history under an id you can cite as evidence. Within earshot of the patient. What the patient has no answer to stays unknown: it is not normal, and nothing is invented.",
    fields: { itemId: "A history item id you already know; otherwise leave it out and use text.", text: "The question, as you would say it." },
  },
  observe: {
    does: "Look at the patient: general appearance, colour, distress, posture, what is visible at the needles. Needs the patient in view. What you see enters the record as evidence.",
  },
  examine: {
    does: "Carry out one examination, described in words (\"palpate the lumbar paraspinal muscles\", \"inspect the tongue\", \"feel the radial pulses\"). At the patient's side. The finding enters record.examination under an id; an examination may also reveal tender (Ashi) points and skin conditions at a site, which then appear in the record.",
    fields: { findingId: "An examination finding id you already know; otherwise leave it out and use text.", text: "The manoeuvre, in words." },
  },
  review_result: {
    does: "Read a report or record that already exists for this patient (an X-ray report, a blood count, an INR, a letter, the clinic notes), found by a few words. At a records terminal, or with the patient for the reports they brought. What is not provided or not modelled is reported as such.",
    fields: { query: "A few words naming the report (\"INR\", \"x-ray report\", \"blood count\")." },
  },
  order_investigation: {
    does: "Order a new investigation. Only for a role that may order it here: where your role may not, refer instead.",
  },
  check_vitals: {
    does: "Measure the vital signs (pulse, blood pressure and the rest). At the patient's side; takes a few simulated minutes. Use it at baseline when it matters and after any reaction.",
  },

  /* decision and consent */
  assess: {
    does: "Record your assessment by vocabulary ids (lookup vocabulary): biomedical diagnoses, the TCM pattern, any red flags. A pattern must name `patternEvidence`: ids of findings already in your record. It is judged on what those findings show (lookup pattern), not on its name. Assess again when findings change your mind: the latest assessment is the one on record.",
    fields: { patternEvidence: "Ids from record (history, examination, results, vitals, observations) that the pattern rests on. Only what you obtained can be named.", redFlags: "Red-flag ids you recognise in this patient; none when you screened and found none." },
  },
  decide: {
    does: "Record the clinical decision for this visit. Treatment, a modified treatment (adapted to a risk factor or a site to avoid), further assessment, deferral, referral and declining are all valid outcomes when the findings support them.",
  },
  propose_plan: {
    does: "Set the treatment plan: points, technique and retention, rationale, the alternatives, the follow-up. A new plan replaces the old one. The patient's consent covers the version they agreed to: more points, a longer retention, another method or a stronger stimulation need explaining and consent again.",
    fields: {
      "plan.points": "The points to needle. Standard points take a side (midline points: midline); a group point is planned site by site.",
      "plan.technique.retentionMinutes": "How long the needles stay in, in minutes.",
      "plan.technique.stimulation": "none (the needles are not worked), even, reducing or reinforcing.",
      "plan.alternatives": "The other options you will put to the patient.",
    },
  },
  explain: {
    does: "Explain to the patient, in words they can follow: the procedure, the benefits, the risks, the alternatives, what the evidence says, aftercare, the right to stop at any time. Only what you actually say (`text`) is explained. `topics` only index what those words cover. Within earshot.",
    fields: { text: "What you say to the patient.", topics: "The topics your words cover." },
  },
  seek_consent: {
    does: "Ask the patient whether they agree to the current plan. They answer for themselves: they agree, ask questions first, or decline, and they may withdraw later. Needs a plan, and an explanation of what they need to know. Within earshot.",
  },
  refer: {
    does: "Refer the patient to one of the clinic's referral targets (lookup clinic), with the urgency and the reason. This is the act for a red flag. It does not end the visit: tell the patient, document, then end the visit.",
  },

  /* localisation */
  position_patient: {
    does: "Help the patient into a position. At their side. The position decides which regions can be reached and the configuration each chart is in, so skin marks made in another configuration go stale and must be redone. A patient may decline a position. Do not reposition with needles in place, except to lay flat someone who is fainting.",
  },
  identify_landmark: {
    does: "Palpate one landmark of a regional chart on this patient as they lie now: returns its position on the chart in centimetres. The body site within arm's reach. The landmarks of a chart, and how each is found, are in lookup region.",
  },
  measure: {
    does: "Measure on this patient: one proportional segment of a region with a tape (cm; one B-cun there is that length divided by the segment's cun), or with `fingerCun` the patient's own finger cun. The body site within arm's reach.",
    fields: { segment: "A segment id of the region's chart (lookup region).", fingerCun: "true to measure the patient's finger cun instead of a segment." },
  },
  mark_point: {
    does: "Mark on the skin where you will needle: the target, the chart position you constructed for it and how you found it. A needle is then inserted at the mark. The body site within arm's reach. Marking touches the skin: clean the site after marking, not before.",
    fields: { target: POINT_TARGET, at: CHART_AT, method: "proportional (bone measurement), finger-cun, landmark (the point is at a landmark) or palpation (an Ashi point)." },
  },

  /* preparation */
  move: {
    does: "Walk. `to` is a room id, or { fixture } (to where it can be used), { person } (a colleague's id, or \"patient\"), { region, side, within? } (to where that body site is within the requested distance as the patient lies now: a site on the far side of the couch means walking round it) or { x, z }. A body site's optional within is 0.3 to 0.85 metres on the floor plan; omitting it preserves the ordinary 0.85 m reach. Ask for a smaller distance, such as 0.75, when the 3D hand needs a closer stance. The existing collision planner may refuse when no free spot meets that distance; it never moves you through furniture. With a room and `withPatient: true` the patient walks there at your side and takes its seat. Walking takes simulated time, and nothing else walks for you: an act out of reach is refused, and the refusal names this walk.",
    fields: { withPatient: "true to walk the patient to a room with you. They must be able to walk: not faint, no needles in.", "to.within": "Optional maximum floor-plan distance to a region/side target in metres, finite 0.3 to 0.85. Default 0.85 preserves legacy moves. It is not a clinical or hand-specific reach measurement. The collision planner refuses when no free visible spot is close enough." },
  },
  hand_hygiene: {
    does: "Clean your hands at a sink or hand-rub dispenser within reach: before handling sterile needles or prepared skin, and after contact with the patient or with used needles. Not possible while you hold needles.",
  },
  fetch: {
    does: "Take a sealed needle pack or a supply from the fixture it is kept on (lookup clinic: supplies; packs are listed in view equipment), that fixture within reach.",
  },
  handover: {
    does: "Hand something you hold to a colleague within reach who may handle equipment.",
  },
  open_pack: {
    does: "Open a sealed pack you hold onto a needle trolley or worktop within reach: its needles then lie on that tray. Read its label first (view equipment: size, sterility, an expired label).",
  },
  pick_up: {
    does: "Take one needle from the tray of the trolley within reach, or pick up a needle that was found on the floor, the couch or the clothing.",
  },
  prepare_site: {
    does: "Clean the skin of a region and side with an alcohol swab, once the marks are made. The body site within arm's reach. Whatever touches that skin afterwards (palpating, measuring, marking) undoes it.",
  },
  prepare_couch: {
    does: "Clean the couch and put on fresh linen, from beside it, when nobody is lying on it.",
  },

  /* procedure */
  insert_needle: {
    does: "Insert the needle you hold: at a mark, or at explicit chart coordinates with the target they are meant for. Needs the site within arm's reach, the patient's consent to the current plan, clean hands and prepared skin. Choose angle, direction and depth for this patient's build and for what lies beneath: the simulation guard stops a path that would reach a critical structure, and a stopped attempt stays on the record.",
    fields: {
      mark: "The id of a mark made with mark_point (the usual way).",
      target: `Without a mark: ${POINT_TARGET}`,
      at: `Without a mark: ${CHART_AT}`,
      angleDeg: "0 is perpendicular to the skin, 45 oblique, 75 to 90 transverse.",
      azimuthDeg: "The direction the tip travels across the chart: 0 cranial (+v), 90 towards +u, 180 caudal, 270 towards -u.",
      depthCm: "Depth along the shaft, in centimetres.",
      presentation: "Optional 3D insertion choreography: duration, grip, supporting hand and needle-holding hand. These settings never alter the permitted needle path, depth, consent or clinical response.",
      "presentation.durationMs": "Insertion movement duration in milliseconds, 400 to 8000.",
      "presentation.grip": "Default two-finger holding uses the thumb and index. Explicit three-finger holding retains the thumb-index pinch and adds middle-finger support.",
      "presentation.support": "Illustrative supporting-hand pose: none, stabilize, stretch, pinch or press.",
      "presentation.hand": "auto chooses the closer hand; left or right requests the named hand.",
      "presentation.gripApertureMm": "Approach/release opening in millimetres, 0 to 12, with minimum clearance when letting go. Engaged fingers fit the actual rendered handle; this is not contact force.",
    },
  },
  adjust_needle: {
    fields: {
      technique: "none, lift-thrust or rotate for parameterized needle movement. Legacy lift, thrust, twist, bu and xie remain supported; bu/xie are illustrative labels without a therapeutic efficacy model.",
      strokeMm: "Total peak-to-peak axial excursion in mm; lift-thrust only. The full excursion is checked against anatomy.",
      rotationDeg: "Peak angular displacement in degrees for alternating turns, degrees per cycle for one-way turns; rotate only.",
      frequencyHz: "Cycles per second, not a clinical recommendation.",
      durationSeconds: "Duration in seconds of simulated time.",
      depthCm: "Depth along the shaft from skin entry in cm. Decrease to lift, increase to thrust. Angles are fixed while inserted; withdraw before redirecting.",
      motion: "Legacy presentation-only settings: cycles, durationMs, outward strokeMm and rotationDeg. These do not change the executed depth or clinical response. Use top-level parameters for an anatomy-checked clinical motion envelope.",
    },
    does: "Work a needle in place, or change its depth: lift and thrust, rotate, or re-seat it deeper or shallower. What you then feel in the needle is evidence of its response. Stronger stimulation is never the aim: a tip that lies too shallow is not helped by working it harder, and a sharp, burning or electric sensation means withdraw a little or take the needle out.",
  },
  perform_technique: {
    does: "Perform one illustrative 3D manipulation, using the same bounded parameters as the operator panel. Read lookup techniques for all 24 basic terms, 10 compound demonstrations and bu/xie, source status, contexts, defaults and bounds. This records choreography; it does not insert, withdraw, deepen a needle, measure force, produce clinical evidence or change therapeutic effects. Retained maneuvers require an inserted needle; post-removal maneuvers require a needle withdrawn in this visit; skin maneuvers use a current mark, a needle's executed site, or explicit chart coordinates. Treatment gestures need current consent and a well patient; post-removal covering follows aftercare permissions and may still be demonstrated after treatment stops. Every gesture needs permission and the actual body site within reach. Skin contact affects preparation and hand hygiene; follow the engine's returned conditions.",
    fields: {
      technique: "Stable technique id from lookup techniques, such as nian, ti, gua, an, men, shao-shan-huo, bu or xie. Definitions are authored illustrative variants rather than verified clinical standards.",
      needleId: "Required for retained or post-removal techniques. May anchor a skin gesture to a needle's executed site in this visit.",
      mark: "A current non-stale mark for a skin gesture. Omit conflicting targets when needleId determines the site.",
      region: "Without mark or needleId, name a regional model and give side and at.",
      at: CHART_AT,
      motion: "Optional bounded presentation settings shared with the operator controls. Use lookup techniques for units and per-technique defaults. Contact intensity is cosmetic and is never a force measurement or clinical dose.",
      "motion.cycles": "Displayed cycles within each primitive phase, 1 to 12. A compound's total duration spans all phases.",
      "motion.durationMs": "Total performance duration in milliseconds, 400 to 30000, spanning every compound phase. Presentation time does not advance the clinical clock.",
      "motion.grip": "Default two-finger holding uses the thumb and index. For techniques offering grip selection, three-finger explicitly adds middle-finger support without replacing the thumb-index pair. Gua/Tan keep thumb-index holding and use the middle nail as the active finger.",
      "motion.gripApertureMm": "Approach/release opening in millimetres, 0 to 12. A held grip fits the actual handle; letting go retains minimum clearance even at zero. This cannot make the fingers float apart during a held manipulation.",
    },
  },
  check_sensation: {
    does: "Ask the patient what they feel at one needle. Their answer is evidence of that needle's response. Within earshot.",
  },
  monitor: {
    does: "Check on the patient and on every needle in place: how they are, what they report, which needles are actually there. Needs the patient in view. Someone must do this at intervals while needles are retained: you, or a colleague through a monitor-patient task.",
  },
  wait: {
    does: "Let simulated minutes pass: the retention time, or while a colleague works.",
  },
  stop_treatment: {
    does: "Stop the treatment at once, giving the reason: the patient asks, withdraws consent, or is unwell. Then take the needles out.",
  },

  /* completion */
  remove_needle: {
    does: "Withdraw one needle, the site within arm's reach. It is then in your hand: it goes straight into a sharps container.",
  },
  remove_all_needles: {
    does: "Withdraw every needle in place, one after another, walking round the couch as needed. If something interrupts it, the needles already out stay out and the rest are still in.",
  },
  apply_pressure: {
    does: "Press on the site of a needle that has been withdrawn (bleeding; a patient who bruises or bleeds easily).",
  },
  count_needles: {
    does: "Count the needles: opened, in the patient, in hand, on the tray, in the sharps container. Only a count made where the needles are reconciles them: in the patient's room with the patient in sight while any needle is in place, and in the room of every tray that holds opened needles. Count before a visit ends.",
  },
  dispose: {
    does: "Put needles into a sharps container within reach: a needle you hold (its id), or a pack id for the opened, unused needles still on its tray. Every opened needle ends there or has its loss reported.",
  },
  search: {
    does: "Search one place for a missing needle.",
  },
  report_incident: {
    does: "Report an incident: a needle lost (after searching for it) or broken, a needlestick, an adverse event or a near miss.",
  },
  document: {
    does: "Write the record of this visit. For a treated visit `needling.responses` states the response at every needle: deqi or none, each naming evidence of that needle (what the patient said they felt there, what you felt on working it), or not-sought. Record only what you observed. The record should agree with what was done: points, needle count, adverse events.",
    fields: {
      "record.pointsUsed": "The points actually needled.",
      "record.needling.responses": "One entry for each needle inserted in this visit.",
      "record.needling.responses[].evidence": "Ids of that needle's own evidence (view needling); none for not-sought.",
    },
  },
  end_visit: {
    does: "End the current visit. Every needle must be out and accounted for (in a sharps container, or its loss reported after a search), and the rules in force at the end of a visit met: the count, the record, the observation of the patient.",
  },
  begin_follow_up: {
    does: "Begin the follow-up visit, when the encounter has one and the current visit has ended.",
  },
  finish_encounter: {
    does: "Finish the encounter, once the current visit has ended and no further visit is to be held.",
  },

  /* team */
  assign_task: {
    does: "Ask a colleague to do something they are allowed to: monitor-patient (params.intervalMinutes), position-patient (params.position), fetch (params.item), count-needles, dispose-sharps, record-vitals, chaperone, prepare-couch. They acknowledge, do it and report back; a task is complete only when the state shows it was done.",
    fields: { to: "The colleague's id (view team).", params: "What the task needs: intervalMinutes, position or item.", note: "What you say to them." },
  },
  acknowledge_task: { does: "Accept a task a colleague assigned to you." },
  decline_task: { does: "Decline a task assigned to you, giving the reason." },
  report_task: { does: "Report a task assigned to you as done, with what you found. It is checked against the state." },
  cancel_task: { does: "Cancel a task you assigned, when it is no longer needed." },
  approve_plan: { does: "Approve the current treatment plan, as the supervisor of a learner." },
};

/** The zod object of one action type. */
function optionOf(type: ActionType): z.ZodObject<z.ZodRawShape> {
  const found = ActionSchema.options.find((o) => (o.shape as Record<string, ZodTypeAny>).type!._def.value === type);
  if (!found) throw new Error(`no action ${type}`);
  return found as unknown as z.ZodObject<z.ZodRawShape>;
}

/** Every action type, in the order of the action interface. */
export const ACTION_TYPES: readonly ActionType[] = ActionSchema.options.map((o) => (o.shape as Record<string, ZodTypeAny>).type!._def.value as ActionType);

/** What went wrong with an input, in words a model can act on. */
function problems(error: z.ZodError): string {
  const lines: string[] = [];
  const walk = (issues: z.ZodIssue[]) => {
    for (const issue of issues) {
      // a union lists what each alternative wanted: the first alternative's complaints say enough
      if (issue.code === "invalid_union") walk(issue.unionErrors[0]?.issues ?? []);
      else lines.push(`${issue.path.filter((p) => p !== "type").join(".") || "input"}: ${issue.message}`);
    }
  };
  walk(error.issues);
  return [...new Set(lines)].slice(0, 6).join("; ");
}

/** The tool of one action type. */
export function actionTool(type: ActionType): ActionTool {
  const doc = ACTION_DOCS[type];
  return {
    kind: "act",
    name: type,
    description: doc.does,
    inputSchema: objectSchemaOf(optionOf(type), doc.fields ?? {}, "", ["type"]),
    toAction(input) {
      const fields = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const parsed = ActionSchema.safeParse({ ...fields, type });
      if (!parsed.success) return { ok: false, error: `Not a valid ${type}: ${problems(parsed.error)}. Nothing was done.` };
      // the input as given (the engine applies its own defaults): what the log records is what was asked
      return { ok: true, action: { ...fields, type } as ActionInput };
    },
  };
}

/** The tools of the actions a role may take (`view.you.may`), in the order of the action interface. */
export function actionTools(may: readonly string[]): ActionTool[] {
  return ACTION_TYPES.filter((t) => may.includes(t)).map(actionTool);
}
