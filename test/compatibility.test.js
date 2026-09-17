import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileScript, parseMeta} from '../src/engine/script.js';
import {runWorkflow, resolveSource, resolveModel} from '../src/engine/runner.js';
import {normalizeSchema, strictOutputSchema, validateAgainstSchema} from '../src/engine/schema.js';
import {listWorkflowFiles} from '../src/util/paths.js';
import {loadAgentFile} from '../src/engine/agents.js';
const source = body => `export const meta={name:'compat',description:'Compatibility fixture'};\n${body}`;
async function fixture(fn) {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'cdw-compat-'));
  try { await fn(cwd); } finally { await fs.rm(cwd,{recursive:true,force:true}); }
}
const execute=body=>compileScript(source(body)).run({reportFailure:()=>{}});

test('Claude pipeline waits for promise inputs and stops at null; preserves original item/index', async()=>{
 assert.deepEqual(await execute(`
 const seen=[];
 const values=await pipeline([null,Promise.resolve(2),3],
   (prev,original,index)=>{seen.push([prev,original instanceof Promise,index]);return index===2?null:prev+1;},
   value=>value*10);
 return {values,seen};`),{values:[null,30,null],seen:[[2,true,1],[3,false,2]]});
});
test('parallel settles thrown null, script errors and rejections without losing successful siblings',async()=>{
 assert.deepEqual(await execute(`return await parallel([()=>{throw null},()=>{const e=new Error('bad');e.name='WorkflowScriptError';throw e},()=>7]);`),[null,null,7]);
});
test('pipeline snapshots inputs and awaits zero-stage promise items',async()=>{
 assert.deepEqual(await execute('return await pipeline([Promise.resolve(1), Promise.reject("bad"), null]);'),[1,null,null]);
 assert.deepEqual(await execute('return await pipeline([], null);'),[]);
 await assert.rejects(()=>execute('return await parallel(new Array(1));'),/函数数组/);
});
test('literal meta permits comments, braces and function-like text without executing expressions',()=>{
 assert.equal(parseMeta(`export const meta={/* } */name:'meta',description:'function foo() => ...'};return 1;`).meta.name,'meta');
 assert.throws(()=>parseMeta("export const meta={name:'bad',description:(()=>1)()};"),/纯字面量/);
});
test('JSON Schema preserves optional properties and enforces full validation semantics',()=>{
 const original={type:'object',properties:{requiredValue:{type:'integer',minimum:2},optional:{type:'string'}},required:['requiredValue'],additionalProperties:false};
 const schema=normalizeSchema(original);
 assert.deepEqual(schema,original);assert.equal(strictOutputSchema(schema),null);
 assert.equal(validateAgainstSchema({requiredValue:2},schema).valid,true);
 assert.equal(validateAgainstSchema({requiredValue:1},schema).valid,false);
 assert.equal(validateAgainstSchema({requiredValue:2,extra:true},schema).valid,false);
 assert.equal(validateAgainstSchema(2,{oneOf:[{type:'number'},{type:'integer'}]}).valid,false);
 assert.equal(validateAgainstSchema('a',{allOf:[{type:'string'},{minLength:2}]}).valid,false);
 assert.equal(validateAgainstSchema({a:1},{enum:[{a:1}]}).valid,true);
 assert.equal(validateAgainstSchema('bad',{type:'string',format:'email'}).valid,false);
 assert.equal(validateAgainstSchema([1],{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',prefixItems:[{type:'string'}]}).valid,false);
 assert.throws(()=>normalizeSchema({type:'object',required:['missing'],additionalProperties:false}),/必填字段/);
 assert.throws(()=>normalizeSchema({$ref:'#/$defs/missing'}),/无效/);
 const strict={type:'object',properties:{x:{type:'string'}},required:['x'],additionalProperties:false};
 assert.deepEqual(strictOutputSchema(strict),strict);
});
test('model mapping is explicit and inherit uses the run default',()=>{
 assert.equal(resolveModel('sonnet','fallback',{sonnet:'gpt-6-astra'}),'gpt-6-astra');
 assert.equal(resolveModel('inherit','gpt-6-astra'),'gpt-6-astra');
 assert.throws(()=>resolveModel('opus'),/modelMap/);
});
test('named workflows use meta.name and project overrides; scriptPath wins and is cwd-relative',()=>fixture(async cwd=>{
 const low=path.join(cwd,'low'),high=path.join(cwd,'.claude/workflows');
 await fs.mkdir(low);await fs.mkdir(high,{recursive:true});
 await fs.writeFile(path.join(low,'different.js'),source('return 1;'));
 await fs.writeFile(path.join(high,'filename.js'),source('return args;'));
 const dirs=[low,high];
 assert.equal(listWorkflowFiles(cwd,dirs).get('compat'),path.join(high,'filename.js'));
 assert.equal((await resolveSource({workflowName:'compat',workflowDirs:dirs,cwd})).filename,path.join(high,'filename.js'));
 const r=await runWorkflow({cwd,script:'invalid',scriptPath:'.claude/workflows/filename.js',args:['ok'],dryRun:true});
 assert.deepEqual(r.result,['ok']);
 const child=await runWorkflow({cwd,script:source("return await workflow({scriptPath:'.claude/workflows/filename.js'},42);"),dryRun:true});
 assert.equal(child.result,42);
 const named=await runWorkflow({cwd,name:'compat',args:false,dryRun:true});assert.equal(named.result,false);
}));
test('Claude YAML agent definitions support multiline fields, max and inherit',()=>fixture(async cwd=>{
 const dir=path.join(cwd,'.claude/agents');await fs.mkdir(dir,{recursive:true});
 const file=path.join(dir,'worker.md');await fs.writeFile(file,'---\nname: worker\ndescription: |\n  Multiline\n  description\nmodel: inherit\neffort: max\n---\nReturn a short answer.');
 const def=await loadAgentFile(file);assert.match(def.description,/Multiline\ndescription/);assert.equal(def.effort,'max');
 const events=[];const r=await runWorkflow({cwd,script:source("return await agent('task',{agentType:'worker',effort:'max'});"),dryRun:true,onEvent:e=>events.push(e)});
 assert.equal(r.agentCount,1);assert.equal(events.find(e=>e.type==='agent.started').effort,'max');
 await fs.writeFile(file,'---\nname: worker\ntools:\n  - Read\n---\nRead files only.');
 await assert.rejects(()=>runWorkflow({cwd,script:source("return await agent('task',{agentType:'worker'});"),dryRun:true}),/不能等价映射/);
}));
