// chat.mjs: discussion with Pak Prod before a run. Engines: claude (Claude Code: subscription or key),
// api (Messages API key), dry (canned replies, free, for trying the flow).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OFFICE, RUNS, PIPELINE, TEMPLATES } from '../orchestrator/lib/config.mjs';
import { runClaude, childEnv } from '../orchestrator/lib/claude.mjs';
import { appendLedger } from '../orchestrator/lib/events.mjs';

const CHATS = path.join(RUNS, '_chats');
const chatFile = (id) => path.join(CHATS, `${id}.json`);
const today = () => new Date().toISOString().slice(0, 10);

export function systemPrompt() {
  const base = fs.readFileSync(path.join(OFFICE, 'agents', 'office-producer-chat.md'), 'utf8');
  const ready = TEMPLATES.filter((t) => t.status === 'ready')
    .map((t) => `- ${t.id}: ${t.name} (${(t.kreator || ['openanstruk', 'aina']).join('/')}, ~$${t.estUSD}) ${t.uses ? '· ' + t.uses.join(', ') : ''}`).join('\n');
  const notReady = TEMPLATES.filter((t) => t.status !== 'ready' && !t.id.startsWith('opuscar:')).map((t) => `${t.id} (${t.status})`).join(', ');
  return `${base}\n\nToday is ${today()}.\n\nREADY templates:\n${ready}\n\nHouse templates that are not ready: ${notReady}. The 99 lemo-opuscar styles all need adapting first.`;
}

