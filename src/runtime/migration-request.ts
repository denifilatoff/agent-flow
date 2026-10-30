import {parsePublication} from '../provider/publication.ts';
export interface MigrationRequest {pr:number;to:string;resume?:string;}
export function isMigrationCommand(body:string):boolean {return /^\s*\/agent-flow\s+migrate(?:\s|$)/.test(body);}
export function parseMigrationRequest(body:string):MigrationRequest|null {
 if(!isMigrationCommand(body)) return null;
 if(parsePublication(body).kind!=='unmarked') throw new Error('Migration commands must be unmarked human comments');
 const tokens=body.trim().split(/\s+/).slice(2), options=new Map<string,string>();
 for(let i=0;i<tokens.length;i+=2) {
  const flag=tokens[i]!,value=tokens[i+1];
  if(!['--pr','--to','--resume-from'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) throw new Error('Missing, duplicate or unknown migration option: '+flag);
  options.set(flag,value);
 }
 const pr=options.get('--pr'),to=options.get('--to'),resume=options.get('--resume-from');
 if(!pr || !/^[1-9][0-9]*$/.test(pr) || !Number.isSafeInteger(Number(pr)) || !to) throw new Error('Migration requires --pr and --to');
 if(to!=='latest' && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(to) || to==='HEAD' || to.includes('..'))) throw new Error('Invalid migration selector');
 if(resume && !/^[a-z][a-z0-9-]*$/.test(resume)) throw new Error('Invalid replay stage');
 return {pr:Number(pr),to,...resume?{resume}:{}};
}
