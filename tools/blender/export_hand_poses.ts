/**
 * Export the articulated hand's actual runtime controls and material attachments.
 *
 * npx tsx tools/blender/export_hand_poses.ts --input path/to/calibration.glb
 *
 * The input GLB supplies immutable source geometry and attachment frames. Its
 * animations are deliberately ignored; the live controller supplies every key.
 * The recorded input hash identifies calibration input, not a circular hash of
 * the GLB subsequently rebuilt from this choreography.
 */
import "../test/browser-images.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Object3D } from "three";
import type { FingerPose, HandPose } from "../../packages/server/web/stage/hand.js";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
interface MaterialRole {
  surface: string;
  normalField: string;
  definition: unknown;
  engaged?: boolean;
  /** The real counterpart, e.g. needle handle or the opposing preparation pad. */
  engagedWith?: string;
}
interface MaterialAttachment extends MaterialRole {
  position: Vec3;
  quaternion: Quat;
  parent: string;
}
interface MaterialProvider {
  materialContacts(): Record<string, MaterialRole>;
}
interface Sample {
  rotations: Record<string, Quat>;
  modelPosition: Vec3;
  modelQuaternion: Quat;
  materials: Record<string, MaterialAttachment>;
  correctives: Record<string, number>;
}
interface MaterialDefinitionKey { frame: number; definition: unknown; engaged?: boolean; engagedWith?: string }
interface MaterialTrackDefinition { parent: string; surface: string; normalField: string; keys: MaterialDefinitionKey[] }

const repo = fileURLToPath(new URL("../../", import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write("Usage: tsx tools/blender/export_hand_poses.ts [--input calibration.glb] [--output hand_poses.json]\n");
  process.stdout.write("Exports nine poses; open/scrape use 31 samples and flick uses 34 event-preserving samples.\n");
  process.exit(0);
}
const options: Record<string, string> = {};
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i], value = argv[i + 1];
  if ((flag !== "--input" && flag !== "--output") || !value || value.startsWith("--")) {
    throw new Error(`Unknown or incomplete export option: ${flag}`);
  }
  options[flag] = value;
}
const input = options["--input"] ? resolve(options["--input"]) : resolve(repo, "content/world/assets/models/acu-practitioner-hand.glb");
const output = options["--output"] ? resolve(options["--output"]) : resolve(repo, "tools/blender/hand_poses.json");
const sourcePaths = {
  hand: resolve(repo, "packages/server/web/stage/hand.ts"),
  physiology: resolve(repo, "packages/server/web/stage/hand-physiology.ts"),
  nailWork: resolve(repo, "packages/server/web/stage/hand-nail-work.ts"),
  anatomy: resolve(repo, "tools/blender/hand_anatomy.json"),
  builder: resolve(repo, "tools/blender/build_hand.py"),
  correctives: resolve(repo, "tools/blender/hand_thumb_web_correctives.json"),
  exporter: fileURLToPath(import.meta.url),
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path: string) => hash(readFileSync(path));
const sourceHashes = Object.fromEntries(Object.entries(sourcePaths).map(([name, path]) => [name, hashFile(path)]));
// Follow the real controller imports; a short explicit list must not miss
// extracted motion logic or the live corrective evaluator.
function controllerSources(entry: string): string[] {
  const seen = new Set<string>(), pending = [entry];
  const aliases: Record<string, string> = {
    "@acucraft/core": resolve(repo, "packages/core/src/index.ts"),
    "@clinicalcraft/core": resolve(repo, ".deps/clinicalcraft/packages/core/src/index.ts"),
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imported of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      const specifier = imported.fileName;
      let candidates: string[] = [];
      if (specifier.startsWith(".")) {
        const path = resolve(dirname(file), specifier);
        candidates = /\.m?js$/.test(path) ? [path.replace(/\.mjs$/, ".mts").replace(/\.js$/, ".ts"), path] : [path, `${path}.ts`, resolve(path, "index.ts")];
      } else if (aliases[specifier]) candidates = [aliases[specifier]!];
      const dependency = candidates.find(path => existsSync(path) && statSync(path).isFile());
      if (dependency && !seen.has(dependency)) pending.push(dependency);
    }
  }
  return [...seen].sort();
}
const runtimeModules = controllerSources(sourcePaths.hand);
const runtimeModuleHashes = Object.fromEntries(runtimeModules.map(path => [relative(repo, path), hashFile(path)]));
const inputBytes = readFileSync(input), inputHash = hash(inputBytes);
// Read hashes before dynamic import, then verify them after loading and again
// before publishing. A restarted or edited runtime cannot silently mix proofs.
const { ArticulatedHand } = await import("../../packages/server/web/stage/hand.js");
const sourcesStable = () => Object.entries(sourcePaths).every(([name, path]) => hashFile(path) === sourceHashes[name])
  && runtimeModules.every(path => hashFile(path) === runtimeModuleHashes[relative(repo, path)]);
