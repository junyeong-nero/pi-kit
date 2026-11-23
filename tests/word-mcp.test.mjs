import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Runs against an extracted bundle (WORD_MCP_TEST_BUNDLE) with its own Python, exactly as config/mcp.json launches it.
const bundle = resolve(process.env.WORD_MCP_TEST_BUNDLE || '.');
const config = JSON.parse(readFileSync(join(bundle, 'config/mcp.json'), 'utf8')).mcpServers.word;

test('Word MCP config exposes only live COM tools over stdio', () => {
  assert.equal(config.exposure, 'hidden');
  assert.deepEqual(config.toolExposure, { 'word_live_*': 'deferred' });
  assert.equal(config.env.MCP_TRANSPORT, 'stdio');
});

test('bundled Python starts the Word MCP over stdio and runs a live tool', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const transport = new StdioClientTransport({
    command: join(bundle, 'runtime/python/python.exe'), args: config.args, cwd: bundle, stderr: 'pipe',
    env: { ...process.env, ...config.env },
  });
  let errors = '';
  transport.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
  const client = new Client({ name: 'harness-word-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['word_live_list_open', 'word_live_get_text', 'word_live_find_text', 'word_live_insert_text',
      'word_live_replace_text', 'word_live_format_text', 'word_live_modify_table', 'word_live_save', 'word_live_undo']) {
      assert.ok(tools.includes(name), `Missing ${name}: ${tools.join(', ')}`);
    }
    // Word is not installed on the runner: the tool must answer instead of crashing the server.
    const result = await client.callTool({ name: 'word_live_list_open', arguments: {} });
    assert.ok(Array.isArray(result.content) && result.content.length, JSON.stringify(result));
  } catch (error) {
    throw new Error(`${error.message}\n${errors}`);
  } finally {
    await client.close();
  }
});
