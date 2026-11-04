import {browser,openComposition,overflow} from './lib.mjs';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
export async function render(b,dir,out){const start=performance.now();const c=await openComposition(b,dir);try{await c.page.screenshot({path:out,animations:'disabled'});return {out,width:c.config.width,height:c.config.height,dpr:2,ms:Math.round(performance.now()-start),overflow:await overflow(c.page),blocked:c.blocked};}finally{await c.close();}}
if(process.argv[1]?.endsWith('/render.mjs')){const b=await browser();try{const report=await render(b,process.argv[2],process.argv[3]);await writeFile(process.argv[3]+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}finally{await b.close();}}
