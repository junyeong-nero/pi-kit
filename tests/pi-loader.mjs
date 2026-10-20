import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const root = mkdtempSync(join(tmpdir(), 'pi loader 한글 '));
mkdirSync(join(root, 'config'));
const file = join(root, 'main.cpp');
copyFileSync(resolve('tests/fixtures/cpp/main.cpp'), file);
process.env.HARNESS_LSP_CONFIG = join(root, 'config/lsp.json');
writeFileSync(process.env.HARNESS_LSP_CONFIG, JSON.stringify({ servers: {
  cpp: { command: process.env.TEST_CLANGD ?? 'clangd', args: ['--log=error'] },
  csharp: { command: join(root, 'deliberately-missing-server') },
} }));
let extension;
try {
  const loaded = await loadExtensions([resolve('extensions/cpp-csharp-lsp-lite/index.ts')], root);
  assert.deepEqual(loaded.errors, []); extension = loaded.extensions[0];
  assert.equal(extension.tools.size, 6);
  const context = { cwd: root };
  const call = async (name, params) => {
    const result = await extension.tools.get(name).definition.execute('test', params, undefined, undefined, context);
    return result.content.map(item => item.text ?? '').join('\n');
  };
  const position = { path: file, line: 2, symbol: 'add' };
  assert.match(await call('lsp_hover', position), /add/);
  assert.match(await call('lsp_definition', position), /main.cpp:1:/);
  assert.match(await call('lsp_references', position), /main.cpp:2:/);
  assert.match(await call('lsp_symbols', { path: file }), /add/);
  assert.match(await call('find_symbol', { name: 'add', path: root }), /^find_symbol add:/);
  assert.match(await call('lsp_diagnostics', { path: file }), /no issues/);
  assert.match(await call('lsp_symbols', { query: 'add' }), /Partial search:/);
  writeFileSync(file, 'int main() { return missing_name; }\n');
  for (const handler of extension.handlers.get('tool_result')) {
    const result = await handler({ toolName: 'write', input: { path: file }, isError: false, content: [{ type: 'text', text: 'written' }] }, context);
    assert.match(result.content.at(-1).text, /missing_name/);
  }
  console.log('pi loader: all 6 tools, partial server failure, edit diagnostics passed');
} finally {
  for (const handler of extension?.handlers.get('session_shutdown') ?? []) await handler({}, { cwd: root });
  rmSync(root, { recursive: true, force: true });
}
