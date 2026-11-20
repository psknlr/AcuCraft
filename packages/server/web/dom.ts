/**
 * A small DOM kit for the workspace. Elements are made with text nodes only — never HTML parsed from a string — so
 * nothing in a record (a patient's words, a note, a model's text) can run as markup. Inline handlers and
 * `javascript:` links are refused; the page's CSP allows no inline script or style either.
 */

export type Child = Node | string | number | boolean | null | undefined | Child[];
export type Attrs = Record<string, unknown> & {
  class?: string | (string | false | null | undefined)[];
  on?: Partial<Record<string, (event: Event) => void>>;
};

const BOOLEAN = new Set(["disabled", "checked", "selected", "multiple", "required", "hidden", "open", "readonly", "autofocus"]);

function apply(el: Element, attrs: Attrs | null | undefined): void {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.setAttribute("class", Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value));
    else if (key === "on") for (const [type, fn] of Object.entries(value as Record<string, (e: Event) => void>)) el.addEventListener(type, fn);
    else if (/^on/i.test(key)) continue;
    else if (key === "value" && "value" in el) (el as HTMLInputElement).value = String(value);
    else if (key === "checked" && el instanceof HTMLInputElement) el.checked = Boolean(value);
    else if (BOOLEAN.has(key)) el.toggleAttribute(key, Boolean(value));
    else if ((key === "href" || key === "src") && /^\s*(javascript|data|vbscript):/i.test(String(value))) continue;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** An HTML element with attributes and children (strings become text). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number | undefined> | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) if (value !== undefined) el.setAttribute(key, String(value));
  append(el, children);
  return el;
}

/** Replace an element's children. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** A short-lived notice in the corner. */
export function toast(text: string, tone: "ok" | "bad" | "info" = "info"): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const item = h("div", { class: ["toast", tone] }, text);
  host.appendChild(item);
  setTimeout(() => item.classList.add("leaving"), 4200);
  setTimeout(() => item.remove(), 4800);
}

/** Copy text to the clipboard, saying so. */
export async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, "ok");
  } catch {
    toast(`Could not copy ${what}: select it and copy it by hand`, "bad");
  }
}
