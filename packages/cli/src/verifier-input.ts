import { describeMalformedVerifier } from "@martin/core";

import { CliCommandError } from "./ux.js";

export { describeMalformedVerifier };

export function assertWellFormedVerifier(command: string): string {
  const reason = describeMalformedVerifier(command);
  if (reason !== undefined) {
    throw new CliCommandError("invalid_input", reason, {
      suggestion: 'Quote the whole verifier and nothing else, for example: --verify "npm test" --budget-usd 1',
      details: { verifier: command }
    });
  }
  return command;
}
