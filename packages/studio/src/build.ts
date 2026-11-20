import { build, type Plugin } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Bundle the studio's browser client (three.js and the client's own TypeScript) into `packages/studio/dist`.
 * The client takes everything it shows from the server as JSON: it imports the engine's types only, and the bundler
 * refuses anything else from the engine — nothing of a scenario's hidden side can be compiled into the page.
 */

export const CLIENT_SRC = fileURLToPath(new URL("./client", import.meta.url));
export const CLIENT_DIST = fileURLToPath(new URL("../dist", import.meta.url));

const noEngine: Plugin = {
  name: "no-engine-in-the-client",
  setup(b) {
    b.onResolve({ filter: /^@(acucraft|clinicalcraft)\// }, (args) => ({
      errors: [{ text: `${args.path} is imported as a value in ${args.importer}: the client may import the engine's types only (import type)` }],
    }));
  },
};

export interface BuildOptions {
  outDir?: string;
  minify?: boolean;
  sourcemap?: boolean;
}

export async function buildClient(opts: BuildOptions = {}): Promise<{ outDir: string; bytes: number; ms: number }> {
  const outDir = opts.outDir ?? CLIENT_DIST;
  const started = Date.now();
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(CLIENT_SRC, "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(outDir, "app.js"),
    minify: opts.minify ?? true,
    sourcemap: opts.sourcemap ?? false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [noEngine],
  });
  for (const name of ["index.html", "app.css"]) copyFileSync(join(CLIENT_SRC, name), join(outDir, name));
  return { outDir, bytes: statSync(join(outDir, "app.js")).size, ms: Date.now() - started };
}

/** Is there a built client in `dir`? */
export const clientBuilt = (dir: string = CLIENT_DIST): boolean => existsSync(join(dir, "index.html")) && existsSync(join(dir, "app.js"));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildClient({ sourcemap: process.argv.includes("--sourcemap"), minify: !process.argv.includes("--no-minify") })
    .then((r) => console.log(`studio client built: ${r.outDir} (app.js ${(r.bytes / 1024).toFixed(0)} kB, ${r.ms} ms)`))
    .catch((e: unknown) => {
      console.error((e as Error).message);
      process.exit(1);
    });
}
