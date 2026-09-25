/** Synthetic policy selection and provider outcome only; no actual worker or IO. */
export async function journalQuestion(f,{mode='SHADOW',coverage=false,key='question',outcome='AMBIGUOUS'}={}) {
  const {db,stores,core}=f;
  if(mode==='LIVE') {
    await db.linkTelegram({userId:'a',chatId:'123',now:core.now()});
    await db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-09-20T00:00:00.000Z'),scope:'offline',whoopUserId:'synthetic'});
    await db.raw.execute(`INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at)
      VALUES ('a','READY','2026-09-19T00:00:00.000Z','2026-09-19T00:00:00.000Z','2026-09-19T00:00:00.000Z')`);
    await stores.initializeTenant('a','LIVE');
  }
  const context=await stores.capture('a',{executionMode:mode}),source=await stores.root(context,'USER','a');
  const run=await stores.evidence.start(context,{deterministic_run_key:key,method:'SYNTHETIC',algorithm_version:'fixture',registry_version:'fixture',
    evidence_contract_version:'fixture',promotion_confound_version:'fixture',exposure_classification_version:'fixture',factor_set_version:'fixture',started_at:core.timestamp()},[source.ref]);
  await stores.evidence.complete(context,run.row.run_id,{});
  const item=await stores.evidence.addItem(context,{run_id:run.row.run_id,item_key:key,exposure_classification_version:'fixture',factor_set_version:'fixture'});
  const episode=await stores.episodes.open(context,{identity:{algorithmMajor:'fixture',direction:'DOWN',domain:'sleep',metric:'synthetic',subject:'synthetic',windowFamily:key},
    data:{episode_type:'SYNTHETIC',severity:1,expires_at:'2026-09-26T00:00:00.000Z'},evidenceItemId:item.row.evidence_item_id,
    semanticAt:core.timestamp()});
  const question={episode_id:episode.row.episode_id,episode_revision:1,factor_question_kind:coverage?'COVERAGE:alcohol,caffeine':'caffeine',
    target_window_start_utc:'2026-09-18T00:00:00.000Z',target_window_end_utc:'2026-09-19T00:00:00.000Z',
    question_template_version:coverage?'journal-coverage-v1':'journal-factor-v1',policy_version:'fixture',question_utility_version:'fixture',
    counterfactual_evaluator_version:'fixture',utility_score:0.9,eligibility_threshold:0.5};
  const decision={deterministic_decision_key:`decision-${key}`,policy_version:'fixture',metric_registry_version:'fixture',evidence_version:'fixture',
    template_version:'fixture',expires_at:'2026-09-20T00:00:00.000Z'};
  if(mode==='LIVE') {
    await stores.transport.mode(context,'CONTEXT_QUESTION');
    await db.raw.execute("UPDATE tenant_delivery_modes SET mode='PHASE4',revision=revision+1,reason_code='CUTOVER_COMMITTED',cutover_boundary='2026-09-19T00:00:00.000Z',timezone='Asia/Taipei' WHERE user_id='a' AND execution_mode='LIVE'");
    await db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
    await db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a' AND execution_mode='LIVE'");
  }
  const selected=await stores.slots.acquire(context,{question,decision,sourceRefs:[item.ref],...(mode==='LIVE'?{message:{payload_text:'Synthetic context question.',expires_at:'2026-09-20T00:00:00.000Z'}}:{})});
  const control=await stores.captureControl('a');
  let slot;
  if(mode==='SHADOW') {
    slot=await stores.slots.beginSimulation(context,{questionRequestId:selected.questionRequestId,expectedRevision:selected.slot.revision});
    slot=await stores.slots.classifySimulation(control,mode,{questionRequestId:selected.questionRequestId,expectedRevision:slot.revision,outcome});
  } else {
    await stores.transport.makeEligible(context,{messageId:selected.messageId,expectedRevision:0});
    const lease=await stores.transport.claim(context,{messageId:selected.messageId,owner:'synthetic'});
    const attempt=await stores.transport.start(context,lease,{slotRevision:selected.slot.revision});
    await stores.transport.settle(control,mode,{attemptId:attempt.attemptId,outcome,...(outcome==='DELIVERED'?{providerMessageId:'synthetic'}:{ambiguityReason:'TIMEOUT'})});
    slot=await stores.slots.read(control,mode);
  }
  return {context,control,slot,question,selected};
}
export async function inboundAnswer(f,control,id=9101) {
  await f.db.claimTelegramUpdate(id,{owner:'answer-owner',conversationKey:'tg:123',now:f.core.now()});
  await f.db.markTelegramUpdateProcessing(id,{owner:'answer-owner',now:f.core.now()});
  await f.db.acquireLock('telegram_lane:tg:123',{owner:'answer-owner',ttlMs:120000,now:f.core.now()});
  return f.stores.journalInbound.capture(control,{updateId:id,owner:'answer-owner'});
}
