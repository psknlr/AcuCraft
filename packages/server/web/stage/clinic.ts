import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { StageInfo } from "./types.js";

/** The navigated clinic itself, in metres. Cutaway walls leave people and procedures visible. */
export function buildClinic(info: StageInfo, modelUrl: (file: string) => string) {
  const root = new Group();
  const floor = new MeshStandardMaterial({ color: 0xd5dcd6, roughness: 0.78 });
  const wall = new MeshStandardMaterial({ color: 0xebe6dc, roughness: 0.9 });
  const furniture = new MeshStandardMaterial({ color: 0x8faaa2, roughness: 0.6 });
  const add = (x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  };
  for (const room of info.layout.rooms) add((room.minX + room.maxX) / 2, -0.035, (room.minZ + room.maxZ) / 2, room.maxX-room.minX, 0.07, room.maxZ-room.minZ, floor);
  const modelled = new Set(info.layout.placements.filter(p => info.models[p.type]).map(p => `eq:${p.id}`));
  for (const c of info.layout.colliders) {
    if (c.passable || modelled.has(c.id)) continue;
    const isWall = c.kind === "wall" || c.kind === "partition";
    if (!isWall && c.kind !== "equipment") continue;
    const top = isWall ? Math.min(c.maxY, 0.8) : c.maxY;
    if (top <= c.minY) continue;
    add((c.minX+c.maxX)/2, (c.minY+top)/2, (c.minZ+c.maxZ)/2, c.maxX-c.minX, top-c.minY, c.maxZ-c.minZ, isWall ? wall : furniture);
  }
  const loader = new GLTFLoader();
  const ready = Promise.all(info.layout.placements.map(async p => {
    const ref = info.models[p.type];
    if (!ref) return;
    const asset = await loader.loadAsync(modelUrl(ref.file));
    asset.scene.position.set(...ref.offset);
    asset.scene.scale.setScalar(ref.scale);
    asset.scene.traverse(o => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    const holder = new Group();
    holder.position.set(p.x, p.y, p.z); holder.rotation.y = p.rot * Math.PI / 180;
    holder.add(asset.scene); root.add(holder);
  })).then(() => undefined);
  return { root, ready };
}
