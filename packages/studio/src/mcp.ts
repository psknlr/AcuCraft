import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ACUCRAFT_VERSION, type AgentView } from "@acucraft/core";
import { CLAUDE_SYSTEM_PROMPT, agentOutcome, episodeMarkdown, lookup, type EncounterReport } from "@acucraft/bench";
import { StudioError, type ActResult, type StudioSession } from "./session.js";

/**
 * The studio as a Model Context Protocol server over stdio (docs/STUDIO.md): a language model in any MCP client —
 * a desktop assistant, a coding agent, an IDE — is given the practitioner's three tools (`act`, `view`, `lookup`) and
 * nothing else. It is the same interface the built-in model agent has, on the same session: started on its own the
 * bridge runs an encounter of its own; attached to a running studio (`--attach <url>`) it drives the encounter the
 * browser shows, so a person watches the model work in the 3D clinic and can take the next step themselves.
 *
 * JSON-RPC 2.0, one message a line. Nothing but protocol messages is ever written to the output.
 */

/** What the bridge drives: a session in this process, or a studio server somewhere else. */
export interface McpBackend {
  view(): Promise<AgentView>;
  act(action: unknown): Promise<{ view: AgentView; hint?: unknown }>;
  lookup(input: { topic?: string; id?: string }): Promise<unknown>;
  report(): Promise<EncounterReport>;
}

export function localBackend(session: StudioSession): McpBackend {
  return {
    view: async () => session.view(),
    act: async (action) => {
      const r = session.act({ action, via: "mcp" });
      return { view: r.snapshot.view, ...(r.attempt.hint ? { hint: r.attempt.hint } : {}) };
    },
    lookup: async (input) => lookup(session.library(), input),
    report: async () => session.report(),
  };
}

export function remoteBackend(base: string): McpBackend {
  const root = base.replace(/\/+$/, "");
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${root}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { error?: string; message?: string };
    if (!res.ok) throw new StudioError(res.status, json.error ?? "error", json.message ?? `the studio answered ${res.status}`);
    return json;
  };
  return {
    view: async () => (await call("/api/session/view")) as AgentView,
    act: async (action) => {
      const r = (await call("/api/session/act", { action, via: "mcp" })) as ActResult;
      return { view: r.snapshot.view, ...(r.attempt.hint ? { hint: r.attempt.hint } : {}) };
    },
    lookup: async (input) => call(`/api/session/library?topic=${encodeURIComponent(input.topic ?? "")}${input.id ? `&id=${encodeURIComponent(input.id)}` : ""}`),
    report: async () => (await call("/api/session/report")) as EncounterReport,
  };
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const LOOKUP_TOPICS = ["points", "point", "region", "regions", "vocabulary", "pattern", "deqi", "techniques", "clinic", "floorplan", "roles", "rules", "evidence", "actions"];

const TOOLS = [
  {
    name: "act",
    description:
      'Perform exactly one action in the encounter, as the treating practitioner. The input is { action: { type: <action type>, ...fields } }, for example { "action": { "type": "ask", "text": "What brings you in today?" } }. The environment is authoritative: the result says what happened (executed, partial, rejected or blocked) and what you now observe. The action types and their fields are in the server instructions (and under lookup topic "actions").',
    inputSchema: { type: "object", properties: { action: { type: "object", description: "One action object with its `type` and fields." } }, required: ["action"], additionalProperties: false },
  },
  {
    name: "view",
    description: "Your full current view of the encounter: where you stand and what is in reach, the patient, the record so far with the id of every item of evidence, your latest assessment, each needle with how it was worked and the evidence of its response, localisation, plan, equipment, team, tasks, counts and the rules in force. Takes no simulated time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "lookup",
    description: "Read the public reference library (no simulated time): point definitions and their construction, regional charts and landmarks, vocabulary ids, what each pattern is recognised by, deqi, needling techniques and their parameters, the clinic and its floor plan, roles, rules, guideline evidence, the action catalogue.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: LOOKUP_TOPICS },
        id: { type: "string", description: "For point: a point id or alias (ST36). For region: a region id (knee-leg). For points: a channel (ST), a body area or a region. For pattern: a pattern id." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "report",
    description: "The evaluator's report on the encounter. Written when the encounter has finished (finish_encounter); in teaching mode it can be read at any time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

/** Answer one JSON-RPC message (null: a notification, nothing to send). */
export async function handleMcp(backend: McpBackend, msg: RpcMessage): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (typeof msg.method !== "string") return msg.id !== undefined ? fail(-32600, "not a request") : null;
  if (msg.id === undefined || msg.id === null) return null; // notifications (initialized, cancelled …) need no answer
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "acucraft-studio", title: "AcuCraft studio", version: ACUCRAFT_VERSION },
        instructions: CLAUDE_SYSTEM_PROMPT,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === "view") return reply(text(await backend.view()));
        if (name === "lookup") return reply(text((await backend.lookup({ ...(typeof args.topic === "string" ? { topic: args.topic } : {}), ...(typeof args.id === "string" ? { id: args.id } : {}) })) ?? { error: "unknown topic", topics: LOOKUP_TOPICS }));
        if (name === "report") return reply(text(episodeMarkdown(await backend.report())));
        if (name === "act") {
          // a model may send the action itself, or wrapped as the schema asks
          const action = args.action && typeof args.action === "object" ? args.action : typeof args.type === "string" ? args : null;
          if (!action) return reply(text({ error: 'give { "action": { "type": …, …fields } }' }, true));
          const r = await backend.act(action);
          const out = agentOutcome(r.view) as Record<string, unknown>;
          return reply(text(r.hint ? { ...out, hint: r.hint } : out));
        }
        return fail(-32602, `unknown tool ${String(name)}`);
      } catch (e) {
        // a refusal of the studio (the agent is paused out, the report is not ready) is a result the model can read
        if (e instanceof StudioError) return reply(text({ error: e.code, message: e.message }, true));
        return reply(text({ error: "internal", message: (e as Error).message }, true));
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve MCP on a pair of streams (stdin and stdout by default) until the input ends. */
export async function serveMcp(backend: McpBackend, io: { input?: Readable; output?: Writable } = {}): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    // one message at a time, in order: an encounter has one clock
    chain = chain.then(async () => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(raw) as RpcMessage;
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        return;
      }
      const answer = await handleMcp(backend, msg);
      if (answer) output.write(`${JSON.stringify(answer)}\n`);
    });
  }
  await chain;
}
