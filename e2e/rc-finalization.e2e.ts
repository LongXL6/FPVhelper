import { mkdir, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, readStoredTrainingRecords } from "./fixtures/fpv-hardware";
import { installPhase2AMediaGate } from "./fixtures/phase2a-media-gate";
import type { TrainingSession } from "../lib/training-session";

test.use({seedDataOnlyPreference:false});
test.setTimeout(45000);
const networkViolations = new WeakMap<Page, string[]>();
const gateSnapshot=(page:Page)=>page.evaluate(()=> (window as unknown as {__phase2aMediaGate:{snapshot():{mode:string;events:Array<{kind:string}>}}}).__phase2aMediaGate.snapshot());
async function release(page:Page,json=false){await page.evaluate((json)=>{const gate=(window as unknown as {__phase2aMediaGate:{release():void;releaseJson():void}}).__phase2aMediaGate;if(json)gate.releaseJson();else gate.release();},json);}
async function files(page:Page,jsonOnly=false,directoryName="phase2a-e2e"){return page.evaluate(async({jsonOnly,directoryName})=>{
 let stage="open OPFS root";
 try {
  const root=await navigator.storage.getDirectory();stage="open phase2a-e2e directory";
  const directory=await root.getDirectoryHandle(directoryName);const rows:Array<{name:string;bytes:number;sha256:string;json?:TrainingSession;header:number[]}>=[];
  for await(const [name,handle] of directory.entries())if(handle.kind==="file"&&(jsonOnly?name.endsWith(".json"):/\.(json|mp4|webm)$/.test(name))){
   stage=`getFile ${name}`;const file=await(handle as FileSystemFileHandle).getFile();stage=`read confirmed contents ${name}`;
   const sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,"0")).join("");
   rows.push({name,bytes:file.size,sha256,header:[...new Uint8Array(await file.slice(0,12).arrayBuffer())],...(name.endsWith(".json")?{json:JSON.parse(await file.text())}: {})});
  }return rows;
 }catch(error){throw new Error(`OPFS evidence read failed at ${stage}: ${String(error)}`);}
},{jsonOnly,directoryName});}

async function attach(info:TestInfo,name:string,value:unknown){const path=info.outputPath(name);await mkdir(info.outputDir,{recursive:true});await writeFile(path,JSON.stringify(value,null,2));await info.attach(name,{path,contentType:"application/json"});}
async function prepare(page:Page,mode:string,extra=""){
 await page.addInitScript(installPhase2AMediaGate);
 await page.addInitScript(()=>Object.defineProperty(window,"showDirectoryPicker",{configurable:true,value:async()=> (await navigator.storage.getDirectory()).getDirectoryHandle("phase2a-e2e",{create:true})}));
 const origin="http://127.0.0.1:3137";const violations:string[]=[];networkViolations.set(page,violations);
 await page.route("**/*",route=>{const req=route.request(),url=new URL(req.url());if(["http:","https:"].includes(url.protocol)&&(url.origin!==origin||!["GET","HEAD"].includes(req.method()))){violations.push(req.method()+" "+url.origin+url.pathname);return route.abort();}return route.continue();});
 await page.goto(`/?analytics=off&mediaGate=${mode}${extra}`);
 const setup=page.getByRole("region",{name:"录制准备",exact:true});
 await setup.getByRole("button",{name:/连接当前选手/}).click();await setup.getByRole("button",{name:/打开当前输入/}).click();await setup.getByRole("button",{name:/选择保存目录/}).click();
 await page.getByRole("textbox",{name:"当前训练选手代号",exact:true}).fill("PHASE2A-E2E");
 await page.getByRole("button",{name:"● 开始记录",exact:true}).click();
 await expect.poll(async()=> (await readStoredTrainingRecords(page)).drafts[0]?.samples.length??0,{intervals:[20]}).toBeGreaterThan(40);
 const checkpoint=(await readStoredTrainingRecords(page)).drafts[0];await page.waitForTimeout(80);
 await page.getByRole("button",{name:"■ 结束记录",exact:true}).click();return checkpoint;
}
async function terminal(page:Page){await expect.poll(async()=> (await readStoredTrainingRecords(page)).sessions.length).toBe(1);return (await readStoredTrainingRecords(page)).sessions[0];}
test.afterEach(async({page})=>{if(!page.isClosed()){await release(page).catch(()=>undefined);await release(page,true).catch(()=>undefined);}expect(networkViolations.get(page)??[]).toEqual([]);});

