import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { parseYaml } from './schema-validator.ts';
import type { ConfigBundle } from './load.ts';
import type { FlowDefinition, FlowState } from './types.ts';

export interface MigrationRule {
 apiVersion: 'agent-flow/migration-v1'; kind:'WorkflowMigration'; id:string;
 source:string; sourceFlow:string; targetFlow:string; activationLabel:string;
 states:Record<string,{target:string;replay:string[];retain:string[]}>;
}
const validator=new Ajv2020({strict:true,allErrors:true}).compile(JSON.parse(readFileSync(new URL('../../schemas/v1/workflow-migration.schema.json',import.meta.url),'utf8')));
export function validateMigrationRule(value:unknown,target:ConfigBundle):MigrationRule {
 if(!validator(value)) throw new Error('Invalid workflow migration rule: '+JSON.stringify(validator.errors));
 const rule=value as MigrationRule;
 if(rule.targetFlow!==target.flow.metadata.id) throw new Error('Migration target flow does not match');
 for(const mapping of Object.values(rule.states)) {
  for(const state of [mapping.target,...mapping.replay]) {
   if(target.flow.spec.states[state]?.kind!=='agent') throw new Error('Migration target must be an executable agent stage: '+state);
   if(!routeStages(target.flow,rule.activationLabel).includes(state)) throw new Error('Migration target is on another route: '+state);
  }
  for(const state of mapping.retain) if(target.flow.spec.states[state]?.kind!=='agent') throw new Error('Invalid retained stage: '+state);
 }
 return rule;
}
export async function loadMigrationRules(bundle:ConfigBundle):Promise<MigrationRule[]> {
 const directory=join(bundle.root,'config/migrations');
 try { if(!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe migration directory'); }
 catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return []; throw error; }
 const rules:MigrationRule[]=[];
 for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(!entry.isFile() || !/^[a-z0-9][a-z0-9-]*\.ya?ml$/.test(entry.name)) throw new Error('Unsafe migration rule file: '+entry.name);
  rules.push(validateMigrationRule(await parseYaml(join(directory,entry.name)),bundle));
 }
 if(new Set(rules.map(r=>r.id)).size!==rules.length) throw new Error('Duplicate migration rule id');
 return rules;
}
// Follow only the successful route, never retry/cancellation edges shared by unrelated routes.
export function routeStages(flow:FlowDefinition,label:string):string[] {
 let stage=label===flow.metadata.activationLabel?flow.spec.initial:flow.spec.activationRoutes?.[label];
 if(!stage) throw new Error('Unknown activation route');
 const result:string[]=[];
 while(stage && !result.includes(stage)) {
  result.push(stage); const state:FlowState|undefined=flow.spec.states[stage];
  if(!state) throw new Error('Unknown route stage: '+stage);
  stage=state.on?.['agent-succeeded']?.target ?? state.on?.['human-approved']?.target ?? state.on?.['review-approved']?.target;
 }
 return result;
}
export function digest(value:unknown):string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function canonical(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value!==null && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export async function behaviorDigest(bundle:ConfigBundle):Promise<string> {
 const flow=structuredClone(bundle.flow);
 for(const state of Object.values(flow.spec.states)) delete state.agent;
 const files=[...new Set([...bundle.stack.spec.contracts,...bundle.stack.spec.schemas])].sort();
 return digest({flow,contracts:await Promise.all(files.map(async path=>[path,JSON.parse(await readFile(join(bundle.root,path),'utf8'))]))});
}
export interface MigrationSelection {stage:string;retain:string[];basis:string;noop:boolean;}
export async function selectMigration(source:ConfigBundle,target:ConfigBundle,label:string,state:string,replay?:string):Promise<MigrationSelection> {
 const sourceRoute=routeStages(source.flow,label), targetRoute=routeStages(target.flow,label);
 if(!sourceRoute.includes(state)) throw new Error('Source stage is ambiguous or outside the activation route');
 const unchanged=await behaviorDigest(source)===await behaviorDigest(target);
 let stage=state, retain:string[]=sourceRoute.slice(0,sourceRoute.indexOf(state)), basis='unchanged:'+await behaviorDigest(source);
 if(!unchanged) {
  const rules=(target.migrations??[]).filter(r=>r.source===source.revision && r.sourceFlow===source.flow.metadata.id && r.targetFlow===target.flow.metadata.id && r.activationLabel===label);
  if(rules.length!==1) throw new Error('Changed workflow requires exactly one direct rule for the source configuration');
  const rule=rules[0]!, mapping=rule.states[state];
  if(!mapping) throw new Error('Direct rule has no mapping for source stage '+state);
  for(const s of Object.keys(rule.states)) if(!source.flow.spec.states[s]) throw new Error('Direct rule names invalid source state '+s);
  stage=mapping.target; retain=mapping.retain; basis='rule:'+rule.id+':'+digest(rule);
  if(replay && !mapping.replay.includes(replay)) throw new Error('Replay target is forbidden by the direct rule');
 }
 if(replay) {
  if(!targetRoute.includes(replay)) throw new Error('Replay target is on another route');
  if(target.flow.spec.states[replay]?.kind!=='agent') throw new Error('Replay requires an executable agent stage');
  const limit=unchanged?targetRoute.indexOf(state):targetRoute.indexOf(stage);
  if(targetRoute.indexOf(replay)>limit) throw new Error('Replay must select the current or an earlier stage');
  stage=replay;
 }
 if(!target.flow.spec.states[stage]) throw new Error('Unknown destination stage');
 retain=retain.filter(s=>targetRoute.indexOf(s)>=0 && targetRoute.indexOf(s)<targetRoute.indexOf(stage));
 for(const s of retain) if(digest({...source.flow.spec.states[s],agent:undefined})!==digest({...target.flow.spec.states[s],agent:undefined})) throw new Error('Retained stage contract changed: '+s);
 return {stage,retain,basis,noop:source.revision===target.revision && !replay};
}
