/**
 * Authoring aid: print a scenario's patient-specific landmarks and point locations (the hidden reference),
 * in the configuration a given patient position puts each region in.
 *
 *   npx tsx tools/locate.ts sg-knee-oa/base supine-knee-flexed ST35:right ST36:right
 */
import { patientRegion, pointInstance, regionAccess, type Position, type Side } from "@acucraft/core";
import { loadContentPack, requireScenario } from "@acucraft/bench";

const [id, position, ...points] = process.argv.slice(2);
if (!id || !position) {
  console.error("usage: tsx tools/locate.ts <family/variant> <position> [POINT:side ...]");
  process.exit(2);
}
const sc = requireScenario(loadContentPack(), id);
for (const regionId of sc.field.regions) {
  const region = sc.bundle.regions.get(regionId)!;
  const sides: Side[] = region.laterality === "bilateral" ? ["left", "right"] : ["midline"];
  for (const side of sides) {
    const access = regionAccess(region, side, position as Position);
    const frame = patientRegion(sc, regionId, side, access.configuration);
    console.log(`${regionId} ${side} (${access.accessible ? access.configuration : `not reachable: ${access.reason}`})`);
    for (const lm of region.landmarks) {
      const p = frame.landmark(lm.id)!;
      console.log(`  ${lm.id.padEnd(32)} u=${p.u.toFixed(2)} v=${p.v.toFixed(2)}`);
    }
    for (const seg of region.segments) console.log(`  ${seg.id.padEnd(32)} ${frame.segmentCm(seg.id)!.toFixed(2)} cm, cun ${frame.cunCm(seg.id)!.toFixed(3)} cm`);
  }
}
for (const spec of points) {
  const [pid, side] = spec.split(":");
  const def = sc.bundle.acupoints.get(pid!);
  if (!def?.region) {
    console.log(`${spec}: not localised`);
    continue;
  }
  const region = sc.bundle.regions.get(def.region)!;
  const access = regionAccess(region, (def.bilateral ? side : "midline") as Side, position as Position);
  const inst = pointInstance(sc, def, (side ?? "midline") as Side, access.configuration);
  console.log(inst ? `${spec.padEnd(16)} u=${inst.position.u.toFixed(2)} v=${inst.position.v.toFixed(2)} tol=${inst.toleranceCm.toFixed(2)} cfg=${inst.configuration}${inst.configurationMismatch ? " (mismatch)" : ""}` : `${spec}: no instance`);
}
