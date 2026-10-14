import test from 'node:test';import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';
import {ownRamScopes,shareRamScopes,registerRamScopes,closeRamScopes,ramScopeCounters} from './stage6RamScopeLifetime.mjs';
test('terminal owned RAM scope cleanup preserves other receiver/global authority and alias isolation',async()=>{
 const a={closed:false},b={closed:false},alias={},s=new AsyncLocalStorage(),peer=new AsyncLocalStorage(),outer=new AsyncLocalStorage();ownRamScopes(a);ownRamScopes(b);shareRamScopes(a,alias);registerRamScopes(alias,s);registerRamScopes(b,peer);s.run({private:'synthetic'},()=>{});peer.run('peer',()=>{});
 await outer.run('request/budget preserved',async()=>{assert.throws(()=>closeRamScopes(a),/RAM_SCOPE_CONNECTION_NOT_CLOSED/);assert.equal(s.enabled,true);a.closed=true;closeRamScopes(a);assert.equal(s.enabled,false);assert.equal(peer.enabled,true);assert.equal(outer.getStore(),'request/budget preserved');assert.throws(()=>registerRamScopes(alias,new AsyncLocalStorage()),/RAM_SCOPE_OWNER_CLOSED/);closeRamScopes(a);});
 b.closed=true;closeRamScopes(b);outer.disable();assert.equal(ramScopeCounters().liveOwners,0);
});
test('unregistered clients cannot dispose an unrelated activated scope',()=>{const client={closed:true},scope=new AsyncLocalStorage();scope.run(7,()=>{});registerRamScopes(client,scope);closeRamScopes(client);assert.equal(scope.enabled,true);scope.disable();});
