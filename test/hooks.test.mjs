import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { handleHook, sessionFile } from '../dist/hooks.js';
const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-hooks-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await cp(path.join(packageRoot,'examples/membership-repo'),root,{recursive:true});
  await mkdir(path.join(root,'.codex'));
  const config = path.join(root,'.codex','tools.json');
  await cp(path.join(packageRoot,'examples/demo-tools.json'),config);
  const settings = {version:1, root, config, keyFile:path.join(root,'.env'),stateDir:path.join(root,'.codex','state'),verifyCommandIds:['membership-tests'],timeoutMs:1000,maxSteps:4};
  await writeFile(settings.keyFile,'TYPESAFE_API_KEY=test-placeholder\n');
  const event = (kind,extra={})=>({hook_event_name:kind,session_id:'session-one',turn_id:'turn-one',cwd:root,...extra});
  let calls=0;
  const decider={decide:async(input)=>{
    calls++;
    const action=input.actions.find(x=>x.tool==='read_file'&&x.args.path==='src/access.mjs');
    return {choice:input.observations.length?'request_coding_agent':action.id,confidence:1,probabilities:{},model:'contract',durationMs:0,inputTokens:10,outputTokens:1};
  }};
  const run=(kind,extra={})=>handleHook(settings,event(kind,extra),{decider});
  return {root,settings,event,run,decider,calls:()=>calls};
}

test('prompt hook collects actual source, never runs commands, and suppresses duplicate delivery',async t=>{
  const f=await fixture(t);
  const result=await f.run('UserPromptSubmit',{prompt:'Inspect membership access'});
  assert.match(result.hookSpecificOutput.additionalContext,/membership !== null/);
  assert.equal(f.calls(),2);
  assert.deepEqual(await f.run('UserPromptSubmit',{prompt:'Inspect membership access'}),{});
  assert.equal(f.calls(),2);
  const state=JSON.parse(await readFile(sessionFile(f.settings,'session-one')+'.json','utf8'));
  assert.equal(state.evidence.some(x=>x.action.tool==='run_command'),false);
});

test('exact duplicate read is blocked once, changed files and compound commands remain available',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Inspect membership'});
  const tool={tool_name:'Bash',tool_input:{command:'cat src/access.mjs'}};
  assert.equal((await f.run('PreToolUse',tool)).hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(await f.run('PreToolUse',tool),{});
  assert.deepEqual(await f.run('PreToolUse',{tool_name:'Bash',tool_input:{command:'cat src/access.mjs && echo next'}}),{});
  await writeFile(path.join(f.root,'src/access.mjs'),'export const updated = true;\n');
  assert.deepEqual(await f.run('PreToolUse',{...tool,tool_input:{command:'cat ./src/access.mjs'}}),{});
});

test('Stop batches real verification after an edit and subsequent Stop does not rerun it',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Fix membership'});
  await writeFile(path.join(f.root,'src/access.mjs'),'export function canReceiveMessages(membership) { return membership?.status === "active"; }\n');
  await f.run('PostToolUse',{tool_name:'apply_patch'});
  const result=await f.run('Stop');
  assert.match(result.systemMessage,/verification passed.*exit 0/);
  assert.deepEqual(await f.run('Stop'),{});
  assert.equal(f.calls(),2);
  const summary=JSON.parse(await readFile(sessionFile(f.settings,'session-one')+'.verification.json','utf8'));
  assert.equal(summary.metrics.decisionCalls,0);
  assert.equal(summary.checks[0].exitCode,0);
});

test('failed verification supplies real failure evidence and does not loop unchanged',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Fix membership'});
  await writeFile(path.join(f.root,'src/access.mjs'),'export function canReceiveMessages() { return true; }\n');
  await f.run('PostToolUse',{tool_name:'apply_patch'});
  const result=await f.run('Stop');
  assert.equal(result.decision,'block');
  assert.match(result.reason,/exit 1/);
  assert.deepEqual(await f.run('Stop',{stop_hook_active:true}),{});
});

test('provider failure is visible and native tools remain available',async t=>{
  const f=await fixture(t);
  const result=await handleHook(f.settings,f.event('UserPromptSubmit',{prompt:'Inspect membership'}),{decider:{decide:async()=>{throw new Error('provider offline')}}});
  assert.match(result.systemMessage,/degraded mode/);
  assert.deepEqual(await f.run('PreToolUse',{tool_name:'Bash',tool_input:{command:'cat src/access.mjs'}}),{});
});

test('interruption cancels an in-flight decision and releases the session lock',async t=>{
  const f=await fixture(t);
  let ready;
  const started=new Promise(resolve=>{ready=resolve});
  const pending=handleHook(f.settings,f.event('UserPromptSubmit',{prompt:'Inspect membership'}),{decider:{decide:async(_,signal)=>{
    ready();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}});
  await started;
  await f.run('Interrupt');
  await assert.rejects(pending,/interrupted/);
  assert.equal((await readdir(f.settings.stateDir)).some(name=>name.endsWith('.lock')),false);
});

test('sessions, turns and workspace roots cannot consume each other’s evidence',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Inspect membership'});
  const tool={tool_name:'Bash',tool_input:{command:'cat src/access.mjs'}};
  assert.deepEqual(await f.run('PreToolUse',{...tool,session_id:'different'}),{});
  assert.deepEqual(await f.run('PreToolUse',{...tool,turn_id:'different'}),{});
  assert.deepEqual(await f.run('PreToolUse',{...tool,cwd:path.dirname(f.root)}),{});
});

