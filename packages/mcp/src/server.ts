import { ACUCRAFT_VERSION, observeAs, createEncounter, type EncounterLog, type Mode } from "@acucraft/core";
import { EncounterSession, openingText, systemPrompt, toolsFor, type ObjectSchema, type ToolContext, type ToolDefinition } from "@acucraft/agent";
import { CLINICALCRAFT_REV, evaluateEncounter, requireScenario, type ContentPack, type EncounterReport } from "@acucraft/bench";
import { classify, LineSplitter, RPC_ERRORS, RpcError, rpcError, rpcResult, type JsonRpcResponse } from "./jsonrpc.js";

/**
 * `acucraft mcp` — a Model Context Protocol server over stdio (one JSON-RPC 2.0 message per line) that lets an
 * external agent play the practitioner: `initialize`, `ping`, `tools/list`, `tools/call`.
 *
 * The tools are the built-in agent's own (`@acucraft/agent`): one for each action a practitioner may take, plus
 * `lookup`, `view`, `construct_point` and `read_skill` — each with a `session_id`. `list_encounters` and
 * `start_encounter` open an encounter; `get_report` gives the independent evaluation once it is finished. Before
 * that, nothing hidden is served: the same view and the same library as any agent under test, and a variant is
 * never named to the client.
 *
 * stdout carries protocol messages only; diagnostics go to stderr.
 */

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpServerOptions {
  pack: ContentPack;
  /** Open encounters kept before the least recently used is closed (default 16). */
  maxSessions?: number;
  /** Called when an encounter is finished or abandoned: its replayable log and its report (the command line writes them). */
  onClosed?: (closed: { sessionId: string; log: EncounterLog; report: EncounterReport }) => void;
  /** Diagnostics (default: stderr). */
  log?: (message: string) => void;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

interface Open {
  id: string;
  session: EncounterSession;
  used: number;
  closed: boolean;
}

const SESSION_ID = { type: "string", description: "The session_id start_encounter gave you." } as const;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class McpServer {
  private readonly pack: ContentPack;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, Open>();
  private readonly definitions: ToolDefinition[];
  private readonly log: (message: string) => void;
  private readonly onClosed: McpServerOptions["onClosed"];
  private opened = 0;
  private clock = 0;

  constructor(options: McpServerOptions) {
    this.pack = options.pack;
    this.maxSessions = options.maxSessions ?? 16;
    this.log = options.log ?? ((m) => process.stderr.write(`[acucraft mcp] ${m}\n`));
    this.onClosed = options.onClosed;
    // every action a practitioner under test may take in any family of the pack (the engine still decides each call)
    const may = new Set<string>();
    for (const family of this.pack.families.values()) {
      const sc = requireScenario(this.pack, `${family.id}/${family.variantIds[0]}`);
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      for (const type of observeAs(sc, createEncounter(sc, { seed: 1 }), actor).you.may) may.add(type);
    }
    this.definitions = toolsFor([...may], { skills: this.pack.skills.length > 0 });
  }

  /** The instructions a client is given on `initialize`: the practitioner's standing instructions, and how sessions work. */
  instructions(): string {
    return `${systemPrompt(this.pack.skills)}\n\nThrough this server\n\nCall list_encounters, then start_encounter: it returns a session_id and your opening view. Pass session_id with every other tool. When the encounter is finished (finish_encounter), get_report gives its independent evaluation — a teaching-script measure, not a validated competency score.`;
  }

  tools(): McpTool[] {
    const own: McpTool[] = [
      {
        name: "list_encounters",
        description: "The encounters that can be started: each family (a patient and a presentation) with the number of its variants. A variant changes one thing about the case; which one you get is not told.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "start_encounter",
        description: "Start an encounter as the practitioner: returns a session_id and your opening view. `variant` picks one of the family's variants by number (default: chosen from the seed); `mode` teaching shows reference locations and anatomical notes, assessment (default) shows none.",
        inputSchema: {
          type: "object",
          properties: {
            family: { type: "string", description: "A family id from list_encounters." },
            variant: { type: "integer", minimum: 1, description: "Which of the family's variants, by number." },
            seed: { type: "integer", description: "The seed of the encounter's chance events (default 1)." },
            mode: { type: "string", enum: ["assessment", "teaching"] },
          },
          required: ["family"],
          additionalProperties: false,
        },
      },
      {
        name: "get_report",
        description: "The independent evaluation of an encounter, once it is finished: the outcome, the pathway reached, the five tracks, critical errors and unsafe attempts. With `abandon: true` an unfinished encounter is closed as it stands and evaluated.",
        inputSchema: { type: "object", properties: { session_id: SESSION_ID, abandon: { type: "boolean", description: "Close an unfinished encounter now." } }, required: ["session_id"], additionalProperties: false },
      },
    ];
    return [
      ...own,
      ...this.definitions.map((t): McpTool => ({
        name: t.name,
        description: t.description,
        inputSchema: { ...t.inputSchema, properties: { session_id: SESSION_ID, ...t.inputSchema.properties }, required: ["session_id", ...t.inputSchema.required] },
        ...(t.kind === "read" ? { annotations: { readOnlyHint: true } } : {}),
      })),
    ];
  }

  /** Answer one JSON-RPC message (or a batch). `null`: nothing to send (a notification). */
  async handle(value: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(value)) {
      if (value.length === 0) return rpcError(null, RPC_ERRORS.invalidRequest, "an empty batch");
      const out: JsonRpcResponse[] = [];
      for (const item of value) {
        const one = await this.handle(item);
        if (one && !Array.isArray(one)) out.push(one);
      }
      return out.length > 0 ? out : null;
    }
    const incoming = classify(value);
    if (incoming.kind === "invalid") return rpcError(incoming.id, RPC_ERRORS.invalidRequest, incoming.reason);
    if (incoming.kind !== "request") return null;
    const { id, method, params } = incoming.message;
    try {
      return rpcResult(id, this.dispatch(method, params));
    } catch (e) {
      if (e instanceof RpcError) return rpcError(id, e.code, e.message);
      this.log(`${method} failed: ${e instanceof Error ? e.message : String(e)}`);
      return rpcError(id, RPC_ERRORS.internalError, "internal error");
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    switch (method) {
      case "initialize": {
        const asked = record(params).protocolVersion;
        return {
          protocolVersion: typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "acucraft", title: "AcuCraft · acupuncture encounters", version: ACUCRAFT_VERSION },
          instructions: this.instructions(),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools() };
      case "tools/call": {
        const p = record(params);
        if (typeof p.name !== "string") throw new RpcError(RPC_ERRORS.invalidParams, "tools/call needs a tool name");
        if (p.arguments !== undefined && (typeof p.arguments !== "object" || p.arguments === null || Array.isArray(p.arguments))) throw new RpcError(RPC_ERRORS.invalidParams, "arguments must be an object");
        const { ok, output } = this.call(p.name, record(p.arguments));
        return { content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }], ...(ok ? {} : { isError: true }) };
      }
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `no method ${method}`);
    }
  }

  /** One tool call. A failure of the call is a result the client's model can read, not a protocol error. */
  call(name: string, args: Record<string, unknown>): { ok: boolean; output: unknown } {
    if (name === "list_encounters") {
      return { ok: true, output: [...this.pack.families.values()].map((f) => ({ family: f.id, title: (f.source.family as { title: string }).title, variants: f.variantIds.length })) };
    }
    if (name === "start_encounter") return this.start(args);
    const open = typeof args.session_id === "string" ? this.sessions.get(args.session_id) : undefined;
    if (!open) return { ok: false, output: { error: `no open encounter ${String(args.session_id ?? "")}: call start_encounter first` } };
    open.used = ++this.clock;
    if (name === "get_report") return this.report(open, args.abandon === true);
    if (open.closed) return { ok: false, output: { error: "This encounter is closed: get_report has its evaluation." } };
    const tool = this.definitions.find((t) => t.name === name);
    if (!tool) return { ok: false, output: { error: `There is no tool ${name}.` } };
    const { session_id: _session, ...input } = args;
    if (tool.kind === "read") {
      const ctx: ToolContext = { library: open.session.library(), view: open.session.view(), skills: this.pack.skills };
      return tool.run(input, ctx);
    }
    const parsed = tool.toAction(input);
    if (!parsed.ok) return { ok: false, output: { error: parsed.error } };
    const done = open.session.act(parsed.action);
    if (open.session.finished) this.close(open);
    return { ok: done.attempt.status !== "rejected" && done.attempt.status !== "blocked", output: done.result };
  }

  private start(args: Record<string, unknown>): { ok: boolean; output: unknown } {
    const family = typeof args.family === "string" ? this.pack.families.get(args.family) : undefined;
    if (!family) return { ok: false, output: { error: `no family ${String(args.family ?? "")}`, families: [...this.pack.families.keys()] } };
    const seed = Number.isInteger(args.seed) ? (args.seed as number) : 1;
    const n = family.variantIds.length;
    if (args.variant !== undefined && !(Number.isInteger(args.variant) && (args.variant as number) >= 1 && (args.variant as number) <= n)) return { ok: false, output: { error: `variant is a number from 1 to ${n}` } };
    const index = args.variant !== undefined ? (args.variant as number) - 1 : (((seed - 1) % n) + n) % n;
    const mode: Mode = args.mode === "teaching" ? "teaching" : "assessment";
    const session = new EncounterSession(requireScenario(this.pack, `${family.id}/${family.variantIds[index]}`), { seed, mode });
    // an opaque id: it names neither the variant nor anything else of the scenario
    const id = `enc-${++this.opened}-${Math.abs(Math.imul(seed + 0x9e3779b9, this.opened * 2654435761)).toString(36)}`;
    this.sessions.set(id, { id, session, used: ++this.clock, closed: false });
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.used - b.used)[0]!;
      this.close(oldest);
      this.sessions.delete(oldest.id);
    }
    return { ok: true, output: { session_id: id, opening: openingText(session.view()) } };
  }

  private report(open: Open, abandon: boolean): { ok: boolean; output: unknown } {
    if (!open.session.finished && !open.closed) {
      if (!abandon) return { ok: false, output: { error: "The encounter is still open. Finish it (end_visit, then finish_encounter) — or pass abandon: true to close it as it stands." } };
      this.close(open);
    }
    const report = evaluateEncounter(open.session.scenario, open.session.state);
    return {
      ok: true,
      output: {
        notice: report.notice,
        finished: open.session.finished,
        primary: report.primary,
        tracks: Object.fromEntries(Object.entries(report.tracks).map(([k, t]) => [k, { score: t.score, missed: t.items.filter((i) => i.met === false).map((i) => i.label) }])),
        criticalErrors: report.criticalErrors,
        unsafe: report.unsafe,
        points: report.points,
        efficiency: report.efficiency,
      },
    };
  }

  private close(open: Open): void {
    if (open.closed) return;
    open.closed = true;
    try {
      this.onClosed?.({ sessionId: open.id, log: open.session.log({ clinicalcraft: CLINICALCRAFT_REV }, { agent: "mcp client" }), report: evaluateEncounter(open.session.scenario, open.session.state) });
    } catch (e) {
      this.log(`could not write the log of ${open.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Close every encounter still open (the input ended). */
  shutdown(): void {
    for (const open of this.sessions.values()) this.close(open);
  }
}

export interface RunMcpServerOptions extends McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Serve on newline-delimited stdio until the input ends. */
export async function runMcpServer(options: RunMcpServerOptions): Promise<void> {
  const server = new McpServer(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((m: string) => process.stderr.write(`[acucraft mcp] ${m}\n`));
  let broken = false;
  output.on("error", (err: Error) => {
    broken = true;
    log(`output error: ${err.message}`);
  });
  const send = (message: JsonRpcResponse | JsonRpcResponse[] | null) => {
    if (message !== null && !broken) output.write(`${JSON.stringify(message)}\n`);
  };
  const onLine = async (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      send(rpcError(null, RPC_ERRORS.parseError, `Parse error: ${(e as Error).message}`));
      return;
    }
    send(await server.handle(value));
  };
  const splitter = new LineSplitter();
  try {
    // one message at a time, in order: an encounter is a sequence
    for await (const chunk of input as AsyncIterable<string | Uint8Array>) for (const line of splitter.push(chunk)) await onLine(line);
  } catch (e) {
    log(`input error: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const line of splitter.end()) await onLine(line);
  server.shutdown();
}
