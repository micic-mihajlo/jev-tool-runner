#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile, rename, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicJson, settingsSchema } from '../dist/hooks.js';
import { loadConfig } from '../dist/config.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, config: { type: 'string' }, 'key-file': { type: 'string' },
  verify: { type: 'string', default: '' }, timeout: { type: 'string', default: '15' },
} });
const mode = positionals[0];
async function optional(file, fallback) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
async function atomicText(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
const begin = '# BEGIN JEV TOOL RUNNER';
const end = '# END JEV TOOL RUNNER';
function removeBlock(text, block) {
  if (!block) return text;
  if (!text.includes(block)) throw new Error('The managed MCP block was edited. Preserve your changes and remove its BEGIN/END JEV section manually before reinstalling.');
  return text.replace(block, '');
}
function withoutOwnHooks(document, command) {
  if (!command) return document;
  for (const [event, groups] of Object.entries(document.hooks ?? {})) {
    document.hooks[event] = groups.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => hook.command !== command) })).filter((group) => group.hooks.length);
    if (!document.hooks[event].length) delete document.hooks[event];
  }
  return document;
}
async function main() {
  if (process.platform === 'win32') throw new Error('The integration installer currently supports macOS and Linux.');
  const root = await realpath(values.root);
  const codex = path.join(root, '.codex');
  const dir = path.join(codex, 'jev');
  const receiptFile = path.join(dir, 'installation.json');
  const settingsFile = path.join(dir, 'settings.json');
  const hookFile = path.join(codex, 'hooks.json');
  const configFile = path.join(codex, 'config.toml');
  const receipt = JSON.parse(await optional(receiptFile, 'null'));
  const originalHooks = await optional(hookFile, '{"hooks":{}}');
  const originalConfig = await optional(configFile, '');
  const hooks = JSON.parse(originalHooks);
  if (mode === 'doctor') {
    const settings = receipt ? settingsSchema.parse(JSON.parse(await readFile(settingsFile, 'utf8'))) : null;
    const checks = { installed: !!receipt, hookDefinitionsPresent: !!receipt && events.every(event => (hooks.hooks?.[event] ?? []).some(group => group.hooks.some(hook => hook.command === receipt.command))),
      mcpRegistrationPresent: !!receipt && originalConfig.includes(receipt.block), keyFileReadable: false, commandsValid: false, codexVersion: null, ripgrep: false,
      lastObservedHooks: [],
      hookTrust: 'Review /hooks in Codex. File presence does not prove hooks are trusted or active in an existing session.' };
    if (settings) {
      try { await access(settings.keyFile); checks.keyFileReadable = true; } catch {}
      try { const config = await loadConfig(settings.config); checks.commandsValid = settings.verifyCommandIds.every((id) => config.commands.some((cmd) => cmd.id === id)); } catch {}
    }
    try { checks.codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(); } catch {}
    try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); checks.ripgrep = true; } catch {}
    if (settings) {
      const names = await readdir(settings.stateDir).catch(() => []);
      checks.lastObservedHooks = (await Promise.all(names.filter(name => /\.(investigation|verification)\.json$/.test(name)).map(async name => {
        try { const value = JSON.parse(await readFile(path.join(settings.stateDir, name), 'utf8')); return { phase: name.includes('.investigation.') ? 'investigation' : 'verification', at: value.at, status: value.status, metrics: value.metrics, checks: value.checks }; } catch { return null; }
      }))).filter(value => value && (!receipt.installedAt || value.at >= receipt.installedAt)).sort((a,b) => b.at.localeCompare(a.at)).slice(0, 5);
    }
    console.log(JSON.stringify(checks, null, 2));
    if (!checks.installed || !checks.hookDefinitionsPresent || !checks.mcpRegistrationPresent || !checks.keyFileReadable || !checks.commandsValid || !checks.codexVersion || !checks.ripgrep) process.exitCode = 1;
    return;
  }
  if (mode === 'uninstall') {
    if (!receipt) { console.log('No Jev installation in this project.'); return; }
    const config = removeBlock(originalConfig, receipt.block);
    withoutOwnHooks(hooks, receipt.command);
    await atomicJson(hookFile, hooks);
    await atomicText(configFile, config);
    await rm(receiptFile);
    console.log('Removed Jev hook handlers and MCP registration. Other hooks/config, private settings and run evidence were preserved. Restart the Codex session.');
    return;
  }
  if (!values.config || !values['key-file']) throw new Error('Install requires --config and --key-file. Keys are never copied into the project.');
  const settings = settingsSchema.parse({ version: 1, root, config: await realpath(values.config), keyFile: await realpath(values['key-file']),
    stateDir: path.join(dir, 'state'), verifyCommandIds: values.verify.split(',').filter(Boolean), timeoutMs: Number(values.timeout) * 1000, maxSteps: 6 });
  const configured = await loadConfig(settings.config);
  if (new Set(settings.verifyCommandIds).size !== settings.verifyCommandIds.length || settings.verifyCommandIds.length > configured.maxSteps
    || settings.verifyCommandIds.some((id) => !configured.commands.some((cmd) => cmd.id === id))) throw new Error('Verification IDs must be unique configured commands within the step budget.');
  await access(path.join(packageRoot, 'dist/hook-cli.js'));
  execFileSync('rg', ['--version'], { stdio: 'ignore' });
  let config = removeBlock(originalConfig, receipt?.block);
  if (parseToml(config).mcp_servers?.jev_tools) throw new Error('An existing jev_tools MCP registration is not managed by this installer. Remove or rename it first.');
  let nodeCommand = process.execPath;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'node');
    try { if (await realpath(candidate) === await realpath(process.execPath)) { nodeCommand = candidate; break; } } catch {}
  }
  const command = `${quote(nodeCommand)} ${quote(path.join(packageRoot, 'dist/hook-cli.js'))} --settings ${quote(settingsFile)}`;
  withoutOwnHooks(hooks, receipt?.command);
  hooks.hooks ??= {};
  for (const event of events) {
    const timeout = event === 'UserPromptSubmit' ? Math.ceil(settings.timeoutMs / 1000) + 15 : event === 'Stop' ? Math.ceil(configured.timeoutMs / 1000) + 15 : ['Interrupt', 'SessionEnd'].includes(event) ? 3 : 15;
    const handler = { type: 'command', command, timeout, statusMessage: `Jev: ${event}`,
      ...(['SessionStart', 'UserPromptSubmit'].includes(event) ? { additionalContextLimit: 6000 } : {}) };
    (hooks.hooks[event] ??= []).push({ ...(event === 'PreToolUse' ? { matcher: '^Bash$' } : event === 'PostToolUse' ? { matcher: '^apply_patch$|^Edit$|^Write$' } : {}), hooks: [handler] });
  }
  const args = [`--env-file=${settings.keyFile}`, path.join(packageRoot, 'dist/cli.js'), 'serve', '--root', root, '--config', settings.config];
  const block = `\n${begin}\n[mcp_servers.jev_tools]\ncommand = ${JSON.stringify(nodeCommand)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 15\ntool_timeout_sec = ${Math.ceil(configured.timeoutMs / 1000) + 30}\nenabled_tools = ["run_tools"]\n${end}\n`;
  parseToml(config + block); // Validate the combined document before changing any project files.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!receipt) {
    await writeFile(path.join(dir, 'hooks.before.json'), originalHooks, { mode: 0o600, flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
    await writeFile(path.join(dir, 'config.before.toml'), originalConfig, { mode: 0o600, flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  }
  await atomicJson(settingsFile, settings);
  await atomicJson(hookFile, hooks);
  await atomicText(configFile, config + block);
  await atomicJson(receiptFile, { command, block, installedAt: new Date().toISOString() });
  // Prevent accidental publication in target repositories without changing their shared ignore policy.
  try {
    const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8' }).trim();
    const excludePath = path.resolve(root, exclude);
    const previous = await optional(excludePath, '');
    const relative = path.relative(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim(), codex).split(path.sep).join('/');
    const line = `/${relative}/`;
    if (!previous.split('\n').includes(line)) await writeFile(excludePath, previous + '\n' + line + '\n');
  } catch { console.warn('Ensure .codex/ is ignored before committing this project.'); }
  console.log(JSON.stringify({ installed: root, hooks: hookFile, verification: settings.verifyCommandIds,
    next: 'Open a new trusted Codex session in this project, run /hooks, and review/trust these exact hook definitions. No trust or sandbox bypass was installed. Existing sessions must be restarted.',
    data: 'Automatic investigation sends selected repository content to TypeSafe. Configured verification runs locally at Stop after detected edits. Private state stays in .codex/jev/state.' }, null, 2));
}

if (!['install', 'doctor', 'uninstall'].includes(mode) || !values.root) {
  console.log('Usage: node scripts/codex-integration.mjs install --root PROJECT --config COMMANDS.json --key-file PRIVATE.env [--verify tests,typecheck] [--timeout 15]\n       node scripts/codex-integration.mjs doctor|uninstall --root PROJECT');
  process.exitCode = 1;
} else {
  await main();
}
