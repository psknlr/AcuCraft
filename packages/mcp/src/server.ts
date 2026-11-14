import { ACUCRAFT_VERSION, observeAs, createEncounter, type EncounterLog } from "@acucraft/core";
import { systemPrompt, toolsFor, type ObjectSchema, type ToolDefinition } from "@acucraft/agent";
import { requireScenario, type ContentPack, type EncounterReport } from "@acucraft/bench";
import { classify, LineSplitter, RPC_ERRORS, RpcError, rpcError, rpcResult, type JsonRpcResponse } from "./jsonrpc.js";
import { MemoryStore, type ClientRef, type EncounterStore } from "./store.js";

/**
 * `acucraft mcp` — a Model Context Protocol server that lets an external agent play the practitioner: `initialize`,
 * `ping`, `tools/list`, `tools/call`. Over stdio here (one JSON-RPC 2.0 message per line); `acu serve` serves the same
 * server over HTTP, on the live records of its browser workspace (`@acucraft/server`, docs/WEB.md).
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
  /** Where the encounters live (default: this server's own, in memory — the stdio case). */
  store?: EncounterStore;
  /** The connection, for a store shared by several (default: one stdio client). */
  connection?: string;
  /** Open encounters kept before the least recently used is closed (default 16; the default store only). */
  maxSessions?: number;
  /** Called when an encounter is finished or abandoned: its replayable log and its report (the default store only). */
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

const SESSION_ID = { type: "string", description: "The session_id start_encounter gave you." } as const;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Every action a practitioner under test may take in any family of the pack (the engine still decides each call), once per pack. */
const DEFINITIONS = new WeakMap<ContentPack, ToolDefinition[]>();
function definitionsOf(pack: ContentPack): ToolDefinition[] {
  let defs = DEFINITIONS.get(pack);
  if (!defs) {
    const may = new Set<string>();
    for (const family of pack.families.values()) {
      const sc = requireScenario(pack, `${family.id}/${family.variantIds[0]}`);
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      for (const type of observeAs(sc, createEncounter(sc, { seed: 1 }), actor).you.may) may.add(type);
    }
    defs = toolsFor([...may], { skills: pack.skills.length > 0 });
    DEFINITIONS.set(pack, defs);
  }
  return defs;
}

export class McpServer {
  private readonly pack: ContentPack;
  private readonly store: EncounterStore;
  private readonly definitions: ToolDefinition[];
  private readonly log: (message: string) => void;
  /** Who is calling: the connection, and the name the client gave on `initialize`. */
  private readonly client: ClientRef;

  constructor(options: McpServerOptions) {
    this.pack = options.pack;
    this.log = options.log ?? ((m) => process.stderr.write(`[acucraft mcp] ${m}\n`));
    this.store = options.store ?? new MemoryStore(options.pack, { maxSessions: options.maxSessions, onClosed: options.onClosed, log: this.log });
    this.client = { id: options.connection ?? "stdio", name: "mcp client" };
    this.definitions = definitionsOf(this.pack);
  }

  /** The name the client gave on `initialize` ("mcp client" until then). */
  get clientName(): string {
    return this.client.name;
  }

  /** The instructions a client is given on `initialize`: the practitioner's standing instructions, and how sessions work. */
  instructions(): string {
    const join = this.store.openEncounters
      ? " list_open_encounters shows the encounters already open on this server — started by a person in the browser workspace, or by another client — and any of their session_ids works with every tool: you and they work on one record, and each action's result says what the others did meanwhile."
      : "";
    return `${systemPrompt(this.pack.skills)}\n\nThrough this server\n\nCall list_encounters, then start_encounter: it returns a session_id and your opening view. Pass session_id with every other tool.${join} When the encounter is finished (finish_encounter), get_report gives its independent evaluation — a teaching-script measure, not a validated competency score.`;
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
    if (this.store.openEncounters) {
      own.push({
        name: "list_open_encounters",
        description: "The encounters already open on this server — started by a person in the browser workspace or by another client — each with its session_id, the patient and where it stands. Pass a session_id to any tool to work on that encounter with them.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true },
      });
    }
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
        const p = record(params);
        const asked = p.protocolVersion;
        const name = record(p.clientInfo).name;
        if (typeof name === "string" && name.trim()) this.client.name = name.trim().slice(0, 60);
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
    if (name === "list_encounters") return { ok: true, output: this.store.families() };
    if (name === "start_encounter") return this.store.open(args, this.client);
    if (name === "list_open_encounters" && this.store.openEncounters) return this.store.openEncounters(this.client);
    const id = typeof args.session_id === "string" ? args.session_id : "";
    const none = { ok: false, output: { error: `no open encounter ${String(args.session_id ?? "")}: call start_encounter first` } };
    if (name === "get_report") return this.store.report(id, args.abandon === true, this.client) ?? none;
    const tool = this.definitions.find((t) => t.name === name);
    if (!tool) return { ok: false, output: { error: `There is no tool ${name}.` } };
    const { session_id: _session, ...input } = args;
    return this.store.call(id, tool, input, this.client) ?? none;
  }

  /** Close every encounter still open (the input ended). */
  shutdown(): void {
    this.store.shutdown?.();
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
