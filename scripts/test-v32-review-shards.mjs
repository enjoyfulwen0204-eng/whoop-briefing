import {spawn} from 'node:child_process';import {readFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
const files=JSON.parse(readFileSync('docs/phase4-v32-review-files.json','utf8'));
const label=process.argv[2]??'';
if(label&&!/^[a-z0-9-]+$/.test(label))throw Error('EVIDENCE_LABEL_INVALID');
if(new Set(files).size!==files.length)throw Error('DUPLICATE_TEST_FILE');
let failed=false;
for(let index=0;index<3;index++){
 const output=`tmp/v32-review-${label?`${label}-`:''}broad-${index}`;
 if(existsSync(output)&&readdirSync(output).length)throw Error('FRESH_EVIDENCE_DIRECTORY_REQUIRED');mkdirSync(output,{recursive:true});
 const child=spawn(process.execPath,['scripts/test-stage5-closure.mjs',...files.filter((_,position)=>position%3===index)],
  {stdio:'inherit',env:{...process.env,STAGE5_TEST_OUTPUT:output,STAGE5_TEST_TIMEOUT_MS:'600000'}});
 const outcome=await new Promise(resolve=>{child.on('error',error=>resolve({error:error.code}));child.on('close',(code,signal)=>resolve({code,signal}));});
 console.log(JSON.stringify({shard:index,...outcome}));if(outcome.code!==0)failed=true;
}
process.exitCode=failed?1:0;
