#!/usr/bin/env node
import { writeRepository, writeTool } from './lib/repository-write.mjs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { inspectRepository, inspectionTool } from './lib/repository-tools.mjs';

// One private stdio MCP server per reviewer; no arbitrary command execution.
const repo = process.argv[2];
const audit = process.argv[3];
const recovery = process.argv[4];
const evidence = { successes: 0, failures: 0 };
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024)
      throw new Error('Request too large.');
    request = JSON.parse(line);
    if (!Object.hasOwn(request, 'id')) continue;
    let result;
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'repository-review', version: '1.0.0' },
      };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list')
      result = { tools: [inspectionTool, ...(recovery ? [writeTool] : [])] };
    else if (
      request.method === 'tools/call' &&
      (request.params?.name === 'inspect' ||
        (recovery && request.params?.name === 'write'))
    ) {
      result = await callTool(request.params.arguments, request.params.name);
    } else {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found.' },
        }),
      );
      continue;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } catch {
    console.log(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: { code: -32700, message: 'Invalid request.' },
      }),
    );
  }
}

async function callTool(input, name) {
  try {
    const text =
      name === 'write'
        ? await writeRepository(repo, recovery, input)
        : await inspectRepository(repo, input);
    // Tool mistakes are reported to the reviewer, not permanent vetoes.
    // Bounded pages contain explicit continuation instructions.
    evidence.successes++;
    await saveEvidence();
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    evidence.failures++;
    await saveEvidence();
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

async function saveEvidence() {
  if (audit) await writeFile(audit, JSON.stringify(evidence), { mode: 0o600 });
}
