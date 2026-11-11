import {maxBytes, maxSeconds} from './config.mjs';
import {validateFeedback} from './feedback.mjs';

export function blankReview(duration) {
 return {segments:[{id:crypto.randomUUID(),start:0,end:duration,label:'unknown'}],airEvents:[],steamPresence:'unsure',reviewed:false,excluded:false,note:''};
}

export function validateRecord(record, schema) {
 const fail = message => {throw Error(message);};
 const s=record.source,r=record.review;
 if(record.schema!=='milk-steaming-record-v1'||!s||!r)fail('지원하지 않는 저장 형식입니다.');
 if(!/^[a-f0-9]{64}$/.test(s.id)||s.originalSHA256!==s.id)fail('음원 식별자가 올바르지 않습니다.');
 if(!Number.isFinite(s.duration)||s.duration<=0||s.duration>maxSeconds)fail('음원은 15분 이하여야 합니다.');
 if(!Number.isInteger(s.bytes)||s.bytes<=0||s.bytes>maxBytes)fail('음원은 20MiB 이하여야 합니다.');
 if(!new RegExp(`^recordings/${s.id}/original\\.(m4a|wav|mp3|aac|flac|ogg|aiff|aif)$`).test(s.originalAudio))fail('음원 경로가 올바르지 않습니다.');
 if(s.kind!=='recording'||s.datasetGroup!=='home'||typeof s.originalFilename!=='string'||typeof s.title!=='string'||s.title.length>500||typeof s.sourceGroup!=='string')fail('녹음 정보가 올바르지 않습니다.');
 if(!Array.isArray(s.waveform)||!s.waveform.length||s.waveform.length>2200||s.waveform.some(p=>!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||p[0]<0||p[0]>s.duration||!Number.isFinite(p[1])||p[1]<0))fail('파형 정보가 올바르지 않습니다.');
 if(typeof r.reviewed!=='boolean'||typeof r.excluded!=='boolean'||typeof r.note!=='string'||r.note.length>10000||!['yes','no','unsure'].includes(r.steamPresence))fail('검수 정보가 올바르지 않습니다.');
 const defs=[...schema.classes,...schema.annotationOnly],labels=new Set(defs.map(d=>d.id));
 if(!Array.isArray(r.segments)||!r.segments.length||r.segments.length>20000)fail('라벨 구간이 올바르지 않습니다.');
 let end=0;const ids=new Set();
 for(const p of r.segments){
  if(!p||typeof p.id!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(p.id)||ids.has(p.id)||!labels.has(p.label)||p.label==='steam_purge')fail('구간 식별자 또는 라벨 오류입니다.');
  if(!Number.isFinite(p.start)||!Number.isFinite(p.end)||p.start<0||p.end>s.duration||p.start>=p.end||Math.abs(p.start-end)>1e-7)fail('라벨 구간은 빈틈·겹침 없이 이어져야 합니다.');
  if(p.endSignal!==undefined&&(p.endSignal!=='steam_purge'||p.label!=='non_steam'))fail('청소 방출은 비스티밍 구간에만 지정할 수 있습니다.');
  ids.add(p.id);end=p.end;
 }
 if(Math.abs(end-s.duration)>1e-7)fail('라벨 구간이 음원 끝까지 이어져야 합니다.');
 if(r.steamPresence==='no'&&r.segments.some(p=>defs.some(d=>d.id===p.label&&(d.isSteaming||d.isSteamingCandidate))))fail('스티밍 없음 상태에 스티밍 라벨이 있습니다.');
 if(r.reviewed&&!r.excluded&&(!r.segments.some(p=>schema.classes.some(d=>d.id===p.label))||r.segments.some(p=>defs.some(d=>d.id===p.label&&d.isCandidate))))fail('검수 완료 전에 후보를 확정하고 구간을 지정하세요.');
 if(!Array.isArray(r.airEvents)||r.airEvents.length>20000)fail('공기 주입 정보 오류입니다.');
 end=0;
 for(const e of r.airEvents){
  if(!e||!Number.isFinite(e.start)||!Number.isFinite(e.end)||e.start<end||e.start>=e.end||e.end>s.duration||(e.count!==null&&(!Number.isInteger(e.count)||e.count<1||e.count>10000))||![null,'weak','medium','strong','mixed'].includes(e.strength)||(e.count===null&&e.strength===null)||r.segments.some(p=>p.end>e.start&&p.start<e.end&&p.label!=='normal_air'))fail('공기 주입 횟수·강도 범위 오류입니다.');
  end=e.end;
 }
 validateFeedback(r.feedback,r.segments);
 return record;
}

export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');

export function toBase64(bytes){
 let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));
 return btoa(text);
}
export const fromBase64 = text => Uint8Array.from(atob(text.replace(/\s/g,'')),c=>c.charCodeAt(0));
