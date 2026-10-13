import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7Development} from '../src/stage7Development.js';
export async function stage7Fixture(t,{now=()=>new Date('2026-09-19T00:00:00.000Z')}={}){
 const f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:now()});await f.db.linkTelegram({userId:'b',chatId:'456',now:now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01T00:00:00.000Z'),scope:'offline',whoopUserId:'synthetic'},{now:now()});
 const user=await f.db.getUser('a'),companion=await createStage7Development({...f});
 const command=()=>companion.handle({text:'/journal',chatId:'123',user});
 let sequence=0;
 async function tap(reply,label){
  const button=reply.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));if(!button)throw Error('SYNTHETIC_BUTTON_NOT_FOUND:'+label);
  const messageId=reply.editMessageId??42;
  if(reply.stage7InteractionId)await companion.interactions.bind(await companion.interactions.authenticate({user,chatId:'123'}),reply.stage7InteractionId,messageId);
  const callback={id:String(++sequence),data:button.callback_data,from:{id:123},message:{message_id:Number(messageId),chat:{id:123,type:'private'}}};
  return companion.handle({callback,chatId:'123',user});
 }
 return {...f,user,companion,command,tap};
}
