/**
 * Where the body of a needling station is, for the model that has to fit it.
 *
 * A station's body is not part of its model: ClinicalCraft's world draws it with its own figure kit (the type's
 * `manikin`: ClinicalCraft docs/FACILITIES.md "A body drawn with equipment"), the same figures as the people of the
 * world. The model — the couch, the pillow, and what each step of the drill puts on the skin: the marks, the
 * needles — is built in Blender round that body, so it needs to know where the skin is. This tool asks the pinned
 * ClinicalCraft's own code — it builds the manikin as the world does and casts a ray at each site onto the meshes
 * that are drawn — and writes what it finds, in the type's frame (metres; x right, y up, z front; origin at the
 * footprint centre on the floor), to tools/blender/fit/<type>.json, which tools/blender/models.py reads.
 *
 * The sites are points this pack's own reference courses use, at the depths they use, placed on the simulator by
 * proportional measurement of its own body (`SITES` below). That is a drawing aid for a teaching station — schematic and
 * unreviewed, like the rest of this release's anatomy — and no guide to locating a point on a person.
 *
 *   npx tsx tools/figure-fit.mts [--check]
 *
 * `--check` writes nothing and fails when a file on disk is not what the engine says now (tools/check.sh runs it:
 * a figure that changes shape upstream must not leave the model fitted to the old one). It also fails when a
 * site is not on bare skin (under a towel, on hair), or when a look of the station moves the body: the model is
 * built round one body in one position.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type V3 = readonly [number, number, number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = fs.realpathSync(path.join(root, ".deps", "clinicalcraft"));
const check = process.argv.includes("--check");
if (!fs.existsSync(path.join(engine, "packages/web/src/world/manikin.ts"))) {
  console.error("no ClinicalCraft checkout in .deps/clinicalcraft: run `npm run bootstrap`");
  process.exit(2);
}
const from = (rel: string) => import(pathToFileURL(path.join(engine, rel)).href);
// (three as the figure kit itself resolves it: one copy of the library for the rig and for the rays)
const THREE = await import(pathToFileURL(createRequire(path.join(engine, "packages/web/src/world/npc.ts")).resolve("three")).href);
const { buildManikin, placedPoint } = await from("packages/web/src/world/manikin.ts");
const { limbPoint } = await from("packages/web/src/world/figure/body.ts");
const { HIP } = await from("packages/web/src/world/figure/anatomy.ts");
const { EquipmentManikinSchema } = await from("packages/core/src/schema/facility.ts");
const { drawnManikin } = await from("packages/core/src/engine/looks.ts");

interface Rig { root: any; body: any; head: any; skin: { mesh: any; ranges: [number, number][] }[]; frame: { wide: number; scale: number }; skeleton: { arms: any[]; legs: any[] } }

/** A site on the simulator: the point it stands for, where a ray is aimed in the upright figure's own frame, and the way it comes from. */
interface Site { id: string; point: string; side: "left" | "right" | "midline"; anchor: (rig: Rig) => V3; from: (rig: Rig) => V3; reach: number; depthCm: number; tiltDeg?: number; note: string }

/**
 * Proportional measurement on the simulator's own body. On the back: the fourth lumbar spinous process on the line
 * between the tops of the hip bones, some 13 cm above the hip joint; two vertebrae are 7.2 cm; 1.5 cun from the
 * midline is 3.75 cm on a body of average width (8 cun between the nipples). On a limb, a point is a share of
 * the bone's length (`limbPoint`: 0 … 1 down the first bone, 1 … 2 down the second): 12 cun from the elbow crease
 * to the wrist crease, 16 from the knee to the outer ankle, 13 from the knee to the inner ankle.
 */
const L4 = HIP + 0.125;
const CUN_BACK = 0.025;

const sign = (side: Site["side"]) => (side === "left" ? 1 : side === "right" ? -1 : 0);
const unit = (v: V3): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};

