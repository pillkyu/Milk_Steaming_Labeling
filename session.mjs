import {repository,maxBytes,maxSeconds} from './config.mjs';
import {GitHubStore} from './github.mjs';
import {blankReview,sha256,validateRecord} from './records.mjs';

function openDrafts(){return new Promise((resolve,reject)=>{
 const request=indexedDB.open('milk-steaming-drafts',1);
 request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'key'});
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('브라우저 임시 저장소를 열 수 없습니다. 일반 브라우저 창에서 다시 시도하세요.'));
});}
function transaction(db,method,value){return new Promise((resolve,reject)=>{
 const tx=db.transaction('drafts',method==='getAll'?'readonly':'readwrite');
 const request=tx.objectStore('drafts')[method](value);
 tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(Error('브라우저 임시 저장 실패: 저장 공간을 확인하고 작업 백업을 내려받으세요.'));
});}

export class Session {
 constructor(store,db,schema){this.store=store;this.db=db;this.schema=schema;this.entries=new Map();this.urls=new Map();this.prefix=`${repository}:${store.user.id}:`;}
 async load(){
  const remote=await this.store.list();for(const e of remote)this.entries.set(e.record.source.id,{...e,dirty:false});
  const drafts=await transaction(this.db,'getAll');
  for(const local of drafts.filter(e=>e.key.startsWith(this.prefix))){
   validateRecord(local.record,this.schema);
   const current=this.entries.get(local.record.source.id);
   if(local.dirty)this.entries.set(local.record.source.id,{...local,audioSha:current?.audioSha||local.audioSha});
  }
 }
 sources(){return [...this.entries.values()].map(e=>e.record.source);}
 async remember(id,review){
  const e=this.entries.get(id);e.record.review=structuredClone(review);e.dirty=true;
  await transaction(this.db,'put',{...e,key:this.prefix+id});
 }
 async add(file){
  const ext=file.name.split('.').at(-1).toLowerCase();
  if(!['m4a','wav','mp3','aac','flac','ogg','aiff','aif'].includes(ext))throw Error('지원하는 녹음 파일을 선택하세요.');
  if(!file.size||file.size>maxBytes)throw Error('파일당 20MiB 이하여야 합니다.');
  if(file.name.length>400)throw Error('파일 이름이 너무 깁니다.');
  const bytes=await file.arrayBuffer(),id=await sha256(bytes);
  if(this.entries.has(id))return {id,duplicate:true};
  const context=new AudioContext({sampleRate:48000});let audio;
  try{audio=await context.decodeAudioData(bytes.slice(0));}catch{throw Error('이 브라우저에서 재생할 수 없는 음원입니다. WAV·MP3·M4A로 변환 후 올려 주세요.');}finally{await context.close();}
  if(!Number.isFinite(audio.duration)||audio.duration<=0||audio.duration>maxSeconds)throw Error('녹음은 15분 이하여야 합니다.');
  const waveform=[],step=Math.ceil(audio.length/2200),channels=Array.from({length:audio.numberOfChannels},(_,c)=>audio.getChannelData(c));
  for(let i=0;i<audio.length;i+=step){let peak=0;const end=Math.min(i+step,audio.length);for(let j=i;j<end;j++){let value=0;for(const c of channels)value+=c[j]/channels.length;if(!Number.isFinite(value))throw Error('올바르지 않은 음원 값입니다.');peak=Math.max(peak,Math.abs(value));}waveform.push([(i+end)/2/audio.sampleRate,peak]);}
  const source={id,kind:'recording',datasetGroup:'home',title:file.name,originalFilename:file.name,originalSHA256:id,originalAudio:`recordings/${id}/original.${ext}`,bytes:file.size,duration:audio.duration,decodedSampleRate:audio.sampleRate,sourceGroup:`upload-${id}`,channel:this.store.user.login,waveform,legacySegments:[]};
  const record={schema:'milk-steaming-record-v1',labelSchema:this.schema.schema,source,review:blankReview(audio.duration),uploadedBy:this.store.user.login,createdAt:new Date().toISOString()};
  validateRecord(record,this.schema);
  const entry={record,original:file,sha:null,dirty:true,key:this.prefix+id};
  await transaction(this.db,'put',entry);this.entries.set(id,entry);
  return {id,duplicate:false};
 }
 async media(id){
  if(!this.urls.has(id)){
   const e=this.entries.get(id),blob=e.original||await this.store.audio(e);
   if(!this.urls.has(id))this.urls.set(id,URL.createObjectURL(blob));
  }
  return this.urls.get(id);
 }
 async save(id,review){
  const entry=this.entries.get(id);
  const record={...entry.record,review:structuredClone(review),updatedBy:this.store.user.login,updatedAt:new Date().toISOString()};
  const saved=await this.store.save(record,entry.original,entry.sha);
  Object.assign(entry,saved,{record,dirty:false});
  await transaction(this.db,'delete',this.prefix+id);
  delete entry.original;
 }
 async reload(id){
  const entry=(await this.store.list()).find(e=>e.record.source.id===id);
  if(!entry)throw Error('아직 GitHub에 저장되지 않은 음원입니다. 현재 작업을 유지합니다.');
  await transaction(this.db,'delete',this.prefix+id);
  this.entries.set(id,{...entry,dirty:false});return entry.record.review;
 }
 close(){this.store.token='';for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();this.db.close();}
}

export async function connect(){
 const schema=await fetch('./labels.json').then(r=>{if(!r.ok)throw Error('라벨 정의를 불러오지 못했습니다.');return r.json();});
 document.getElementById('repository-name').textContent=repository;
 return new Promise(resolve=>{
  const form=document.getElementById('connect-form'),button=document.getElementById('connect-button'),input=document.getElementById('access-token'),message=document.getElementById('connect-message');
  form.onsubmit=async event=>{
   event.preventDefault();button.disabled=true;message.textContent='권한과 저장된 자료를 확인하고 있습니다…';
   const store=new GitHubStore(repository,input.value.trim(),schema);input.value='';
   try{
    const user=await store.connect(),session=new Session(store,await openDrafts(),schema);await session.load();
    document.getElementById('account').textContent=user.login;
    document.getElementById('connection').hidden=true;document.getElementById('application').inert=false;
    document.getElementById('disconnect').onclick=()=>{if([...session.entries.values()].some(e=>e.dirty)&&!confirm('저장하지 않은 작업은 이 브라우저에 남습니다. 연결을 종료할까요?'))return;session.close();location.reload();};
    resolve(session);
   }catch(e){store.token='';message.textContent=e.message;button.disabled=false;input.focus();}
  };
  button.disabled=false;
 });
}
