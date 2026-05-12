import test from "node:test";
import assert from "node:assert/strict";

import { summarizeInvoice } from "../src/invoice-summary.js";

test("summarizeInvoice returns subtotal, tax, and total", () => {
  const result = summarizeInvoice(
    [
      { quantity: 2, unitPrice: 19.99 },
      { quantity: 1, unitPrice: 5.5 }
    ],
    0.13
  );

  assert.deepEqual(result, {
    subtotal: 45.48,
    tax: 5.91,
    total: 51.39
  });
});
