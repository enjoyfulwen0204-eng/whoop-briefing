from pathlib import Path
import subprocess,json,time
p=Path(__file__).parent;c=p/'checkout';out=[]
for name in ('stage8BodyEnergyProjection.js','stage8DerivedReader.js','stage8Runtime.js'):
 cmd=['/Users/kelvin/.local/node/bin/node','--input-type=module','-e',"await import("+json.dumps((c/'src'/name).as_uri())+"); process.stdout.write('DIRECT_IMPORT_OK\\n');"]
 at=time.monotonic();r=subprocess.run(cmd,cwd=c,text=True,capture_output=True,timeout=5);out.append({'module':name,'returncode':r.returncode,'durationSeconds':time.monotonic()-at,'stdout':r.stdout,'stderr':r.stderr})
(p/'direct-module-init.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
