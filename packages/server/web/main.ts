import { agentPanel } from "./agent.js";
import { api, ApiError, me, setName, stream, type EncounterSnapshot, type EncounterSummary, type Info, type ToolInfo } from "./api.js";
import { composer } from "./composer.js";
import { copy, h, replace, toast } from "./dom.js";
import { banner, pill, renderRecord, reportCard } from "./record.js";
import { ago, libraryLite, minute, type LibraryLite } from "./text.js";

/**
 * The AcuCraft workspace in the browser (docs/WEB.md): the list of records, and one encounter's complete record —
 * kept live from the server's event stream, so that what the operator, the server's language model and any MCP
 * client do appears here as it happens.
 */

interface Open {
  id: string;
  snapshot: EncounterSnapshot;
  tools: ToolInfo[];
  lib: LibraryLite | null;
  /** The keys of what has been drawn (null: not drawn yet, so nothing is marked new on the first drawing). */
  seen: Set<string> | null;
  act: ReturnType<typeof composer>;
  agent: ReturnType<typeof agentPanel>;
}

const state = {
  info: null as Info | null,
  encounters: new Map<string, EncounterSummary>(),
  open: null as Open | null,
  stop: null as (() => void) | null,
  conn: "connecting" as "live" | "connecting" | "offline",
  filter: "",
};

/* ------------------------------------------------------------------ */
/* the frame                                                           */
/* ------------------------------------------------------------------ */

const app = document.getElementById("app")!;
const conn = h("span", { class: "conn", title: "the live link to the server" });
const nameInput = h("input", { type: "text", value: me.name, maxlength: 40, "aria-label": "your name, as the timeline shows it" });
nameInput.addEventListener("change", () => {
  setName(nameInput.value);
  nameInput.value = me.name;
  toast(`You act as ${me.name}`, "info");
});
const list = h("ul", { class: "encounters" });
const search = h("input", { type: "search", placeholder: "Find a record…", "aria-label": "find a record" });
search.addEventListener("input", () => {
  state.filter = search.value.trim().toLowerCase();
  drawList();
});
const newForm = h("div", { class: "new" });
const main = h("main", { id: "main" });
const side = h("aside", { id: "side" });

replace(
  app,
  h(
    "header",
    { class: "top" },
    h("a", { class: "brand", href: "#/" }, h("img", { src: "/app/icon.svg", alt: "", width: 22, height: 22 }), "AcuCraft · Patient records"),
    h("span", { class: "clinic muted" }),
    conn,
    h("label", { class: "me" }, "You: ", nameInput),
  ),
  h("div", { class: "layout" }, h("nav", { id: "sidebar", "aria-label": "records" }, newForm, search, list), main, side),
);

function drawConn(): void {
  replace(conn, h("span", { class: ["dot", state.conn] }), state.conn === "live" ? "live" : state.conn === "connecting" ? "connecting…" : "offline");
}

/* ------------------------------------------------------------------ */
/* the list of records                                                 */
/* ------------------------------------------------------------------ */

const statusPill = (s: EncounterSummary) =>
  s.status === "open" ? pill("open", "info") : pill(`${s.status}${s.outcome ? ` · ${s.outcome}` : ""}`, s.outcome === "success" ? "ok" : s.outcome === "adjudicate" ? "warn" : s.status === "closed" ? "muted" : "bad");
const agentPill = (s: EncounterSummary) => (s.agent && ["thinking", "awaiting-approval", "paused"].includes(s.agent.state) ? pill(`LLM ${s.agent.state}`, "llm") : null);

