import { ActionSchema } from "@acucraft/core";
import { z, type ZodTypeAny } from "zod";

/**
 * The action interface as data: every action the engine accepts, with its fields, their types, ranges and defaults,
 * read from the zod schemas (so a form built from it — and a language model told about it — can never offer what the
 * engine would not accept, nor miss what it does). The studio client builds its forms from this; the HTTP and MCP
 * interfaces serve it to a model.
 */

export type FieldSpec =
  | { kind: "string"; max?: number }
  | { kind: "number"; min?: number; max?: number; int?: boolean }
  | { kind: "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; of: FieldSpec; max?: number }
  | { kind: "object"; fields: FieldEntry[] }
  | { kind: "union"; options: FieldSpec[] }
  | { kind: "record" }
  | { kind: "unknown" };

export interface FieldEntry {
  name: string;
  optional: boolean;
  /** The value the engine takes when the field is left out. */
  default?: unknown;
  spec: FieldSpec;
}

export const ACTION_GROUPS = ["consultation", "decision", "localisation", "preparation", "procedure", "completion", "team"] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface ActionSpec {
  type: string;
  group: ActionGroup;
  title: string;
  /** One line: what the act is and what it needs. */
  summary: string;
  fields: FieldEntry[];
}

function spec(t: ZodTypeAny): FieldSpec {
  if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) return spec(t.unwrap());
  if (t instanceof z.ZodDefault) return spec(t._def.innerType);
  if (t instanceof z.ZodLazy) return spec(t.schema);
  if (t instanceof z.ZodEffects) return spec(t.innerType());
  if (t instanceof z.ZodLiteral) return { kind: "literal", value: t.value as string | number | boolean };
  if (t instanceof z.ZodEnum) return { kind: "enum", options: [...(t.options as string[])] };
  if (t instanceof z.ZodString) {
    const max = t._def.checks.find((c) => c.kind === "max");
    return { kind: "string", ...(max && "value" in max ? { max: max.value } : {}) };
  }
  if (t instanceof z.ZodNumber) {
    const out: Extract<FieldSpec, { kind: "number" }> = { kind: "number" };
    for (const c of t._def.checks) {
      if (c.kind === "min") out.min = c.inclusive ? c.value : c.value + Number.EPSILON;
      else if (c.kind === "max") out.max = c.value;
      else if (c.kind === "int") out.int = true;
    }
    // "positive" is an exclusive minimum of 0: a form starts just above it
    if (out.min !== undefined && out.min > 0 && out.min < 1e-9) out.min = 0.1;
    return out;
  }
  if (t instanceof z.ZodBoolean) return { kind: "boolean" };
  if (t instanceof z.ZodArray) return { kind: "array", of: spec(t.element), ...(t._def.maxLength ? { max: t._def.maxLength.value } : {}) };
  if (t instanceof z.ZodRecord) return { kind: "record" };
  if (t instanceof z.ZodUnion) return { kind: "union", options: (t.options as ZodTypeAny[]).map(spec) };
  if (t instanceof z.ZodObject) return { kind: "object", fields: fieldsOf(t.shape as Record<string, ZodTypeAny>) };
  return { kind: "unknown" };
}

function defaultOf(t: ZodTypeAny): unknown {
  if (t instanceof z.ZodDefault) return t._def.defaultValue();
  if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) return defaultOf(t.unwrap());
  if (t instanceof z.ZodEffects) return defaultOf(t.innerType());
  return undefined;
}

function fieldsOf(shape: Record<string, ZodTypeAny>): FieldEntry[] {
  return Object.entries(shape)
    .filter(([name]) => name !== "type")
    .map(([name, t]) => {
      const def = defaultOf(t);
      return { name, optional: t.isOptional() || def !== undefined, ...(def !== undefined ? { default: def } : {}), spec: spec(t) };
    });
}

