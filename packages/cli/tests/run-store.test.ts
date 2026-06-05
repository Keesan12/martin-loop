import { describe, expect, it } from "vitest";

import { resolveCliEnvironment } from "../src/run-store.js";

describe("resolveCliEnvironment", () => {
  it("preserves the openai engine selection", () => {
    const environment = resolveCliEnvironment({ engine: "openai" });

    expect(environment.engine).toBe("openai");
  });
});
