import assert from 'node:assert/strict';
import test from 'node:test';
import {processMigration} from '../../src/runtime/migration.ts';
test('unauthorized migration comments never resolve targets or mutate provider state',async()=>{
 const evidence={complete:true,legacyActive:false,activeBoundary:'known',ambiguities:[],publications:[],changes:[],reviews:[],snapshot:{ref:{repository:"owner/repo"},open:true,activation:{present:true},comments:[{id:'1',body:'/agent-flow migrate --pr 8 --to latest',actor:{login:'outsider',providerId:'2'}}]}};
 const dependencies={provider:{permission:async()=> 'read'},config:{resolveTarget:async()=>assert.fail('unauthorized resolution')}};
 assert.equal(await processMigration(dependencies as never,evidence as never),evidence);
});

async function migrationFixture(t:import('node:test').TestContext) {
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {loadConfigBundle}=await import('../../src/config/load.ts'),{openLocalStore,providerScope}=await import('../../src/runtime/local-store.ts'),{createControlWriter}=await import('../../src/runtime/control-state.ts');
 const {parsePublication,renderPublication}=await import('../../src/provider/publication.ts');
 const controller='eb587def-76dc-4d14-beb1-87c12cdd37e1',sourceSha='a'.repeat(40),targetSha='b'.repeat(40),actor={login:'owner',providerId:'1'};
 const source=await loadConfigBundle(process.cwd(),'config/stack.yaml',sourceSha),target={...source,revision:targetSha};
 const root=await mkdtemp(join(tmpdir(),'migration-protocol-')),store=await openLocalStore(join(root,"local.sqlite"));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const ref={provider:'github',repository:'owner/repo',number:2} as const;
 const marker=renderPublication({config:sourceSha,controller});
 const comment=(id:string,body:string)=>({id,url:'https://github.com/owner/repo/issues/2#issuecomment-'+id,body,actor,createdAt:'2026-10-30T00:01:'+id.padStart(2,'0')+'Z',updatedAt:'2026-10-30T00:01:'+id.padStart(2,'0')+'Z'});
 const selected={provider:'github',repository:ref.repository,number:8,url:'https://github.com/owner/repo/pull/8',headRepository:ref.repository,headBranch:'feature',headSha:'1'.repeat(40),state:'open',body:marker,actor,createdAt:'2026-10-30T00:01:02Z',updatedAt:'2026-10-30T00:01:02Z'} as const;
 const snapshot={ref,repository:{provider:'github',name:ref.repository,host:'github.com',cloneRoot:'https://github.com/',cloneUrl:'https://github.com/owner/repo.git'},title:'migration',description:'ticket',open:true,labels:['agent-flow:managed','agent-flow:development','agent-stage:awaiting-merge'],updatedAt:'2026-10-30T00:02:00Z',activation:{present:true,label:'agent-flow:development',eventId:'activation',actor,occurredAt:'2026-10-30T00:00:00Z'},comments:[comment('1',marker+'\nAssessment'),comment('3','/agent-flow migrate --pr 8 --to latest --resume-from development')],changeRequest:selected};
 const key=(kind:string,id:string)=>JSON.stringify(['github','https://api.github.com/',ref.repository,kind,id]);
 const raw=()=>({snapshot:structuredClone(snapshot),complete:true,activeBoundary:'known',legacyActive:false,ambiguities:[],changes:[structuredClone(selected)],reviews:[],publications:[...snapshot.comments.flatMap(c=>{const p=parsePublication(c.body);return p.kind==='current'?[{key:key('comment',c.id),createdAt:c.createdAt,metadata:p.metadata}]:[];}),{key:key('change-request','8'),createdAt:selected.createdAt,metadata:{config:sourceSha,controller}}]});
 let next=4,resolves=0,creates=0,cancels=0;const starts:unknown[]=[];
 const provider={kind:'github',permission:async()=> 'write',readRecoveryEvidence:async()=>raw(),readTicket:async()=>structuredClone(snapshot),readChangeRequest:async()=>structuredClone(selected),readComment:async(_ref:unknown,id:string)=>snapshot.comments.find(c=>c.id===id)!,createComment:async(_ref:unknown,body:string)=>{creates++;const c=comment(String(next++),body);snapshot.comments.push(c);return c;},setControllerLabels:async(_ref:unknown,remove:string[],add:string[])=>{snapshot.labels=snapshot.labels.filter(l=>!remove.includes(l));snapshot.labels.push(...add);return snapshot.labels;}};
 const writeControl=createControlWriter(store,providerScope('github','https://api.github.com'),controller);
 const d={provider,controllerId:controller,writeControl,config:{loadPinned:async(sha:string)=>sha===sourceSha?source:target,loadCurrent:async()=>target,resolveTarget:async()=>{resolves++;return targetSha;}},launcher:{start:async(request:unknown)=>{starts.push(request);},cancel:async()=>{cancels++;},isRunning:()=>false}};
 return {d,raw,snapshot,selected,source,target,starts,writeControl,ref,counts:()=>({resolves,creates,cancels})};
}

test('receipt commit/readback carries PR 8 and duplicate reconciliation preserves one replay boundary',async(t)=>{
 const f=await migrationFixture(t),{reconcileTicket}=await import('../../src/runtime/reconcile.ts');
 const first=await reconcileTicket(f.d as never,f.ref);
 assert.equal(first.stateId,'development');assert.equal(first.configRevision,f.target.revision);
 assert.equal(f.counts().creates,1);assert.equal(f.counts().resolves,1);assert.equal(f.starts.length,1);
 assert.equal(f.snapshot.changeRequest.number,8);assert.ok(f.snapshot.changeRequest.body.includes(f.source.revision));
 const saved=f.writeControl.load!(f.ref)!;assert.ok(saved.value.migrationId);
 await reconcileTicket(f.d as never,f.ref);
 assert.equal(f.counts().creates,1);assert.equal(f.counts().resolves,1);
 assert.equal(f.writeControl.load!(f.ref)!.value.migrationId,saved.value.migrationId);
});
