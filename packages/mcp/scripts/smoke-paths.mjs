import { realpath } from "node:fs/promises";

export async function resolveSmokeWorkspaceRoot(tempRoot) {
  return realpath(tempRoot);
}
