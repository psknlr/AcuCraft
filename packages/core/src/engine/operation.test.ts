import { describe, expect, it } from "vitest";
import {
  DEPTH_LEVELS, MANIPULATION_TECHNIQUES, MANIPULATION_TECHNIQUE_IDS, NEEDLE_CLEARANCE_MM, OPERATIVE_TECHNIQUES, TECHNIQUE_CARDS, TECHNIQUE_GROUPS, WINDING,
  ManipulationMotionSettingsSchema, needleHold, operationCountsError, operationEffect, operationStages, operativeCatalogueComplete, operativeTechnique,
  resolveManipulationMotion, resolveOperationMotion, resolveTechniqueMotion, sampleManipulation, sampleOperation, sampleTechnique, techniqueCatalogue, techniqueDefinition,
  type ManipulationTechniqueId, type OperationSample,
} from "../index.js";

const deg = (rad: number) => (rad * 180) / Math.PI;
/** Every 4 ms of a performance at these settings. */
function run(id: ManipulationTechniqueId, settings = {}, depthMm = 15, context: { besideNeedle?: boolean } = {}): OperationSample[] {
  const duration = resolveOperationMotion(id, settings).durationMs;
  const out: OperationSample[] = [];
  for (let t = 0.001; t < duration; t += 4) out.push(sampleOperation(id, t, settings, { depthMm, ...context }));
  return out;
}
const stageOf = (samples: OperationSample[], zh: string) => samples.filter((s) => s.stage.zh === zh);

