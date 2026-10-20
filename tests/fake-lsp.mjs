import { stdin, stdout } from 'node:process';
const mode = process.argv[2] ?? 'push';
let buffer = Buffer.alloc(0), document, checks = 0;
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  // Deliberately split UTF-8 framing across chunks.
  stdout.write(header.subarray(0, 7)); stdout.write(header.subarray(7));
  stdout.write(body.subarray(0, 3)); stdout.write(body.subarray(3));
}
const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: '오류: undefined identifier' };
function publish(version) {
  if (mode === 'silent' || mode === 'pull') return;
  // Obsolete errors must never replace the current version's diagnostics.
  send({ method: 'textDocument/publishDiagnostics', params: { uri: document.uri, version: version - 1, diagnostics: [diagnostic] } });
  setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: { uri: document.uri, version, diagnostics: document.text.includes('broken') ? [diagnostic] : [] } }), 15);
}
function onMessage(message) {
  if (message.method === undefined) {
    if (message.id === 'config' && message.result?.[0]?.enabled === true && message.result?.[1] === null) checks++;
    if (message.id === 'unknown' && message.error?.code === -32601) checks++;
    if (message.id === 'edit' && message.result?.applied === false) checks++;
    return;
  }
  const reply = result => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': reply({ capabilities: { positionEncoding: 'utf-16', textDocumentSync: 2, ...(mode === 'pull' ? { diagnosticProvider: { identifier: 'fake' } } : {}) } }); break;
    case 'initialized':
      send({ id: 'config', method: 'workspace/configuration', params: { items: [{ section: 'test' }, { section: 'missing' }] } });
      send({ id: 'unknown', method: 'notSupported', params: {} });
      send({ id: 'edit', method: 'workspace/applyEdit', params: {} }); break;
    case 'textDocument/didOpen': document = message.params.textDocument; publish(document.version); break;
    case 'textDocument/didChange': document = { ...message.params.textDocument, text: message.params.contentChanges[0].text }; publish(document.version); break;
    case 'textDocument/diagnostic': reply({ kind: 'full', items: document.text.includes('broken') ? [diagnostic] : [] }); break;
    case 'test/status': reply({ checks, cwd: process.cwd() }); break;
    case 'test/hang': break;
    case 'shutdown': reply(null); break;
    case 'exit': process.exit(0); break;
    default: if (message.id !== undefined) reply(null);
  }
}
stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const body = buffer.subarray(end + 4, end + 4 + size); buffer = buffer.subarray(end + 4 + size);
    onMessage(JSON.parse(body));
  }
});
