import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUDGET, type LoopBudget, type LoopTask } from "@martin/contracts";

import type {
  BenchmarkBaseline,
  BenchmarkCase,
  BenchmarkSuite,
  BenchmarkSuiteManifest
} from "./types.js";

interface RawBenchmarkCase {
  caseId: string;
  label?: string;
  task: LoopTask;
  budget?: Partial<LoopBudget>;
  baseline: BenchmarkBaseline;
  tags?: string[];
  metadata?: Record<string, string>;
}

interface RawBenchmarkSuite {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  cases: RawBenchmarkCase[];
}

const BUILT_IN_FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures", import.meta.url));

export function getBuiltInFixtureDirectory(): string {
  return BUILT_IN_FIXTURE_DIRECTORY;
}

export function getBuiltInFixturePath(suiteId: string): string {
  return join(BUILT_IN_FIXTURE_DIRECTORY, `${suiteId}.json`);
}

export async function loadBenchmarkSuiteFixture(suiteId: string): Promise<BenchmarkSuite> {
  return loadBenchmarkSuiteFromFile(getBuiltInFixturePath(suiteId));
}

export async function loadBenchmarkSuiteFromFile(filePath: string): Promise<BenchmarkSuite> {
  const contents = await readFile(filePath, "utf8");
  const raw = JSON.parse(contents) as RawBenchmarkSuite;

  return normalizeSuite(raw);
}

export async function listBuiltInSuites(): Promise<BenchmarkSuiteManifest[]> {
  const entries = await readdir(BUILT_IN_FIXTURE_DIRECTORY, {
    withFileTypes: true
  });

  const fixtureFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const manifests = await Promise.all(
    fixtureFiles.map(async (fixtureName) => {
      const fixturePath = join(BUILT_IN_FIXTURE_DIRECTORY, fixtureName);
      const suite = await loadBenchmarkSuiteFromFile(fixturePath);

      return {
        suiteId: suite.suiteId,
        label: suite.label,
        description: suite.description,
        baselineAdapter: suite.baselineAdapter,
        caseCount: suite.cases.length,
        fixturePath
      };
    })
  );

  return manifests;
}

function normalizeSuite(raw: RawBenchmarkSuite): BenchmarkSuite {
  assertHasText(raw.suiteId, "suiteId");
  assertHasText(raw.label, "label");
  assertHasText(raw.description, "description");
  assertHasText(raw.baselineAdapter, "baselineAdapter");

  return {
    suiteId: raw.suiteId,
    label: raw.label,
    description: raw.description,
    baselineAdapter: raw.baselineAdapter,
    cases: raw.cases.map((benchmarkCase) => normalizeCase(benchmarkCase))
  };
}

function normalizeCase(raw: RawBenchmarkCase): BenchmarkCase {
  assertHasText(raw.caseId, "caseId");
  assertHasText(raw.task?.title, `case ${raw.caseId} task.title`);
  assertHasText(raw.task?.objective, `case ${raw.caseId} task.objective`);

  const task: LoopTask = {
    title: raw.task.title,
    objective: raw.task.objective,
    verificationPlan: [...raw.task.verificationPlan],
    ...(raw.task.repoRoot ? { repoRoot: raw.task.repoRoot } : {})
  };

  return {
    caseId: raw.caseId,
    label: raw.label?.trim().length ? raw.label : raw.caseId,
    task,
    budget: {
      ...DEFAULT_BUDGET,
      ...raw.budget
    },
    baseline: normalizeBaseline(raw.baseline, raw.caseId),
    tags: [...(raw.tags ?? [])],
    ...(raw.metadata ? { metadata: { ...raw.metadata } } : {})
  };
}

function normalizeBaseline(baseline: BenchmarkBaseline, caseId: string): BenchmarkBaseline {
  assertHasText(baseline?.adapterId, `case ${caseId} baseline.adapterId`);
  assertHasText(baseline?.model, `case ${caseId} baseline.model`);
  assertHasText(baseline?.strategy, `case ${caseId} baseline.strategy`);

  return {
    adapterId: baseline.adapterId,
    model: baseline.model,
    strategy: baseline.strategy
  };
}

function assertHasText(value: string | undefined, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Benchmark fixture field "${fieldName}" must be a non-empty string.`);
  }
}
