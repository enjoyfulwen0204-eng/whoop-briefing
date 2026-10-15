import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createClient} from '@libsql/client';import {exactRealStatement} from '../src/exactRealStatement.js';
const quote=x=>'"'+x.replaceAll('"','""')+'"';
test('original evidence snapshot ROW guard rejects raw Hrana but accepts exact binding and rejects changed authority',async()=>{
 const h=createClient({url:'http://sqld:8080'}),n=createClient({url:'file::memory:'});let tx;
 try{
  const infos=(await h.execute('PRAGMA table_info(evidence_items)')).rows,cols=infos.map(r=>r.name),rows=(await h.execute("SELECT * FROM evidence_items WHERE user_id='a' AND execution_mode='SHADOW' ORDER BY evidence_item_id")).rows;assert.equal(rows.length,17);
  const sql=`SELECT json(CASE WHEN (EXISTS(SELECT 1 FROM "evidence_items" WHERE (user_id=? AND "execution_mode"='SHADOW') AND ${cols.map(c=>quote(c)+' IS ?').join(' AND ')})) THEN 'true' ELSE 'SHORT_TRANSACTION_CONDITION_REJECTED' END) verified`;
  assert.equal(createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex'),'9b33bf89b4604da9fd0b4abbc5815d51148c175a723b8e5ed497bf214d7ce667');
  await n.execute('CREATE TABLE evidence_items ('+infos.map(c=>quote(c.name)+' '+c.type).join(',')+')');
  await n.batch(rows.map(r=>({sql:`INSERT INTO evidence_items(${cols.map(quote).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`,args:cols.map(k=>r[k])})));
  let rawRejected=0;for(const row of rows){const stmt={sql,args:['a',...cols.map(k=>row[k])]};try{await h.execute(stmt);}catch(e){assert.equal(e.code,'SQLITE_UNKNOWN');rawRejected++;}assert.equal((await h.execute(exactRealStatement(stmt))).rows[0].verified,'true');assert.equal((await n.execute(exactRealStatement(stmt))).rows[0].verified,'true');}
  assert.equal(rawRejected,4);
  const original=rows.find(r=>r.recency_weight!==null&&!Number.isInteger(r.recency_weight));assert.ok(original);const before={sql,args:['a',...cols.map(k=>original[k])]},cross={sql,args:['peer',...cols.map(k=>original[k])]};await assert.rejects(h.execute(exactRealStatement(cross)));
  const bytes=Buffer.alloc(8);bytes.writeDoubleBE(original.recency_weight);bytes.writeBigUInt64BE(bytes.readBigUInt64BE()+1n);const changed=bytes.readDoubleBE();
  const changedSnapshot={sql,args:['a',...cols.map(k=>k==='recency_weight'?changed:original[k])]};await assert.rejects(h.execute(exactRealStatement(changedSnapshot)));
  tx=await h.transaction('write');await assert.rejects(tx.execute(exactRealStatement({sql:'UPDATE evidence_items SET recency_weight=? WHERE user_id=? AND evidence_item_id=?',args:[changed,'a',original.evidence_item_id]})),/phase4_content_append_only/);await tx.rollback();tx=null;
  assert.equal((await h.execute(exactRealStatement(before))).rows[0].verified,'true');
  console.log('EXACT_EVIDENCE_GUARD '+JSON.stringify({originalBatchStep:34,rows:rows.length,columns:cols.length,rawRejected,exactAccepted:rows.length,nativeAccepted:rows.length,changedSnapshotValueRejected:true,immutableAuthoritativeMutationRejected:true,crossTenantRejected:true,mutationRolledBack:true,durableApplicationWrites:0}));
 }finally{tx?.close();h.close();n.close();}
});
