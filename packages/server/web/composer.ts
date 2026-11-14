import { api, ApiError, type AgentView, type ToolInfo } from "./api.js";
import { h, replace, toast } from "./dom.js";
import { formFor } from "./form.js";
import { pill } from "./record.js";
import { statusTone, suggestions, type LibraryLite } from "./text.js";

/**
 * Acting as the practitioner: the quick acts of a consultation, and every other tool of the practitioner as a form
 * made from its schema. Whatever is done here goes through the same path as a language model's actions — the
 * engine checks it, it is attributed to the operator, and every browser sees it at once.
 */

export interface ComposerContext {
  id: string;
  tools: ToolInfo[];
  view(): AgentView;
  lib(): LibraryLite | null;
}

const parseTarget = (target: string): Record<string, string> | null => {
  if (target.startsWith("ashi:")) return { ashi: target.slice(5) };
  const [point, side, site] = target.split(":");
  return point && side && ["left", "right", "midline"].includes(side) ? { point, side, ...(site ? { site } : {}) } : null;
};

/** A first draft of the clinical note from what is on the record (facts only: no response is claimed for a needle). */
export function noteDraft(view: AgentView): Record<string, unknown> {
  const used = [...new Map(view.needling.map((n) => [n.target, parseTarget(n.target)])).values()].filter((x): x is Record<string, string> => x !== null);
  const pack = view.equipment.packs.find((p) => !p.sealed) ?? view.equipment.packs[0];
  const needling: Record<string, unknown> = {};
  if (pack) needling.needleType = pack.spec;
  if (view.needling.length) needling.needleCount = view.needling.length;
  if (view.plan && view.needling.length) needling.retentionMinutes = view.plan.retentionMinutes;
  if (view.plan && view.needling.length) needling.stimulation = view.plan.stimulation;
  return {
    record: {
      presentingComplaint: view.patient.presenting,
      ...(view.assessment?.pattern ? { pattern: view.assessment.pattern } : {}),
      ...(view.documentation.consent.status === "given" ? { consent: `Given (plan version ${view.documentation.consent.planVersion ?? "?"}); topics explained: ${view.documentation.consent.topics.join(", ") || "—"}` } : {}),
      ...(used.length ? { pointsUsed: used } : {}),
      ...(Object.keys(needling).length ? { needling } : {}),
    },
  };
}

