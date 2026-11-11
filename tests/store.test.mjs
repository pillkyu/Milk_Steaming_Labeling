import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GitHubStore} from '../site/github.mjs';
import {blankReview,sha256,validateRecord,toBase64,fromBase64} from '../site/records.mjs';
import {commitRange} from '../site/segments.mjs';
const schema=JSON.parse(await readFile(new URL('../site/labels.json',import.meta.url)));
const original=new Blob(['synthetic-test-audio']);
const id=await sha256(await original.arrayBuffer());
const fixture=()=>({schema:'milk-steaming-record-v1',labelSchema:schema.schema,source:{id,originalSHA256:id,originalAudio:`recordings/${id}/original.wav`,bytes:original.size,duration:2,kind:'recording',datasetGroup:'home',originalFilename:'테스트.wav',title:'테스트.wav',sourceGroup:'test-session',waveform:[[0,0],[1,1]]},review:blankReview(2)});

import {fakeGitHub} from './fake-github.mjs';

test('validates full coverage, labels, purge and air event integrity',()=>{
 const r=fixture();validateRecord(r,schema);
 Object.assign(r.review,commitRange(r.review.segments,[],0,1,'normal_air',2,'weak'));
 Object.assign(r.review,commitRange(r.review.segments,r.review.airEvents,1,2,'steam_purge'));
 r.review.steamPresence='yes';r.review.reviewed=true;validateRecord(r,schema);
 for(const corrupt of [x=>x.review.segments[1].start=1.1,x=>x.review.segments[0].label='wrong',x=>x.review.segments[1].label='steam_end',x=>x.review.airEvents[0].end=2,x=>x.source.originalAudio='../../secret',x=>x.review.steamPresence='no']){
  const copy=structuredClone(r);corrupt(copy);assert.throws(()=>validateRecord(copy,schema));
 }
});
test('refuses a public data repository',async()=>{
 const fake=fakeGitHub();fake.private=false;
 await assert.rejects(new GitHubStore('test/data','test',schema,fake.fetch).connect(),/비공개/);
 assert.equal(fake.writes.length,0);
});
test('saves original and labels atomically, reopens and verifies original bytes',async()=>{
 const fake=fakeGitHub(),store=new GitHubStore('test/data','test',schema,fake.fetch);await store.connect();
 const r=fixture(),saved=await store.save(r,original,null),list=await store.list();
 assert.equal(list.length,1);assert.equal(list[0].sha,saved.sha);assert.equal(await (await store.audio(list[0])).text(),await original.text());
 assert.equal(fake.writes.filter(w=>w.path.includes('/git/refs/')).length,1);
 r.review.note='수정';await store.save(r,null,saved.sha);assert.equal((await store.list())[0].record.review.note,'수정');
 assert.equal(fake.writes.filter(w=>w.path.endsWith('/git/blobs')&&w.body.encoding==='base64').length,1);
});
test('rejects a stale same-record edit without overwriting newer labels',async()=>{
 const fake=fakeGitHub(),store=new GitHubStore('test/data','test',schema,fake.fetch);await store.connect();
 const r=fixture(),old=await store.save(r,original,null);r.review.note='new';await store.save(r,null,old.sha);
 const head=fake.head;r.review.note='stale';await assert.rejects(store.save(r,null,old.sha),/다른 사용자/);assert.equal(fake.head,head);
});
test('retries a concurrent different-record commit without forcing the branch',async()=>{
 const fake=fakeGitHub(),store=new GitHubStore('test/data','test',schema,fake.fetch);await store.connect();fake.failPatch=1;
 await store.save(fixture(),original,null);assert.equal((await store.list()).length,1);
 assert.ok(fake.writes.filter(w=>w.path.includes('/git/refs/')).every(w=>w.body.force===false));
});
test('rejects wrong original bytes before writing any blob',async()=>{
 const fake=fakeGitHub(),store=new GitHubStore('test/data','test',schema,fake.fetch);await store.connect();
 await assert.rejects(store.save(fixture(),new Blob(['wrong']),null),/검증/);assert.equal(fake.writes.length,0);
});
