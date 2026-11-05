import { describe, it, expect } from "vitest";
import { z } from "zod";
import { agentSchema } from "./content.js";

describe("agentSchema", () => {
  it("drops $schema (the claude CLI rejects draft 2020-12) and keeps strict objects", () => {
    const schema = agentSchema(z.object({ angles: z.array(z.object({ title: z.string() })) })) as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["angles"]);
  });
});
