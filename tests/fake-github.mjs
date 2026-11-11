import {sha256,toBase64,fromBase64} from '../site/records.mjs';
export function fakeGitHub(){
 const blobs=new Map(),trees=new Map([['t0',[]]]),commits=new Map([['c0',{tree:{sha:'t0'}}]]);let head='c0',n=0;
 const state={private:true,writes:[],failPatch:0,blobs,trees,commits,get head(){return head;},set head(v){head=v;}};
 state.fetch=async(input,options={})=>{
  const url=new URL(input),path=url.pathname,method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
  const answer=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  if(method!=='GET')state.writes.push({path,body});
  if(path==='/user')return answer({login:'tester',id:1});
  if(path==='/repos/test/data')return answer({private:state.private,default_branch:'main'});
  if(path.endsWith('/git/ref/heads/main'))return answer({object:{sha:head}});
  if(method==='GET'&&path.includes('/git/commits/'))return answer(commits.get(path.split('/').at(-1)));
  if(method==='GET'&&path.includes('/git/trees/'))return answer({tree:trees.get(path.split('/').at(-1)),truncated:false});
  if(method==='GET'&&path.includes('/git/blobs/'))return answer({content:toBase64(blobs.get(path.split('/').at(-1)))});
  if(method==='POST'&&path.endsWith('/git/blobs')){const bytes=body.encoding==='base64'?fromBase64(body.content):new TextEncoder().encode(body.content),sha=await sha256(bytes);blobs.set(sha,bytes);return answer({sha});}
  if(method==='POST'&&path.endsWith('/git/trees')){const sha='t'+(++n),entries=new Map(trees.get(body.base_tree).map(e=>[e.path,e]));for(const e of body.tree)entries.set(e.path,{...e,size:blobs.get(e.sha).length});trees.set(sha,[...entries.values()]);return answer({sha});}
  if(method==='POST'&&path.endsWith('/git/commits')){const sha='c'+(++n);commits.set(sha,{tree:{sha:body.tree},parents:body.parents});return answer({sha});}
  if(method==='PATCH'){
   if(state.failPatch-->0){const sha='other'+(++n);commits.set(sha,{tree:commits.get(head).tree,parents:[head]});head=sha;return answer({},422);}
   if(commits.get(body.sha).parents[0]!==head)return answer({},422);
   head=body.sha;return answer({object:{sha:head}});
  }
  return answer({},404);
 };
 return state;
}

