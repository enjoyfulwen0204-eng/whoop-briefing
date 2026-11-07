import test from 'node:test';import assert from 'node:assert/strict';
import {createBetaEnrollment,BETA_COPY,requireBetaConsent} from '../src/betaEnrollment.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {checkAiBudget,aiMonth,notifyAiBudget} from '../src/aiMonthlyBudget.js';
import {createCoach} from '../src/coach.js';
import {computeCost} from '../src/usage.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {stage7Configuration} from '../src/stage7Runtime.js';
const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,5),auditKey:Buffer.alloc(32,6)});
const owner={id:'owner',displayName:'Owner',status:'ACTIVE',lifecycleGeneration:1,createdAt:'2026-09-01T00:00:00Z',timezone:'Asia/Taipei'};
const incoming=(text,id=123)=>({text,chat:{id,type:'private'},from:{id,first_name:'Synthetic',language_code:'en'}});
function fixture(){
 let at=new Date('2026-11-06T12:00:00Z'),tail=Promise.resolve(),connected=new Set(),failCreate=false;
 const state=new Map(),users=new Map([['owner',{...owner}]]),links=new Map(),locales=new Map([['owner','en']]);
 const db={getState:async k=>state.get(k)??null,setState:async(k,v)=>state.set(k,v),getUser:async id=>users.get(id)??null,
  listUsers:async()=>[...users.values()],listActiveUsers:async()=>[...users.values()].filter(u=>u.status==='ACTIVE'),getLocale:async id=>locales.get(id),setLocale:async(id,l)=>locales.set(id,l),
  getTelegramLink:async id=>links.get(id)??null,resolveUserByChatId:async id=>{const l=links.get(id);return l?{user:users.get(l.userId)}:null;},
  createUser:async input=>{const u={...input,id:'new-'+users.size,lifecycleGeneration:1,createdAt:at.toISOString()};users.set(u.id,u);if(failCreate)throw Error('SYNTHETIC_WRITE_FAILURE');return u;},
  claimTelegramChat:async({chatId,userId})=>{if(links.has(chatId))return {ok:false};links.set(chatId,{userId,status:'ACTIVE'});return {ok:true,userId};},ensureOnboarding:async()=>{},
  raw:{execute:async({args})=>({rows:connected.has(args[0])?[{ok:1}]:[]})},getAiUsage:async()=>[],
  transaction:async fn=>{const before=tail;let release;tail=new Promise(r=>release=r);await before;const saved=[state,users,links,locales].map(m=>structuredClone([...m]));try{return await fn();}catch(e){[state,users,links,locales].forEach((m,i)=>{m.clear();for(const [k,v]of saved[i])m.set(k,v);});throw e;}finally{release();}},
 };
 const env={REGISTRATION_MODE:'invite',BETA_MAX_USERS:'7',OWNER_USER_IDS:'owner',AI_MONTHLY_CAP_USD:'2'};
 const runtime=createBetaEnrollment({db,keys,environment:env,now:()=>at});
 const code=async()=>{const reply=await runtime.handle({user:owner,chatId:'1',text:'/admin invite',requestId:Math.random()});let rendered;
  await runtime.wrapSender(async input=>{rendered=input.reply.text;return {sent:true};},{botUsername:'synthetic_bot'} )({userId:'owner',reply});return rendered.match(/start=([\w-]+)/)[1];};
 return {db,runtime,env,state,users,links,locales,connected,code,setTime:v=>at=new Date(v),setFail:v=>failCreate=v};
}
test('only owners can issue an invitation; bearer code never persists in state or operation reply',async()=>{
 const f=fixture();assert.equal((await f.runtime.handle({user:{...owner,id:'outsider'},text:'/admin invite'}))?.betaInviteHandle,undefined);
 await assert.rejects(f.runtime.invite({...owner,id:'outsider'},1),{code:'BETA_OWNER_REQUIRED'});
 const code=await f.code();assert.ok(!JSON.stringify([...f.state]).includes(code));
});
test('single-use invitation is atomic across competing new chats',async()=>{
 const f=fixture(),code=await f.code();const results=await Promise.all([123,124].map(id=>f.runtime.register({message:incoming('/start '+code,id),chatId:String(id)})));
 assert.equal(results.filter(r=>r.text.includes('Welcome')).length,1);assert.equal(f.users.size,2);assert.equal(f.links.size,1);
});
test('expired/closed/full invitations create no account and no binding',async()=>{
 const f=fixture(),code=await f.code(),before=f.state.size;f.setTime('2026-11-13T12:00:00Z');
 assert.match((await f.runtime.register({message:incoming('/start '+code),chatId:'123'})).text,/expired/);assert.equal(f.users.size,1);assert.equal(f.state.size,before);
 f.env.REGISTRATION_MODE='closed';assert.match((await f.runtime.register({message:incoming('/start '+code),chatId:'123'})).text,/closed/);
 f.setTime('2026-11-06T12:00:00Z');f.env.REGISTRATION_MODE='invite';f.env.BETA_MAX_USERS='1';
 await f.runtime.register({message:incoming('/start '+code),chatId:'123'});const second=await f.code();assert.match((await f.runtime.register({message:incoming('/start '+second,124),chatId:'124'})).text,/filled/);assert.equal(f.users.size,2);
});
test('failed registration rolls back everything and invitation can be retried',async()=>{
 const f=fixture(),code=await f.code(),before=JSON.stringify([...f.state]);f.setFail(true);
 await assert.rejects(f.runtime.register({message:incoming('/start '+code),chatId:'123'}),/SYNTHETIC_WRITE_FAILURE/);
 assert.equal(f.users.size,1);assert.equal(f.links.size,0);assert.equal(JSON.stringify([...f.state]),before);
 f.setFail(false);assert.match((await f.runtime.register({message:incoming('/start '+code),chatId:'123'})).text,/Welcome/);
});
test('disclaimer binds user, lifecycle and version; consent has a timestamp, decline blocks WHOOP',async()=>{
 const f=fixture(),code=await f.code(),card=await f.runtime.register({message:incoming('/start '+code),chatId:'123'}),user=f.users.get('new-1');
 await assert.rejects(requireBetaConsent(f.db,user.id),{code:'BETA_CONSENT_REQUIRED'});
 const callback={data:card.replyMarkup.inline_keyboard[1][0].callback_data,message:{message_id:1}};
 await f.runtime.handle({user,chatId:'123',callback});assert.equal(await f.runtime.consented(user.id),false);
 const fresh=await f.runtime.handle({user,chatId:'123',text:'/start',requestId:3});callback.data=fresh.replyMarkup.inline_keyboard[0][0].callback_data;
 await f.runtime.handle({user,chatId:'123',callback});await requireBetaConsent(f.db,user.id);
 assert.deepEqual((await f.runtime.read('member',user.id)).consent,{version:'2026-11-07-v2',at:'2026-11-06T12:00:00.000Z'});
 const changed=createBetaEnrollment({db:f.db,keys,environment:f.env,version:'v2'});assert.equal(await changed.consented(user.id),false);
});
test('Stage7 new member needs ACTIVE + connected + current consent; disabled member excluded',async()=>{
 const f=fixture(),code=await f.code(),card=await f.runtime.register({message:incoming('/start '+code),chatId:'123'}),user=f.users.get('new-1');
 f.connected.add(user.id);assert.equal(await f.runtime.eligible(user),false);
 await f.runtime.handle({user,chatId:'123',callback:{data:card.replyMarkup.inline_keyboard[0][0].callback_data}});assert.equal(await f.runtime.eligible(user),true);
 user.status='DISABLED';assert.deepEqual(await f.runtime.eligibleIds(),[]);
 assert.equal(stage7Configuration({...f.env,STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on'}).dynamic,true);
});
test('tampered signed enrollment fails closed',async()=>{
 const f=fixture();await f.runtime.write('member','owner',{consent:{version:'2026-11-06-v1',at:'today'}});const key=f.runtime.key('member','owner');f.state.set(key,f.state.get(key).replace('today','yesterday'));await assert.rejects(f.runtime.consented('owner'),{code:'BETA_STATE_INVALID'});
});
test('all disclaimer buttons in three languages have icons',()=>{for(const c of Object.values(BETA_COPY))for(const key of ['yes','no'])assert.match(c[key],/^\p{Extended_Pictographic}/u);});
test('Taipei month starts at UTC 16:00 and resets independently of local timezone',async()=>{
 assert.equal(aiMonth(new Date('2026-11-30T15:59:59Z')).month,'2026-11');assert.equal(aiMonth(new Date('2026-11-30T16:00:00Z')).month,'2026-12');
 assert.equal(aiMonth(new Date('2026-11-06')).fromIso,'2026-10-31T16:00:00.000Z');
});
test('AI budget 79%, 80%, 100%, unknown pricing and bounded ledger',async()=>{
 const db={getAiUsage:async()=>[{estimated_cost_usd:1.58,request_status:'OK'}]},args={db,userId:'a',environment:{AI_MONTHLY_CAP_USD:'2'}};
 assert.equal((await checkAiBudget(args)).warning,false);db.getAiUsage=async()=>[{estimated_cost_usd:1.6,request_status:'OK'}];assert.equal((await checkAiBudget(args)).warning,true);db.getAiUsage=async()=>[{estimated_cost_usd:2,request_status:'OK'}];assert.equal((await checkAiBudget(args)).limited,true);
 db.getAiUsage=async()=>[{estimated_cost_usd:null,request_status:'OK'}];await assert.rejects(checkAiBudget(args),{code:'AI_BUDGET_COST_UNKNOWN'});
 db.getAiUsage=async()=>Array(10001).fill({estimated_cost_usd:0});await assert.rejects(checkAiBudget(args),{code:'AI_BUDGET_LEDGER_BOUNDS'});
});
test('central model client does not call provider or add a failed usage record at cap',async()=>{
 let calls=0,writes=0;const coach=createCoach({apiKey:'synthetic',userId:'a',db:{getAiUsage:async()=>[{estimated_cost_usd:2,request_status:'OK'}],recordAiUsage:async()=>writes++},env:{AI_MONTHLY_CAP_USD:'2'},fetchImpl:async()=>{calls++;assert.fail('provider');}});
 assert.equal(await coach.json({system:'synthetic',userMessage:'synthetic'}),null);assert.equal(calls,0);assert.equal(writes,0);
});
test('prices are known, null prices stay unknown, and Haiku long context is charged correctly',()=>{
 assert.equal(computeCost({model:'anthropic/claude-sonnet-5',inputTokens:1000000,outputTokens:1000000}),12);
 assert.ok(Math.abs(computeCost({model:'anthropic/claude-haiku-5.5',inputTokens:1000,outputTokens:1000})-.0006)<1e-12);
 assert.equal(computeCost({model:'anthropic/claude-haiku-5.5',inputTokens:100000,outputTokens:100000}),.3);
 assert.equal(computeCost({model:'x',inputTokens:1,outputTokens:1,pricing:{x:{input_per_million:null,output_per_million:null}}}),null);
});
test('v33 real transaction: invited onboarding creates signed consent state, not OAuth',async t=>{
 const {db,keys}=await syntheticStage7V33Fixture(t),user=await db.getUser('a');const runtime=createBetaEnrollment({db,keys,environment:{BETA_MAX_USERS:'7',REGISTRATION_MODE:'invite',OWNER_USER_IDS:'a'}});
 const handle=await runtime.invite(user,1);let code;
 await runtime.wrapSender(async({reply})=>{code=reply.text.match(/start=([\w-]+)/)[1];return {sent:true};},{botUsername:'synthetic_bot'})({userId:'a',reply:{text:'invite',betaInviteHandle:handle,betaLocale:'en'}});
 const card=await runtime.register({message:incoming('/start '+code),chatId:'123'});assert.match(card.text,/Welcome/);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM users')).rows[0].n,3);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM oauth_states')).rows[0].n,0);
});

