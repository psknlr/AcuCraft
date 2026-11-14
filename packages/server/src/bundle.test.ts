import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StageBundle } from "./bundle.js";

/**
 * The 3D view's bundle (docs/WEB.md §4): built from `web/stage/` with the pinned ClinicalCraft's figure kit and
 * three.js — a change upstream that breaks it fails here, not in a browser.
 */

const entry = fileURLToPath(new URL("../web/stage/index.ts", import.meta.url));
const engineDir = fileURLToPath(new URL("../../../.deps/clinicalcraft", import.meta.url));

describe("the 3D view's bundle", () => {
  it("builds from the pinned engine: one module exporting mountStage, with the figure kit in it", async () => {
    const bundle = new StageBundle({ entry, engineDir });
    expect(bundle.available).toBe(true);
    const built = await bundle.get();
    const js = built.js.toString("utf8");
    expect(js).toMatch(/export\s*\{[^}]*mountStage/);
    expect(built.bytes).toBeGreaterThan(400_000);
    expect(built.gz.length).toBeLessThan(built.bytes);
    // the figure kit is in it (its shared material's name), and nothing reaches for Node
    expect(js).toContain("__figure");
    expect(js).not.toMatch(/require\("node:|from"node:/);
    // asked again with nothing changed, the same bundle
    expect((await bundle.get()).etag).toBe(built.etag);
  }, 60_000);

  it("says why there is none without the engine checkout", () => {
    const bundle = new StageBundle({ entry, engineDir: "/nowhere/clinicalcraft" });
    expect(bundle.available).toBe(false);
    expect(bundle.missing).toMatch(/bootstrap/);
  });
});
