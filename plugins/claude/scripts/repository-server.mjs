#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { inspectRepository, inspectionTool } from './lib/repository-tools.mjs';

// One private stdio MCP server per reviewer; no arbitrary command execution.
const repo = process.argv[2];
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
      result = { tools: [inspectionTool] };
    else if (
      request.method === 'tools/call' &&
      request.params?.name === 'inspect'
    ) {
      result = await callTool(request.params.arguments);
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

async function callTool(input) {
  try {
    const text = await inspectRepository(repo, input);

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}