describe("the operative catalogue", () => {
  it("has the same 36 techniques as the illustrative one — same ids, contexts and families — each with its card and its stages", () => {
    expect(operativeCatalogueComplete()).toBe(true);
    expect(OPERATIVE_TECHNIQUES.map((t) => t.id)).toEqual([...MANIPULATION_TECHNIQUE_IDS]);
    for (const t of OPERATIVE_TECHNIQUES) {
      const v1 = MANIPULATION_TECHNIQUES.find((x) => x.id === t.id)!;
      expect([t.zh, t.context, t.family, t.needsNeedle], t.id).toEqual([v1.zh, v1.context, v1.family, v1.needsNeedle]);
      expect(t.evidence).toBe("operative");
      expect(t.source).toMatchObject({ id: "acucraft-operative-techniques-v2", review: "unreviewed" });
      const card = TECHNIQUE_CARDS[t.id];
      expect(card.aim.length, `${t.id} aim`).toBeGreaterThan(20);
      expect(card.method.length, `${t.id} method`).toBeGreaterThanOrEqual(2);
      expect(card.essentials.length, `${t.id} essentials`).toBeGreaterThanOrEqual(2);
      expect(card.simulation.length, `${t.id} simulation`).toBeGreaterThan(20);
      expect(t.stages.length, `${t.id} stages`).toBeGreaterThan(0);
      // the stages tile the performance, in order
      expect(t.stages[0]!.start).toBe(0);
      expect(t.stages.at(-1)!.end).toBeCloseTo(1, 9);
      t.stages.slice(1).forEach((x, i) => expect(x.start, `${x.id} follows`).toBeCloseTo(t.stages[i]!.end, 9));
      // the settings it advertises are settings the action takes, and its defaults are valid ones
      expect(ManipulationMotionSettingsSchema.safeParse(t.defaults).success, `${t.id} defaults`).toBe(true);
      for (const control of t.controls) expect(Object.keys(ManipulationMotionSettingsSchema.shape), `${t.id} ${control}`).toContain(control);
    }
    // the illustrative catalogue is still there, untouched, for the records made on it
    expect(techniqueCatalogue(undefined)).toBe(MANIPULATION_TECHNIQUES);
    expect(techniqueCatalogue("operative")).toBe(OPERATIVE_TECHNIQUES);
    expect(techniqueDefinition(undefined, "shao-shan-huo")!.phases).toHaveLength(4);
    expect(techniqueDefinition("operative", "shao-shan-huo")!.phases).toHaveLength(3);
  });

  it("groups the twenty-four single methods in six fours, then the ten compound methods and the two bare forms", () => {
    const byGroup = (id: string) => OPERATIVE_TECHNIQUES.filter((t) => t.card.group === id).map((t) => t.zh).join("");
    expect(TECHNIQUE_GROUPS.slice(0, 6).map((g) => [g.zh, byGroup(g.id)])).toEqual([
      ["揣爪循摄", "揣爪循摄"], ["摇盘捻搓", "摇盘捻搓"], ["进退提插", "进退提插"], ["刮弹飞摩", "刮弹飞摩"], ["动推颤弩", "动推颤弩"], ["按扪搜拨", "按扪搜拨"],
    ]);
    expect(OPERATIVE_TECHNIQUES.filter((t) => t.card.group === "compound")).toHaveLength(10);
    expect(byGroup("bu-xie")).toBe("补泻");
  });

  it("carries the numbers the methods are taught with: nine and six, shallow and deep, left and right", () => {
    const counts = (id: ManipulationTechniqueId) => operativeTechnique(id)!.counts.map((c) => c.count);
    expect(counts("shao-shan-huo")).toEqual([9, 9, 9]);
    expect(counts("tou-tian-liang")).toEqual([6, 6, 6]);
    expect(counts("yang-zhong-yin-yin")).toEqual([9, 6]);
    expect(counts("yin-zhong-yin-yang")).toEqual([6, 9]);
    expect(counts("long-hu-jiao-zhan")).toEqual([9, 6]);
    expect(counts("qing-long-bai-wei")).toEqual([9]);
    expect(counts("bai-hu-yao-tou")).toEqual([6]);
    expect(counts("bu")).toEqual([9]);
    expect(counts("xie")).toEqual([6]);
    const work = (id: ManipulationTechniqueId) => operativeTechnique(id)!.stages.filter((x) => x.counted);
    // 烧山火: shallow, middle, deep — each a quick thrust and a slow lift (most of the stroke is the lift)
    expect(work("shao-shan-huo").map((x) => [x.level, x.count, x.bias > 0.5])).toEqual([["tian", 9, true], ["ren", 9, true], ["di", 9, true]]);
    // 透天凉: deep, middle, shallow — each a quick lift and a slow thrust
    expect(work("tou-tian-liang").map((x) => [x.level, x.count, x.bias < 0.5])).toEqual([["di", 6, true], ["ren", 6, true], ["tian", 6, true]]);
    // 龙虎交战: nine to the left (thumb forward), six to the right, and again
    expect(work("long-hu-jiao-zhan").map((x) => [x.turn, x.count])).toEqual([[1, 9], [-1, 6], [1, 9], [-1, 6]]);
    // 子午捣臼: three rounds of three in and two out — nine in, six out
    const mortar = operativeTechnique("zi-wu-dao-jiu")!.stages;
    expect(mortar.filter((x) => x.zh.includes("进 · 左转"))).toHaveLength(9);
    expect(mortar.filter((x) => x.zh.includes("退 · 右转"))).toHaveLength(6);
    // 苍龟探穴: four directions, three steps in and one out each
    const turtle = operativeTechnique("cang-gui-tan-xue")!.stages;
    expect(turtle.filter((x) => /[一二三]进$/.test(x.zh))).toHaveLength(12);
    expect(turtle.filter((x) => x.zh === "一退")).toHaveLength(4);
    expect(DEPTH_LEVELS.tian.fraction).toBeCloseTo(1 / 3);
    expect(DEPTH_LEVELS.ren.fraction).toBeCloseTo(2 / 3);
    expect(DEPTH_LEVELS.di.fraction).toBe(1);
  });
});

