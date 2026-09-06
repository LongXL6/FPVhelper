"""Offline post-batch reporting. Does not run during formal collection."""
import collections,gzip,importlib.util,json,statistics,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('common',Path(__file__).with_name('phase1b-r1-common.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
folder=Path(sys.argv[1]);receipt=json.loads((folder/'orchestrator.json').read_text());rows=[]
for r in receipt['runs']:
 if r['status']!='completed':continue
 path=Path(r['rawPath']);data=path.read_bytes();assert c.digest(data)==r['rawSha256'];raw=json.loads(gzip.decompress(data));w=raw['windows'][0];cdp=w['cdp']
 windows={k:c.interval(cdp[x]['metrics'],cdp[y]['metrics']) for k,x,y in [('steady','before','steadyEnd'),('drain','steadyEnd','after'),('full','before','after')]}
 assert windows==r['metrics']
 frames=[f for f in raw['hardware']['frames'] if f['deliveredAtMs'] is not None and w['t0']<=f['deliveredAtMs']<w['t1']]
 events=None if raw['probe'] is None else [e for e in raw['probe']['events'] if e['kind']=='react.commit' and w['t0']<=e['commitTime']<w['t1']]
 profilers=None if events is None else {b:{'callbacks':len(es:=[e for e in events if e['profilerId']==b]),'callbacks_s':len(es)*1000/(w['t1']-w['t0']),'callbacks_rc':len(es)/len(frames),'render_ms_total':sum(e['actualDuration'] for e in es),'render_ms_median':statistics.median(e['actualDuration'] for e in es)} for b in sorted({e['profilerId'] for e in events})}
 summary=json.loads(Path(r['summaryPath']).read_text())
 row={k:r[k] for k in ['index','pairId','kind','condition','mode','order','position','arm','sourceSha','buildId','wallSeconds','rawSha256','decodedSha256','rawPath']};row.update(metrics=windows,rawEndpoints=cdp,deliveredRC=len(frames),actualRcHz=len(frames)*1000/(w['t1']-w['t0']),profilers=profilers,integrityValid=summary['valid'],violations=summary['violations'],savedSessions=len(raw['sessions']),savedSamples=sum(len(s['samples']) for s in raw['sessions']),runtimeReactVersion=None if events is None else sorted({e.get('reactVersion','unknown') for e in events}),browser=raw['browser'],traceReceipt=raw.get('traceReceipt'),summary=summary)
 if raw.get('traceReceipt') and not raw['traceReceipt']['truncated']:
  profile=json.loads(gzip.decompress(Path(raw['traceReceipt']['path']).read_bytes()));nodes={n['id']:n for n in profile['nodes']};weights=collections.Counter()
  for node,dt in zip(profile['samples'],profile['timeDeltas']):
   f=nodes[node]['callFrame'];weights[(f['functionName'],f['url'],f['lineNumber'],f['columnNumber'])]+=dt
  row['sampledStackSelfTimeTop20']=[{'function':key[0],'url':key[1],'line0':key[2],'column0':key[3],'weightedMicroseconds':value} for key,value in weights.most_common(20)]
  row['profileInterpretation']='Sampled top-stack weights only; gaps/idle/native labels included. Not exact CPU timing or exhaustive task/layout/GC attribution. Minified names may not map causally to product source.'
 rows.append(row)
pairs=[]
for pairId in dict.fromkeys(r['pairId'] for r in rows):
 rs=[r for r in rows if r['pairId']==pairId]
 if len(rs)!=2:continue
 x,y=rs;kind=x['kind'];signed={}
 for window in ['steady','drain','full']:
  signed[window]=c.pair_delta(*[{'arm':r['arm'],'sourceSha':r['sourceSha'],'buildId':r['buildId'],'taskPercent':r['metrics'][window]['percent']['TaskDuration']} for r in rs],kind)
 pairs.append({'pairId':pairId,'kind':kind,'condition':x['condition'],'mode':x['mode'],'order':x['order'],'indices':[x['index'],y['index']],'delta_pp':signed,'absoluteFullDeltaPp':abs(signed['full']),'meaning':'second-first same product/build' if kind=='control' else 'B-A','A_B_or_positions':[{k:r[k] for k in ['arm','position','actualRcHz','metrics','profilers']} for r in rs]})
stats=[]
for condition,mode in [('S1-100','N'),('S1-100','P1'),('S2','P1')]:
 ps=[p for p in pairs if p['kind']=='main' and p['condition']==condition and p['mode']==mode];values=[p['delta_pp']['full'] for p in ps]
 stats.append({'condition':condition,'mode':mode,'pairs':len(ps),'positive':sum(v>0 for v in values),'negative':sum(v<0 for v in values),'median_pp':statistics.median(values) if values else None,'min_pp':min(values) if values else None,'max_pp':max(values) if values else None,'mean_pp':statistics.mean(values) if values else None})
if any(s['pairs']==4 and s['positive']==4 for s in stats):risk='observed_regression_signal'
elif all(s['pairs']==4 and s['positive']==0 for s in stats):risk='not_reproduced_in_bounded_check'
else:risk='measurement_sensitive_or_inconclusive'
report={'title':'FPVHelper Phase 1B-R1 — CDP Increase Confirmation Without Product Changes','status':receipt['status'],'riskClassification':risk,'stats':stats,'pairs':pairs,'runs':rows,'failed':[r for r in receipt['runs'] if r['status']!='completed'],'diagnosticTriggers':receipt['diagnosticTriggers'],'limits':['Short descriptive repeats, not significance or no-regression proof. No engineering tolerance added.','A single AA/BB control per mode does not establish a noise bound.','N and P1 cannot be subtracted as pure instrumentation overhead.','Nested Profiler durations not summed; callbacks are not FPS; CDP is renderer duration, not host CPU.','All original persistence/video/vision/real-device/endurance risks remain open.']}
(folder/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'risk':risk,'stats':stats},indent=2))
