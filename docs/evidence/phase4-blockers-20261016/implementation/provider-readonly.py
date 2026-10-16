import importlib.util,json,re,datetime,urllib.request,urllib.error,concurrent.futures
from pathlib import Path
ROOT=Path('/Users/kelvin/Desktop/whoop-briefing');OUT=Path('/private/tmp/phase4-blockers-20261016')
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
p=load('existing_preflight',ROOT/'tmp/overnight-pre-stage7-20261011/provider-preflight.py')
c=load('bounded_cf_metadata',ROOT/'tmp/last3-gaps-20261012/cf-http2-json.py')
def env_value(x):return p.env_value(x)
out={'observedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionMutations':0,'credentialChanges':0,'tokenMetadataInspected':False}
cf=Path('/Users/kelvin/Library/Preferences/.wrangler/config/default.toml')
try:
 match=re.search(r'^oauth_token\s*=\s*"([^"]*)"',cf.read_text(),re.M)
 if not match:raise RuntimeError('EXISTING_CLOUDFLARE_AUTH_UNAVAILABLE')
 base='https://api.cloudflare.com/client/v4/accounts/17558c0263c5c4076055ee0f860907dc/workers/scripts/whoop-briefing-scheduler'
 code,raw,_=c.metadata_get(base+'/settings',match.group(1));out['cloudflare']={'settingsHttpStatus':code}
 if code==200:
  settings=json.loads(raw)['result'];bindings=settings.get('bindings',[])
  out['cloudflare']['bindingNames']=[b.get('name') for b in bindings]
  public={'BRIEFING_RELEASE_SHA','BRIEFING_CONFIG_PROOF','BRIEFING_EXECUTION_MODE','BRIEFING_CONTINUATION_DISCOVERY','BRIEFING_CONTINUATION_SCOPE','BRIEFING_ENDPOINT_URL'}
  out['cloudflare']['configuration']={b['name']:b.get('text') for b in bindings if b.get('name') in public and b.get('type')=='plain_text'}
  for name in ['schedules','deployments']:
   status,body,_=c.metadata_get(base+'/'+name,match.group(1));out['cloudflare'][name+'HttpStatus']=status
   if status==200:
    result=json.loads(body)['result']
    out['cloudflare'][name]=result if name=='schedules' else [{'id':x.get('id'),'versions':x.get('versions'),'created_on':x.get('created_on')} for x in result.get('deployments',[])]
except Exception as e:out['cloudflare']={'status':'BLOCKED','error':type(e).__name__}
try:
 key=p.render_admin_key();base='https://api.render.com/v1/services/srv-dahs71qd0e5s738n94c0'
 status,s=p.get(base,key);dstatus,deps=p.get(base+'/deploys?limit=20',key)
 out['render']={'serviceHttpStatus':status,'deployHttpStatus':dstatus}
 if status==200:
  details=s.get('serviceDetails',{});out['render'].update({'serviceId':s.get('id'),'repo':s.get('repo'),'branch':s.get('branch'),'autoDeploy':s.get('autoDeploy'),'suspended':s.get('suspended'),'plan':details.get('plan'),'instanceType':details.get('instanceType'),'numInstances':details.get('numInstances'),'runtime':details.get('runtime'),'maintenance':details.get('maintenanceMode',{}).get('enabled'),'startCommand':details.get('envSpecificDetails',{}).get('startCommand')})
 if dstatus==200:
  terminal={'live','deactivated','build_failed','update_failed','canceled','pre_deploy_failed'}
  ds=[x.get('deploy',x) for x in deps];out['render']['liveDeploys']=[{'id':d.get('id'),'status':d.get('status'),'sha':d.get('commit',{}).get('id'),'finishedAt':d.get('finishedAt')} for d in ds if d.get('status')=='live'];out['render']['inProgressDeploys']=[{'id':d.get('id'),'status':d.get('status')} for d in ds if d.get('status') not in terminal]
 flags=['NODE_VERSION','PHASE4_RELEASE_SHA','PHASE4_EXECUTION_PROFILE','PHASE4_BETA_SHADOW_RUNTIME','PHASE4_PUBLIC_BETA_MODE','PHASE4_BETA_PILOT_STOP','BRIEFING_CONTINUATION_SCOPE','STAGE7_COMPANION','PHASE4_STAGE8_RUNTIME','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_STAGE8_OWNER_MONITORING','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS']
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  values=list(pool.map(lambda name:p.get(base+'/env-vars/'+name,key),flags))
 out['applicationFlags']={name:{'httpStatus':code,'value':env_value(v)} for name,(code,v) in zip(flags,values)}
 secret_names=['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TELEGRAM_BOT_TOKEN']
 secrets={name:env_value(p.get(base+'/env-vars/'+name,key)[1]) for name in secret_names}
 url=secrets['TURSO_DATABASE_URL'];token=secrets['TURSO_AUTH_TOKEN'];host=(url or '').replace('libsql://','https://').split('/')[2] if url else None
 if host=='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io' and token:
  sql='SELECT MAX(version) AS version FROM schema_version'
  req=urllib.request.Request('https://'+host+'/v2/pipeline',data=json.dumps({'requests':[{'type':'execute','stmt':{'sql':sql,'want_rows':True}},{'type':'close'}]}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
  with urllib.request.urlopen(req,timeout=20) as r:
   raw=json.load(r);result=raw['results'][0];out['databaseSchema']={'httpStatus':r.status,'type':result.get('type'),'rows':result.get('response',{}).get('result',{}).get('rows',[]),'readOnlySql':sql}
 if secrets['TELEGRAM_BOT_TOKEN']:
  with urllib.request.urlopen('https://api.telegram.org/bot'+secrets['TELEGRAM_BOT_TOKEN']+'/getWebhookInfo',timeout=20) as r:
   raw=json.load(r);v=raw.get('result',{});out['telegram']={'ok':raw.get('ok'),'url':v.get('url'),'pendingUpdateCount':v.get('pending_update_count'),'maxConnections':v.get('max_connections'),'allowedUpdates':v.get('allowed_updates'),'lastErrorDate':v.get('last_error_date')}
except Exception as e:out['renderReadbackError']={'type':type(e).__name__,'detailsSuppressed':True}
(OUT/'provider-readback.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
