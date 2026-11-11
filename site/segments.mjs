// Preserve complete source coverage when a reviewer paints a time interval.
const id=()=>crypto.randomUUID();
// 청소 방출은 비스티밍 정답을 유지하면서 종료 단서를 함께 기록합니다.
export const segmentLabel=s=>s.label==='non_steam'&&s.endSignal==='steam_purge'?'steam_purge':s.label;
export function commitRange(parts,events,start,end,label,count=null,strength=null,origin=null){
 let next=parts,records=events;
 // Changing the label paints only the selection; same-label boundary edits move the original region.
 if(origin&&segmentLabel(origin)===label&&(origin.start!==start||origin.end!==end)){
  next=paint(next,origin.start,origin.end,'unknown');records=updateAirEvents(records,origin.start,origin.end,'unknown');
 }
 next=paint(next,start,end,label);records=updateAirEvents(records,start,end,label,count,strength);
 return {segments:next,airEvents:records};
}
export function updateAirEvents(events,start,end,label,count=null,strength=null){
 const kept=events.filter(e=>e.end<=start||e.start>=end).map(e=>({...e}));
 if(label==='normal_air'&&(count!==null||strength!==null))kept.push({start,end,count,strength});
 return kept.sort((a,b)=>a.start-b.start);
}
export function dragRange(range,anchor,time,duration,edge=null){
 const sample=1/48000,t=Math.max(0,Math.min(duration,time));
 if(edge==='start')return [Math.min(t,range[1]-sample),range[1]];
 if(edge==='end')return [range[0],Math.max(t,range[0]+sample)];
 const a=Math.max(0,Math.min(duration,anchor));
 return Math.abs(a-t)<sample?null:[Math.min(a,t),Math.max(a,t)];
}
export function rangeBounds(parts,startText,endText,selection){
 const edges=[parts[0].start,...parts.map(s=>s.end)];
 const read=(text,i)=>{
  if(text===''||!Number.isFinite(Number(text)))throw Error('시작과 끝을 숫자로 입력하세요.');
  if(selection&&text===selection[i].toFixed(3))return selection[i];
  const value=Number(text),edge=edges.reduce((best,t)=>Math.abs(t-value)<Math.abs(best-value)?t:best,edges[0]);
  return Math.abs(edge-value)<=.000500001?edge:value;
 };
 const start=read(startText,0),end=read(endText,1);
 if(start<0||start>=end||end>parts.at(-1).end)throw Error('0 ≤ 시작 < 끝 ≤ 음원 길이로 입력하세요.');
 return [start,end];
}
export function repairRoundingSlivers(parts){
 const result=parts.map(s=>({...s}));let removed=0;
 for(let i=1;i<result.length-1;){
  const left=result[i-1],s=result[i],right=result[i+1];
  if(s.end-s.start<=.000500001&&s.start.toFixed(3)===s.end.toFixed(3)&&segmentLabel(left)===segmentLabel(right)){
   left.end=right.end;result.splice(i,2);removed++;i=Math.max(1,i-1);
  }else i++;
 }
 return {parts:result,removed};
}
export function paint(parts,start,end,label){
 const duration=parts.at(-1).end;
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=end||end>duration)throw Error('0 ≤ 시작 < 끝 ≤ 음원 길이로 입력하세요.');
 const next=[];let inserted=false;
 for(const s of parts){
  if(s.end<=start||s.start>=end){next.push({...s});continue;}
  if(s.start<start)next.push({...s,id:id(),end:start});
  if(!inserted){next.push({id:id(),start,end,label:label==='steam_purge'?'non_steam':label,...(label==='steam_purge'?{endSignal:'steam_purge'}:{})});inserted=true;}
  if(s.end>end)next.push({...s,id:id(),start:end});
 }
 const merged=[];
 for(const s of next){const last=merged.at(-1);if(last&&segmentLabel(last)===segmentLabel(s)&&Math.abs(last.end-s.start)<1e-8)last.end=s.end;else merged.push(s);}
 return merged;
}
export function split(parts,time){
 const i=parts.findIndex(s=>s.start<time-1e-6&&time<s.end-1e-6);
 if(i<0)throw Error('구간 내부의 재생 위치에서 나눌 수 있어요.');
 return parts.flatMap((s,j)=>j===i?[{...s,id:id(),end:time},{...s,id:id(),start:time}]:[{...s}]);
}
