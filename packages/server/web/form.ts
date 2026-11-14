import { h, replace } from "./dom.js";
import { alternativeFor, alternativeLabel, alternatives, isLong, numberOf, prune, title, type JsonSchema } from "./schema.js";
import type { Option } from "./text.js";

/**
 * A form for any tool, made from its JSON Schema: text, numbers, choices, yes/no, nested parts, lists that grow,
 * unions (choose the kind of target, then fill it in) and key/value records. Each field may offer the values the
 * view and the library suggest. What the form reads is what the tool is sent — the engine checks it.
 */

export interface FieldContext {
  tool: string;
  /** Values a field may take (`path`: dotted, with `[]` for list items). */
  suggest(path: string): Option[];
}

export interface Editor {
  el: HTMLElement;
  read(): unknown;
  set(value: unknown): void;
}

let lists = 0;

/** A datalist of suggestions for an input (none: no list). */
function datalist(options: Option[]): { id: string | undefined; el: HTMLDataListElement | null } {
  if (!options.length) return { id: undefined, el: null };
  const id = `dl-${++lists}`;
  return { id, el: h("datalist", { id }, options.slice(0, 600).map((o) => h("option", { value: o.value }, o.label ?? ""))) };
}

function scalar(schema: JsonSchema, path: string, required: boolean, ctx: FieldContext): Editor {
  if (schema.const !== undefined) {
    const el = h("span", { class: "const" }, String(schema.const));
    return { el, read: () => schema.const, set: () => {} };
  }
  if (schema.enum) {
    // a choice starts blank, never on a value nobody chose (a needle's response must not read "deqi" by default)
    const select = h(
      "select",
      { "aria-label": title(path) },
      h("option", { value: "" }, schema.default !== undefined ? `— (default: ${String(schema.default)})` : required ? "— choose —" : "—"),
      schema.enum.map((v) => h("option", { value: String(v) }, String(v))),
    );
    return { el: select, read: () => (select.value === "" ? undefined : schema.enum!.find((v) => String(v) === select.value)), set: (v) => (select.value = v === undefined || v === null ? "" : String(v)) };
  }
  if (schema.type === "boolean") {
    const select = h("select", { "aria-label": title(path) }, h("option", { value: "" }, schema.default !== undefined ? `— (default: ${schema.default ? "yes" : "no"})` : "—"), h("option", { value: "true" }, "yes"), h("option", { value: "false" }, "no"));
    return { el: select, read: () => (select.value === "" ? undefined : select.value === "true"), set: (v) => (select.value = typeof v === "boolean" ? String(v) : "") };
  }
  if (schema.type === "number" || schema.type === "integer") {
    const input = h("input", {
      type: "number",
      step: schema.type === "integer" ? "1" : "any",
      min: schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum : undefined),
      max: schema.maximum,
      placeholder: schema.default !== undefined ? `default ${String(schema.default)}` : "",
      "aria-label": title(path),
    });
    return { el: input, read: () => numberOf(input.value), set: (v) => (input.value = typeof v === "number" ? String(v) : "") };
  }
  const list = datalist(ctx.suggest(path));
  if (isLong(schema)) {
    const area = h("textarea", { rows: 3, maxlength: schema.maxLength, "aria-label": title(path), placeholder: schema.default ? `default: ${String(schema.default)}` : "" });
    return { el: area, read: () => area.value, set: (v) => (area.value = typeof v === "string" ? v : "") };
  }
  const input = h("input", { type: "text", list: list.id, maxlength: schema.maxLength, autocomplete: "off", spellcheck: "false", "aria-label": title(path), placeholder: list.el ? "type, or pick a suggestion" : "" });
  const wrap = h("span", { class: "scalar" }, input, list.el);
  return { el: wrap, read: () => input.value, set: (v) => (input.value = v === undefined || v === null ? "" : String(v)) };
}

function objectEditor(schema: JsonSchema, path: string, ctx: FieldContext, legend: string | null): Editor {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const fields = props.map(([key, sub]) => {
    const sp = path ? `${path}.${key}` : key;
    return { key, editor: editorFor(sub, sp, required.has(key), ctx), sub, required: required.has(key) };
  });
  const rows = fields.map(({ key, editor, sub, required: req }) =>
    h(
      "div",
      { class: ["field", sub.properties || sub.items || sub.anyOf ? "wide" : ""] },
      h("label", { class: "name" }, title(key), req ? h("span", { class: "req", title: "required" }, " *") : null),
      editor.el,
      sub.description ? h("small", { class: "hint" }, sub.description) : null,
    ),
  );
  const el = legend ? h("fieldset", { class: "obj" }, h("legend", null, legend), rows) : h("div", { class: "obj" }, rows);
  return {
    el,
    read: () => Object.fromEntries(fields.map((f) => [f.key, f.editor.read()])),
    set: (v) => {
      const value = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      for (const f of fields) f.editor.set(value[f.key]);
    },
  };
}

