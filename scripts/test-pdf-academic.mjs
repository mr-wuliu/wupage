// Isolated browsers, original generated fixtures and a local mock translator.
// --file=... additionally checks a user-supplied paper; it is never uploaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { browserTarget } from './lib/browser-target.mjs';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { anonymizePdfFonts } from './lib/pdf-anonymous-fonts.mjs';
import { inspectPdfPageQuality } from './lib/pdf-page-quality.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const outputArgument=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
const output = outputArgument ? path.resolve(root,outputArgument) : path.join(root, '.npm-cache/pdf-academic', target.kind);
assert.ok(output.startsWith(path.join(root,'.npm-cache')+path.sep),'Test output must stay inside .npm-cache');
const expansion=Number(process.argv.find(arg=>arg.startsWith('--expansion='))?.slice(12)??0.33);
assert.ok(expansion>=0.1&&expansion<=2,'Invalid translation expansion');
await fs.mkdir(output, { recursive: true });
const checks = [], requests = [];
const fontPin = JSON.parse(await fs.readFile(path.join(root,'public/pdf-fonts/font-metadata.json'),'utf8')).font;
const fontBytes = await fs.readFile(process.env.PDF_FONT_FIXTURE || path.join(root,'tests/fixtures/pdf-export-font.otf'));
let fontRequests = 0;
const source = await PDFDocument.create();
const regular = await source.embedFont(StandardFonts.TimesRoman), bold = await source.embedFont(StandardFonts.HelveticaBold), italic = await source.embedFont(StandardFonts.TimesRomanItalic);
const symbol = await source.embedFont(StandardFonts.Symbol);
const add = (page, text, x, y, size = 10, font = regular) => page.drawText(text, { x, y, size, font });
const first = source.addPage([600, 800]);
add(first, 'Clinical prediction of complications', 40, 740, 17, bold);
add(first, 'Background', 40, 700, 10, bold);
add(first, 'The model uses routinely collected clinical measurements', 95, 700);
add(first, 'to predict complications. Its predictions retain the original statistics.', 40, 687);
add(first, 'The discussion continues in this column.', 40, 600);
add(first, 'These findings require careful clinical interpretation.', 40, 587);
add(first, 'References', 330, 600, 11, bold);
add(first, '1 Smith J. Clinical measurements. Journal 2020; 2: 10-20.', 330, 580, 7);
add(first, '2 Brown A. Prediction methods. Journal 2021; 3: 20-30.', 330, 565, 7);
for (const [text, x] of [['PPV',40],['NPV',105],['AUC',170]]) add(first, text, x, 450, 8, bold);
add(first, 'RNN', 40, 430, 8); add(first, '0.90', 105, 430, 8); add(first, '0.87', 170, 430, 8);
add(first, 'Training (n=4180)', 40, 380, 7); add(first, 'Test (n=464)', 110, 380, 7);
add(first, 'PPV=positive predictive value. NPV=negative predictive value.', 40, 260, 8);
add(first, 'RNN=recurrent neural network. AUC=area under the curve.', 40, 247, 8);
const second = source.addPage([600, 800]);
add(second, '3 Jones K. Further observations. Journal 2022; 4: 30-40.', 40, 740, 7);
add(second, 'Appendix', 40, 680, 12, bold);
add(second, 'The appendix must still be translated.', 40, 660);
for (const [text,y] of [['A Bleeding',600],['B Mortality',500],['C Renal failure',400]]) add(second,text,40,y,8,bold);
second.drawLine({ start: { x: 40, y: 550 }, end: { x: 250, y: 570 }, color: rgb(0,0.3,0.8), thickness: 1.5 });
second.drawLine({ start: { x: 40, y: 535 }, end: { x: 250, y: 545 }, color: rgb(0.8,0,0.2), thickness: 1.5 });
add(second, 'RNN', 300, 550, 7); add(second, 'Clinical reference tool', 300, 541.6, 7);
add(second, 'State', 40, 250, 8); add(second, 's', 60, 250, 8, italic);
add(second, 's', 180, 250, 8, italic); add(second, 't', 183, 247.5, 5, italic);
// Small caps next to math, and italic prose before an explanation, must reach
// the translator as ordinary words rather than being baked into formula crops.
add(second, 'IV. THE', 40, 180); add(second, 'π', 80, 180, 10, symbol); add(second, '0', 86, 178.5, 7);
add(second, 'M', 94, 180, 10); add(second, 'ODEL', 103.5, 180, 8);
add(second, 'We use segment', 40, 150);
const termX = 40 + regular.widthOfTextAtSize('We use segment', 10) + 3;
add(second, 'annotations', termX, 150, 10, italic);
add(second, '(fine-grained labels for sub-trajectories).', termX + italic.widthOfTextAtSize('annotations', 10) + 3, 150);
const cropped = source.addPage([600,800]); cropped.setCropBox(50,80,500,600);
add(cropped,'A cropped page with its original vector graphics.',70,620,13);
cropped.drawRectangle({x:70,y:500,width:180,height:45,color:rgb(0.1,0.7,0.3)});
const rotated = source.addPage([600,800]);rotated.setRotation(degrees(90));
rotated.drawText('Upright text on a rotated page.',{x:120,y:100,size:14,rotate:degrees(90),font:regular});
rotated.drawRectangle({x:240,y:300,width:180,height:45,color:rgb(0.1,0.7,0.3)});
// A page with only a numeric label and artwork needs no provider request,
// but its translated panel and exported page must still preserve the source.
const retained = source.addPage([600,800]);
add(retained,'42',40,740,10);
retained.drawRectangle({x:100,y:500,width:180,height:45,color:rgb(0.1,0.7,0.3)});
// ACS-style abstracts widen beneath artwork; section markers and Unicode
// superscript reference ranges must not change the heading or paragraph size.
const wrapped = source.addPage([600,800]);
const abstractLines = ['ABSTRACT: These observations explain how the', 'material responds to changing conditions and',
 'retains its structure during the experiments', 'described here. The results demonstrate that',
 'the same approach can provide stable outcomes', 'for different samples and several processes',
 'involving water and dissolved components. We', 'evaluate the response over time and identify',
 'the conditions that control the behavior of', 'the material. These findings clarify the', 'relevant geological processes and support',
 'a comprehensive assessment of material performance across the full range of environmental conditions.',
 'Further experiments confirm these observations and provide a basis for practical applications.'];
