import {browser,openComposition,overflow,root} from './lib.mjs';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function check(b,dir,{maxMismatchPct=3.0,output}={}){
 const c=await openComposition(b,dir);
 try{
 const lint=await c.page.evaluate(()=>{
  const errors=[],images=[];const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  for(const img of document.querySelectorAll('[data-bip-source]')){
   const r=img.getBoundingClientRect();images.push({sha:img.dataset.bipSource,src:img.src,box:{x:r.x,y:r.y,width:r.width,height:r.height}});
   for(let e=img;e&&e!==document.documentElement;e=e.parentElement){const s=getComputedStyle(e);for(const [k,v] of [['filter','none'],['mixBlendMode','normal'],['backdropFilter','none']])if(s[k]!==v)errors.push(`${e.tagName}.${e.className}: ${k}=${s[k]}`);if(Number(s.opacity)<1)errors.push(`opacity=${s.opacity}`);if(s.transform!=='none')errors.push('transformed screenshot unsupported');}
   const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
   while(walk.nextNode()){const n=walk.currentNode,p=n.parentElement;if(!n.textContent.trim()||p.closest('script,style,[data-bip-annotation]'))continue;if(getComputedStyle(p).visibility==='hidden'||!p.getClientRects().length)continue;const range=document.createRange();range.selectNodeContents(n);if([...range.getClientRects()].some(t=>overlap(r,t)))errors.push(`unmarked text overlaps screenshot: ${n.textContent.trim().slice(0,70)}`);}
  }
  if(!images.length)errors.push('missing source image');return {errors,images};
 });
 const screenshot=PNG.sync.read(await c.page.screenshot({animations:'disabled'}));const diffs=[];
 for(const item of lint.images){
  const source=await readFile(path.join(root,'out/assets',item.sha+'.png'));const hash=createHash('sha256').update(source).digest('hex');if(hash!==item.sha||!c.config.sources.includes(hash))lint.errors.push('source hash mismatch');
  const expectedSrc=new URL('/out/assets/'+item.sha+'.png',c.page.url()).href;if(item.src!==expectedSrc)lint.errors.push('source URL does not match declared hash');
  const {x,y,width,height}=item.box;const px=Math.round(x*2),py=Math.round(y*2),w=Math.round(width*2),h=Math.round(height*2);
  // Chromium canvas uses the same browser resampling family; independent source pixels, no composition CSS.
  const expectedURL=await c.page.evaluate(async({src,w,h})=>{const img=new Image();img.src=src;await img.decode();const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(img,0,0,w,h);return canvas.toDataURL();},{src:expectedSrc,w,h});
  const expected=PNG.sync.read(Buffer.from(expectedURL.split(',')[1],'base64'));const actual=new PNG({width:w,height:h});PNG.bitblt(screenshot,actual,px,py,w,h,0,0);
  const diff=new PNG({width:w,height:h});const mismatches=pixelmatch(actual.data,expected.data,diff.data,w,h,{threshold:.1,includeAA:false});const pct=mismatches/(w*h)*100;
  diffs.push({sha:hash,width:w,height:h,mismatches,mismatchPct:pct,maxMismatchPct});if(output)await writeFile(output.replace(/\.json$/,'.diff.png'),PNG.sync.write(diff));
 }
 const report={pass:lint.errors.length===0&&diffs.every(d=>d.mismatchPct<=maxMismatchPct),errors:lint.errors,diffs,overflow:await overflow(c.page),blocked:c.blocked};if(output)await writeFile(output,JSON.stringify(report,null,2));return report;
 }finally{await c.close();}
}
if(process.argv[1]?.endsWith('/check-fidelity.mjs')){const b=await browser();try{const report=await check(b,process.argv[2],{output:process.argv[3]});console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;}finally{await b.close();}}