function drawList(): void {
  const items = [...state.encounters.values()]
    .filter((s) => !state.filter || `${s.patient} ${s.title} ${s.status} ${s.id}`.toLowerCase().includes(state.filter))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  replace(
    list,
    items.length
      ? items.map((s) =>
          h(
            "li",
            { class: ["enc", state.open?.id === s.id ? "active" : ""] },
            h(
              "a",
              { href: `#/e/${s.id}` },
              h("strong", null, s.patient),
              h("span", { class: "title" }, s.title),
              h("span", { class: "meta" }, statusPill(s), agentPill(s), ` ${minute(s.minute)} · ${s.actions} actions${s.viewers > 1 ? ` · ${s.viewers} watching` : ""} · ${ago(s.updatedAt)}`),
            ),
          ),
        )
      : h("li", { class: "empty" }, state.encounters.size ? "No record matches." : "No records yet: start an encounter above."),
  );
}

function drawNewForm(info: Info): void {
  const family = h("select", { "aria-label": "family" }, info.families.map((f) => h("option", { value: f.family }, f.title)));
  const variant = h("select", { "aria-label": "variant" });
  const fill = () => {
    const f = info.families.find((x) => x.family === family.value);
    replace(variant, h("option", { value: "" }, "variant chosen by the seed"), Array.from({ length: f?.variants ?? 0 }, (_, i) => h("option", { value: String(i + 1) }, `variant ${i + 1}`)));
  };
  family.addEventListener("change", fill);
  fill();
  const seed = h("input", { type: "number", value: 1, min: 1, step: 1, class: "narrow", "aria-label": "seed" });
  const mode = h("select", { "aria-label": "mode" }, h("option", { value: "assessment" }, "assessment"), h("option", { value: "teaching" }, "teaching (shows reference locations)"));
  const file = h("input", { type: "file", accept: ".json,application/json", "aria-label": "import a log" });
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const made = await api.importLog(JSON.parse(await f.text()) as unknown);
      toast("Log imported as a new record", "ok");
      location.hash = `#/e/${made.id}`;
    } catch (e) {
      toast(`Could not import it: ${e instanceof ApiError ? e.message : String(e)}`, "bad");
    } finally {
      file.value = "";
    }
  });
  replace(
    newForm,
    h(
      "details",
      { class: "card", open: true },
      h("summary", null, "+ New encounter"),
      h(
        "form",
        {
          class: "stack",
          on: {
            submit: async (e: Event) => {
              e.preventDefault();
              try {
                const made = await api.create({ family: family.value, ...(variant.value ? { variant: Number(variant.value) } : {}), seed: Number(seed.value) || 1, mode: mode.value });
                location.hash = `#/e/${made.id}`;
              } catch (err) {
                toast(err instanceof ApiError ? err.message : String(err), "bad");
              }
            },
          },
        },
        family,
        variant,
        h("div", { class: "row" }, h("label", { class: "inline" }, "seed ", seed), mode),
        h("button", { type: "submit", class: "primary" }, "Start the encounter"),
        h("p", { class: "muted small" }, "A variant changes one thing about the case. Its name is not shown while the encounter is open."),
      ),
      h("label", { class: "file" }, h("span", null, "Or import a saved log (", h("code", null, "log.json"), ") as a new record"), file),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* one record                                                          */
/* ------------------------------------------------------------------ */

let frame = 0;
/** Draw the open record again (at most once a frame: a language model may act faster than the screen). */
function redraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    drawRecord();
  });
}

