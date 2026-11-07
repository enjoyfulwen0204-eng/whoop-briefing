import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
export function denyRehearsalNetwork(){
 const deny=()=>{throw Object.assign(Error('REHEARSAL_NETWORK_DENIED'),{code:'REHEARSAL_NETWORK_DENIED'});};
 globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny();}};
 for(const mod of [http,https]){mod.request=deny;mod.get=deny;}
 net.connect=net.createConnection=tls.connect=dgram.createSocket=deny;net.Socket.prototype.connect=deny;
 for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[key]=deny;
 syncBuiltinESMExports();
}
