import assert from "node:assert/strict";
import test from "node:test";

import { equalUsd } from "../lib/required-live-authority.mjs";

test("Live Swarm treats cent-identical totals as equal across floating-point aggregation order", () => {
  const leaseOrder = [0.09, 0.07, 0.08].reduce((sum, value) => sum + value, 0);
  const childOrder = [0.08, 0.07, 0.09].reduce((sum, value) => sum + value, 0);

  assert.notEqual(leaseOrder, childOrder);
  assert.equal(equalUsd(leaseOrder, childOrder), true);
  assert.equal(equalUsd(leaseOrder, childOrder + 0.000_01), false);
  assert.equal(equalUsd(Number.NaN, childOrder), false);
});
