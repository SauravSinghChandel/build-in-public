import {server,browser,root} from './lib.mjs';
import {createHash} from 'node:crypto';
import {writeFile,chmod,mkdir} from 'node:fs/promises';
const s=await server('/tmp/bip-spike-image/site'),b=await browser();
try{const p=await b.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
 const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(s.origin,{waitUntil:'networkidle'});await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));});
 const bytes=await p.screenshot({animations:'disabled'}),sha=createHash('sha256').update(bytes).digest('hex');
 const target=`${root}/out/assets/${sha}.png`;await mkdir(`${root}/out/assets`,{recursive:true});await writeFile(target,bytes);await chmod(target,0o444);
 const report={sha,path:target,viewport:[1440,900],dpr:2,pixels:[2880,1800],bytes:bytes.length,title:await p.title(),errors};await writeFile(`${root}/out/logs/capture.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await b.close();await s.close();}
