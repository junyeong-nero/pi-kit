import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'pi extensions 한글 '));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
mkdirSync(join(root, 'agent/extensions/subagent'), { recursive: true });
copyFileSync('config/extensions/subagent/config.json', join(root, 'agent/extensions/subagent/config.json'));
copyFileSync('config/extensions/allowlist-gate.json', join(root, 'agent/extensions/allowlist-gate.json'));
try {
  const { loadExtensions } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  // package.json's pi manifest is the single list of what the bundle loads (setup.ps1 and `pi install` both use it).
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')).pi;
  assert.equal(manifest.extensions[0], './extensions/harness-env/index.ts', 'harness-env must load first to set defaults for later extensions');
  assert.equal(manifest.extensions.at(-1), './extensions/tool-profile/index.ts', 'tool-profile must run after upstream activation hooks');
  assert.deepEqual(manifest.skills, [], 'no bundled skills');
  assert.deepEqual(manifest.prompts, [], 'no eager bundled prompt templates');
  for (const name of readdirSync('extensions', { withFileTypes: true }).filter(e => existsSync(`extensions/${e.name}/index.ts`)).map(e => e.name)) {
    assert.ok(manifest.extensions.includes(`./extensions/${name}/index.ts`), `extensions/${name} is missing from package.json pi.extensions`);
  }
  for (const path of [...manifest.skills, ...manifest.prompts]) assert.ok(existsSync(path), `Missing package resource ${path}`);
  const loaded = await loadExtensions(manifest.extensions.map(path => resolve(path)), root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, manifest.extensions.length);
  const usage = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/@tian.zuo/pi-usage/index.ts'));
  assert.ok(usage?.commands.has('tokens'), 'pi-usage must register the local token history command');
  const commands = loaded.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(new Set(commands).size, commands.length, 'No duplicate command registrations');
  const hooksOf = name => [...(loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith(`extensions/${name}/index.ts`))?.handlers.keys() ?? [])];
  assert.ok(hooksOf('harness-env').includes('before_agent_start'), 'harness-env hooks before_agent_start');
  const footer = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/pi-context-footer/extensions/footer.ts'));
  assert.ok(footer?.handlers.has('session_start') && footer.commands.has('builtin-footer'), 'pi-context-footer installs the footer on session start');
  assert.ok(!manifest.extensions.some(path => path.includes('pi-usage-bar')), 'pi-usage-bar is excluded from the bundle');
  assert.ok(hooksOf('allowlist-gate').includes('tool_call'), 'allowlist-gate hooks tool_call');
  // The bundled allowlist lets read-only commands and tools run and asks (blocks without a screen) for everything else.
  const [gate] = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('extensions/allowlist-gate/index.ts')).handlers.get('tool_call');
  const notices = [];
  const gateContext = { cwd: root, hasUI: false, signal: undefined, isProjectTrusted: () => false, ui: { notify: message => notices.push(message) } };
  const gated = async (toolName, input) => (await gate({ type: 'tool_call', toolCallId: 'test', toolName, input }, gateContext))?.block === true;
  for (const command of ['Get-ChildItem -Recurse -Filter *.cpp', 'Get-Content main.cpp | Select-String add', 'git status --short', 'git diff']) {
    assert.equal(await gated('powershell', { command }), false, `allowed: ${command}`);
  }
  for (const command of ['Remove-Item main.cpp', 'Get-ChildItem; Remove-Item main.cpp', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'Get-Content main.cpp > copy.cpp', 'msbuild app.sln']) {
    assert.equal(await gated('powershell', { command }), true, `asks: ${command}`);
  }
  assert.equal(await gated('harness_tools', { action: 'list' }), false, 'read-only tools run without asking');
  assert.equal(await gated('mcp__build_center__get_results', { project_name: 'ProjectA', module_ids: ['1'] }), false, 'build center MCP tools run without asking');
  assert.equal(await gated('mcp__other__get_results', {}), true, 'asks: tools of other MCP servers');
  assert.equal(await gated('mcp__edge__browser_snapshot', {}), true, 'asks before reading signed-in Edge pages');
  assert.equal(await gated('mcp__edge__browser_click', { target: 'e1' }), true, 'asks before clicking in Edge');
  assert.equal(await gated('mcp__edge__browser_fill_form', { fields: [] }), true, 'asks before filling forms in Edge');
  assert.equal(await gated('mcp__windows__Snapshot', {}), true, 'asks before reading the Windows desktop');
  assert.equal(await gated('mcp__windows__Click', { loc: [10, 10] }), true, 'asks before clicking on the Windows desktop');
  assert.equal(await gated('read', { path: 'main.cpp' }), false, 'read is never gated');
  assert.equal(await gated('ask_user_question', { questions: [] }), false, 'asking the user needs no extra approval');
  assert.equal(await gated('todo', { action: 'list' }), false, 'the session task list needs no approval');
  for (const [toolName, input] of [['edit', { path: 'main.cpp', edits: [] }], ['write', { path: 'main.cpp', content: '' }], ['subagent', {}]]) {
    assert.equal(await gated(toolName, input), true, `asks: ${toolName}`);
  }
  assert.deepEqual(notices, [], 'bundled allowlist-gate.json loads without warnings');
  const automode = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/extensions/auto-mode/index.ts')).commands.get('automode');
  assert.ok(automode, 'automode command is registered');
  for (const mode of ['on', 'auto']) {
    await automode.handler(mode, gateContext);
    assert.equal(await gated('write', { path: 'main.cpp', content: '' }), false, 'automode takes effect on the next call without reload');
    await automode.handler('off', gateContext);
    assert.equal(await gated('write', { path: 'main.cpp', content: '' }), true, 'automode off restores approval without reload');
  }
  assert.equal(manifest.extensions[1], './vendor/extensions/node_modules/pi-tool-repair/tool-repair.ts', 'pi-tool-repair fixes tool calls right after harness-env');
  assert.ok(hooksOf('harness-env').includes('message_end'), 'harness-env repairs powershell argument names');
  const repair = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/pi-tool-repair/tool-repair.ts'));
  assert.ok(repair?.handlers.has('message_end'), 'pi-tool-repair hooks message_end');
  assert.ok(hooksOf('read-budget').includes('tool_call') && hooksOf('read-budget').includes('tool_result'), 'read-budget trims large reads and notes it');
  const planPath = './vendor/extensions/node_modules/@narumitw/pi-plan-mode/dist/index.ts';
  const plan = loaded.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/@narumitw/pi-plan-mode/dist/index.ts'));
  assert.ok(plan?.commands.has('plan') && plan.handlers.has('tool_call'), 'pi-plan-mode registers /plan and guards tool calls');
  assert.ok(manifest.extensions.indexOf(planPath) >= 0 && manifest.extensions.indexOf(planPath) < manifest.extensions.findIndex(path => path.includes('allowlist-gate')), 'pi-plan-mode blocks before allowlist-gate asks for approval');
  const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.equal(new Set(tools).size, tools.length, 'No duplicate tool registrations');
  for (const name of ['subagent', 'ask_user_question', 'todo', 'harness_tools']) {
    assert.ok(tools.includes(name), `Missing ${name}`);
  }
  assert.ok(!tools.some(name => name.startsWith('lsp_') || name === 'find_symbol'), 'no LSP tools are registered');
  assert.ok(!manifest.extensions.some(path => path.includes('pi-lens')), 'pi-lens is not bundled');
  assert.ok(!tools.some(name => name.startsWith('lens_') || name.startsWith('ast_grep') || name === 'module_report' || name === 'read_symbol'), 'no pi-lens tools are registered');
  console.log(`${loaded.extensions.length} package extensions loaded without collisions (${tools.length} tools)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