test('80% Owner and 100% user notices are each once per Taipei month; no quiet-time send',async()=>{
 const f=fixture(),recipient={...owner,id:'member',displayName:'Member'};f.users.set('member',recipient);
 let spend=1.58,paused=false,quiet=false,sent=[];
 f.db.getAiUsage=async()=>[{estimated_cost_usd:spend,request_status:'OK'}];
 f.db.raw.execute=async()=>({rows:[{notifications_paused:paused?1:0,quiet_start:quiet?'00:00':'22:00',quiet_end:quiet?'23:59':'08:00'}]});
 f.db.assertAccountActive=async(id,life)=>{assert.equal(f.users.get(id).status,'ACTIVE');assert.equal(life,1);};f.db.getActiveChatIdForUser=async id=>id;
 const run=()=>notifyAiBudget({db:f.db,keys,user:recipient,env:{},environment:f.env,now:()=>new Date('2026-11-06T12:00:00Z'),send:async(text,{authorize})=>{assert.equal(await authorize(),true);sent.push(text);return {messageId:sent.length};}});
 assert.equal((await run()).status,'NOT_DUE');spend=1.6;quiet=true;await run();assert.equal(sent.length,0);quiet=false;
 await run();await run();assert.equal(sent.length,1);assert.match(sent[0],/80%/);
 spend=2;paused=true;await run();assert.equal(sent.length,1);paused=false;await run();await run();assert.equal(sent.length,2);assert.match(sent[1],/monthly AI allowance/);
});
test('new invite chat emergency wins over registration and makes zero writes',async t=>{
 const previous=process.env.REGISTRATION_MODE;process.env.REGISTRATION_MODE='invite';t.after(()=>{if(previous===undefined)delete process.env.REGISTRATION_MODE;else process.env.REGISTRATION_MODE=previous;});
 let sent=0;const p=createUpdateProcessor({db:{getTelegramLink:async()=>null},resolveUser:async()=>null,enrollment:{register:()=>assert.fail('registration')},sendReply:async({reply})=>{assert.match(reply.text,/immediate attention/);sent++;return {sent:true};}});
 assert.equal((await p.processUpdate({update_id:1,message:incoming('I have chest pain')})).outcome,'processed');assert.equal(sent,1);
});
test('disclaimer callback reaches shared processor before Journal and health handlers',async()=>{
 const f=fixture(),code=await f.code(),card=await f.runtime.register({message:incoming('/start '+code),chatId:'123'}),user=f.users.get('new-1');
 let sent=0;const p=createUpdateProcessor({db:f.db,enrollment:f.runtime,resolveUser:async()=>({user}),handleMessage:()=>assert.fail('health handler'),stage7Inbound:()=>assert.fail('journal'),stage7Reply:()=>assert.fail('journal'),sendReply:async({reply})=>{assert.match(reply.text,/Agreement recorded/);sent++;return {sent:true,messageId:2};}});
 await p.processUpdate({update_id:2,callback_query:{id:'synthetic',from:{id:123},data:card.replyMarkup.inline_keyboard[0][0].callback_data,message:{chat:{id:123,type:'private'},message_id:1}}});
 assert.equal(sent,1);assert.equal(await f.runtime.consented(user.id),true);
});

