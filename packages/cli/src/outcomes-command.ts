import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ExternalOutcomeContractError,
  ExternalOutcomePolicyError,
  hashExternalOutcomeContract,
  resolveRunsRoot,
  verifyExternalOutcomes,
  writeExternalOutcomeEvidence,
} from "@martin/core";
import type { ExternalOutcomeContract, MartinOutputMode } from "@martin/contracts";

import { CliCommandError, renderCliSuccess } from "./ux.js";

export interface OutcomesVerifyRequest {
  contractPath: string;
  runsDir?: string;
  allowLocal: boolean;
  expectedContractSha256?: string;
}

export function parseOutcomesVerifyArguments(args: string[]): OutcomesVerifyRequest {
  let contractPath: string | undefined;
  let runsDir: string | undefined;
  let allowLocal = false;
  let expectedContractSha256: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--allow-local") {
      if (allowLocal) throw new CliCommandError("invalid_input", "Duplicate --allow-local option.");
      allowLocal = true;
      continue;
    }
    if (token === "--contract" || token === "--runs-dir" || token === "--expected-contract-sha256") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${token} requires a value.`);
      if (token === "--contract") {
        if (contractPath !== undefined) throw new CliCommandError("invalid_input", "Duplicate --contract option.");
        contractPath = value;
      } else if (token === "--runs-dir") {
        if (runsDir !== undefined) throw new CliCommandError("invalid_input", "Duplicate --runs-dir option.");
        runsDir = value;
      } else {
        if (expectedContractSha256 !== undefined) throw new CliCommandError("invalid_input", "Duplicate --expected-contract-sha256 option.");
        if (!/^[a-f0-9]{64}$/u.test(value)) throw new CliCommandError("invalid_input", "--expected-contract-sha256 must be a lowercase SHA-256 digest.");
        expectedContractSha256 = value;
      }
      continue;
    }
    throw new CliCommandError("invalid_input", `Unsupported outcomes verify argument: ${token}.`);
  }

  if (!contractPath) throw new CliCommandError("invalid_input", "outcomes verify requires --contract <path>.");
  return {
    contractPath,
    ...(runsDir ? { runsDir } : {}),
    allowLocal,
    ...(expectedContractSha256 ? { expectedContractSha256 } : {}),
  };
}

export async function executeOutcomesVerifyCommand(
  request: OutcomesVerifyRequest,
  outputMode: MartinOutputMode,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const contractPath = resolve(request.contractPath);
  let contract: ExternalOutcomeContract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8")) as ExternalOutcomeContract;
  } catch (error) {
    throw new CliCommandError("invalid_input", `Unable to read external outcome contract: ${error instanceof Error ? error.message : String(error)}`);
  }

  const contractSha256 = hashExternalOutcomeContract(contract);
  if (request.expectedContractSha256 && request.expectedContractSha256 !== contractSha256) {
    throw new CliCommandError(
      "policy_blocked",
      "External outcome contract changed after the trusted pre-execution snapshot.",
      { details: { expectedContractSha256: request.expectedContractSha256, observedContractSha256: contractSha256 } }
    );
  }
  enforceBoundOutcomeNetworkPolicy(contract, process.env);

  let result;
  try {
    result = await verifyExternalOutcomes(contract, {
      env: process.env,
      allowLocal: request.allowLocal,
    });
  } catch (error) {
    if (error instanceof ExternalOutcomeContractError) {
      throw new CliCommandError("invalid_input", "External outcome contract is invalid.", {
        details: { errors: error.errors },
      });
    }
    if (error instanceof ExternalOutcomePolicyError) {
      throw new CliCommandError("policy_blocked", error.message, {
        details: { reasonCode: error.code },
      });
    }
    throw error;
  }

  const runsRoot = resolve(request.runsDir?.trim() || resolveRunsRoot(process.env));
  const runId = process.env.MARTIN_RUN_ID?.trim();
  const evidence = await writeExternalOutcomeEvidence(result, {
    runsRoot,
    ...(runId ? { runId } : {}),
  });

  const requiredPassed =
    result.aggregate.claimedDone > 0
    && result.aggregate.passed === result.aggregate.claimedDone
    && result.aggregate.failed === 0
    && result.aggregate.unknown === 0;

  const data = {
    command: "outcomes verify",
    status: requiredPassed ? "passed" : "failed",
    contractId: result.contractId,
    contractSha256: result.contractSha256,
    aggregate: result.aggregate,
    actions: result.actions,
    evidence: evidence.reference,
    evidencePath: evidence.path,
  };

  return renderCliSuccess(outputMode, {
    data,
    human: [
      requiredPassed ? "outcome checks passed" : "outcome checks failed",
      `Contract: ${result.contractId}`,
      `Claimed done: ${result.aggregate.claimedDone}`,
      `Passed: ${result.aggregate.passed} / Failed: ${result.aggregate.failed} / Unknown: ${result.aggregate.unknown}`,
      ...result.actions.map((action) => `- ${action.actionId}: ${action.status} (${action.reasonCode})`),
      `Evidence: ${evidence.path}`,
    ],
    quiet: requiredPassed ? "passed" : "failed",
    exitCode: requiredPassed ? 0 : 7,
  });
}
function enforceBoundOutcomeNetworkPolicy(contract: ExternalOutcomeContract, env: NodeJS.ProcessEnv): void {
  const runId = env.MARTIN_RUN_ID?.trim();
  if (!runId || runId === "unbound") return;

  if (env.MARTIN_EXECUTION_PROFILE !== "staging_controlled") {
    throw new CliCommandError(
      "policy_blocked",
      "Governed external outcome verification requires the staging_controlled execution profile."
    );
  }

  let allowedDomains: string[] = [];
  try {
    const parsed = JSON.parse(env.MARTIN_ALLOWED_NETWORK_DOMAINS ?? "[]");
    if (Array.isArray(parsed)) {
      allowedDomains = parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.toLowerCase());
    }
  } catch {
    throw new CliCommandError("policy_blocked", "Governed external outcome network allowlist is unreadable.");
  }
  if (allowedDomains.length === 0) {
    throw new CliCommandError("policy_blocked", "Governed external outcome verification requires an explicit network allowlist.");
  }

  for (const action of contract.actions) {
    const hostname = new URL(action.source.url).hostname.toLowerCase();
    if (!allowedDomains.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
      throw new CliCommandError(
        "policy_blocked",
        `External outcome source host is outside the governed network allowlist: ${hostname}`,
      );
    }
  }
}

