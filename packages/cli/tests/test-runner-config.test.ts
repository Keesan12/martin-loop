import { describe, expect, it } from "vitest";

import config from "../vitest.config.js";

describe("CLI test-runner resource contract", () => {
  it("serializes subprocess-heavy test files", () => {
    expect(config).toMatchObject({
      test: {
        fileParallelism: false,
      },
    });
  });
});
