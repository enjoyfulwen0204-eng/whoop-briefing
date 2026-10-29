// Preloaded only by the bounded synthetic Round4 command.
import {Socket} from 'node:net';
globalThis.fetch=async()=>{throw Error('ROUND4_REAL_NETWORK_FORBIDDEN');};
Socket.prototype.connect=function(){throw Error('ROUND4_REAL_NETWORK_FORBIDDEN');};
process.loadEnvFile=()=>{throw Error('ROUND4_ENV_FILE_FORBIDDEN');};
