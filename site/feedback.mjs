import {featureVersion,soundLabel,soundLabels,median} from './audio-features.mjs';
export const algorithm='nearest-original-q95-v1';
export const sameSegment=(check,s)=>check.id===s.id&&check.start===s.start&&check.end===s.end&&check.label===soundLabel(s);
export const validVector=v=>Array.isArray(v)&&v.length===273&&v.every(x=>Number.isFinite(x)&&Math.abs(x)<1e12);
export function retainChecks(review){
 if(review.feedback)review.feedback.checks=review.feedback.checks.filter(c=>review.segments.some(s=>sameSegment(c,s)));
}
export function validateFeedback(f,segments){
 if(!f)return;
 if(f.algorithm!==algorithm||f.features!==featureVersion||!Array.isArray(f.checks)||f.checks.length>segments.length)throw Error('재확인 기록 형식 오류입니다.');
 const seen=new Set();
 for(const c of f.checks){
  if(seen.has(c.id)||!segments.some(s=>sameSegment(c,s))||!soundLabels.includes(c.label)||!['accepted','confirmed','unscored'].includes(c.decision)||
   !['different','short','insufficient','ordinary','unavailable'].includes(c.reason)||typeof c.at!=='string'||!Number.isFinite(Date.parse(c.at))||typeof c.by!=='string'||!c.by||c.by.length>100||
   typeof c.reference!=='string'||c.reference.length>200||!(c.vector===null||validVector(c.vector))||
   !(c.score===null||Number.isFinite(c.score)&&c.score>=0)||!(c.threshold===null||Number.isFinite(c.threshold)&&c.threshold>=0)||
   (['different','short'].includes(c.reason)&&c.decision!=='confirmed')||
   (c.reason==='ordinary'&&c.decision!=='accepted')||
   (c.reason==='unavailable'&&c.decision!=='unscored')||
   (['different','ordinary'].includes(c.reason)&&(!validVector(c.vector)||c.score===null||c.threshold===null)))throw Error('재확인 구간 기록 오류입니다.');
  seen.add(c.id);
 }
}
export function validateReference(seed){
 if(seed?.features!==featureVersion||!Array.isArray(seed.rows)||seed.rows.length>10000)throw Error('비교 자료 형식이 올바르지 않습니다.');
 for(const r of seed.rows){
  if(typeof r.group!=='string'||!r.group||r.group.length>100||!soundLabels.includes(r.label)||!validVector(r.vector))throw Error('비교 자료 특징이 올바르지 않습니다.');
  if(r.id!==undefined&&(typeof r.id!=='string'||!r.id||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start))throw Error('이관된 비교 구간 정보가 올바르지 않습니다.');
 }
 return seed;
}
export function references(seed,entries,currentId){
 validateReference(seed);
 const replaced=new Set(entries.map(e=>e.record.source.id));replaced.add(currentId);
 const rows=seed.rows.filter(r=>{
  if(!replaced.has(r.group))return true;
  const record=entries.find(e=>e.record.source.id===r.group)?.record;
  // 과거 검수 구간은 이관 후에도 라벨·경계·ID가 그대로인 동안만 기준으로 유지합니다.
  return r.group!==currentId&&r.id!==undefined&&record&&!record.review.excluded&&record.review.segments.some(s=>sameSegment(r,s))&&
   !record.review.feedback?.checks.some(c=>sameSegment(c,r)&&(record.review.reviewed||c.decision==='confirmed')&&c.decision!=='unscored'&&validVector(c.vector));
 });
 for(const {record} of entries){
  if(record.source.id===currentId||record.review.excluded)continue;
  const f=record.review.feedback;if(!f||f.algorithm!==algorithm||f.features!==featureVersion)continue;
  for(const c of f.checks)if((record.review.reviewed||c.decision==='confirmed')&&c.decision!=='unscored'&&validVector(c.vector)&&c.end-c.start>=.5&&record.review.segments.some(s=>sameSegment(c,s)))rows.push({group:record.source.id,label:c.label,vector:c.vector});
 }
 return rows;
}
function distanceModel(rows){
 const grouped=new Map();for(const r of rows){if(!grouped.has(r.group))grouped.set(r.group,[]);grouped.get(r.group).push(r.vector);}
 const centers=[...grouped.values()].map(v=>Array.from({length:273},(_,i)=>median(v.map(x=>x[i]))));
 const mean=Array.from({length:273},(_,i)=>centers.reduce((s,c)=>s+c[i],0)/centers.length);
 const scale=mean.map((v,i)=>Math.sqrt(centers.reduce((s,c)=>s+(c[i]-v)**2,0)/centers.length)||1);
 return vector=>Math.sqrt(Math.min(...rows.map(r=>r.vector.reduce((s,x,i)=>s+((vector[i]-x)/scale[i])**2,0)/273)));
}
export function assess(vectors,rows){
 const models=new Map();
 return vectors.map(c=>{
  if(!c.vector||c.end-c.start<.5)return {...c,reason:'short',score:null,threshold:null};
  if(!models.has(c.label)){
   const same=rows.filter(r=>r.label===c.label),groups=[...new Set(same.map(r=>r.group))];
   if(groups.length<5)models.set(c.label,null);
   else{
    const scores=groups.map(group=>{const model=distanceModel(same.filter(r=>r.group!==group));return Math.max(...same.filter(r=>r.group===group).map(r=>model(r.vector)));}).sort((a,b)=>a-b);
    models.set(c.label,{score:distanceModel(same),threshold:scores[Math.ceil(.95*(scores.length-1))]});
   }
  }
  const model=models.get(c.label);if(!model)return {...c,reason:'insufficient',score:null,threshold:null};
  const score=model.score(c.vector);return {...c,score,threshold:model.threshold,reason:score>model.threshold?'different':'ordinary'};
 });
}
