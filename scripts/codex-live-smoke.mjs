#!/usr/bin/env node
// Explicit opt-in: a real Codex session plus the TypeSafe API on a disposable fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { redact } from '../dist/config.js';
const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { 'key-file': { type:'string' }, output: {type:'string'}, offline: {type:'boolean',default:false} } });
assert.ok(values['key-file'] && values.output, 'Provide --key-file and a new --output directory.');
const output = path.resolve(values.output);
await mkdir(output, {recursive:false,mode:0o700});
const root = path.join(output,'fixture');
await cp(path.join(packageRoot,'examples/membership-repo'),root,{recursive:true});
await exec('git',['init','-q'],{cwd:root});
await writeFile(path.join(root,'.gitignore'),'.codex/\n');
const keyFile = path.resolve(values['key-file']);
process.loadEnvFile(keyFile);
let effectiveKey = keyFile;
if (values.offline) {
  effectiveKey=path.join(output,'offline.env');
  await writeFile(effectiveKey,'TYPESAFE_API_KEY=offline-test\nTYPESAFE_BASE_URL=http://127.0.0.1:1\n',{mode:0o600});
}
await exec(process.execPath,[path.join(packageRoot,'scripts/codex-integration.mjs'),'install','--root',root,'--config',path.join(packageRoot,'examples/demo-tools.json'),'--key-file',effectiveKey,'--verify','membership-tests']);
const args=['exec','--ignore-user-config','--strict-config','--ephemeral','--skip-git-repo-check','--dangerously-bypass-hook-trust','--json','--color','never','--sandbox','workspace-write',
  '-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c',`projects.${JSON.stringify(root)}.trust_level="trusted"`,'-c','web_search="disabled"','-c','features.multi_agent=false','-'];
const toml = value => Array.isArray(value) ? `[${value.map(toml).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)}=${toml(item)}`).join(',')}}` : JSON.stringify(value);
const hookConfig=JSON.parse(await readFile(path.join(root,'.codex','hooks.json'),'utf8'));
// --ignore-user-config skips file configuration in this CLI build; supply the vetted fixture hooks explicitly.
args.splice(args.length-1,0,'-c',`hooks=${toml(hookConfig.hooks)}`);
const prompt='Fix src/access.mjs so only memberships with status active can receive messages. Preserve tests. Use the automatic Jev evidence if available. Do not run test commands yourself: the installed Stop hook runs membership-tests. Explain the change briefly.';
const env={...process.env};
for(const key of ['TYPESAFE_API_KEY','TYPESAFE_BASE_URL','TYPESAFE_MODEL'])delete env[key];
const started=performance.now();
// Only this disposable harness skips hook trust: it installs and vets its own definitions.
const result=await new Promise((resolve,reject)=>{
  const child=execFile('codex',args,{cwd:root,env,timeout:180000,maxBuffer:8000000},(error,stdout,stderr)=>resolve({error,stdout,stderr}));
  child.stdin.end(prompt);
});
await writeFile(path.join(output,'events.jsonl'),redact(result.stdout),{mode:0o600});
await writeFile(path.join(output,'stderr.txt'),redact(result.stderr),{mode:0o600});
const stateDir=path.join(root,'.codex','jev','state');
const names=await readdir(stateDir).catch(()=>[]);
const investigations=await Promise.all(names.filter(x=>x.endsWith('.investigation.json')).map(async x=>JSON.parse(await readFile(path.join(stateDir,x),'utf8'))));
const verifications=await Promise.all(names.filter(x=>x.endsWith('.verification.json')).map(async x=>JSON.parse(await readFile(path.join(stateDir,x),'utf8'))));
const finalSource=await readFile(path.join(root,'src/access.mjs'),'utf8');
const events=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
const summary={elapsedMs:Math.round(performance.now()-started),offline:values.offline,codexExitCode:result.error?.code??0,investigations,verifications,
  turnUsage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage),sourceChanged:finalSource.includes('active')};
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
console.log(JSON.stringify(summary,null,2));
assert.equal(summary.codexExitCode,0,'Codex session must complete');
assert.ok(investigations.length,'UserPromptSubmit must actually fire');
assert.ok(values.offline ? investigations.some(x=>x.status==='error') : investigations.some(x=>x.metrics.toolCalls>0),'Expected real investigation or explicit provider outage');
assert.ok(verifications.some(x=>x.checks.some(check=>check.id==='membership-tests'&&check.exitCode===0)),'Stop must actually verify the edited fixture');
await exec(process.execPath,['--test','test/access.test.mjs'],{cwd:root});
