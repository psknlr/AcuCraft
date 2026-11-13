#!/usr/bin/env node
/**
 * The pictures of docs/img that are taken inside ClinicalCraft's own 3D world: the clinic's rooms and the skills
 * room as its renderer draws them — the pack's models, the people as its figure kit builds them, the needling
 * stations in the states of their drill. Nothing is composed or retouched: each picture is the canvas of the
 * world's QA page (world-harness.html) at a pose.
 *
 *   node tools/world-shots.mjs [--cc <ClinicalCraft checkout>] [--out docs/img] [--only <name>,…]
 *
 * Needs a ClinicalCraft checkout at the pinned revision with its dependencies installed ($CLINICALCRAFT_DIR, or
 * ../ClinicalCraft): the web world runs from source under vite, and its QA page bundles packages/content, so
 * the pack's catalog, room templates and facilities are copied there for the run — and removed again, whatever
 * happens. The models are served from a temporary home (never from the checkout). Needs `playwright` with its
 * Chromium. The QA page puts a demonstration patient of its own in the first patient slot: that is ClinicalCraft's
 * stand-in, not a patient of this pack. The player's own hand — in ClinicalCraft it holds a stethoscope — is
 * hidden; a run fails when a model of the pack did not load.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PACK = join(ROOT, "content", "world");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const CC = resolve(flag("--cc") ?? process.env.CLINICALCRAFT_DIR ?? join(ROOT, "..", "ClinicalCraft"));
const OUT = resolve(flag("--out") ?? join(ROOT, "docs", "img"));
const only = (flag("--only") ?? "").split(",").filter(Boolean);
if (!existsSync(join(CC, "node_modules", "vite")) || !existsSync(join(CC, "packages", "web", "world-harness.html"))) {
  console.error(`no ClinicalCraft checkout with its dependencies installed at ${CC} (--cc, or CLINICALCRAFT_DIR)`);
  process.exit(2);
}

/**
 * The pictures: a facility, where the camera stands (x, z on the floor plan; the eye is 1.6 m up), what it looks
 * at (x, z and a height), and the state each needling station is drawn in.
 */
const SHOTS = [
  { name: "clinic-3d-treatment-room", facility: "sg-tcm-outpatient", from: [-1.35, -1.75], at: [1.25, 0.75, -4.2] },
  { name: "clinic-3d-consult-room", facility: "sg-tcm-outpatient", from: [-3.55, -2.15], at: [-6.1, 0.85, -4.9] },
  { name: "clinic-3d-consult-desk", facility: "sg-tcm-outpatient", from: [-4.75, -3.9], at: [-6.05, 0.8, -5.2] },
  { name: "clinic-3d-reception", facility: "sg-tcm-outpatient", from: [-1.6, 5.1], at: [-5.0, 1.0, 2.5] },
  { name: "skills-3d-room", facility: "sg-tcm-skills-room", from: [3.0, 2.2], at: [-0.9, 0.8, -1.7], states: { "skills-room.station-prone": "retained", "skills-room.station-supine": "located" } },
  { name: "skills-3d-station-prone", facility: "sg-tcm-skills-room", from: [-1.2, -1.95], at: [-2.0, 0.87, -1.5], states: { "skills-room.station-prone": "retained" } },
  { name: "skills-3d-station-supine", facility: "sg-tcm-skills-room", from: [2.45, -0.55], at: [1.5, 0.8, -0.85], states: { "skills-room.station-supine": "needled" } },
  // not one of the documentation's pictures (`--only qa-couch-patient`): ClinicalCraft's stand-in patients in every
  // slot, to see a body the world lays on the clinic's couch — on the padding, the head on the pillow
  { name: "qa-couch-patient", facility: "sg-tcm-outpatient", query: "&patients=all", qa: true, from: [2.3, -2.6], at: [1.0, 0.75, -4.1] },
  // and the world's own walking (`--only qa-walk`): from the corridor, through the treatment room's door, to the side of the couch
  { name: "qa-walk", facility: "sg-tcm-outpatient", qa: true, from: [0.25, -0.25], at: [1.0, 0.75, -3.9], walk: [1.75, -3.75] },
];
const EYE = 1.6;

/* ------------------------------------------------------------------ */
/* the pack in the checkout, for the run only                          */
/* ------------------------------------------------------------------ */