for (const [index,text] of abstractLines.entries()) add(wrapped,text,40,710-index*12);
wrapped.drawRectangle({x:320,y:590,width:240,height:130,color:rgb(0.1,0.7,0.3)});
const markerFont = await source.embedFont(StandardFonts.ZapfDingbats);
wrapped.drawText('■',{x:40,y:480,size:16,font:markerFont,color:rgb(0.1,0.35,0.2)});
add(wrapped,'INTRODUCTION',62,480,10,bold);
const prose = 'The material affects groundwater resources.';
add(wrapped,prose,40,450);
const citationX=40+regular.widthOfTextAtSize(prose,10);
add(wrapped,'1',citationX,454,6);
add(wrapped,'−',citationX+3,454,6,symbol);
add(wrapped,'4',citationX+6.3,454,6);
add(wrapped,'Further observations confirm these findings.',40,438);
const columns=source.addPage([600,800]);
add(columns,'Three-column proceedings',35,740,16,bold);
for(const [column,x] of [35,215,395].entries()){
 add(columns,`Section ${column+1}`,x,700,10,bold);
 for(const [line,text] of ['This column describes the method', 'and explains the observations made',
  'during the experiment. The results', 'provide useful evidence about the', 'behavior of the proposed system.'].entries())add(columns,text,x,680-line*12,9);
}
const imageOnly=source.addPage([600,800]);
const image=await source.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
imageOnly.drawImage(image,{x:40,y:100,width:520,height:600});
const fixture = path.join(output, 'academic-source.pdf'); await fs.writeFile(fixture, await source.save());
const file = process.argv.find(arg => arg.startsWith('--file='))?.slice(7);
const corpusId = process.argv.find(arg => arg.startsWith('--corpus='))?.slice(9);
const corpus = corpusId ? JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/pdf-corpus.json'), 'utf8')).find(entry => entry.id === corpusId) : undefined;
assert.ok(!corpusId || corpus, 'Unknown PDF corpus id');
const documents = [{ id: 'fixture', file: fixture, preservedRegions: [
 {page:6,x:320,y:590,width:240,height:130,tolerance:1}, {page:6,x:40,y:475,width:15,height:20}
] }, ...(file ? [{ id: 'paper', file: path.resolve(file) }] : []),
 ...(corpus ? [{ ...corpus, file: path.join(root, '.npm-cache/pdf-corpus', corpus.id + '.pdf') }] : [])];
