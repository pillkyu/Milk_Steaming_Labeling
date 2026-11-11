// Same 48 kHz / FFT 2048 / hop 512 spectral contract as ChicV2FeatureExtractor.
export const featureVersion='chic273-median256-v1';
export const soundLabels=['normal_air','surface_sputter','metallic_squeal','balanced_rolling','steam_start','steam_end','steam_purge','non_steam','excess_bubbling'];
export const soundLabel=s=>s.endSignal==='steam_purge'?'steam_purge':s.label;
export const median=values=>{const a=Array.from(values).sort((a,b)=>a-b),n=a.length;return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2;};
const N=2048,HOP=512,RATE=48000;
const edges=[200,500,1000,2000,3000,4000,5000,6000,7000,8000,9000,10000,11000,12000,13000,14000,15000,16000];
const indices=[0,1,2,3,4,5,6,7,8,29,...Array.from({length:17},(_,i)=>i+12)];
const window=Float64Array.from({length:N},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(N-1)));
const norm=2/(N*window.reduce((s,v)=>s+v*v,0));
const reverse=Uint16Array.from({length:N},(_,i)=>{let v=0;for(let j=0;j<11;j++){v=v*2+(i&1);i>>=1;}return v;});
const cos=Float64Array.from({length:N/2},(_,i)=>Math.cos(-2*Math.PI*i/N));
const sin=Float64Array.from({length:N/2},(_,i)=>Math.sin(-2*Math.PI*i/N));
const db=p=>10*Math.log10(Math.max(p,1e-16));

export class Features {
 constructor(){this.re=new Float64Array(N);this.im=new Float64Array(N);this.rms=[];this.history=[];this.previous=null;}
 frame(pcm,offset){
  const re=this.re,im=this.im;let energy=0,peak=0,first=0,last=0;
  for(let i=0;i<N;i++){const v=pcm[offset+i],p=v*v;energy+=p;peak=Math.max(peak,Math.abs(v));if(i<512)first+=p/512;if(i>=N-512)last+=p/512;re[reverse[i]]=v*window[i];im[reverse[i]]=0;}
  for(let size=2;size<=N;size*=2){const half=size/2,stride=N/size;for(let start=0;start<N;start+=size)for(let j=0;j<half;j++){
   const a=start+j,b=a+half,k=j*stride,tr=cos[k]*re[b]-sin[k]*im[b],ti=sin[k]*re[b]+cos[k]*im[b];
   re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
  }}
  const bands=new Float64Array(17);let total=0,weighted=0,maximum=0,high=0,lower=0,upper=0,sum=0,logs=0,count=0,lowSum=0,lowLogs=0,lowCount=0;
  for(let k=1;k<N/2;k++){
   const hz=k*RATE/N,p=re[k]*re[k]+im[k]*im[k];
   if(hz>=200&&hz<16000){total+=p;weighted+=p*hz;maximum=Math.max(maximum,p);let b=0;while(hz>=edges[b+1])b++;bands[b]+=p;}
   if(hz>=4000&&hz<12000)high+=p;if(hz>=4000&&hz<8000)lower+=p;if(hz>=12000&&hz<16000)upper+=p;
   if(hz>=2000&&hz<12000){sum+=p;logs+=Math.log(Math.max(p,1e-30));count++;}
   if(hz>=2000&&hz<4000){lowSum+=p;lowLogs+=Math.log(Math.max(p,1e-30));lowCount++;}
  }
  const fractions=Array.from(bands,p=>p/Math.max(total,1e-30)),rmsDB=db(energy/N);
  this.rms.push(rmsDB);if(this.rms.length>94)this.rms.shift();
  const rmsMean=this.rms.reduce((s,v)=>s+v,0)/this.rms.length;
  const modulation=Math.sqrt(this.rms.reduce((s,v)=>s+(v-rmsMean)**2,0)/this.rms.length);
  const flux=this.previous?fractions.reduce((s,v,i)=>s+Math.abs(v-this.previous[i]),0):0;
  const base=[db(high*norm)-rmsDB,high/Math.max(total,1e-30),sum>1e-25?Math.exp(logs/count)/(sum/count):0,
   db(upper*norm)-db(lower*norm),-fractions.reduce((s,v)=>s+v*Math.log(Math.max(v,1e-30)),0)/Math.log(17),
   peak/Math.max(Math.sqrt(energy/N),1e-8),10*Math.log10(Math.max(last,1e-16)/Math.max(first,1e-16)),
   weighted/Math.max(total,1e-30)/16000,maximum/Math.max(total,1e-30),modulation,
   Math.exp(lowLogs/lowCount)/Math.max(lowSum/lowCount,1e-30),Math.max(...this.rms)-Math.min(...this.rms),
   ...fractions.map(v=>10*Math.log10(Math.max(v,1e-8))),flux];
  this.previous=fractions;const selected=indices.map(i=>base[i]);this.history.push(selected);if(this.history.length>38)this.history.shift();
  const result=[...base];
  for(const count of [5,14,38]){
   const values=this.history.slice(-count),mean=new Float64Array(27),square=new Float64Array(27);
   for(const row of values)for(let i=0;i<27;i++){mean[i]+=row[i]/values.length;square[i]+=row[i]*row[i]/values.length;}
   result.push(...mean,...Array.from(mean,(v,i)=>Math.sqrt(Math.max(0,square[i]-v*v))),...selected.map((v,i)=>v-mean[i]));
  }
  return result;
 }
}

export function sampleFrames(start,end,length){
 const first=Math.ceil(start*RATE/HOP),last=Math.min(Math.ceil((end*RATE-N)/HOP)-1,Math.floor((length-N)/HOP));
 const count=Math.max(0,last-first+1),take=Math.min(256,count);
 return Array.from({length:take},(_,i)=>first+(take===1?0:Math.floor(i*(count-1)/(take-1))));
}

export function extractSegments(pcm,segments,progress=()=>{}){
 if(!(pcm instanceof Float32Array)||!pcm.length||pcm.length>RATE*900||pcm.some(v=>!Number.isFinite(v)))throw Error('분석할 음원 형식이 올바르지 않습니다.');
 const targets=segments.filter(s=>soundLabels.includes(soundLabel(s))).map(s=>({...s,label:soundLabel(s),frames:sampleFrames(s.start,s.end,pcm.length)}));
 const wanted=new Map();for(const s of targets)for(const frame of s.frames){if(!wanted.has(frame))wanted.set(frame,[]);wanted.get(frame).push(s);}
 // shortcut: at most 256 evenly spaced frames per interval; revisit for transient-level detection.
 const collected=new Map(targets.map(s=>[s.id,[]])),vectors=new Map(),extractor=new Features();
 for(let offset=0,frame=0;offset+N<=pcm.length;offset+=HOP,frame++){
  const x=extractor.frame(pcm,offset);for(const target of wanted.get(frame)||[]){
   const rows=collected.get(target.id);rows.push(x);
   if(frame===target.frames.at(-1)){vectors.set(target.id,Array.from({length:273},(_,i)=>median(rows.map(r=>r[i]))));collected.delete(target.id);}
  }
  if(frame%500===0)progress(offset/pcm.length);
 }
 return targets.map(s=>({id:s.id,start:s.start,end:s.end,label:s.label,vector:vectors.get(s.id)||null}));
}
