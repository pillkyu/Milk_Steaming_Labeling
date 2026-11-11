import {algorithm,references,sameSegment} from './feedback.mjs';
import {featureVersion,soundLabel,soundLabels} from './audio-features.mjs';
const $=id=>document.getElementById(id);

export async function checkBeforeSave(session,id,review,names){
 if(review.excluded||!review.segments.some(s=>soundLabels.includes(soundLabel(s))))return {review};
 const dialog=$('feedback-dialog'),message=$('feedback-message'),list=$('feedback-list'),save=$('feedback-save'),skip=$('feedback-skip'),player=$('feedback-audio');
 list.replaceChildren();player.hidden=true;message.textContent='소리를 살펴보고 있습니다…';save.hidden=true;skip.hidden=false;skip.textContent='검사 없이 이번 작업 저장';
 let worker=null,finished=false,analysisFailed=false,timeout,playTimer,stopAt=null;
 const original=structuredClone(review),prior=review.feedback?.features===featureVersion?review.feedback.checks:[];
 const selected=review.segments.filter(s=>soundLabels.includes(soundLabel(s)));
 const confirmed=prior.filter(c=>c.decision==='confirmed'&&selected.some(s=>sameSegment(c,s)));
 if(selected.every(s=>confirmed.some(c=>sameSegment(c,s))))return {review};
 const answer=new Promise(resolve=>{
  const finish=value=>{if(finished)return;finished=true;clearTimeout(timeout);clearTimeout(playTimer);worker?.terminate();player.pause();player.removeAttribute('src');player.load();dialog.close();resolve(value);};
  $('feedback-cancel').onclick=()=>finish(null);
  dialog.oncancel=e=>{e.preventDefault();finish(null);};
  skip.onclick=()=>{
   const at=new Date().toISOString(),by=session.store.user.login;
   original.feedback={algorithm,features:featureVersion,checks:selected.map(s=>confirmed.find(c=>sameSegment(c,s))||{
    id:s.id,start:s.start,end:s.end,label:soundLabel(s),vector:null,reason:'unavailable',score:null,threshold:null,reference:'not-checked',decision:'unscored',at,by})};
   finish({review:original,notice:'소리 차이 검사를 건너뛰고 저장했습니다.'});
  };
  dialog.showModal();
  const failed=e=>{if(finished||analysisFailed)return;analysisFailed=true;worker?.terminate();save.hidden=true;skip.hidden=false;clearTimeout(timeout);message.textContent='소리 차이를 확인하지 못했습니다. 라벨은 그대로 저장할 수 있습니다.';list.textContent=e.message;skip.textContent='검사 없이 저장';};
  timeout=setTimeout(()=>failed(Error('분석 시간이 길어지고 있습니다. 작업으로 돌아가거나 이번 검사를 건너뛸 수 있습니다.')),90000);
  (async()=>{
   const data=await session.store.feedbackData();if(finished||analysisFailed)return;
   const rows=references(data.seed,data.entries,id);
   const cached=selected.map(s=>prior.find(c=>sameSegment(c,s)&&c.vector));
   let pcm=null;
   if(!cached.every(Boolean)){
    const url=await session.media(id);if(finished||analysisFailed)return;
    const bytes=await fetch(url).then(r=>r.arrayBuffer()),context=new AudioContext({sampleRate:48000});let audio;
    try{audio=await context.decodeAudioData(bytes);}finally{await context.close();}
    if(finished||analysisFailed)return;
    if(audio.sampleRate!==48000||Math.abs(audio.duration-session.entries.get(id).record.source.duration)>.1)throw Error('음원 길이 또는 샘플레이트가 달라 검사를 건너뛰었습니다.');
    pcm=new Float32Array(audio.length);for(let ch=0;ch<audio.numberOfChannels;ch++){const a=audio.getChannelData(ch);for(let i=0;i<pcm.length;i++)pcm[i]+=a[i]/audio.numberOfChannels;}
   }
   if(finished||analysisFailed)return;
   worker=new Worker(new URL('./feedback-worker.mjs',import.meta.url),{type:'module'});
   worker.onerror=()=>failed(Error('이 브라우저에서 소리 분석을 실행하지 못했습니다.'));
   worker.onmessage=async({data:result})=>{
    if(finished||analysisFailed)return;
    if(result.error){failed(Error(result.error));return;}
    if(result.progress!==undefined){message.textContent=`소리를 살펴보고 있습니다… ${Math.round(result.progress*100)}%`;return;}
    clearTimeout(timeout);worker.terminate();
    const at=new Date().toISOString(),by=session.store.user.login;
    const checks=result.checks.map(c=>confirmed.find(old=>sameSegment(old,c))||{...c,reference:data.reference,at,by,decision:['different','short'].includes(c.reason)?'pending':'accepted'});
    const warnings=checks.filter(c=>c.decision==='pending'),uncounted=checks.filter(c=>c.reason==='insufficient').length;
    const complete=()=>{original.feedback={algorithm,features:featureVersion,checks};finish({review:original,notice:uncounted?'일부 라벨은 비교 자료가 적어 소리 차이를 판단하지 않았습니다.':''});};
    if(!warnings.length){complete();return;}
    message.textContent=`${warnings.length}개 구간만 다시 확인해 주세요. 다른 소리라고 해서 잘못된 라벨은 아닙니다.`;
    skip.hidden=true;save.hidden=false;save.disabled=true;save.textContent='확인한 라벨로 저장';
    for(const c of warnings){
     const card=document.createElement('section');card.className='feedback-card';
     const title=document.createElement('h3');title.textContent=`${names[c.label]} · ${c.start.toFixed(3)}–${c.end.toFixed(3)}초`;
     const reason=document.createElement('p');reason.textContent=c.reason==='short'?'아주 짧은 구간입니다. 경계가 의도한 위치인지 확인해 주세요.':'기존의 같은 라벨 소리와 차이가 큽니다. 한 번 더 들어보세요.';
     const actions=document.createElement('div');actions.className='feedback-actions';
     const listen=document.createElement('button');listen.type='button';listen.textContent='▶ 이 구간 듣기';
     listen.onclick=async()=>{try{
      const url=await session.media(id);if(finished||analysisFailed)return;
      player.pause();clearTimeout(playTimer);if(player.src!==url)player.src=url;
      player.hidden=false;player.currentTime=Math.max(0,c.start-.25);stopAt=Math.min(session.entries.get(id).record.source.duration,c.end+.25);
      await player.play();playTimer=setTimeout(()=>player.pause(),Math.max(0,stopAt-player.currentTime)*1000);
     }catch{reason.textContent='재생을 시작하지 못했습니다. 다시 듣기를 누르거나 편집 화면에서 확인해 주세요.';}};
     const edit=document.createElement('button');edit.type='button';edit.textContent='라벨·경계 수정';edit.onclick=()=>finish({edit:c});
     actions.append(listen,edit);
     const label=document.createElement('label');label.className='feedback-confirm';const input=document.createElement('input');input.type='checkbox';
     label.append(input,document.createTextNode('확인했으며 이 라벨이 맞습니다'));
     input.onchange=()=>{c.decision=input.checked?'confirmed':'pending';save.disabled=warnings.some(c=>c.decision==='pending');};
     card.append(title,reason,actions,label);list.append(card);
    }
    player.ontimeupdate=()=>{if(stopAt!==null&&player.currentTime>=stopAt)player.pause();};
    save.onclick=complete;list.querySelector('button')?.focus();
   };
   const vectors=cached.every(Boolean)?cached.map(c=>({id:c.id,start:c.start,end:c.end,label:c.label,vector:c.vector})):null;
   worker.postMessage({pcm,segments:selected,rows,vectors},pcm?[pcm.buffer]:[]);
  })().catch(failed);
 });
 return answer;
}
