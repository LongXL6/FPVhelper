"""Bounded build preparation; preserves every prior attempt and exact generated-file states."""
import hashlib,importlib.util,json,os,signal,subprocess,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('common',Path(__file__).with_name('phase1b-r1-common.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
out=Path.cwd()/'output/playwright/phase1b-r1/preflight/build-attempt-02';out.mkdir(exist_ok=False)
rows={};steps=[]
def save(): (out/'receipt.json').write_text(json.dumps({'steps':steps,'arms':rows},indent=2)+'\n')
def build(root,arm,mode,label):
 env=os.environ.copy();env.update(FPV_MEASUREMENT_BUILD='1' if mode=='P1' else '0',NEXT_PUBLIC_ANALYTICS_ENABLED='false',NEXT_TELEMETRY_DISABLED='1')
 command=['node','node_modules/next/dist/bin/next','build']+(['--profile'] if mode=='P1' else [])
 log=out/f'{label}.log';row=dict(arm=arm,mode=mode,label=label,command=command,env={k:env[k] for k in ['FPV_MEASUREMENT_BUILD','NEXT_PUBLIC_ANALYTICS_ENABLED','NEXT_TELEMETRY_DISABLED']},status='running',beforeNextEnvSha256=c.digest((root/'next-env.d.ts').read_bytes()),startedEpochMs=int(time.time()*1000));steps.append(row);save();start=time.monotonic()
 try:
  with log.open('x') as f: proc=subprocess.Popen(command,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=proc.wait(timeout=120)
  except subprocess.TimeoutExpired:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=15)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
   raise RuntimeError('Build deadline; own process cleaned')
  row['exitCode']=code
  if code:raise RuntimeError('Build failed '+str(log))
  row['afterNextEnvSha256']=c.digest((root/'next-env.d.ts').read_bytes());row['generatedDifferences']=c.verify_source(root,allow_generated=mode=='P1')
  diff=subprocess.check_output(['git','-C',str(root),'diff','--binary']);(out/f'{label}.patch').write_bytes(diff)
  if mode=='N':assert not c.git(root,'status','--porcelain')
  dist=root/('.next' if mode=='N' else '.next-measurement');inventory=[{'path':str(p.relative_to(dist)),'bytes':p.stat().st_size,'sha256':c.digest(p.read_bytes())} for p in sorted(dist.rglob('*')) if p.is_file()]
  inv=out/f'{label}-inventory.json';inv.write_text(json.dumps(inventory,indent=2)+'\n')
  row.update(status='completed',buildId=(dist/'BUILD_ID').read_text().strip(),inventory=str(inv),inventorySha256=c.digest(inv.read_bytes()),directory=str(dist),log=str(log));return row
 except BaseException as e:row.update(status='failed',error=str(e));raise
 finally:row['seconds']=time.monotonic()-start;save()
# Already-observed generated state only; ordinary build restores it via Next itself.
root=Path('/Users/longxl/.codex/worktrees/fpvhelper-phase1b-r1-a');assert c.verify_source(root,True)==['next-env.d.ts'];build(root,'A','N','A-N-recovery');c.verify_source(root)
for arm in 'AB':
 root=Path('/Users/longxl/.codex/worktrees/fpvhelper-phase1b-r1-'+arm.lower());c.verify_source(root)
 rows[arm]={'root':str(root),'sourceSha':c.git(root,'rev-parse','HEAD'),'treeSha':c.git(root,'rev-parse','HEAD^{tree}'),'lockSha256':c.digest((root/'package-lock.json').read_bytes()),'modes':{}}
 for mode in ['P1','N']:
  rows[arm]['modes'][mode]=build(root,arm,mode,f'{arm}-{mode}');save();print(arm,mode,rows[arm]['modes'][mode]['buildId'],flush=True)
 c.verify_source(root);rows[arm]['sourceCleanAfterBuilds']=True;save()
(Path.cwd()/'output/playwright/phase1b-r1/preflight/builds.json').write_text(json.dumps(rows,indent=2)+'\n')
