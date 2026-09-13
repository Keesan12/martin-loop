// SPDX-License-Identifier: Apache-2.0
export const PUBLISHER_EQUIVALENT_COMMANDS = Object.freeze([
  ["pnpm", ["install", "--frozen-lockfile"]], ["pnpm", ["release:clean-check"]], ["pnpm", ["public:promotion-guard"]], ["pnpm", ["release:authority:check"]],
  ["pnpm", ["lint"]], ["pnpm", ["public:copy-scan"]], ["pnpm", ["public:portability-guard"]], ["pnpm", ["public:git-surface"]],
  ["pnpm", ["build"]], ["pnpm", ["release:authority:check:built"]], ["pnpm", ["test"]], ["pnpm", ["oss:validate"]], ["pnpm", ["public:smoke"]],
  ["pnpm", ["--filter", "@martinloop/mcp", "lint"]], ["pnpm", ["--filter", "@martinloop/mcp", "test"]], ["pnpm", ["--filter", "@martinloop/mcp", "build"]],
  ["pnpm", ["--filter", "@martinloop/mcp", "smoke:pack"]], ["pnpm", ["--filter", "@martinloop/mcp", "smoke:published:pack"]], ["pnpm", ["--filter", "@martinloop/mcp", "verify:release"]],
  ["pnpm", ["--filter", "@martinloop/mcp", "mcpb:build"]], ["pnpm", ["--filter", "@martinloop/mcp", "mcpb:validate"]], ["pnpm", ["--filter", "@martinloop/mcp", "mcpb:smoke"]],
]);
