import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const screenshotsDir = resolve(currentDir, "../docs/demo/screenshots");
const manifestPath = resolve(screenshotsDir, "manifest.json");

const manifest = {
  generatedAt: new Date().toISOString(),
  assets: [
    {
      id: "executive-overview",
      label: "Hosted executive overview",
      sourceType: "Seeded Demo Data"
    },
    {
      id: "hosted-economics",
      label: "Hosted economics view",
      sourceType: "Seeded Demo Data"
    },
    {
      id: "hosted-governance",
      label: "Hosted governance view",
      sourceType: "Seeded Demo Data"
    },
    {
      id: "operator-current-run",
      label: "Local operator current run",
      sourceType: "Seeded Demo Data"
    },
    {
      id: "ralph-vs-martin-board",
      label: "Ralph vs Martin comparison board",
      sourceType: "Simulated Scenario"
    },
    {
      id: "governance-setup",
      label: "Guardrails setup panel",
      sourceType: "Illustrative"
    }
  ]
};

await mkdir(screenshotsDir, { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

console.log(`Wrote demo asset manifest to ${manifestPath}`);
