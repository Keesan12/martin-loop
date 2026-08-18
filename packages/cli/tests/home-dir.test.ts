import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { resolveMartinHome } from "../src/home-dir.js";

describe("resolveMartinHome", () => {
  it("prefers USERPROFILE on Windows", () => {
    expect(
      resolveMartinHome(
        { HOME: "C:\\posix-home", USERPROFILE: "C:\\Users\\Example" },
        "win32",
      ),
    ).toBe("C:\\Users\\Example");
  });

  it("prefers HOME on POSIX platforms", () => {
    expect(
      resolveMartinHome(
        { HOME: "/home/example", USERPROFILE: "C:\\Users\\Example" },
        "linux",
      ),
    ).toBe("/home/example");
  });

  it("falls back across variables and then to the OS home", () => {
    expect(resolveMartinHome({ HOME: " /fallback " }, "win32")).toBe("/fallback");
    expect(resolveMartinHome({}, "linux")).toBe(homedir());
  });
});
