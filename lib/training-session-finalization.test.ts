import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createTrainingSessionStore } from "./training-session-store";
import { appendTrainingSessionSample, createTrainingSessionDraft, finishTrainingSession, parseTrainingSession, serializeTrainingSession, type TrainingSession } from "./training-session";
import { hasCurrentSessionExport, sessionFinalization } from "./training-session-metadata";
import { EMPTY_TELEMETRY } from "./telemetry";

function terminal(id="terminal"): TrainingSession {
  const draft=createTrainingSessionDraft({id,athleteCode:"SYNTHETIC",workstationId:"10000000-0000-4000-8000-000000000001",build:"0.6.1+test",source:"serial",startedAtEpochMs:1800000000000,startedMonotonicMs:1000});
  for(let i=0;i<3;i++)appendTrainingSessionSample(draft,{...EMPTY_TELEMETRY,sequence:i+1,monotonicTimestampMs:1010+i*10,rcChannelsUs:[1500,1500,1500,1200]},"serial");
  return {...finishTrainingSession(draft,1800000001000,2000),finalization:{version:1,contentRevision:0,confirmedExportRevision:null,media:{state:"pending",operationId:"operation-1"}}};
}
const receipt={filename:"synthetic.webm",mimeType:"video/webm",bytes:300,startedAtEpochMs:1800000000000,finishedAtEpochMs:1800000001000};
const value=<T,>(request: IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function legacy(factory: IDBFactory,name:string,session:TrainingSession){
 const request=factory.open(name,2);request.onupgradeneeded=()=>{request.result.createObjectStore("drafts",{keyPath:"id"});request.result.createObjectStore("sessions",{keyPath:"id"});};
 const database=await value(request);const tx=database.transaction("sessions","readwrite");tx.objectStore("sessions").put(session);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});return database;
}

