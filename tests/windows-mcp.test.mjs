import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Runs against an extracted bundle (WINDOWS_MCP_TEST_BUNDLE) with its own Python, exactly as config/mcp.json launches it.
const bundle = resolve(process.env.WINDOWS_MCP_TEST_BUNDLE || '.');
const config = JSON.parse(readFileSync(join(bundle, 'config/mcp.json'), 'utf8')).mcpServers.windows;

test('Windows-MCP config keeps telemetry off and hides tools that bypass pi', () => {
  assert.equal(config.exposure, 'deferred');
  assert.equal(config.env.ANONYMIZED_TELEMETRY, 'false');
  for (const tool of ['PowerShell', 'FileSystem', 'Registry', 'Process', 'Scrape', 'Screenshot']) {
    assert.equal(config.toolExposure[tool], 'hidden', `${tool} must be hidden`);
  }
});

test('bundled Python starts Windows-MCP over stdio and runs a tool', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const transport = new StdioClientTransport({
    command: join(bundle, 'runtime/python/python.exe'), args: config.args, cwd: bundle, stderr: 'pipe',
    env: { ...process.env, ...config.env },
  });
  let errors = '';
  transport.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
  const client = new Client({ name: 'harness-windows-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['App', 'Click', 'Type', 'Shortcut', 'Scroll', 'Snapshot', 'Wait']) {
      assert.ok(tools.includes(name), `Missing ${name}: ${tools.join(', ')}`);
    }
    for (const name of Object.keys(config.toolExposure)) {
      assert.ok(tools.includes(name), `toolExposure names a tool this version does not have: ${name}`);
    }
    const result = await client.callTool({ name: 'Wait', arguments: { duration: 1 } });
    assert.ok(!result.isError, JSON.stringify(result.content));
  } catch (error) {
    throw new Error(`${error.message}\n${errors}`);
  } finally {
    await client.close();
  }
});
