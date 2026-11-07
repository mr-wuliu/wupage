// Installed Firefox, isolated profile, local generated media and mock text service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {startFirefox} from './lib/firefox.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=path.join(root,'.npm-cache/video-firefox');await fs.mkdir(output,{recursive:true});
const requests=[],checks=[];
const server=createServer(async(request,response)=>{
 if(request.method==='POST'){
  let text='';for await(const chunk of request)text+=chunk;const payload=JSON.parse(text);requests.push(payload);
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify({translations:payload.texts.map(text=>text==='Hello world.'?'你好，世界。':text==='Seek to another moment.'?'跳转到另一个时间。':'读取视频现有字幕。')}));return;
 }
 if(request.url==='/embedded'){
  response.setHeader('Content-Type','text/html;charset=utf-8');
  response.end('<!doctype html><h1>Embedded video</h1><iframe width="850" height="750" src="http://localhost:'+server.address().port+'/"></iframe>');return;
 }
 const name=request.url==='/video-subtitles.vtt'?'video-subtitles.vtt':'video-subtitles.html';
 response.setHeader('Content-Type',name.endsWith('.vtt')?'text/vtt;charset=utf-8':'text/html;charset=utf-8');
 response.end(await fs.readFile(path.join(root,'tests/fixtures',name)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let firefox;
try{
 firefox=await startFirefox(output,path.join(root,'dist-firefox'),{'full-screen-api.allow-trusted-requests-only':false});
 const first=await firefox.command('WebDriver:GetWindowHandle');const control=first.value??first;
 const select=handle=>firefox.command('WebDriver:SwitchToWindow',{handle});
 const api=async script=>{
  await select(control);
  const result=await firefox.executeAsync('const done=arguments[arguments.length-1];const chrome=window.wrappedJSObject.chrome;(async()=>{'+script+'})().then(value=>done(JSON.stringify({value})),error=>done(JSON.stringify({error:String(error)})));');
  const parsed=JSON.parse(result);if(parsed.error)throw new Error(parsed.error);return parsed.value;
 };
 const wait=async(read,predicate,label)=>{
  const start=Date.now();let value;
  do{value=await read();if(predicate(value))return value;await delay(150);}while(Date.now()-start<20000);
  throw new Error('Timed out: '+label+'; '+JSON.stringify(value));
 };
 await firefox.command('WebDriver:Navigate',{url:firefox.base+'options.html'});
 await api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
  settings.activeProviderId='http-template';settings.sourceLang='en';settings.targetLang='zh-CN';settings.cacheEnabled=false;
  Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{enabled:true,url:${JSON.stringify(origin+'/translate')},method:'POST',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
 const opened=await firefox.command('WebDriver:NewWindow',{type:'tab'});const reading=opened.handle??opened.value?.handle;
 await select(reading);await firefox.command('WebDriver:Navigate',{url:origin});
 await wait(()=>firefox.execute('return window.wrappedJSObject.fixtureReady===true;'),Boolean,'local video ready');
 await wait(()=>firefox.execute('return !!document.querySelector("[data-wupage-video]");'),Boolean,'player controls');
 assert.equal(requests.length,0);
 await firefox.execute('document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".toggle").click();');
 const translation=()=>firefox.execute('return document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".translation span").textContent;');
 await wait(translation,text=>text==='你好，世界。','bilingual subtitle');
 checks.push('Firefox native subtitle track, text translation and one-click control');
 await firefox.execute('document.querySelector("video").currentTime=2.3;');
 await wait(translation,text=>text==='跳转到另一个时间。','seek');checks.push('media-time seek');
 await firefox.execute('document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".settings").click();');
 assert.equal(await firefox.execute('return document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".panel").hidden;'),false);
 await firefox.execute(`const root=document.querySelector('[data-wupage-video]').shadowRoot;
   const align=root.querySelector('.display-mode');align.value='western';align.dispatchEvent(new Event('change'));
   root.querySelector('details').open=true;`);
 await wait(()=>firefox.execute(`return getComputedStyle(document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.captions .source')).textAlign;`),value=>value==='left','source alignment');
 assert.equal(await firefox.execute(`return getComputedStyle(document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.captions .translation')).textAlign;`),'left');
 assert.equal(requests.length,1,'alignment reuses the translated text');
 checks.push('Firefox Western layout left-aligns both languages');
 const shot=await firefox.command('WebDriver:TakeScreenshot',{id:null,highlights:[],full:true});
 await fs.writeFile(path.join(output,'settings.png'),Buffer.from(shot.value,'base64'));
  await firefox.execute(`const root=document.querySelector('[data-wupage-video]').shadowRoot;
    root.querySelector('.layout-open').click();
    const width=root.querySelector('.layout-width');width.value='55';width.dispatchEvent(new Event('input'));
    root.querySelector('.layout-cancel').click();`);
  assert.equal(await firefox.execute(`return getComputedStyle(document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.layout-preview .source')).textAlign;`),'left');
  assert.equal(await firefox.execute(`return document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.captions').style.width;`),'90%');
  await firefox.execute(`const root=document.querySelector('[data-wupage-video]').shadowRoot;
    root.querySelector('.settings').click();root.querySelector('.layout-open').click();
    for(const [selector,value] of [['.layout-width','55'],['.layout-font','28']]){
      const input=root.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input'));
    }
    root.querySelector('.layout-preview').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true}));
    root.querySelector('.layout-done').click();`);
  await wait(()=>firefox.execute(`return !document.querySelector('[data-wupage-video]').hasAttribute('data-layout-editing');`),Boolean,'save subtitle layout');
  const savedLayout=await api(`return (await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.videoTranslation.siteLayouts.find(entry=>entry.id==='127.0.0.1');`);
  assert.deepEqual(savedLayout,{id:'127.0.0.1',x:50,bottom:15,width:55,fontSize:28});
  await select(reading);
  assert.equal(await firefox.execute(`return getComputedStyle(document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.captions')).fontSize;`),'28px');
  await firefox.execute(`document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.settings').click();`);
  checks.push('Firefox layout preview, cancel, range controls, keyboard movement and website layout persistence');
 await firefox.execute('document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".close").click();document.querySelector("video").requestFullscreen();');
 await wait(()=>firefox.execute('return document.fullscreenElement===document.querySelector("video");'),Boolean,'native fullscreen');
 const nativeCues=()=>firefox.execute(`return [...[...document.querySelector('video').textTracks].find(track=>track.label==='WuPage 双语').cues]
   .map(cue=>({text:cue.text,align:cue.align,line:cue.line,position:cue.position,size:cue.size}));`);
 await wait(nativeCues,cues=>cues.length===1,'native fullscreen cue');
 assert.deepEqual(await nativeCues(),[{text:'Seek\n跳转到另一个时间。',align:'left',line:'auto',position:5,size:90}]);
 const nativeShot=await firefox.command('WebDriver:TakeScreenshot',{id:null,highlights:[],full:true});
 await fs.writeFile(path.join(output,'alignment-native-fullscreen.png'),Buffer.from(nativeShot.value,'base64'));
 await firefox.execute('document.exitFullscreen();');
 await wait(()=>firefox.execute('return !document.fullscreenElement;'),Boolean,'exit native fullscreen');
 checks.push('Firefox native fullscreen retains Western layout and progressive original text');
 await firefox.execute('document.querySelector("[data-wupage-video]").shadowRoot.querySelector(".toggle").click();');
 assert.equal(await firefox.execute('return document.querySelector("video").textTracks[0].mode;'),'showing');checks.push('popover and native subtitle restoration');
 await firefox.command('WebDriver:Navigate',{url:origin+'/embedded'});
 const frame=await firefox.command('WebDriver:FindElement',{using:'css selector',value:'iframe'});
 await firefox.command('WebDriver:SwitchToFrame',{id:frame.value});
 await wait(()=>firefox.execute('return !!document.querySelector("[data-wupage-video]");'),Boolean,'lazy embedded video controls');
 await wait(()=>firefox.execute('return window.wrappedJSObject.fixtureReady===true;'),Boolean,'embedded video ready');
 const openedEmbedded=await api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(origin+'/embedded')});return chrome.runtime.sendMessage({type:'OPEN_VIDEO_SUBTITLES',tabId:tab.id});`);
 assert.equal(openedEmbedded.ok,true,JSON.stringify(openedEmbedded));
 await select(reading);await firefox.command('WebDriver:SwitchToFrame',{id:frame.value});
 await wait(translation,text=>text==='你好，世界。','embedded bilingual subtitle');
 checks.push('Firefox lazy video module and popup routing in a cross-origin iframe');
 const beforeDisable=requests.length;
 await api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});settings.videoTranslation={...settings.videoTranslation,enabled:false};return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
 await select(reading);await firefox.command('WebDriver:SwitchToFrame',{id:frame.value});
 await wait(()=>firefox.execute('return document.querySelectorAll("[data-wupage-video]").length;'),value=>value===0,'disabled embedded controls');
 assert.equal(await firefox.execute('return document.querySelector("video").textTracks[0].mode;'),'showing');
 await delay(300);assert.equal(requests.length,beforeDisable);
 await api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});settings.videoTranslation.enabled=true;return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
 await select(reading);await firefox.command('WebDriver:SwitchToFrame',{id:frame.value});
 await wait(()=>firefox.execute('return !!document.querySelector("[data-wupage-video]");'),Boolean,'re-enabled embedded controls');
 assert.equal(await firefox.execute('return document.querySelector("[data-wupage-video]").hasAttribute("data-enabled");'),false);
 checks.push('global disable removes active embedded subtitles and restores the native track; re-enable restores idle controls');
 await firefox.command('WebDriver:SwitchToFrame',{id:null});
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,version:firefox.session.capabilities.browserVersion,checks,requests},null,2));
 console.log(JSON.stringify({passed:true,version:firefox.session.capabilities.browserVersion,checks}));
}catch(error){await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,checks,failure:String(error)},null,2));throw error;}
finally{await firefox?.close();await new Promise(resolve=>server.close(resolve));}