describe("terminal metadata and old-writer protection",()=>{
 it("reads legacy files and rejects unsupported or inconsistent extension instead of discarding it",()=>{
  const current=terminal();const {finalization:_extension,...old}=current;void _extension;
  expect(sessionFinalization(parseTrainingSession(old)).media.state).toBe("unknown");
  expect(parseTrainingSession(serializeTrainingSession(current)).finalization).toEqual(current.finalization);
  expect(()=>parseTrainingSession({...current,finalization:{...current.finalization,version:2}})).toThrow("finalization");
  expect(()=>parseTrainingSession({...current,finalization:{...current.finalization,extra:true}})).toThrow("finalization");
  expect(()=>parseTrainingSession({...current,finalization:{...current.finalization,media:{state:"recorded",operationId:"operation-1"}}})).toThrow("finalization");
  expect(()=>parseTrainingSession({...current,finalization:{...current.finalization,confirmedExportRevision:1}})).toThrow("修订");
 });
 it("rejects array media states and normalizes termination so summary and detail agree",async()=>{
  const session=terminal();expect(()=>parseTrainingSession({...session,finalization:{...session.finalization,media:{state:["pending"],operationId:"operation-1"}}})).toThrow("finalization");
  const store=createTrainingSessionStore(new IDBFactory(),"reason-normalization");await store.completeSession(session);
  const summary=await store.patchSession(session.id,{kind:"termination",termination:{interrupted:false,interruptionReason:"telemetry_unavailable"}});
  const detail=await store.getSession(session.id);expect(summary.interrupted).toBe(true);expect(detail?.interrupted).toBe(true);expect(summary.validity).toEqual(detail?.validity);await store.close();
 });
 it("refuses and quarantines a metadata patch when a sample chunk is missing",async()=>{
  const factory=new IDBFactory(),store=createTrainingSessionStore(factory,"missing-chunk");const session=terminal();await store.completeSession(session);
  const database=await value(factory.open("missing-chunk"));const tx=database.transaction("sampleChunks","readwrite");tx.objectStore("sampleChunks").delete([session.id,0]);await new Promise<void>((resolve)=>{tx.oncomplete=()=>resolve();});
  await expect(store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt})).rejects.toThrow("样本块");
  const manifest=await value(database.transaction("sessionIndex").objectStore("sessionIndex").get(session.id));expect(manifest.status).toBe("quarantined");expect(manifest.original.metadata.video.recorded).toBe(false);expect(await store.getSession(session.id)).toBeNull();
  await expect(store.patchSession(session.id,{kind:"notes",notes:"cannot revive"})).rejects.toThrow("隔离");database.close();await store.close();
 });
 it("merges cross-store notes/media/export confirmation and preserves raw samples, times and historical exports",async()=>{
  const factory=new IDBFactory(),a=createTrainingSessionStore(factory,"merge"),b=createTrainingSessionStore(factory,"merge");const session=terminal();await a.completeSession(session);
  await a.patchSession(session.id,{kind:"export",exportedAtEpochMs:1800000001100,snapshotRevision:0});
  await Promise.all([a.patchSession(session.id,{kind:"notes",notes:"latest note"}),b.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt})]);
  const saved=await b.getSession(session.id);expect(saved).toMatchObject({samples:session.samples,endedAt:session.endedAt,durationMs:session.durationMs,notes:"latest note",exportCount:1,video:{recorded:true},finalization:{contentRevision:2,confirmedExportRevision:0}});
  expect(hasCurrentSessionExport(saved!)).toBe(false);
  // A delayed close for the old snapshot cannot claim the newer media/notes revision.
  await a.patchSession(session.id,{kind:"export",exportedAtEpochMs:1800000001200,snapshotRevision:0});expect(hasCurrentSessionExport((await a.getSession(session.id))!)).toBe(false);
  await a.patchSession(session.id,{kind:"export",exportedAtEpochMs:1800000001300,snapshotRevision:2});expect(hasCurrentSessionExport((await a.getSession(session.id))!)).toBe(true);
  await a.close();await b.close();
 });
 it("treats same operation/receipt as idempotent, rejects stale or conflicting results, and upgrades termination without changing endpoints",async()=>{
  const store=createTrainingSessionStore(new IDBFactory(),"media-idempotency");const session=terminal();await store.completeSession(session);
  await store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt});const first=await store.getSession(session.id);
  await store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt});expect(await store.getSession(session.id)).toEqual(first);
  await expect(store.patchSession(session.id,{kind:"media",operationId:"old-op",receipt})).rejects.toThrow("身份");
  await expect(store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt:{...receipt,bytes:301}})).rejects.toThrow("不一致");
  await store.patchSession(session.id,{kind:"termination",termination:{interrupted:true,interruptionReason:"rx_link_lost"}});
  await store.patchSession(session.id,{kind:"termination",termination:{interrupted:false,interruptionReason:null}});
  expect(await store.getSession(session.id)).toMatchObject({endedAt:session.endedAt,durationMs:session.durationMs,samples:session.samples,interruptionReason:"rx_link_lost",video:first!.video,finalization:{contentRevision:2}});
  expect(await store.getActiveDraft()).toBeNull();await store.close();
 });
 it("does not confirm a metadata patch whose transaction aborts and supports retry",async()=>{
  const store=createTrainingSessionStore(new IDBFactory(),"abort");const session=terminal();await store.completeSession(session);
  const original=IDBObjectStore.prototype.put;const put=vi.spyOn(IDBObjectStore.prototype,"put").mockImplementation(function(this: IDBObjectStore,value,key){if(this.name==="sessionIndex")throw new DOMException("fault","QuotaExceededError");return original.call(this,value,key);});
  await expect(store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt})).rejects.toThrow("fault");put.mockRestore();
  expect((await store.getSession(session.id))!.video.recorded).toBe(false);
  await store.patchSession(session.id,{kind:"media",operationId:"operation-1",receipt});expect((await store.getSession(session.id))!.video.recorded).toBe(true);await store.close();
 });
 it("closes a cooperating old v2 connection and makes old open(version2) fail without rewriting the legacy original",async()=>{
  const factory=new IDBFactory(),session=terminal();delete session.finalization;const old=await legacy(factory,"upgrade",session);let changed=false;
  old.onversionchange=()=>{changed=true;old.close();};const current=createTrainingSessionStore(factory,"upgrade");expect((await current.listSessions())[0]).toMatchObject({id:session.id,samples:session.samples});expect(changed).toBe(true);
  expect(()=>old.transaction("sessions","readwrite")).toThrow();await expect(value(factory.open("upgrade",2))).rejects.toMatchObject({name:"VersionError"});
  const database=await value(factory.open("upgrade"));expect(database.version).toBe(3);expect(await value(database.transaction("sessions").objectStore("sessions").get(session.id))).toEqual(session);database.close();await current.close();
 });
 it("reports a blocked upgrade and can reopen after the old uncooperative connection is closed",async()=>{
  const factory=new IDBFactory(),session=terminal();delete session.finalization;const old=await legacy(factory,"blocked-upgrade",session);
  const events:string[]=[];let ordinal=0;const open=factory.open.bind(factory);
  const spy=vi.spyOn(factory,"open").mockImplementation((name,version)=>{const request=open(name,version);const index=++ordinal;request.addEventListener("blocked",()=>events.push(`${index}:blocked`));request.addEventListener("success",()=>events.push(`${index}:success`));return request;});
  const blocked=createTrainingSessionStore(factory,"blocked-upgrade");await expect(blocked.getActiveDraft()).rejects.toThrow("阻塞");events.push("old:close");old.close();await expect(blocked.close()).rejects.toThrow("阻塞");
  const retry=createTrainingSessionStore(factory,"blocked-upgrade");expect((await retry.listSessions())[0].id).toBe(session.id);expect(events).toEqual(["1:blocked","old:close","1:success","2:success"]);spy.mockRestore();await retry.close();
 });
});
