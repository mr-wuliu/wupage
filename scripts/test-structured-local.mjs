import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker as NativeWorker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root=process.cwd(), output=path.join(root,'.npm-cache/structured-translation');
// Optional real-model regression. Uses existing files only; never downloads.
const fixture=process.env.LOCAL_MODEL_FIXTURE_DIR;
if(!fixture)throw new Error('Set LOCAL_MODEL_FIXTURE_DIR to the cached en-zh-Hans model directory and run build:firefox first.');
const model=JSON.parse(await fs.readFile(path.join(root,'src/local/catalog.json'),'utf8')).find(model=>model.id==='en-zh-Hans');
const files=Object.fromEntries(model.files.map(file=>[file.role,file.name]));
for(const file of model.files){const data=await fs.readFile(path.join(fixture,file.name));assert.equal(data.length,file.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256);}
const runtime=path.join(root,'dist-firefox/bergamot-runtime/translator-worker.js');
const wasm=await fs.readFile(path.join(root,'dist-firefox/bergamot-runtime/bergamot-translator-worker.wasm'));
await build({entryPoints:[path.join(root,'src/local/engine.ts')],outfile:path.join(output,'engine-check.mjs'),bundle:true,platform:'node',format:'esm',
  define:{'import.meta.env.MODE':'"test"'},plugins:[{name:'cached-model',setup(build){
    build.onResolve({filter:/^\.\/model-store$/},()=>({path:'cached-model',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import fs from 'node:fs/promises';export async function readLocalModel(){const files=${JSON.stringify(files)},base=${JSON.stringify(fixture)};return Object.fromEntries(await Promise.all(Object.entries(files).map(async([key,name])=>{const buffer=await fs.readFile(base+'/'+name);return [key,buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)];})));}`,loader:'js'}));
  }}]});
const {window}=new JSDOM();
globalThis.DOMParser=window.DOMParser;globalThis.Element=window.Element;globalThis.Node=window.Node;
globalThis.chrome={runtime:{getURL:value=>value}};
globalThis.Worker=class{
  constructor(){
    this.worker=new NativeWorker(`const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');global.require=require;global.__dirname=path.dirname(${JSON.stringify(runtime)});global.__filename=${JSON.stringify('/'+runtime.replaceAll('\\','/'))};vm.runInThisContext(fs.readFileSync(${JSON.stringify(runtime)},'utf8'),{filename:${JSON.stringify(runtime)}});`,{eval:true});
    this.worker.on('message',data=>this.onmessage?.({data}));
    this.worker.on('error',error=>{console.error(error);this.onerror?.({preventDefault(){}});});
  }
  postMessage(message,transfer=[]){if(message.name==='initialize')message.args[0].wasmBinary=wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength);this.worker.postMessage(message,transfer);}
  terminate(){this.worker.terminate();}
};
const {LocalTranslationEngine}=await import(pathToFileURL(path.join(output,'engine-check.mjs')).href);
await build({stdin:{contents:"export {normalizeProtectedText} from './src/shared/protected-text.ts';export {translateProtectedText} from './src/background/protected-translation.ts';",resolveDir:root,loader:'ts'},outfile:path.join(output,'protected-check.mjs'),bundle:true,platform:'node',format:'esm'});
const {normalizeProtectedText,translateProtectedText}=await import(pathToFileURL(path.join(output,'protected-check.mjs')).href);
const engine=new LocalTranslationEngine();
try{
  const texts=['Read ⟪WUPAGEOPEN0⟫the complete guide⟪WUPAGECLOSE0⟫ now.','Click ⟪WUPAGEOPEN0⟫Save⟪WUPAGECLOSE0⟫ to keep changes.'];
  const route=[model];
  const raw=await engine.translate(route,texts);
  let calls=0;
  const translations=await translateProtectedText({texts,sourceLang:'en',targetLang:'zh-CN',preservePlaceholders:true},request=>{calls++;return engine.translate(route,request.texts);});
  translations.forEach((text,index)=>{assert.match(text,/\p{Script=Han}/u);assert.equal(normalizeProtectedText(texts[index],text),text);});
  const report={passed:true,engine:'Bergamot 0.4.9',model:'cached en-zh-Hans',htmlAlignment:true,rawAlignmentAccepted:raw.filter((text,index)=>normalizeProtectedText(texts[index],text)!==undefined).length,protectedRecoveryCalls:calls,translations};
  await fs.writeFile(path.join(output,'local-model-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{engine.release();window.close();}
