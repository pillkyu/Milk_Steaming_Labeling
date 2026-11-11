import {paint,commitRange,dragRange,rangeBounds,segmentLabel} from './segments.mjs?v=20261106-purge';
const $=id=>document.getElementById(id),video=$('video'),clone=v=>structuredClone(v),fmt=n=>Number(n).toFixed(3);
import {connect} from './session.mjs';
import {checkBeforeSave} from './feedback-ui.mjs';
import {retainChecks} from './feedback.mjs';
const session=await connect(),labelSchema=session.schema;
const bootstrap={dataset:{datasetId:'milk-steaming-home-v1',labelSchema,files:session.sources()},reviews:{datasetId:'milk-steaming-home-v1',files:Object.fromEntries([...session.entries].map(([id,e])=>[id,e.record.review]))}};
const definitions=[...labelSchema.classes,...labelSchema.annotationOnly],names=Object.fromEntries(definitions.map(d=>[d.id,d.name])),colors=Object.fromEntries(definitions.map(d=>[d.id,d.color])),shortNames=Object.fromEntries(definitions.map(d=>[d.id,d.short]));
const steamLabels=new Set([...labelSchema.classes.filter(d=>d.isSteaming!==false),...definitions.filter(d=>d.isSteamingCandidate)].map(d=>d.id));
const draftLabels=new Set(definitions.filter(d=>d.isCandidate).map(d=>d.id));
const selectableDefinitions=definitions.filter(d=>labelSchema.classes.includes(d)||d.id==='steam_purge');
$('label-options').innerHTML=selectableDefinitions.map(d=>`<button data-label="${d.id}" style="--label-color:${d.color}" aria-pressed="false" title="${d.description}"><i></i><span>${d.name}</span><kbd>${d.key}</kbd></button>`).join('');
const strengthNames={weak:'약함',medium:'보통',strong:'강함',mixed:'섞임'};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let uploading=false,saving=false,checking=false;
let DATA,files=[],working={},revisions={},selected=0,ready=false,failed=false,pending=0,queue=Promise.resolve();
let viewStart=0,viewEnd=1,draft=emptyDraft(),clipEnd=null,timer=0,raf=0,playToken=0,toastTimer=0;
const drafts=new Map(),histories=new Map();
const source=()=>files[selected],review=()=>working[source().id];
const recordingIndex=f=>f.id.slice(0,8);
const sourceIndex=(id,time=0)=>files.findIndex(f=>f.id===id||(f.parentSourceId===id&&f.parentStart<=time&&time<f.parentEnd));
function emptyDraft(){return {start:null,end:null,label:'normal_air',count:'',strength:'',origin:null,dirty:false};}
function validRange(){return ready&&Number.isFinite(draft.start)&&Number.isFinite(draft.end)&&draft.start>=0&&draft.start<draft.end&&draft.end<=source().duration;}
function anyDraft(){return draft.dirty||[...drafts.entries()].some(([id,d])=>id!==source()?.id&&d.dirty);}
function toast(text,error=false){$('toast').textContent=text;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function status(){
 const dirty=[...session.entries.values()].filter(e=>e.dirty).length;
 $('save-state').textContent=checking?'저장 전 소리 확인 중…':saving?'GitHub에 저장 중…':pending?'브라우저에 임시 보관 중…':failed?'임시 보관 실패 · 작업 백업 필요':dirty?`${dirty}개 음원 · GitHub 저장 필요`:ready&&anyDraft()?'구간 편집 중':'GitHub 저장 완료';
 $('save-state').classList.toggle('error',failed);
 $('save-record').disabled=!ready||saving||uploading||pending>0||anyDraft();
 $('complete').disabled=!ready||saving||uploading||pending>0;
}
function persist(fid){
 const snapshot=clone(working[fid]);pending++;status();
 queue=queue.then(async()=>{
  try{await session.remember(fid,snapshot);failed=false;return true;}
  catch(e){failed=true;toast(e.message,true);return false;}
  finally{pending--;status();}
 });return queue;
}
async function saveRemote(complete=false){
 if(!ready||saving||uploading)return;
 $('note').blur();
 if(draft.dirty){toast('편집 중인 구간을 먼저 적용하거나 선택을 취소하세요.',true);return;}
 await queue;
 const id=source().id;
 if(complete){
  const value=working[id];
  if(!value.excluded&&!value.segments.some(s=>labelSchema.classes.some(d=>d.id===s.label))){toast('확정 구간을 지정하거나 사용 제외로 표시하세요.',true);return;}
 }
 $('error').hidden=true;saving=true;checking=true;pending++;stopPlayback();document.querySelector('.app-layout').inert=true;status();
 try{
  const checked=await checkBeforeSave(session,id,working[id],names);
  checking=false;status();
  if(!checked)return;
  if(checked.edit){const i=working[id].segments.findIndex(s=>s.id===checked.edit.id);if(i>=0)selectPart(i,checked.edit.start,checked.edit.end);return;}
  working[id]=checked.review;if(complete)working[id].reviewed=true;
  await persist(id);
  await session.save(id,working[id]);failed=false;
  toast((complete?'검수 완료 · 음원과 라벨을 GitHub에 저장했습니다.':'음원과 라벨을 GitHub에 저장했습니다.')+(checked.notice?' '+checked.notice:''));
 }catch(e){toast(e.message,true);$('error').textContent=e.message;$('error').hidden=false;}
 finally{saving=false;checking=false;pending--;document.querySelector('.app-layout').inert=false;renderSources();renderFileState();status();}
}
$('save-record').onclick=()=>saveRemote();
$('reload-record').onclick=async()=>{
 if(!ready||saving)return;
 if(!confirm('현재 음원의 임시 작업을 최신 GitHub 저장본으로 교체할까요? 필요한 작업은 먼저 백업하세요.'))return;
 const id=source().id;saving=true;document.querySelector('.app-layout').inert=true;status();
 try{await queue;working[id]=clone(await session.reload(id));drafts.delete(id);histories.delete(id);failed=false;$('error').hidden=true;await choose(selected);toast('최신 저장본을 불러왔습니다.');}
 catch(e){toast(e.message,true);}
 finally{saving=false;document.querySelector('.app-layout').inert=false;status();}
};
function history(){const id=source().id;if(!histories.has(id))histories.set(id,{undo:[],redo:[]});return histories.get(id);}
function snapshot(){return {value:clone(review()),draft:clone(draft)};}
function backup(forCommit=false){
 const h=history(),previous=snapshot();
 if(forCommit){
  const origin=draft.origin,e=origin?review().airEvents.find(e=>e.start===origin.start&&e.end===origin.end):null;
  previous.draft=origin?{start:origin.start,end:origin.end,label:segmentLabel(origin),count:e?.count??'',strength:e?.strength??'',origin:clone(origin),dirty:false}:emptyDraft();
 }
 h.undo.push(previous);if(h.undo.length>40)h.undo.shift();h.redo=[];
}
function changed(){review().reviewed=false;retainChecks(review());drafts.set(source().id,clone(draft));persist(source().id);renderSources();renderFileState();renderRegions();renderInspector();renderTimeline();}
function travel(direction){
 const h=history(),from=h[direction],to=h[direction==='undo'?'redo':'undo'];if(!from.length)return;
 to.push(snapshot());const previous=from.pop();stopPlayback();working[source().id]=previous.value;review().reviewed=false;draft=previous.draft;
 changed();toast(direction==='undo'?'직전 변경을 되돌렸습니다.':'변경을 다시 실행했습니다.');
}
function renderFileState(){
 $('review-badge').textContent=review().excluded?'학습 제외':review().reviewed?'검수 완료':'검수 중';$('review-badge').classList.toggle('done',review().reviewed&&!review().excluded);
 $('note').value=review().note;$('excluded').checked=review().excluded;$('steam-presence').value=review().steamPresence||'unsure';
 $('undo').disabled=!history().undo.length;$('redo').disabled=!history().redo.length;
 const known=review().segments.filter(p=>names[p.label]&&p.label!=='unknown'&&p.label!=='exclude'&&!draftLabels.has(p.label)).reduce((n,p)=>n+p.end-p.start,0);
 $('presence-detail').textContent=review().excluded?'이 자료는 학습에서 제외됩니다.':`라벨 지정 ${fmt(known)}초 / ${fmt(source().duration)}초`;
}

function visibleIndices(){
 const filter=$('filter').value,query=$('search').value.trim().toLowerCase();
 return files.map((f,i)=>({f,i})).filter(({f})=>(!query||(f.title+' '+f.channel+' '+recordingIndex(f)).toLowerCase().includes(query))&&(filter==='all'||filter==='pending'&&!working[f.id].reviewed&&!working[f.id].excluded||filter==='reviewed'&&working[f.id].reviewed&&!working[f.id].excluded||filter==='excluded'&&working[f.id].excluded)).map(v=>v.i);
}
function renderSources(){
 const done=files.filter(f=>working[f.id].reviewed&&!working[f.id].excluded).length;
 $('progress').textContent=`${done} / ${files.length}개 검수 완료`;
 const visible=visibleIndices();
 $('source-list').innerHTML=visible.map(i=>{const f=files[i];return `<button class="source ${i===selected?'active':''}" data-source="${i}"><span class="source-top"><span class="source-kind">녹음 ${recordingIndex(f)} · ${fmt(f.duration)}초</span><span class="${working[f.id].reviewed?'done':''}">${working[f.id].excluded?'제외':working[f.id].reviewed?'✓ 완료':'대기'}</span></span><span class="source-title">${esc(f.title)}</span></button>`;}).join('')||'<p class="muted">이 조건에 해당하는 자료가 없습니다.</p>';
 const position=visible.indexOf(selected);$('prev').disabled=position<=0;$('next').disabled=position<0||position>=visible.length-1;
}
function navigate(delta){const list=visibleIndices(),position=list.indexOf(selected),next=position<0?list[0]:list[position+delta];if(next!==undefined)choose(next);}

function renderInspector(){
 $('selection-heading').textContent=draft.origin?'기존 구간 편집':draft.start!==null?'새 구간':'구간 만들기';
 $('label-description').textContent=definitions.find(d=>d.id===draft.label)?.description||'';
 $('selection-hint').textContent=draft.origin?(segmentLabel(draft.origin)===draft.label?'같은 라벨의 경계를 변경하면 원래 범위의 남는 부분은 미라벨로 바뀝니다.':'선택한 범위의 라벨만 바꾸며, 바깥 구간은 그대로 유지합니다.'):draft.start!==null&&draft.end===null?'시작을 찍었습니다. 재생한 뒤 O로 끝을 찍으세요.':'타임라인 드래그 또는 I → O로 범위를 만드세요.';
 $('start').value=draft.start===null?'':fmt(draft.start);$('end').value=draft.end===null?'':fmt(draft.end);
 $('duration').textContent=validRange()?`${fmt(draft.end-draft.start)}초 선택됨`:draft.start===null?'선택한 구간 없음':'끝 지점을 지정하세요';
 document.querySelectorAll('[data-label]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.label===draft.label));
 $('air-fields').hidden=draft.label!=='normal_air';$('air-count').value=draft.count;$('air-strength').value=draft.strength;
 $('apply').disabled=!ready||failed||!validRange()||!selectableDefinitions.some(d=>d.id===draft.label);$('apply').innerHTML=(draft.origin?'변경 적용':'새 구간 적용')+' <kbd>Enter</kbd>';
 $('delete-region').disabled=!draft.origin;$('play-selection').disabled=!validRange();$('clear-selection').disabled=draft.start===null;
 $('edit-state').textContent=draft.dirty?'● 아직 적용하지 않은 구간입니다.':draft.origin?'적용된 구간 · 수정하면 Enter로 적용':'1–5 소리 · 6 시작 · 7 종료 · C 청소 방출 · 0 비스티밍';
 status();
}
function regionPieces(){
 const pieces=[];
 for(const [i,s] of review().segments.entries()){
  if(s.label==='unknown')continue;
  const records=s.label==='normal_air'?review().airEvents.filter(e=>e.start>=s.start&&e.end<=s.end):[];let cursor=s.start;
  for(const e of records){if(cursor<e.start)pieces.push({i,start:cursor,end:e.start});pieces.push({i,start:e.start,end:e.end,event:e});cursor=e.end;}
  if(cursor<s.end)pieces.push({i,start:cursor,end:s.end});
 }
 return pieces;
}
function renderRegions(){
 const pieces=regionPieces();$('region-count').textContent=pieces.length+'개';
 $('regions').innerHTML=pieces.map(p=>{
  const s=review().segments[p.i],e=p.event,meta=e?[e.count===null?'':e.count+'회',strengthNames[e.strength]||''].filter(Boolean).join(' · '):'';
  const active=draft.origin&&draft.origin.start===p.start&&draft.origin.end===p.end;
  return `<button class="region ${active?'active':''}" data-part="${p.i}" data-start="${p.start}" data-end="${p.end}" style="border-left-color:${colors[segmentLabel(s)]}">${names[segmentLabel(s)]}<span>${fmt(p.start)} → ${fmt(p.end)}초${meta?' · '+meta:''}</span></button>`;
 }).join('')||'<p class="muted" style="padding:10px 0">아직 마킹한 구간이 없습니다.</p>';

}
function topInspector(){document.querySelector('.inspector-content').scrollTop=0;}
function clearSelection(){topInspector();draft=emptyDraft();drafts.set(source().id,clone(draft));renderInspector();renderRegions();drawSelection();}
function selectPart(i,start=null,end=null){
 const s=review().segments[i];if(!s)return;stopPlayback();start??=s.start;end??=s.end;
 const e=review().airEvents.find(e=>Math.abs(e.start-start)<1e-8&&Math.abs(e.end-end)<1e-8);
 draft={start,end,label:segmentLabel(s),count:e?.count??'',strength:e?.strength??'',origin:{...clone(s),start,end},dirty:false};
 renderInspector();renderRegions();drawSelection();topInspector();seek(start);
}
function previewRangeInput(){
 const a=$('start').value,b=$('end').value,before=[draft.start,draft.end];
 try{if(a!==''&&b!=='')[draft.start,draft.end]=rangeBounds(review().segments,a,b,validRange()?[draft.start,draft.end]:null);
 else{draft.start=a===''?null:Number(a);draft.end=b===''?null:Number(b);}}
 catch{draft.start=a===''?null:Number(a);draft.end=b===''?null:Number(b);}
 if(draft.origin&&(before[0]!==draft.start||before[1]!==draft.end)){draft.count='';draft.strength='';$('air-count').value='';$('air-strength').value='';}
 draft.dirty=true;
 $('duration').textContent=validRange()?`${fmt(draft.end-draft.start)}초 선택됨`:'시작과 끝을 지정하세요.';
 $('apply').disabled=!ready||failed||!validRange()||!selectableDefinitions.some(d=>d.id===draft.label);$('play-selection').disabled=!validRange();$('clear-selection').disabled=false;
 $('edit-state').textContent='● 아직 적용하지 않은 구간입니다.';drawSelection();status();
}
function readInputs(edge=null){
 const before=[draft.start,draft.end];const a=$('start').value,b=$('end').value;
 if(a===''||b===''){draft.start=a===''?null:Number(a);draft.end=b===''?null:Number(b);}
 else [draft.start,draft.end]=rangeBounds(review().segments,a,b,validRange()?[draft.start,draft.end]:null);
 if(draft.origin&&(before[0]!==draft.start||before[1]!==draft.end)){draft.count='';draft.strength='';}
 draft.dirty=true;renderInspector();drawSelection();if(edge&&Number.isFinite(draft[edge])){stopPlayback();seek(draft[edge]);}
}
function apply(){try{
 if(!validRange())throw Error('먼저 시작과 끝을 지정하세요.');
 if(!selectableDefinitions.some(d=>d.id===draft.label))throw Error('소리 라벨을 선택하세요.');
 const count=draft.label==='normal_air'&&draft.count!==''?Number(draft.count):null,strength=draft.label==='normal_air'?draft.strength||null:null;
 if(count!==null&&(!Number.isInteger(count)||count<1||count>10000))throw Error('횟수는 1~10000 사이 정수로 입력하세요.');
 backup(true);stopPlayback();const {start,end,label}=draft;if(steamLabels.has(label))review().steamPresence='yes';
 const next=commitRange(review().segments,review().airEvents,start,end,label,count,strength,draft.origin);Object.assign(review(),next);
 draft.origin={...clone(review().segments.find(s=>s.start<=start&&s.end>=end)),start,end};draft.dirty=false;
 changed();toast(`${fmt(start)}–${fmt(end)}초 · ${names[label]} 저장`);
 }catch(e){toast(e.message,true);}}
function deleteRegion(){if(!draft.origin)return;backup(true);stopPlayback();const s=draft.origin;
 Object.assign(review(),commitRange(review().segments,review().airEvents,s.start,s.end,'unknown'));draft=emptyDraft();changed();toast('구간을 지웠습니다. 해당 부분은 미라벨로 남습니다.');
}
async function choose(i){
 if(!files[i])return;
 if(ready&&files[selected])drafts.set(source().id,clone(draft));stopPlayback();selected=i;ready=true;$('empty-state').hidden=true;document.querySelector('.editor').hidden=false;
 const f=source();draft=clone(drafts.get(f.id)||emptyDraft());viewStart=0;viewEnd=f.duration;
 $('title').textContent=f.title;$('file-index').textContent=`녹음 ${recordingIndex(f)} · ${f.channel}`;
 video.removeAttribute('src');video.load();video.playbackRate=Number($('speed').value);
 document.querySelector('.video-stage').classList.add('audio-only');$('recording-stage').hidden=false;$('recording-title').textContent=f.title;
 $('video-warning').hidden=true;
 $('source-evidence').textContent='구간을 적용한 뒤 작업 저장 또는 검수 완료를 누르세요.';
 try{localStorage.setItem('puffin.five.selected',f.id);}catch{}
 renderSources();renderFileState();renderInspector();renderRegions();renderTimeline();topInspector();updateTime();
 if(innerWidth<1151)toggleLibrary(false);
 try{const url=await session.media(f.id);if(source()?.id===f.id){video.src=url;video.load();}}catch(e){if(source()?.id===f.id){$('video-warning').hidden=false;$('video-warning').textContent=e.message;}}
}
function toggleLibrary(open=!$('library').classList.contains('open')){$('library').classList.toggle('open',open);$('library-toggle').setAttribute('aria-expanded',open);}
function seek(t){cancelClip();video.currentTime=Math.max(0,Math.min(source().duration,t));updateTime();}
function cancelClip(){clipEnd=null;clearTimeout(timer);playToken++;}
function stopPlayback(){cancelClip();video.pause();cancelAnimationFrame(raf);}
function finishClip(){
 const end=clipEnd;if(end===null)return;
 if($('loop').checked&&validRange()){stopPlayback();video.currentTime=draft.start;clipEnd=draft.end;const token=++playToken;video.play().then(()=>{if(token===playToken)scheduleClip();}).catch(e=>toast('구간 재생 실패: '+e.message,true));return;}
 stopPlayback();video.currentTime=end;updateTime();
}

function scheduleClip(){clearTimeout(timer);if(clipEnd===null||video.paused)return;const left=clipEnd-video.currentTime;if(left<=0){finishClip();return;}timer=setTimeout(()=>{if(clipEnd!==null&&video.currentTime>=clipEnd-.005)finishClip();else scheduleClip();},Math.max(10,left/video.playbackRate*1000));}
function updateTime(){
 if(!ready)return;const t=video.currentTime||0;$('time').textContent=`${fmt(t)} / ${fmt(source().duration)}`;$('play').textContent=video.paused?'▶':'Ⅱ';
 const cursor=$('cursor');if(cursor){const x=timeX(t);cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);}
}
function tick(){if(clipEnd!==null&&video.currentTime>=clipEnd){finishClip();return;}updateTime();if(!video.paused)raf=requestAnimationFrame(tick);}
async function togglePlay(){try{if(video.paused){cancelClip();await video.play();}else stopPlayback();}catch(e){toast('재생 실패: '+e.message,true);}}
async function playSelection(){if(!validRange())return;try{stopPlayback();const token=playToken;video.currentTime=draft.start;clipEnd=draft.end;await video.play();if(token===playToken)scheduleClip();}catch(e){stopPlayback();toast('재생 실패: '+e.message,true);}}
function step(delta){stopPlayback();seek((video.currentTime||0)+delta);}
function markIn(){const t=Math.min(video.currentTime||0,source().duration);if(t>=source().duration){toast('음원 끝보다 앞에서 시작을 찍으세요.',true);return;}draft={...emptyDraft(),start:t,label:draft.label,dirty:true};topInspector();renderInspector();renderRegions();drawSelection();}
function markOut(){const t=Math.min(video.currentTime||0,source().duration);if(draft.start===null||t<=draft.start){toast('I로 시작을 찍고, 그보다 뒤에서 O로 끝을 찍으세요.',true);return;}stopPlayback();if(draft.origin&&draft.end!==t){draft.count='';draft.strength='';}draft.end=t;draft.dirty=true;topInspector();renderInspector();drawSelection();}
function timeX(t){return 16+(t-viewStart)/(viewEnd-viewStart)*($('timeline').clientWidth-32);}
function changeView(start,end){const duration=source().duration,width=Math.min(duration,Math.max(.08,end-start));viewStart=Math.max(0,Math.min(duration-width,start));viewEnd=viewStart+width;renderTimeline();}
function zoom(factor,anchor=validRange()?(draft.start+draft.end)/2:video.currentTime||0){const width=(viewEnd-viewStart)*factor,ratio=Math.max(0,Math.min(1,(anchor-viewStart)/(viewEnd-viewStart)));changeView(anchor-width*ratio,anchor+width*(1-ratio));}
function drawSelection(){
 const svg=$('timeline').querySelector('svg');if(!svg)return;
 const valid=validRange(),a=valid?timeX(draft.start):0,b=valid?timeX(draft.end):0,shade=svg.querySelector('#selection');
 shade.style.display=valid?'':'none';shade.setAttribute('x',Math.max(16,a));shade.setAttribute('width',Math.max(0,Math.min(svg.viewBox.baseVal.width-16,b)-Math.max(16,a)));
 for(const [edge,t] of [['start',draft.start],['end',draft.end]]){const handle=svg.querySelector(`[data-edge="${edge}"]`);handle.style.display=valid&&t>=viewStart&&t<=viewEnd?'':'none';handle.setAttribute('transform',`translate(${valid?timeX(t):0},0)`);handle.setAttribute('aria-valuenow',t??0);handle.setAttribute('aria-valuetext',t===null?'미지정':fmt(t)+'초');}
 updateTime();
}
function renderTimeline(){
 if(!ready)return;const W=$('timeline').clientWidth,H=$('timeline').clientHeight;if(W<1||H<1)return;
 const f=source(),x=timeX,bandY=H*.61,bandH=Math.max(24,H*.18),bottom=H-4;
 let svg=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="group" aria-label="파형과 마킹 구간"><defs><clipPath id="plot"><rect x="16" y="0" width="${W-32}" height="${H}"/></clipPath></defs>`;
 for(let i=0;i<=5;i++){const t=viewStart+(viewEnd-viewStart)*i/5;svg+=`<line x1="${x(t)}" x2="${x(t)}" y1="24" y2="${bottom}" stroke="#283644"/><text x="${x(t)}" y="16" font-size="10" fill="#91a6b8" text-anchor="${i===0?'start':i===5?'end':'middle'}">${t.toFixed(viewEnd-viewStart<1?3:2)}s</text>`;}
 svg+='<g clip-path="url(#plot)">';const wave=f.waveform.filter(w=>w[0]>=viewStart&&w[0]<=viewEnd),step=Math.max(1,Math.ceil(wave.length/(W-32)));const reduced=[];
 for(let i=0;i<wave.length;i+=step){const g=wave.slice(i,i+step);reduced.push([g[0][0],Math.max(...g.map(w=>w[1]))]);}
 const mid=H*.34,amp=H*.20;svg+=`<polygon points="${reduced.map(w=>`${x(w[0])},${mid-w[1]*amp}`).join(' ')} ${reduced.slice().reverse().map(w=>`${x(w[0])},${mid+w[1]*amp}`).join(' ')}" fill="#829cb0" pointer-events="none"/>`;
 for(const [i,s] of review().segments.entries()){if(s.end<=viewStart||s.start>=viewEnd)continue;const a=Math.max(16,x(s.start)),b=Math.min(W-16,x(s.end));svg+=`<rect data-part="${i}" x="${a}" y="${bandY}" width="${b-a}" height="${bandH}" rx="3" fill="${colors[segmentLabel(s)]}" opacity="${s.label==='unknown'?'.35':'.9'}" stroke="#111820" stroke-width="1"/>`;if(b-a>76&&s.label!=='unknown')svg+=`<text x="${(a+b)/2}" y="${bandY+bandH/2+3}" font-size="10" text-anchor="middle" fill="#0e1c25" pointer-events="none">${shortNames[segmentLabel(s)]||names[segmentLabel(s)]}</text>`;}
 svg+=`<rect id="selection" y="25" height="${H-30}" fill="#83e3c1" fill-opacity=".09" stroke="#9ceccc" stroke-width="1.5" pointer-events="none"/><line id="cursor" y1="21" y2="${bottom}" stroke="#f2db9b" stroke-width="1.5" pointer-events="none"/>`;
 for(const edge of ['start','end'])svg+=`<g data-edge="${edge}" tabindex="0" role="slider" aria-label="${edge==='start'?'시작':'끝'} 경계 손잡이" aria-valuemin="0" aria-valuemax="${f.duration}"><rect x="-10" y="23" width="20" height="${H-26}" fill="transparent"/><line y1="25" y2="${bottom}" stroke="#9ceccc" stroke-width="2"/><rect x="-5" y="${H-20}" width="10" height="16" rx="3" fill="#9ceccc"/></g>`;
 svg+='</g></svg>';$('timeline').innerHTML=svg;drawSelection();
 $('view-info').textContent=`${fmt(viewStart)}–${fmt(viewEnd)}초`;$('pan').disabled=viewEnd-viewStart>=f.duration;$('pan').value=f.duration===viewEnd-viewStart?0:viewStart/(f.duration-(viewEnd-viewStart))*1000;$('pan-left').disabled=viewStart<=0;$('pan-right').disabled=viewEnd>=f.duration;
 const chart=$('timeline').querySelector('svg');let drag=null;
 const position=e=>{const box=chart.getBoundingClientRect();return Math.max(viewStart,Math.min(viewEnd,viewStart+(e.clientX-box.left-16)/(box.width-32)*(viewEnd-viewStart)));};
 chart.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,anchor:position(e),before:clone(draft),edge:e.target.closest('[data-edge]')?.dataset.edge,part:e.target.closest('[data-part]')?.dataset.part,moved:false};chart.setPointerCapture(e.pointerId);};
 chart.onpointermove=e=>{if(!drag||drag.id!==e.pointerId)return;if(!drag.moved&&Math.abs(e.clientX-drag.x)<3)return;if(!drag.moved){stopPlayback();if(!drag.edge)draft={...emptyDraft(),label:drag.before.label};else if(draft.origin){draft.count='';draft.strength='';}}drag.moved=true;
 const range=dragRange(drag.edge?[drag.before.start,drag.before.end]:[0,f.duration],drag.anchor,position(e),f.duration,drag.edge);
 if(range){[draft.start,draft.end]=range;draft.dirty=true;drawSelection();$('start').value=fmt(draft.start);$('end').value=fmt(draft.end);$('duration').textContent=fmt(draft.end-draft.start)+'초 선택됨';}
 };
 chart.onpointerup=e=>{if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;chart.releasePointerCapture(e.pointerId);
 if(d.moved){renderInspector();renderRegions();topInspector();seek(d.edge==='end'?draft.end:draft.start);return;}if(d.edge)return;
 if(d.part!==undefined&&review().segments[Number(d.part)].label!=='unknown'){const t=position(e),p=regionPieces().find(p=>p.i===Number(d.part)&&p.start<=t&&t<p.end);selectPart(Number(d.part),p?.start,p?.end);}else{stopPlayback();seek(position(e));}
 };
 chart.onpointercancel=()=>{if(drag){draft=drag.before;drag=null;renderInspector();drawSelection();}};
 chart.onkeydown=e=>{const edge=e.target.closest('[data-edge]')?.dataset.edge;if(!edge||!validRange()||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();e.stopPropagation();if(draft.origin){draft.count='';draft.strength='';}const t=draft[edge]+(e.key==='ArrowRight'?1:-1)*(e.shiftKey ? .1 : .01);[draft.start,draft.end]=dragRange([draft.start,draft.end],0,t,f.duration,edge);draft.dirty=true;renderInspector();drawSelection();seek(draft[edge]);};
}
function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportBackup(){if(source())drafts.set(source().id,clone(draft));download('puffin-five-sound-backup.json',{schema:'puffin-five-sound-backup-v1',datasetId:DATA.datasetId,labelSchema:DATA.labelSchema,sources:files,files:working,revisions,pendingDrafts:Object.fromEntries(drafts)});toast('저장된 라벨과 미저장 구간을 백업했습니다.');}
$('library-toggle').onclick=()=>toggleLibrary();$('library-close').onclick=()=>toggleLibrary(false);$('source-list').onclick=e=>{const b=e.target.closest('[data-source]');if(b)choose(Number(b.dataset.source));};$('filter').onchange=renderSources;$('search').oninput=renderSources;
$('steam-presence').onchange=()=>{const value=$('steam-presence').value;if(value==='no'&&review().segments.some(s=>steamLabels.has(s.label))){$('steam-presence').value=review().steamPresence;toast('스티밍 라벨이 있습니다. 해당 구간을 먼저 확인해 주세요.',true);return;}backup();review().steamPresence=value;changed();};
$('prev').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);$('play').onclick=togglePlay;$('step-back').onclick=()=>step(-.05);$('step-forward').onclick=()=>step(.05);$('mark-in').onclick=markIn;$('mark-out').onclick=markOut;$('play-selection').onclick=playSelection;
$('speed').onchange=()=>{video.playbackRate=Number($('speed').value);scheduleClip();};$('mute').onclick=()=>{video.muted=!video.muted;$('mute').textContent=video.muted?'소리 꺼짐':'소리 켜짐';};
$('start').oninput=$('end').oninput=previewRangeInput;
$('start').onchange=$('end').onchange=e=>{try{readInputs(e.target.id);}catch(e){toast(e.message,true);}};
for(const b of document.querySelectorAll('[data-label]'))b.onclick=()=>{draft.label=b.dataset.label;if(draft.start!==null)draft.dirty=true;renderInspector();};
$('air-count').oninput=()=>{draft.count=$('air-count').value;if(validRange())draft.dirty=true;$('edit-state').textContent='● 횟수 입력 후 Enter로 저장하세요.';status();};$('air-strength').onchange=()=>{draft.strength=$('air-strength').value;if(validRange())draft.dirty=true;renderInspector();};
$('apply').onclick=apply;$('clear-selection').onclick=clearSelection;$('delete-region').onclick=deleteRegion;$('regions').onclick=e=>{const b=e.target.closest('[data-part]');if(b)selectPart(Number(b.dataset.part),Number(b.dataset.start),Number(b.dataset.end));};
$('undo').onclick=()=>travel('undo');$('redo').onclick=()=>travel('redo');
$('zoom-in').onclick=()=>zoom(.5);$('zoom-out').onclick=()=>zoom(2);$('zoom-full').onclick=()=>changeView(0,source().duration);$('zoom-selection').onclick=()=>{if(validRange()){const pad=Math.max(.04,(draft.end-draft.start)*.18);changeView(draft.start-pad,draft.end+pad);}else toast('확대할 구간을 먼저 선택하세요.');};
$('pan-left').onclick=()=>{const w=viewEnd-viewStart;changeView(viewStart-w*.65,viewEnd-w*.65);};$('pan-right').onclick=()=>{const w=viewEnd-viewStart;changeView(viewStart+w*.65,viewEnd+w*.65);};$('pan').oninput=()=>{const width=viewEnd-viewStart,a=Number($('pan').value)/1000*(source().duration-width);changeView(a,a+width);};
$('timeline').addEventListener('wheel',e=>{if(!ready)return;e.preventDefault();if(e.ctrlKey||e.metaKey){const box=$('timeline').getBoundingClientRect(),t=viewStart+(e.clientX-box.left)/box.width*(viewEnd-viewStart);zoom(e.deltaY>0?1.25:.8,t);}else{const delta=Math.sign(e.deltaX||e.deltaY)*(viewEnd-viewStart)*.12;changeView(viewStart+delta,viewEnd+delta);}},{passive:false});
$('note').onchange=()=>{backup();review().note=$('note').value;changed();};$('excluded').onchange=()=>{backup();review().excluded=$('excluded').checked;changed();};
$('reset').onclick=()=>{backup();stopPlayback();review().segments=[{id:crypto.randomUUID(),start:0,end:source().duration,label:'unknown'}];review().airEvents=[];draft=emptyDraft();changed();toast('전체를 미라벨로 초기화했습니다. 되돌리기로 복원할 수 있습니다.');};
$('complete').onclick=()=>saveRemote(true);
$('upload-audio').onclick=()=>$('upload-files').click();
$('upload-files').onchange=async()=>{
 if(uploading||saving)return;
 const uploads=[...$('upload-files').files];if(!uploads.length)return;
 uploading=true;$('upload-audio').disabled=true;status();
 let added=0,duplicates=0,first=null;const errors=[];
 try{
  for(const [i,file] of uploads.entries()){
   $('upload-status').textContent=`음원 준비 ${i+1}/${uploads.length}: ${file.name}`;
   try{
    const result=await session.add(file);first??=result.id;
    if(result.duplicate)duplicates++;else added++;
    const e=session.entries.get(result.id);if(!working[result.id])working[result.id]=clone(e.record.review);
   }catch(e){errors.push(file.name+': '+e.message);}
  }
  files=session.sources();DATA.files=files;renderSources();
  if(!ready&&files.length)choose(files.findIndex(f=>f.id===first)>=0?files.findIndex(f=>f.id===first):0);
  $('upload-status').textContent=`추가 ${added}개 · 중복 ${duplicates}개${errors.length?' / '+errors.join(' / '):' · 라벨링 후 상단의 작업 저장을 누르세요.'}`;
 }finally{uploading=false;$('upload-audio').disabled=false;$('upload-files').value='';status();}
};
$('export').onclick=exportBackup;
video.addEventListener('play',()=>{cancelAnimationFrame(raf);scheduleClip();tick();});video.addEventListener('pause',()=>{clearTimeout(timer);cancelAnimationFrame(raf);updateTime();});video.addEventListener('seeked',updateTime);video.addEventListener('timeupdate',()=>{if(clipEnd!==null&&video.currentTime>=clipEnd)finishClip();else updateTime();});video.addEventListener('error',()=>{if(ready){$('video-warning').hidden=false;$('video-warning').textContent='음원을 재생하지 못했습니다. 브라우저에서 지원하는 형식인지 확인하세요.';}});
document.addEventListener('keydown',e=>{
 if(!ready||saving)return;
 if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)){if(e.key==='Enter'&&['start','end','air-count','air-strength'].includes(e.target.id)){e.preventDefault();e.target.blur();apply();}return;}
 if(e.target.tagName==='BUTTON'&&['Enter',' '].includes(e.key))return;
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();travel(e.shiftKey?'redo':'undo');return;}if(e.metaKey||e.ctrlKey||e.altKey)return;
 if(e.key===' '){e.preventDefault();togglePlay();}else if(e.key.toLowerCase()==='i'){e.preventDefault();markIn();}else if(e.key.toLowerCase()==='o'){e.preventDefault();markOut();}else if(e.key.toLowerCase()==='p'){e.preventDefault();playSelection();}else if(e.key==='Enter'){e.preventDefault();apply();}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step((e.key==='ArrowLeft'?-1:1)*(e.shiftKey ? .5 : .05));}else if(selectableDefinitions.some(d=>d.key.toLowerCase()===e.key.toLowerCase())){e.preventDefault();draft.label=selectableDefinitions.find(d=>d.key.toLowerCase()===e.key.toLowerCase()).id;if(draft.start!==null)draft.dirty=true;renderInspector();}else if(e.key==='Escape'){clearSelection();toggleLibrary(false);}
});
window.addEventListener('beforeunload',e=>{if(pending||uploading||failed||[...session.entries.values()].some(e=>e.dirty)||(ready&&anyDraft())){e.preventDefault();e.returnValue='';}});
new ResizeObserver(()=>{if(ready&&source())renderTimeline();}).observe($('timeline'));
document.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);
try{
 DATA=bootstrap.dataset;const saved=bootstrap.reviews;files=DATA.files;
 for(const f of files){working[f.id]=saved.files[f.id]?clone(saved.files[f.id]):{segments:[{id:crypto.randomUUID(),start:0,end:f.duration,label:'unknown'}],airEvents:[],steamPresence:f.evidence?.status==='human_confirmed'?'yes':'unsure',reviewed:false,excluded:false,note:''};working[f.id].airEvents??=[];revisions[f.id]=saved.files[f.id]?.revision||0;}
 ready=files.length>0;document.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=false);let remembered;try{remembered=localStorage.getItem('puffin.five.selected');}catch{}const params=new URLSearchParams(location.search),requested=sourceIndex(params.get('source'),Number(params.get('start'))||0),previous=sourceIndex(remembered);const first=visibleIndices().find(i=>!working[files[i].id].reviewed&&!working[files[i].id].excluded)??visibleIndices()[0];choose(requested>=0?requested:previous>=0?previous:first??0);if(ready&&requested>=0&&params.has('start')&&params.has('end')){const offset=source().parentSourceId===params.get('source')?source().parentStart:0,a=Number(params.get('start'))-offset,b=Math.min(Number(params.get('end'))-offset,source().duration);if(Number.isFinite(a)&&Number.isFinite(b)&&0<=a&&a<b&&b<=source().duration){const part=review().segments.findIndex(s=>s.start<=a&&s.end>=b);if(part>=0)selectPart(part,a,b);else toast('이 구간의 라벨 경계가 변경됐습니다. 원음을 확인해 주세요.');}}
}catch(e){$('error').hidden=false;$('error').textContent=e.message;}

if(!ready){document.querySelector('.editor').hidden=true;$('empty-state').hidden=false;toggleLibrary(true);renderSources();}
status();
