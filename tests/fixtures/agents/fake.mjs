#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fake-agent 1.0.0');process.exit(0);}
if(args[0]==='login'){console.log('signed in');process.exit(0);}
const provider=args[0]==='exec'?'codex':'claude';
const prompt=args.at(-1)||'';
const mode=process.env.BIP_FAKE_MODE|| (prompt.includes('FAKE_SLOW')?'slow':prompt.includes('FAKE_INVALID')?'invalid':'success');
if(mode==='nonzero'){console.error('Fixture process failed');process.exit(7);}
const resume=args.includes('resume')||args.includes('--resume');
let lines=fs.readFileSync(path.join(dir,`${provider}-${resume?'resume':'draft'}.jsonl`),'utf8').trim().split('\n').map(JSON.parse);
let output;
if(prompt.includes('TASK: story.angles')) {
 const commits=[...new Set(prompt.match(/Commit ([a-f0-9]{40,64})/g)||[])].map(v=>v.slice(7));
 output={angles:[{title:'A smaller daily workflow',hook:'I removed a repeated step.',why_interesting:'A concrete change to everyday work',commits},{title:'What I learned building this',hook:'One detail changed how I approached it.',why_interesting:'A practical lesson',commits},{title:'The implementation detail',hook:'Here is the part I spent time on.',why_interesting:'A technical tradeoff',commits}]};
} else if(prompt.includes('TASK: project.summary')) output={what_it_is:'A local project workspace.',who_its_for:'Developers',stack:['TypeScript'],notable_parts:['Commit timeline']};
else if(prompt.includes('TASK: post.edit')) {
 const parts=prompt.includes('Shorten')?['I simplified my daily workflow by removing a repeated step.']:['I built a smaller workflow around the detail that mattered.'];
 output=prompt.includes('Edit only x.')?{x:{parts},highlights:[],claims_to_verify:[]}:{linkedin:{text:'I simplified the workflow around one repeated step.\n\n'+('The useful part was making the next action clear and keeping the work close to its context. '.repeat(8))},highlights:[],claims_to_verify:[]};
}
if(prompt.includes('TASK: post.draft')) { const recorded=fs.readFileSync(path.join(dir,`${provider}-draft.jsonl`),'utf8').trim().split('\n').map(JSON.parse); output=provider==='claude'?recorded.find(e=>e.type==='result').structured_output:JSON.parse(recorded.find(e=>e.type==='item.completed'&&e.item.type==='agent_message').item.text); }
if(prompt.includes('TASK: video.edit')) {
 const file=path.join(process.cwd(),'composition.json'),comp=JSON.parse(fs.readFileSync(file,'utf8'));
 comp.scenes[0].endMs-=100;
 for(const scene of comp.scenes.slice(1)){scene.startMs-=100;scene.endMs-=100;}
 for(const caption of comp.captions){caption.startMs-=100;caption.endMs-=100;}
 comp.durationMs-=100;fs.writeFileSync(file,JSON.stringify(comp,null,2));
 if(prompt.includes('VIDEO_GSAP_FAIL'))fs.writeFileSync(path.join(process.cwd(),'motion.js'),'window.gsap.to("#root",{});');
 output={done:true};
} else if(prompt.includes('TASK: video.steps')) output={steps:[{action:'pause',ms:1000},{action:'click',selector:'#go'},{action:'pause',ms:2000}]};
else if(prompt.includes('TASK: image.edit')) {
 const file=path.join(process.cwd(),'composition.json');
 const comp=JSON.parse(fs.readFileSync(file,'utf8'));
 comp.slots.headline='A headline from the fake agent';
 fs.writeFileSync(file,JSON.stringify(comp,null,2));
 if(prompt.includes('FILTER_FAIL'))fs.appendFileSync(path.join(process.cwd(),'styles.css'),'\nimg[data-bip-source]{filter:saturate(1.4)}');
 output={done:true};
} else if(prompt.includes('TASK: image.steps'))output={steps:[{action:'wait',ms:50}]};
else if(prompt.includes('TASK: image.alt'))output={alt:'A screenshot of the project workspace.'};
if(mode==='invalid')output={wrong:'shape'};
if(output) lines=lines.map(e=>{
 if(e.type==='result')return {...e,structured_output:output};
 if(e.type==='item.completed'&&e.item.type==='agent_message')return {...e,item:{...e.item,text:JSON.stringify(output)}};
 return e;
});
// Session arrives before slow output, so a killed server has a durable resume id.
console.log(JSON.stringify(lines.shift()));
if(mode==='stubborn') {process.on('SIGINT',()=>{});setTimeout(finish,30000);}
else if(mode==='slow'&&!resume) { process.on('SIGINT',()=>process.exit(130));setTimeout(finish,30000); }
else setTimeout(finish,60);
function finish(){for(const e of lines)console.log(JSON.stringify(e));}