function arrayEditor(schema: JsonSchema, path: string, ctx: FieldContext): Editor {
  const items: Editor[] = [];
  const box = h("div", { class: "items" });
  const itemPath = `${path}[]`;
  const add = (value?: unknown) => {
    const editor = editorFor(schema.items ?? { type: "string" }, itemPath, true, ctx);
    if (value !== undefined) editor.set(value);
    const row = h(
      "div",
      { class: "item" },
      editor.el,
      h(
        "button",
        {
          type: "button",
          class: "icon",
          title: "remove",
          "aria-label": "remove",
          on: {
            click: () => {
              items.splice(items.indexOf(editor), 1);
              row.remove();
            },
          },
        },
        "×",
      ),
    );
    items.push(editor);
    box.appendChild(row);
  };
  const el = h("div", { class: "array" }, box, h("button", { type: "button", class: "small", on: { click: () => add() } }, "+ add"));
  return {
    el,
    read: () => items.map((e) => e.read()),
    set: (v) => {
      items.splice(0);
      box.replaceChildren();
      if (Array.isArray(v)) for (const x of v) add(x);
    },
  };
}

function unionEditor(schema: JsonSchema, path: string, required: boolean, ctx: FieldContext): Editor {
  const alts = alternatives(schema);
  const select = h("select", { class: "alt", "aria-label": `${title(path)}: which kind` }, alts.map((a, i) => h("option", { value: String(i) }, alternativeLabel(a))));
  const holder = h("div", { class: "alt-body" });
  let current: Editor = editorFor(alts[0]!, path, required, ctx);
  const show = (i: number, value?: unknown) => {
    current = editorFor(alts[i]!, path, required, ctx);
    if (value !== undefined) current.set(value);
    replace(holder, current.el);
  };
  select.addEventListener("change", () => show(Number(select.value)));
  show(0);
  return {
    el: h("div", { class: "union" }, select, holder),
    read: () => current.read(),
    set: (v) => {
      const i = alternativeFor(schema, v);
      select.value = String(i);
      show(i, v);
    },
  };
}

function recordEditor(schema: JsonSchema, path: string, ctx: FieldContext): Editor {
  const rows: { key: HTMLInputElement; editor: Editor; row: HTMLElement }[] = [];
  const box = h("div", { class: "items" });
  const value = typeof schema.additionalProperties === "object" ? schema.additionalProperties : { type: "string" };
  const add = (k = "", v?: unknown) => {
    const key = h("input", { type: "text", placeholder: "name", value: k, "aria-label": "name" });
    const editor = editorFor(value, `${path}.*`, true, ctx);
    if (v !== undefined) editor.set(v);
    const row = h("div", { class: "item kv" }, key, editor.el, h("button", { type: "button", class: "icon", title: "remove", on: { click: () => (rows.splice(rows.findIndex((r) => r.row === row), 1), row.remove()) } }, "×"));
    rows.push({ key, editor, row });
    box.appendChild(row);
  };
  return {
    el: h("div", { class: "array" }, box, h("button", { type: "button", class: "small", on: { click: () => add() } }, "+ add")),
    read: () => Object.fromEntries(rows.filter((r) => r.key.value.trim()).map((r) => [r.key.value.trim(), r.editor.read()])),
    set: (v) => {
      rows.splice(0);
      box.replaceChildren();
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(k, x);
    },
  };
}

/** The editor of one value of a schema. */
export function editorFor(schema: JsonSchema, path: string, required: boolean, ctx: FieldContext): Editor {
  if (schema.anyOf) return unionEditor(schema, path, required, ctx);
  if (schema.type === "array") return arrayEditor(schema, path, ctx);
  if (schema.type === "object" && schema.properties) return objectEditor(schema, path, ctx, path ? title(path.split(".").pop()!) : null);
  if (schema.type === "object") return recordEditor(schema, path, ctx);
  return scalar(schema, path, required, ctx);
}

/** The form of a tool: its fields, read as the input to send (empty fields left out). */
export function formFor(schema: JsonSchema, ctx: FieldContext): { el: HTMLElement; read(): Record<string, unknown>; set(value: Record<string, unknown>): void } {
  const editor = objectEditor(schema, "", ctx, null);
  return {
    el: editor.el,
    read: () => (prune(editor.read()) as Record<string, unknown> | undefined) ?? {},
    set: (v) => editor.set(v),
  };
}
