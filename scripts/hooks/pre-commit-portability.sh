#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
node "$repo_root/scripts/hooks/pre-commit-portability-scan.mjs"
