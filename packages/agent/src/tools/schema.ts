import { z, type ZodTypeAny } from "zod";

/**
 * JSON Schema for a model's tool input, generated from the zod schemas the engine validates with — so what a tool
 * declares can never drift from what the engine accepts. It covers the zod constructs the action interface uses
 * (objects, unions, enums, literals, strings, numbers, booleans, arrays, records, optional and defaulted fields) and
 * throws on anything else: a new construct in an action is a decision to make here, not a silent `{}`.
 *
 * The schemas are hints for the model (bounds, enums, what is required); the engine's own zod parse stays the check.
 */

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: (string | number | boolean)[];
  const?: string | number | boolean;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  default?: unknown;
};

/** An object schema as a tool's `input_schema` must be. */
export type ObjectSchema = JsonSchema & { type: "object"; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false };

/** Field descriptions by dotted path (`at.u`, `plan.technique.retentionMinutes`), added where the schema has that field. */
export type FieldNotes = Readonly<Record<string, string>>;

/** Is the field one the caller may leave out (optional, or filled by a default)? */
const omissible = (t: ZodTypeAny): boolean => t instanceof z.ZodOptional || t instanceof z.ZodDefault || t.isOptional();

/** The JSON Schema of a zod type; `notes` describe fields below `path`. */
export function jsonSchemaOf(t: ZodTypeAny, notes: FieldNotes = {}, path = ""): JsonSchema {
  const described = (schema: JsonSchema): JsonSchema => (notes[path] ? { ...schema, description: notes[path]! } : schema);
  if (t instanceof z.ZodOptional) return jsonSchemaOf(t.unwrap(), notes, path);
  if (t instanceof z.ZodDefault) {
    const inner = jsonSchemaOf(t._def.innerType as ZodTypeAny, notes, path);
    const value = t._def.defaultValue() as unknown;
    // a default worth stating: scalars only (an empty list or object says nothing)
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? { ...inner, default: value } : inner;
  }
  if (t instanceof z.ZodNullable) {
    const inner = jsonSchemaOf(t.unwrap(), notes, path);
    return described({ anyOf: [inner, { type: "null" }] });
  }
  if (t instanceof z.ZodEffects) return jsonSchemaOf(t.innerType(), notes, path);
  if (t instanceof z.ZodLazy) return jsonSchemaOf(t.schema as ZodTypeAny, notes, path);
  if (t instanceof z.ZodString) {
    const out: JsonSchema = { type: "string" };
    for (const check of t._def.checks) {
      if (check.kind === "max") out.maxLength = check.value;
      if (check.kind === "min" && check.value > 0) out.minLength = check.value;
    }
    return described(out);
  }
  if (t instanceof z.ZodNumber) {
    const out: JsonSchema = { type: t.isInt ? "integer" : "number" };
    for (const check of t._def.checks) {
      if (check.kind === "min") {
        if (check.inclusive) out.minimum = check.value;
        else out.exclusiveMinimum = check.value;
      }
      if (check.kind === "max" && check.inclusive) out.maximum = check.value;
    }
    return described(out);
  }
  if (t instanceof z.ZodBoolean) return described({ type: "boolean" });
  if (t instanceof z.ZodLiteral) return described({ const: t.value as string | number | boolean });
  if (t instanceof z.ZodEnum) return described({ type: "string", enum: [...(t.options as string[])] });
  if (t instanceof z.ZodArray) {
    const out: JsonSchema = { type: "array", items: jsonSchemaOf(t.element as ZodTypeAny, notes, `${path}[]`) };
    if (t._def.maxLength) out.maxItems = t._def.maxLength.value;
    if (t._def.minLength && t._def.minLength.value > 0) out.minItems = t._def.minLength.value;
    return described(out);
  }
  if (t instanceof z.ZodRecord) return described({ type: "object", additionalProperties: jsonSchemaOf(t.valueSchema as ZodTypeAny, notes, `${path}.*`) });
  if (t instanceof z.ZodUnion) {
    const options = (t.options as ZodTypeAny[]).map((o) => jsonSchemaOf(o, notes, path));
    // a union of plain scalar types reads better as one `type` list
    if (options.every((o) => typeof o.type === "string" && Object.keys(o).length === 1)) return described({ type: options.map((o) => o.type as string) });
    return described({ anyOf: options });
  }
  if (t instanceof z.ZodObject) return described(objectSchemaOf(t, notes, path));
  throw new Error(`no JSON Schema for ${t.constructor.name}${path ? ` at ${path}` : ""}`);
}

/** The JSON Schema of a zod object, leaving out `omit` (the discriminator of an action). */
export function objectSchemaOf(t: z.ZodObject<z.ZodRawShape>, notes: FieldNotes = {}, path = "", omit: readonly string[] = []): ObjectSchema {
  const shape = t.shape as Record<string, ZodTypeAny>;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    if (omit.includes(key)) continue;
    properties[key] = jsonSchemaOf(field, notes, path ? `${path}.${key}` : key);
    if (!omissible(field)) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
