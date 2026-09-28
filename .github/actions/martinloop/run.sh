#!/usr/bin/env bash
set -uo pipefail

RUNS_DIR="${RUNNER_TEMP:-/tmp}/martin-runs"
mkdir -p "$RUNS_DIR"
PKG="martin-loop@${ML_VERSION:-0.6.9}"
OUT="$RUNS_DIR/run.json"

MODE="${ML_MODE:-proof}"
case "$MODE" in
  proof|run)
    ;;
  *)
    {
      echo "reason-code=invalid_mode"
      echo "exit-code=2"
    } >> "$GITHUB_OUTPUT"
    echo "::error title=MartinLoop::Invalid mode '$MODE'. Expected 'proof' or 'run'." >&2
    exit 2
    ;;
esac

TOOL_DIR="${RUNNER_TEMP:-/tmp}/martinloop-tool-${ML_VERSION:-0.6.9}"
CLI_JS="$TOOL_DIR/node_modules/martin-loop/dist/bin/martin-loop.js"

if [ ! -f "$CLI_JS" ]; then
  mkdir -p "$TOOL_DIR"
  if ! npm install --prefix "$TOOL_DIR" --no-save --package-lock=false "$PKG"; then
    echo "::error title=MartinLoop::Failed to install $PKG for the Action runner." >&2
    exit 1
  fi
fi

run_martin() {
  node "$CLI_JS" "$@"
}

args=(run "$ML_OBJECTIVE" --verify "$ML_VERIFY" --runs-dir "$RUNS_DIR" --json)
if [ "$MODE" = "proof" ]; then
  args+=(--proof)
else
  args+=(--budget-usd "$ML_BUDGET" --max-iterations "$ML_ITERS" --engine "$ML_ENGINE")
  [ -n "${ML_MODEL:-}" ] && args+=(--model "$ML_MODEL")
  while IFS= read -r g; do [ -n "$g" ] && args+=(--allow-path "$g"); done <<< "${ML_ALLOW:-}"
  while IFS= read -r g; do [ -n "$g" ] && args+=(--deny-path "$g"); done <<< "${ML_DENY:-}"
fi

echo "::group::martin-loop ${args[*]}"
run_martin "${args[@]}" > "$OUT"
CODE=$?
echo "::endgroup::"

if ! node -e '
  const fs=require("fs");
  try {
    const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if (!d || d.command !== "run") process.exit(1);
  } catch {
    process.exit(1);
  }
' "$OUT"; then
  {
    echo "status=needs_review"
    echo "reason-code=cli_execution_failed"
    echo "loop-id=none"
    echo "cost-usd=0.00"
    echo "exit-code=$CODE"
    echo "receipt-dir="
  } >> "$GITHUB_OUTPUT"
  echo "::error title=MartinLoop::CLI execution failed before a valid run result was produced (exit $CODE)." >&2
  [ "$CODE" -ne 0 ] && exit "$CODE"
  exit 1
fi

read -r STATUS REASON LOOP COST < <(node -e '
  const fs=require("fs");
  let d={}; try{ d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")) }catch(e){}
  const rc=(d.decision&&(d.decision.reasonCode||d.decision.lifecycleState))||"unknown";
  const loop=(d.loop&&d.loop.loopId)||"none";
  const cost=((d.loop&&d.loop.cost&&d.loop.cost.actualUsd)||0).toFixed(2);
  const mode=process.env.ML_MODE||"proof";
  const proofOutcome=d.proofOutcome;
  const stopped=["budget_exit","budget_cap","turn_cap","policy_blocked","stuck_exit","human_interrupt","external_event","wall_clock"];
  let status;
  if(mode==="proof") status = proofOutcome==="PROOF_PASSED" ? "proof_passed" : "proof_failed";
  else status = rc==="goal_met" ? "verified" : (stopped.includes(rc) ? "stopped" : "needs_review");
  console.log(status, rc, loop, cost);
' "$OUT")

RECEIPT_DIR=""
if [ "$LOOP" != "none" ]; then
  run_martin share --loop-id "$LOOP" --runs-dir "$RUNS_DIR" --json > "$RUNS_DIR/share.json" 2>/dev/null || true
  RECEIPT_DIR=$(node -e 'try{console.log(require(process.argv[1]).outputDir||"")}catch(e){console.log("")}' "$RUNS_DIR/share.json")
fi

{
  echo "status=$STATUS"
  echo "reason-code=$REASON"
  echo "loop-id=$LOOP"
  echo "cost-usd=$COST"
  echo "exit-code=$CODE"
  echo "receipt-dir=$RECEIPT_DIR"
} >> "$GITHUB_OUTPUT"

ICON="✅"
[ "$STATUS" = "proof_failed" ] && ICON="❌"
[ "$STATUS" = "stopped" ] && ICON="⛔"
[ "$STATUS" = "needs_review" ] && ICON="⚠️"
{
  printf '## %s MartinLoop: `%s`\n\n' "$ICON" "${STATUS^^}"
  printf '| Field | Value |\n'
  printf '| --- | --- |\n'
  printf '| Mode | `%s` |\n' "$MODE"
  printf '| Objective | %s |\n' "$ML_OBJECTIVE"
  printf '| Verifier | `%s` |\n' "$ML_VERIFY"
  printf '| Reason | `%s` |\n' "$REASON"
  printf '| Spend | $%s |\n' "$COST"
  printf '| Loop | `%s` |\n\n' "$LOOP"
  if [ -n "$RECEIPT_DIR" ] && [ -f "$RECEIPT_DIR/run-receipt.md" ]; then
    echo "<details><summary>Run receipt</summary>"
    echo ""
    cat "$RECEIPT_DIR/run-receipt.md"
    echo ""
    echo "</details>"
  fi
  echo ""
  echo "<sub>Governed by [MartinLoop](https://github.com/Keesan12/martin-loop)</sub>"
} >> "$GITHUB_STEP_SUMMARY"

exit 0
