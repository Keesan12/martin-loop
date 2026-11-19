import { open } from "node:fs/promises";

const [receiptPath, runId] = process.argv.slice(2);
if (!receiptPath || !runId) {
  process.exitCode = 2;
} else {
  try {
    const receipt = await open(receiptPath, "wx");
    try {
      await receipt.writeFile(`${JSON.stringify({ runId, launches: 1 })}\n`, "utf8");
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    process.stdout.write("launched\n");
    setInterval(() => {}, 1_000);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      process.exitCode = 17;
    } else {
      throw error;
    }
  }
}
