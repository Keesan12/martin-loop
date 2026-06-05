import { describe, expect, it } from "vitest";

import { resolveCliEnvironment } from "../src/run-store.js";

describe("resolveCliEnvironment", () => {
  it("preserves the openai engine selection", () => {
    const environment = resolveCliEnvironment({ engine: "openai" });

    expect(environment.engine).toBe("openai");
  });

  it("exposes MARTIN_LIVE=false as proof mode for public surfaces", () => {
    const environment = resolveCliEnvironment({ env: { ...process.env, MARTIN_LIVE: "false" } });

    expect(environment.liveMode).toBe("proof");
  });

  it("honors explicit proof mode without requiring environment mutation", () => {
    const environment = resolveCliEnvironment({ liveMode: "proof" });

    expect(environment.liveMode).toBe("proof");
  });
});
