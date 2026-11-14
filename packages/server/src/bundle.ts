import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { build, type Plugin } from "esbuild";

/**
 * The browser app's 3D view of the encounter (`web/stage/`) as one JavaScript module. Unlike the app's other
 * modules (each transpiled on its own as it is served) the stage is bundled: it draws the people with the pinned
 * ClinicalCraft's own figure kit (`packages/web/src/world/`: the same figures as the 3D world) and three.js, which
 * the browser cannot import by name. The bundle is built when first asked for and again whenever one of its
 * sources changes; it is kept gzipped as well.
 */

export interface StageBundleOptions {
  /** The stage's entry module (`web/stage/index.ts`). */
  entry: string;
  /** A ClinicalCraft checkout at the pinned revision (`.deps/clinicalcraft`); without one there is no 3D view. */
  engineDir: string | null;
  minify?: boolean;
}

export interface BuiltBundle {
  js: Buffer;
  gz: Buffer;
  etag: string;
  inputs: number;
  bytes: number;
}

/** `@clinicalcraft/*` as the pinned engine's sources: the packages the figure kit imports, and the web world itself. */
function enginePlugin(engineDir: string): Plugin {
  const pkg = (name: string) => join(engineDir, "packages", name, "src", "index.ts");
  return {
    name: "clinicalcraft-engine",
    setup(b) {
      b.onResolve({ filter: /^@clinicalcraft\/(core|world)$/ }, (args) => ({ path: pkg(args.path.split("/")[1]!) }));
      // `@clinicalcraft/web/world/npc.js` → packages/web/src/world/npc.ts
      b.onResolve({ filter: /^@clinicalcraft\/web\// }, (args) => {
        const rest = args.path.slice("@clinicalcraft/web/".length).replace(/\.js$/, ".ts");
        return { path: join(engineDir, "packages", "web", "src", rest) };
      });
    },
  };
}

export class StageBundle {
  private built: (BuiltBundle & { mtimes: Map<string, number> }) | null = null;
  private building: Promise<BuiltBundle> | null = null;
  private checkedAt = 0;
  private readonly engineDir: string | null;

  constructor(private readonly options: StageBundleOptions) {
    const dir = options.engineDir && existsSync(join(options.engineDir, "packages", "web", "src", "world", "npc.ts")) ? realpathSync(options.engineDir) : null;
    this.engineDir = dir;
  }

  /** Whether there is a 3D view to serve (the stage's sources and the pinned engine are both there). */
  get available(): boolean {
    return this.engineDir !== null && existsSync(this.options.entry);
  }

  /** Why there is none, for the browser. */
  get missing(): string | null {
    if (!existsSync(this.options.entry)) return "the stage's sources are not installed";
    if (!this.engineDir) return "no ClinicalCraft checkout at the pinned revision (.deps/clinicalcraft): run `npm run bootstrap`";
    return null;
  }

  /** The bundle, built anew if a source changed (checked at most once a second). */
  async get(): Promise<BuiltBundle> {
    if (!this.available) throw new Error(this.missing ?? "no 3D view");
    if (this.built && (Date.now() - this.checkedAt < 1000 || !this.stale())) return this.built;
    this.building ??= this.make().finally(() => (this.building = null));
    return this.building;
  }

  private stale(): boolean {
    this.checkedAt = Date.now();
    for (const [file, mtime] of this.built!.mtimes) {
      try {
        if (statSync(file).mtimeMs !== mtime) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  private async make(): Promise<BuiltBundle> {
    const out = await build({
      entryPoints: [this.options.entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      metafile: true,
      minify: this.options.minify ?? true,
      legalComments: "eof",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.vitest": "undefined" },
      plugins: [enginePlugin(this.engineDir!)],
    });
    const file = out.outputFiles[0];
    if (!file) throw new Error("the stage bundle came out empty");
    const js = Buffer.from(file.contents);
    const mtimes = new Map<string, number>();
    for (const input of Object.keys(out.metafile.inputs)) {
      const path = resolve(input);
      try {
        mtimes.set(path, statSync(path).mtimeMs);
      } catch {
        /* a virtual module */
      }
    }
    const built = { js, gz: gzipSync(js, { level: 6 }), etag: `"${createHash("sha256").update(js).digest("hex").slice(0, 24)}"`, inputs: mtimes.size, bytes: js.length, mtimes };
    this.built = built;
    this.checkedAt = Date.now();
    return built;
  }
}