test('installer is repeatable, doctor checks setup, uninstall preserves unrelated hooks and config',async t=>{
  const f=await fixture(t);
  const hookFile=path.join(f.root,'.codex','hooks.json');
  const configFile=path.join(f.root,'.codex','config.toml');
  await writeFile(hookFile,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo unrelated'}]}]}}));
  await writeFile(configFile,'model_reasoning_effort = "medium"\n');
  const command=path.join(packageRoot,'scripts/codex-integration.mjs');
  const args=[command,'install','--root',f.root,'--config',f.settings.config,'--key-file',f.settings.keyFile,'--verify','membership-tests'];
  await exec(process.execPath,args);
  await exec(process.execPath,args);
  const hooks=JSON.parse(await readFile(hookFile,'utf8'));
  assert.equal(hooks.hooks.UserPromptSubmit.length,1);
  assert.equal(hooks.hooks.Stop.length,2);
  const doctor=JSON.parse((await exec(process.execPath,[command,'doctor','--root',f.root]).catch(error=>({stdout:error.stdout}))).stdout);
  assert.equal(doctor.hookDefinitionsPresent,true);
  assert.equal(doctor.commandsValid,true);
  delete hooks.hooks.UserPromptSubmit;
  await writeFile(hookFile,JSON.stringify(hooks));
  const partial=await exec(process.execPath,[command,'doctor','--root',f.root]).catch(error=>({stdout:error.stdout}));
  assert.equal(JSON.parse(partial.stdout).hookDefinitionsPresent,false);
  await exec(process.execPath,[command,'uninstall','--root',f.root]);
  assert.equal(await readFile(configFile,'utf8'),'model_reasoning_effort = "medium"\n');
  assert.deepEqual(JSON.parse(await readFile(hookFile,'utf8')),{hooks:{Stop:[{hooks:[{type:'command',command:'echo unrelated'}]}]}});
});

test('installer refuses unmanaged MCP collisions without changing hook configuration',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'.codex','config.toml'),'mcp_servers = { jev_tools = { command = "existing" } }\n');
  await assert.rejects(exec(process.execPath,[path.join(packageRoot,'scripts/codex-integration.mjs'),'install','--root',f.root,'--config',f.settings.config,'--key-file',f.settings.keyFile]),/not managed/);
  await assert.rejects(readFile(path.join(f.root,'.codex','hooks.json')),/ENOENT/);
});

test('evidence collected across a concurrent edit is withheld',async t=>{
  const f=await fixture(t);
  let calls=0;
  const decider={decide:async(input,signal)=>{
    calls++;
    if(calls===2)await writeFile(path.join(f.root,'src/access.mjs'),'export const changedConcurrently = true;\n');
    return f.decider.decide(input,signal);
  }};
  const result=await handleHook(f.settings,f.event('UserPromptSubmit',{prompt:'Inspect membership'}),{decider});
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext,/membership !== null/);
  const state=JSON.parse(await readFile(sessionFile(f.settings,'session-one')+'.json','utf8'));
  assert.deepEqual(state.evidence,[]);
});

test('a provider timeout ends the investigation and reports degraded operation',async t=>{
  const f=await fixture(t);
  const result=await handleHook(f.settings,f.event('UserPromptSubmit',{prompt:'Inspect membership'}),{decider:{decide:async(_,signal)=>{
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}});
  assert.match(result.systemMessage,/degraded mode/);
  assert.match(result.hookSpecificOutput.additionalContext,/time_limit/);
});

test('partial source evidence never blocks a complete native read',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'src/access.mjs'),Array.from({length:200},(_,i)=>`// source line ${i}`).join('\n'));
  await f.run('UserPromptSubmit',{prompt:'Inspect membership'});
  assert.deepEqual(await f.run('PreToolUse',{tool_name:'Bash',tool_input:{command:'cat src/access.mjs'}}),{});
});

test('changed command configuration invalidates cached checks and reruns verification',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Fix membership'});
  await writeFile(path.join(f.root,'src/access.mjs'),'export function canReceiveMessages(membership) { return membership?.status === "active"; }\n');
  await f.run('PostToolUse',{tool_name:'apply_patch'});
  assert.match((await f.run('Stop')).systemMessage,/passed/);
  const config=JSON.parse(await readFile(f.settings.config,'utf8'));
  config.commands[0].argv=['node','-e','process.exit(7)'];
  await writeFile(f.settings.config,JSON.stringify(config));
  assert.deepEqual(await f.run('PreToolUse',{tool_name:'Bash',tool_input:{command:'node -e "process.exit(7)"'}}),{});
  assert.match((await f.run('Stop')).systemMessage,/FAILED OR INCOMPLETE.*exit 7/);
});

test('external edits do not run verification in a read-only Codex task',async t=>{
  const f=await fixture(t);
  await f.run('UserPromptSubmit',{prompt:'Explain membership access without editing or running tests'});
  await writeFile(path.join(f.root,'src/access.mjs'),'// Another task changed this file.\n');
  assert.deepEqual(await f.run('Stop'),{});
  await assert.rejects(readFile(sessionFile(f.settings,'session-one')+'.verification.json'),/ENOENT/);
});