export function loadChat(id) {
  if (!/^[a-f0-9-]{8,40}$/.test(id || '')) return null;
  return fs.existsSync(chatFile(id)) ? JSON.parse(fs.readFileSync(chatFile(id), 'utf8')) : null;
}
function saveChat(c) { fs.mkdirSync(CHATS, { recursive: true }); fs.writeFileSync(chatFile(c.id), JSON.stringify(c, null, 2)); }
export function listChats() {
  if (!fs.existsSync(CHATS)) return [];
  return fs.readdirSync(CHATS).filter((f) => f.endsWith('.json')).map((f) => {
    try { const c = JSON.parse(fs.readFileSync(path.join(CHATS, f), 'utf8')); return { id: c.id, title: c.messages.find((m) => m.role === 'user')?.text.slice(0, 60) || '-', updatedAt: c.updatedAt, usd: c.usd }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function parseProposal(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const b of blocks.reverse()) {
    try {
      const j = JSON.parse(b[1]);
      const p = j.proposal || j;
      if (p && typeof p === 'object' && (p.topic || p.template)) {
        return {
          kreator: ['openanstruk', 'aina'].includes(p.kreator) ? p.kreator : 'openanstruk',
          topic: String(p.topic || '').slice(0, 120), slot: String(p.slot || ''), template: String(p.template || ''),
          notes: String(p.notes || '').slice(0, 600),
        };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

// ---------- engines ----------
async function claudeReply(chat, message, opts) {
  const sys = path.join(CHATS, 'producer-chat-system.md');
  fs.mkdirSync(CHATS, { recursive: true });
  fs.writeFileSync(sys, systemPrompt());
  const tools = PIPELINE.chat.tools.join(',');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', PIPELINE.models[PIPELINE.chat.model].cli,
    '--append-system-prompt-file', sys, '--tools', tools, '--allowedTools', tools, '--permission-mode', 'dontAsk',
    '--max-turns', '8', '--max-budget-usd', String(PIPELINE.chat.maxUSDPerMessage)];
  if (chat.sessionId) args.push('--resume', chat.sessionId);
  const cwd = fs.existsSync(opts.repo) ? opts.repo : OFFICE;
  const r = await runClaude({ args, input: message, cwd, env: childEnv(opts), timeoutMs: 5 * 60000, budgetUSD: PIPELINE.chat.maxUSDPerMessage * 1.5, price: PIPELINE.models[PIPELINE.chat.model] });
  if (!r.ok) throw new Error(r.auth ? `Claude Code is not logged in. Open a terminal, run "claude" once and log in. (${r.error})` : r.error);
  chat.sessionId = r.sessionId || chat.sessionId;
  return { text: r.text, usd: r.usd };
}

async function apiReply(chat, message) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (chat engine "api")');
  const m = PIPELINE.models[PIPELINE.chat.model];
  const messages = [...chat.messages.filter((x) => x.role === 'user' || x.role === 'assistant').map((x) => ({ role: x.role, content: x.text })), { role: 'user', content: message }];
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m.api, max_tokens: 1500, system: [{ type: 'text', text: systemPrompt() + '\n\n(You cannot read files in this mode.)', cache_control: { type: 'ephemeral' } }], messages }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `API error ${res.status}`);
  const u = j.usage;
  const usd = ((u.input_tokens || 0) * m.in + (u.output_tokens || 0) * m.out + (u.cache_read_input_tokens || 0) * m.read + (u.cache_creation_input_tokens || 0) * m.write) / 1e6;
  return { text: j.content.map((c) => c.text || '').join('\n'), usd };
}

function dryReply(chat, message) {
  const userTurns = chat.messages.filter((m) => m.role === 'user').length;
  const go = /\b(go|jalan|buat|ok|oke|gas|setuju|start)\b/i.test(message);
  if (userTurns === 0 && !go) {
    return { usd: 0, text: `(dry mode: Pak Prod is simulated, no tokens used)\n\nSiap. Saya tangkap topiknya: "${message.slice(0, 80)}". Dua pertanyaan:\n1. Untuk OpenAnstruk atau Aina?\n2. Slot tanggal berapa? Kalau belum ada, saya usulkan ${nextDay()}.\n\nBalas "ok" kalau mau langsung saya buatkan usulan.` };
  }
  const said = [...chat.messages.filter((m) => m.role === 'user').map((m) => m.text), message];
  const first = said[0];
  const aina = said.some((t) => /\baina\b/i.test(t)) && !said.some((t) => /openanstruk/i.test(t));
  const slot = said.map((t) => /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1]).filter(Boolean).pop() || nextDay();
  const p = { kreator: aina ? 'aina' : 'openanstruk', topic: first.replace(/\s+/g, ' ').slice(0, 80), slot, template: aina ? 'aina-reel-penuh' : 'kolase-browser', notes: 'Usulan dry mode. Ganti catatan ini dengan sudut, hook dan sumber yang disepakati.' };
  return { usd: 0, text: `(dry mode) Baik, ini usulan saya. Periksa, ubah kalau perlu, lalu tekan Start.\n\n\`\`\`json\n${JSON.stringify({ proposal: p })}\n\`\`\`` };
}
const nextDay = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

export async function chatTurn({ id, message, engine, repo, subscription }) {
  message = String(message || '').trim().slice(0, 4000);
  if (!message) throw new Error('Empty message');
  let chat = id ? loadChat(id) : null;
  if (!chat) chat = { id: crypto.randomUUID(), engine, sessionId: null, messages: [], usd: 0, createdAt: new Date().toISOString() };
  const fn = { claude: claudeReply, api: apiReply, dry: dryReply }[chat.engine] || dryReply;
  const r = await fn(chat, message, { repo, subscription });
  chat.messages.push({ role: 'user', text: message, at: new Date().toISOString() });
  const proposal = parseProposal(r.text);
  chat.messages.push({ role: 'assistant', text: r.text, at: new Date().toISOString(), usd: r.usd, proposal });
  chat.usd = +(chat.usd + (r.usd || 0)).toFixed(4);
  if (proposal) chat.proposal = proposal;
  chat.updatedAt = new Date().toISOString();
  saveChat(chat);
  if (r.usd) appendLedger({ kind: 'chat', chat: chat.id, engine: chat.engine, usd: +r.usd.toFixed(4) });
  return { chat, reply: r.text, proposal, usd: r.usd };
}
