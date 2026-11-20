import {
  LinearSRGBColorSpace, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera,
  PlaneGeometry, Scene, WebGLRenderer,
} from "three";
import { exteriorGeometry, exteriorShape, updateExteriorGeometry } from "../../web/stage/needle-shape.js";
import { exteriorShaftMaterial } from "../../web/stage/needle-shaft-material.js";

const width = 144, height = 128;
const renderer = new WebGLRenderer({ antialias: false });
renderer.outputColorSpace = LinearSRGBColorSpace;
renderer.setSize(width, height);
renderer.setClearColor(0xffffff);
const scene = new Scene();
const camera = new OrthographicCamera(-.072, .072, .064, -.064, .01, 1);
camera.position.z = .2;

// At this scale a 0.25 mm steel shaft covers a quarter of a pixel.
const geometry = exteriorGeometry(), straight = { x: 0, z: 0 };
updateExteriorGeometry(geometry, exteriorShape(.1, straight, straight).points, .000125);
const steel = new MeshStandardMaterial({ color: 0x151515, emissive: 0x080808 });
const filteredSteel = exteriorShaftMaterial(steel);
const shaft = new Mesh(geometry, filteredSteel);
shaft.position.y = -.05;
shaft.rotation.z = .07;
scene.add(shaft);
const blocker = new Mesh(new PlaneGeometry(.15, .018), new MeshBasicMaterial({ color: 0xffffff }));
blocker.position.z = .005;
scene.add(blocker);

function pixels(): Uint8Array {
  renderer.render(scene, camera);
  const gl = renderer.getContext(), buffer = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  return buffer;
}

function darkness(frame: Uint8Array, y: number): number {
  let sum = 0;
  for (let x = 0; x < width; x++) sum += 1 - frame[4 * (y * width + x)]! / 255;
  return sum;
}

const exposed: number[] = [], occluded: number[] = [];
for (const phasePx of [0, .35, .7]) {
  shaft.position.x = .0035 + phasePx * .001;
  const frame = pixels();
  for (let y = 22; y <= 104; y++) {
    if (y <= 52 || y >= 76) exposed.push(darkness(frame, y));
    if (y >= 58 && y <= 69) occluded.push(darkness(frame, y));
  }
}
shaft.material = steel;
const raw = pixels();
const rawMin = Math.min(...Array.from({ length: 30 }, (_, i) => darkness(raw, i + 22)));

// At four pixels wide the normal steel mesh fully resolves. Compare every RGBA byte.
blocker.visible = false;
camera.zoom = 16;
camera.updateProjectionMatrix();
const close = pixels();
shaft.material = filteredSteel;
const filtered = pixels();
const closeInk = close.filter((c, i) => i % 4 === 0 && c < 100).length;
const closeDelta = filtered.reduce((sum, c, i) => sum + Number(c !== close[i]), 0);
void fetch("/result", { method: "POST", body: JSON.stringify({
  min: Math.min(...exposed), max: Math.max(...exposed), blocked: Math.max(...occluded), rawMin, closeInk, closeDelta,
}) });
