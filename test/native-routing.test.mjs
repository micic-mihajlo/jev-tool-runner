import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { routingInput } from '../dist/native-routing.js';
import { startRouter, toolResponse } from '../dist/router-server.js';

const tool = {type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}};
const request = (goal='Read src/one.ts and src/two.ts to explain the behavior.') => ({stream:true,tools:[tool],input:[{type:'message',role:'user',content:[{type:'input_text',text:goal}]}]});
const key='test-only-private-router-token-123456';
const decision = choice => ({choice,durationMs:1,inputTokens:100,outputTokens:10});

test('router offers native calls from named paths without reading the repository',()=>{
  const input=routingInput(request());
  assert.equal(input.offers.length,2);
  assert.equal(input.offers[0].call.name,'exec_command');
  assert.match(JSON.parse(input.offers[0].call.arguments).cmd,/awk.*\.\/src\/one.ts/);
  assert.deepEqual(input.completed,[]);
  assert.equal(routingInput(request('Read .worktrees/feature/src/one.ts')).offers.length,1);
});

test('offered native command preserves source line numbers and missing-file failure',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'jev-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);
  const offered=routingInput(request('Read example.ts')).offers[0];
  const {cmd}=JSON.parse(offered.call.arguments);
  await assert.rejects(exec('/bin/sh',['-c',cmd],{cwd:root}),e=>typeof e.code==='number'&&e.code!==0);
  await writeFile(path.join(root,'example.ts'),'export const answer = 42;\n');
  const {stdout}=await exec('/bin/sh',['-c',cmd],{cwd:root});
  assert.match(stdout,/1\s+export const answer = 42;/);
});

test('Codex results stay out of selector state; completed calls cannot be selected again',()=>{
  const body=request();const first=routingInput(body).offers[0];
  const call=toolResponse(first.call,first.id).output[0];
  body.input.push(call,{type:'function_call_output',call_id:call.call_id,output:'PRIVATE_SOURCE_SENT_ONLY_TO_CODEX'});
  const next=routingInput(body);
  assert.equal(next.offers.length,1);
  assert.doesNotMatch(JSON.stringify(next),/PRIVATE_SOURCE/);
  assert.equal(next.completed[0].id,first.id);
});

test('pending calls, coding-model continuation, and unsupported transport hand off',()=>{
  const body=request();const first=routingInput(body).offers[0];
  body.input.push(toolResponse(first.call,first.id).output[0]);
  assert.equal(routingInput(body),undefined);
  assert.equal(routingInput({...request(),previous_response_id:'stored'}),undefined);
  assert.equal(routingInput({...request(),tool_choice:'none'}),undefined);
  assert.equal(routingInput({...request(),tools:[]}),undefined);
  const coding=request();coding.input.push({type:'reasoning',summary:[]});
  assert.equal(routingInput(coding),undefined);
});

test('credentials, parent traversals, and ambiguous goals produce no native offers',()=>{
  assert.equal(routingInput(request('Read ../secrets.json and .env')),undefined);
  assert.equal(routingInput(request('Read /etc/config.json')),undefined);
  assert.equal(routingInput(request('Read .codex/auth.json')),undefined);
  assert.equal(routingInput(request('Fix the bug')),undefined);
  assert.equal(routingInput(request('<environment_context> src/file.ts </environment_context>')),undefined);
});