if (!sourcesStable()) throw new Error("Hand source changed while loading the pose exporter");
const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(inputBytes).buffer, "");
const source = gltf.scene.getObjectByName("acu_practitioner_hand");
if (source?.userData.builderSourceSha256 !== sourceHashes.builder
  || source?.userData.anatomySourceSha256 !== sourceHashes.anatomy
  || source?.userData.correctiveSourceSha256 !== sourceHashes.correctives) {
  throw new Error("Calibration geometry does not match the current hand builder/anatomy/correctives; export a fresh --calibration-only GLB before sampling poses");
}
if (!gltf.scene.getObjectByName("index_nail_edge_contact")) {
  throw new Error("Calibration GLB lacks the actual index free-edge source attachment; rebuild the current hand source first");
}
const hand = new ArticulatedHand(gltf.scene, [], "#d2a389");
const provider = hand as unknown as MaterialProvider;
if (typeof provider.materialContacts !== "function") {
  hand.dispose();
  throw new Error("Runtime materialContacts() provenance is unavailable; finish the hand roles before exporting choreography");
}
const digits = ["thumb", "index", "middle", "ring", "little"] as const;
const joints = ["proximal", "middle", "distal"] as const;
const labels = { thumb: ["CMC", "MCP", "IP"], index: ["MCP", "PIP", "DIP"], middle: ["MCP", "PIP", "DIP"], ring: ["MCP", "PIP", "DIP"], little: ["MCP", "PIP", "DIP"] } as const;
const names = digits.flatMap(digit => joints.map(joint => `${digit}_${joint}`));
const node = (name: string): Object3D => {
  const result = hand.model.getObjectByName(name);
  if (!result) throw new Error(`Missing source hand control: ${name}`);
  return result;
};
const fixedBones = digits.flatMap(digit => [
  ...labels[digit].map(label => node(`${digit}_${label}`)),
  ...joints.map(joint => node(`${digit}_${joint}`)),
  node(`${digit}_tip`),
]).map(control => ({ control, position: control.position.clone(), scale: control.scale.clone() }));
const requirePlainData = (value: unknown, location: string): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location}: non-finite provenance`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, i) => requirePlainData(entry, `${location}[${i}]`)); return; }
  if (typeof value === "object") { Object.entries(value).forEach(([key, entry]) => requirePlainData(entry, `${location}.${key}`)); return; }
  throw new Error(`${location}: material provenance must be explicit JSON data`);
};
const expectedMaterials = (pose: HandPose): string[] => pose === "palpate" ? ["index_volar_contact"]
  : pose === "tripod" ? ["thumb_pad_contact", "index_pad_contact", "middle_side_contact"]
  : pose === "scrape" ? ["thumb_pad_contact", "index_nail_edge_contact"]
  : pose === "flick" ? ["thumb_pad_contact", "index_pad_contact", "index_nail_edge_contact"]
  : ["thumb_pad_contact", "index_pad_contact"];

function sample(pose: HandPose, grip = 1, phase = 0, nailContact = phase): Sample {
  const scaleIsRigid = () => hand.model.scale.toArray().every(value => Math.abs(Math.abs(value)-1) <= 1e-12);
  if (!scaleIsRigid()) throw new Error("Source hand model has non-unit scale before capture");
  const settings: FingerPose = { pose, grip, phase, nailContact, apertureMm: 12, stabilizerGrip: grip,
    handleRadiusM: ["palpate", "press", "stretch"].includes(pose) ? undefined : 0.0007,
    wristElevationDeg: pose === "tripod" ? 48 : 55, gripStyle: "tip-pinch", idleFingerPose: "curled" };
  hand.setSide("right"); hand.root.position.set(0, 0, 0); hand.root.quaternion.identity();
  hand.pose(settings); hand.model.updateMatrixWorld(true);
  if (!scaleIsRigid()) throw new Error("Runtime scaled the hand model during capture");
  if (!hand.contactValid) throw new Error(`Invalid runtime hand contact: ${pose}, grip=${grip}, phase=${phase}`);
  for (const fixed of fixedBones) {
    if (fixed.control.position.distanceTo(fixed.position) > 1e-12 || fixed.control.scale.distanceTo(fixed.scale) > 1e-12) {
      throw new Error(`Runtime changed a bone pivot or scale: ${fixed.control.name}`);
    }
  }
  const rotations: Record<string, Quat> = {};
  for (const digit of digits) for (let i = 0; i < 3; i++) {
    const name = `${digit}_${joints[i]}`;
    const combined = node(`${digit}_${labels[digit][i]}`).quaternion.clone().multiply(node(name).quaternion).normalize();
    if (!combined.toArray().every(Number.isFinite)) throw new Error(`Non-finite bone rotation: ${name}`);
    rotations[name] = combined.toArray() as Quat;
  }
  const declarations = provider.materialContacts(), actualNames = Object.keys(declarations).sort();
  const expected = expectedMaterials(pose).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) throw new Error(`${pose}: canonical material roles differ: ${actualNames}`);
  const materials: Record<string, MaterialAttachment> = {};
  for (const name of expected) {
    const alias = node(name), role = declarations[name]!;
    if (!name.endsWith("_contact") || !alias.parent || !role.surface || !role.normalField || !hand.model.getObjectByName(role.surface)) {
      throw new Error(`Material role is not attached to a real source surface: ${name}`);
    }
    if (!role.definition || typeof role.definition !== "object" || Array.isArray(role.definition)) throw new Error(`${pose}/${name}: an explicit material definition object is required`);
    if (role.engaged !== undefined && typeof role.engaged !== "boolean") throw new Error(`${pose}/${name}: engagement must be boolean`);
    if (role.engagedWith !== undefined && (typeof role.engagedWith !== "string" || !role.engagedWith)) throw new Error(`${pose}/${name}: an explicit interaction counterpart is required`);
    requirePlainData(role.definition, `${pose}/${name}`);
    if (![...alias.position.toArray(), ...alias.quaternion.toArray()].every(Number.isFinite)) throw new Error(`Non-finite material frame: ${name}`);
    materials[name] = { position: alias.position.toArray() as Vec3, quaternion: alias.quaternion.toArray() as Quat,
      parent: alias.parent.name, surface: role.surface, normalField: role.normalField,
      definition: JSON.parse(JSON.stringify(role.definition)) as unknown, ...(role.engaged === undefined ? {} : { engaged: role.engaged }),
      ...(role.engagedWith === undefined ? {} : { engagedWith: role.engagedWith }) };
  }
  const correctives = hand.skinCorrectiveWeights();
  requirePlainData(correctives, `${pose}/skinCorrectives`);
  return { rotations, modelPosition: hand.model.position.toArray() as Vec3,
    modelQuaternion: hand.model.quaternion.toArray() as Quat, materials, correctives };
}

const requests: Record<string, [HandPose, number, number, number?]> = {
  pinch: ["pinch", 1, 0], open: ["pinch", 0, 0], support: ["palpate", 1, 0],
  three_finger: ["tripod", 1, 0], scrape_start: ["scrape", 1, 0, 0], scrape_end: ["scrape", 1, 1, 1],
  flick_loaded: ["flick", 1, 0.2], flick_release: ["flick", 1, 0.5], flick_return: ["flick", 1, 1],
};
const poses: Record<string, Record<string, Quat>> = {}, poseFrames: Record<string, Pick<Sample, "modelPosition" | "modelQuaternion">> = {};
const materialPoses: Record<string, Record<string, MaterialAttachment>> = {}, activeContacts: Record<string, string[]> = {};
const correctivePoses: Record<string, Record<string, number>> = {};
const sequences: Record<string, { samplingTimes: number[]; joints: string[]; frames: [number, ...Quat[]][]; modelFrames: [number, Vec3, Quat][];
  contactFrames: Record<string, [number, Vec3, Quat][]>; materialDefinitions: Record<string, MaterialTrackDefinition>;
  correctiveFrames: Record<string, [number, number][]> }> = {};
try {
  for (const [name, args] of Object.entries(requests)) {
    const value = sample(...args);
    poses[name] = value.rotations; poseFrames[name] = { modelPosition: value.modelPosition, modelQuaternion: value.modelQuaternion };
    correctivePoses[name] = value.correctives;
    materialPoses[name] = value.materials; activeContacts[name] = Object.keys(value.materials);
  }
  for (const name of ["open", "scrape", "flick"] as const) {
    // Keep the normal sampling density and the actual Tan contact/recovery
    // events. Uniform 30 fps alone misses the .28 strike and .58 preparation.
    const samplingTimes = [...new Set([...Array.from({ length: 31 }, (_, i) => i / 30), ...(name === "flick" ? [0.08, 0.28, 0.5, 0.58] : [])])].sort((a, b) => a - b);
    const sequence = { samplingTimes, joints: names, frames: [] as [number, ...Quat[]][], modelFrames: [] as [number, Vec3, Quat][],
      contactFrames: {} as Record<string, [number, Vec3, Quat][]>, materialDefinitions: {} as Record<string, MaterialTrackDefinition>,
      correctiveFrames: {} as Record<string, [number, number][]> };
    let expected: string[] | undefined;
    let expectedCorrectives: string[] | undefined;
    for (const time of samplingTimes) {
      const frame = 1 + 30 * time;
      const value = name === "open" ? sample("pinch", 1 - time, 0) : sample(name, 1, time, time);
      const current = Object.keys(value.materials);
      expected ??= current;
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`${name}: active material channels changed during the clip`);
      sequence.frames.push([frame, ...names.map(joint => value.rotations[joint]!)]);
      sequence.modelFrames.push([frame, value.modelPosition, value.modelQuaternion]);
      const correctiveNames = Object.keys(value.correctives).sort();
      expectedCorrectives ??= correctiveNames;
      if (JSON.stringify(correctiveNames) !== JSON.stringify(expectedCorrectives)) throw new Error(`${name}: corrective target channels changed during the clip`);
      for (const [target, weight] of Object.entries(value.correctives)) (sequence.correctiveFrames[target] ??= []).push([frame, weight]);
      for (const [contact, material] of Object.entries(value.materials)) {
        (sequence.contactFrames[contact] ??= []).push([frame, material.position, material.quaternion]);
        const definition = sequence.materialDefinitions[contact] ??= { parent: material.parent, surface: material.surface, normalField: material.normalField, keys: [] };
        if (definition.parent !== material.parent || definition.surface !== material.surface || definition.normalField !== material.normalField) {
          throw new Error(`${name}/${contact}: material topology or normal definition changed during a clip`);
        }
        const last = definition.keys.at(-1);
        if (!last || JSON.stringify(last.definition) !== JSON.stringify(material.definition) || last.engaged !== material.engaged || last.engagedWith !== material.engagedWith) {
          definition.keys.push({ frame, definition: material.definition, ...(material.engaged === undefined ? {} : { engaged: material.engaged }),
            ...(material.engagedWith === undefined ? {} : { engagedWith: material.engagedWith }) });
        }
      }
    }
    sequences[name] = sequence;
  }
  if (!sourcesStable() || hashFile(input) !== inputHash) throw new Error("Hand geometry or controller changed while sampling; nothing was written");
  const result = {
    schemaVersion: 2,
    description: "Runtime-sampled fixed-length hand animation with actual skin material points and index nail free-edge contact roles. Authored visualization, not motion capture or clinical calibration.",
    quaternionOrder: "xyzw",
    provenance: {
      calibrationInputAsset: { path: isAbsolute(input) ? relative(repo, input) : input, sha256: inputHash, role: "immutable geometry calibration input; not the subsequently rebuilt GLB output hash" },
      sources: Object.fromEntries(Object.entries(sourcePaths).map(([name, path]) => [name, { path: relative(repo, path), sha256: sourceHashes[name] }])),
      runtimeModules: runtimeModuleHashes,
      animationsRead: false, runtimeContactsValidAtEveryExportedFrame: true,
    },
    poses, poseFrames, materialPoses, activeContacts, correctivePoses, sequences,
  };
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n"); renameSync(temporary, output);
  process.stdout.write(JSON.stringify({ output, inputAssetSha256: inputHash, poses: Object.keys(poses).length,
    sequences: Object.fromEntries(Object.entries(sequences).map(([name, sequence]) => [name, sequence.frames.length])), sourceHashes }) + "\n");
} finally {
  hand.dispose();
}
