import {isDeepStrictEqual} from 'node:util';
import {digest,selectMigration} from '../config/migrations.ts';
import {validateSemantics} from '../config/semantic.ts';
import {parseMigrationReceipt,renderMigrationReceipt,type MigrationReceipt} from '../provider/migration-receipt.ts';
import {electOwner,parsePublication,renderPublication} from '../provider/publication.ts';
import type {ProviderComment,RecoveryEvidence} from '../provider/types.ts';
import type {ReconcileDependencies} from './reconcile.ts';
import {parseMigrationRequest,isMigrationCommand} from './migration-request.ts';
import {publicationIdentity,recoverMigration} from './migration-recovery.ts';
const authorized=new Set(['admin','maintain','write']);
const pending=new WeakMap<object,Map<string,{body:string;receipt:MigrationReceipt}>>();
export async function processMigration(d:ReconcileDependencies,e:RecoveryEvidence):Promise<RecoveryEvidence> {
 if(!e.snapshot.open || !e.snapshot.activation.present) return e;
 const receipts=e.snapshot.comments.flatMap(c=>{const p=parseMigrationReceipt(c.body);return p?[p.receipt]:[];});
 const accepted=new Set(receipts.map(r=>r.request.id));
 const requests=e.snapshot.comments.filter(c=>isMigrationCommand(c.body) && !accepted.has(c.id) && (!e.snapshot.activation.occurredAt || Date.parse(c.createdAt)>Date.parse(e.snapshot.activation.occurredAt))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
 for(const request of requests) {
  if(!authorized.has(await d.provider.permission(e.snapshot.ref.repository,request.actor))) continue;
  const diagnostic='<!-- agent-flow-migration-diagnostic:v1 '+request.id+' '+digest(request.body)+' -->';
  if(e.snapshot.comments.some(c=>c.body.startsWith(diagnostic))) continue;
  let delivery=false;
  try {
   const command=parseMigrationRequest(request.body)!;
   if(d.provider.kind!=='github') throw new Error('GitLab workflow migration is not supported; ordinary GitLab flows are unchanged');
   if(!e.complete || e.activeBoundary!=='known' || e.legacyActive) throw new Error('Migration requires complete source activation evidence');
   if(e.ambiguities.some(a=>a!=='multiple linked pull requests')) throw new Error('Source evidence is ambiguous: '+e.ambiguities.join('; '));
   const owner=e.migration?.owner??electOwner(e.publications);
   if(!owner || owner.metadata.controller!==d.controllerId) throw new Error('Migration requires verifiable local source ownership');
   const sourcePin=e.migration?.receipt.target.config??owner.metadata.config;
   const cached=d.writeControl.load?.(e.snapshot.ref)?.value.control;
   if(cached && (cached.configRevision!==sourcePin || cached.activationEventId!==e.snapshot.activation.eventId)) throw new Error('Local source execution conflicts with provider evidence');
   const source=await d.config.loadPinned(sourcePin),activation=e.snapshot.activation;
   if(!activation.eventId || !activation.label || !activation.actor || !activation.occurredAt || !e.snapshot.labels.includes(activation.label)) throw new Error('Source activation is unavailable');
   if(!authorized.has(await d.provider.permission(e.snapshot.ref.repository,activation.actor))) throw new Error('Source activation actor lacks permission');
   const selected=e.changes.find(c=>c.number===command.pr);
   if(!selected) throw new Error('Selected PR is not linked to this ticket');
   if(selected.state==='closed') throw new Error('Selected PR is closed; reopen the same PR before migrating');
   if(selected.state==='merged') throw new Error('Selected PR is merged; follow-up work requires a separate decision');
   if(selected.repository!==e.snapshot.ref.repository || selected.headRepository!==selected.repository || !selected.headBranch) throw new Error('Selected PR repository or head branch is unavailable or unsupported');
   if(e.changes.some(c=>c.number!==command.pr && parsePublication(c.body).kind!=='unmarked')) throw new Error('Competing implementation PR evidence must be resolved');
   const parsed=parsePublication(selected.body);
   const carried=e.migration?.receipt.change;
   if(parsed.kind!=='current' || parsed.metadata.controller!==d.controllerId || (parsed.metadata.config!==sourcePin && carried?.number!==selected.number)) throw new Error('Selected PR has conflicting source provenance');
   if(!carried && !e.publications.some(p=>{const [kind,id]=publicationIdentity(p.key);return kind==='change-request'&&id===String(selected.number)&&p.ownershipEligible!==false;})) throw new Error('Selected PR original publication provenance is unavailable');
   let sourceStage=cached?.stateId??e.snapshot.labels.find(l=>l.startsWith('agent-stage:'))?.slice(12);
   if(sourceStage==='awaiting-merge' && activation.label!=='agent-flow:development') sourceStage='bug-awaiting-merge';
   if(!sourceStage) throw new Error('Source stage is unavailable');
   const resume=cached?.resumeStateId??null;
   if(source.flow.spec.states[sourceStage]?.kind==='paused' && !resume) throw new Error('Source paused-stage resume context is ambiguous');
   let proposals=pending.get(d.provider);if(!proposals){proposals=new Map();pending.set(d.provider,proposals);}
   const proposalKey=JSON.stringify([e.snapshot.ref,request.id]);
   let proposal=proposals.get(proposalKey);
   if(proposal && proposal.receipt.request.bodyHash!==digest(request.body)) throw new Error('Pending migration request was edited');
   if(!proposal) {
    if(!d.config.resolveTarget) throw new Error('Strict migration target resolution is unavailable');
    const sha=await d.config.resolveTarget(command.to),target=await d.config.loadPinned(sha);
    if(target.revision!==sha) throw new Error('Target bundle does not match resolved SHA');
    await validateSemantics(target);await d.config.validateTarget?.(target);
    const selection=await selectMigration(source,target,activation.label,resume??sourceStage,command.resume);
    if(selection.noop) {await d.provider.createComment(e.snapshot.ref,diagnostic+'\nMigration is a no-op: configuration is unchanged and no replay was requested.');continue;}
    const receipt:MigrationReceipt={apiVersion:'agent-flow/migration-v1',kind:'MigrationReceipt',ticket:e.snapshot.ref,
     activation:{eventId:activation.eventId,label:activation.label,actor:activation.actor,occurredAt:activation.occurredAt},
     owner:{key:owner.key,config:owner.metadata.config,createdAt:owner.createdAt},request:{id:request.id,actor:request.actor,bodyHash:digest(request.body)},
     source:{config:sourcePin,stage:sourceStage,resume},target:{config:sha,flow:target.flow.metadata.id,label:activation.label,basis:selection.basis},
     change:{provider:selected.provider,repository:selected.repository,number:selected.number,url:selected.url,headRepository:selected.headRepository,headBranch:selected.headBranch,headSha:selected.headSha,marker:renderPublication(parsed.metadata)},
     start:selection.stage,retained:[],baseline:{comments:e.snapshot.comments.map(c=>c.id),reviews:e.reviews.map(r=>r.id)},predecessor:e.migration?.id??null};
    proposal={receipt,body:renderMigrationReceipt(receipt,d.controllerId!)};proposals.set(proposalKey,proposal);
   }
   if(cached) await d.launcher.cancel(cached.flowInstanceId);
   if(cached && d.launcher.isRunning(cached.flowInstanceId)) throw new Error('Old agent termination could not be confirmed');
   const fresh=await d.provider.readRecoveryEvidence(e.snapshot.ref,activation.label);
   const freshRequest=fresh.snapshot.comments.find(c=>c.id===request.id),freshSelected=await d.provider.readChangeRequest(e.snapshot.ref,command.pr);
   if(!fresh.complete || !fresh.snapshot.open || !fresh.snapshot.activation.present || !isDeepStrictEqual(fresh.snapshot.activation,activation)
    || !freshRequest || digest(freshRequest.body)!==digest(request.body) || !isDeepStrictEqual(freshRequest.actor,request.actor)
    || !authorized.has(await d.provider.permission(e.snapshot.ref.repository,freshRequest.actor))) throw new Error('Source activation, ownership or request changed while draining work');
   if(!isDeepStrictEqual(freshSelected,selected) || !isDeepStrictEqual(fresh.snapshot.labels,e.snapshot.labels)) throw new Error('Source stage or selected PR changed while draining work');
   const committed=fresh.snapshot.comments.filter(c=>c.body===proposal!.body);
   if(committed.length>1) throw new Error('Conflicting duplicate migration receipts');
   const newPublications=fresh.publications.filter(p=>!e.publications.some(old=>old.key===p.key) && !committed.some(c=>publicationIdentity(p.key)[1]===c.id));
   if(newPublications.length && !e.migration) throw new Error('Source publications changed while draining work; reassess before migrating');
   delivery=true;
   const created=committed[0]??await d.provider.createComment(e.snapshot.ref,proposal.body);
   const readback=await d.provider.readComment(e.snapshot.ref,created.id);
   if(readback.id!==created.id || readback.body!==proposal.body || readback.updatedAt!==readback.createdAt) throw new Error('Migration receipt readback mismatch; reconcile before retrying');
   const verified=await d.provider.readRecoveryEvidence(e.snapshot.ref,activation.label);
   if(!verified.complete || !verified.snapshot.comments.some(c=>c.id===created.id && c.body===proposal!.body)) throw new Error('Migration receipt is not visible in complete recovery evidence');
   const result=await recoverMigration(verified,sha=>d.config.loadPinned(sha));proposals.delete(proposalKey);return result;
  } catch(error) {
   if(delivery) throw error;
   const message=error instanceof Error?error.message:'Migration validation failed';
   await d.provider.createComment(e.snapshot.ref,diagnostic+'\nMigration rejected: '+message+'. The source configuration and stage are unchanged. Submit a new request after resolving this diagnostic.');
  }
 }
 return e;
}
