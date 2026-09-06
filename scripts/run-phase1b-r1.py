"""Serial bounded orchestrator. Never builds, resets or patches products."""
import argparse,gzip,importlib.util,json,os,signal,socket,subprocess,time,urllib.request
from pathlib import Path
spec=importlib.util.spec_from_file_location('common',Path(__file__).with_name('phase1b-r1-common.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--exploratory',action='store_true');parser.add_argument('--exploration-id',default='exploration-02');opts=parser.parse_args()
planpath=root/'benchmarks/capture/phase1b-r1-plan.json';p=json.loads(planpath.read_text());c.validate_plan(p)
if not opts.exploratory: assert p['status']=='frozen' and not c.git(root,'status','--porcelain')
buildpath=root/'output/playwright/phase1b-r1/preflight/builds.json';builds=json.loads(buildpath.read_text())
child=root/'benchmarks/capture/phase1b-r1-child.json';planhash=c.digest(planpath.read_bytes());childhash=c.digest(child.read_bytes());driver=c.git(root,'rev-parse','HEAD')
out=root/'output/playwright/phase1b-r1'/(opts.exploration_id if opts.exploratory else p['run_id']);out.mkdir(exist_ok=False)
receipt={'status':'running','driverTestedSha':driver,'driverTree':c.git(root,'rev-parse','HEAD^{tree}'),'planSha256':planhash,'childPlanSha256':childhash,'buildReceiptSha256':c.digest(buildpath.read_bytes()),'driverDiffSha256':c.digest(subprocess.check_output(['git','diff','HEAD'],cwd=root)),'driverFiles':{str(f.relative_to(root)):c.digest(f.read_bytes()) for f in sorted((root/'scripts').glob('*phase1b*r1*')) if f.is_file()},'products':builds,'startedEpochMs':int(time.time()*1000),'runs':[],'diagnosticTriggers':[],'externalOperations':[]}
started=time.monotonic();server=None;runner=None
def deadline_signal(signum,frame): raise TimeoutError('Global deadline interrupted synchronous work')
signal.signal(signal.SIGALRM,deadline_signal)
signal.setitimer(signal.ITIMER_REAL,c.remaining_seconds(started,p['maxBatchMs'],p['cleanupMs']))
source_before={}

def save(): (out/'orchestrator.json').write_text(json.dumps(receipt,indent=2)+'\n')
def budget():
 c.remaining_seconds(started,p['maxBatchMs'])
 rows=[]
 for r in p['budgetRoots']:
  q=Path(r); files=list(q.rglob('*')) if q.exists() else []
  assert not any(x.is_symlink() for x in files),'Evidence symlink'
  rows.append({'root':r,'bytes':sum(x.stat().st_size for x in files if x.is_file())})
 free=os.statvfs(root).f_bavail*os.statvfs(root).f_frsize;total=sum(r['bytes'] for r in rows)
 if free<p['minDiskFreeBytes'] or total>p['maxOutputBytes']:raise RuntimeError('Resource guard')
 return dict(roots=rows,totalBytes=total,freeBytes=free)
def verify():
 c.remaining_seconds(started,p['maxBatchMs'],p['cleanupMs'])
 if c.digest(planpath.read_bytes())!=planhash or c.digest(child.read_bytes())!=childhash or c.git(root,'rev-parse','HEAD')!=driver:raise RuntimeError('Driver/plan changed')
 for f,h in receipt['driverFiles'].items():
  if c.digest((root/f).read_bytes())!=h:raise RuntimeError('Driver tool bytes changed')
 if not opts.exploratory and c.git(root,'status','--porcelain'):raise RuntimeError('Driver no longer clean')
 for a,r in p['roots'].items():
  b=builds[a]
  if c.git(r,'rev-parse','HEAD')!=b['sourceSha'] or c.git(r,'rev-parse','HEAD^{tree}')!=b['treeSha'] or c.git(r,'status','--porcelain'):raise RuntimeError('Product source changed')
  if c.source_inventory(r)!=source_before[a]:raise RuntimeError('Product byte mismatch')
  for mode,m in b['modes'].items():
   d=Path(m['directory'])
   for f in json.loads(Path(m['inventory']).read_text()):
    path=d/f['path']
    if not path.is_file() or c.digest(path.read_bytes())!=f['sha256']:raise RuntimeError('Build content mismatch: '+str(path))
stop=c.stop_owned
def metrics(raw):
 w=raw['windows'][0];m=w['cdp']
 return {k:c.interval(m[x]['metrics'],m[y]['metrics']) for k,x,y in [('steady','before','steadyEnd'),('drain','steadyEnd','after'),('full','before','after')]}
def execute(pair,position,arm,diagnostic=False):
 global server,runner
 index=len(receipt['runs']);rout=out/f'{index:02}-{pair["pairId"]}-{position}-{arm}';rout.mkdir()
 run={'index':index,'pairId':pair['pairId'],'kind':'diagnostic' if diagnostic else pair['kind'],'condition':pair['condition'],'mode':pair['mode'],'order':pair['order'],'position':position,'arm':arm,'sourceSha':builds[arm]['sourceSha'],'buildId':builds[arm]['modes'][pair['mode']]['buildId'],'status':'running','startedEpochMs':int(time.time()*1000)}
 receipt['runs'].append(run);save();verify();run['budgetBefore']=budget()
 load=subprocess.check_output(['ps','-Ao','pid,comm,pcpu,pmem']);(rout/'host-load.bin').write_bytes(load)
 run['hostLoadBefore']={'text':load.decode('utf8',errors='replace'),'rawSha256':c.digest(load),'decoding':'UTF8 replacement for ps truncated multibyte names; raw bytes retained'}
 runstart=time.monotonic(); deadline=min(started+p['maxBatchMs']/1000-p['cleanupMs']/1000,runstart+p['maxRunMs']/1000)
 with socket.socket() as probe:probe.bind(('127.0.0.1',p['port']))
 env=os.environ.copy();env.update(FPV_MEASUREMENT_BUILD='1' if pair['mode']=='P1' else '0',NEXT_PUBLIC_ANALYTICS_ENABLED='false',NEXT_TELEMETRY_DISABLED='1')
 url=f'http://127.0.0.1:{p["port"]}'
 with (rout/'server.log').open('w') as f:server=subprocess.Popen(['node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(p['port'])],cwd=p['roots'][arm],env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 run['serverPid']=server.pid;run['serviceUrl']=url;save()
 ready=time.monotonic()+20
 while True:
  if time.monotonic()>min(ready,deadline) or server.poll() is not None:raise RuntimeError('Readiness failed')
  try:
   with urllib.request.urlopen(url,timeout=1) as response:
    if response.status==200:break
  except Exception:time.sleep(.2)
 idx={('S1-100','N'):0,('S1-100','P1'):1,('S2','P1'):2}[(pair['condition'],pair['mode'])]
 cmd=['node','--experimental-transform-types','--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','scripts/measure-phase1b-r1.mts','--plan',str(child),'--normal-url',url,'--profile-url',url,'--output',str(rout),'--run-index',str(idx),'--product-root',p['roots'][arm],'--build-id',run['buildId']]+(['--exploratory'] if opts.exploratory else [])+(['--trace'] if diagnostic else [])
 with (rout/'runner.log').open('w') as f:runner=subprocess.Popen(cmd,cwd=root,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 run['runnerPid']=runner.pid;run['command']=cmd;save()
 while runner.poll() is None:
  if time.monotonic()>deadline:raise RuntimeError('Run/batch deadline')
  budget();time.sleep(1)
 run['runnerExitCode']=runner.returncode;run['runnerCleanup']=stop(runner);runner=None
 run['serverCleanup']=stop(server);server=None
 if run['runnerExitCode']!=0:raise RuntimeError('Runner failed; retained logs/raw')
 artifacts=list(rout.glob('*.json.gz'));artifacts=[f for f in artifacts if not f.name.endswith(('.trace.json.gz','.cpuprofile.json.gz'))]
 assert len(artifacts)==1
 rawbytes=gzip.decompress(artifacts[0].read_bytes());raw=json.loads(rawbytes);summary=json.loads(artifacts[0].with_suffix('').with_suffix('.summary.json').read_text())
 assert raw['sourceSha']==run['sourceSha'] and raw['driverSha']==driver and raw['servedBuildId']==run['buildId'] and raw['planSha256']==childhash and raw['sourceDiffSha256']==c.digest(b'')
 assert raw['mode']==run['mode'] and raw['condition']['id']==run['condition'] and summary['valid'] and len(rawbytes)<=p['maxTraceBytes']
 run.update(status='completed',wallSeconds=time.monotonic()-runstart,rawPath=str(artifacts[0]),rawSha256=c.digest(artifacts[0].read_bytes()),decodedBytes=len(rawbytes),decodedSha256=c.digest(rawbytes),metrics=metrics(raw),summaryPath=str(artifacts[0].with_suffix('').with_suffix('.summary.json')))
 verify();run['budgetAfter']=budget();save();print(json.dumps({k:run[k] for k in ['index','pairId','arm','kind','status','wallSeconds']}),flush=True)
try:
 source_before={a:c.source_inventory(r) for a,r in p['roots'].items()}
 (out/'source-inventories.json').write_text(json.dumps(source_before,indent=2)+'\n')
 receipt['initialBudget']=budget();verify();save()
 if opts.exploratory:
  for condition,mode,trace in [('S1-100','N',False),('S1-100','P1',True),('S2','P1',False)]:
   execute(dict(pairId='explore-'+condition+'-'+mode,kind='exploratory',condition=condition,mode=mode,order='B'),1,'B',trace)
 else:
  for pair in p['pairs']:
   for pos,arm in enumerate(pair['order']):execute(pair,pos+1,arm)
 if not opts.exploratory:
  for condition in ['S1-100','S2']:
   triggers=[]
   for pair in [x for x in p['pairs'] if x['kind']=='main' and x['condition']==condition and x['mode']=='P1']:
    rows=[r for r in receipt['runs'] if r['pairId']==pair['pairId']];a,b=sorted(rows,key=lambda x:x['arm']);delta=b['metrics']['full']['percent']['TaskDuration']-a['metrics']['full']['percent']['TaskDuration']
    if delta>0:triggers.append({'pairId':pair['pairId'],'delta_pp':delta})
   receipt['diagnosticTriggers'].append({'condition':condition,'triggered':bool(triggers),'positivePairs':triggers});save()
   if triggers:
    pair=dict(pairId='trace-'+condition,kind='diagnostic',condition=condition,mode='P1',order='AB')
    for pos,arm in enumerate('AB'):execute(pair,pos+1,arm,True)
 receipt['status']='needs_review'
except BaseException as e:
 receipt.update(status='partial',stopReason=type(e).__name__+': '+str(e))
 if receipt['runs'] and receipt['runs'][-1]['status']=='running':receipt['runs'][-1].update(status='failed',stopReason=receipt['stopReason'])
finally:
 # Reserve a distinct hard alarm for all cleanup, final budget traversal and receipt writes.
 signal.setitimer(signal.ITIMER_REAL,max(.001,started+p['maxBatchMs']/1000-time.monotonic()))
 for name,proc in [('runner',runner),('server',server)]:
  try:receipt[name+'FinalCleanup']=stop(proc)
  except Exception as e:receipt[name+'FinalCleanup']={'error':str(e),'pid':proc.pid};receipt['status']='partial'
 receipt['finishedEpochMs']=int(time.time()*1000)
 c.record_final_budget(receipt,budget)
 c.record_elapsed(receipt,time.monotonic()-started,p['maxBatchMs'])
 try:save()
 except TimeoutError:
  receipt['status']='partial';receipt['stopReason']='Global deadline during receipt write';save()
 signal.setitimer(signal.ITIMER_REAL,0)
 c.record_elapsed(receipt,time.monotonic()-started,p['maxBatchMs']);save()
 print(json.dumps({'status':receipt['status'],'completed':sum(r['status']=='completed' for r in receipt['runs']),'receipt':str(out/'orchestrator.json')}),flush=True)
if receipt['status']!='needs_review':raise SystemExit(1)