function drawRecord(): void {
  const open = state.open;
  if (!open) return;
  const snap = open.snapshot;
  const first = open.seen === null;
  const seen = open.seen ?? new Set<string>();
  const fresh = (key: string) => {
    const isNew = !seen.has(key);
    seen.add(key);
    return !first && isNew;
  };
  open.seen = seen;
  const s = snap.summary;
  const tools = h(
    "div",
    { class: "row wrap toolbar" },
    s.status === "open"
      ? h(
          "button",
          {
            type: "button",
            on: {
              click: async () => {
                if (!confirm("Close this encounter as it stands? It is then evaluated and can no longer be changed.")) return;
                try {
                  await api.close(open.id, true);
                } catch (e) {
                  toast(e instanceof ApiError ? e.message : String(e), "bad");
                }
              },
            },
          },
          "Close as it stands",
        )
      : null,
    h("a", { class: "button", href: api.logUrl(open.id), download: `${open.id}-log.json` }, "Download the log"),
    h("button", { type: "button", on: { click: () => print() } }, "Print the record"),
    h("button", { type: "button", class: "small", title: "for an MCP client: list_open_encounters", on: { click: () => void copy(open.id, "the session id") } }, `session ${open.id}`),
    h(
      "button",
      {
        type: "button",
        class: "danger",
        on: {
          click: async () => {
            if (!confirm("Delete this record? Its log and timeline are removed from the server.")) return;
            try {
              await api.remove(open.id);
            } catch (e) {
              toast(e instanceof ApiError ? e.message : String(e), "bad");
            }
          },
        },
      },
      "Delete",
    ),
  );
  replace(
    main,
    banner(snap.view, [statusPill(s), agentPill(s), s.viewers > 1 ? pill(`${s.viewers} watching`, "muted") : null, pill(`variant ${s.variant} of ${s.variants} · seed ${s.seed}`, "muted")]),
    tools,
    snap.report
      ? reportCard(snap.report, [
          h("a", { class: "button", href: api.debriefUrl(open.id), target: "_blank", rel: "noopener" }, "Open the debrief (shows hidden truth)"),
          h("a", { class: "button", href: api.logUrl(open.id), download: `${open.id}-log.json` }, "Download the log"),
        ])
      : null,
    renderRecord({ view: snap.view, timeline: snap.timeline, lib: open.lib, fresh }),
  );
}

async function openRecord(id: string): Promise<void> {
  state.stop?.();
  state.open = null;
  replace(main, h("p", { class: "boot" }, "Opening the record…"));
  replace(side);
  let snapshot: EncounterSnapshot;
  let tools: ToolInfo[];
  try {
    [snapshot, { tools }] = await Promise.all([api.snapshot(id), api.tools(id)]);
  } catch (e) {
    replace(main, h("div", { class: "card" }, h("h2", null, "This record cannot be opened"), h("p", null, e instanceof ApiError ? e.message : String(e)), h("a", { href: "#/" }, "Back to the records")));
    listen(null);
    return;
  }
  const open: Open = { id, snapshot, tools, lib: null, seen: null, act: undefined!, agent: undefined! };
  open.act = composer({ id, tools, view: () => open.snapshot.view, lib: () => open.lib });
  open.agent = agentPanel({ id, info: state.info! });
  state.open = open;
  const closed = snapshot.summary.status !== "open";
  open.act.setClosed(closed);
  open.agent.setClosed(closed);
  open.agent.update(snapshot.agent);
  replace(side, open.act.el, open.agent.el);
  drawRecord();
  drawList();
  listen(id);
  void loadLibrary(open);
}

/** The public library, cut to what the forms suggest (the points, regions, vocabulary and clinic of this encounter). */
async function loadLibrary(open: Open): Promise<void> {
  const look = async (topic: string, id?: string) => (await api.act(open.id, "lookup", { topic, ...(id ? { id } : {}) })).output;
  try {
    const [vocabulary, clinic, points, regions] = await Promise.all([look("vocabulary"), look("clinic"), look("points"), look("regions")]);
    const region = await Promise.all((Array.isArray(regions) ? regions : []).map((r) => look("region", String((r as { id: string }).id))));
    open.lib = libraryLite({ vocabulary, clinic, points, regions, region });
    if (state.open === open) redraw();
  } catch {
    /* the forms work without suggestions */
  }
}

