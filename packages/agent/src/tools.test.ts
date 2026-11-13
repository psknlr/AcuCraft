import { describe, expect, it } from "vitest";
import { ActionSchema, createEncounter, observeAs, referenceLibrary, step, type ActionRequestInput, type EncounterState, type Scenario } from "@acucraft/core";
import { loadContentPack, requireScenario, scenarioIds } from "@acucraft/bench";
import { ACTION_DOCS, ACTION_TYPES, actionCatalogue, actionTool, constructPoint, constructPointTool, lookupTool, LOOKUP_TOPICS, readSkillTool, toolsFor, viewTool, VIEW_SECTIONS, type JsonSchema, type ToolContext } from "./index.js";

/**
 * The tools a language-model practitioner is given (docs/AGENT.md): generated from the engine's own schemas, so they
 * accept exactly what the engine accepts; and the read-only tools, which can show only what the practitioner may know.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");

function upTo(sc: Scenario, stop: (r: ActionRequestInput) => boolean): EncounterState {
  let s = createEncounter(sc, { seed: 1 });
  for (const r of sc.field.solution) {
    if (stop(r)) break;
    s = step(sc, s, r, { strict: true }).state;
  }
  return s;
}
const ctxOf = (sc: Scenario, s: EncounterState): ToolContext => ({ library: referenceLibrary(sc), view: observeAs(sc, s, "practitioner"), skills: pack.skills });

/** Every object of a schema, with where it is. */
function objects(schema: JsonSchema, path = "input"): { path: string; schema: JsonSchema }[] {
  const out: { path: string; schema: JsonSchema }[] = [];
  if (schema.type === "object") out.push({ path, schema });
  for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(...objects(v, `${path}.${k}`));
  if (schema.items) out.push(...objects(schema.items, `${path}[]`));
  if (typeof schema.additionalProperties === "object") out.push(...objects(schema.additionalProperties, `${path}.*`));
  for (const [i, v] of (schema.anyOf ?? []).entries()) out.push(...objects(v, `${path}|${i}`));
  return out;
}