if(process.argv.includes('--anonymize-fonts')){
 assert.ok(documents.length>1,'Supply --corpus or --file for the font anonymity test');
 for(const document of documents.slice(1)){
  const file=path.join(output,document.id+'-anonymous.pdf');
  const bytes=await anonymizePdfFonts(await fs.readFile(document.file));await fs.writeFile(file,bytes);
  const task=getDocument({data:bytes,fontExtraProperties:true}),pdf=await task.promise;
  try{
   for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number),content=await page.getTextContent();await page.getOperatorList();
    for(const name of Object.keys(content.styles))assert.match(page.commonObjs.get(name).name,/^Opaque\d+$/u,'PDF.js must see anonymized names');
   }
  }finally{await task.destroy();}
  documents.push({...document,id:document.id+'-anonymous',file,sourceId:document.id});
 }
}
const words = new Map([['References','参考文献'],['Appendix','附录'],['Background','背景'],['Training','训练'],['Test','测试'],['State','状态'],
 ['Bleeding','出血'],['Mortality','死亡风险'],['Renal failure','肾功能衰竭'],['Clinical reference tool','临床参考工具'],['Features','特征'],['Prediction','预测'],
 ['MIN','最小值'],['TYP','典型值'],['MAX','最大值'],['UNIT','单位'],['FREQUENCY','频率'],['(TYP)','（典型值）']]);
