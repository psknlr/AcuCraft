import { PNG } from "pngjs";

/** Decoded pixels for Node-side asset inspection; no canvas, GPU or browser rendering is emulated. */
export class NodePngBitmap {
  private pixels: Uint8ClampedArray;
  private bitmapWidth: number;
  private bitmapHeight: number;

  constructor(width: number, height: number, pixels: Uint8ClampedArray) {
    this.bitmapWidth = width; this.bitmapHeight = height; this.pixels = pixels;
  }

  get width(): number { return this.bitmapWidth; }
  get height(): number { return this.bitmapHeight; }
  get data(): Uint8ClampedArray { return this.pixels; }

  close(): void {
    this.pixels = new Uint8ClampedArray();
    this.bitmapWidth = 0; this.bitmapHeight = 0;
  }
}

/** Decode the generated PNG textures used by GLTFLoader's ImageBitmapLoader in Node tests. */
export async function decodePngBitmap(blob: Blob, options: ImageBitmapOptions = {}): Promise<NodePngBitmap> {
  if (!(blob instanceof Blob)) throw new TypeError("The Node asset-image adapter accepts PNG Blob sources only.");
  if (options.resizeWidth !== undefined || options.resizeHeight !== undefined) {
    throw new TypeError("The Node asset-image adapter does not resize textures.");
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, signature.length).equals(signature)) throw new TypeError("The Node asset-image adapter requires PNG data.");
  const decoded = PNG.sync.read(bytes, { checkCRC: true });
  const pixels = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  const flipY = options.imageOrientation === "flipY", premultiply = options.premultiplyAlpha === "premultiply";
  for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
    const from = ((flipY ? decoded.height - y - 1 : y) * decoded.width + x) * 4;
    const to = (y * decoded.width + x) * 4, alpha = decoded.data[from + 3]!;
    for (let channel = 0; channel < 3; channel++) {
      const value = decoded.data[from + channel]!;
      pixels[to + channel] = premultiply ? Math.round(value * alpha / 255) : value;
    }
    pixels[to + 3] = alpha;
  }
  // GLTFLoader explicitly requests colorSpaceConversion:"none". Keep encoded channel values,
  // including non-colour normal/roughness data; Three retains each texture's colour-space metadata.
  return new NodePngBitmap(decoded.width, decoded.height, pixels);
}

/** Install once without Vitest stubs, so unrelated vi.unstubAllGlobals calls retain the decoder. */
export function installNodeBrowserImages(): void {
  if (typeof globalThis.self === "undefined") {
    Object.defineProperty(globalThis, "self", { value: globalThis, writable: true, configurable: true });
  }
  if (typeof globalThis.createImageBitmap === "undefined") {
    const create = async (source: ImageBitmapSource, optionsOrX?: ImageBitmapOptions | number): Promise<NodePngBitmap> => {
      if (typeof optionsOrX === "number") throw new TypeError("The Node asset-image adapter does not crop textures.");
      return decodePngBitmap(source as Blob, optionsOrX);
    };
    Object.defineProperty(globalThis, "createImageBitmap", { value: create, writable: true, configurable: true });
  }
}

installNodeBrowserImages();
