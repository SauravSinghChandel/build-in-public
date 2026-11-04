import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const [engine,version='v2',suffix='']=process.argv.slice(2);if(!['hyperframes','remotion'].includes(engine))throw Error('engine');
const base=new URL('.',import.meta.url).pathname;
const output=`../out/${engine}-${version}${suffix}.mp4`;
const chrome='/home/justbuster/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const args=engine==='hyperframes'?['hyperframes','render','--workers=2','--crf=22','--video-frame-format=png','-o',output]:['remotion','render','src/index.ts','Portfolio',output,`--browser-executable=${chrome}`,'--concurrency=2','--crf=22','--log=info'];
const fd=fs.openSync(`${base}out/${engine}-${version}${suffix}.log`,'w');const start=performance.now();const p=spawnSync('npx',args,{cwd:`${base}${engine}`,env:{...process.env,TMPDIR:'/tmp/bip-spike-video',XDG_CONFIG_HOME:'/tmp/bip-spike-video/config',XDG_STATE_HOME:'/tmp/bip-spike-video/state',HYPERFRAMES_NO_TELEMETRY:'1',HYPERFRAMES_BROWSER_PATH:chrome},stdio:['ignore',fd,fd]});
fs.writeFileSync(`${base}out/${engine}-${version}${suffix}.seconds`,`${(performance.now()-start)/1000}\n`);fs.closeSync(fd);console.log({engine,version,suffix,status:p.status,seconds:(performance.now()-start)/1000});process.exitCode=p.status??1;
