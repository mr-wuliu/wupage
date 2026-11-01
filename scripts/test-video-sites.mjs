// Deterministic adapter integration, using routed site fixtures rather than live accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.join(root,'.npm-cache/video-sites-regression');await fs.mkdir(output,{recursive:true});
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const calls=[];const checks=[];const errors=[];
let youtubeEmpty = false;
let youtubeFragments = false;
let translationDelay = 0;
const texts=['Hello world.','Read the existing subtitles.','Seek to another moment.'];
const translated=['你好，世界。','读取视频现有字幕。','跳转到另一个时间。'];
const cues=[{start:0,end:.9,text:texts[0]},{start:1,end:1.9,text:texts[1]},{start:2,end:3.8,text:texts[2]}];
const server=createServer(async(request,response)=>{
 let raw='';for await(const chunk of request)raw+=chunk;
 const data=JSON.parse(raw);calls.push(data);response.setHeader('Content-Type','application/json');
 if(translationDelay)await new Promise(resolve=>setTimeout(resolve,translationDelay));
 response.end(JSON.stringify({translations:data.texts.map(text=>text==='This tool can save you time.'?'这个工具能为你节省时间。':translated[texts.indexOf(text)]||'译：'+text)}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const base=await fs.readFile(path.join(root,'tests/fixtures/video-subtitles.html'),'utf8');
const sites=[
 {id:'youtube',url:'https://www.youtube.com/watch?v=fixture',cls:'html5-video-player',extra:'id="movie_player"',caption:'<div class="ytp-caption-window-container"><div class="caption-visual-line"><span class="ytp-caption-segment"></span></div></div>'},
 {id:'bilibili',url:'https://www.bilibili.com/video/BVfixture/',cls:'bpx-player-container',caption:'<div class="bili-subtitle-x-subtitle-panel-major-group"><span class="bili-subtitle-x-subtitle-panel-text"></span></div>'},
 {id:'netflix',url:'https://www.netflix.com/watch/fixture',cls:'watch-video',caption:'<div class="player-timedtext"><div class="player-timedtext-text-container"><span></span></div></div>'},
 {id:'vimeo',url:'https://vimeo.com/fixture',cls:'player',caption:'<div class="vp-captions"><span class="CaptionsRenderer_module_captionsLine"></span></div>'},
 {id:'disney',url:'https://www.disneyplus.com/video/fixture',cls:'disney-web-player',caption:'<div class="dss-subtitle-renderer-cue"><span></span></div>'},
 {id:'prime',url:'https://www.primevideo.com/detail/fixture',cls:'atvwebplayersdk-player-container',caption:'<div class="atvwebplayersdk-captions-text"><span></span></div>'},
 {id:'ted',url:'https://www.ted.com/talks/fixture',cls:'video-js',caption:'<div class="vjs-text-track-display"><div class="vjs-text-track-cue"><span></span></div></div>'},
 {id:'coursera',url:'https://www.coursera.org/learn/fixture/lecture/1',cls:'rc-VideoPlayer',caption:'<div class="rc-CaptionsRenderer"><span></span></div>'},
 {id:'udemy',url:'https://www.udemy.com/course/fixture/learn/lecture/1',cls:'_media-player_fixture_22',extra:'data-purpose="media-player-container"',caption:'<div class="_caption-container_fixture_16" role="status"><div class="_cue-text_fixture_32"></div></div>'}
];
const varint=value=>{const result=[];do{result.push((value&127)|(value>127?128:0));value=Math.floor(value/128);}while(value);return result;};
const field=(id,value)=>{const bytes=typeof value==='string'?[...Buffer.from(value)]:value;return [...varint(id*8+2),...varint(bytes.length),...bytes];};
const biliTrack=[...field(2,'42'),...field(3,'en'),...field(4,'English'),...field(5,'//subtitle.bilibili.com/S%13%1BP.%1D%28%29X%2CR%5Ej%1F%25w%0E%02H%5EHO4%14%7B4%08K%40%3C%7B%00M%0B%0A%1AM%1A%19%0BI%2A2%14%3C%7D%08%12V%0D%09%073W%25W%1A%06?auth_key=fixture')];
const biliMetadata=Buffer.from(field(1,field(3,biliTrack)));
function html(site){
 let result=base.replace('<div class="player">','<div class="player '+site.cls+'" '+(site.extra||'')+' style="position:relative">')
  .replace(/<track[^>]*>/,'').replace('</video></div>','</video>'+site.caption+'<button class="ytp-subtitles-button" aria-pressed="false">CC</button></div>');
 if(site.id==='vimeo')result=result.replace('<video ', '<div class="vp-video-wrapper" aria-hidden="true"><video ').replace('</video>','</video></div>');
 const script=`<script>
 const site=${JSON.stringify(site.id)},cues=${JSON.stringify(cues)};
 const player=document.querySelector('.player'),video=document.querySelector('video'),cc=player.querySelector('.ytp-subtitles-button');
 let captionsOn=site!=='youtube';cc.onclick=()=>{captionsOn=!captionsOn;cc.setAttribute('aria-pressed',String(captionsOn));};
 const source=player.querySelector('${site.id==='youtube'?'.ytp-caption-segment':site.id==='netflix'?'.player-timedtext-text-container span':site.id==='udemy'?'._cue-text_fixture_32':'.player > div span'}');
 setInterval(()=>{const cue=cues.find(cue=>cue.start<=video.currentTime&&cue.end>video.currentTime);if(source)source.textContent=captionsOn?(window.captionOverride??(cue?.text||'')):'';},60);
 if(site==='youtube'){
  player.getPlayerResponse=()=>({videoDetails:{videoId:new URL(location.href).searchParams.get('v')},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v='+new URL(location.href).searchParams.get('v')+'&lang=en',languageCode:'en',vssId:'.en',name:{simpleText:'English'}}]}}});
  player.getOption=()=>captionsOn?{vss_id:'.en',languageCode:'en'}:undefined;
 }
 if(site==='bilibili')fetch('https://api.bilibili.com/x/v2/subtitle/web/view?oid=fixture',{credentials:'include'});
 </script>`;
 return result.replace('<script>',script+'<script>');
}
let context;
try{
 context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging'],viewport:{width:1240,height:850}});
 await context.route('https://**/*',async route=>{
  const url=new URL(route.request().url());const site=sites.find(site=>new URL(site.url).hostname===url.hostname);
  if(url.pathname==='/api/timedtext'){
   const timeline=youtubeFragments?[{start:0,end:.3,text:'This tool'},{start:.3,end:.6,text:'can save'},{start:.6,end:.9,text:'you time.'}]:cues;
   return route.fulfill({contentType:'application/json',body:youtubeEmpty?'':JSON.stringify({events:timeline.map(cue=>({tStartMs:cue.start*1000,dDurationMs:(cue.end-cue.start)*1000,segs:[{utf8:cue.text}]}))})});
  }
  if(url.pathname==='/x/v2/subtitle/web/view')return route.fulfill({contentType:'application/octet-stream',body:biliMetadata,headers:{'Access-Control-Allow-Origin':'https://www.bilibili.com','Access-Control-Allow-Credentials':'true'}});
  if(url.hostname==='aisubtitle.hdslb.com')return route.fulfill({contentType:'application/json',body:JSON.stringify({body:cues.map(cue=>({from:cue.start,to:cue.end,content:cue.text}))}),headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Credentials':'true'}});
  if(site)return route.fulfill({contentType:'text/html',body:html(site)});
  return route.abort();
 });
 const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:path.join(root,process.env.VIDEO_TEST_EXTENSION_DIR||'dist')});await cdp.detach();
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const options=await context.newPage();await options.goto('chrome-extension://'+new URL(worker.url()).host+'/options.html');
 await options.evaluate(async origin=>{
  const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
  settings.activeProviderId='http-template';settings.sourceLang='en';settings.targetLang='zh-CN';settings.cacheEnabled=false;
  Object.assign(settings.providers.find(p=>p.id==='http-template'),{enabled:true,url:origin,method:'POST',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});
 },origin);
 for(const site of sites){
  const page=await context.newPage();page.on('pageerror',error=>errors.push(site.id+': '+error.message));page.setDefaultTimeout(10000);
  await page.goto(site.url);await page.waitForFunction(()=>window.fixtureReady);
  const view=page.locator('[data-wupage-video]').first();await view.waitFor();
  if(site.id==='vimeo')assert.equal(await view.evaluate(host=>!!host.closest('[aria-hidden="true"]')),false,'Vimeo controls stay outside the hidden picture layer');
  const before=calls.length;await view.locator('.toggle').evaluate(button=>button.click());
  await view.locator('.translation span').filter({hasText:translated[0]}).waitFor();
  assert.ok(calls.length>before,site.id+' should translate captions');
  if(site.id==='youtube')assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{document.querySelector('video').currentTime=2.3;});
  await view.locator('.translation span').filter({hasText:translated[2]}).waitFor();
  if(site.id==='youtube'){
   await page.evaluate(()=>{document.querySelector('#movie_player').classList.add('ad-showing');});
   await page.waitForTimeout(200);assert.equal(await view.locator('.captions').isVisible(),false,'do not overlay video subtitles over ads');
   await page.evaluate(()=>{document.querySelector('#movie_player').classList.remove('ad-showing');});
   await view.locator('.translation span').filter({hasText:translated[2]}).waitFor();
   await page.evaluate(()=>{history.pushState({},'','/watch?v=next-fixture');document.dispatchEvent(new Event('yt-navigate-finish'));document.querySelector('video').currentTime=0;});
   await view.locator('.translation span').filter({hasText:translated[0]}).waitFor();
   await page.screenshot({path:path.join(output,'youtube-fixture.png')});
  }
  await view.locator('.toggle').evaluate(button=>button.click());
  assert.equal(await view.locator('.captions').isVisible(),false);
  assert.equal(await page.locator('[data-wupage-video-native]').count(),0);
  if(site.id==='youtube')assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'),'false');
  if(site.id==='youtube'){
   youtubeFragments=true;
   await page.evaluate(()=>{history.pushState({},'','/watch?v=sentence-fixture');document.dispatchEvent(new Event('yt-navigate-finish'));document.querySelector('video').currentTime=0;});
   const sentenceStart=calls.length;
   await view.locator('.toggle').evaluate(button=>button.click());
   await view.locator('.translation span').filter({hasText:'这个工具能为你节省时间。'}).waitFor();
   assert.ok(calls.slice(sentenceStart).some(call=>call.texts.includes('This tool can save you time.')));
   assert.ok(calls.slice(sentenceStart).every(call=>!call.texts.some(text=>['This tool','can save','you time.'].includes(text))));
   await page.evaluate(()=>{document.querySelector('video').currentTime=.7;});
   await view.locator('.source span').filter({hasText:'This tool can save you time.'}).waitFor();
   await view.locator('.translation span').filter({hasText:'这个工具能为你节省时间。'}).waitFor();
   await page.screenshot({path:path.join(output,'youtube-sentence-fixture.png')});
   await page.evaluate(()=>{document.querySelector('video').currentTime=1.1;});
   await page.waitForFunction(()=>document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.translation span').textContent==='');
   await view.locator('.toggle').evaluate(button=>button.click());
   youtubeFragments=false;
   await page.evaluate(()=>{history.pushState({},'','/watch?v=fallback-fixture');document.dispatchEvent(new Event('yt-navigate-finish'));});
   checks.push('youtube: fragmented JSON3 cues translate as one sentence and share the original time range');
   youtubeEmpty=true;
   await page.evaluate(()=>{document.querySelector('video').currentTime=0;});
   const fallbackStart=calls.length;
   await view.locator('.toggle').evaluate(button=>button.click());
   await view.locator('.translation span').filter({hasText:translated[0]}).waitFor();
   assert.ok(calls.length>fallbackStart,'empty timedtext must fall back to rendered captions');
   await page.evaluate(()=>{document.querySelector('video').currentTime=2.3;});
   await view.locator('.translation span').filter({hasText:translated[2]}).waitFor();
   await view.locator('.toggle').evaluate(button=>button.click());
   translationDelay=700;
   await page.evaluate(()=>{
    const words='that auto generates this new support structure that saves time when printing and makes it much easier to remove the finished part from the printer so you can continue with your next project without spending a long time cutting away unnecessary material from every surface'.split(' ');
    let index=5;window.asrDone=false;window.captionOverride=words.slice(0,index).join(' ');
    window.asrTimer=setInterval(()=>{
     index++;window.captionOverride=words.slice(Math.max(0,index-12),index).join(index%2?'\n':' ');
     if(index>=words.length){clearInterval(window.asrTimer);window.asrDone=true;}
    },180);
   });
   await view.locator('.toggle').evaluate(button=>button.click());
   await page.waitForFunction(()=>!window.asrDone&&document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.translation span').textContent.startsWith('译：'));
   assert.equal(await view.getAttribute('data-subtitle-source'),'live');
   checks.push('youtube: rolling ASR remains translated with 700ms responses and changing line wraps');
   await page.locator('.ytp-subtitles-button').click();
   assert.equal(await view.getAttribute('data-enabled'),null,'manual native CC off stops translation');
   assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'),'false');
   checks.push('youtube: empty timedtext fallback, rendered-caption seek, native CC off');
   translationDelay=0;await page.evaluate(()=>clearInterval(window.asrTimer));
   youtubeEmpty=false;
  }
  checks.push(site.id+': source, translation, seek, stop/restore');await page.close();
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,requests:calls.length,errors},null,2));
 console.log(JSON.stringify({passed:true,checks,requests:calls.length}));
}catch(error){
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,checks,errors,failure:String(error)},null,2));throw error;
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
