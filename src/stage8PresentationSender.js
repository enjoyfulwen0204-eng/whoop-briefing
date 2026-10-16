/** Keep this boundary installed while Stage8 is off. A durable saved reply
 * cannot lose its scoped authority check merely because configuration changed. */
export function createStage8PresentationSender(runtime,send){
 if(typeof send!=='function')throw Error('STAGE8_PRESENTATION_SENDER_REQUIRED');
 return input=>{
  if(input.reply?.stage8ReplyGuard&&!runtime)return {sent:false,messageId:null,reason:'stage8_presentation_disabled'};
  return runtime?runtime.sendReply(send,input):send(input);
 };
}
