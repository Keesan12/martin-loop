/**
 * Martin Loop Local Dashboard Server
 *
 * Serves the static dashboard files and provides /api/runs which reads
 * real loop records from ~/.martin/runs/*.jsonl.
 *
 * Usage:
 *   node apps/local-dashboard/server.js
 *   # Then open http://localhost:6789
 *
 * Returns an explicit "No runs yet" payload when no persisted run artifacts exist.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLatestRunDashboardData } from "./data/live-run-data.js";

const PORT = 6789;
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json"
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/runs") {
    const dashboardData = await loadLatestRunDashboardData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dashboardData));
    return;
  }

  // Static file serving
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = join(__dirname, filePath);

  const ext = extname(filePath);
  const mime = MIME[ext] ?? "text/plain";

  try {
    const contents = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(contents);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`Martin Loop Dashboard → http://localhost:${PORT}`);
  console.log(`API → http://localhost:${PORT}/api/runs`);
  console.log(`Run data → ${join(homedir(), ".martin", "runs")}`);
});