export function composer(ctx: ComposerContext): { el: HTMLElement; open(tool: string, prefill?: Record<string, unknown>): void; setClosed(closed: boolean): void } {
  const result = h("div", { class: "result", "aria-live": "polite" });
  let busy = false;
  let closed = false;

  const show = (tool: string, ok: boolean, output: unknown) => {
    const o = (output && typeof output === "object" ? output : { value: output }) as Record<string, unknown>;
    if (typeof o.error === "string") return replace(result, pill("not done", "bad"), " ", o.error);
    const tooling = ctx.tools.find((t) => t.name === tool);
    if (tooling?.kind === "read") return replace(result, h("details", { open: true }, h("summary", null, `${tool}: what it says`), h("pre", null, JSON.stringify(output, null, 2).slice(0, 60_000))));
    const status = String(o.status ?? (ok ? "executed" : "rejected"));
    const changed = o.changed && typeof o.changed === "object" ? Object.keys(o.changed as object) : [];
    replace(
      result,
      h("p", null, pill(`${tool}: ${status}`, statusTone(status)), o.message ? ` ${String(o.message)}` : ""),
      Array.isArray(o.observations) && o.observations.length ? h("ul", { class: "plain obs" }, (o.observations as unknown[]).map((x) => h("li", null, String(x)))) : null,
      changed.length ? h("p", { class: "muted" }, `Changed: ${changed.join(", ")}`) : null,
    );
  };

  const run = async (tool: string, input: Record<string, unknown>, done?: () => void) => {
    if (busy) return;
    if (closed) return toast("This record is closed: it can be read, not changed.", "bad");
    busy = true;
    el.classList.add("busy");
    try {
      const answer = await api.act(ctx.id, tool, input);
      show(tool, answer.ok, answer.output);
      if (answer.ok) done?.();
    } catch (e) {
      replace(result, pill("error", "bad"), ` ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      busy = false;
      el.classList.remove("busy");
    }
  };

  const quick = (tool: string, field: string, placeholder: string, label: string) => {
    const input = h("input", { type: "text", placeholder, "aria-label": placeholder, autocomplete: "off" });
    return h(
      "form",
      {
        class: "quick-line",
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            void run(tool, { [field]: text }, () => (input.value = ""));
          },
        },
      },
      input,
      h("button", { type: "submit" }, label),
    );
  };
  const minutes = h("input", { type: "number", min: 1, max: 60, value: 5, class: "narrow", "aria-label": "minutes to wait" });
  const button = (label: string, tool: string, input: () => Record<string, unknown> = () => ({})) => h("button", { type: "button", class: "small", on: { click: () => void run(tool, input()) } }, label);

  // every tool, by the stage of an encounter it belongs to
  const groups = new Map<string, ToolInfo[]>();
  for (const t of ctx.tools) (groups.get(t.group) ?? groups.set(t.group, []).get(t.group)!).push(t);
  const select = h("select", { "aria-label": "all actions" }, h("option", { value: "" }, "— choose an action —"), [...groups].map(([group, tools]) => h("optgroup", { label: group }, tools.map((t) => h("option", { value: t.name }, t.name)))));
  const description = h("p", { class: "desc" });
  const formHost = h("div", { class: "form-host" });
  let current: { tool: ToolInfo; form: ReturnType<typeof formFor> } | null = null;
  const choose = (name: string, prefill?: Record<string, unknown>) => {
    const tool = ctx.tools.find((t) => t.name === name);
    select.value = tool ? name : "";
    if (!tool) {
      current = null;
      replace(description);
      replace(formHost);
      return;
    }
    const form = formFor(tool.inputSchema, { tool: tool.name, suggest: (path) => suggestions(tool.name, path, ctx.view(), ctx.lib()) });
    if (prefill) form.set(prefill);
    current = { tool, form };
    replace(description, tool.description);
    replace(
      formHost,
      h(
        "form",
        {
          class: "tool-form",
          on: {
            submit: (e: Event) => {
              e.preventDefault();
              if (current) void run(current.tool.name, current.form.read());
            },
          },
        },
        Object.keys((tool.inputSchema.properties ?? {}) as object).length ? form.el : h("p", { class: "muted" }, "Nothing to fill in."),
        h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, tool.kind === "read" ? "Look it up" : `Do it: ${tool.name}`), h("button", { type: "button", class: "small", on: { click: () => choose(tool.name, prefill) } }, "clear")),
      ),
    );
  };
  select.addEventListener("change", () => choose(select.value));

  const el = h(
    "section",
    { class: "card act", "aria-label": "act as the practitioner" },
    h("h3", null, "Act as the practitioner"),
    h("p", { class: "muted small" }, "Everything you do here is checked by the engine, recorded under your name and shown to everyone watching."),
    quick("ask", "text", "Ask the patient… (one or two things at a time)", "Ask"),
    quick("say", "text", "Say to the patient…", "Say"),
    quick("examine", "text", "Examine… (e.g. inspect the tongue)", "Examine"),
    h(
      "div",
      { class: "row wrap" },
      button("Observe", "observe"),
      button("Check vitals", "check_vitals"),
      button("Monitor", "monitor"),
      button("Hand hygiene", "hand_hygiene"),
      button("Count needles", "count_needles"),
      h("span", { class: "wait" }, button("Wait", "wait", () => ({ minutes: Number(minutes.value) || 5 })), minutes, " min"),
    ),
    h("div", { class: "row" }, h("button", { type: "button", class: "note-button", on: { click: () => choose("document", noteDraft(ctx.view())) } }, "Write the clinical note…")),
    h("label", { class: "block" }, "All actions", select),
    description,
    formHost,
    result,
  );
  return {
    el,
    open: choose,
    setClosed(value: boolean) {
      closed = value;
      el.classList.toggle("closed", value);
    },
  };
}
