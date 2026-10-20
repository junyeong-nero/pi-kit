import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

// CI also runs this against the extracted ZIP in a path containing spaces and Korean.
const bundle = resolve(process.env.USAGE_TEST_BUNDLE || '.');
const extensionPath = join(bundle, 'vendor/extensions/node_modules/@tian.zuo/pi-usage/index.ts');

async function withTracker(run) {
  const root = mkdtempSync(join(tmpdir(), 'pi usage 사내 모델 '));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'config');
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  let loaded;
  const notifications = [];
  const context = {
    mode: 'json', hasUI: false, cwd: root,
    model: { provider: 'corp', id: 'internal-coding-model' },
    ui: {
      notify: (message) => notifications.push(message),
      setStatus: () => {},
    },
  };
  try {
    const result = await loadExtensions([extensionPath], root);
    assert.deepEqual(result.errors, []);
    [loaded] = result.extensions;
    assert.ok(loaded.commands.has('tokens'));
    await run({ root, loaded, context, notifications });
  } finally {
    for (const shutdown of loaded?.handlers.get('session_shutdown') ?? []) {
      await shutdown({ type: 'session_shutdown' }, context);
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function localCompletion(withUsage) {
  let request;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer local-test-only');
      let body = '';
      for await (const chunk of req) body += chunk;
      request = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (choices, extra = {}) => ({
        id: 'chatcmpl-corp-test', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'internal-coding-model', choices, ...extra,
      });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send(chunk([{ index: 0, delta: { role: 'assistant', content: 'local model response' }, finish_reason: null }]));
      send(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
      if (withUsage) send(chunk([], { usage: {
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 10 },
      } }));
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const model = {
      id: 'internal-coding-model', name: '사내 코딩 모델', provider: 'corp',
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const user = { role: 'user', content: 'hello', timestamp: Date.now() };
    const response = await streamSimple(model, normalizeContext({ messages: [user] }), {
      apiKey: 'local-test-only', timeoutMs: 5000,
    }).result();
    assert.notEqual(response.stopReason, 'error', response.errorMessage);
    assert.equal(request.model, model.id);
    assert.equal(request.stream_options.include_usage, true);
    return { model, user, response };
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

for (const withUsage of [true, false]) {
  test(`corp model SSE → pi session → /tokens (${withUsage ? 'usage supplied' : 'usage omitted'})`, { timeout: 30000 }, async () => {
    const completion = await localCompletion(withUsage);
    assert.equal(completion.response.provider, 'corp');
    assert.deepEqual({
      input: completion.response.usage.input,
      output: completion.response.usage.output,
      cacheRead: completion.response.usage.cacheRead,
      total: completion.response.usage.totalTokens,
    }, withUsage ? { input: 90, output: 20, cacheRead: 10, total: 120 } : { input: 0, output: 0, cacheRead: 0, total: 0 });
    await withTracker(async ({ root, loaded, context, notifications }) => {
      const sessions = join(process.env.PI_CODING_AGENT_DIR, 'sessions', 'corp-project');
      const manager = SessionManager.create(root, sessions);
      manager.appendMessage(completion.user);
      manager.appendMessage(completion.response);
      // Forked/replayed copies must not double-count the same entry ids.
      copyFileSync(manager.getSessionFile(), join(sessions, 'replayed.jsonl'));
      const originalFetch = globalThis.fetch;
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; throw new Error('External network forbidden'); };
      try {
        context.model = completion.model;
        for (const event of ['session_start', 'model_select', 'turn_start']) {
          for (const handler of loaded.handlers.get(event) ?? []) await handler({ type: event }, context);
        }
        await loaded.commands.get('tokens').handler('', context);
        assert.equal(fetches, 0, 'corp hooks and /tokens must not query provider endpoints');
      } finally { globalThis.fetch = originalFetch; }
      const text = notifications.join('\n');
      for (const label of ['Today', 'Last 7 days', 'Last 30 days', 'Month to date']) {
        assert.ok(text.includes(`${label}: ${withUsage ? 120 : 0} tokens · $0 · 1 requests`), text);
      }
      // Zero cost is expected from the zero-price corporate model, not a quota balance.
      assert.equal(completion.response.usage.cost.total, 0);
    });
  });
}
