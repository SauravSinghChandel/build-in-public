import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema to hand to the agent CLIs.
 * - claude rejects a `$schema` draft-2020-12 declaration, so it is dropped.
 * - codex uses OpenAI strict structured outputs: every object property must be listed in
 *   `required`. Optional properties become required-but-nullable; parseAgentOutput() strips
 *   the nulls again before zod validation.
 */
export function agentSchema(schema: z.ZodType): object {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as JsonSchema;
  return strictify(rest) as object;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) out[key] = strictify(value);
  const props = out.properties as JsonSchema | undefined;
  if (out.type === "object" && props && typeof props === "object") {
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Remove null-valued object keys (the nullable stand-ins for optional fields), then validate. */
export function parseAgentOutput<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  return schema.parse(stripNulls(raw));
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== null) out[key] = stripNulls(v);
  }
  return out;
}
