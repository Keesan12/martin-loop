import { stat } from "node:fs/promises";
import path from "node:path";

import {
  readAllLoopRecords,
  readLatestLoopRecord,
  readLatestLoopRecordFromFile,
  readLoopRecordsFromFile,
  resolveRunsRoot,
  type LoopRunRecord
} from "@martin/core";

import {
  resolveSafeLoopRecordPath,
  resolveSafeRunsPath,
  resolveSafeRunsRootPath
} from "../server-validation.js";

export interface InspectLoopSource {
  source: string;
  loops: LoopRunRecord[];
}

export interface StatusLoopSource {
  source: string;
  loop: LoopRunRecord;
}

export async function loadLoopRecordsForInspect(input: {
  file?: string;
  runsDir?: string;
}): Promise<InspectLoopSource> {
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));

  if (!input.file) {
    return {
      source: runsRoot,
      loops: await readAllLoopRecords(runsRoot)
    };
  }

  const targetPath = resolveSafeRunsPath(input.file, runsRoot);
  const targetStats = await stat(targetPath);
  if (targetStats.isDirectory()) {
    const canonicalLoopRecordPath = path.join(targetPath, "loop-record.json");
    try {
      const canonicalLoopRecordStats = await stat(canonicalLoopRecordPath);
      if (canonicalLoopRecordStats.isFile()) {
        return {
          source: canonicalLoopRecordPath,
          loops: await readLoopRecordsFromFile(canonicalLoopRecordPath)
        };
      }
    } catch {
      // fall through to treating the directory as a full runs root
    }

    return {
      source: targetPath,
      loops: await readAllLoopRecords(targetPath)
    };
  }

  return {
    source: targetPath,
    loops: await readLoopRecordsFromFile(targetPath)
  };
}

export async function loadLoopRecordForStatus(input: {
  loopJson?: string;
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}): Promise<StatusLoopSource> {
  if (input.loopJson) {
    return {
      source: "inline:loopJson",
      loop: JSON.parse(input.loopJson) as LoopRunRecord
    };
  }

  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));

  if (input.file) {
    const targetPath = resolveSafeRunsPath(input.file, runsRoot);
    const targetStats = await stat(targetPath);

    if (targetStats.isDirectory()) {
      const canonicalLoopRecordPath = path.join(targetPath, "loop-record.json");
      try {
        const canonicalLoopRecordStats = await stat(canonicalLoopRecordPath);
        if (canonicalLoopRecordStats.isFile()) {
          const loop = await readLatestLoopRecordFromFile(canonicalLoopRecordPath);
          if (!loop) {
            throw new Error("No loop records found.");
          }

          return {
            source: canonicalLoopRecordPath,
            loop
          };
        }
      } catch {
        // fall through to treating the directory as a full runs root
      }

      const loop = await readLatestLoopRecord(targetPath);
      if (!loop) {
        throw new Error("No loop records found.");
      }

      return {
        source: targetPath,
        loop
      };
    }

    const loop = await readLatestLoopRecordFromFile(targetPath);
    if (!loop) {
      throw new Error("No loop records found.");
    }

    return {
      source: targetPath,
      loop
    };
  }

  if (input.loopId) {
    const targetPath = resolveSafeLoopRecordPath(input.loopId, runsRoot);
    const loop = await readLatestLoopRecordFromFile(targetPath);
    if (!loop) {
      throw new Error("No loop records found.");
    }

    return {
      source: targetPath,
      loop
    };
  }

  if (input.latest) {
    const loop = await readLatestLoopRecord(runsRoot);
    if (!loop) {
      throw new Error("No loop records found.");
    }

    return {
      source: runsRoot,
      loop
    };
  }

  throw new Error("Provide exactly one of loopJson, file, loopId, or latest.");
}
