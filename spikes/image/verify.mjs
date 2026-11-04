import {browser,root,openComposition} from './lib.mjs';
import {render} from './render.mjs';
import {check} from './check-fidelity.mjs';
import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const base=path.join(root,'out/compositions/launch-1');
const files=['index.html','styles.css','composition.json'];
async function clone(name){const target=path.join(root,'out/compositions',name);await mkdir(target,{recursive:true});for(const f of files)await copyFile(path.join(base,f),path.join(target,f));return target;}
const b=await browser();
try{
 const report={versions:{node:process.version,playwright:JSON.parse(await readFile(path.join(root,'node_modules/playwright/package.json'))).version,chromium:b.version()},renders:[],fidelity:{},negatives:{}};
 const initial=await clone('initial-baseline');for(const f of files)await writeFile(path.join(initial,f),execFileSync('git',['-C',base,'show',`HEAD~1:${f}`]));
 report.fidelity.initial=await check(b,initial,{output:path.join(root,'out/logs/initial-fidelity.json')});
 report.renders.push(await render(b,base,path.join(root,'out/renders/launch-revision-2.png')));
 report.fidelity.edited=await check(b,base,{output:path.join(root,'out/logs/edited-fidelity.json')});
 report.warmMs=[];for(let i=0;i<5;i++)report.warmMs.push((await render(b,base,path.join(root,'out/renders/launch-revision-2.png'))).ms);
 for(const [name,w,h] of [['square',1080,1080],['portrait',1080,1350]]){
  const dir=await clone(name),config=JSON.parse(await readFile(path.join(dir,'composition.json')));config.width=w;config.height=h;await writeFile(path.join(dir,'composition.json'),JSON.stringify(config,null,2)+'\n');
  report.renders.push(await render(b,dir,path.join(root,`out/renders/launch-${name}.png`)));
  report.fidelity[name]=await check(b,dir,{output:path.join(root,`out/logs/${name}-fidelity.json`)});
  report[`${name}OnlySizeChanged`]=files.filter(f=>f!=='composition.json').every(f=>execFileSync('cmp',[path.join(base,f),path.join(dir,f)]).length===0);
 }
 for(const [name,extra] of [['filter','img[data-bip-source]{filter:saturate(1.4)!important;}'],['text','.unmarked-test{position:absolute;top:70px;left:20px;z-index:5;background:white;color:black;font:30px sans-serif;}']]){
  const dir=await clone(`negative-${name}`);await writeFile(path.join(dir,'styles.css'),await readFile(path.join(dir,'styles.css'),'utf8')+'\n'+extra+'\n');
  if(name==='text')await writeFile(path.join(dir,'index.html'),(await readFile(path.join(dir,'index.html'),'utf8')).replace('<div class="browser-frame" data-bip-frame>','<div class="browser-frame" data-bip-frame><div class="unmarked-test">UNMARKED OVERLAY</div>'));
  report.negatives[name]=await check(b,dir,{output:path.join(root,`out/logs/negative-${name}.json`)});
 }
 const c=await openComposition(b,base);try{await c.page.evaluate(async()=>{try{await fetch('https://example.com/bip-network-probe');}catch{}});report.networkBlocked=c.blocked.includes('https://example.com/bip-network-probe');}finally{await c.close();}
 const config=JSON.parse(await readFile(path.join(base,'composition.json')));const asset=path.join(root,'out/assets',config.sources[0]+'.png');
 report.asset={sha:createHash('sha256').update(await readFile(asset)).digest('hex'),mode:((await stat(asset)).mode&0o777).toString(8)};
 report.revisions=execFileSync('git',['-C',base,'log','--format=%h %s']).toString().trim().split('\n');
 report.agentEdit={provider:'manual-fallback',codexSucceeded:false,attempts:2,headline:config.slots.headline,background:config.slots.background,annotation:(await readFile(path.join(base,'index.html'),'utf8')).includes('data-bip-annotation')};
 report.compositionChecksPass=Object.values(report.fidelity).every(r=>r.pass)&&Object.values(report.negatives).every(r=>!r.pass)&&report.renders.every(r=>!r.overflow.length)&&report.warmMs.every(t=>t<3000)&&report.revisions.length===2&&report.networkBlocked&&report.asset.mode==='444'&&report.asset.sha===config.sources[0]&&report.agentEdit.headline==='My portfolio, rebuilt from scratch'&&report.agentEdit.annotation&&report.squareOnlySizeChanged&&report.portraitOnlySizeChanged;
 report.pass=report.compositionChecksPass&&report.agentEdit.codexSucceeded;
 await writeFile(path.join(root,'out/logs/verification.json'),JSON.stringify(report,null,2));
 execFileSync('git',['-C',base,'show','HEAD','--format=fuller'],{encoding:'utf8'});await writeFile(path.join(root,'out/logs/revision-2.patch'),execFileSync('git',['-C',base,'show','HEAD','--format=fuller']));
 // Gitignore cannot express size predicates. Enumerate exact large generated paths.
 const large=[];async function scan(dir){for(const ent of await readdir(dir,{withFileTypes:true})){if(ent.name==='.git')continue;const p=path.join(dir,ent.name);if(ent.isDirectory())await scan(p);else if((await stat(p)).size>20*1024*1024)large.push('/'+path.relative(root,p));}}await scan(path.join(root,'out'));
 await writeFile(path.join(root,'.gitignore'),'node_modules/\n# Exact generated files over 20 MiB (updated by verify.mjs).\nout/large-files/\n'+large.join('\n')+'\n');
 console.log(JSON.stringify(report,null,2));process.exitCode=report.pass?0:1;
}finally{await b.close();}
