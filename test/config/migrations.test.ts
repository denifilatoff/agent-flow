import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfigBundle } from '../../src/config/load.ts';
import { selectMigration, validateMigrationRule } from '../../src/config/migrations.ts';
const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const bundle = () => loadConfigBundle(process.cwd(), 'config/stack.yaml', sourceSha);
test('agent-only and same-pin replay select earlier executable stages without rules', async () => {
 const source = await bundle(), target = {...source, revision: targetSha};
 for (const stage of ['assessment','planning','development']) {
  assert.equal((await selectMigration(source,target,'agent-flow:development','awaiting-merge',stage)).stage,stage);
 }
 assert.equal((await selectMigration(source,source,'agent-flow:development','development')).noop,true);
 assert.equal((await selectMigration(source,source,'agent-flow:development','development','development')).noop,false);
 await assert.rejects(selectMigration(source,target,'agent-flow:development','planning','development'), /earlier/);
 await assert.rejects(selectMigration(source,target,'agent-flow:development','planning','bug-development'), /route/);
});
test('changed required CI requires an exact direct mapping', async () => {
 const source = await bundle(), target = await bundle(); target.revision=targetSha;
 source.flow.spec.requiredChecks = undefined;
 await assert.rejects(selectMigration(source,target,'agent-flow:development','awaiting-merge'), /direct rule/);
 const rule = validateMigrationRule({apiVersion:'agent-flow/migration-v1',kind:'WorkflowMigration',id:'ci',source:sourceSha,sourceFlow:source.flow.metadata.id,targetFlow:target.flow.metadata.id,activationLabel:'agent-flow:development',states:{'awaiting-merge':{target:'development',replay:['assessment','planning','development'],retain:[]}}},target);
 target.migrations=[rule];
 assert.equal((await selectMigration(source,target,'agent-flow:development','awaiting-merge')).stage,'development');
 assert.equal((await selectMigration(source,target,'agent-flow:development','awaiting-merge','planning')).stage,'planning');
 target.migrations=[rule,rule];
 await assert.rejects(selectMigration(source,target,'agent-flow:development','awaiting-merge'), /exactly one/);
});
test('rule validation rejects extensions, invalid targets, versions and source identities', async () => {
 const target=await bundle();
 const valid={apiVersion:'agent-flow/migration-v1',kind:'WorkflowMigration',id:'ci',source:sourceSha,sourceFlow:target.flow.metadata.id,targetFlow:target.flow.metadata.id,activationLabel:'agent-flow:development',states:{'awaiting-merge':{target:'development',replay:['planning'],retain:[]}}};
 assert.ok(validateMigrationRule(valid,target));
 for(const value of [{...valid,script:'echo hi'},{...valid,apiVersion:'v2'},{...valid,source:'latest'},{...valid,states:{'awaiting-merge':{target:'done',replay:[],retain:[]}}}]) assert.throws(()=>validateMigrationRule(value,target));
});

test('shipped old-CI rules validate against the actual source configuration on both activation routes',async(t)=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {loadPinnedConfig}=await import('../../src/config/repository.ts');
 const root=await mkdtemp(join(tmpdir(),'old-ci-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=await loadPinnedConfig(process.cwd(),root,'896c0003dd5c42350ee0628a4dc30b680409fefa'),target=await bundle();
 assert.equal((await selectMigration(source,target,'agent-flow:development','awaiting-merge')).stage,'development');
 assert.equal((await selectMigration(source,target,'bugfix','bug-awaiting-merge')).stage,'bug-development');
 await assert.rejects(selectMigration(source,target,'agent-flow:development','review'),/no mapping/);
 await assert.rejects(selectMigration(source,target,'agent-flow:development','awaiting-merge','review'),/forbidden/);
});
