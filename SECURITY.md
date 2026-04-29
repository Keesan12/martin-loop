# Security Policy

MartinLoop governs autonomous AI coding agent runs. Security issues may include unsafe command execution, secret leakage, policy bypasses, incorrect budget enforcement, or unsafe file-scope handling.

## Reporting a vulnerability

Please report security issues privately by emailing:

keesan@martinloop.com

Please include:

- Affected version
- Reproduction steps
- Expected behavior
- Actual behavior
- Potential impact

## Please do not

- Publish exploit details before we have reviewed the issue
- Include live secrets, tokens, or credentials in reports
- Test against systems you do not own

## Scope

Security-sensitive areas include:

- Verifier command execution
- Policy checks
- File allow/deny scope handling
- Rollback behavior
- Persistence and run records
- Secret-like value detection
- Budget enforcement logic

## Supported versions

The latest public release is the supported version.

Older versions may not receive fixes unless the issue is severe.