test('code-mode adapter uses advertised native executor and JSON-encodes its arguments',()=>{
  const body=request();delete body.tools;
  body.input.unshift({type:'additional_tools',tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',description:'declare const tools: { exec_command(args: { cmd: string }): Promise<unknown>; };'}]}]});
  const call=routingInput(body).offers[0].call;
  assert.equal(call.type,'custom_tool_call');assert.equal(call.namespace,'functions');
  assert.match(call.input,/^text\(await tools\.exec_command\(/);
});

async function fixture(t,selector) {
  const forwarded=[];const audits=[];
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    forwarded.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({upstream:true}));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const router=await startRouter({selector,token:key,upstream:`http://127.0.0.1:${upstream.address().port}/v1`,allowLocalUpstreamForTests:true,audit:e=>audits.push(e)});
  t.after(async()=>{await router.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const send=(body,headers={})=>fetch(router.url+'/responses',{method:'POST',headers:{'content-type':'application/json','x-jev-router-key':key,...headers},body:JSON.stringify(body)});
  return {router,send,forwarded,audits};
}

test('one Jev choice becomes a streamed Codex call with no upstream model request',async t=>{
  const f=await fixture(t,{select:async input=>decision(input.offers[0].id)});
  const response=await f.send(request());const stream=await response.text();
  assert.match(stream,/response.function_call_arguments.delta/);
  assert.match(stream,/call_jev_/);assert.match(stream,/response.completed/);
  assert.equal(f.forwarded.length,0);assert.equal(f.audits[0].upstreamRequestSkipped,true);
});

test('handoff preserves full source result for coding model but never forwards router credentials',async t=>{
  const f=await fixture(t,{select:async()=>decision('handoff')});
  const body=request('Explain the result');body.input.push({type:'function_call_output',call_id:'call_old',output:'source data'});
  const response=await f.send(body,{authorization:'Bearer fake-upstream-token'});
  assert.equal(response.status,200);await response.text();
  assert.deepEqual(JSON.parse(f.forwarded[0].body),body);
  assert.equal(f.forwarded[0].headers.authorization,'Bearer fake-upstream-token');
  assert.equal(f.forwarded[0].headers['x-jev-router-key'],undefined);
});

test('selector outage falls back to original request exactly once',async t=>{
  const f=await fixture(t,{select:async()=>{throw Error('offline')}});
  const body=request();await(await f.send(body)).text();
  assert.equal(f.forwarded.length,1);assert.deepEqual(JSON.parse(f.forwarded[0].body),body);
  assert.equal(f.audits[0].kind,'fallback');
});

test('router rejects unauthorized requests, unknown endpoints and non-OpenAI upstreams',async t=>{
  const f=await fixture(t,{select:async()=>{throw Error('must not run')}});
  const response=await f.send(request(),{'x-jev-router-key':'wrong'});assert.equal(response.status,401);await response.text();
  const unknown=await fetch(f.router.url+'/secrets',{headers:{'x-jev-router-key':key}});assert.equal(unknown.status,404);await unknown.text();
  assert.equal(f.forwarded.length,0);
  await assert.rejects(startRouter({selector:{},token:key,upstream:'https://example.com'}),/official OpenAI/);
});

test('launcher applies provider options after the Codex subcommand without leaking env-file values',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'jev-launcher-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'codex'),keyFile=path.join(root,'private.env');
  await writeFile(keyFile,'TYPESAFE_API_KEY=fixture-only\nJEV_PRIVATE_FIXTURE_VALUE=should-stay-in-parent\n');
  await writeFile(executable,`#!/usr/bin/env node\nconst args=process.argv.slice(2); console.log(JSON.stringify({keyPresent:!!process.env.TYPESAFE_API_KEY,otherPrivatePresent:!!process.env.JEV_PRIVATE_FIXTURE_VALUE,providerAfterCommand:args.indexOf('model_provider="jev_router"')>args.indexOf('exec'),sandbox:args[args.indexOf('--sandbox')+1]}));\n`);
  await chmod(executable,0o700);
  const env={...process.env,PATH:root+path.delimiter+process.env.PATH};delete env.JEV_PRIVATE_FIXTURE_VALUE;
  const {stdout}=await promisify(execFile)(process.execPath,[path.resolve('dist/router-cli.js'),'--key-file',keyFile,'--','exec','--ignore-user-config','--sandbox','read-only'],{env});
  assert.deepEqual(JSON.parse(stdout),{keyPresent:false,otherPrivatePresent:false,providerAfterCommand:true,sandbox:'read-only'});
});
