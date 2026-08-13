import { link, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TerminationEnvelopeV1 } from "@martin/contracts";

/**
 * Atomically persist the termination envelope for a governed run.
 *
 * Crash-safe write sequence (mirrors exit-signal.ts atomic publication):
 *   1. Write complete JSON to a unique tmp file (wx, 0o600) in runDirectory
 *   2. Sync and close the tmp file
 *   3. Hard-link tmp → termination.json (EEXIST → slot already occupied)
 *   4. On EEXIST, read and return the existing envelope
 *   5. Unlink the tmp file in finally (best-effort)
 *
 * First terminal exit path wins — competing callers that hit EEXIST get back
 * the envelope that won the race.  This is the A1 idempotency guarantee.
 */
export async function persistTerminationEnvelope(
  runDirectory: string,
  envelope: TerminationEnvelopeV1
): Promise<TerminationEnvelopeV1> {
  const finalPath = join(runDirectory, "termination.json");
  const tmpPath = join(runDirectory, `.termination-tmp-${randomUUID()}.json`);
  const json = `${JSON.stringify(envelope, null, 2)}\n`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, "wx", 0o600);
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(tmpPath, finalPath);
      return envelope;
    } catch (linkErr) {
      if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") throw linkErr;
      // Another path won the race — read what's on disk and return it
      const existing = await readFile(finalPath, "utf8");
      return JSON.parse(existing) as TerminationEnvelopeV1;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
  }
}
