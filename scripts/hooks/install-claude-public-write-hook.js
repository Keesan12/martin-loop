#!/usr/bin/env node
"use strict";

const { copyFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { homedir } = require("node:os");

const source = resolve(__dirname, "block-public-oss-writes.js");
const hookHome = process.env.MARTIN_CLAUDE_HOOK_HOME || homedir();
const target = resolve(hookHome, ".claude", "scripts", "hooks", "block-public-oss-writes.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[hook-install] synchronized ${target}`);
