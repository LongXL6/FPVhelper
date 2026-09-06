"""Independent stdlib recalculation. Reads originals without modifying them."""
import gzip, hashlib, json, statistics, sys
from pathlib import Path
old = Path('/Users/longxl/.codex/worktrees/fpvhelper-phase1b-recording-progress')
receipt = json.loads((old/'output/playwright/phase1b/formal-b6a3849-01/phase1b-orchestrator.json').read_text())
rows = []
for run in receipt['runs']:
    data = Path(run['artifact']['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == run['artifact']['sha256']
    raw = json.loads(gzip.decompress(data)); w = raw['windows'][0]
    before, after = (w['cdp'][k]['metrics'] for k in ['before','after'])
    deltas = {k: after[k]-before[k] for k in ['Timestamp','TaskDuration','ScriptDuration','LayoutDuration']}
    assert deltas['Timestamp'] > 0
    frames = [f for f in raw['hardware']['frames'] if f['deliveredAtMs'] is not None and w['t0'] <= f['deliveredAtMs'] < w['t1']]
    events = None if raw['probe'] is None else [e for e in raw['probe']['events'] if e['kind']=='react.commit' and w['t0'] <= e['commitTime'] < w['t1']]
    profilers = None if events is None else {b: {'callbacks':len(es := [e for e in events if e['profilerId']==b]),'callbacks_s': len(es)*1000/(w['t1']-w['t0']), 'callbacks_rc':len(es)/len(frames), 'render_total_ms':sum(e['actualDuration'] for e in es)} for b in sorted({e['profilerId'] for e in events})}
    rows.append({k:run[k] for k in ['globalIndex','arm','condition','mode','repeat','startedAtUtc']} | {'artifact_sha256':run['artifact']['sha256'], 'deltas':deltas, 'task_percent':100*deltas['TaskDuration']/deltas['Timestamp'], 'delivery_hz':len(frames)*1000/(w['t1']-w['t0']), 'profilers':profilers, 'browser':raw['browser'], 'resources':raw['resourcesBefore'], 'buffer_overflow':raw['hardware']['overflowCount'], 'errors':raw['errors']})
pairs=[]
for i in range(0,len(rows),2):
    x,y=rows[i:i+2]; a,b=sorted([x,y],key=lambda r:r['arm'])
    pairs.append({'condition':a['condition'],'mode':a['mode'],'repeat':a['repeat'],'order':x['arm']+y['arm'],'A_task_percent':a['task_percent'],'B_task_percent':b['task_percent'],'delta_pp':b['task_percent']-a['task_percent'], 'recording_callbacks_rc_change_percent': None if not a['profilers'] or 'recording-ui' not in a['profilers'] else 100*(b['profilers']['recording-ui']['callbacks_rc']/a['profilers']['recording-ui']['callbacks_rc']-1)})
expected={'S1-100/P1':[.3199670902675962,3.0131003985464275,.9561386965221317], 'S2/P1':[-3.805426396833319,-15.248161580882968,3.600300588945551],'S2/N':[-2.6923166953393185,-5.171948749757821,-3.660031376056626]}
for key,values in expected.items():
    actual=[p['delta_pp'] for p in pairs if p['condition']+'/'+p['mode']==key]
    assert all(abs(a-b)<1e-9 for a,b in zip(actual,values)) and len(actual)==len(values)
result={'status':'recomputed_18_originals','rows':rows,'pairs':pairs,'serverEvents':receipt['serverEvents'], 'facts':['Fresh chromium.launch per spawned runner and newContext per run (source); same arm/mode server reused when adjacent category unchanged (source and serverEvents).','5s warmup,20s page cohort,3s live-source drain; CDP includes drain and cross-process overhead.','Fixture demand-paced synthetic responses; reported delivery_hz is actual cohort.','No recorded host-process load, thermal state or cache flush; machine-idle/GC causation unavailable.','Old start/end CDP calls lack cross-process bracket timestamps; cannot retroactively split steady/drain.','P1 nested profiler durations kept separate; N internal metrics unavailable.']}
Path(sys.argv[1]).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(pairs,indent=2))
