import{writeFile}from'node:fs/promises';await import('./checkout/test/phase4Fixture.js');const {createResultAuthority}=await import('./checkout/src/phase4ResultAuthority.js');
const observations=[];
for(const mode of ['SHADOW','LIVE']){
 const queries=[],core={liveAllocation:mode==='LIVE',keys:{},client:{execute:async s=>{queries.push(s);return{rows:[]};}},run:async(_context,work)=>work()};
 const context={userId:'synthetic-routing-user',executionMode:mode};let error;
 try{await createResultAuthority(core).read(context,'synthetic-routing-item','METRIC');}catch(e){error=e.code??e.message;}
 observations.push({mode,query:queries[0],error,expectedTable:mode==='LIVE'?'stage8_live_evidence_result_authorities':'phase4_evidence_result_authorities',correctTable:queries[0]?.sql.includes('FROM '+(mode==='LIVE'?'stage8_live_evidence_result_authorities':'phase4_evidence_result_authorities')+' ')});
}
const out={qualification:'SQL_SELECTION_ONLY_NOT_ROW_AUTHENTICATION_OR_FULL_PRODUCER',sourceCommit:process.argv[2],observations};console.log(JSON.stringify(out));if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(out,null,2)+'\n');
