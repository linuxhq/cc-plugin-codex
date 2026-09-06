#!/usr/bin/env node
import { gateFailure, runGate } from './lib/gate.mjs';

async function readInput() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2 * 1024 * 1024)
      throw new Error('Hook input exceeds 2 MiB.');
  }

  return JSON.parse(input);
}

try {
  console.log(JSON.stringify(await runGate(await readInput())));
} catch (error) {
  // Stop hooks require valid JSON; a nonzero exit would merely report an error.
  console.log(JSON.stringify(gateFailure(error.message)));
}
