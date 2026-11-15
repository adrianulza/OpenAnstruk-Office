#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, used by the tests.
// Behaviour comes from FAKE_CLAUDE (JSON): { "default": {...}, "<task id>": {...} }
//   cost     USD reported in the result (default 0.1)
//   verdict  PASS | BLOCK | NONE (for gate steps)   ready  yes | no
//   write    false to skip writing the required files
//   error    make the result an error with this text (e.g. "Not logged in · Please run /login")
//   video    path (relative to cwd) of an mp4 to create (ops render fallback)
//   usage    output tokens to report in an assistant message (for the live budget kill)
//   sleep    ms to wait before answering
// Every call's argv is appended to FAKE_CLAUDE_LOG.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: claude [options]\n  -p, --print\n  --max-budget-usd <amount>\n  --effort <level>\n  --append-system-prompt-file <file>\n  --tools <tools...>');
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\n');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const conf = JSON.parse(process.env.FAKE_CLAUDE || '{}');
  const task = /Your task: ([\w-]+)\./.exec(input)?.[1] || 'chat';
  const b = { cost: 0.1, verdict: 'PASS', ready: 'yes', write: true, ...(conf.default || {}), ...(conf[task] || {}) };
  if (b.sleep) await new Promise((r) => setTimeout(r, b.sleep));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake' });

  const files = (/Write these files \(required[^)]*\): (.+)/.exec(input)?.[1] || '').split(', ').filter(Boolean);
  if (b.write) for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, f.endsWith('.json') ? '{"scenes":[]}' : `# ${task}\nfake content\n`); }
  if (b.video) { fs.mkdirSync(path.dirname(path.resolve(b.video)), { recursive: true }); fs.writeFileSync(b.video, 'fake mp4'); }
  out({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: b.usage || 10 }, content: [{ type: 'tool_use', name: 'Write', input: { file_path: files[0] || 'x' } }] } });
  if (b.usage) { await new Promise((r) => setTimeout(r, 3000)); }

  let text = `Kerja ${task} selesai.`;
  if (/READY:/.test(input)) text += `\nREADY: ${b.ready}`;
  if (/VERDICT:/.test(input) && b.verdict !== 'NONE') text += `\nVERDICT: ${b.verdict}${b.verdict === 'BLOCK' ? ' angka tanpa sumber' : ''}`;
  if (task === 'chat') text = conf.chatReply || 'Siap. Usulan:\n```json\n{"proposal":{"kreator":"openanstruk","topic":"Gempa kecil","slot":"2026-11-20","template":"kolase-browser","notes":""}}\n```';
  if (b.video) text += `\nVideo: ${b.video}`;
  text += `\nSUMMARY: ${task} oke`;
  out({ type: 'result', subtype: 'success', is_error: !!b.error, result: b.error || text, total_cost_usd: b.cost, session_id: 'fake-session', usage: { input_tokens: 10, output_tokens: 10 } });
});
