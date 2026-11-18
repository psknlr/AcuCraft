import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const browser = [process.env.CHROME_BIN, ...(process.env.PATH ?? "").split(delimiter).flatMap(dir =>
  ["chromium", "google-chrome"].map(name => join(dir, name)))].find((path): path is string => !!path && existsSync(path));

interface Coverage {
  min: number; max: number; blocked: number; rawMin: number; closeInk: number; closeDelta: number;
}

it.skipIf(!browser)("rasterizes an occludable, continuous subpixel shaft while retaining the resolved steel silhouette", async ({ onTestFinished }) => {
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
  // Browser.close goes over Chromium's private debugging pipe and reaches the actual browser
  // even when CHROME_BIN is a launcher that backgrounds its child and exits successfully.
  const grouped = process.platform !== "win32";
  const chrome = spawn(browser!, ["--headless", "--no-sandbox", "--no-first-run", "--disable-background-networking", "--disable-dev-shm-usage",
    "--remote-debugging-pipe", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${profile}`,
    `http://127.0.0.1:${address.port}/`], { detached: grouped, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let diagnostics = "";
  chrome.stderr!.setEncoding("utf8").on("data", (message: string) => { diagnostics = (diagnostics + message).slice(-2000); });
  const commands = chrome.stdio[3] as Writable, replies = chrome.stdio[4] as Readable;
  replies.resume();
  commands.on("error", () => { /* A browser that already exited has closed its pipe. */ });
  const closed = new Promise<void>(resolve => chrome.once("close", () => resolve()));
  const failure = new Promise<never>((_, reject) => {
    chrome.once("error", reject);
    chrome.once("exit", (code, signal) => {
      if (code !== 0) reject(Error(`Raster browser exited (${signal ?? code}): ${diagnostics}`));
    });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  onTestFinished(async () => {
    clearTimeout(timeout);
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    if (!commands.destroyed) commands.end('{"id":1,"method":"Browser.close"}\0');
    await Promise.race([closed, delay(2000, undefined, { ref: false })]);
    // Stop any remaining processes in this fixture's own group before removing their profile.
    if (grouped && chrome.pid) {
      try { process.kill(-chrome.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const data = await Promise.race([result, failure, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(Error(`Timed out waiting for the WebGL shaft image: ${diagnostics}`)), 45000);
  })]);
  expect(data.rawMin).toBe(0);
  expect(data.min).toBeGreaterThan(.12);
  expect(data.max).toBeLessThan(.4);
  expect(data.blocked).toBe(0);
  expect(data.closeInk).toBeGreaterThan(300);
  expect(data.closeDelta).toBe(0);
}, 55000);
