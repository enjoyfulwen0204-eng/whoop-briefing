import {SCHEMA_VERSION} from './schema.js';
/** Metadata-only version guard for read/admin CLIs. Full privileged admission
 * remains separate. Legacy inspection is opt-in and must stay read-only. */
export async function requireRuntimeSchema(client,{legacyReadOnly=false}={}){
 if(Number(process.versions.node.split('.')[0])<22)throw Error('NODE_22_REQUIRED');
 const v=Number((await client.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0]?.v??0);
 if(v===SCHEMA_VERSION)return v;
 if(v<SCHEMA_VERSION&&legacyReadOnly)return v;
 const code=v<SCHEMA_VERSION?'CONTROLLED_MIGRATION_REQUIRED':'UNSUPPORTED_FUTURE_SCHEMA';
 throw Object.assign(Error(code),{code});
}
