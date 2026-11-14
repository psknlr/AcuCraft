import { api, ApiError, type Info, type RunnerSnapshot, type TranscriptItem } from "./api.js";
import { copy, h, replace, toast } from "./dom.js";
import { pill } from "./record.js";
import { clock } from "./text.js";

/**
 * The language model in the workspace: start one on the encounter (Claude through the Messages API, or the
 * scenario's reference trajectory as an offline demonstration of the loop), watch it work, pause it, approve its
 * actions one by one, or stop it — and how to connect a model of your own over MCP to the same record.
 */

export interface AgentPanelContext {
  id: string;
  info: Info;
}

const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = { thinking: "info", "awaiting-approval": "warn", paused: "warn", finished: "ok", stopped: "muted", failed: "bad" };

export function agentPanel(ctx: AgentPanelContext): { el: HTMLElement; update(agent: RunnerSnapshot | null): void; add(item: TranscriptItem): void; setClosed(closed: boolean): void } {
  const provider = h(
    "select",
    { "aria-label": "who plays the practitioner" },
    h("option", { value: "claude" }, ctx.info.languageModel.claude ? "Claude (Messages API)" : "Claude (Messages API — no API key on the server)"),
    h("option", { value: "reference" }, "Reference trajectory (offline demo, not a model)"),
  );
  if (!ctx.info.languageModel.claude) provider.value = "reference";
  const model = h("input", { type: "text", value: "claude-opus-5-5", "aria-label": "model", spellcheck: "false" });
  const effort = h("select", { "aria-label": "effort" }, ["low", "medium", "high", "xhigh", "max"].map((e) => h("option", { value: e, selected: e === "high" }, `effort ${e}`)));
  const supervised = h("input", { type: "checkbox" });
  const status = h("p", { class: "status" });
  const pending = h("div", { class: "pending" });
  const list = h("ol", { class: "transcript", "aria-live": "polite" });
  const send = async (op: "start" | "pause" | "resume" | "stop") => {
    try {
      const out = await api.agent(ctx.id, op, op === "start" ? { provider: provider.value, model: model.value.trim(), effort: effort.value, supervised: supervised.checked } : {});
      update(out.agent);
      if (op === "start") replace(list);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), "bad");
    }
  };
  const start = h("button", { type: "button", class: "primary", on: { click: () => void send("start") } }, "Start");
  const pause = h("button", { type: "button", on: { click: () => void send("pause") } }, "Pause");
  const resume = h("button", { type: "button", on: { click: () => void send("resume") } }, "Resume");
  const stop = h("button", { type: "button", on: { click: () => void send("stop") } }, "Stop");
  const claudeOnly = h("span", { class: "claude-only row wrap" }, model, effort);
  provider.addEventListener("change", () => claudeOnly.classList.toggle("hidden", provider.value !== "claude"));
  claudeOnly.classList.toggle("hidden", provider.value !== "claude");

  const origin = location.origin;
  const command = `claude mcp add --transport http acucraft ${origin}/mcp${ctx.info.auth.token ? ' --header "Authorization: Bearer <the server\'s token>"' : ""}`;
  const mcp = h(
    "details",
    { class: "mcp" },
    h("summary", null, "Connect your own model over MCP"),
    h("p", null, "Any MCP client works on this same record: it sees what you see, its actions appear here as they happen, and each of its results says what you did meanwhile."),
    h("p", null, h("code", { class: "copyable" }, command), " ", h("button", { type: "button", class: "small", on: { click: () => void copy(command, "the command") } }, "copy")),
    h("p", null, "Then ask it to call ", h("code", null, "list_open_encounters"), " and work on session ", h("code", { class: "copyable" }, ctx.id), " ", h("button", { type: "button", class: "small", on: { click: () => void copy(ctx.id, "the session id") } }, "copy")),
  );

  let closed = false;
  const el = h(
    "section",
    { class: "card agent", "aria-label": "language model" },
    h("h3", null, "Language model"),
    h("div", { class: "controls" }, provider, claudeOnly, h("label", { class: "check" }, supervised, " approve each action before it is done")),
    h("div", { class: "row wrap" }, start, pause, resume, stop),
    status,
    pending,
    list,
    mcp,
  );

  function item(t: TranscriptItem): HTMLElement {
    const detail = t.detail as { calls?: { name: string; input: unknown }[]; status?: string } | undefined;
    return h(
      "li",
      { class: ["t", t.kind] },
      h("span", { class: "when" }, clock(t.at)),
      t.kind === "action" && detail?.status ? pill(detail.status, detail.status === "executed" ? "ok" : detail.status === "partial" ? "warn" : "bad") : null,
      h("span", { class: "text" }, t.text),
      t.kind === "model" && detail?.calls?.length ? h("span", { class: "chips" }, detail.calls.map((c) => h("span", { class: "chip", title: JSON.stringify(c.input) }, c.name))) : null,
    );
  }

  function update(agent: RunnerSnapshot | null): void {
    const active = !!agent && ["thinking", "awaiting-approval", "paused"].includes(agent.state);
    start.disabled = closed || active;
    pause.disabled = !active || agent!.state === "paused";
    resume.disabled = !active || agent!.state !== "paused";
    stop.disabled = !active;
    for (const c of [provider, model, effort, supervised]) c.disabled = active || closed;
    if (!agent) {
      replace(status, h("span", { class: "muted" }, closed ? "This record is closed." : "No language model has worked on this encounter."));
      replace(pending);
      return;
    }
    const u = agent.usage;
    replace(
      status,
      pill(agent.state, STATE_TONE[agent.state] ?? "muted"),
      ` ${agent.label}${agent.supervised ? " · approving each action" : ""} · ${agent.actions} action${agent.actions === 1 ? "" : "s"}`,
      u && u.modelCalls ? ` · ${u.modelCalls} model turns, ${(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens).toLocaleString()} tokens in, ${u.outputTokens.toLocaleString()} out` : "",
      agent.note && !active ? h("span", { class: "muted" }, ` — ${agent.note}`) : null,
    );
    if (agent.pending) {
      const reason = h("input", { type: "text", placeholder: "why not (the model is told)", "aria-label": "reason" });
      replace(
        pending,
        h(
          "div",
          { class: ["card", "inner", agent.pending.why] },
          h("p", null, h("strong", null, agent.pending.why === "approval" ? "Waiting for your approval: " : "Held while paused: "), h("code", null, agent.pending.tool)),
          h("pre", null, JSON.stringify(agent.pending.input, null, 2)),
          agent.pending.why === "approval"
            ? h(
                "div",
                { class: "row wrap" },
                h("button", { type: "button", class: "primary", on: { click: () => void decide(true) } }, "Approve"),
                reason,
                h("button", { type: "button", on: { click: () => void decide(false, reason.value) } }, "Don't do it"),
              )
            : h("p", { class: "muted" }, "Resume to carry it out, or stop the model."),
        ),
      );
    } else replace(pending);
    if (list.childElementCount === 0 && agent.transcript.length) replace(list, agent.transcript.map(numbered));
  }

  function numbered(t: TranscriptItem): HTMLElement {
    const li = item(t);
    li.dataset.seq = String(t.seq);
    return li;
  }

  async function decide(approve: boolean, reason?: string): Promise<void> {
    try {
      update((await api.decide(ctx.id, approve, reason)).agent);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), "bad");
    }
  }

  update(null);
  return {
    el,
    update,
    add(t: TranscriptItem) {
      const last = list.lastElementChild as HTMLElement | null;
      if (last?.dataset.seq && Number(last.dataset.seq) >= t.seq) return;
      list.appendChild(numbered(t));
      while (list.childElementCount > 300) list.firstElementChild?.remove();
      list.scrollTop = list.scrollHeight;
    },
    setClosed(value: boolean) {
      closed = value;
    },
  };
}
