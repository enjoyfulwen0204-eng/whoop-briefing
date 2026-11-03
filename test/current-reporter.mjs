// Compact console reporter. No evidence files or snapshots are written.
export default async function* report(source){
 for await(const event of source){
  if(event.type==='test:fail'){
   const d=event.data,e=d.details?.error,c=e?.cause??e;
   yield `FAIL ${d.file??''}:${d.line??''} ${d.name}\n${String(c?.code??'')} ${String(c?.message??'').slice(0,1800)}\n`;
  }
  if(event.type==='test:summary')yield `SUMMARY ${JSON.stringify(event.data)}\n`;
  if(event.type==='test:diagnostic'&&/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(event.data.message))yield event.data.message+'\n';
 }
}
