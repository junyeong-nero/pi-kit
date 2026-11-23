import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Runs against an extracted bundle (WORD_MCP_TEST_BUNDLE) with its own Python, exactly as config/mcp.json launches it.
const bundle = resolve(process.env.WORD_MCP_TEST_BUNDLE || '.');
const config = JSON.parse(readFileSync(join(bundle, 'config/mcp.json'), 'utf8')).mcpServers.word_vba;

test('Word VBA MCP is deferred and its timeout covers the longest VBA run', () => {
  assert.equal(config.exposure, 'deferred');
  assert.ok(config.timeout >= 600, 'pi must wait longer than run_vba (580 s max) to see its timeout message');
});

test('bundled Python starts the Word VBA MCP and reports a missing Word as a tool error', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const transport = new StdioClientTransport({
    command: join(bundle, 'runtime/python/python.exe'), args: config.args, cwd: bundle, stderr: 'pipe', env: process.env,
  });
  let errors = '';
  transport.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
  const client = new Client({ name: 'harness-word-vba-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['list_documents', 'read_output', 'run_vba']);
    // Word is not installed on the runner: the model must see why, not only "Error executing tool".
    const code = 'Function PiMain() As String\n  PiMain = ActiveDocument.Name\nEnd Function';
    const result = await client.callTool({ name: 'run_vba', arguments: { code } });
    assert.ok(result.isError, JSON.stringify(result));
    assert.match(result.content[0].text, /Word/);
    const missing = await client.callTool({ name: 'run_vba', arguments: { code: 'Sub Main()\nEnd Sub' } });
    assert.ok(missing.isError && /PiMain/.test(missing.content[0].text), JSON.stringify(missing));
    const gone = await client.callTool({ name: 'read_output', arguments: { output_id: 'none', offset: 0 } });
    assert.ok(gone.isError && /output_id/.test(gone.content[0].text), JSON.stringify(gone));
  } catch (error) {
    throw new Error(`${error.message}\n${errors}`);
  } finally {
    await client.close();
  }
});
