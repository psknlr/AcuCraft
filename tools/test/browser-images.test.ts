import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { Mesh, MeshStandardMaterial, NoColorSpace, SRGBColorSpace, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { decodePngBitmap, NodePngBitmap } from "./browser-images.js";

// A compressed 2x2 RGBA PNG: red, green / blue, semi-transparent (100,150,200,128).
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4AWP4z8Dwn+E/w3/mRob/DSnino0ARGIHRZ/V7O0AAAAASUVORK5CYII=", "base64");
const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 100, 150, 200, 128];

describe("real PNG image decoding for Node asset tests", () => {
  it("decodes actual compressed colour/alpha pixels, applies flipY and premultiplication, and releases closed data", async () => {
    const blob = new Blob([Uint8Array.from(fixture)], { type: "image/png" });
    const bitmap = await decodePngBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    expect([bitmap.width, bitmap.height]).toEqual([2, 2]);
    expect([...bitmap.data]).toEqual(rgba);
    const flipped = await decodePngBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none" });
    expect([...flipped.data]).toEqual([...rgba.slice(8), ...rgba.slice(0, 8)]);
    const multiplied = await decodePngBitmap(blob, { premultiplyAlpha: "premultiply" });
    expect([...multiplied.data.slice(12)]).toEqual([50, 75, 100, 128]);
    bitmap.close(); bitmap.close();
    expect([bitmap.width, bitmap.height, bitmap.data.byteLength]).toEqual([0, 0, 0]);
    flipped.close(); multiplied.close();
  });

  it("rejects non-PNG, corrupted image data and unsupported resize instead of manufacturing a texture", async () => {
    await expect(decodePngBitmap(new Blob(["not an image"]))).rejects.toThrow(/PNG/);
    const corrupt = Buffer.from(fixture); corrupt[corrupt.length - 16]! ^= 1;
    await expect(decodePngBitmap(new Blob([Uint8Array.from(corrupt)]))).rejects.toThrow();
    await expect(decodePngBitmap(new Blob([Uint8Array.from(fixture)]), { resizeWidth: 1 })).rejects.toThrow(/resize/);
  });

  it("survives restoration of unrelated global stubs and uses native Blob URL fetching", async () => {
    vi.stubGlobal("unrelatedImageTestGlobal", true); vi.unstubAllGlobals();
    expect(globalThis.self).toBe(globalThis);
    const url = URL.createObjectURL(new Blob([Uint8Array.from(fixture)], { type: "image/png" }));
    try {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" }) as unknown as NodePngBitmap;
      expect([...bitmap.data]).toEqual(rgba);
      bitmap.close();
    } finally { URL.revokeObjectURL(url); }
  });

  it("loads the actual GLB's embedded PBR images into material maps with their real decoded RGBA data", async () => {
    // An explicit override lets the asset author validate a generated candidate before replacing
    // the committed asset. CI always checks the repository GLB.
    const path = process.env.ACUCRAFT_HAND_TEXTURE_FIXTURE ?? fileURLToPath(new URL("../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url));
    const bytes = readFileSync(path), jsonLength = bytes.readUInt32LE(12), binaryStart = 20 + jsonLength + 8;
    const json = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength)) as {
      images: { bufferView: number; mimeType: string }[];
      textures: { source: number }[];
      bufferViews: { byteOffset?: number; byteLength: number }[];
      materials: { name: string; normalTexture?: { index: number }; pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } } }[];
    };
    expect(json.images.length).toBeGreaterThanOrEqual(4);
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const materials = new Set<MeshStandardMaterial>(), textures = new Set<Texture>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial) materials.add(material);
      }
    });
    try {
      const skin = [...materials].find((material) => material.name === "hand_skin")!, nail = [...materials].find((material) => material.name === "hand_nails")!;
      expect(skin).toBeDefined(); expect(nail).toBeDefined();
      const skinDef = json.materials.find((material) => material.name === skin.name)!, nailDef = json.materials.find((material) => material.name === nail.name)!;
      for (const [texture, definition, colourSpace] of [
        [skin.map, skinDef.pbrMetallicRoughness?.baseColorTexture, SRGBColorSpace],
        [skin.normalMap, skinDef.normalTexture, NoColorSpace],
        [skin.roughnessMap, skinDef.pbrMetallicRoughness?.metallicRoughnessTexture, NoColorSpace],
        [nail.map, nailDef.pbrMetallicRoughness?.baseColorTexture, SRGBColorSpace],
      ] as const) {
        expect(texture).toBeInstanceOf(Texture); expect(definition).toBeDefined();
        textures.add(texture!);
        const source = json.images[json.textures[definition!.index]!.source]!, view = json.bufferViews[source.bufferView]!;
        expect(source.mimeType).toBe("image/png");
        const start = binaryStart + (view.byteOffset ?? 0), decoded = PNG.sync.read(bytes.subarray(start, start + view.byteLength), { checkCRC: true });
        const bitmap = texture!.image as NodePngBitmap;
        expect(bitmap).toBeInstanceOf(NodePngBitmap);
        expect([bitmap.width, bitmap.height, bitmap.data.length]).toEqual([decoded.width, decoded.height, decoded.width * decoded.height * 4]);
        expect(Buffer.from(bitmap.data).equals(decoded.data)).toBe(true);
        expect(new Set(bitmap.data).size).toBeGreaterThan(3);
        expect(texture!.colorSpace).toBe(colourSpace);
      }
    } finally {
      for (const texture of textures) { (texture.image as NodePngBitmap).close(); texture.dispose(); }
      gltf.scene.traverse((object) => { if (object instanceof Mesh) object.geometry.dispose(); });
      for (const material of materials) material.dispose();
    }
  });
});
