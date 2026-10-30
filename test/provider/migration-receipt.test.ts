import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMigrationReceipt,renderMigrationReceipt} from '../../src/provider/migration-receipt.ts';
import {renderPublication} from '../../src/provider/publication.ts';
const controller='eb587def-76dc-4d14-beb1-87c12cdd37e1',sha='a'.repeat(40);
export const receipt={apiVersion:'agent-flow/migration-v1',kind:'MigrationReceipt',ticket:{provider:'github',repository:'owner/repo',number:2},activation:{eventId:'activation',label:'agent-flow:development',actor:{login:'owner',providerId:'1'},occurredAt:'2026-10-30T00:00:00Z'},owner:{key:'owner-key',config:sha,createdAt:'2026-10-30T00:01:00Z'},request:{id:'request',actor:{login:'owner',providerId:'1'},bodyHash:'a'.repeat(64)},source:{config:sha,stage:'awaiting-merge',resume:null},target:{config:'b'.repeat(40),flow:'development-autonomous',label:'agent-flow:development',basis:'unchanged:test'},change:{provider:'github',repository:'owner/repo',number:8,url:'https://github.com/owner/repo/pull/8',headRepository:'owner/repo',headBranch:'feature',headSha:sha,marker:renderPublication({config:sha,controller})},start:'development',retained:[],baseline:{comments:['1'],reviews:['2']},predecessor:null};
test('migration receipts round trip independently of the common two-field marker',()=>{
 const body=renderMigrationReceipt(receipt as never,controller);
 assert.deepEqual(parseMigrationReceipt(body),{receipt,controller});
 for(const bad of [body.replace('migration-v1','migration-v2'),body.replace('"number":2','"number":0'),body.replace('"kind":"MigrationReceipt"','"kind":"MigrationReceipt","script":"exec"'),body+ '\n'+renderPublication({config:sha,controller})]) assert.throws(()=>parseMigrationReceipt(bad));
 assert.equal(parseMigrationReceipt('ordinary comment'),null);
});
