import {isDeepStrictEqual} from 'node:util';
import type {ConfigBundle} from '../config/load.ts';
import {digest,selectMigration} from '../config/migrations.ts';
import {parseMigrationReceipt,type MigrationReceipt} from '../provider/migration-receipt.ts';
import {electOwner,parsePublication,type Publication} from '../provider/publication.ts';
import type {NormalizedChangeRequest,ProviderComment,RecoveryEvidence} from '../provider/types.ts';
import {parseMigrationRequest} from './migration-request.ts';
export interface RecoveredMigration {id:string;receipt:MigrationReceipt;owner:Publication;comment:ProviderComment;}
export function eligibleAfterMigration(receipt:MigrationReceipt,kind:string,id:string):boolean {
 if(kind==='change-request') return false;
 return kind==='comment'?!receipt.baseline.comments.includes(id):kind==='review'?!receipt.baseline.reviews.includes(id):false;
}
export function publicationIdentity(key:string):[string,string] {
 const parts=JSON.parse(key);if(!Array.isArray(parts) || parts.length!==5) throw new Error('Invalid publication identity');return [parts[3],parts[4]];
}
export function assertCarriedChange(change:NormalizedChangeRequest,receipt:MigrationReceipt):void {
 const pinned=receipt.change;
 if(change.provider!==pinned.provider || change.repository!==pinned.repository || change.number!==pinned.number || change.url!==pinned.url
  || change.headRepository!==pinned.headRepository || change.headBranch!==pinned.headBranch) throw new Error('Selected PR repository or branch identity changed');
 const marker=parsePublication(change.body),source=parsePublication(pinned.marker);
 if(marker.kind!=='current' || source.kind!=='current' || !isDeepStrictEqual(marker.metadata,source.metadata)) throw new Error('Selected PR source marker changed');
}
export async function recoverMigration(evidence:RecoveryEvidence,load:(sha:string)=>Promise<ConfigBundle>):Promise<RecoveryEvidence> {
 const rows=evidence.snapshot.comments.flatMap(comment=>{const parsed=parseMigrationReceipt(comment.body);return parsed?[{comment,...parsed}]:[];});
 if(!rows.length) return evidence;
 if(!evidence.complete) throw new Error('Migration recovery requires complete provider evidence');
 const ids=new Set(rows.map(r=>r.comment.id));
 const ordinary=evidence.publications.filter(p=>{const [kind,id]=publicationIdentity(p.key);return kind!=='comment'||!ids.has(id);});
 const owner=electOwner(ordinary);
 if(!owner) throw new Error('Migration original ownership anchor is unavailable');
 const first=rows.filter(r=>r.receipt.predecessor===null);
 if(first.length!==1) throw new Error('Migration receipt chain has missing or conflicting root');
 let row=first[0]!,previous:string|null=null,sourcePin=owner.metadata.config,seen=new Set<string>(),last:RecoveredMigration|undefined;
 while(row) {
  if(seen.has(row.comment.id)) throw new Error('Migration receipt chain cycle');seen.add(row.comment.id);
  const r=row.receipt, activation=evidence.snapshot.activation;
  if(row.comment.updatedAt!==row.comment.createdAt) throw new Error('Migration receipt was edited');
  if(!evidence.publications.some(p=>publicationIdentity(p.key)[1]===row.comment.id && p.metadata.controller===row.controller && p.ownershipEligible!==false)) throw new Error('Migration receipt author/provenance is unavailable');
  if(row.controller!==owner.metadata.controller || r.owner.key!==owner.key || r.owner.config!==owner.metadata.config || r.owner.createdAt!==owner.createdAt) throw new Error('Migration receipt cannot transfer ownership');
  if(!isDeepStrictEqual(r.ticket,evidence.snapshot.ref) || r.activation.eventId!==activation.eventId || r.activation.label!==activation.label
   || !isDeepStrictEqual(r.activation.actor,activation.actor) || r.activation.occurredAt!==activation.occurredAt || r.target.label!==activation.label) throw new Error('Migration activation or ticket scope conflicts');
  if(r.source.config!==sourcePin || r.predecessor!==previous) throw new Error('Migration receipt source chain conflicts');
  const request=evidence.snapshot.comments.find(c=>c.id===r.request.id);
  if(!request || digest(request.body)!==r.request.bodyHash || !isDeepStrictEqual(request.actor,r.request.actor)) throw new Error('Accepted migration request is missing or edited');
  const command=parseMigrationRequest(request.body);
  if(!command || command.pr!==r.change.number || command.resume!==undefined && command.resume!==r.start) throw new Error('Accepted migration command conflicts');
  const [source,target]=await Promise.all([load(r.source.config),load(r.target.config)]);
  if(target.flow.metadata.id!==r.target.flow) throw new Error('Migration target flow conflicts');
  const selection=await selectMigration(source,target,r.activation.label,r.source.resume??r.source.stage,command.resume);
  if(selection.stage!==r.start || selection.basis!==r.target.basis || selection.noop) throw new Error('Migration compatibility decision conflicts');
  for(const retained of r.retained) {
   if(!selection.retain.includes(retained.stage)) throw new Error('Migration retains forbidden stage result');
   const p=ordinary.find(p=>p.key===retained.key);if(!p) throw new Error('Retained publication is unavailable');
   const [kind,id]=publicationIdentity(p.key),comment=evidence.snapshot.comments.find(c=>kind==='comment'&&c.id===id);
   if(!comment || digest(comment.body)!==retained.digest) throw new Error('Retained result changed');
  }
  last={id:row.comment.id,receipt:r,owner,comment:row.comment};sourcePin=r.target.config;previous=row.comment.id;
  const next=rows.filter(x=>x.receipt.predecessor===previous);
  if(next.length>1) throw new Error('Migration receipt chain fork');
  row=next[0]!;
 }
 if(seen.size!==rows.length || !last) throw new Error('Migration receipt chain is disconnected');
 const selected=evidence.changes.find(c=>c.number===last!.receipt.change.number);
 if(!selected) throw new Error('Selected carried PR is unavailable or unlinked');
 assertCarriedChange(selected,last.receipt);
 const competing=evidence.changes.filter(c=>c.number!==selected.number && parsePublication(c.body).kind!=='unmarked');
 if(competing.length) throw new Error('Competing implementation PR evidence');
 const active=ordinary.filter(p=>{
  const [kind,id]=publicationIdentity(p.key);
  if(p.metadata.controller!==owner.metadata.controller) return true;
  return eligibleAfterMigration(last!.receipt,kind,id);
 });
 if(active.some(p=>p.metadata.controller===owner.metadata.controller && p.metadata.config!==last!.receipt.target.config)) throw new Error('Post-migration publication uses an unexpected configuration');
 return {...evidence,migration:last,publications:active,changes:[selected],snapshot:{...evidence.snapshot,changeRequest:selected},
  reviews:evidence.reviews.filter(r=>eligibleAfterMigration(last!.receipt,'review',r.id)),
  ambiguities:evidence.ambiguities.filter(s=>s!=='multiple linked pull requests')};
}
