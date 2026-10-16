/** Persisted cards and Coach projections retain their send authority even
 * when the Stage7 runtime is disabled during same-schema recovery. */
export function createStage7PresentationSender(runtime,send){
 if(typeof send!=='function')throw Error('STAGE7_PRESENTATION_SENDER_REQUIRED');
 return input=>{
  const reply=input.reply,guarded=reply?.stage7ReplyGuard||reply?.stage7InteractionId||reply?.stage7View||reply?.stage7CoachContextGuard;
  if(guarded&&!runtime)return {sent:false,messageId:null,reason:'stage7_presentation_disabled'};
  return runtime?runtime.sendReply(send,input):send(input);
 };
}
