// Controlled component/browser contract test. No live provider calls or private media.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProtocolClient } from "./cdp-client.mjs";
import { closeTestBrowser } from "./browser-lifecycle.mjs";

const port = Number(process.env.CLIMBIQ_COACHING_TEST_PORT ?? 9341);
const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const executable = process.env.CLIMBIQ_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const child = spawn(executable, ["--headless=new", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmpdir(), `climbiq-coaching-${Date.now()}`)}`], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let send;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await delay(100); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  ({ send } = createProtocolClient(socket));
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } throw new Error(`Timed out: ${expression}`); };
  await wait("!!document.querySelector('.upload-dropzone')");
  const status = await evaluate("fetch('/api/coaching?status=1').then(r=>r.json())");
  if (status.enabled !== false) throw new Error("This test requires hosted AI disabled; do not run it against a configured workspace.");
  await evaluate(`(async()=>{
    const {default:React} = await import('/node_modules/.vite/deps/react.js');
    const {default:{createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
    const {default:Panel} = await import('/src/components/CoachingReviewPanel.tsx');
    const {buildCoachingCatalog} = await import('/src/lib/coachingPolicy.ts');
    window.__calls=[]; window.__jumps=[]; window.__slow=false;
    const nativeFetch=window.fetch;
    window.fetch=async(input,init)=>{
      if(!String(input).startsWith('/api/coaching'))return nativeFetch(input,init);
      if(String(input).includes('status=1'))return Response.json({enabled:true});
      if(init?.method==='POST'){
        const body=JSON.parse(init.body);window.__calls.push(body);
        window.__record={id:'abcdefghijklmnopqrstu',status:'complete',packet:body.packet,plan:buildCoachingCatalog(body.packet).defaultPlan};
        if(window.__slow)await new Promise(r=>setTimeout(r,250));
        return Response.json(window.__record);
      }
      return Response.json(window.__record);
    };
    const markers=[['startSignal',9.4],['firstMovement',9.6],['hold10',15.9],['finishPad',21.655]];
    const s={id:'current',version:1,name:'Controlled UI fixture',climberName:'PRIVATE NAME',location:'PRIVATE GYM',notes:'PRIVATE NOTES',date:'2026-09-08',attemptType:'Training',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z',videoMetadata:null,zones:{},startLightCalibration:{},
      settings:{startSearchStart:0,startSearchEnd:12,startSensitivity:'medium',startLightVisibility:'clear',startDetectionProfile:'auto',reactionTimeOffset:0,startSignalOffset:0,movementSensitivity:'medium',firstMovementDefinition:'earliest',committedLaunchMinDelay:.08,firstMovementOffset:0,officialTotalTime:''},
      timestamps:markers.map(([id,rawTime])=>({id,label:id,rawTime,climbTime:null,confidence:'High',source:'Manual'}))};
    const host=document.createElement('main');host.id='coaching-harness';host.className='card';document.body.replaceChildren(host);
    createRoot(host).render(React.createElement(Panel,{getCurrentSession:()=>s,sessions:[{...s,id:'baseline',name:'Comparable fixture'}],onJump:t=>window.__jumps.push(t),disabled:false}));
  })()`);
  await wait("!!document.querySelector('.coaching-panel')");
  const click = async text => { await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`); await delay(40); };
  const text = () => evaluate("document.querySelector('.coaching-panel').innerText");
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await click("Review my run");
  check((await text()).includes("12.255s") && (await text()).includes("Bottom/top-half conclusions are withheld"), "Local facts or contact gate missing.");
  await click("View Start"); check((await evaluate("window.__jumps[0]")) === 9.4, "Evidence link did not preserve raw time.");
  await evaluate("document.querySelector('.coaching-hosted').open=true");
  check(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Prioritize with NIM').disabled"), "Hosted action lacks opt-in gate.");
  await evaluate(`(()=>{const input=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'workspace-test-code');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.coaching-hosted input[type=checkbox]').click()})()`);
  await delay(40); await click("Prioritize with NIM");
  await wait("document.body.innerText.includes('AI-prioritized review')");
  check(!JSON.stringify(await evaluate("window.__calls")).match(/PRIVATE|rawTime|location|notes/), "Private metadata reached mocked API.");
  check((await text()).includes("What this review can establish"), "Model selection hid mandatory limits.");
  await click("Load saved review");
  await wait("document.body.innerText.includes('Saved numeric review')");
  check(await evaluate("!document.querySelector('.coaching-result button')"), "Archived record has local-video seek links.");
  await evaluate(`(()=>{const select=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'start');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait("!document.querySelector('.coaching-result')");
  await click("Review my run"); await evaluate("window.__slow=true"); await click("Prioritize with NIM");
  await evaluate(`(()=>{const select=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'halves');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await delay(350);
  check(await evaluate("!document.querySelector('.coaching-result')"), "A stale in-flight response restored old evidence.");
  await click("Review my run");
  await mkdir('test-results',{recursive:true});
  for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+2"), `${name} overflows horizontally.`);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(`test-results/coaching-${name}.png`,Buffer.from(shot.data,'base64'));
  }
  console.log(JSON.stringify({passed:true,localFacts:true,contactGate:true,sourceLinks:true,optIn:true,privateMetadataExcluded:true,mandatoryLimits:true,archivedLinksWithheld:true,staleResponseRejected:true,responsive:true,provider:'mocked; no live NIM call'},null,2));
} finally { await closeTestBrowser(child,send); }
