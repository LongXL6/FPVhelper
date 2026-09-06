import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { installMeasurementHardware } from "../e2e/fixtures/measurement-hardware.ts";
import { installPhase2AMediaGate } from "../e2e/fixtures/phase2a-media-gate.ts";
import { readStoredTrainingRecords } from "../e2e/fixtures/fpv-hardware.ts";
const output = resolve(process.argv[2] ?? "output/playwright/phase2a/cua-baseline");
await mkdir(output, {recursive: true});
const origin = "http://127.0.0.1:3138";
const context = await chromium.launchPersistentContext(resolve(output,"profile"), {headless: false, viewport:{width:1440,height:1100}, permissions:["camera"], args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
const violations: unknown[] = [];
await context.route("**/*", (route) => {
  const req=route.request(),url=new URL(req.url());
  if (["http:","https:"].includes(url.protocol) && (url.origin!==origin || !["GET","HEAD"].includes(req.method()))) {
    violations.push({url:url.origin+url.pathname,method:req.method()});return route.abort();
  }
  return route.continue();
});
await context.addInitScript({content:`if(location.protocol === 'http:' && location.hostname === '127.0.0.1'){(${installMeasurementHardware.toString()})({inputHz:100,detailed:false,maxFrames:30000,maxEvents:200000});}`});
await context.addInitScript(installPhase2AMediaGate);
const page=context.pages()[0] ?? await context.newPage();
await page.goto(origin+"/?analytics=off&mediaGate=before-close");
const server=createServer(async(req,res)=>{
  try {
    if(req.url==="/snapshot") {
      const value={url:page.url(),records:await readStoredTrainingRecords(page),gate:await page.evaluate(()=> (window as unknown as {__phase2aMediaGate:{snapshot():unknown}}).__phase2aMediaGate.snapshot()),violations};
      await writeFile(resolve(output,`snapshot-${Date.now()}.json`),JSON.stringify(value,null,2));res.end(JSON.stringify(value));
    } else if(req.url==="/release") {
      await page.evaluate(()=> (window as unknown as {__phase2aMediaGate:{release():void}}).__phase2aMediaGate.release());res.end("released test-only gate");
    } else if(req.url==="/close") {res.end("closing owned context");await context.close();server.close();}
    else {res.statusCode=404;res.end();}
  } catch(e){res.statusCode=500;res.end(String(e));}
});
server.listen(3139,"127.0.0.1");
console.log(JSON.stringify({ready:true,origin,url:page.url(),browserExecutable:chromium.executablePath(),output,control:"127.0.0.1:3139",profile:"owned, separate persistent context",fault:"test-only media close gate; real IDB/OPFS/MediaRecorder"}));
const timeout=setTimeout(async()=>{await context.close();server.close();},15*60*1000);timeout.unref();
process.once("SIGTERM",async()=>{await context.close();server.close();});