/** What each action is, in a practitioner's words: its group, a title and one line of what it needs. */
const ABOUT: Record<string, [ActionGroup, string, string]> = {
  say: ["consultation", "Say", "Speak to the patient (or to a member of the team with `to`). Needs earshot."],
  ask: ["consultation", "Ask", "One focused question of the history, in your own words. The answer enters the record as evidence."],
  observe: ["consultation", "Observe", "Look at the patient: what you see enters the record. Needs them in view."],
  examine: ["consultation", "Examine", "One examination, in your own words (inspection, tongue, pulse, palpation, movement). Needs you at their side."],
  review_result: ["consultation", "Review a result", "Read an investigation or record already on file."],
  order_investigation: ["consultation", "Order an investigation", "Ask for an investigation (its result comes when it comes)."],
  check_vitals: ["consultation", "Vital signs", "Measure pulse, blood pressure and the rest. Needs you at their side."],
  assess: ["decision", "Assess", "Record diagnoses, a pattern with the evidence ids it rests on, and red flags."],
  decide: ["decision", "Decide", "The disposition: treat, treat modified, assess further, defer, refer or decline."],
  propose_plan: ["decision", "Propose a plan", "The points, the stimulation and the retention time, with the reasoning."],
  explain: ["decision", "Explain", "Explain the procedure, benefits, risks, alternatives, evidence, aftercare, the right to stop."],
  seek_consent: ["decision", "Seek consent", "Ask the patient to consent to the current plan."],
  refer: ["decision", "Refer", "Refer the patient on, with the urgency and the reason."],
  position_patient: ["localisation", "Position the patient", "Help the patient into a position. Needs you at their side."],
  identify_landmark: ["localisation", "Palpate a landmark", "Find a landmark of a regional chart on this patient. Needs the site within arm's reach."],
  measure: ["localisation", "Measure", "Measure a segment of the chart on this patient (or their finger-cun)."],
  mark_point: ["localisation", "Mark a point", "Mark where a point lies on this patient's skin, in chart centimetres."],
  move: ["preparation", "Walk", "Walk to a room, a fixture, a person, a body site or a spot of the floor plan."],
  hand_hygiene: ["preparation", "Hand hygiene", "Clean your hands at a sink or a hand-rub dispenser."],
  fetch: ["preparation", "Fetch", "Take an item from where it is kept."],
  handover: ["preparation", "Hand over", "Hand something you hold to a member of the team."],
  open_pack: ["preparation", "Open a pack", "Open a needle pack onto a trolley or worktop."],
  pick_up: ["preparation", "Pick up", "Pick up one needle from the tray."],
  prepare_site: ["preparation", "Prepare the site", "Clean the skin of a site. Needs the site within arm's reach."],
  insert_needle: ["procedure", "Insert a needle", "At a mark (or chart coordinates): angle, direction, depth, method and speed."],
  adjust_needle: ["procedure", "Work a needle", "Move a needle to another depth and/or manipulate it: lift-thrust, rotate, scrape, flick, shake, tremble."],
  check_sensation: ["procedure", "Ask what they feel", "Ask the patient what they feel at one needle: evidence of its response."],
  monitor: ["procedure", "Monitor", "Check on the patient and the needles."],
  wait: ["procedure", "Wait", "Let simulated minutes pass (retention)."],
  stop_treatment: ["procedure", "Stop the treatment", "Stop, with the reason."],
  remove_needle: ["completion", "Withdraw a needle", "Quickly or slowly, with or without pressing the hole."],
  remove_all_needles: ["completion", "Withdraw all needles", "Each retained needle in turn."],
  apply_pressure: ["completion", "Apply pressure", "Press on a needle site that bleeds."],
  count_needles: ["completion", "Count the needles", "Reconcile the needles opened with those accounted for."],
  dispose: ["completion", "Dispose", "Put a needle (or the rest of a pack) into a sharps container."],
  search: ["completion", "Search", "Look for a missing needle: couch, floor, patient, tray or clothing."],
  report_incident: ["completion", "Report an incident", "A lost or broken needle, a needlestick, an adverse event or a near miss."],
  document: ["completion", "Write the record", "The clinical record, with the response at each needle and the evidence it rests on."],
  end_visit: ["completion", "End the visit", "Close this visit."],
  begin_follow_up: ["completion", "Begin the follow-up", "Start the follow-up visit, when the encounter has one."],
  finish_encounter: ["completion", "Finish the encounter", "Close the encounter: the report is then written."],
  assign_task: ["team", "Assign a task", "Ask a member of the team to do something."],
  acknowledge_task: ["team", "Acknowledge a task", "Accept a task assigned to you."],
  decline_task: ["team", "Decline a task", "Decline a task, with the reason."],
  report_task: ["team", "Report on a task", "Report what was done and found."],
  cancel_task: ["team", "Cancel a task", "Cancel a task you assigned."],
  approve_plan: ["team", "Approve the plan", "A supervisor's approval of the current plan."],
};

let CACHED: ActionSpec[] | null = null;

/** Every action the engine accepts, in the schema's order. */
export function actionSpecs(): ActionSpec[] {
  if (CACHED) return CACHED;
  CACHED = ActionSchema.options.map((option) => {
    const shape = option.shape as Record<string, ZodTypeAny>;
    const type = (shape.type as z.ZodLiteral<string>).value;
    const about = ABOUT[type];
    return { type, group: about?.[0] ?? "procedure", title: about?.[1] ?? type, summary: about?.[2] ?? "", fields: fieldsOf(shape) };
  });
  return CACHED;
}
