import type { EncounterLog, Mode } from "@acucraft/core";
import { EncounterSession, openingText, type ToolContext, type ToolDefinition } from "@acucraft/agent";
import { CLINICALCRAFT_REV, evaluateEncounter, requireScenario, type ContentPack, type EncounterReport, type FamilyEntry } from "@acucraft/bench";

/**
 * Where an MCP server's encounters live. Over stdio they are the server's own (`MemoryStore`: one client, gone when
 * it disconnects); served by `acu serve` they are the live records of the browser workspace (`@acucraft/server`),
 * which an operator in a browser and any number of clients work on together.
 */

/** A tool call's answer: a failure is a result the client's model can read, not a protocol error. */
export interface StoreResult {
  ok: boolean;
  output: unknown;
}

/** Who is calling: an id unique to one connection, and the name the client gave (`initialize`'s `clientInfo`). */
export interface ClientRef {
  id: string;
  name: string;
}

export interface EncounterStore {
  /** The encounters that can be started: each family with the number of its variants (never their names). */
  families(): { family: string; title: string; variants: number }[];
  /** Start an encounter (`start_encounter`'s arguments): `{ session_id, opening }`. */
  open(args: Record<string, unknown>, client: ClientRef): StoreResult;
  /** The encounters already open that a client may join (absent: none can be joined, and there is no such tool). */
  openEncounters?(client: ClientRef): StoreResult;
  /** One tool call on an open encounter; null when there is no open encounter `id`. */
  call(id: string, tool: ToolDefinition, input: Record<string, unknown>, client: ClientRef): StoreResult | null;
  /** The independent evaluation of an encounter (closing it first with `abandon`); null when there is no encounter `id`. */
  report(id: string, abandon: boolean, client: ClientRef): StoreResult | null;
  /** The server is going away. */
  shutdown?(): void;
}

/** What `start_encounter` asked for, checked against the pack: the scenario to open, or why there is none. */
export type StartChoice = { ok: true; family: FamilyEntry; index: number; seed: number; mode: Mode; scenarioId: string } | { ok: false; output: unknown };

export function startChoice(pack: ContentPack, args: Record<string, unknown>): StartChoice {
  const family = typeof args.family === "string" ? pack.families.get(args.family) : undefined;
  if (!family) return { ok: false, output: { error: `no family ${String(args.family ?? "")}`, families: [...pack.families.keys()] } };
  const seed = Number.isInteger(args.seed) ? (args.seed as number) : 1;
  const n = family.variantIds.length;
  if (args.variant !== undefined && !(Number.isInteger(args.variant) && (args.variant as number) >= 1 && (args.variant as number) <= n)) return { ok: false, output: { error: `variant is a number from 1 to ${n}` } };
  const index = args.variant !== undefined ? (args.variant as number) - 1 : (((seed - 1) % n) + n) % n;
  const mode: Mode = args.mode === "teaching" ? "teaching" : "assessment";
  return { ok: true, family, index, seed, mode, scenarioId: `${family.id}/${family.variantIds[index]}` };
}

/** The families of a pack, as `list_encounters` gives them. */
export function familiesOf(pack: ContentPack): { family: string; title: string; variants: number }[] {
  return [...pack.families.values()].map((f) => ({ family: f.id, title: (f.source.family as { title: string }).title, variants: f.variantIds.length }));
}

/** The part of an evaluation a client is given (`get_report`). */
export function reportOutput(report: EncounterReport, finished: boolean): Record<string, unknown> {
  return {
    notice: report.notice,
    finished,
    primary: report.primary,
    tracks: Object.fromEntries(Object.entries(report.tracks).map(([k, t]) => [k, { score: t.score, missed: t.items.filter((i) => i.met === false).map((i) => i.label) }])),
    criticalErrors: report.criticalErrors,
    unsafe: report.unsafe,
    points: report.points,
    efficiency: report.efficiency,
  };
}

/** One tool on one session: a read answered from the view and the library, or an action stepped by the engine. */
export function callOn(session: EncounterSession, tool: ToolDefinition, input: Record<string, unknown>, skills: ContentPack["skills"]): StoreResult & { acted: boolean } {
  if (tool.kind === "read") {
    const ctx: ToolContext = { library: session.library(), view: session.view(), skills };
    return { ...tool.run(input, ctx), acted: false };
  }
  const parsed = tool.toAction(input);
  if (!parsed.ok) return { ok: false, output: { error: parsed.error }, acted: false };
  const done = session.act(parsed.action);
  return { ok: done.attempt.status !== "rejected" && done.attempt.status !== "blocked", output: done.result, acted: true };
}

interface Open {
  id: string;
  session: EncounterSession;
  used: number;
  closed: boolean;
}

export interface MemoryStoreOptions {
  /** Open encounters kept before the least recently used is closed (default 16). */
  maxSessions?: number;
  /** Called when an encounter is finished or abandoned: its replayable log and its report (the command line writes them). */
  onClosed?: (closed: { sessionId: string; log: EncounterLog; report: EncounterReport }) => void;
  log?: (message: string) => void;
}

/** The encounters of one stdio client: in memory, the least recently used closed to make room. */
export class MemoryStore implements EncounterStore {
  private readonly sessions = new Map<string, Open>();
  private readonly maxSessions: number;
  private readonly onClosed: MemoryStoreOptions["onClosed"];
  private readonly log: (message: string) => void;
  private opened = 0;
  private clock = 0;

  constructor(
    private readonly pack: ContentPack,
    options: MemoryStoreOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 16;
    this.onClosed = options.onClosed;
    this.log = options.log ?? (() => {});
  }

  families() {
    return familiesOf(this.pack);
  }

  open(args: Record<string, unknown>): StoreResult {
    const choice = startChoice(this.pack, args);
    if (!choice.ok) return choice;
    const session = new EncounterSession(requireScenario(this.pack, choice.scenarioId), { seed: choice.seed, mode: choice.mode });
    // an opaque id: it names neither the variant nor anything else of the scenario
    const id = `enc-${++this.opened}-${Math.abs(Math.imul(choice.seed + 0x9e3779b9, this.opened * 2654435761)).toString(36)}`;
    this.sessions.set(id, { id, session, used: ++this.clock, closed: false });
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.used - b.used)[0]!;
      this.close(oldest);
      this.sessions.delete(oldest.id);
    }
    return { ok: true, output: { session_id: id, opening: openingText(session.view()) } };
  }

  call(id: string, tool: ToolDefinition, input: Record<string, unknown>): StoreResult | null {
    const open = this.sessions.get(id);
    if (!open) return null;
    open.used = ++this.clock;
    if (open.closed) return { ok: false, output: { error: "This encounter is closed: get_report has its evaluation." } };
    const { ok, output, acted } = callOn(open.session, tool, input, this.pack.skills);
    if (acted && open.session.finished) this.close(open);
    return { ok, output };
  }

  report(id: string, abandon: boolean): StoreResult | null {
    const open = this.sessions.get(id);
    if (!open) return null;
    open.used = ++this.clock;
    if (!open.session.finished && !open.closed) {
      if (!abandon) return { ok: false, output: { error: "The encounter is still open. Finish it (end_visit, then finish_encounter) — or pass abandon: true to close it as it stands." } };
      this.close(open);
    }
    return { ok: true, output: reportOutput(evaluateEncounter(open.session.scenario, open.session.state), open.session.finished) };
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

  shutdown(): void {
    for (const open of this.sessions.values()) this.close(open);
  }
}