test("normal stop confirms RC, real video close and exactly one final JSON",async({page},info)=>{
 const checkpoint=await prepare(page,"normal");await expect.poll(async()=> (await terminal(page)).video.recorded).toBe(true);
 await expect.poll(async()=> (await terminal(page)).exportCount).toBe(1);
 expect((await files(page)).filter(f=>f.json?.video.recorded)).toHaveLength(1);
 const stored=await terminal(page),artifacts=await files(page);const exported=artifacts.find(f=>f.json)!.json!;
 expect(stored.samples.length).toBeGreaterThan(checkpoint.samples.length);expect((await readStoredTrainingRecords(page)).drafts).toHaveLength(0);
 expect(exported.samples).toEqual(stored.samples);expect(exported.video).toEqual(stored.video);expect(exported.finalization?.confirmedExportRevision).toBe(stored.finalization?.contentRevision);
 expect(artifacts.filter(f=>f.json)).toHaveLength(1);if(!stored.video.recorded)throw new Error("missing receipt");
 const videoReceipt=stored.video;const video=artifacts.find(f=>f.name===videoReceipt.filename)!;expect(video.bytes).toBe(videoReceipt.bytes);expect(video.bytes).toBeGreaterThan(0);
 expect(video.header.slice(4,8).join()==="102,116,121,112"||video.header.slice(0,4).join()==="26,69,223,163").toBe(true);
 await attach(info,"normal.json",{checkpointSamples:checkpoint.samples.length,stored,artifacts,gate:await gateSnapshot(page)});
});

test("unclosed media does not block terminal RC, early export or same-origin reload",async({page},info)=>{
 const checkpoint=await prepare(page,"before-close");const stored=await terminal(page);
 await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("media-close-entered");
 expect((await gateSnapshot(page)).events.some(e=>e.kind==="media-underlying-close-resolved")).toBe(false);
 expect(stored.samples.length).toBeGreaterThan(checkpoint.samples.length);expect(stored.video.recorded).toBe(false);expect(stored.finalization?.media.state).toBe("pending");expect(stored.interrupted).toBe(false);
 await expect(page.locator(".session-detail-header")).toContainText("遥控数据已保存");await expect(page.locator(".session-detail").getByText("视频仍在收尾",{exact:false})).toBeVisible();
 await page.getByRole("button",{name:"导出 JSON",exact:true}).click();await expect.poll(async()=> (await terminal(page)).exportCount).toBe(1);
 const early=(await files(page,true)).find(f=>f.json)!.json!;expect(early.samples).toEqual(stored.samples);expect(early.video.recorded).toBe(false);
 let dialogType:string|null=null;page.once("dialog",async dialog=>{dialogType=dialog.type();await dialog.accept();});await page.reload();expect(dialogType).toBe("beforeunload");
 await expect.poll(async()=> (await readStoredTrainingRecords(page)).sessions.length).toBe(1);
 const reopened=(await readStoredTrainingRecords(page)).sessions[0];expect(reopened.samples).toEqual(stored.samples);expect(reopened.endedAt).toBe(stored.endedAt);expect(reopened.interruptionReason).toBe(stored.interruptionReason);expect(reopened.video.recorded).toBe(false);expect(reopened.finalization?.media.state).toBe("pending");
 await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"训练记录",exact:true}).click();await expect(page.locator(".session-detail").getByText("视频尚未确认",{exact:false})).toBeVisible();
 await attach(info,"pending-reopened.json",{checkpointSamples:checkpoint.samples.length,stored,early,reopened,dialogType,boundary:"same Page/context/origin DB; no target record seed after reload; before-close gate did not close media"});
});

test("RC transaction failure is retryable while media remains pending",async({page},info)=>{
 await prepare(page,"before-close","&rcFault=once");await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("rc-final-transaction-fault");
 expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(0);
 await page.locator(".session-card").getByRole("button",{name:"重试保存 Session",exact:true}).click();
 const stored=await terminal(page);expect(stored.video.recorded).toBe(false);expect(stored.finalization?.media.state).toBe("pending");
 expect((await gateSnapshot(page)).events.some(e=>e.kind==="media-underlying-close-resolved")).toBe(false);
 await attach(info,"rc-retry.json",{stored,gate:await gateSnapshot(page)});
});

