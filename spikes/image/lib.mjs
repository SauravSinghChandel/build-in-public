import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=path.dirname(fileURLToPath(import.meta.url));
export async function server(dir){
 const base=await realpath(dir);
 const srv=createServer(async(req,res)=>{try{
  let target=path.resolve(base,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if((await stat(target)).isDirectory())target=path.join(target,'index.html');
  target=await realpath(target);
  if(!target.startsWith(base+path.sep))throw Error('outside root');
  res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(target)]??'application/octet-stream');
  res.end(await readFile(target));
 }catch{res.writeHead(404);res.end('Not found');}});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 return {origin:`http://127.0.0.1:${srv.address().port}`,close:()=>new Promise(r=>srv.close(r))};
}
export async function browser(){return chromium.launch({headless:true,chromiumSandbox:false});}
export async function openComposition(b,dir){
 const config=JSON.parse(await readFile(path.join(dir,'composition.json'),'utf8'));
 // Serve only this spike; source assets are siblings of composition workspaces.
 const srv=await server(root);
 const context=await b.newContext({viewport:{width:config.width,height:config.height},deviceScaleFactor:2,serviceWorkers:'block'});
 const blocked=[];
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===srv.origin)return route.continue();blocked.push(url.href);return route.abort('blockedbyclient');});
 const page=await context.newPage();
 await page.goto(srv.origin+'/'+path.relative(root,path.resolve(dir)).split(path.sep).join('/')+'/index.html',{waitUntil:'load'});
 await page.waitForFunction(()=>window.bipReady===true);
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
 return {page,config,blocked,close:async()=>{await context.close();await srv.close();}};
}
export async function overflow(page){return page.evaluate(()=>[...document.body.querySelectorAll('*')].filter(e=>!['SCRIPT','STYLE'].includes(e.tagName)).flatMap(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.x<-.5||r.y<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5)?[{tag:e.tagName,class:e.className,box:{x:r.x,y:r.y,width:r.width,height:r.height}}]:[];}));}
