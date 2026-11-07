/**
 * Authoring aid: what a perpendicular needle meets under each localised point, on a scenario's patient.
 *
 *   npx tsx tools/anatomy/probe.ts [family/variant] [REGION|POINT ...]
 *
 * For each point: its patient-specific location, the layer stack under it, the depth at which bone stops a needle,
 * the depth of the pleura or of the first critical layer, and the structures within 1 cm of a 6 cm perpendicular
 * path (clearance in cm). Hidden geometry: never show it to an agent under test.
 */
import { assessPath, patientRegion, pointInstance, regionAccess, type Side } from "@acucraft/core";
import { loadContentPack, requireScenario } from "@acucraft/bench";

const args = process.argv.slice(2);
const pack = loadContentPack();
const scenarioId = args[0]?.includes("/") ? args.shift()! : "sg-knee-oa/base";
const sc = requireScenario(pack, scenarioId);
const filters = new Set(args);
const fmt = (n: number) => n.toFixed(2);

for (const def of pack.bundle.acupoints.values()) {
  if (!def.region || !def.localisation) continue;
  if (filters.size > 0 && !filters.has(def.id) && !filters.has(def.region)) continue;
  const region = pack.bundle.regions.get(def.region)!;
  const side: Side = def.bilateral ? "right" : "midline";
  const cfg = def.configuration ?? regionAccess(region, side, region.access[0]!.position).configuration;
  const inst = pointInstance(sc, def, side, cfg);
  if (!inst) {
    console.log(`${def.id.padEnd(8)} no instance`);
    continue;
  }
  const frame = patientRegion(sc, def.region, inst.side, cfg);
  const layers = frame.layersAt(inst.position);
  let top = 0;
  let bone: number | null = null;
  let critical: string | null = null;
  for (const l of layers) {
    if (bone === null && l.tissue === "bone") bone = top;
    if (critical === null && (l.tissue === "pleura" || l.hazard === "critical")) critical = `${l.label ?? l.tissue} at ${fmt(top)}`;
    top += l.thicknessCm;
  }
  const path = assessPath(frame, inst.position, 0, 0, 6, { diameterMm: 0.25, lengthMm: 75 });
  const near = frame.structures
    .map((s) => {
      const deep = assessPath({ ...frame, structures: [s] }, inst.position, 0, 0, 6, { diameterMm: 0.25, lengthMm: 75 });
      return deep.findings[0] ? `${s.id}${s.hazard === "critical" ? "!" : ""} ${fmt(deep.findings[0].clearanceCm)}` : null;
    })
    .filter(Boolean);
  console.log(
    `${def.id.padEnd(8)} ${def.region}/${cfg} u=${fmt(inst.position.u)} v=${fmt(inst.position.v)} | ${layers.map((l) => `${l.tissue}${l.label ? `(${l.label})` : ""} ${fmt(l.thicknessCm)}`).join(", ")} | bone ${bone === null ? "-" : fmt(bone)} | critical ${critical ?? "-"} | stopped ${path.stoppedBy ?? "-"} | near: ${near.join("; ") || "-"}`,
  );
}
