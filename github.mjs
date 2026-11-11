import {validateRecord,sha256,toBase64,fromBase64} from './records.mjs';

export class GitHubStore {
 constructor(repository,token,schema,request=(...args)=>fetch(...args)){this.repository=repository;this.token=token;this.schema=schema;this.request=request;}
 async api(path,method='GET',body){
  const response=await this.request(`https://api.github.com${path}`,{method,cache:'no-store',headers:{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){const e=Error(response.status===401?'접근 토큰이 만료되었거나 올바르지 않습니다.':response.status===403?'저장 권한 또는 GitHub 요청 한도를 확인하세요.':response.status===404?'초대 수락 여부와 토큰의 저장소 접근 권한을 확인하세요.':`GitHub 요청 실패 (${response.status}). 작업은 이 브라우저에 남아 있습니다.`);e.status=response.status;throw e;}
  return response.status===204?null:response.json();
 }
 path(suffix=''){return `/repos/${this.repository}${suffix}`;}
 async connect(){
  const repo=await this.api(this.path());
  if(!repo.private)throw Error('음원 보호를 위해 비공개 데이터 저장소만 연결할 수 있습니다.');
  this.branch=repo.default_branch;
  this.user=await this.api('/user');
  return this.user;
 }
 async tree(){
  const head=await this.api(this.path(`/git/ref/heads/${encodeURIComponent(this.branch)}`));
  const commit=await this.api(this.path(`/git/commits/${head.object.sha}`));
  const tree=await this.api(this.path(`/git/trees/${commit.tree.sha}?recursive=1`));
  if(tree.truncated)throw Error('저장소 목록이 너무 큽니다. 관리자에게 문의하세요.');
  return {head:head.object.sha,tree:commit.tree.sha,entries:tree.tree};
 }
 async jsonBlob(sha){const blob=await this.api(this.path(`/git/blobs/${sha}`));return JSON.parse(new TextDecoder().decode(fromBase64(blob.content)));}
 async list(tree){
  tree??=await this.tree();
  const entries=tree.entries.filter(e=>/^recordings\/[a-f0-9]{64}\/record\.json$/.test(e.path)),result=[];
  for(let i=0;i<entries.length;i+=4){
   result.push(...await Promise.all(entries.slice(i,i+4).map(async e=>{
    if(e.size>2*1024*1024)throw Error('라벨 파일이 너무 큽니다.');
    const record=validateRecord(await this.jsonBlob(e.sha),this.schema);
    if(e.path!==`recordings/${record.source.id}/record.json`)throw Error('자료 경로와 식별자가 다릅니다.');
    const audio=tree.entries.find(a=>a.path===record.source.originalAudio);
    if(!audio||audio.size!==record.source.bytes)throw Error('원본 음원이 없거나 크기가 달라졌습니다.');
    return {record,sha:e.sha,audioSha:audio.sha};
   })));
  }
  return result;
 }
 async feedbackData(){
  const tree=await this.tree(),seed=tree.entries.find(e=>e.path==='feedback/reference.json');
  if(!seed||seed.size>8*1024*1024)throw Error('비교 자료를 준비하지 못했습니다.');
  return {reference:tree.head,seed:await this.jsonBlob(seed.sha),entries:await this.list(tree)};
 }
 async audio(entry){
  const value=await this.api(this.path(`/git/blobs/${entry.audioSha}`)),bytes=fromBase64(value.content);
  if(bytes.length!==entry.record.source.bytes||await sha256(bytes)!==entry.record.source.originalSHA256)throw Error('원본 음원의 해시가 일치하지 않습니다.');
  return new Blob([bytes]);
 }
 async save(record,original,expectedSha){
  validateRecord(record,this.schema);
  const path=`recordings/${record.source.id}/record.json`;
  if(new TextEncoder().encode(JSON.stringify(record)).length>2*1024*1024)throw Error('라벨 파일이 너무 큽니다.');
  let audioBlob=null,recordBlob=null;
  for(let attempt=0;attempt<3;attempt++){
   const current=await this.tree(),existing=current.entries.find(e=>e.path===path);
   if((existing?.sha||null)!==(expectedSha||null)){
    // A lost response may follow a successful commit; recognize an identical retry.
    if(existing&&recordBlob&&existing.sha===recordBlob.sha)return {sha:existing.sha,audioSha:current.entries.find(e=>e.path===record.source.originalAudio)?.sha};
    throw Error('다른 사용자가 이 음원을 저장했습니다. 작업 백업 후 다시 연결하여 최신 라벨을 확인하세요. 기존 작업은 덮어쓰지 않았습니다.');
   }
   const existingAudio=current.entries.find(e=>e.path===record.source.originalAudio);
   if(!existing){
    if(!original)throw Error('저장할 원본 음원을 찾을 수 없습니다.');
    if(!audioBlob){const bytes=new Uint8Array(await original.arrayBuffer());if(bytes.length!==record.source.bytes||await sha256(bytes)!==record.source.id)throw Error('원본 음원 검증 실패');audioBlob=await this.api(this.path('/git/blobs'),'POST',{content:toBase64(bytes),encoding:'base64'});}
   }else{
    const previous=await this.jsonBlob(existing.sha);
    if(!existingAudio||JSON.stringify(previous.source)!==JSON.stringify(record.source))throw Error('원본 녹음 정보가 달라졌습니다. 다시 연결해 주세요.');
   }
   recordBlob??=await this.api(this.path('/git/blobs'),'POST',{content:JSON.stringify(record,null,2)+'\n',encoding:'utf-8'});
   const entries=[{path,mode:'100644',type:'blob',sha:recordBlob.sha}];
   if(!existing)entries.push({path:record.source.originalAudio,mode:'100644',type:'blob',sha:audioBlob.sha});
   const tree=await this.api(this.path('/git/trees'),'POST',{base_tree:current.tree,tree:entries});
   const commit=await this.api(this.path('/git/commits'),'POST',{message:`Save annotation ${record.source.id.slice(0,12)} by ${this.user.login}`,tree:tree.sha,parents:[current.head]});
   try{
    await this.api(this.path(`/git/refs/heads/${encodeURIComponent(this.branch)}`),'PATCH',{sha:commit.sha,force:false});
    return {sha:recordBlob.sha,audioSha:existingAudio?.sha||audioBlob.sha};
   }catch(e){if(![409,422].includes(e.status)||attempt===2)throw e;}
  }
 }
}
