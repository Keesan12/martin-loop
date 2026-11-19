import { describe, expect, it, vi } from "vitest";

import {
  renameAtomically,
  retryTransientWindowsFileSystemOperation
} from "../src/persistence/atomic-replace.js";

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("atomic Windows replacement", () => {
  it("does not observe the retry clock on the successful fast path", async () => {
    const now = vi.fn(() => 0);
    await expect(retryTransientWindowsFileSystemOperation(
      async () => "published",
      { platform: "win32", now }
    )).resolves.toBe("published");
    expect(now).not.toHaveBeenCalled();
  });

  it("recovers exclusive lock opens from transient filter denials without swallowing contention", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(filesystemError("EPERM"))
      .mockResolvedValueOnce("handle");
    let clock = 0;

    await expect(retryTransientWindowsFileSystemOperation(operation, {
      platform: "win32",
      deadlineMs: 100,
      sleep: async (delayMs) => { clock += delayMs; },
      now: () => clock
    })).resolves.toBe("handle");
    expect(operation).toHaveBeenCalledTimes(2);

    const contention = vi.fn().mockRejectedValue(filesystemError("EEXIST"));
    await expect(retryTransientWindowsFileSystemOperation(contention, {
      platform: "win32",
      sleep: vi.fn(),
      now: () => 0
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(contention).toHaveBeenCalledTimes(1);
  });

  it("recovers from bounded transient filter-driver denials without weakening atomicity", async () => {
    const renameFile = vi.fn()
      .mockRejectedValueOnce(filesystemError("EPERM"))
      .mockRejectedValueOnce(filesystemError("EACCES"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    let clock = 0;

    await renameAtomically("pending", "canonical", {
      platform: "win32",
      renameFile,
      sleep: async (delayMs) => {
        clock += delayMs;
        await sleep(delayMs);
      },
      now: () => clock,
      deadlineMs: 100
    });

    expect(renameFile).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it.each(["ENOENT", "EINVAL"])("fails closed immediately for %s", async (code) => {
    const renameFile = vi.fn().mockRejectedValue(filesystemError(code));
    await expect(renameAtomically("pending", "canonical", {
      platform: "win32",
      renameFile,
      sleep: vi.fn(),
      now: () => 0
    })).rejects.toMatchObject({ code });
    expect(renameFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry Windows-specific failures on another platform", async () => {
    const renameFile = vi.fn().mockRejectedValue(filesystemError("EPERM"));
    await expect(renameAtomically("pending", "canonical", {
      platform: "linux",
      renameFile,
      sleep: vi.fn(),
      now: () => 0
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(renameFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the bounded recovery deadline is exhausted", async () => {
    const failure = filesystemError("EBUSY");
    const renameFile = vi.fn().mockRejectedValue(failure);
    let clock = 0;
    await expect(renameAtomically("pending", "canonical", {
      platform: "win32",
      deadlineMs: 15,
      renameFile,
      sleep: async (delayMs) => { clock += delayMs; },
      now: () => clock
    })).rejects.toBe(failure);
    expect(renameFile).toHaveBeenCalledTimes(3);
  });
});
