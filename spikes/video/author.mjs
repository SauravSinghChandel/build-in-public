import fs from 'node:fs/promises';
const capture=JSON.parse(await fs.readFile('out/capture/events.json','utf8'));
const model=`export const capture=${JSON.stringify(capture)};
export const ramp={start:10.2,end:11.6,rate:2};
export const contentDuration=12.3;
export const sourceTime=t=>t<ramp.start?t:t<10.9?10.2+(t-10.2)*2:t+.7;
export const outputTime=t=>t<10.2?t:t<11.6?10.2+(t-10.2)/2:t-.7;
const clamp=x=>Math.max(0,Math.min(1,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
const smoother=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10)};
const points=capture.events.filter(e=>e.type==='pointermove');
const clicks=capture.events.filter(e=>e.type==='click');
export function state(t,zoomReturn=.5){
 const st=sourceTime(t);let a={t:0,x:740,y:480},b=a;
 for(const p of points){if(p.t<=st)a=p;else{b=p;break}}if(b.t<a.t)b=a;
 const f=b.t===a.t?0:clamp((st-a.t)/(b.t-a.t));const x=a.x+(b.x-a.x)*f,y=a.y+(b.y-a.y)*f;
 let z=1,ox=720,oy=450,ripple=0,rx=0,ry=0;
 for(const c of clicks){const ct=outputTime(c.t),d=t-ct;const ease=zoomReturn>.5?smoother:smooth;
 const w=d<0?ease((d+.4)/.4):d<.35?1:1-ease((d-.35)/zoomReturn);
 if(w>0){z=1+.6*w;ox=c.x;oy=c.y;}if(d>=0&&d<.45){ripple=d/.45;rx=c.x;ry=c.y;}
 }
 // Keep the 1440x900 source covering the viewport even for clicks in the top navigation.
 const tx=Math.max(1440*(1-z),Math.min(0,720-ox*z));
 const ty=Math.max(900*(1-z),Math.min(0,450-oy*z));
 return {x,y,z,tx,ty,ripple,rx,ry};
}
`;
for(const engine of ['hyperframes','remotion']){
 const dir=engine==='hyperframes'?'hyperframes/assets':'remotion/public';await fs.mkdir(dir,{recursive:true});await fs.copyFile('out/capture/raw.mp4',`${dir}/raw.mp4`);await fs.copyFile('out/capture/events.json',`${dir}/events.json`);await fs.writeFile(`${engine}/model.mjs`,model);await fs.writeFile(`${engine}/settings.json`,JSON.stringify({intro:2.5,zoomReturn:.5,outroAdvance:0},null,2)+'\n');
}
await fs.copyFile('hyperframes/node_modules/gsap/dist/gsap.min.js','hyperframes/assets/gsap.min.js');
