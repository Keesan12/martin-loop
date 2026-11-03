type CleanRecoveryTestHook = (paths: {
  candidatePath: string;
  originalPath: string;
  parentPath: string;
}) => Promise<void>;

let hook: CleanRecoveryTestHook | undefined;

export function setCleanRecoveryTestHookForTesting(nextHook: CleanRecoveryTestHook | undefined): void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error("clean recovery test hooks are available only under NODE_ENV=test");
  }
  hook = nextHook;
}

export async function runCleanRecoveryTestHook(paths: {
  candidatePath: string;
  originalPath: string;
  parentPath: string;
}): Promise<void> {
  await hook?.(paths);
}
