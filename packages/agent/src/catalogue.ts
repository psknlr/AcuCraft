import { ActionSchema } from "@acucraft/core";
import { z, type ZodTypeAny } from "zod";

/**
 * A compact text catalogue of the action interface, generated from the zod schemas (so it never drifts from what the
 * engine accepts). Given to language-model agents in their system prompt.
 */

function describe(t: ZodTypeAny, depth = 0): string {
  if (t instanceof z.ZodOptional) return describe(t.unwrap(), depth);
  if (t instanceof z.ZodDefault) return describe(t._def.innerType, depth);
  if (t instanceof z.ZodNullable) return `${describe(t.unwrap(), depth)} | null`;
  if (t instanceof z.ZodLazy) return describe(t.schema, depth);
  if (t instanceof z.ZodEffects) return describe(t.innerType(), depth);
  if (t instanceof z.ZodLiteral) return JSON.stringify(t.value);
  if (t instanceof z.ZodEnum) return (t.options as string[]).map((o) => JSON.stringify(o)).join("|");
  if (t instanceof z.ZodString) return "string";
  if (t instanceof z.ZodNumber) return "number";
  if (t instanceof z.ZodBoolean) return "boolean";
  if (t instanceof z.ZodArray) {
    const el = describe(t.element, depth);
    return /[|]/.test(el) && !el.startsWith("{ ") ? `(${el})[]` : /\} \| \{/.test(el) ? `(${el})[]` : `${el}[]`;
  }
  if (t instanceof z.ZodRecord) return "object";
  if (t instanceof z.ZodUnion) return (t.options as ZodTypeAny[]).map((o) => describe(o, depth)).join(" | ");
  if (t instanceof z.ZodObject) {
    if (depth > 2) return "object";
    const shape = t.shape as Record<string, ZodTypeAny>;
    return `{ ${Object.entries(shape)
      .map(([k, v]) => `${k}${v.isOptional() ? "?" : ""}: ${describe(v, depth + 1)}`)
      .join(", ")} }`;
  }
  return "any";
}

const isDefaulted = (t: ZodTypeAny) => t instanceof z.ZodDefault;

export function actionCatalogue(): string {
  const lines: string[] = [];
  for (const option of ActionSchema.options) {
    const shape = option.shape as Record<string, ZodTypeAny>;
    const fields = Object.entries(shape)
      .filter(([k]) => k !== "type")
      .map(([k, v]) => `${k}${v.isOptional() || isDefaulted(v) ? "?" : ""}: ${describe(v)}`);
    lines.push(`- ${(shape.type as z.ZodLiteral<string>).value}${fields.length ? ` { ${fields.join(", ")} }` : ""}`);
  }
  return lines.join("\n");
}