describe("the settings of a performance", () => {
  it("uses the method's own counts unless others are given, and the time those counts take unless a time is given", () => {
    const fire = resolveOperationMotion("shao-shan-huo");
    expect(fire.phaseCycles).toEqual([9, 9, 9]);
    expect(fire.durationMs).toBe(operativeTechnique("shao-shan-huo")!.defaults.durationMs);
    expect(fire.support).toBe("none");
    // one count for every counted stage
    expect(resolveOperationMotion("shao-shan-huo", { cycles: 3 }).phaseCycles).toEqual([3, 3, 3]);
    // or each its own; fewer strokes take less time at the same tempo
    const short = resolveOperationMotion("shao-shan-huo", { phaseCycles: [3, 6, 9] });
    expect(short.phaseCycles).toEqual([3, 6, 9]);
    expect(short.durationMs).toBeLessThan(fire.durationMs);
    expect(resolveOperationMotion("shao-shan-huo", { phaseCycles: [3, 6, 9], durationMs: 9000 }).durationMs).toBe(9000);
    // a single method counts with cycles
    expect(resolveOperationMotion("nian").cycles).toBe(6);
    expect(resolveOperationMotion("nian", { cycles: 10 }).cycles).toBe(10);
    expect(resolveOperationMotion("nian").phaseCycles).toBeUndefined();
    // resolving what was resolved changes nothing: a record plays as it was performed
    for (const t of OPERATIVE_TECHNIQUES) {
      const once = resolveOperationMotion(t.id, { cycles: 4 });
      expect(resolveOperationMotion(t.id, once), t.id).toEqual(once);
    }
    // travel belongs to the hands that travel
    expect(resolveOperationMotion("xun").travelMm).toBe(30);
    expect(resolveOperationMotion("nian").travelMm).toBeUndefined();
    // and the illustrative catalogue resolves as it always did
    expect(resolveTechniqueMotion(undefined, "shao-shan-huo")).toEqual(resolveManipulationMotion("shao-shan-huo"));
    expect(resolveTechniqueMotion("operative", "shao-shan-huo")).toEqual(fire);
    expect("travelMm" in resolveManipulationMotion("xun", { travelMm: 20 })).toBe(false);
  });

  it("says what is wrong with counts that do not fit the method", () => {
    expect(operationCountsError(operativeTechnique("shao-shan-huo")!, { phaseCycles: [9, 9] })).toMatch(/needs 3 counts.*天部.*人部.*地部/);
    expect(operationCountsError(operativeTechnique("nian")!, { phaseCycles: [2, 2] })).toMatch(/one count.*set cycles/);
    expect(operationCountsError(operativeTechnique("long-hu-jiao-zhan")!, { phaseCycles: [9, 6] })).toBeNull();
    expect(operationCountsError(operativeTechnique("shao-shan-huo")!, {})).toBeNull();
  });
});

