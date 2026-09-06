import importlib.util,unittest,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('common',Path(__file__).with_name('phase1b-r1-common.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class Tests(unittest.TestCase):
 def test_cdp_weighted(self):
  a=dict(Timestamp=1,TaskDuration=2,ScriptDuration=1,LayoutDuration=0);b=dict(Timestamp=21,TaskDuration=6,ScriptDuration=3,LayoutDuration=1);d=dict(Timestamp=24,TaskDuration=9,ScriptDuration=4,LayoutDuration=1)
  self.assertAlmostEqual(c.interval(a,d)['percent']['TaskDuration'],100*7/23)
  self.assertNotEqual(c.interval(a,d)['percent']['TaskDuration'],(c.interval(a,b)['percent']['TaskDuration']+c.interval(b,d)['percent']['TaskDuration'])/2)
 def test_zero_and_missing(self):
  for a,b in [({},{}),(dict(Timestamp=1,TaskDuration=2,ScriptDuration=1,LayoutDuration=0),dict(Timestamp=1,TaskDuration=3,ScriptDuration=2,LayoutDuration=0))]:
   with self.assertRaises(ValueError):c.interval(a,b)
 def test_control(self):
  a=dict(arm='A',sourceSha='aaa',buildId='build',taskPercent=2);b=a|dict(taskPercent=3)
  self.assertEqual(c.pair_delta(a,b,'control'),1)
  for key,value in [('arm','B'),('sourceSha','bbb'),('buildId','other')]:
   with self.assertRaises(ValueError):c.pair_delta(a,b|{key:value},'control')
 def test_ba_sign(self):
  self.assertEqual(c.pair_delta(dict(arm='B',taskPercent=3),dict(arm='A',taskPercent=2),'main'),1)
 def test_mapping(self):
  p=json.loads(Path('benchmarks/capture/phase1b-r1-plan.json').read_text());c.validate_plan(p)
  p['pairs'][0]['order']='AA'
  with self.assertRaises(AssertionError):c.validate_plan(p)
 def test_source_and_driver_separate(self):
  text=Path('scripts/measure-phase1b-r1.mts').read_text();self.assertIn('cwd: productRoot',text);self.assertIn('driverSha, productRoot, servedBuildId',text)
 def test_bounded_trace(self):
  text=Path('scripts/measure-phase1b-r1.mts').read_text();self.assertIn('bytes.length > traceSettings.maxEncodedBytes',text);self.assertIn('truncated || !positiveControl',text);self.assertIn('Profiler.disable',text)
 def test_generated_declaration_exact(self):
  original=b'import "./.next/types/routes.d.ts";\nimport "./.next/types/root-params.d.ts";\n'
  expected=b'import "./.next-measurement/types/routes.d.ts";\nimport "./.next-measurement/types/root-params.d.ts";\n'
  self.assertEqual(c.expected_generated(original),expected)
  self.assertNotEqual(c.expected_generated(original),expected+b'// extra')
 def test_real_owned_process_cleanup(self):
  import subprocess,sys
  proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
  self.assertTrue(c.stop_owned(proc)['groupGone'])
 def test_generated_only_real_git(self):
  import tempfile,subprocess
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);(root/'next-env.d.ts').write_text('import "./.next/types/routes.d.ts";\nimport "./.next/types/root-params.d.ts";\n');(root/'product.ts').write_text('const a=1;\n')
   def git(*args):subprocess.run(['git','-C',folder,*args],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   git('init');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture')
   p=root/'next-env.d.ts';p.write_bytes(c.expected_generated(p.read_bytes()))
   self.assertEqual(c.verify_source(root,True),['next-env.d.ts'])
   with self.assertRaises(ValueError):c.verify_source(root)
   (root/'product.ts').write_text('const a=2;\n')
   with self.assertRaises(ValueError):c.verify_source(root,True)
 def test_final_budget_failure_never_success(self):
  r={'status':'needs_review','runs':[{'status':'completed'}]}
  def fail():raise RuntimeError('over budget')
  c.record_final_budget(r,fail)
  self.assertEqual(r['status'],'partial');self.assertEqual(len(r['runs']),1);self.assertIn('over budget',r['finalBudget']['error'])
 def test_global_deadline_reserved_and_final(self):
  self.assertEqual(c.remaining_seconds(100,1800000,20000,101),1779)
  with self.assertRaises(TimeoutError):c.remaining_seconds(100,1800000,20000,1880)
  r={'status':'needs_review'};c.record_elapsed(r,1800.01,1800000);self.assertEqual(r['status'],'partial')
 def test_real_alarm_interrupts_synchronous_work(self):
  import signal,time
  old=signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError('test deadline')))
  try:
   signal.setitimer(signal.ITIMER_REAL,.02)
   with self.assertRaises(TimeoutError):time.sleep(1)
  finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old)
if __name__=='__main__':unittest.main()