function translate(text) {
 return text.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu).map(part => {
  if (/^⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫$/u.test(part) || !/\p{L}/u.test(part)) return part;
  if (words.has(part.trim())) return part.replace(part.trim(), words.get(part.trim()));
  const count = Math.max(2, Math.ceil(part.length * expansion));
  return '这是用于验证论文段落排版与保护规则的本地模拟译文。'.repeat(Math.ceil(count/26)).slice(0,count);
 }).join('');
}
const server = createServer(async (request,response) => {
 if(request.method==='GET'){
  if(request.url==='/export-font.otf'){fontRequests++;response.writeHead(200,{'Content-Type':'font/otf'}).end(fontBytes);return;}
  const doc = documents.find(doc => request.url === '/'+doc.id+'.pdf');
  if(!doc){response.writeHead(404).end();return;}
  response.writeHead(200,{'Content-Type':'application/pdf'}).end(await fs.readFile(doc.file));return;
 }
 let body='';for await(const chunk of request)body+=chunk;
 const input=JSON.parse(body); requests.push(input);
 response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({translations:input.texts.map(translate)}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
// Font data is served locally. Only the isolated test copy changes its pinned
// URL/hash/size; production sources and release files retain the official pin.
const stagedRoot=path.join(output,'font-test-build'),buildDir=target.kind==='firefox'?'dist-firefox':'dist';
const stagedBuild=path.join(stagedRoot,buildDir);
await fs.mkdir(stagedRoot,{recursive:true});await fs.cp(path.join(root,buildDir),stagedBuild,{recursive:true});
let fontAdapters=0;
for(const directory of [stagedBuild,path.join(stagedBuild,'assets')])for(const name of await fs.readdir(directory)){
 if(!name.endsWith('.js'))continue;
 const file=path.join(directory,name),text=await fs.readFile(file,'utf8');
 if(!text.includes(fontPin.source))continue;
 const adapted=text.replaceAll(fontPin.source,origin+'/export-font.otf')
  .replaceAll(fontPin.sha256,createHash('sha256').update(fontBytes).digest('hex'))
  .replaceAll(String(fontPin.bytes),String(fontBytes.length));
 await fs.writeFile(file,adapted);fontAdapters++;
}
assert.ok(fontAdapters>0,'optional font metadata adapted in the test build');
let browser;
const wait=async(read,predicate,label)=>{let value;const end=Date.now()+120000;do{value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,150));}while(Date.now()<end);throw new Error(label+': '+JSON.stringify(value));};
try{
 browser=await openExtensionBrowser(stagedRoot,output,target.kind==='firefox');
 const base=await browser.api(`const settings=(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data;
  settings.providers.push({id:'academic-test',type:'http-template',label:'Academic local test',enabled:true,method:'POST',url:${JSON.stringify(origin+'/translate')},headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}},"context":{{json context}}}',responsePath:'translations'});
  Object.assign(settings,{activeProviderId:'academic-test',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,pdfTranslationPageRadius:null});
  const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!result.ok)throw new Error(result.error);return chrome.runtime.getURL('pdf.html');`);
 const userAgent=await browser.evaluate('return navigator.userAgent;');
 for(const document of documents){
  const requestStart=requests.length;
  await browser.navigate(base+'?url='+encodeURIComponent(origin+'/'+document.id+'.pdf')+'&translate=1');
  await wait(()=>browser.evaluate('return {status:document.querySelector("#statusToast").textContent,disabled:document.querySelector("#translateDocument").disabled};'),v=>!v.disabled&&v.status.includes('翻译完成'),document.id+' translation');
  for(const text of document.protectedText??[])assert.ok(!requests.slice(requestStart).some(input=>input.texts.some(source=>source.includes(text))),document.id+' preserved text must not reach the translator: '+text);
  const pages=await browser.evaluate('return document.querySelectorAll(".page-row").length;');
  const pageChecks=[];
  for(let number=1;number<=pages;number++){
   await browser.evaluate(`document.querySelector('article[data-page="${number}"]').scrollIntoView({block:'start'});`);
   await wait(()=>browser.evaluate(`return !!document.querySelector('article[data-page="${number}"] .canvas-shell.is-rendered');`),Boolean,'render page');
   await wait(()=>browser.evaluate(`return document.querySelector('article[data-page="${number}"] .translation-prompt').hidden;`),Boolean,'translated or retained page displayed');
   await new Promise(resolve=>setTimeout(resolve,100));
   const quality=await browser.evaluate(`return (${inspectPdfPageQuality.toString()})(${number},${JSON.stringify(document.preservedRegions??[])});`);
   pageChecks.push(quality);
   await fs.writeFile(path.join(output,`${document.id}-${number}-quality.json`),JSON.stringify(quality,null,2));
   if(document.id==='fixture'||quality.collisions.length||quality.protectedOverlaps.length||quality.blocks.some(block=>block.problems.length)
    ||(document.inspect??[1,3,5,6,9,10]).includes(number))await browser.capture(`${document.id}-${number}.png`);
  }
  const qualityProblems=pageChecks.flatMap(page=>[
   ...page.blocks.filter(block=>block.problems.length).map(block=>({page:page.page,id:block.id,problems:block.problems})),
   ...page.collisions.map(ids=>({page:page.page,collision:ids})),
   ...page.protectedOverlaps.map(overlap=>({page:page.page,protectedOverlap:overlap}))
  ]);
  if(qualityProblems.length&&process.argv.includes('--allow-safe-rejection')&&document.id!=='fixture'){
   assert.ok(qualityProblems.every(problem=>problem.collision||problem.problems?.every(value=>value==='overflow')),
    document.id+' only explicitly detected layout failures can be safely rejected');
   const marked=await browser.evaluate(`return [...document.querySelectorAll('[data-layout-overflow],[data-layout-collision]')].map(block=>block.dataset.blockId);`);
   for(const problem of qualityProblems)for(const id of problem.collision??[problem.id])assert.ok(marked.includes(id),document.id+' unmarked layout failure: '+id);
   const count=await browser.evaluate('return document.querySelectorAll(".translation-layout-warning:not([hidden])").length;');
   assert.ok(count>0,'reader must explain unsafe layout');
   const before=requests.length;
   await browser.evaluate('document.querySelector("#downloadDocument").click();');
   await wait(()=>browser.evaluate('return {status:document.querySelector("#statusToast").textContent,disabled:document.querySelector("#downloadDocument").disabled};'),
    value=>!value.disabled&&value.status.includes('超出可读排版范围'),document.id+' unsafe export is blocked');
   assert.equal(requests.length,before,'rejecting unsafe export does not retranslate successful paragraphs');
   checks.push({document:document.id,outcome:'safely-rejected',pages,pagesChecked:pageChecks.length,qualityProblems,exportBlocked:true,
    blocks:pageChecks.reduce((sum,page)=>sum+page.blocks.length,0)});
   continue;
  }
  assert.deepEqual(qualityProblems,[],document.id+' page quality');
  const layout=await browser.evaluate(`return Array.from(document.querySelectorAll('.translation-block')).map(block=>({
   id:block.dataset.blockId,text:block.querySelector('.translation-block-text').textContent,overflow:!!block.dataset.layoutOverflow,
   size:parseFloat(block.querySelector('.translation-block-text').style.fontSize),preferred:Number(block.dataset.preferredFontSize)}));`);
  if(layout.some(block=>block.overflow)){
   const details=await browser.evaluate(`return Array.from(document.querySelectorAll('[data-layout-overflow]')).map(block=>{
    const text=block.querySelector('.translation-block-text'),layer=block.parentElement,original=block.closest('.page-row').querySelector('.original-text-layer');
    return {id:block.dataset.blockId,geometry:block.style.cssText,textStyle:text.style.cssText,computed:getComputedStyle(text).font,
     width:text.clientWidth,height:text.clientHeight,scrollWidth:text.scrollWidth,scrollHeight:text.scrollHeight,layer:layer.style.cssText,
     coordinateScale:layer.dataset.coordinateScale,original:original.style.cssText};});`);
   await fs.writeFile(path.join(output,document.id+'-overflow.json'),JSON.stringify(details,null,2));
  }
  assert.equal(layout.filter(block=>block.overflow).length,0,document.id+' readable layout: '+JSON.stringify(layout.filter(block=>block.overflow)));
  if(document.id==='fixture'){
   const wrappedLayout=await browser.evaluate(`const row=document.querySelector('article[data-page="6"]');
    const canvas=row.querySelector('.translated-panel > .canvas-shell > canvas'),box=canvas.getBoundingClientRect();
    const sx=box.width/600,sy=box.height/800;
    return [...row.querySelectorAll('.translation-block')].map(block=>{const text=block.querySelector('.translation-block-text'),r=block.getBoundingClientRect();
     return {left:(r.left-box.left)/sx,right:(r.right-box.left)/sx,top:(r.top-box.top)/sy,bottom:(r.bottom-box.top)/sy,
      size:parseFloat(text.style.fontSize)/Number(block.parentElement.dataset.coordinateScale)/(canvas.width/600),formulas:text.querySelectorAll('.pdf-inline-formula').length};});`);
   assert.ok(wrappedLayout.every(block=>block.right<=320||block.left>=560||block.bottom<=80||block.top>=210),
    'abstract translation stays outside artwork: '+JSON.stringify(wrappedLayout));
   const headings=wrappedLayout.filter(block=>block.top>300&&block.top<330);
   assert.equal(headings.length,1,'translated section heading remains visible');
   assert.ok(headings.every(block=>block.size<=10),
    'section marker does not inflate heading font size: '+JSON.stringify(wrappedLayout));
   assert.equal(wrappedLayout.filter(block=>block.top>330&&block.formulas===1).length,1,'superscript citation stays inside its prose paragraph');
   assert.ok(requests.slice(requestStart).some(input=>input.texts.some(text=>text.includes('ABSTRACT:')&&text.includes('comprehensive assessment'))),
    'wrapped abstract is translated as one paragraph');
   assert.ok(requests.every(input=>input.texts.every(text=>!text.includes('■'))),'section marker stays out of translation');
  }
  const tableLabels = await browser.evaluate(`return ${JSON.stringify(document.tableLabels ?? [])}.map(label=>{
   const row=document.querySelector('article[data-page="'+label.page+'"]');
   const canvas=row.querySelector('.translated-panel > .canvas-shell > canvas');
   const [width,height]=row.querySelector('.original-panel .canvas-shell').style.aspectRatio.split('/').map(Number);
   const rect=canvas.getBoundingClientRect(),sx=rect.width/width,sy=rect.height/height,scale=canvas.width/width;
   const top=height-label.y-label.height;
   const bg=canvas.getContext('2d').getImageData(Math.round((label.x+label.width/2)*scale),Math.round((top+label.height/2)*scale),1,1).data;
   return {...label,visible:[...row.querySelectorAll('.translation-block-text')].some(node=>{
    if(node.textContent.trim()!==label.text)return false;
    const box=node.getBoundingClientRect(),color=getComputedStyle(node).color.match(/\\d+/g).map(Number);
    return box.width>0 && box.height>0 && (box.left-rect.left)/sx>=label.x-0.5
     && (box.right-rect.left)/sx<=label.x+label.width+0.5 && (box.top-rect.top)/sy>=top-0.5
     && (box.bottom-rect.top)/sy<=top+label.height+0.5 && Math.hypot(...color.slice(0,3).map((v,i)=>v-bg[i]))>80;
   })};
  });`);
  assert.ok(tableLabels.every(label=>label.visible),document.id+' readable table labels: '+JSON.stringify(tableLabels.filter(label=>!label.visible)));
  const preservedRegions = (await browser.evaluate(`return ${JSON.stringify(document.preservedRegions ?? [])}.map(region=>{
   const row=document.querySelector('article[data-page="'+region.page+'"]');
   const original=row.querySelector('.original-panel canvas'),translated=row.querySelector('.translated-panel > .canvas-shell > canvas');
   const [width,height]=row.querySelector('.original-panel .canvas-shell').style.aspectRatio.split('/').map(Number),scale=original.width/width;
   const x=Math.ceil(region.x*scale),y=Math.ceil((height-region.y-region.height)*scale),w=Math.floor(region.width*scale),h=Math.floor(region.height*scale);
   const before=original.getContext('2d').getImageData(x,y,w,h).data,after=translated.getContext('2d').getImageData(x,y,w,h).data;
   let differences=0;const changed=[];
   for(let i=0;i<before.length;i+=4)if(Math.max(Math.abs(before[i]-after[i]),Math.abs(before[i+1]-after[i+1]),Math.abs(before[i+2]-after[i+2]))>(region.tolerance||0)){
    differences++;if(changed.length<5)changed.push({x:x+(i/4)%w,y:y+Math.floor(i/4/w),before:Array.from(before.slice(i,i+3)),after:Array.from(after.slice(i,i+3))});
   }
   return {...region,differences,changed,pixelsChecked:w*h,sourcePixels:Array.from(before)};
  });`)).map(({sourcePixels,...region})=>({...region,sourceHash:createHash('sha256').update(Buffer.from(sourcePixels)).digest('hex')}));
  for(const region of preservedRegions)assert.ok(region.differences<=Math.floor(region.pixelsChecked*(region.maximumDifferentRatio||0)),document.id+' preserved region on page '+region.page+': '+JSON.stringify(region));
  if(document.sourceId){
   const original=checks.find(check=>check.document===document.sourceId);
   assert.deepEqual(preservedRegions.map(region=>region.sourceHash),original.preservedRegions.map(region=>region.sourceHash),'font renaming preserves source rendering in checked regions');
  }
  if(document.pages)assert.equal(pages,document.pages,'corpus page count');
  const start=requests.length;
  if(document.id==='fixture'){
   assert.equal(fontRequests,0,'reading and translation never download fonts');
   await browser.evaluate('document.querySelector("#downloadDocument").click();');
   await wait(()=>browser.evaluate('return document.querySelector("#pdfFontDialog").open;'),Boolean,'font choice dialog');
   await browser.capture('font-choice.png');
   if(process.env.PDF_FONT_PROMPT_INSTALL==='1'){
    await browser.download('document.querySelector("#pdfFontInstall").click();',path.join(output,'fixture-install-and-export.pdf'));
    assert.equal(fontRequests,1,'font is installed only after confirming the export dialog');
   }else{
   const basic=path.join(output,'fixture-basic.pdf');
   await browser.download('document.querySelector("#pdfFontBasic").click();',basic);
   const basicLoading=getDocument({data:new Uint8Array(await fs.readFile(basic))}),basicPdf=await basicLoading.promise;
   assert.equal(basicPdf.numPages,pages);
   assert.equal((await(await basicPdf.getPage(1)).getTextContent()).items.length,0,'basic export remains image-only');
   await basicLoading.destroy();assert.equal(fontRequests,0,'basic export needs no font download');
   await browser.evaluate('document.querySelector("#pdfFontAction").click();');
   await wait(()=>browser.evaluate('return document.querySelector("#pdfFontDialog").open;'),Boolean,'font installer');
   await browser.capture('font-installer.png');
   await browser.evaluate('document.querySelector("#pdfFontInstall").click();');
   await wait(()=>browser.evaluate('return {open:document.querySelector("#pdfFontDialog").open,state:document.querySelector("#pdfFontAction").dataset.state,status:document.querySelector("#pdfFontStatus").textContent,statusState:document.querySelector("#pdfFontStatus").dataset.state};'),v=>{assert.notEqual(v.statusState,'error','font installation failed: '+JSON.stringify(v));return !v.open&&v.state==='installed';},'font installed');
   assert.equal(fontRequests,1,'one explicit font installation');
   }
  }
  const destination=path.join(output,document.id+'-translated.pdf');
  await browser.download('document.querySelector("#downloadDocument").click();',destination);
  assert.equal(requests.length,start,'export reuses completed translations');
  assert.equal(fontRequests,1,'subsequent export reuses the installed font');
  const loading=getDocument({data:new Uint8Array(await fs.readFile(destination))}),pdf=await loading.promise;
  const texts=[];for(let i=1;i<=pdf.numPages;i++)texts.push((await(await pdf.getPage(i)).getTextContent()).items.map(item=>item.str??'').join(''));
  assert.equal(texts.length,pages);assert.ok(texts.some(text=>text.includes('译文')),'Chinese text remains searchable');
  if(document.id==='fixture'){
   const crop=(await pdf.getPage(3)).getViewport({scale:1}),rotation=(await pdf.getPage(4)).getViewport({scale:1});
   assert.deepEqual([crop.width,crop.height],[500,600]);assert.deepEqual([rotation.width,rotation.height],[800,600]);
   assert.ok(texts[0].includes('Smith J. Clinical measurements.'),'references retain their original text');
   assert.ok(texts[0].includes('PPV')&&texts[0].includes('NPV')&&texts[0].includes('RNN'));
   assert.ok(!texts.join('').includes('付费观看')&&!texts.join('').includes('净现值'));
   assert.ok(texts[1].includes('Jones K. Further observations.'));
   assert.ok(texts[1].includes('附录'));
  }else if(document.id==='paper'){
   assert.ok(texts[8].includes('Krittanawong'),'mixed bibliography remains searchable');
   assert.ok(texts[9].includes('Halpern'),'bibliography continuation retains original text');
  }
  await loading.destroy();
  const fontFallbackPages=await browser.evaluate('return JSON.parse(document.querySelector("#downloadDocument").dataset.fontFallbackPages??"[]");');
  checks.push({document:document.id,outcome:'translated',pages,pagesChecked:pageChecks.length,preservedRegions,fontFallbackPages,textLengths:texts.map(text=>text.length),blocks:layout.length,minimumFontRatio:Math.min(...layout.map(block=>block.size/block.preferred)),bytes:(await fs.stat(destination)).size,export:destination});
 }
 assert.ok(requests.every(input=>input.context?.includes('Academic document:')));
 assert.ok(requests.every(input=>!input.texts.some(text=>/^(?:PPV|NPV|RNN)$/u.test(text))));
 assert.ok(requests.some(input=>input.texts.some(text=>text.includes('segment annotations (fine-grained'))),'italic annotations remain translatable');
 assert.ok(requests.some(input=>input.texts.some(text=>/^IV\. THE ⟪WUPAGE\d+⟫ MODEL$/u.test(text))),'small-caps MODEL stays outside the symbol crop');
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,browser:target.kind,userAgent,mock:true,checks,requests},null,2));
 console.log(JSON.stringify({passed:true,browser:target.kind,userAgent,checks}));
}catch(error){await browser?.capture('failure.png').catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,browser:target.kind,checks,error:String(error)},null,2));throw error;}
finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
