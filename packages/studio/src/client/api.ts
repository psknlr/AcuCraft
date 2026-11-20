import type { ActResult, ActionSpec, AgentStatus, Library, Probe, ScenarioInfo, Snapshot, StudioEvent, StudioScene, TeachingRegion } from "./types.js";

/** The studio's HTTP interface, from the page. Every change goes through `act`; everything shown comes back as JSON. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? ((await res.json()) as unknown) : await res.text();
  if (!res.ok) {
    const e = data as { error?: string; message?: string };
    throw new ApiError(res.status, e?.error ?? "error", e?.message ?? `the studio answered ${res.status}`);
  }
  return data as T;
}

const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  scenarios: () => call<ScenarioInfo[]>("/api/scenarios"),
  snapshot: () => call<Snapshot>("/api/session"),
  scene: () => call<StudioScene>("/api/session/scene"),
  actions: () => call<ActionSpec[]>("/api/session/actions"),
  library: () => call<Library>("/api/session/library"),
  start: (body: { scenario?: string; seed?: number; mode?: string }) => call<Snapshot>("/api/session", body),
  act: (action: unknown, opts: { expectedVersion?: number; takeover?: boolean; as?: string } = {}) => call<ActResult>("/api/session/act", { action, via: "operator", ...opts }),
  undo: () => call<Snapshot>("/api/session/undo", {}),
  agent: (body: { agent?: string | null; stepDelayMs?: number; run?: boolean; model?: string; effort?: string }) => call<AgentStatus>("/api/session/agent", body),
  agentRun: () => call<AgentStatus>("/api/session/agent/run", {}),
  agentPause: () => call<AgentStatus>("/api/session/agent/pause", {}),
  agentStep: () => call<unknown>("/api/session/agent/step", {}),
  agentPropose: () => call<AgentStatus>("/api/session/agent/propose", {}),
  agentDiscard: () => call<AgentStatus>("/api/session/agent/discard", {}),
  reportMarkdown: () => call<string>("/api/session/report?format=markdown"),
  teaching: (region: string, side: string) => call<TeachingRegion>(`/api/session/teaching?${qs({ region, side })}`),
  probe: (q: { region: string; side: string; u: number; v: number; angleDeg: number; azimuthDeg: number; depthCm: number }) => call<Probe>(`/api/session/teaching/probe?${qs(q)}`),
  events(on: (e: StudioEvent) => void, status: (live: boolean) => void): EventSource {
    const source = new EventSource("/api/session/events");
    source.addEventListener("state", (ev) => on(JSON.parse((ev as MessageEvent<string>).data) as StudioEvent));
    source.onopen = () => status(true);
    source.onerror = () => status(false);
    return source;
  },
};
