import { describe, expect, it, vi } from "vitest";

import {
  animateBannerShine,
  canAnimate,
  paint,
  padRightVisible,
  renderTable,
  stripAnsi,
  terminalAnsi,
  visibleWidth,
  withSpinner,
  writeHumanOutputWithShine
} from "../src/index.js";

describe("semantic terminal presentation", () => {
  it("uses RGB semantic color when a 24-bit TTY is available", () => {
    const rendered = paint("VERIFIED", "success", {
      color: "always",
      colorDepth: 24,
      isTty: true
    });

    expect(rendered).toContain("\u001b[38;2;94;225;115m");
    expect(stripAnsi(rendered)).toBe("VERIFIED");
  });

  it("does not color output when NO_COLOR is active", () => {
    expect(
      paint("STOPPED", "danger", {
        color: "auto",
        isTty: true,
        noColor: true
      })
    ).toBe("STOPPED");
  });

  it("pads colored content by visible width", () => {
    const colored = paint("READY", "success", {
      color: "always",
      colorDepth: 24,
      isTty: true
    });
    const padded = padRightVisible(colored, 10);

    expect(visibleWidth(padded)).toBe(10);
    expect(stripAnsi(padded)).toBe("READY     ");
  });

  it("renders aligned tables when cells contain ANSI color", () => {
    const rows = [
      { stage: "Scope", status: paint("READY", "success", { color: "always" }) },
      { stage: "Verify", status: paint("BLOCKED", "danger", { color: "always" }) }
    ];
    const rendered = renderTable(
      rows,
      [
        { header: "STAGE", value: (row) => row.stage, minWidth: 8 },
        { header: "STATUS", value: (row) => row.status, minWidth: 8 }
      ],
      80
    );

    const plainLines = stripAnsi(rendered).split("\n");
    expect(new Set(plainLines.map((line) => line.length))).toEqual(new Set([19]));
  });

  it.each([80, 120, 160])(
    "honors a %i-column table width",
    (width) => {
      const rendered = renderTable(
        [
          {
            stage: "Verification",
            status: "NEXT",
            gate: "C:\\Users\\Example\\Projects\\MartinLoop\\scripts\\very-long-verifier-command.ps1",
            purpose: "Run configured completion checks and preserve evidence"
          }
        ],
        [
          { header: "STAGE", value: (row) => row.stage, minWidth: 18, maxWidth: 24 },
          { header: "STATUS", value: (row) => row.status, minWidth: 12, maxWidth: 14 },
          { header: "GATE", value: (row) => row.gate, minWidth: 18, maxWidth: 36 },
          { header: "PURPOSE", value: (row) => row.purpose, minWidth: 24 }
        ],
        width
      );

      const lineWidths = stripAnsi(rendered)
        .split("\n")
        .map((line) => line.length);
      expect(Math.max(...lineWidths)).toBeLessThanOrEqual(width);
      expect(new Set(lineWidths).size).toBe(1);
    }
  );
});

describe("motion policy", () => {
  it.each([
    [{ outputMode: "json", stdoutIsTty: true }, false],
    [{ outputMode: "quiet", stdoutIsTty: true }, false],
    [{ outputMode: "human", stdoutIsTty: true, ci: true }, false],
    [{ outputMode: "human", stdoutIsTty: false }, false],
    [{ outputMode: "human", stdoutIsTty: true, term: "dumb" }, false],
    [{ outputMode: "human", stdoutIsTty: true, noMotion: true }, false],
    [{ outputMode: "human", stdoutIsTty: true, ci: false, term: "xterm-256color" }, true]
  ] as const)("evaluates motion eligibility", (environment, expected) => {
    expect(canAnimate(environment)).toBe(expected);
  });

  it("exposes cursor cleanup sequences for exception-safe writers", () => {
    expect(terminalAnsi.reset).toBe("\u001b[0m");
    expect(terminalAnsi.showCursor).toBe("\u001b[?25h");
    expect(terminalAnsi.eraseLine).toBe("\u001b[2K");
  });

  it("clears the line and restores the cursor after a banner shine", async () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((value) => {
        writes.push(String(value));
        return true;
      });

    try {
      await animateBannerShine("M", {
        outputMode: "human",
        stdoutIsTty: true,
        ci: false,
        term: "xterm-256color"
      });
    } finally {
      write.mockRestore();
    }

    const output = writes.join("");
    expect(output).toContain(terminalAnsi.hideCursor);
    expect(output).toContain(terminalAnsi.eraseLine);
    expect(output).toContain(terminalAnsi.showCursor);
  });

  it("restores the cursor when a spinner task rejects", async () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((value) => {
        writes.push(String(value));
        return true;
      });

    try {
      await expect(
        withSpinner(
          "Checking evidence",
          async () => {
            throw new Error("expected failure");
          },
          {
            outputMode: "human",
            stdoutIsTty: true,
            ci: false,
            term: "xterm-256color"
          }
        )
      ).rejects.toThrow("expected failure");
    } finally {
      write.mockRestore();
    }

    expect(writes.join("")).toContain(terminalAnsi.showCursor);
  });

  it("writes stable output without motion for JSON mode", async () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((value) => {
        writes.push(String(value));
        return true;
      });

    try {
      await writeHumanOutputWithShine("MARTINLOOP\ntruth", {
        outputMode: "json",
        stdoutIsTty: true
      });
    } finally {
      write.mockRestore();
    }

    expect(writes.join("")).toBe("MARTINLOOP\ntruth\n");
  });
});