const copied = [];
function cleanup() {
  for (const file of copied.splice(0)) rmSync(file, { force: true });
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

for (const dir of ["catalogs", "templates", "facilities"]) {
  for (const file of readdirSync(join(PACK, dir)).filter((f) => f.endsWith(".json"))) {
    const to = join(CC, "packages", "content", dir, file);
    if (existsSync(to)) throw new Error(`${to} exists: the checkout already has a file of that name`);
    copied.push(to);
    cpSync(join(PACK, dir, file), to);
  }
}
const home = mkdtempSync(join(tmpdir(), "acucraft-shots-"));
cpSync(join(PACK, "assets"), join(home, "assets"), { recursive: true });

/* ------------------------------------------------------------------ */
/* the world, served from source                                       */
/* ------------------------------------------------------------------ */

const port = 5300 + Math.floor(Math.random() * 400);
const vite = spawn(join(CC, "node_modules", ".bin", "vite"), ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: join(CC, "packages", "web"),
  env: { ...process.env, CLINICALCRAFT_HOME: home, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
const started = new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error(`vite did not start:\n${log}`)), 120_000);
  const seen = (d) => {
    log += d;
    if (/Local:\s+http/.test(log)) {
      clearTimeout(timer);
      ok();
    }
  };
  vite.stdout.setEncoding("utf8").on("data", seen);
  vite.stderr.setEncoding("utf8").on("data", seen);
  vite.on("exit", (code) => fail(new Error(`vite exited ${code}:\n${log}`)));
});

let failed = false;
let browser = null;
try {
  await started;
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  // 1280 × 720 CSS pixels drawn at 1.25: pictures of 1600 × 900
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.25, locale: "en-US" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 300)));
  let facility = null;
  for (const shot of SHOTS.filter((s) => (only.length ? only.includes(s.name) : !s.qa))) {
    const key = shot.facility + (shot.query ?? "");
    if (facility !== key) {
      await page.goto(`http://127.0.0.1:${port}/world-harness.html?facility=${shot.facility}&quality=high&locale=en&vitals=none${shot.query ?? ""}`);
      await page.waitForFunction(() => window.__READY__ === true && !!window.__WORLD__, null, { timeout: 180_000 });
      const shown = await page.evaluate(() => document.querySelector("#hud")?.textContent ?? "");
      if (!shown.includes(shot.facility)) throw new Error(`the QA page did not load ${shot.facility} (it shows: ${shown.slice(0, 80)})`);
      await page.addStyleTag({ content: "#bar,#hud,#toast,#issues,#mini,#target,#crosshair{display:none!important}" });
      // the models are fetched after the world is built: every one requested must have loaded
      await page.waitForLoadState("networkidle", { timeout: 120_000 });
      await page.waitForTimeout(2500);
      const world = await page.evaluate(() => {
        const d = window.__WORLD__.debug;
        // the player's hand is a child of the camera
        for (const child of d.camera.children) child.visible = false;
        return { models: JSON.parse(JSON.stringify(d.models, (k, v) => (v instanceof Map ? [...v.keys()] : v instanceof Set ? [...v] : v))), warnings: [...d.warnings] };
      });
      const lost = world.warnings.filter((w) => /model of/.test(w));
      if (lost.length) throw new Error(`${shot.facility}: models that did not load:\n  ${lost.join("\n  ")}`);
      console.log(`${shot.facility}: models ${JSON.stringify(world.models).slice(0, 160)}`);
      facility = key;
    }
    const pose = await page.evaluate(
      ({ shot, eye }) => {
        const w = window.__WORLD__;
        for (const [placement, state] of Object.entries(shot.states ?? {})) w.setEquipmentState(placement, state);
        const [x, z] = shot.from, [ax, ay, az] = shot.at;
        const dx = ax - x, dz = az - z;
        // a facing of 0 looks north (−Z) and grows turning left; the pitch is set by looking up or down from where it is
        w.teleport(x, z, Math.atan2(-dx, -dz));
        const want = Math.atan2(ay - eye, Math.hypot(dx, dz));
        const p0 = w.position.pitch;
        w.look(0, 100);
        const per = (p0 - w.position.pitch) / 100;
        if (per) w.look(0, (w.position.pitch - want) / per);
        return w.position;
      },
      { shot, eye: EYE },
    );
    if (shot.walk) {
      // the world plans and walks the way itself (its `walkTo`): it must arrive, through the door
      const arrived = await page.evaluate(async ([x, z]) => {
        const w = window.__WORLD__;
        await w.walkTo({ x, z });
        return w.position;
      }, shot.walk);
      const off = Math.hypot(arrived.x - shot.walk[0], arrived.z - shot.walk[1]);
      // (the world's own walk ends within a metre of the spot asked for)
      if (off > 1.0) throw new Error(`${shot.name}: the walk ended at (${arrived.x.toFixed(2)}, ${arrived.z.toFixed(2)}), ${off.toFixed(2)} m from (${shot.walk.join(", ")})`);
      console.log(`${shot.name}: walked from (${shot.from.join(", ")}) to (${arrived.x.toFixed(2)}, ${arrived.z.toFixed(2)})`);
    }
    await page.waitForTimeout(1500);
    const file = join(OUT, `${shot.name}.png`);
    await page.locator("#world").screenshot({ path: file });
    console.log(`${shot.name}: from (${pose.x.toFixed(2)}, ${pose.z.toFixed(2)}), facing ${pose.yaw.toFixed(2)}, pitch ${pose.pitch.toFixed(2)} → ${file}`);
  }
  if (errors.length) {
    failed = true;
    console.error(`page errors:\n  ${errors.join("\n  ")}`);
  }
} catch (e) {
  failed = true;
  console.error(String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  vite.kill("SIGTERM");
  cleanup();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
