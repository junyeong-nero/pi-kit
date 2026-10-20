import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../vendor/extensions/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const bundle = resolve(process.env.EDGE_TEST_BUNDLE || '.');
const config = JSON.parse(readFileSync(join(bundle, 'config/mcp.json'), 'utf8')).mcpServers.edge;
const browserConfig = JSON.parse(readFileSync(join(bundle, 'config/playwright.json'), 'utf8'));
const python = process.platform === 'win32' ? join(bundle, 'runtime/python/python.exe') : 'python3';
const launcherArgs = process.platform === 'win32' ? config.args : ['-I', '-X', 'utf8', '-B', join(bundle, 'mcp/edge/edge_mcp.py')];

function text(result) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function connect(root, env = {}) {
  const transport = new StdioClientTransport({
    command: python, args: launcherArgs, cwd: root, stderr: 'pipe',
    env: {
      ...process.env, ...config.env,
      PI_CODING_AGENT_DIR: join(root, 'config'), ...env,
    },
  });
  let errors = '';
  const client = new Client({ name: 'harness-edge-test', version: '1.0.0' });
  try {
    const pending = client.connect(transport);
    transport.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
    await pending;
    return { client, close: () => client.close() };
  } catch (error) {
    await transport.close();
    throw new Error(`${error.message}\n${errors}`);
  }
}

test('Edge MCP initializes without a browser, npx, downloads, or project-relative paths', { timeout: 20000 }, async () => {
  assert.equal(browserConfig.browser.cdpEndpoint, 'msedge');
  assert.equal(config.exposure, 'deferred');
  for (const tool of ['browser_install', 'browser_evaluate', 'browser_run_code', 'browser_file_upload']) {
    assert.equal(config.toolExposure[tool], 'hidden');
  }
  assert.equal(browserConfig.webmcp, false);
  assert.equal(browserConfig.imageResponses, 'omit');
  const root = mkdtempSync(join(tmpdir(), 'edge MCP init 한글 '));
  let connection;
  try {
    connection = await connect(root);
    const tools = (await connection.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['browser_snapshot', 'browser_tabs', 'browser_navigate', 'browser_click', 'browser_fill_form']) {
      assert.ok(tools.includes(name), `Missing ${name}: ${tools.join(', ')}`);
    }
  } finally {
    await connection?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const edgeCandidates = process.platform === 'win32'
  ? [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).map(root => join(root, 'Microsoft/Edge/Application/msedge.exe'))
  : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
const edge = edgeCandidates.find(existsSync);
// macOS can verify the CDP path with installed Chrome, but Windows CI must use Edge.
const executable = edge || (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);

async function launchBrowser(root, url) {
  const browser = spawn(executable, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(root, 'browser-profile')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', url,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let log = '';
  try {
    const endpoint = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Browser CDP startup timed out: ${log}`)), 15000);
      const finish = (error, value) => {
        clearTimeout(timer);
        browser.removeListener('error', onError);
        browser.removeListener('exit', onExit);
        browser.stderr.removeListener('data', onData);
        if (error) reject(error); else done(value);
      };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Browser exited ${code}: ${log}`));
      const onData = data => {
        log = (log + data.toString()).slice(-8192);
        const match = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) finish(undefined, `http://127.0.0.1:${match[1]}`);
      };
      browser.once('error', onError);
      browser.once('exit', onExit);
      browser.stderr.on('data', onData);
    });
    // Keep draining browser diagnostics after connection.
    browser.stderr.on('data', () => {});
    return { browser, endpoint };
  } catch (error) {
    await stopBrowser(browser);
    throw error;
  }
}

async function stopBrowser(browser) {
  if (!browser?.pid || browser.exitCode !== null || browser.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/F', '/T', '/PID', String(browser.pid)], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit');
  } else {
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  if (browser.exitCode === null && browser.signalCode === null) await once(browser, 'exit');
}

test('CDP attaches to an existing signed-in browser and fills/clicks a page (Edge required on Windows)', { timeout: 45000, skip: !executable && process.platform !== 'win32' }, async () => {
  assert.ok(executable, 'Windows CI requires installed Microsoft Edge');
  const root = mkdtempSync(join(tmpdir(), 'edge MCP browser 한글 '));
  let signedIn;
  const initialPage = new Promise(done => { signedIn = done; });
  const server = createServer((req, res) => {
    if (req.url === '/login-fixture') {
      res.setHeader('Set-Cookie', 'corp_session=local-test-only; Path=/; HttpOnly');
      res.end('<h1>Login fixture</h1>');
      signedIn();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!req.headers.cookie?.includes('corp_session=local-test-only')) { res.end('<h1>Login required</h1>'); return; }
    res.end('<h1>Signed in corporate fixture</h1><label>Project<input id="project"></label><button onclick="document.getElementById(\'result\').textContent=\'Found \'+document.getElementById(\'project\').value">Search</button><p id="result" role="status"></p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let running;
  let connection;
  try {
    running = await launchBrowser(root, `${url}/login-fixture`);
    await Promise.race([initialPage, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser did not load login fixture')), 10000);
      initialPage.finally(() => clearTimeout(timer));
    })]);
    connection = await connect(root, { PLAYWRIGHT_MCP_CDP_ENDPOINT: running.endpoint });
    const call = async (name, args = {}) => {
      const result = text(await connection.client.callTool({ name, arguments: args }));
      const snapshot = result.match(/\[Snapshot\]\((.*)\)/);
      if (!snapshot) return result;
      // Newer Playwright returns a file link; pi's normal read tool reads this same file.
      assert.ok(resolve(snapshot[1]).startsWith(resolve(root) + sep));
      return result + '\n' + readFileSync(snapshot[1], 'utf8');
    };
    let snapshot = await call('browser_navigate', { url: `${url}/private` });
    assert.match(snapshot, /Signed in corporate fixture/);
    const input = snapshot.match(/textbox "Project" \[ref=([^\]]+)\]/);
    assert.ok(input, snapshot);
    await call('browser_fill_form', { fields: [{ name: 'Project', type: 'textbox', target: input[1], value: 'Project-A' }] });
    snapshot = await call('browser_snapshot');
    const button = snapshot.match(/button "Search" \[ref=([^\]]+)\]/);
    assert.ok(button, snapshot);
    await call('browser_click', { target: button[1] });
    snapshot = await call('browser_snapshot');
    assert.match(snapshot, /Found Project-A/);
    await connection.close();
    connection = undefined;
    // Disconnect must not close the user's existing Edge instance.
    assert.equal((await fetch(`${running.endpoint}/json/version`)).status, 200);
    console.log(`CDP browser verified: ${edge ? 'Microsoft Edge' : 'Google Chrome (macOS fallback)'}`);
  } finally {
    await connection?.close();
    await stopBrowser(running?.browser);
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
});