function back(id: string, point: string, side: Site["side"], cun: number, above: number, depthCm: number, note: string, tiltDeg = 0): Site {
  // straight down onto the back from behind it (the figure's own −Z)
  return { id, point, side, anchor: (rig) => [sign(side) * cun * CUN_BACK * rig.frame.wide, L4 + above, 0], from: () => [0, 0, -1], reach: 0.3, depthCm, tiltDeg, note };
}
function onLimb(id: string, point: string, side: "left" | "right", which: "arms" | "legs", t: number, dir: (s: number, limb: any) => V3, reach: number, depthCm: number, note: string): Site {
  // (a skeleton gives both limbs of a pair as the left one: the right is its mirror)
  const mirror = (p: V3): V3 => [sign(side) * p[0], p[1], p[2]];
  const limbOf = (rig: Rig) => rig.skeleton[which][side === "left" ? 0 : 1];
  return {
    id, point, side, reach, depthCm, note,
    anchor: (rig) => {
      const q = limbPoint(limbOf(rig), t);
      return mirror([q.x, q.y, q.z]);
    },
    from: (rig) => mirror(unit(dir(1, limbOf(rig)))),
  };
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const SITES: Record<string, Site[]> = {
  // the lumbar points of the low-back-pain family (content/families/sg-low-back-pain), as its reference course needles
  // them: perpendicular to 1.8 cm, GV3 to 1.5 cm at 20° towards the head
  "acu-needling-station-prone": [
    ...(["left", "right"] as const).map((side) => back(`BL23-${side}`, "BL23", side, 1.5, 0.072, 1.8, "1.5 cun beside the lower border of the second lumbar spinous process")),
    ...(["left", "right"] as const).map((side) => back(`BL25-${side}`, "BL25", side, 1.5, 0, 1.8, "1.5 cun beside the lower border of the fourth lumbar spinous process")),
    back("GV3", "GV3", "midline", 0, 0, 1.5, "on the midline below the fourth lumbar spinous process", 20),
  ],
  // limb points of the nausea and insomnia families, at their reference courses' depths: PC6 on the palmar forearm,
  // ST36 below the knee, SP6 above the inner ankle
  "acu-needling-station-supine": (["left", "right"] as const).flatMap((side) => [
    onLimb(`PC6-${side}`, "PC6", side, "arms", 2 - 2 / 12, (_s, limb) => limb.face as V3, 0.07, 1.0, "2 cun above the wrist crease, between the two tendons"),
    onLimb(`ST36-${side}`, "ST36", side, "legs", 1 + 3 / 16, () => [Math.sin(rad(38)), 0, Math.cos(rad(38))], 0.1, 2.0, "3 cun below the outer eye of the knee, a finger's breadth outside the shin's crest"),
    onLimb(`SP6-${side}`, "SP6", side, "legs", 2 - 3 / 13, () => [-Math.cos(rad(32)), 0, Math.sin(rad(32))], 0.075, 1.5, "3 cun above the tip of the inner ankle, behind the shin bone's inner border"),
  ]),
};

/** What a state's look may change of the body without moving it. */
const CLOTH_ONLY = new Set(["cover", "breathing", "asleep"]);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const arr = (v: { x: number; y: number; z: number }): number[] => [r4(v.x), r4(v.y), r4(v.z)];

const catalog = JSON.parse(fs.readFileSync(path.join(root, "content/world/catalogs/acucraft-tcm.json"), "utf8")) as {
  equipment: { id: string; manikin?: unknown; behavior?: { states?: Record<string, { look?: { manikin?: Record<string, unknown> } }> } }[];
};
let stale = 0, fitted = 0;
for (const type of catalog.equipment) {
  if (!type.manikin) continue;
  const sites = SITES[type.id];
  if (!sites) throw new Error(`${type.id}: a body, and no sites for it in tools/figure-fit.mts`);
  const m = EquipmentManikinSchema.parse(type.manikin);
  if (m.posture !== "prone" && m.posture !== "lying") throw new Error(`${type.id}: this tool fits a body lying flat`);
  for (const [state, st] of Object.entries(type.behavior?.states ?? {})) {
    const moved = Object.keys(st.look?.manikin ?? {}).filter((k) => !CLOTH_ONLY.has(k));
    if (moved.length) throw new Error(`${type.id}: state "${state}" changes the manikin's ${moved.join(", ")} — the model is built round one body in one position`);
  }
  const drawn = drawnManikin(m);
  const rig: Rig = buildManikin(drawn, { x: 0, y: 0, z: 0, rot: 0 }, type.id);
  rig.root.updateMatrixWorld(true);
  const meshes: any[] = [];
  rig.root.traverse((o: any) => {
    if (o.isMesh && o.userData.figure) meshes.push(o);
  });
  const at = (p: V3) => placedPoint(rig, p);
  const way = (p: V3, d: V3) => at([p[0] + d[0], p[1] + d[1], p[2] + d[2]]).sub(at(p)).normalize();
  const ray = new THREE.Raycaster();
  /** The first drawn surface a ray from `origin` along `dir` meets: where, its outward normal, and whether it is skin. */
  const cast = (origin: any, dir: any, far: number) => {
    ray.set(origin, dir);
    ray.far = far;
    // (a rig's meshes take no aim in the world — its unseen box does: ask the meshes themselves)
    const hits: any[] = [];
    for (const mesh of meshes) THREE.Mesh.prototype.raycast.call(mesh, ray, hits);
    const hit = hits.sort((a, b) => a.distance - b.distance)[0];
    if (!hit) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.dot(dir) > 0) n.negate();
    const skin = rig.skin.some((s) => s.mesh === hit.object && s.ranges.some(([start, count]) => hit.face.a >= start && hit.face.a < start + count));
    return { p: hit.point.clone(), n, skin };
  };

  const out: Record<string, unknown> = {};
  for (const site of sites) {
    const anchor = site.anchor(rig), d = site.from(rig);
    const inward = way(anchor, [-d[0], -d[1], -d[2]]);
    const origin = at(anchor).addScaledVector(inward, -site.reach);
    const hit = cast(origin, inward, site.reach * 2);
    if (!hit) throw new Error(`${type.id}: nothing of the body at ${site.id}`);
    if (!hit.skin) throw new Error(`${type.id}: ${site.id} is not on bare skin (a towel, the hair or a garment covers it)`);
    // the way out of the skin there: across four rays 4 mm round the site, not one facet's own normal
    const along = way(anchor, [0, 1, 0]);
    along.addScaledVector(inward, -along.dot(inward)).normalize();
    const across = new THREE.Vector3().crossVectors(inward, along).normalize();
    const near = (dir: any, by: number) => cast(origin.clone().addScaledVector(dir, by), inward, site.reach * 2);
    const [a, b, c, d2] = [near(along, 0.004), near(along, -0.004), near(across, 0.004), near(across, -0.004)];
    const n = a && b && c && d2 ? new THREE.Vector3().crossVectors(a.p.clone().sub(b.p), c.p.clone().sub(d2.p)).normalize() : hit.n.clone();
    if (n.dot(inward) > 0) n.negate();
    if (n.dot(hit.n) < 0.9) throw new Error(`${type.id}: the skin at ${site.id} is not smooth enough to stand a needle on (an edge of the body's meshes)`);
    // the way up the body there (towards the head; on a limb, towards its root), square to the skin
    const up = along.clone().addScaledVector(n, -along.dot(n)).normalize();
    out[site.id] = { point: site.point, side: site.side, p: arr(hit.p), n: arr(n), up: arr(up), depthCm: site.depthCm, tiltDeg: site.tiltDeg ?? 0, where: site.note };
  }

  // the head, for what lies under it: the joint it turns about, and the lowest point of it over the couch (a pillow
  // fills what is under that; a breathing hole lies under the face)
  const head = rig.head.getWorldPosition(new THREE.Vector3());
  let under: { y: number; z: number } | null = null;
  for (let z = head.z - 0.2; z <= head.z + 0.1001; z += 0.005) {
    const hit = cast(new THREE.Vector3(head.x, (m.y ?? 0) - 0.05, z), new THREE.Vector3(0, 1, 0), 0.6);
    if (hit && hit.p.z < head.z + 0.03 && (!under || hit.p.y < under.y)) under = { y: hit.p.y, z: hit.p.z };
  }
  // how far the body reaches, the cloth on it included
  const box = new THREE.Box3();
  for (const mesh of meshes) box.union(new THREE.Box3().setFromObject(mesh, true));

  const fit = {
    type: type.id,
    note: "Written by tools/figure-fit.mts from the pinned ClinicalCraft's figure kit: do not edit. Metres, the type's frame.",
    manikin: { posture: drawn.posture, cover: drawn.cover, x: m.x ?? 0, y: m.y ?? 0, z: m.z ?? 0, rot: m.rot ?? 0, appearance: m.appearance ?? {} },
    surface: r4(m.y ?? 0),
    head: { joint: arr(head), lowest: under ? [r4(under.y), r4(under.z)] : null },
    reach: { min: arr(box.min), max: arr(box.max) },
    sites: out,
  };
  const file = path.join(root, "tools/blender/fit", `${type.id}.json`);
  const text = JSON.stringify(fit, null, 2) + "\n";
  fitted++;
  if (check) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (have !== text) {
      stale++;
      console.error(`${type.id}: tools/blender/fit/${type.id}.json is not what the pinned figure kit says — run \`npx tsx tools/figure-fit.mts\`, then rebuild the model (tools/blender/build.py ${type.id})`);
    } else console.log(`${type.id}: the model's measurements are the pinned figure kit's (${sites.length} sites, all on bare skin)`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`${type.id}: ${sites.length} sites on bare skin → tools/blender/fit/${type.id}.json`);
  }
}
if (!fitted) throw new Error("the catalog has no type with a body");
process.exit(stale ? 1 : 0);