test("late closed-media acknowledgement merges notes and serializes early/final exports",async({page},info)=>{
 await prepare(page,"after-close","&jsonGate=first");const frozen=await terminal(page);
 await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("media-underlying-close-resolved");
 await page.getByRole("textbox",{name:"留给下一次训练",exact:true}).fill("NOTE-BEFORE-LATE-MEDIA");await page.getByRole("button",{name:"保存备注",exact:true}).click();
 await page.getByRole("button",{name:"导出 JSON",exact:true}).click();await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("json-close-entered");
 expect((await terminal(page)).exportCount).toBe(0);await release(page);
 await expect.poll(async()=> (await terminal(page)).video.recorded).toBe(true);
 expect((await gateSnapshot(page)).events.filter(e=>e.kind==="json-writable-created")).toHaveLength(1);
 await release(page,true);await expect.poll(async()=> (await terminal(page)).exportCount).toBe(2);
 const final=await terminal(page),artifacts=await files(page);const snapshots=artifacts.filter(f=>f.json);
 expect(snapshots).toHaveLength(2);expect(new Set(snapshots.map(f=>f.name)).size).toBe(2);
 const early=snapshots.find(f=>!f.json!.video.recorded)!.json!,late=snapshots.find(f=>f.json!.video.recorded)!.json!;
 expect(early.exportCount).toBe(1);expect(late.exportCount).toBe(2);expect(late.notes).toBe("NOTE-BEFORE-LATE-MEDIA");expect(final.notes).toBe(late.notes);expect(final.samples).toEqual(frozen.samples);expect(final.endedAt).toBe(frozen.endedAt);
 expect(final.finalization?.confirmedExportRevision).toBe(final.finalization?.contentRevision);
 await attach(info,"late-media-and-exports.json",{frozen,early,late,final,gate:await gateSnapshot(page),filenames:snapshots.map(f=>f.name)});
});

test("failed media association retries the receipt without another recording or media file",async({page},info)=>{
 await prepare(page,"normal","&associationFault=once");const frozen=await terminal(page);
 await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("media-association-transaction-fault");
 await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"飞行工作台",exact:true}).click();
 await page.getByRole("button",{name:"重试关联视频收据",exact:true}).click();await expect.poll(async()=> (await terminal(page)).video.recorded).toBe(true);
 const final=await terminal(page);expect(final.samples).toEqual(frozen.samples);expect((await gateSnapshot(page)).events.filter(e=>e.kind==="media-writable-created")).toHaveLength(1);
 await attach(info,"association-retry.json",{frozen,final,gate:await gateSnapshot(page)});
});

test("a rejected media result never fabricates a receipt even when the underlying file closed",async({page},info)=>{
 await prepare(page,"reject-after-close");
 await expect.poll(async()=> (await terminal(page)).finalization?.media.state).toBe("failed");
 const stored=await terminal(page);expect(stored.video.recorded).toBe(false);expect(stored.interrupted).toBe(false);
 await expect.poll(async()=> (await terminal(page)).exportCount).toBe(1);
 const artifacts=await files(page);expect(artifacts.some(f=>/\.(mp4|webm)$/.test(f.name)&&f.bytes>0)).toBe(true);expect(artifacts.find(f=>f.json)!.json!.video.recorded).toBe(false);
 await attach(info,"rejected-media.json",{stored,artifacts,gate:await gateSnapshot(page),boundary:"Underlying real close resolved; test then rejected acknowledgement. File existence is not promoted into a success receipt."});
});


test("automatic final JSON stays with its original video directory while the user switches folders",async({page},info)=>{
 await prepare(page,"after-close","&jsonGate=first");const frozen=await terminal(page);
 await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("media-underlying-close-resolved");
 await page.getByRole("textbox",{name:"留给下一次训练",exact:true}).fill("DIRECTORY-BINDING-NOTE");await page.getByRole("button",{name:"保存备注",exact:true}).click();
 await page.getByRole("button",{name:"导出 JSON",exact:true}).click();
 await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("json-close-entered");
 await release(page);await expect.poll(async()=> (await terminal(page)).video.recorded).toBe(true);
 // Only the browser picker boundary is substituted; actual product controls change the selected folder.
 await page.evaluate(()=>Object.defineProperty(window,"showDirectoryPicker",{configurable:true,value:async()=> (await navigator.storage.getDirectory()).getDirectoryHandle("phase2a-d2",{create:true})}));
 await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"飞行工作台",exact:true}).click();
 await page.locator(".recording-options > summary").click();
 await page.getByRole("button",{name:"更换文件夹",exact:true}).click();
 await expect(page.locator(".session-export-directory")).toContainText("phase2a-d2");
 expect((await gateSnapshot(page)).events.filter(e=>e.kind==="json-writable-created")).toHaveLength(1);
 await release(page,true);await expect.poll(async()=> (await terminal(page)).exportCount).toBe(2);
 const final=await terminal(page),d1=await files(page),d2=await files(page,false,"phase2a-d2");
 await attach(info,"directory-binding.json",{frozen,final,d1,d2,gate:await gateSnapshot(page)});
 expect(d2).toHaveLength(0);expect(d1.filter(f=>f.json)).toHaveLength(2);
 const early=d1.find(f=>f.json&&!f.json.video.recorded)!.json!,late=d1.find(f=>f.json?.video.recorded)!.json!;
 expect(early.exportCount).toBe(1);expect(late.exportCount).toBe(2);expect(late.id).toBe(frozen.id);
 expect(early.notes).toBe("DIRECTORY-BINDING-NOTE");expect(late.notes).toBe(early.notes);expect(final.notes).toBe(early.notes);
 expect(late.samples).toEqual(frozen.samples);expect(late.endedAt).toBe(frozen.endedAt);expect(late.video).toEqual(final.video);
 expect(late.finalization?.confirmedExportRevision).toBe(final.finalization?.contentRevision);
 if(!final.video.recorded)throw new Error("missing video receipt");const video=final.video;
 expect(d1.find(f=>f.name===video.filename)?.bytes).toBe(video.bytes);
 await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"训练记录",exact:true}).click();
 await page.getByRole("button",{name:"导出 JSON",exact:true}).click();await expect.poll(async()=> (await terminal(page)).exportCount).toBe(3);
 const manual=await files(page,true,"phase2a-d2");expect(manual).toHaveLength(1);expect(manual[0].json?.id).toBe(frozen.id);expect(manual[0].json?.exportCount).toBe(3);expect(manual[0].json?.samples).toEqual(frozen.samples);
 expect(await files(page)).toEqual(d1);
 await attach(info,"directory-binding-final.json",{frozen,stored:await terminal(page),d1,automaticD2:d2,manualD2:manual,gate:await gateSnapshot(page)});
});


