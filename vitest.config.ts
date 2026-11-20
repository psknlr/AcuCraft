import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const engine = here("./.deps/clinicalcraft/packages/core/src/index.ts");
const world = here("./.deps/clinicalcraft/packages/world/src/index.ts");
if (!existsSync(engine)) {
  throw new Error("ClinicalCraft engine not found in .deps/clinicalcraft: run `npm run bootstrap` (or set CLINICALCRAFT_DIR and run it)");
}
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@clinicalcraft\/core$/, replacement: engine },
      { find: /^@clinicalcraft\/world$/, replacement: world },
      { find: /^@acucraft\/core$/, replacement: here("./packages/core/src/index.ts") },
      { find: /^@acucraft\/bench$/, replacement: here("./packages/bench/src/index.ts") },
      // one zod for AcuCraft and the engine sources, whatever node_modules the engine checkout has
      { find: /^zod$/, replacement: require.resolve("zod") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".deps/**"],
    environment: "node",
    testTimeout: 30000,
  },
});
