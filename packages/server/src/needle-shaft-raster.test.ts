import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const browser = [process.env.CHROME_BIN, ...(process.env.PATH ?? "").split(delimiter).flatMap(dir =>
  ["chromium", "google-chrome"].map(name => join(dir, name)))].find((path): path is string => !!path && existsSync(path));

interface Coverage {
  min: number; max: number; blocked: number; rawMin: number; closeInk: number; closeDelta: number;
}

it.skipIf(!browser)("rasterizes an occludable, continuous subpixel shaft while retaining the resolved steel silhouette", async () => {
  const entry = fileURLToPath(new URL("./fixtures/needle-shaft-raster.ts", import.meta.url));
  const js = buildSync({ entryPoints: [entry], bundle: true, write: false, minify: true }).outputFiles[0]!.text;
  let complete!: (data: Coverage) => void;
  const result = new Promise<Coverage>(resolve => { complete = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/result" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.end();
      complete(JSON.parse(body) as Coverage);
    } else if (request.url === "/raster.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(js);
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<script src="/raster.js"></script>');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing browser fixture port");
  const profile = mkdtempSync(join(tmpdir(), "acu-shaft-raster-"));
  const chrome = spawn(browser!, ["--headless", "--no-sandbox", "--no-first-run", "--disable-background-networking", "--disable-dev-shm-usage",
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${profile}`, `http://127.0.0.1:${address.port}/`], { stdio: "ignore" });
  const closed = once(chrome, "exit");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([result, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error("Timed out waiting for the WebGL shaft image")), 45000);
    }), closed.then(() => { throw Error("Browser closed before the shaft image was read"); })]);
    expect(data.rawMin).toBe(0);
    expect(data.min).toBeGreaterThan(.12);
    expect(data.max).toBeLessThan(.4);
    expect(data.blocked).toBe(0);
    expect(data.closeInk).toBeGreaterThan(300);
    expect(data.closeDelta).toBe(0);
  } finally {
    clearTimeout(timeout);
    chrome.kill();
    await closed;
    server.closeAllConnections();
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}, 55000);
