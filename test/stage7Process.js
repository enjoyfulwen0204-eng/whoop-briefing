import {readFileSync,writeFileSync} from 'node:fs';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createStage7InteractionStore} from '../src/stage7InteractionStore.js';
const [mode,path,packet]=process.argv.slice(2),db=createOwnedFileDb({url:'file:'+path,phase4Keys:fixtureKeys}),now=()=>new Date('2026-09-19T00:00:00.000Z');
try{
 if(mode==='create'){await db.migrate({targetVersion:34});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});await db.linkTelegram({userId:'a',chatId:'123',now:now()});}
 const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,now,authorizeMode:m=>{if(m!=='SHADOW')throw Error('SYNTHETIC_ONLY');}});
 if(mode==='create')await core.initializeTenant('a','SHADOW');
 const s=createStage7InteractionStore({core,db}),user=await db.getUser('a'),actor=await s.authenticate({user,chatId:'123'});
 if(mode==='create'){
  const {row}=await s.issue(actor,{category:'caffeine',targetDate:'2026-09-18'}),reply=await s.render(actor,row);await s.bind(actor,row.interaction_id,42);
  writeFileSync(packet,JSON.stringify({id:row.interaction_id,data:reply.replyMarkup.inline_keyboard[0][0].callback_data}));
 }else{
  const record=JSON.parse(readFileSync(packet,'utf8')),resolved=await s.resolve(actor,{id:'opaque-query',data:record.data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}});
  if(mode==='resolve'){if(resolved?.action!=='NO')throw Error('RESTART_CALLBACK_NOT_FOUND');await db.transaction(()=>s.update(actor,resolved.row,{state:'SKIPPED'}));}
  if(mode==='stale'&&resolved!==null)throw Error('STALE_CALLBACK_ACCEPTED');
 }
 console.log('PASS');
}finally{db.close();}
