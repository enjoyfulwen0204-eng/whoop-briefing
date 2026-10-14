// External synthetic database provider, deliberately outside the app cgroup.
import {createServer} from 'node:http';import {createOwnedDb} from './stage5OwnedDb.js';import {hranaTransport} from './hranaTransport.js';
const url='file:/fixtures/checkpoint.sqlite',seed=createOwnedDb({url});
const users=(await seed.raw.execute('SELECT id,display_name FROM users')).rows;
if(users.length!==1||users[0].id!=='a'||users[0].display_name!=='Synthetic')throw Error('SYNTHETIC_FIXTURE_ONLY');await seed.close();
const transport=hranaTransport(url,{transactionMaxMs:5000});
const server=createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/counts'){res.setHeader('content-type','application/json');res.end(JSON.stringify({counts:transport.counts,evidence:transport.evidence}));return;}
 if(req.method!=='POST'||req.url!=='/v2/pipeline'){res.writeHead(404).end();return;}
 const chunks=[];for await(const part of req)chunks.push(part);await new Promise(r=>setTimeout(r,115));
 const response=await transport.fetch(new Request('https://isolated.invalid/v2/pipeline',{method:'POST',body:Buffer.concat(chunks)}));
 res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
 }catch(e){res.writeHead(500).end(JSON.stringify({error:e.code??e.message}));}});
server.listen(8080,'0.0.0.0');console.log('SYNTHETIC_HRANA_READY');
process.on('SIGTERM',()=>server.close(()=>{transport.close();process.exit(0);}));
