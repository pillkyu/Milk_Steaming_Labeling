import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Features,extractSegments,sampleFrames,featureVersion} from '../site/audio-features.mjs';
import {algorithm,assess,references,retainChecks,validateFeedback,validateReference} from '../site/feedback.mjs';
const vector=n=>Array.from({length:273},(_,i)=>n+i/100);
const segment={id:'s1',start:0,end:1,label:'normal_air'};
const base=()=>({features:featureVersion,rows:Array.from({length:6},(_,i)=>({group:'g'+i,label:'normal_air',vector:vector(i*.01)}))});
const check=()=>({...segment,vector:vector(.02),reason:'different',score:3,threshold:2,reference:'snapshot',at:'2026-11-12T00:00:00Z',by:'tester',decision:'confirmed'});

test('273 browser features match native Swift golden frames on synthetic audio',async()=>{
 const expected=JSON.parse(await readFile(new URL('./fixtures/features.json',import.meta.url))),pcm=new Float32Array(48000*3);let seed=17;
 for(let i=0;i<pcm.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pcm[i]=.12*Math.sin(i*2*Math.PI*417/48000)*(1+.4*Math.sin(i/3100))+.035*(seed/2**32-.5);}
 const f=new Features();for(let i=0;i+2048<=pcm.length;i+=512){const actual=f.frame(pcm,i),gold=expected[i/512];if(gold)for(let j=0;j<273;j++)assert.ok(Math.abs(actual[j]-gold[j])<1e-5,`frame ${i/512}, feature ${j}`);}
 assert.equal(sampleFrames(0,3,pcm.length).length,256);
 assert.equal(extractSegments(pcm,[{...segment,end:.003}])[0].vector,null);
 assert.throws(()=>extractSegments(new Float32Array([NaN]),[segment]));
});
test('same-label distance flags remote sounds; short and undersampled classes are explicit',()=>{
 const result=assess([{...segment,vector:vector(.02)},{...segment,id:'odd',vector:vector(50)},
  {...segment,id:'short',end:.1,vector:vector(.02)},{...segment,id:'other',label:'metallic_squeal',vector:vector(50)}],base().rows);
 assert.deepEqual(result.map(r=>r.reason),['ordinary','different','short','insufficient']);
 assert.ok(result[1].score>result[1].threshold);
});
test('reference updates exclude current audio, edited seed groups, unreviewed and skipped checks',()=>{
 const seed=base(),review={segments:[segment],reviewed:false,excluded:false,feedback:{algorithm,features:featureVersion,checks:[check()]}};
 const entries=[{record:{source:{id:'g0'},review}}];
 let rows=references(seed,entries,'g1');assert.equal(rows.length,5);assert.equal(rows.filter(r=>r.group==='g0').length,1);assert.ok(!rows.some(r=>r.group==='g1'));
 review.feedback.checks[0].decision='accepted';review.feedback.checks[0].reason='ordinary';rows=references(seed,entries,'g1');assert.ok(!rows.some(r=>r.group==='g0'));
 review.reviewed=true;assert.ok(references(seed,entries,'g1').some(r=>r.group==='g0'));
 review.excluded=true;assert.ok(!references(seed,entries,'g1').some(r=>r.group==='g0'));
 assert.throws(()=>validateReference({features:featureVersion,rows:[{group:'g',label:'bad',vector:vector(1)}]}));
});
test('confirmation binds exact interval and label; corrupted metadata cannot enter saved records',()=>{
 const review={segments:[segment],feedback:{algorithm,features:featureVersion,checks:[check()]}};
 validateFeedback(review.feedback,review.segments);
 for(const mutate of [c=>c.start=.1,c=>c.label='metallic_squeal',c=>c.vector[0]=Infinity,c=>c.decision='pending',c=>c.threshold=-1]){
  const f=structuredClone(review.feedback);mutate(f.checks[0]);assert.throws(()=>validateFeedback(f,review.segments));
 }
 review.segments=[{...segment,end:.9}];retainChecks(review);assert.equal(review.feedback.checks.length,0);
});
