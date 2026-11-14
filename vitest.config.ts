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
      // the 3D world's own modules (the figure kit the workspace's 3D view draws people with)
      { find: /^@clinicalcraft\/web\/(.*)\.js$/, replacement: `${here("./.deps/clinicalcraft/packages/web/src/")}$1.ts` },
      { find: /^@acucraft\/core$/, replacement: here("./packages/core/src/index.ts") },
      { find: /^@acucraft\/agent$/, replacement: here("./packages/agent/src/index.ts") },
      { find: /^@acucraft\/agent\/node$/, replacement: here("./packages/agent/src/node/index.ts") },
      { find: /^@acucraft\/bench$/, replacement: here("./packages/bench/src/index.ts") },
      { find: /^@acucraft\/mcp$/, replacement: here("./packages/mcp/src/index.ts") },
      { find: /^@acucraft\/server$/, replacement: here("./packages/server/src/index.ts") },
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
