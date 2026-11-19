import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runProviderFreeVerificationStep } from "../src/swarm-command-private.js";

describe("provider-free verification step", () => {
  it("executes exactly the approved program and records the same command", async () => {
    const execute = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({ stdout: "v0.0.0\n", stderr: "" }));

    const step = await runProviderFreeVerificationStep("node --version", process.cwd(), execute);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe("node");
    expect(execute.mock.calls[0]?.[1]).toEqual(["--version"]);
    // Never resolved inside the untrusted workspace: a planted node.exe there must not run.
    const workspace = join(tmpdir(), "untrusted-workspace");
    execute.mockClear();
    await runProviderFreeVerificationStep("node --version", workspace, execute);
    expect((execute.mock.calls[0]?.[2] as { cwd: string }).cwd).toBe(dirname(process.execPath));
    expect((execute.mock.calls[0]?.[2] as { cwd: string }).cwd).not.toBe(workspace);
    expect(step).toEqual({
      command: "node --version",
      launched: true,
      completed: true,
      crashed: false,
      exitCode: 0,
      timedOut: false,
    });
  });

  it("reports a failing approved command as a failed step", async () => {
    const step = await runProviderFreeVerificationStep("node --version", process.cwd(), async () => {
      throw new Error("exit 1");
    });
    expect(step).toMatchObject({ command: "node --version", launched: true, exitCode: 1 });
  });

  it.each([
    "node --version; echo hi",
    "node -e process.exit(0)",
    "node  --version",
    "bun --version",
    "echo hi",
    "",
  ])("fails closed without launching anything for %j", async (command) => {
    const execute = vi.fn();

    const step = await runProviderFreeVerificationStep(command, process.cwd(), execute);

    expect(execute).not.toHaveBeenCalled();
    expect(step).toEqual({
      command,
      launched: false,
      completed: false,
      crashed: false,
      exitCode: 1,
      timedOut: false,
    });
  });
});
