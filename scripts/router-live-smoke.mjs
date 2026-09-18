#!/usr/bin/env node
// Opt-in real Codex + Jev integration. Retains all outputs, including failed attempts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{root:{type:'string'},goal:{type:'string'},'key-file':{type:'string'},output:{type:'string'},baseline:{type:'boolean',default:false},offline:{type:'boolean',default:false}}});
assert.ok(values.root&&values.goal&&values['key-file']&&values.output,'Supply --root, --goal, --key-file and a new --output directory');
const output=path.resolve(values.output);await mkdir(output,{mode:0o700});
const root=path.resolve(values.root),audit=path.join(output,'router.jsonl');
const packageRoot=path.resolve(import.meta.dirname,'..');
assert.ok(!(values.offline&&values.baseline),'Choose either baseline or offline');
let keyFile=path.resolve(values['key-file']);
if(values.offline){keyFile=path.join(output,'offline.env');await writeFile(keyFile,'TYPESAFE_API_KEY=offline-test\nTYPESAFE_BASE_URL=http://127.0.0.1:1\n',{mode:0o600});}
const codexArgs=['exec','--ignore-user-config','--strict-config','--ephemeral','--json','--sandbox','read-only','-c','features.multi_agent=false','-c','project_doc_max_bytes=0','-c','web_search="disabled"',values.goal];
const command=values.baseline?'codex':process.execPath;
const args=values.baseline?codexArgs:[path.join(packageRoot,'dist/router-cli.js'),'--key-file',keyFile,'--audit',audit,'--',...codexArgs];
const start=performance.now();
const result=await new Promise(resolve=>{const child=execFile(command,args,{cwd:root,timeout:120000,maxBuffer:8000000},(error,stdout,stderr)=>resolve({error,stdout,stderr}));child.stdin.end();});
await writeFile(path.join(output,'events.jsonl'),result.stdout,{mode:0o600});
await writeFile(path.join(output,'stderr.txt'),result.stderr,{mode:0o600});
const events=result.stdout.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
const auditEvents=values.baseline?[]:(await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const selected=auditEvents.filter(e=>e.kind==='selected');
const commands=events.filter(e=>e.type==='item.completed'&&e.item.type==='command_execution').map(e=>({command:e.item.command,exitCode:e.item.exit_code}));
const summary={baseline:values.baseline,offline:values.offline,elapsedMs:Math.round(performance.now()-start),codexExitCode:result.error?(result.error.code??'process_error'):0,
  decisions:selected.length,jevInputTokens:selected.reduce((s,e)=>s+e.inputTokens,0),jevOutputTokens:selected.reduce((s,e)=>s+e.outputTokens,0),jevDecisionMs:selected.reduce((s,e)=>s+e.durationMs,0),
  upstreamResponseRequests:values.baseline?null:auditEvents.filter(e=>e.kind==='upstream'&&e.path==='/responses').length,
  firstDecisionBeforeUpstream:values.baseline?null:selected.length>0&&auditEvents.indexOf(selected[0])<auditEvents.findIndex(e=>e.kind==='upstream'&&e.path==='/responses'),
  commands,usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage),final:events.filter(e=>e.type==='item.completed'&&e.item.type==='agent_message').at(-1)?.item.text};
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({...summary,final:summary.final?.slice(0,1200)},null,2));
assert.equal(summary.codexExitCode,0,'Codex must complete');
assert.ok(summary.final,'Coding model must answer');
if(values.offline){
  assert.equal(summary.decisions,0,'Unavailable Jev must not fabricate decisions');
  assert.ok(auditEvents.some(e=>e.kind==='fallback'),'Outage must be recorded');
  assert.ok(commands.some(c=>c.exitCode===0),'Codex must still execute native tools');
}else if(!values.baseline){
  assert.ok(summary.decisions>0,'Jev must actually select a native call');
  assert.ok(summary.firstDecisionBeforeUpstream,'Jev must select before the coding model is invoked');
  assert.ok(commands.some(c=>c.exitCode===0&&c.command.includes("awk 'NR>160")),'Codex must execute the selected native read');
}