describe("action tools", () => {
  it("there is one for every action of the engine, named after it, documented, with a closed object schema", () => {
    expect(ACTION_TYPES).toEqual(ActionSchema.options.map((o) => o.shape.type.value));
    expect(Object.keys(ACTION_DOCS).sort()).toEqual([...ACTION_TYPES].sort());
    for (const type of ACTION_TYPES) {
      const tool = actionTool(type);
      expect(tool.name).toBe(type);
      expect(tool.description.length, type).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties, type).not.toHaveProperty("type");
      // closed objects throughout, except a record (a task's params)
      for (const o of objects(tool.inputSchema)) if (o.schema.properties) expect(o.schema.additionalProperties, `${type} ${o.path}`).toBe(false);
      for (const key of tool.inputSchema.required) expect(tool.inputSchema.properties, `${type}.${key}`).toHaveProperty(key);
    }
  });

  it("says what the engine's schema says: required fields, bounds, enums, defaults, unions", () => {
    const insert = actionTool("insert_needle").inputSchema;
    expect(insert.required).toEqual(["needleId", "depthCm"]);
    expect(insert.properties.angleDeg).toMatchObject({ type: "number", minimum: 0, maximum: 90, default: 0 });
    expect(insert.properties.depthCm).toMatchObject({ type: "number", exclusiveMinimum: 0, maximum: 10 });
    expect(insert.properties.azimuthDeg!.description).toMatch(/0 cranial/);
    expect(insert.properties.at).toMatchObject({ type: "object", required: ["u", "v"], additionalProperties: false });
    expect(insert.properties.target!.anyOf).toHaveLength(2);
    const move = actionTool("move").inputSchema;
    expect(move.required).toEqual(["to"]);
    expect(move.properties.to!.anyOf!.map((o) => o.type)).toEqual(["string", undefined]);
    expect(move.properties.withPatient).toMatchObject({ type: "boolean", default: false });
    expect(actionTool("wait").inputSchema.properties.minutes).toMatchObject({ type: "integer", minimum: 1, maximum: 60 });
    expect(actionTool("decide").inputSchema.properties.disposition!.enum).toEqual(["treat", "treat-modified", "further-assessment", "defer", "refer", "decline"]);
    expect(actionTool("assign_task").inputSchema.properties.params).toMatchObject({ type: "object", additionalProperties: { type: ["string", "number", "boolean"] } });
    expect(actionTool("document").inputSchema.properties.record!.properties!.needling!.properties!.responses!.items!.properties!.response!.enum).toEqual(["deqi", "none", "not-sought"]);
    expect(actionTool("end_visit").inputSchema).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  it("carries every action of every reference trajectory unchanged", () => {
    let n = 0;
    for (const id of scenarioIds(pack)) {
      for (const r of requireScenario(pack, id).field.solution) {
        const { type, ...fields } = r.action as Record<string, unknown>;
        const parsed = actionTool(type as never).toAction(fields);
        expect(parsed, `${id} ${r.requestId}`).toEqual({ ok: true, action: r.action });
        n++;
      }
    }
    expect(n).toBeGreaterThan(900);
  });

  it("refuses what the engine would not parse, in words that say where — and nothing reaches the engine", () => {
    const insert = actionTool("insert_needle");
    const missing = insert.toAction({ needleId: "pack-a.1" });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toMatch(/Not a valid insert_needle: depthCm: Required.*Nothing was done/);
    expect((insert.toAction({ needleId: "pack-a.1", depthCm: 2, deep: true }) as { error: string }).error).toMatch(/Unrecognized key/);
    expect((actionTool("mark_point").toAction({ target: { point: "ST36" }, region: "knee-leg", side: "right", at: { u: 1, v: 2 } }) as { error: string }).error).toMatch(/target/);
    expect(actionTool("observe").toAction(undefined)).toEqual({ ok: true, action: { type: "observe" } });
    // a `type` in the input cannot turn one tool into another
    expect(actionTool("observe").toAction({ type: "finish_encounter" })).toEqual({ ok: true, action: { type: "observe" } });
  });

  it("a role is given the tools of what it may do", () => {
    const view = observeAs(knee, createEncounter(knee, { seed: 1 }), "practitioner");
    const names = toolsFor(view.you.may, { skills: true }).map((t) => t.name);
    expect(names.slice(0, 4)).toEqual(["lookup", "view", "construct_point", "read_skill"]);
    for (const t of ["ask", "move", "insert_needle", "count_needles", "wait", "finish_encounter"]) expect(names).toContain(t);
    // a physician does not order investigations here and does not supervise
    expect(names).not.toContain("order_investigation");
    expect(names).not.toContain("approve_plan");
    const assistant = toolsFor(observeAs(knee, createEncounter(knee, { seed: 1 }), "assistant").you.may).map((t) => t.name);
    expect(assistant).toContain("count_needles");
    expect(assistant).not.toContain("insert_needle");
    expect(assistant).not.toContain("read_skill");
    expect(toolsFor(view.you.may, { locate: false }).map((t) => t.name)).not.toContain("construct_point");
  });

  it("the text catalogue still lists every action (for people and documents)", () => {
    const text = actionCatalogue();
    for (const t of ACTION_TYPES) expect(text).toMatch(new RegExp(`^- ${t}\\b`, "m"));
    expect(text).toMatch(/^- assess \{.*patternEvidence\?: string\[\]/m);
  });
});

describe("read-only tools", () => {
  const start = ctxOf(knee, createEncounter(knee, { seed: 1 }));

  it("lookup serves the library by topic, and says what the topics are when it does not know one", () => {
    expect(lookupTool.inputSchema.properties.topic!.enum).toEqual([...LOOKUP_TOPICS]);
    const point = lookupTool.run({ topic: "point", id: "st36" }, start);
    expect(point.ok).toBe(true);
    expect(point.output).toMatchObject({ id: "ST36", region: "knee-leg" });
    expect(lookupTool.run({ topic: "point", id: "ZZ99" }, start).ok).toBe(false);
    expect(lookupTool.run({ topic: "weather" }, start)).toMatchObject({ ok: false, output: { topics: LOOKUP_TOPICS } });
    expect(lookupTool.run({ topic: "floorplan" }, start).output).toHaveProperty("ranges.armReach");
  });

  it("view gives the whole view or one section of it", () => {
    expect(viewTool.inputSchema.properties.section!.enum).toEqual([...VIEW_SECTIONS]);
    expect(viewTool.run({}, start).output).toBe(start.view);
    expect(viewTool.run({ section: "space" }, start).output).toEqual({ minute: start.view.minute, space: start.view.space });
    expect(viewTool.run({ section: "teaching" }, start).output).toEqual({ minute: start.view.minute, teaching: null });
    expect(viewTool.run({ section: "evaluation" }, start).ok).toBe(false);
  });

  it("construct_point says what still has to be palpated and measured, then gives the position those observations give", () => {
    const before = constructPointTool.run({ point: "ST36", side: "right" }, start);
    expect(before.output).toMatchObject({ point: "ST36", located: false });
    const needed = (before.output as { stillNeeded: { region: string; side: string; landmarks: string[]; segments: string[] }[] }).stillNeeded;
    expect(needed[0]!.region).toBe("knee-leg");
    expect(needed.flatMap((n) => [...n.landmarks, ...n.segments]).length).toBeGreaterThan(1);
    // (seated in the consultation room the leg chart is not in the configuration it will be needled in)
    // once the reference has palpated and measured for its marks: the same arithmetic as the baseline agent's
    const marked = ctxOf(knee, upTo(knee, (r) => r.action.type === "mark_point"));
    const located = constructPointTool.run({ point: "ST36", side: "right" }, marked);
    expect(located.output).toMatchObject({ point: "ST36", located: true, region: "knee-leg", side: "right" });
    const out = located.output as { at: { u: number; v: number }; mark: Record<string, unknown>; configuration: string };
    const obs = (region: string, side: string) => ({
      landmarks: new Map(marked.view.localisation.landmarks.filter((l) => l.region === region && l.side === side).map((l) => [l.landmark, { u: l.u, v: l.v }])),
      segments: new Map(marked.view.localisation.measurements.filter((m) => m.region === region && m.side === side).map((m) => [m.what, m.cm])),
    });
    const direct = constructPoint(marked.library, "ST36", "right", obs)!;
    expect(out.at.u).toBeCloseTo(direct.u, 2);
    expect(out.at.v).toBeCloseTo(direct.v, 2);
    // …and within a few millimetres of where the reference marked it
    const reference = knee.field.solution.find((r) => r.action.type === "mark_point" && (r.action.target as { point?: string }).point === "ST36")!.action as { at: { u: number; v: number } };
    expect(Math.hypot(out.at.u - reference.at.u, out.at.v - reference.at.v)).toBeLessThan(0.6);
    // what it returns is an input mark_point takes
    expect(actionTool("mark_point").toAction(out.mark).ok).toBe(true);
  });

  it("construct_point knows a bilateral point needs a side, a group point a site, and what cannot be constructed", () => {
    expect(constructPointTool.run({ point: "ST36" }, start)).toMatchObject({ ok: false, output: { error: expect.stringMatching(/bilateral/) } });
    expect(constructPointTool.run({ point: "EX-HN1" }, start).output).toMatchObject({ error: expect.stringMatching(/group of sites/), sites: expect.any(Array) });
    expect(constructPointTool.run({ point: "GV20", site: "anterior" }, start)).toMatchObject({ ok: false });
    expect(constructPointTool.run({ point: "nowhere" }, start)).toMatchObject({ ok: false });
    // a midline point takes no side
    expect(constructPointTool.run({ point: "GV20" }, start).output).toMatchObject({ point: "GV20", located: false });
  });

  it("a landmark palpated in another configuration of its chart no longer counts", () => {
    // palpated with the knee flexed over a bolster; then the patient is laid flat, the knee extended
    let s = upTo(knee, (r) => r.action.type === "mark_point");
    const flexed = ctxOf(knee, s);
    expect((constructPointTool.run({ point: "ST36", side: "right" }, flexed).output as { located: boolean }).located).toBe(true);
    for (const action of [{ type: "move", to: { person: "patient" } }, { type: "position_patient", position: "supine" }] as const) {
      const res = step(knee, s, { requestId: `t-${action.type}`, actor: "practitioner", patient: "patient", action }, { strict: true });
      expect(res.attempt.status, res.attempt.message).toBe("executed");
      s = res.state;
    }
    const configuration = (ctx: ToolContext) => ctx.view.patient.reachable.find((r) => r.region === "knee-leg")!.configuration;
    expect(configuration(ctxOf(knee, s))).not.toBe(configuration(flexed));
    const after = constructPointTool.run({ point: "ST36", side: "right" }, ctxOf(knee, s)).output as { located: boolean; stillNeeded: { landmarks: string[] }[] };
    expect(after.located).toBe(false);
    expect(after.stillNeeded.flatMap((n) => n.landmarks).length).toBeGreaterThan(0);
  });

  it("read_skill returns a skill in full, or the ids there are", () => {
    const read = readSkillTool.run({ id: "point-location" }, start);
    expect(read.ok).toBe(true);
    expect(read.output).toMatch(/^# Locating a point on this patient\n\n/);
    expect(readSkillTool.run({ id: "surgery" }, start)).toMatchObject({ ok: false, output: { skills: expect.any(Array) } });
  });

  it("no read-only tool can show what the practitioner's view and the public library do not hold", () => {
    // the scenario's hidden side: its evaluation, its variant, the reference marks
    const hidden = [knee.variant.id, ...knee.field.evaluation.pathways.map((p) => p.id)];
    const ctx = ctxOf(requireScenario(pack, "sg-knee-oa/hot-knee"), createEncounter(requireScenario(pack, "sg-knee-oa/hot-knee"), { seed: 1 }));
    const served = JSON.stringify([
      ...LOOKUP_TOPICS.map((topic) => lookupTool.run({ topic }, ctx).output),
      viewTool.run({}, ctx).output,
      constructPointTool.run({ point: "ST36", side: "right" }, ctx).output,
      ...pack.skills.map((s) => readSkillTool.run({ id: s.id }, ctx).output),
    ]);
    expect(served).not.toContain("hot-knee");
    for (const id of hidden.filter((x) => x.startsWith("p-"))) expect(served, id).not.toContain(`"${id}"`);
    expect(served).not.toContain("septic-arthritis\",\"expected");
  });
});
