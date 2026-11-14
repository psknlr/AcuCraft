import { h, replace } from "./dom.js";

/**
 * The command palette (Ctrl+K or ⌘K, or "/" for asking): every action of the practitioner and the record's own
 * commands, found by typing a few letters — the way a game's quick menu reaches anything without leaving the view.
 * Choosing a tool opens its form in "Act as the practitioner".
 */

export interface Command {
  id: string;
  title: string;
  group: string;
  hint?: string;
  run(): void;
}

/** How well `query` matches `text`: its letters in order, closer and earlier counting more (0: no match). */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at * 4 - (t.length - q.length) * 0.1;
  let i = 0, last = -1, gaps = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, last + 1);
    if (j < 0) return 0;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    i++;
  }
  return Math.max(1, 500 - gaps * 6 - (t.length - q.length) * 0.1);
}

export function palette(commands: () => Command[]): { open(query?: string): void; close(): void } {
  const input = h("input", { type: "text", class: "palette-input", placeholder: "Type an action or a command…", "aria-label": "search actions", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { class: "palette-list", role: "listbox" });
  const box = h("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "actions" }, input, list, h("p", { class: "palette-foot" }, "↑↓ to choose · Enter to open · Esc to close"));
  const veil = h("div", { class: "palette-veil hidden" }, box);
  document.body.appendChild(veil);
  let shown: Command[] = [];
  let active = 0;

  const draw = () => {
    const q = input.value;
    shown = commands()
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, `${c.group} ${c.title}`) * 0.8, c.hint ? score(q, c.hint) * 0.5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    active = Math.min(active, Math.max(0, shown.length - 1));
    replace(
      list,
      shown.length
        ? shown.map((c, i) =>
            h(
              "li",
              { class: ["palette-item", i === active ? "active" : ""], role: "option", "aria-selected": i === active ? "true" : "false", on: { mousedown: (e: Event) => (e.preventDefault(), choose(i)), mousemove: () => i !== active && ((active = i), draw()) } },
              h("span", { class: "palette-group" }, c.group),
              h("span", { class: "palette-title" }, c.title),
              c.hint ? h("span", { class: "palette-hint" }, c.hint) : null,
            ),
          )
        : h("li", { class: "palette-empty" }, "Nothing matches."),
    );
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i: number) => {
    const c = shown[i];
    if (!c) return;
    close();
    c.run();
  };
  function open(query = ""): void {
    input.value = query;
    active = 0;
    veil.classList.remove("hidden");
    draw();
    input.focus();
  }
  function close(): void {
    veil.classList.add("hidden");
  }
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (active = Math.min(shown.length - 1, active + 1)), draw(), e.preventDefault();
    else if (e.key === "ArrowUp") (active = Math.max(0, active - 1)), draw(), e.preventDefault();
    else if (e.key === "Enter") choose(active), e.preventDefault();
    else if (e.key === "Escape") close();
  });
  veil.addEventListener("mousedown", (e) => {
    if (e.target === veil) close();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      veil.classList.contains("hidden") ? open() : close();
    } else if (e.key === "Escape" && !veil.classList.contains("hidden")) close();
  });
  return { open, close };
}
