import { z } from "zod";

/** Orca's bounded panel-schema dialect (Orca 75b02825, src/shared/plugins/plugin-data-schema.ts),
 *  mirrored so the worker can check its own view models before the host does and tests can
 *  prove the manifest compiles. Keep the rules identical; the host remains authoritative. */
export type DataSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  nullable?: boolean;
  properties?: Record<string, DataSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: DataSchema;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  minimum?: number;
  maximum?: number;
};
const definition = z
  .object({
    type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).max(64).optional(),
    additionalProperties: z.literal(false).optional(),
    items: z.unknown().optional(),
    maxItems: z.number().int().min(0).max(2000).optional(),
    minLength: z.number().int().min(0).max(49152).optional(),
    maxLength: z.number().int().min(0).max(49152).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    enum: z.array(z.string().max(512)).min(1).max(64).optional(),
    nullable: z.boolean().optional(),
  })
  .strict();
const KEYWORDS: Record<DataSchema["type"], string[]> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "maxItems"],
  string: ["minLength", "maxLength", "enum"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
  boolean: [],
  null: [],
};
export function compileDataSchema(input: unknown, depth = 0): z.ZodType {
  if (depth > 8) throw new Error("schema nesting exceeds eight levels");
  if (depth === 0 && JSON.stringify(input).length > 16384) throw new Error("schema exceeds 16 KiB");
  const d = definition.parse(input);
  const allowed = new Set(["type", "nullable", ...KEYWORDS[d.type]]);
  if (Object.keys(d).some((key) => !allowed.has(key)))
    throw new Error("keyword does not apply to schema type");
  let result: z.ZodType;
  switch (d.type) {
    case "object": {
      if (d.additionalProperties !== false) throw new Error("objects must reject additional properties");
      const properties = Object.entries(d.properties ?? {});
      if (properties.length > 64) throw new Error("too many object properties");
      const required = new Set(d.required ?? []);
      if ([...required].some((key) => !Object.hasOwn(d.properties ?? {}, key)))
        throw new Error("unknown required property");
      const fields: Record<string, z.ZodType> = {};
      for (const [key, value] of properties) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("reserved property");
        const field = compileDataSchema(value, depth + 1);
        fields[key] = required.has(key) ? field : field.optional();
      }
      result = z.object(fields).strict();
      break;
    }
    case "array":
      result = z.array(compileDataSchema(d.items, depth + 1)).max(d.maxItems ?? 2000);
      break;
    case "string": {
      let value = z.string().min(d.minLength ?? 0).max(d.maxLength ?? 49152);
      if (d.enum) value = value.refine((text) => d.enum!.includes(text)) as unknown as z.ZodString;
      result = value;
      break;
    }
    case "number":
    case "integer": {
      let value = d.type === "integer" ? z.number().int() : z.number().finite();
      if (d.minimum !== undefined) value = value.min(d.minimum);
      if (d.maximum !== undefined) value = value.max(d.maximum);
      result = value;
      break;
    }
    case "boolean":
      result = z.boolean();
      break;
    case "null":
      result = z.null();
      break;
  }
  return d.nullable ? result.nullable() : result;
}
/** Orca's 48 KiB UTF-8 JSON limit for panel args/results. */
export const PANEL_PAYLOAD_LIMIT = 48 * 1024;
export const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// ---- small constructors so contracts stay readable and within the 16 KiB definition limit
export const str = (maxLength: number, extra: Partial<DataSchema> = {}): DataSchema => ({ type: "string", maxLength, ...extra });
export const int = (minimum?: number, maximum?: number): DataSchema => ({
  type: "integer",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
export const bool = (): DataSchema => ({ type: "boolean" });
export const nullable = (schema: DataSchema): DataSchema => ({ ...schema, nullable: true });
export const arr = (items: DataSchema, maxItems: number): DataSchema => ({ type: "array", items, maxItems });
export function obj(properties: Record<string, DataSchema>, optional: string[] = []): DataSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
