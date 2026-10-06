const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

const mode = process.argv[2];
const statePath = process.argv[3];

if (!statePath) {
  process.exit(2);
}

if (mode === "grandchild") {
  appendFileSync(statePath, `${JSON.stringify({ kind: "grandchild", pid: process.pid })}\n`);
  setInterval(() => undefined, 1_000);
} else {
  const grandchild = spawn(process.execPath, [__filename, "grandchild", statePath], {
    stdio: "ignore",
    windowsHide: true
  });
  writeFileSync(
    statePath,
    `${JSON.stringify({ kind: "child", pid: process.pid, grandchildPid: grandchild.pid })}\n`
  );
  if (mode === "natural-parent") {
    setTimeout(() => process.exit(0), 50);
  } else {
    setInterval(() => undefined, 1_000);
  }
}
