#!/usr/bin/env node
// Opt-in, billable Claude compatibility check of the INSTALLED plugin over MCP.
// Usage: node scripts/smoke-compat-real.mjs <installed-plugin-root> <output-directory>
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
const call=async input=>{
  const response=await request('tools/call',{name:'workflow_run',arguments:{cwd,sandbox:'read-only',concurrency:2,...input},_meta:{progressToken:results.length}});
  assert.ok(!response.result?.isError,JSON.stringify(response));
  const result=response.result.structuredContent;
  assert.equal(result.status,'ok');results.push(result);
  await fs.writeFile(path.join(output,'report.partial.json'),JSON.stringify(results,null,2));
  return result;
};
try {
  await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'compat-real-smoke',version:'1'}});
  const namedDir=path.join(cwd,'.claude/workflows');await fs.mkdir(namedDir,{recursive:true});
  await fs.writeFile(path.join(namedDir,'different-filename.js'),`export const meta={name:'original-name',description:'Compatibility smoke'};
    phase('Data');
    const rows=await pipeline([null, Promise.resolve(args.value)],
      value=>agent('Do not use tools. Return exactly the JSON object {"value":'+value+'}. Omit the optional note property.',{
        model:'sonnet',effort:'low',label:'optional-json',
        schema:{type:'object',properties:{value:{type:'integer'},note:{type:'string'}},required:['value'],additionalProperties:false}
      }),
      row=>row.value);
    log('pipeline done');
    return rows;`);
  const first=await call({name:'original-name',args:{value:7},modelMap:{sonnet:'gpt-6-astra'},description:'Ignored',title:'Ignored'});
  assert.deepEqual(first.result,[null,7]);assert.equal(first.agentCount,1);
  const second=await call({name:'original-name',args:{value:7},modelMap:{sonnet:'gpt-6-astra'},resumeFromRunId:first.runId});
  assert.equal(second.agentCount,0);assert.deepEqual(second.result,first.result);
  await fs.writeFile(path.join(cwd,'child.js'),`export const meta={name:'strict-child',description:'Strict output'};
    return await agent('Do not use tools. Return exactly {"ok":true}.',{
      effort:'max',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}
    });`);
  const third=await call({script:`export const meta={name:'nested',description:'Relative child'};
    return await workflow({scriptPath:'child.js'});`});
  assert.deepEqual(third.result,{ok:true});assert.equal(third.agentCount,1);
  const fourth=await call({script:'invalid ignored inline source',scriptPath:'.claude/workflows/different-filename.js',args:{value:7},modelMap:{sonnet:'gpt-6-astra'},resumeFromRunId:second.runId});
  assert.deepEqual(fourth.result,[null,7]);assert.equal(fourth.agentCount,0);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({plugin,cwd,results,progressCount:progress.length},null,2));
  console.log('PASS: installed MCP, Claude directory/name, model mapping, optional schema, null pipeline, max effort, strict schema, nested relative workflow, two-generation resume, scriptPath precedence');
} finally {
  const closed=once(child,'close');child.stdin.end();await closed;await stderr.close();
}
