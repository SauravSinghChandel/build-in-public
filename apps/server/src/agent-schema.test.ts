import { describe, it, expect } from "vitest";
import { z } from "zod";
import { agentSchema, parseAgentOutput } from "./agents/schema.js";

const steps = z.object({
  steps: z.array(z.object({ action: z.enum(["click", "wait"]), selector: z.string().optional(), ms: z.number().optional() })),
});

describe("agentSchema", () => {
  it("drops $schema (the claude CLI rejects draft 2020-12)", () => {
    const schema = agentSchema(z.object({ a: z.string() })) as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("lists every property as required for codex strict mode, making optional ones nullable", () => {
    const schema = agentSchema(steps) as any;
    const item = schema.properties.steps.items;
    expect(item.required).toEqual(["action", "selector", "ms"]);
    expect(item.properties.selector.anyOf).toContainEqual({ type: "null" });
    expect(item.properties.action.anyOf).toBeUndefined();
  });

  it("parseAgentOutput strips the nulls before validating", () => {
    const out = parseAgentOutput(steps, { steps: [{ action: "wait", selector: null, ms: 1000 }, { action: "click", selector: "#a", ms: null }] });
    expect(out.steps).toEqual([{ action: "wait", ms: 1000 }, { action: "click", selector: "#a" }]);
  });
});
