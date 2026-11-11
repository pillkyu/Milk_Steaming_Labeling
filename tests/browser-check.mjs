import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fakeGitHub} from './fake-github.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_PATH||'playwright');
const root=new URL('../site/',import.meta.url);
const server=createServer(async(req,res)=>{
 try{const pathname=new URL(req.url,'http://localhost').pathname;const path=new URL('.'+(pathname==='/'?'/index.html':pathname),root);if(!path.href.startsWith(root.href))throw Error();const bytes=await readFile(path);res.writeHead(200,{'Content-Type':path.pathname.endsWith('.mjs')?'text/javascript':path.pathname.endsWith('.json')?'application/json':path.pathname.endsWith('.css')?'text/css':'text/html'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),fake=fakeGitHub(),errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text());});page.on('dialog',dialog=>dialog.accept());
 await page.route('https://api.github.com/**',async route=>{
  const req=route.request();const target=req.url().replace('/repos/pillkyu/Milk_Steaming_Labeling_Data','/repos/test/data');
  if(req.headers().authorization!=='Bearer test-token'){await route.fulfill({status:401,body:'{}'});return;}
  const response=await fake.fetch(target,{method:req.method(),body:req.postData()});
  await route.fulfill({status:response.status,body:await response.text(),contentType:'application/json'});
 });
 await page.goto(url);await page.locator('#access-token').fill('bad');await page.locator('#connect-button').click();await page.locator('#connect-message').filter({hasText:'접근 토큰'}).waitFor();
 const login=async()=>{await page.locator('#access-token').fill('test-token');await page.locator('#connect-button').click();await page.locator('#connection').waitFor({state:'hidden'});};
 await login();await page.locator('#empty-state').waitFor({state:'visible'});assert.equal(fake.writes.length,0);
 const samples=48000*2,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/48000)*4000),44+i*2);
 await page.locator('#upload-files').setInputFiles({name:'브라우저 검증.wav',mimeType:'audio/wav',buffer:wav});await page.locator('#title').filter({hasText:'브라우저 검증.wav'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('#video').readyState>=1);
 await page.locator('#play').click();await page.waitForFunction(()=>!document.querySelector('#video').paused);await page.locator('#play').click();
 await page.locator('#start').fill('0');await page.locator('#end').fill('1');await page.locator('[data-label="normal_air"]').click();await page.locator('#apply').click();
 await page.locator('#save-record').waitFor({state:'visible'});assert.equal(fake.writes.length,0,'local editing must not commit');
 await page.reload();await login();await page.locator('#regions').filter({hasText:'정상 공기주입'}).waitFor();
 await page.locator('#save-record').click();await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='GitHub 저장 완료');
 assert.equal(fake.writes.filter(w=>w.path.includes('/git/refs/')).length,1);
 await page.locator('#complete').click();await page.waitForFunction(()=>document.querySelector('#review-badge').textContent==='검수 완료'&&document.querySelector('#save-state').textContent==='GitHub 저장 완료');
 await page.reload();await login();await page.locator('#review-badge').filter({hasText:'검수 완료'}).waitFor();await page.waitForFunction(()=>document.querySelector('#video').readyState>=1);
 const storage=await page.evaluate(async()=>({local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage),input:document.querySelector('#access-token').value}));assert.ok(!JSON.stringify(storage).includes('test-token'));
 const list=[...fake.trees.get(fake.commits.get(fake.head).tree.sha)];assert.equal(list.length,2);assert.ok(list.some(e=>e.path.endsWith('/original.wav')));assert.ok(list.some(e=>e.path.endsWith('/record.json')));
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});await page.screenshot({path:fileURLToPath(new URL('../test-results/editor.png',import.meta.url))});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:fileURLToPath(new URL('../test-results/mobile.png',import.meta.url))});
 assert.deepEqual(errors,[]);console.log('PASS: access denial, empty state, synthetic upload, playback, labeling, draft recovery, explicit atomic save, review/reopen, no token persistence.');
}finally{await browser.close();server.close();}
