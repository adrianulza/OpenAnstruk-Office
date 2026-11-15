// claude.mjs: run Claude Code headless (`claude -p`) safely on every platform.
// - No shell: the prompt goes in via stdin and the system prompt via a file, so quotes, &, | or
//   newlines in a topic can never break or inject into the command (Windows cmd.exe included).
// - stream-json: tool calls become live office events; usage is priced as it streams, and the
//   process is killed if a step goes over its dollar budget (on top of --max-budget-usd).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Returns [command, ...prefixArgs] for spawning without a shell.
export function resolveClaude() {
  if (process.env.OFFICE_CLAUDE_CMD) return JSON.parse(process.env.OFFICE_CLAUDE_CMD);
  if (process.platform !== 'win32') return ['claude'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (fs.existsSync(exe)) return [exe];
  }
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'claude.cmd'))) continue;
    // npm global shim: claude.cmd -> node_modules/@anthropic-ai/claude-code/bin/claude.exe (or cli.js on old versions)
    const pkg = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code');
    const exe = path.join(pkg, 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return [exe];
    const js = path.join(pkg, 'cli.js');
    if (fs.existsSync(js)) return [process.execPath, js];
  }
  return ['claude.exe'];
}

let helpCache = null;
export function claudeHelp() {
  if (helpCache !== null) return helpCache;
  const [cmd, ...pre] = resolveClaude();
  const r = spawnSync(cmd, [...pre, '--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  helpCache = r.error ? '' : `${r.stdout || ''}${r.stderr || ''}`;
  return helpCache;
}
export const claudeInstalled = () => claudeHelp().includes('--print');
export const supports = (flag) => claudeHelp().includes(flag);

export function childEnv({ subscription } = {}) {
  const env = { ...process.env };
  if (subscription) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  return env;
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
}

const priceUsage = (m, u) => !m ? 0 : ((u.input_tokens || 0) * m.in + (u.output_tokens || 0) * m.out + (u.cache_read_input_tokens || 0) * m.read + (u.cache_creation_input_tokens || 0) * m.write) / 1e6;

function describeTool(b) {
  const i = b.input || {};
  const what = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || '';
  return `${b.name}${what ? ': ' + String(what).replace(/\s+/g, ' ') : ''}`.slice(0, 90);
}

/**
 * Runs one headless Claude Code call.
 * opts: { args, input, cwd, env, timeoutMs, budgetUSD, price, onTool(summary), onText(summary), onSpawn(child) }
 * resolves: { ok, text, usd, usage, sessionId, error, killed }
 */
export function runClaude(opts) {
  const [cmd, ...pre] = resolveClaude();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [...pre, ...opts.args], { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, error: `cannot start claude: ${e.message}`, usd: 0, usage: {}, text: '' }); return; }
    opts.onSpawn?.(child);
    let buf = '', stderr = '', result = null, liveUSD = 0, killed = null, lastTool = 0, lastText = 0;
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const seen = new Set();
    const timer = setTimeout(() => { killed = 'timeout'; killTree(child); }, opts.timeoutMs || 30 * 60000);

    const handle = (msg) => {
      if (msg.type === 'assistant' && msg.message) {
        const m = msg.message;
        if (m.usage && m.id && !seen.has(m.id)) {
          seen.add(m.id);
          for (const k of Object.keys(usage)) usage[k] += m.usage[k] || 0;
          liveUSD = priceUsage(opts.price, usage);
          if (opts.budgetUSD && liveUSD > opts.budgetUSD && !killed) { killed = 'budget'; killTree(child); }
        }
        for (const b of m.content || []) {
          const now = Date.now();
          if (b.type === 'tool_use' && now - lastTool > 1500) { lastTool = now; opts.onTool?.(describeTool(b)); }
          if (b.type === 'text' && b.text && now - lastText > 4000) { lastText = now; opts.onText?.(b.text.split('\n').find((l) => l.trim()) || ''); }
        }
      } else if (msg.type === 'result') result = msg;
    };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* non-JSON noise */ }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch { /* ignore */ } }
      const u = result?.usage || usage;
      const usd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : liveUSD;
      const out = {
        text: result?.result || '', usd, sessionId: result?.session_id, killed,
        usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 },
      };
      if (killed === 'timeout') return resolve({ ...out, ok: false, error: 'step timed out' });
      if (killed === 'budget') return resolve({ ...out, ok: false, error: `step went over its budget ($${opts.budgetUSD.toFixed(2)})` });
      if (!result) return resolve({ ...out, ok: false, error: `claude exited (${code}) without a result. ${stderr.trim().split('\n').pop() || ''}`.trim() });
      // Claude Code can exit 0 with is_error (e.g. "Not logged in"), so check both.
      if (result.is_error || (result.subtype && result.subtype !== 'success')) {
        const why = result.result || result.subtype || 'error';
        return resolve({ ...out, ok: false, error: String(why).slice(0, 200), auth: /log ?in|login|auth|api key/i.test(why), budget: /budget/i.test(result.subtype || '') });
      }
      resolve({ ...out, ok: true });
    });
    child.stdin.on('error', () => { /* process died early; close handler reports it */ });
    child.stdin.end(opts.input || '');
  });
}
