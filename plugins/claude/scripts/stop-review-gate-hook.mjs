#!/usr/bin/env node
import { runGate } from './lib/gate.mjs';

async function readInput() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input.trim() ? JSON.parse(input) : {};
}

try {
  console.log(JSON.stringify(await runGate(await readInput())));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
