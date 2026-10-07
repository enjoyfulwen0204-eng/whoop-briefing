import {readFileSync,existsSync} from 'node:fs';import {spawn} from 'node:child_process';
const index=process.argv[2];if(!/^[012]$/.test(index??''))throw Error('SHARD_INDEX_REQUIRED');
const list=`tmp/v32-shard-${index}.list`;
const files=existsSync(list)?readFileSync(list,'utf8').trim().split('\n'):
 JSON.parse(readFileSync('docs/phase4-v32-evidence/relevant-files.json','utf8')).filter((_,position)=>position%3===Number(index));
const child=spawn(process.execPath,['scripts/test-stage5-closure.mjs',...files],{stdio:'inherit',env:{...process.env,STAGE5_TEST_OUTPUT:`tmp/v32-broad-${index}`,STAGE5_TEST_TIMEOUT_MS:'600000'}});
child.on('error',error=>{console.error(error.code);process.exitCode=1;});
child.on('close',(code,signal)=>{process.exitCode=signal?1:code??1;});