describe("the operative sampler", () => {
  it("keeps every technique inside what its settings allow, inside the patient, and never deeper than the needle stands", () => {
    for (const t of OPERATIVE_TECHNIQUES) {
      for (const [settings, depthMm] of [[{}, 15], [{ strokeMm: 3, rotationDeg: 180, lateralMm: 4, tiltDeg: 8, cycles: 12, durationMs: 30_000 }, 30], [{ strokeMm: 3, cycles: 1, durationMs: 400 }, 6]] as const) {
        const motion = resolveOperationMotion(t.id, settings);
        const samples = run(t.id, settings, depthMm);
        const where = `${t.id} at ${JSON.stringify(settings)}`;
        // one pass over the performance, then one judgement of each kind
        let finite = true, deepest = Infinity, shallowest = -Infinity, lateral = 0, tilt = 0, travel = 0, low = Infinity, high = -Infinity, fraction = [Infinity, -Infinity], axialStep = 0, lateralStep = 0;
        let previous: OperationSample | null = null;
        for (const s of samples) {
          finite &&= [s.withdrawalMm, s.rotationRad, s.lateralMm.u, s.lateralMm.v, s.tiltRad.u, s.tiltRad.v, s.gripEngagement, s.nailContact, s.supportContact, s.depthFraction, s.travelMm, s.offsetMm, s.windingRad].every(Number.isFinite);
          deepest = Math.min(deepest, s.withdrawalMm); shallowest = Math.max(shallowest, s.withdrawalMm);
          lateral = Math.max(lateral, Math.hypot(s.lateralMm.u, s.lateralMm.v)); tilt = Math.max(tilt, deg(Math.hypot(s.tiltRad.u, s.tiltRad.v)));
          travel = Math.max(travel, Math.abs(s.travelMm));
          low = Math.min(low, s.gripEngagement, s.nailContact, s.supportContact); high = Math.max(high, s.gripEngagement, s.nailContact, s.supportContact);
          fraction = [Math.min(fraction[0]!, s.depthFraction), Math.max(fraction[1]!, s.depthFraction)];
          if (previous) {
            axialStep = Math.max(axialStep, Math.abs(s.withdrawalMm - previous.withdrawalMm));
            lateralStep = Math.max(lateralStep, Math.hypot(s.lateralMm.u - previous.lateralMm.u, s.lateralMm.v - previous.lateralMm.v));
          }
          previous = s;
        }
        expect(finite, `${where}: finite`).toBe(true);
        expect(deepest, `${where}: never deeper than the needle stands`).toBeGreaterThanOrEqual(0);
        expect(shallowest, `${where}: stays in the patient`).toBeLessThanOrEqual(depthMm - Math.min(2, depthMm * 0.25) + 1e-9);
        expect(fraction[0], `${where}: level`).toBeGreaterThan(0.2);
        expect(fraction[1], `${where}: level`).toBeLessThanOrEqual(1);
        expect(lateral, `${where}: lateral`).toBeLessThanOrEqual(motion.lateralMm + 1e-9);
        expect(tilt, `${where}: tilt`).toBeLessThanOrEqual(motion.tiltDeg + 1e-9);
        expect(travel, `${where}: travel`).toBeLessThanOrEqual((motion.travelMm ?? 0) + 1e-9);
        expect(low, `${where}: shares`).toBeGreaterThanOrEqual(0);
        expect(high, `${where}: shares`).toBeLessThanOrEqual(1);
        if (t.context !== "retained") expect(shallowest, `${where}: no needle moves`).toBe(0);
        // one stage hands the needle to the next without a jump (samples 4 ms apart, at the tempo the method is taught at)
        if (motion.durationMs >= 3000) {
          expect(axialStep, `${where}: axial step`).toBeLessThan(0.45);
          expect(lateralStep, `${where}: lateral step`).toBeLessThan(0.45);
        }
        // it ends where it began — except for what one-way turning leaves on the needle
        const end = sampleOperation(t.id, motion.durationMs, settings, { depthMm });
        expect(end.complete).toBe(true);
        expect([end.withdrawalMm, end.lateralMm.u, end.lateralMm.v, end.tiltRad.u, end.tiltRad.v, end.travelMm], t.id).toEqual([0, 0, 0, 0, 0, 0]);
        expect(end.depthFraction).toBe(1);
        expect(end.rotationRad).toBeCloseTo(end.windingRad, 12);
        if (!t.effect.winds) expect(end.rotationRad).toBe(0);
        // and it is a function of its inputs alone
        expect(sampleOperation(t.id, motion.durationMs / 3, settings, { depthMm })).toEqual(sampleOperation(t.id, motion.durationMs / 3, settings, { depthMm }));
      }
    }
  });

  it("takes the needle through the levels of 烧山火 from shallow to deep, and of 透天凉 from deep to shallow", () => {
    const depthMm = 18;
    const fire = run("shao-shan-huo", {}, depthMm);
    const order = [...new Set(fire.filter((s) => s.stage.of > 0).map((s) => s.stage.level))];
    expect(order).toEqual(["tian", "ren", "di"]);
    for (const [zh, fraction] of [["天部 · 紧按慢提", 1 / 3], ["人部 · 紧按慢提", 2 / 3], ["地部 · 紧按慢提", 1]] as const) {
      const at = stageOf(fire, zh);
      expect(at.every((s) => Math.abs(s.depthFraction - fraction) < 1e-9), zh).toBe(true);
      // the stroke is outward from the level and comes back to it
      const level = (1 - fraction) * depthMm;
      expect(Math.min(...at.map((s) => s.withdrawalMm))).toBeCloseTo(level, 1);
      expect(Math.max(...at.map((s) => s.withdrawalMm))).toBeCloseTo(level + 2, 1);
      expect(Math.max(...at.map((s) => s.stage.count))).toBe(9);
    }
    const cool = run("tou-tian-liang", {}, depthMm);
    expect([...new Set(cool.filter((s) => s.stage.of > 0).map((s) => s.stage.level))]).toEqual(["di", "ren", "tian"]);
    // quick thrust, slow lift: within one stroke the needle is going up for longer than it is coming down — and the reverse
    const rising = (samples: OperationSample[]) => samples.slice(1).filter((s, i) => s.withdrawalMm > samples[i]!.withdrawalMm + 1e-9).length / samples.length;
    expect(rising(stageOf(fire, "人部 · 紧按慢提"))).toBeGreaterThan(0.6);
    expect(rising(stageOf(cool, "人部 · 紧提慢按"))).toBeLessThan(0.4);
    // the breath is named where the needle changes level
    expect(new Set(fire.filter((s) => s.stage.motif === "move" && s.stage.breath).map((s) => s.stage.breath))).toEqual(new Set(["exhale"]));
  });

  it("turns thumb-forward clockwise seen from the handle, and the dragon and the tiger opposite ways", () => {
    const battle = run("long-hu-jiao-zhan");
    const dragon = stageOf(battle, "龙 · 左转九"), tiger = stageOf(battle, "虎 · 右转六");
    // clockwise from the handle is negative about the outward axis: the renderer's convention
    expect(Math.min(...dragon.map((s) => s.rotationRad))).toBeCloseTo(-(120 * Math.PI) / 180, 2);
    expect(Math.max(...dragon.map((s) => s.rotationRad))).toBeLessThanOrEqual(1e-9);
    expect(Math.max(...tiger.map((s) => s.rotationRad))).toBeCloseTo((120 * Math.PI) / 180, 2);
    expect(Math.min(...tiger.map((s) => s.rotationRad))).toBeGreaterThanOrEqual(-1e-9);
    // each twirl is let back: nothing stays on the needle
    expect(battle.every((s) => s.windingRad === 0)).toBe(true);
    // reinforcing: the thumb goes forward with the thrust; reducing: back with the lift
    expect(Math.min(...run("bu").map((s) => s.rotationRad))).toBeLessThan(-0.5);
    expect(Math.max(...run("bu").map((s) => s.rotationRad))).toBeLessThanOrEqual(1e-9);
    expect(Math.max(...run("xie").map((s) => s.rotationRad))).toBeGreaterThan(1);
    // plain twirling goes both ways equally
    const twirl = run("nian").map((s) => s.rotationRad);
    expect(Math.max(...twirl)).toBeCloseTo(-Math.min(...twirl), 2);
  });

  it("leaves on the needle what one-way rolling winds, the way it was rolled", () => {
    const wound = sampleOperation("cuo", 60_000);
    expect(deg(wound.rotationRad)).toBeCloseTo(-360, 6);
    expect(deg(sampleOperation("cuo", 60_000, { direction: "counterclockwise" }).rotationRad)).toBeCloseTo(360, 6);
    expect(deg(sampleOperation("cuo", 60_000, { cycles: 2, rotationDeg: 90 }).rotationRad)).toBeCloseTo(-180, 6);
    // it only ever grows, and the fingers take a fresh hold between rolls
    const rolling = run("cuo");
    rolling.slice(1).forEach((s, i) => expect(s.rotationRad).toBeLessThanOrEqual(rolling[i]!.rotationRad + 1e-9));
    expect(Math.min(...rolling.map((s) => s.gripEngagement))).toBeLessThan(0.5);
    expect(operationEffect("cuo")).toMatchObject({ windingDeg: 360, loosensDeg: 0 });
    expect(operationEffect("cuo", { direction: "counterclockwise" }).windingDeg).toBe(-360);
    expect([needleHold(0), needleHold(179), needleHold(-180), needleHold(539), needleHold(-540)]).toEqual(["free", "free", "held", "held", "stuck"]);
    expect(WINDING.heldFromDeg).toBeLessThan(WINDING.stuckFromDeg);
  });

  it("shows each method's own hand: the flick, the scrape, the flying release, the travelling stroke", () => {
    const flick = run("tan");
    expect(new Set(flick.map((s) => s.handPose))).toEqual(new Set(["flick"]));
    expect(flick.every((s) => s.contact === "nail-handle")).toBe(true);
    const scrape = run("gua");
    expect(new Set(scrape.map((s) => s.handPose))).toEqual(new Set(["scrape"]));
    expect(Math.max(...scrape.map((s) => s.nailContact))).toBeGreaterThan(0.95);
    // 飞: closed on the handle to twirl, then the fingers leave it completely
    const fly = run("fei");
    expect(Math.max(...fly.map((s) => s.gripEngagement))).toBeGreaterThan(0.99);
    expect(Math.min(...fly.map((s) => s.gripEngagement))).toBeLessThan(0.05);
    expect(fly.filter((s) => s.gripEngagement < 0.5).every((s) => Math.abs(s.rotationRad) < 0.35)).toBe(true);
    // 弩 is a three-finger hold, held
    expect(new Set(run("nu").map((s) => s.handPose))).toEqual(new Set(["tripod"]));
    // 循 travels along the channel both ways from the point; beside a needle it keeps clear of the entry
    const trace = run("xun");
    expect(Math.max(...trace.map((s) => s.travelMm))).toBeCloseTo(30, 0);
    expect(Math.min(...trace.map((s) => s.travelMm))).toBeCloseTo(-30, 0);
    expect(trace.every((s) => s.offsetMm === 0)).toBe(true);
    expect(run("xun", {}, 15, { besideNeedle: true }).every((s) => s.offsetMm === NEEDLE_CLEARANCE_MM)).toBe(true);
    // 摄 nips at four stations, two below the point and two above
    const nips = run("she").filter((s) => s.nailContact > 0.6).map((s) => Math.round(s.travelMm));
    expect([...new Set(nips)]).toEqual([-24, -12, 12, 24]);
    // 按 presses at the point, or beside a needle when there is one
    expect(run("an").every((s) => s.travelMm === 0)).toBe(true);
    expect(run("an", {}, 15, { besideNeedle: true }).some((s) => s.travelMm === 18)).toBe(true);
    // 青龙摆尾 sways at the shallow level, leaned over; 白虎摇头 shakes while it lifts
    const dragon = stageOf(run("qing-long-bai-wei"), "一左一右");
    expect(dragon.every((s) => Math.abs(s.depthFraction - 1 / 3) < 1e-9 && s.lateralMm.v > 1)).toBe(true);
    const tiger = stageOf(run("bai-hu-yao-tou"), "边摇边提");
    expect(tiger.at(-1)!.depthFraction).toBeLessThan(tiger[0]!.depthFraction - 0.25);
  });

  it("compresses the strokes of a shallow needle rather than take it out of the skin", () => {
    const shallow = run("shao-shan-huo", { strokeMm: 3 }, 6);
    expect(Math.max(...shallow.map((s) => s.withdrawalMm))).toBeLessThanOrEqual(6 - 1.5 + 1e-9);
    const deep = run("shao-shan-huo", { strokeMm: 3 }, 30);
    const amplitude = (samples: OperationSample[]) => { const at = stageOf(samples, "地部 · 紧按慢提").map((s) => s.withdrawalMm); return Math.max(...at) - Math.min(...at); };
    expect(amplitude(deep)).toBeCloseTo(3, 1);
    expect(amplitude(shallow)).toBeLessThan(1.7);
  });

  it("samples either catalogue through one door, and tells them apart", () => {
    const old = sampleManipulation(undefined, "shao-shan-huo", 1000);
    expect(old).toEqual(sampleTechnique("shao-shan-huo", 1000));
    expect(old.depthFraction).toBeUndefined();
    expect(old.stage).toBeUndefined();
    const now = sampleManipulation("operative", "shao-shan-huo", 1000, undefined, { depthMm: 12 });
    expect(now).toEqual(sampleOperation("shao-shan-huo", 1000, undefined, { depthMm: 12 }));
    expect(now.stage).toMatchObject({ zh: "退至天部", level: "tian", of: 0 });
    expect(now.phase.label).toContain("退至天部");
    expect(operationStages("shao-shan-huo", { phaseCycles: [1, 2, 3] }).filter((x) => x.counted).map((x) => x.count)).toEqual([1, 2, 3]);
  });
});

