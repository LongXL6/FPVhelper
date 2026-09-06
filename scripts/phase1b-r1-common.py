"""Pure identity, pairing and CDP checks for the bounded confirmation."""
import hashlib,json,subprocess
from pathlib import Path

def digest(data): return hashlib.sha256(data).hexdigest()
def git(root,*args): return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
def source_inventory(root):
    paths=subprocess.check_output(['git','-C',str(root),'ls-files','-z']).decode().split('\0')
    return [{'path':p,'sha256':digest((Path(root)/p).read_bytes()),'bytes':(Path(root)/p).stat().st_size} for p in paths if p]
def interval(before,after):
    names=['Timestamp','TaskDuration','ScriptDuration','LayoutDuration']
    if any(k not in before or k not in after for k in names): raise ValueError('Missing CDP endpoint')
    d={k:after[k]-before[k] for k in names}
    if d['Timestamp']<=0 or any(d[k]<0 for k in names): raise ValueError('Invalid CDP delta')
    return {'seconds':d,'percent':{k:100*d[k]/d['Timestamp'] for k in names[1:]}}
def pair_delta(x,y,kind):
    if kind=='control':
        if x['arm']!=y['arm'] or x['sourceSha']!=y['sourceSha'] or x['buildId']!=y['buildId']: raise ValueError('Control identity mismatch')
        return y['taskPercent']-x['taskPercent']
    if {x['arm'],y['arm']}!={'A','B'}: raise ValueError('Not A/B')
    a,b=sorted([x,y],key=lambda r:r['arm']);return b['taskPercent']-a['taskPercent']
def validate_plan(p):
    assert len(p['pairs'])==16
    for condition,mode in [('S1-100','N'),('S1-100','P1'),('S2','P1')]:
        main=[x for x in p['pairs'] if x['kind']=='main' and x['condition']==condition and x['mode']==mode]
        assert sorted(x['order'] for x in main)==['AB','AB','BA','BA']
    controls=[x for x in p['pairs'] if x['kind']=='control']
    assert sorted((x['condition'],x['mode'],x['order']) for x in controls)==[('S1-100','N','AA'),('S1-100','N','BB'),('S1-100','P1','AA'),('S1-100','P1','BB')]
    assert p['maxBatchMs']==1800000 and p['maxRunMs']==120000 and p['maxOutputBytes']==262144000
def expected_generated(original):
    return original.replace(b'import "./.next/types/routes.d.ts";',b'import "./.next-measurement/types/routes.d.ts";').replace(b'import "./.next/types/root-params.d.ts";',b'import "./.next-measurement/types/root-params.d.ts";')
def verify_source(root,allow_generated=False):
    paths=subprocess.check_output(['git','-C',str(root),'ls-files','-z']).decode().split('\0')
    differences=[]
    for p in filter(None,paths):
        original=subprocess.check_output(['git','-C',str(root),'show','HEAD:'+p]);actual=(Path(root)/p).read_bytes()
        if original!=actual:
            if not (allow_generated and p=='next-env.d.ts' and actual==expected_generated(original)): raise ValueError('Unexpected source bytes: '+p)
            differences.append(p)
    return differences
def stop_owned(proc):
    import os,signal,time
    if proc is None:return None
    try:os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    try:proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=2);raise RuntimeError('Owned process needed forced cleanup')
    deadline=time.monotonic()+2
    while time.monotonic()<deadline:
        try:os.killpg(proc.pid,0)
        except ProcessLookupError:return {'pid':proc.pid,'exitCode':proc.returncode,'groupGone':True}
        time.sleep(.1)
    raise RuntimeError('Owned process group still alive')
def record_final_budget(receipt,read_budget):
    try:receipt['finalBudget']=read_budget()
    except Exception as error:
        receipt['finalBudget']={'error':type(error).__name__+': '+str(error)}
        receipt['status']='partial'
        receipt.setdefault('stopReason','Final budget verification failed')
def remaining_seconds(start,limit_ms,cleanup_ms=0,now=None):
    import time
    left=start+(limit_ms-cleanup_ms)/1000-(time.monotonic() if now is None else now)
    if left<=0:raise TimeoutError('Global deadline exhausted')
    return left
def record_elapsed(receipt,elapsed,limit_ms):
    receipt['wallSeconds']=elapsed
    if elapsed*1000>=limit_ms:
        receipt['status']='partial';receipt.setdefault('stopReason','Global deadline exceeded including finalization')
