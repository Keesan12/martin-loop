import { probeCodexLaunch } from "./codex-host.js";

const encoded = process.argv[2];
if (!encoded) throw new Error("Missing Codex readiness probe payload.");

const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Parameters<typeof probeCodexLaunch>[0];
const result = probeCodexLaunch(input);
process.stdout.write(`${JSON.stringify(result)}\n`);
