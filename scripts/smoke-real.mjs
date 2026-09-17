#!/usr/bin/env node
// Opt-in, billable integration check of the INSTALLED plugin over MCP.
// Usage: node scripts/smoke-real.mjs <installed-plugin-root> <output-directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const [pluginArg, outputArg] = process.argv.slice(2);
if (!pluginArg || !outputArg) throw new Error('Expected installed plugin root and output directory');
const plugin = path.resolve(pluginArg);
const output = path.resolve(outputArg);
await fs.mkdir(output, {recursive:true});
const cwd = await fs.mkdtemp(path.join(output,'project-'));
const source = 'export function clamp(x,min,max) { return Math.min(max,Math.max(min,x)); }\nexport function twice(x) { var result = x * 2; return result; }\n';
await fs.writeFile(path.join(cwd,'package.json'), '{"name":"workflow-smoke","type":"module","scripts":{"test":"node --test"}}\n');
await fs.writeFile(path.join(cwd,'README.md'), 'Offline fixture. clamp returns min for x below min, max for x above max, otherwise x. twice doubles x. Run node --test.\n');
await fs.writeFile(path.join(cwd,'calc.js'), source);
await fs.writeFile(path.join(cwd,'calc.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {clamp,twice} from './calc.js'; test('bounds',()=>{assert.equal(clamp(-1,0,10),0);assert.equal(clamp(20,0,10),10);});test('double',()=>assert.equal(twice(3),6));\n");
const git = (...args) => execFileSync('git',args,{cwd,encoding:'utf8'});
git('init','-q');git('add','.');git('-c','user.name=Workflow Test','-c','user.email=workflow-test@example.invalid','commit','-qm','Offline smoke fixture');
const child = spawn(process.execPath, [path.join(plugin,'bin/cdw.js'),'mcp'], {cwd:plugin,stdio:['pipe','pipe','pipe']});
const stderr = await fs.open(path.join(output,'mcp.stderr'),'w');
child.stderr.on('data',chunk=>stderr.write(chunk));
const pending = new Map(); let seq=0;
const progress=[];
createInterface({input:child.stdout}).on('line',line=>{
  const message=JSON.parse(line);
  if (message.id !== undefined) { pending.get(message.id)?.(message);pending.delete(message.id); }
  else if (message.method==='notifications/progress') { progress.push(message.params); console.log(message.params.message); }
});
const request=(method,params)=>new Promise((resolve,reject)=>{
  const id=++seq;
  const timer=setTimeout(()=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}})+'\n');reject(new Error(`${method} exceeded 15 minutes`));},900000);
  pending.set(id,message=>{clearTimeout(timer);resolve(message);});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
const results=[];
async function run(name,args,sandbox='read-only') {
  const response=await request('tools/call',{name:'workflow_run',arguments:{name,cwd,args,sandbox,concurrency:2,budget:30000},_meta:{progressToken:name}});
  await fs.writeFile(path.join(output,`${name}.json`),JSON.stringify(response,null,2));
  assert.ok(!response.result?.isError,JSON.stringify(response));
  const summary=response.result.structuredContent;
  assert.equal(summary.status,'ok');
  assert.ok(summary.agentCount>0);
  results.push({name,runId:summary.runId,agents:summary.agentCount,usage:summary.usage,durationMs:summary.durationMs});
  await fs.writeFile(path.join(output,'report.partial.json'),JSON.stringify({plugin,cwd,results},null,2));
  return summary;
}
try {
  const hello=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'real-smoke',version:'1'}});
  assert.equal(hello.result.serverInfo.name,'codex-dynamic-workflow');
  const list=await request('tools/call',{name:'workflow_list',arguments:{cwd}});
  assert.equal(list.result.structuredContent.workflows.length,5);
  await fs.writeFile(path.join(output,'workflow-list.json'),JSON.stringify(list,null,2));
  await fs.writeFile(path.join(cwd,'calc.js'),source.replace('Math.min(max,Math.max(min,x))','Math.max(max,Math.min(min,x))'));
  const review=await run('review-changes',{dimensions:['correctness'],diffCommand:'git diff -- calc.js'});
  assert.ok(review.result.confirmed.some(f=>f.file.endsWith('calc.js')),'Review must confirm planted clamp regression');
  await fs.writeFile(path.join(cwd,'calc.js'),source);
  const panel=await run('design-panel',{question:'For this tiny offline calc.js fixture, suggest one minimal additional boundary test for clamp. Read only calc.js and calc.test.js. Keep each text field under 100 words, do not modify files.',angles:[{key:'minimal',prompt:'Choose the smallest useful test.'}],criteria:['Catches a meaningful boundary regression']});
  assert.equal(panel.result.proposals.length,1);
  assert.equal(panel.result.judgements.length,1);
  assert.ok(panel.result.finalPlan.length>0);
  const migration=await run('migrate',{instruction:'Only in calc.js, replace var result with const result in twice(). Do not change behavior or other files.',discoverHint:'Exactly one migration site: calc.js. Do not scan .git or .codex.',verifyCommand:'node --test',isolate:true},'workspace-write');
  assert.equal(migration.result.succeeded,1);
  assert.equal(migration.worktrees.length,1);
  const worktree=migration.worktrees[0].path;
  assert.match(await fs.readFile(path.join(worktree,'calc.js'),'utf8'),/const result/);
  execFileSync(process.execPath,['--test'],{cwd:worktree});
  assert.match(await fs.readFile(path.join(cwd,'calc.js'),'utf8'),/var result/);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({plugin,cwd,results,progressCount:progress.length,worktree},null,2));
  console.log('PASS: installed MCP plugin, review, design-panel, migration, independent tests and main-worktree isolation');
} finally {
  const closed = once(child, 'close');
  child.stdin.end();
  await closed;
  await stderr.close();
}