function home(): void {
  state.stop?.();
  state.open = null;
  replace(side);
  const info = state.info!;
  const command = `claude mcp add --transport http acucraft ${location.origin}/mcp${info.auth.token ? ' --header "Authorization: Bearer <the server\'s token>"' : ""}`;
  replace(
    main,
    h(
      "section",
      { class: "card welcome" },
      h("h2", null, "Acupuncture patient records, live"),
      h(
        "p",
        null,
        "Each record here is a simulated acupuncture encounter in the clinic, kept by the AcuCraft engine. You, a language model run by this server, and any model connected over MCP work on the same record together: every action is checked by the engine, recorded with who did it, and shown in every browser as it happens.",
      ),
      h(
        "ol",
        null,
        h("li", null, "Start an encounter (left), or open a record."),
        h("li", null, "Work it yourself from the panel on the right — ask, examine, assess, plan, consent, mark, needle, write the note — or start a language model on it and watch, pause, approve or take over."),
        h("li", null, "When the encounter is finished (or closed as it stands), its evaluation appears, with the replayable log."),
      ),
      h("h3", null, "Connect a model over MCP"),
      h("p", null, h("code", { class: "copyable" }, command), " ", h("button", { type: "button", class: "small", on: { click: () => void copy(command, "the command") } }, "copy")),
      h("p", { class: "muted small" }, `AcuCraft ${info.version} · engine ClinicalCraft ${info.clinicalcraft.slice(0, 7)} · all clinical content is AI-assisted and unreviewed: a simulation for teaching and research, not clinical advice.`),
    ),
  );
  drawList();
  listen(null);
}

/* ------------------------------------------------------------------ */
/* the live link                                                       */
/* ------------------------------------------------------------------ */

function listen(id: string | null): void {
  state.stop?.();
  state.stop = stream(id, {
    status(s) {
      state.conn = s;
      drawConn();
    },
    hello(d) {
      state.encounters = new Map(d.encounters.map((x) => [x.id, x]));
      drawList();
      const open = state.open;
      if (open && d.snapshot && d.snapshot.summary.id === open.id) {
        open.snapshot = d.snapshot;
        open.agent.update(d.snapshot.agent);
        const closed = d.snapshot.summary.status !== "open";
        open.act.setClosed(closed);
        open.agent.setClosed(closed);
        redraw();
      }
    },
    summary(s) {
      state.encounters.set(s.id, s);
      drawList();
      if (state.open?.id === s.id) {
        state.open.snapshot.summary = s;
        redraw();
      }
    },
    removed(id) {
      state.encounters.delete(id);
      drawList();
      if (state.open?.id === id) {
        toast("This record was deleted", "info");
        location.hash = "#/";
      }
    },
    update(d) {
      const open = state.open;
      if (!open) return;
      open.snapshot.view = d.view;
      if (!open.snapshot.timeline.some((e) => e.seq === d.entry.seq)) open.snapshot.timeline.push(d.entry);
      redraw();
    },
    agent(d) {
      const open = state.open;
      if (!open) return;
      open.snapshot.agent = d.agent;
      open.agent.update(d.agent);
      if (d.item) open.agent.add(d.item);
    },
    closed(d) {
      const open = state.open;
      if (!open) return;
      open.snapshot.report = d.report;
      open.act.setClosed(true);
      open.agent.setClosed(true);
      open.agent.update(open.snapshot.agent);
      toast(`The encounter is over: ${d.report.primary.status}`, d.report.primary.status === "success" ? "ok" : "info");
      redraw();
    },
  });
}

function route(): void {
  const m = /^#\/e\/(enc-[a-z0-9]+)$/.exec(location.hash);
  if (m) void openRecord(m[1]!);
  else home();
}

async function boot(): Promise<void> {
  drawConn();
  try {
    state.info = await api.info();
  } catch (e) {
    replace(
      main,
      h(
        "div",
        { class: "card" },
        h("h2", null, "The workspace cannot reach its server"),
        h("p", null, e instanceof ApiError && e.status === 401 ? "This server needs its access token: open the address it printed when it started (it ends in ?token=…)." : String(e instanceof Error ? e.message : e)),
      ),
    );
    return;
  }
  replace(app.querySelector(".clinic")!, `${state.info.families.length} case families`);
  drawNewForm(state.info);
  addEventListener("hashchange", route);
  setInterval(drawList, 30_000);
  route();
}

void boot();