describe("what a performance does", () => {
  it("doses by the method, more for more — but twice the count is not twice the stimulus — and never above one", () => {
    const dose = (id: ManipulationTechniqueId, settings = {}) => operationEffect(id, settings).dose;
    expect(dose("nian")).toBe(0.3);
    expect(dose("nian", { cycles: 12 })).toBeCloseTo(0.3 * Math.SQRT2, 3);
    expect(dose("nian", { rotationDeg: 22.5 })).toBeCloseTo(0.15, 3);
    expect(dose("shao-shan-huo")).toBe(0.7);
    expect(dose("shao-shan-huo", { phaseCycles: [12, 12, 12], strokeMm: 3 })).toBeLessThanOrEqual(1);
    // the light methods are light, the compound ones heavy
    for (const id of ["gua", "tan", "mo", "xun", "she", "an"] as const) expect(dose(id), id).toBeLessThanOrEqual(0.1);
    for (const t of OPERATIVE_TECHNIQUES.filter((x) => x.family === "compound")) expect(t.effect.dose, t.id).toBeGreaterThanOrEqual(0.3);
    expect(dose("chuai")).toBe(0);
    expect(dose("zhua")).toBe(0);
    // time is the performance's own
    expect(operationEffect("shao-shan-huo").minutes).toBeCloseTo(resolveOperationMotion("shao-shan-huo").durationMs / 60_000, 2);
  });

  it("reads each method as the tradition does", () => {
    const reading = (id: ManipulationTechniqueId) => operativeTechnique(id)!.effect.reading;
    for (const id of ["bu", "cha", "jin", "shao-shan-huo", "qing-long-bai-wei", "cang-gui-tan-xue"] as const) expect(reading(id), id).toBe("reinforcing");
    for (const id of ["xie", "ti", "tui-withdraw", "tou-tian-liang", "bai-hu-yao-tou", "chi-feng-ying-yuan"] as const) expect(reading(id), id).toBe("reducing");
    for (const id of ["long-hu-jiao-zhan", "zi-wu-dao-jiu", "yang-zhong-yin-yin", "yin-zhong-yin-yang"] as const) expect(reading(id), id).toBe("mixed");
    expect(reading("nian")).toBe("even");
    for (const id of ["gua", "tan", "fei", "yao", "chuai"] as const) expect(reading(id), id).toBeNull();
    expect(operativeTechnique("shao-shan-huo")!.effect.seeks).toBe("warmth");
    expect(operativeTechnique("tou-tian-liang")!.effect.seeks).toBe("coolness");
    // what frees a wound needle: the channel stroked or nipped, the handle flicked or scraped
    for (const id of ["xun", "she", "tan", "gua"] as const) expect(operativeTechnique(id)!.effect.loosensDeg, id).toBeGreaterThan(0);
    expect(operativeTechnique("she")!.effect.loosensDeg).toBeGreaterThan(operativeTechnique("xun")!.effect.loosensDeg);
    // and the methods that work between levels say how deep a needle they need
    for (const id of ["shao-shan-huo", "tou-tian-liang", "jin", "tui-withdraw", "zi-wu-dao-jiu", "cang-gui-tan-xue"] as const) expect(operativeTechnique(id)!.effect.needsDepthMm, id).toBeGreaterThanOrEqual(6);
    expect(operativeTechnique("nian")!.effect.needsDepthMm).toBe(0);
  });
});
