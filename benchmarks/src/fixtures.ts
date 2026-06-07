import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { BenchmarkSuite, Under3ChallengeFixture } from "./types.js";

const fixturesRoot = new URL("../fixtures/", import.meta.url);

async function readFixture<T>(fileName: string): Promise<T> {
  const raw = await readFile(fileURLToPath(new URL(fileName, fixturesRoot)), "utf8");
  return JSON.parse(raw) as T;
}

export async function loadBenchmarkSuiteFixture(suiteId: string): Promise<BenchmarkSuite> {
  return readFixture<BenchmarkSuite>(`${suiteId}.json`);
}

export async function loadUnder3ChallengeFixture(): Promise<Under3ChallengeFixture> {
  return readFixture<Under3ChallengeFixture>("under-3-challenge.json");
}