test('optional cost notice failure is isolated and does not reopen uncertain delivery',async t=>{
 const f=fixture();f.db.getAiUsage=async()=>[{estimated_cost_usd:2,request_status:'OK'}];f.db.raw.execute=async()=>({rows:[{notifications_paused:0}]});f.db.assertAccountActive=async()=>{};f.db.getActiveChatIdForUser=async()=>1;
 let sent=0;t.mock.method(console,'log',()=>{});const args={db:f.db,keys,user:owner,env:{},environment:f.env,now:()=>new Date('2026-11-06T12:00Z'),send:async()=>{sent++;throw Object.assign(Error('sensitive provider text'),{code:'SYNTHETIC_SEND_FAILURE'});}};
 assert.equal((await notifyAiBudget(args)).status,'SKIPPED');assert.equal(sent,1);
 await notifyAiBudget(args);assert.equal(sent,2); // separate 100% notice, not a replay of the 80% notice
 await notifyAiBudget(args);assert.equal(sent,2);
});
import {morningCoachFooter} from '../src/morningCoachFooter.js';
test('monthly limit omits only the footer before model/context work',async t=>{
 const old=process.env.AI_MONTHLY_CAP_USD;process.env.AI_MONTHLY_CAP_USD='2';t.after(()=>{if(old===undefined)delete process.env.AI_MONTHLY_CAP_USD;else process.env.AI_MONTHLY_CAP_USD=old;});const logs=[];t.mock.method(console,'log',x=>logs.push(JSON.parse(x)));
 const original='unchanged morning report';const footer=await morningCoachFooter({text:original,db:{getAiUsage:async()=>[{estimated_cost_usd:2,request_status:'OK'}]},userId:'a',keys,coach:{footerText:()=>assert.fail('model')},locale:'en'});
 assert.equal(original+footer,original);assert.equal(logs[0].reason,'AI_MONTHLY_CAP_REACHED');assert.equal(logs[0].llm_duration_ms,0);
});
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
test('configuration proof fences E1 registration/owner/cap changes',()=>{
 const env={BETA_MAX_USERS:'7',REGISTRATION_MODE:'closed',AI_MONTHLY_CAP_USD:'2',OWNER_USER_IDS:'owner'},sha='a'.repeat(40),config=publicBetaConfiguration({});
 const proof=configurationProof(keys,config,env,sha);
 for(const patch of [{REGISTRATION_MODE:'invite'},{OWNER_USER_IDS:'another'},{AI_MONTHLY_CAP_USD:'3'},{BETA_MAX_USERS:'6'}])assert.notEqual(configurationProof(keys,config,{...env,...patch},sha),proof);
});
