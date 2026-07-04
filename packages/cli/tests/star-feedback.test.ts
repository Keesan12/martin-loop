import { describe, it, expect } from "vitest";
import { shouldShowStarPrompt } from "../src/star-prompt.js";
import { shouldShowRating, shouldShowFeatureRequest, shouldShowDesignPartner } from "../src/feedback.js";

describe("star prompt trigger logic", () => {
  it("fires on run 2", () => {
    expect(shouldShowStarPrompt(2, 0)).toBe(true);
  });

  it("does not fire on run 1", () => {
    expect(shouldShowStarPrompt(1, 0)).toBe(false);
  });

  it("does not fire on run 3 if last shown at 2", () => {
    expect(shouldShowStarPrompt(3, 2)).toBe(false);
  });

  it("fires again at run 27 if last shown at run 2", () => {
    expect(shouldShowStarPrompt(27, 2)).toBe(true);
  });
});

describe("rating trigger logic", () => {
  it("does not fire before run 10", () => {
    expect(shouldShowRating(9, 0)).toBe(false);
  });

  it("fires at run 10", () => {
    expect(shouldShowRating(10, 0)).toBe(true);
  });

  it("fires at run 20 if last was run 10", () => {
    expect(shouldShowRating(20, 10)).toBe(true);
  });

  it("does not fire at run 15 if last was run 10", () => {
    expect(shouldShowRating(15, 10)).toBe(false);
  });
});

describe("feature request trigger logic", () => {
  it("does not fire before run 20", () => {
    expect(shouldShowFeatureRequest(19, 0)).toBe(false);
  });

  it("fires at run 20", () => {
    expect(shouldShowFeatureRequest(20, 0)).toBe(true);
  });
});

describe("design partner trigger logic", () => {
  it("does not fire if converted", () => {
    expect(shouldShowDesignPartner(50, 0, true)).toBe(false);
  });

  it("fires at run 30 if never asked", () => {
    expect(shouldShowDesignPartner(30, 0, false)).toBe(true);
  });

  it("does not fire before run 30", () => {
    expect(shouldShowDesignPartner(29, 0, false)).toBe(false);
  });
});
