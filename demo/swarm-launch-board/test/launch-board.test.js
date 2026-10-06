import assert from "node:assert/strict";
import test from "node:test";

import { createLaunchBoard } from "../src/api.js";
import { createLaunchState } from "../src/state.js";
import { renderLaunchBoard } from "../src/ui.js";

test("integrated LaunchBoard renders launch items and state", () => {
  const board = createLaunchBoard();
  assert.equal(board.items.length, 2);
  assert.deepEqual(board.items.map((item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(createLaunchState(), { selectedId: null, error: null });
  assert.equal(renderLaunchBoard(board), "LaunchBoard: Alpha, Beta");
});
