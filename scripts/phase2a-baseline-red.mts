import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { installMeasurementHardware } from "../e2e/fixtures/measurement-hardware.ts";
import { installPhase2AMediaGate } from "../e2e/fixtures/phase2a-media-gate.ts";
import { readStoredTrainingRecords } from "../e2e/fixtures/fpv-hardware.ts";
const output="output/playwright/phase2a/baseline-red-01";
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:["camera"]});
const page=await context.newPage();
const evidence: Record<string,unknown>={baseSha:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),buildId:(await readFile(".next/BUILD_ID","utf8")).trim(),browser:browser.version(),classification:"controlled baseline RED; automated UI not Computer Use",source:"syntheticMSP/fakevideo; realIDB/MediaRecorder/OPFS",url:"http://127.0.0.1:3138/?analytics=off&mediaGate=before-close"};
const violations: unknown[]=[];
await context.route("**/*",route=>{const r=route.request(),u=new URL(r.url());if(["http:","https:"].includes(u.protocol)&&(u.origin!=="http://127.0.0.1:3138"||!["GET","HEAD"].includes(r.method()))){violations.push(u.origin+u.pathname);return route.abort();}return route.continue();});
await context.addInitScript({content:`if(location.protocol==='http:'&&location.hostname==='127.0.0.1'){(${installMeasurementHardware.toString()})({inputHz:100,detailed:false,maxFrames:30000,maxEvents:200000});}`});
await context.addInitScript(installPhase2AMediaGate);
const gate=()=>page.evaluate(()=> (window as unknown as {__phase2aMediaGate:{snapshot():unknown}}).__phase2aMediaGate.snapshot());
try {
 await page.goto(String(evidence.url));await page.getByRole("button",{name:"关闭首次使用检查",exact:true}).click();
 const setup=page.getByRole("region",{name:"录制准备",exact:true});
 await setup.getByRole("button",{name:/连接当前选手/}).click();await setup.getByRole("button",{name:/打开当前输入/}).click();await setup.getByRole("button",{name:/选择保存目录/}).click();
 await page.getByRole("textbox",{name:"当前训练选手代号",exact:true}).fill("PHASE2A-RED");
 await page.getByRole("button",{name:"● 开始记录",exact:true}).click();
 await expect.poll(async()=> (await readStoredTrainingRecords(page)).drafts[0]?.samples.length??0,{timeout:7000,intervals:[20]}).toBeGreaterThan(40);
 const checkpoint=await readStoredTrainingRecords(page);evidence.checkpoint=checkpoint;
 await page.waitForTimeout(100);
 await page.getByRole("button",{name:"■ 结束记录",exact:true}).click();
 await expect.poll(async()=>JSON.stringify(await gate()),{timeout:5000}).toContain("media-close-entered");
 evidence.gatePending=await gate();evidence.pendingRead=await readStoredTrainingRecords(page);evidence.pendingUi=await page.locator(".session-card").innerText();
 const retry=page.getByRole("button",{name:"重试保存 Session",exact:true});evidence.retryVisible=await retry.isVisible();evidence.retryDisabled=await retry.isVisible()?await retry.isDisabled():null;
 if(await retry.isVisible()&&await retry.isEnabled())await retry.click();
 evidence.afterRetryRead=await readStoredTrainingRecords(page);
 const pending=evidence.pendingRead as Awaited<ReturnType<typeof readStoredTrainingRecords>>;
 expect(pending.sessions).toHaveLength(0);expect(pending.drafts[0].samples.length).toBe(checkpoint.drafts[0].samples.length);
 try {expect(pending.sessions.some(s=>s.id===checkpoint.drafts[0].id)).toBe(true);} catch(error){evidence.expectedContractFailure=String(error);}
 evidence.status="baseline_red_reproduced";
 await page.screenshot({path:output+"/baseline-pending-automated.png",fullPage:true});
} catch(error){evidence.status="unexpected_preflight_failure";evidence.error=String(error);process.exitCode=1;}
finally {
 try {await page.evaluate(()=> (window as unknown as {__phase2aMediaGate:{release():void}}).__phase2aMediaGate.release());await expect.poll(async()=> (await readStoredTrainingRecords(page)).sessions.length,{timeout:10000}).toBe(1);evidence.afterReleaseRead=await readStoredTrainingRecords(page);evidence.gateReleased=await gate();}catch(error){evidence.cleanupError=String(error);process.exitCode=1;}
 evidence.networkViolations=violations;await context.close();await browser.close();evidence.ownedContextAndBrowserClosed=true;
 await writeFile(output+"/receipt.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:evidence.status,output,error:evidence.error,cleanupError:evidence.cleanupError}));
}
