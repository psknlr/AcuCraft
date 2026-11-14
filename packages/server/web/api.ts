import type { AgentView } from "@acucraft/core";
import type { EncounterReport } from "@acucraft/bench";
import type { EncounterSnapshot, EncounterSummary, StageInfo, TimelineEntry } from "../src/hub.js";
import type { RunnerSnapshot, TranscriptItem } from "../src/runner.js";

/**
 * The workspace's server, as the browser reaches it: JSON over `/api/*` and one Server-Sent Events stream. Every
 * request says who is acting (the name the operator gave, and this tab), so the timeline can say who did what.
 */

export type { AgentView, EncounterReport, EncounterSnapshot, EncounterSummary, RunnerSnapshot, StageInfo, TimelineEntry, TranscriptItem };

export interface Info {
  name: string;
  version: string;
  clinicalcraft: string;
  families: { family: string; title: string; variants: number }[];
  auth: { token: boolean };
  mcp: string;
  languageModel: { claude: boolean };
  /** The 3D view of an encounter: whether the server has it (it needs the pinned engine's figure kit). */
  stage: { available: boolean; missing: string | null };
}

export interface ToolInfo {
  name: string;
  kind: "act" | "read";
  group: string;
  description: string;
  inputSchema: import("./schema.js").JsonSchema;
}

export interface ActAnswer {
  ok: boolean;
  output: unknown;
  entry?: TimelineEntry;
}

const stored = (key: string, store: () => Storage): string | null => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const keep = (key: string, value: string, store: () => Storage) => {
  try {
    store().setItem(key, value);
  } catch {
    /* a private window: it lasts as long as the page */
  }
};

/** Who is at this browser: a name they chose (kept in this browser) and this tab. */
export const me = {
  name: stored("acu.name", () => localStorage) ?? "Operator",
  tab:
    stored("acu.tab", () => sessionStorage) ??
    (() => {
      const tab = `tab-${Math.random().toString(36).slice(2, 10)}`;
      keep("acu.tab", tab, () => sessionStorage);
      return tab;
    })(),
};

export function setName(name: string): void {
  const clean = name.replace(/[^\p{L}\p{N} .,'()_-]/gu, "").trim().slice(0, 40);
  me.name = clean || "Operator";
  keep("acu.name", me.name, () => localStorage);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data ? (data as { error: unknown }).error : res.statusText;
    throw new ApiError(res.status, typeof error === "string" ? error : JSON.stringify(error));
  }
  return data as T;
}

const by = () => ({ name: me.name, tab: me.tab });
const enc = (id: string) => `/api/encounters/${encodeURIComponent(id)}`;

export const api = {
  info: () => request<Info>("GET", "/api/info"),
  encounters: () => request<{ encounters: EncounterSummary[] }>("GET", "/api/encounters"),
  create: (args: { family: string; variant?: number; seed?: number; mode?: string }) => request<{ id: string; summary: EncounterSummary }>("POST", "/api/encounters", { ...args, by: by() }),
  importLog: (log: unknown) => request<{ id: string; summary: EncounterSummary }>("POST", "/api/encounters/import", { log, by: by() }),
  snapshot: (id: string) => request<EncounterSnapshot>("GET", enc(id)),
  tools: (id: string) => request<{ tools: ToolInfo[] }>("GET", `${enc(id)}/tools`),
  stage: (id: string) => request<StageInfo>("GET", `${enc(id)}/stage`),
  act: (id: string, tool: string, input: Record<string, unknown>) => request<ActAnswer>("POST", `${enc(id)}/act`, { tool, input, by: by() }),
  close: (id: string, abandon: boolean) => request<{ report: EncounterReport }>("POST", `${enc(id)}/close`, { abandon, by: by() }),
  remove: (id: string) => request<{ removed: string }>("DELETE", enc(id)),
  agent: (id: string, op: "start" | "pause" | "resume" | "stop", options: Record<string, unknown> = {}) => request<{ agent: RunnerSnapshot | null }>("POST", `${enc(id)}/agent`, { op, options, by: by() }),
  decide: (id: string, approve: boolean, reason?: string) => request<{ agent: RunnerSnapshot }>("POST", `${enc(id)}/agent/decision`, { approve, reason, by: by() }),
  logUrl: (id: string) => `${enc(id)}/log`,
  debriefUrl: (id: string) => `${enc(id)}/debrief`,
};

export interface StreamHandlers {
  hello?(data: { encounters: EncounterSummary[]; snapshot: EncounterSnapshot | null }): void;
  summary?(summary: EncounterSummary): void;
  removed?(id: string): void;
  update?(data: { view: AgentView; entry: TimelineEntry }): void;
  agent?(data: { agent: RunnerSnapshot; item: TranscriptItem | null }): void;
  closed?(data: { report: EncounterReport }): void;
  status?(state: "live" | "connecting" | "offline"): void;
}

/**
 * The live stream: the list of records always, and everything about one encounter when one is named. On every
 * (re)connection the server sends a fresh `hello`, so whatever was missed while the link was down is made good.
 */
export function stream(encounter: string | null, on: StreamHandlers): () => void {
  const source = new EventSource(`/api/stream${encounter ? `?encounter=${encodeURIComponent(encounter)}` : ""}`);
  on.status?.("connecting");
  source.addEventListener("open", () => on.status?.("live"));
  source.addEventListener("error", () => on.status?.(source.readyState === EventSource.CLOSED ? "offline" : "connecting"));
  const bind = <T>(name: string, fn: ((data: T) => void) | undefined) =>
    source.addEventListener(name, (event) => {
      if (!fn) return;
      try {
        fn(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch (e) {
        console.error(`the ${name} event could not be read`, e);
      }
    });
  bind("hello", on.hello?.bind(on));
  bind("summary", on.summary?.bind(on));
  bind<{ id: string }>("removed", on.removed ? (d) => on.removed!(d.id) : undefined);
  bind("update", on.update?.bind(on));
  bind("agent", on.agent?.bind(on));
  bind("closed", on.closed?.bind(on));
  return () => source.close();
}
