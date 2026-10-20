// 파이프라인 검증용 가짜 OpenAI 호환 서버. 모델 품질 측정용이 아니다.
// steps: [{ tool, args }] 를 순서대로 도구 호출로 내보내고, 끝나면 final 텍스트로 종료한다.
import { createServer } from "node:http";

export function startFakeModel(steps, final = "FAKE_DONE") {
  let turn = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const step = steps[turn];
      const delta = step
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: "assistant", content: final };
      const reason = step ? "tool_calls" : "stop";
      turn++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [part, finish] of [[delta, null], [{}, reason]]) {
        const chunk = { id: `chatcmpl-${turn}`, object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: part, finish_reason: finish }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => server.close() })));
}

export function fakeModelsJson(port) {
  return { providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "offline-test", models: [{ id: "fake", name: "fake", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
}
