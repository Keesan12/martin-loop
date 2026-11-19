import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { writeProductionSwarmHostedFixtures } from "../tests/helpers/swarm-hosted-fixture-builder.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const result = await writeProductionSwarmHostedFixtures({
  fixturePath: join(repositoryRoot, "packages", "contracts", "tests", "fixtures", "swarm-hosted-v1-cases.json"),
  checksumPath: join(repositoryRoot, "packages", "contracts", "tests", "fixtures", "swarm-hosted-v1-cases.sha256"),
  handoffPath: join(repositoryRoot, "docs", "reference", "SWARM-HOSTED-V1-HANDOFF.md"),
});

process.stdout.write(`${JSON.stringify({
  status: "generated",
  checksum: result.checksum,
  bytes: result.bytes,
})}\n`);