test("a second Session uses D2 while S1 automatic export is still waiting for its early JSON",async({page},info)=>{
 await prepare(page,"after-close","&jsonGate=first");const s1=await terminal(page);
 await page.getByRole("button",{name:"导出 JSON",exact:true}).click();await expect.poll(async()=>JSON.stringify(await gateSnapshot(page))).toContain("json-close-entered");
 await release(page);await expect.poll(async()=> (await terminal(page)).video.recorded).toBe(true);
 await page.evaluate(()=>Object.defineProperty(window,"showDirectoryPicker",{configurable:true,value:async()=> (await navigator.storage.getDirectory()).getDirectoryHandle("phase2a-s2",{create:true})}));
 await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"飞行工作台",exact:true}).click();
 await page.locator(".recording-options > summary").click();await page.getByRole("button",{name:"更换文件夹",exact:true}).click();
 await expect(page.getByRole("button",{name:"● 开始记录",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"● 开始记录",exact:true}).click();
 await expect.poll(async()=> (await readStoredTrainingRecords(page)).drafts[0]?.samples.length??0).toBeGreaterThan(30);
 const draft=(await readStoredTrainingRecords(page)).drafts[0];expect(draft.id).not.toBe(s1.id);
 await release(page,true);await expect.poll(async()=> (await terminal(page)).exportCount).toBe(2);
 expect((await readStoredTrainingRecords(page)).drafts[0].id).toBe(draft.id);
 await expect(page.getByRole("button",{name:"■ 结束记录",exact:true})).toBeEnabled();
 expect(await files(page,true,"phase2a-s2")).toHaveLength(0);
 await page.getByRole("button",{name:"■ 结束记录",exact:true}).click();
 await expect.poll(async()=> (await readStoredTrainingRecords(page)).sessions.filter(s=>s.id===draft.id&&s.video.recorded&&s.exportCount===1).length).toBe(1);
 const stored=(await readStoredTrainingRecords(page)).sessions,d1=await files(page),d2=await files(page,false,"phase2a-s2");
 expect(stored).toHaveLength(2);expect(d1.filter(f=>f.json)).toHaveLength(2);expect(d2.filter(f=>f.json)).toHaveLength(1);
 expect(d1.filter(f=>f.json).every(f=>f.json!.id===s1.id)).toBe(true);expect(d2.find(f=>f.json)?.json?.id).toBe(draft.id);
 const finalS1=stored.find(s=>s.id===s1.id)!,finalS2=stored.find(s=>s.id===draft.id)!;
 expect(finalS1.samples).toEqual(s1.samples);expect(finalS1.endedAt).toBe(s1.endedAt);expect(finalS1.exportCount).toBe(2);expect(finalS2.interruptionReason).toBeNull();
 expect(finalS2.samples.slice(0,draft.samples.length)).toEqual(draft.samples);
 for(const [session,artifacts] of [[finalS1,d1],[finalS2,d2]] as const){
  if(!session.video.recorded)throw new Error("missing Session video receipt");const video=session.video;
  expect(artifacts.find(f=>f.name===video.filename)?.bytes).toBe(video.bytes);
  const exported=artifacts.find(f=>f.json?.video.recorded)!.json!;expect(exported.samples).toEqual(session.samples);expect(exported.video).toEqual(session.video);expect(exported.finalization?.confirmedExportRevision).toBe(session.finalization?.contentRevision);
 }
 await attach(info,"two-session-directories.json",{s1,draft,stored,d1,d2,gate:await gateSnapshot(page)});
});
