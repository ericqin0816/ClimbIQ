// Controlled component/browser contract test. No live provider calls or private media.
import { mkdir, writeFile } from "node:fs/promises";
import { createProtocolClient } from "./cdp-client.mjs";
import { startTestBrowser } from "./test-browser.mjs";

const url = process.env.CLIMBIQ_E2E_URL ?? "http://127.0.0.1:5173/";
const browser = await startTestBrowser({ label: "coaching", port: Number(process.env.CLIMBIQ_COACHING_TEST_PORT ?? process.env.CLIMBIQ_E2E_PORT ?? 0) });
const port = browser.port;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let send, socket;
try {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
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
    const {default:ComparisonPanel} = await import('/src/components/AttemptComparisonPanel.tsx');
    const {buildCoachingCatalog} = await import('/src/lib/coachingPolicy.ts');
    window.__calls=[]; window.__jumps=[]; window.__slow=false; window.__statusCalls=0; window.__heldResponses=[];
    const nativeFetch=window.fetch;
    window.fetch=async(input,init)=>{
      if(!String(input).startsWith('/api/coaching'))return nativeFetch(input,init);
      if(String(input).includes('status=1')){window.__statusCalls++;return Response.json({enabled:true});}
      if(init?.method==='POST'){
        const body=JSON.parse(init.body);window.__calls.push(body);
        window.__record={id:'abcdefghijklmnopqrstu',status:'complete',packet:body.packet,plan:buildCoachingCatalog(body.packet).defaultPlan};
        if(window.__holdResponse)await new Promise(resolve=>window.__heldResponses.push(resolve));
        if(window.__slow)await new Promise(r=>setTimeout(r,250));
        if(window.__htmlResponse)return new Response('<html>Service unavailable</html>',{status:503});
        return Response.json(window.__record);
      }
      if(window.__holdGetResponse)await new Promise(resolve=>window.__heldResponses.push(resolve));
      return Response.json(window.__wrongReviewId?{...window.__record,id:'BBBBBBBBBBBBBBBBBBBBB'}:window.__record);
    };
    const markers=[['startSignal',9.4],['firstMovement',9.6],['hold10',15.9],['finishPad',21.655]];
    const s={id:'current',version:1,name:'Controlled UI fixture',climberName:'PRIVATE NAME',location:'PRIVATE GYM',notes:'PRIVATE NOTES',date:'2026-09-08',attemptType:'Training',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z',videoMetadata:null,zones:{},startLightCalibration:{},
      settings:{startSearchStart:0,startSearchEnd:12,startSensitivity:'medium',startLightVisibility:'clear',startDetectionProfile:'auto',reactionTimeOffset:0,startSignalOffset:0,movementSensitivity:'medium',firstMovementDefinition:'earliest',committedLaunchMinDelay:.08,firstMovementOffset:0,officialTotalTime:''},
      timestamps:markers.map(([id,rawTime])=>({id,label:id,rawTime,climbTime:null,confidence:'High',source:'Manual'}))};
    const host=document.createElement('main');host.id='coaching-harness';host.className='card';document.body.replaceChildren(host);
    const root=createRoot(host); window.__coachingSession=s;
    window.__coachingBaselines=[s,{...s,id:'baseline',name:'Comparable fixture'}];
    window.__renderCoachingHarness=(key='initial',canSeek=true,Component=Panel)=>root.render(React.createElement(Component,{key,getCurrentSession:()=>window.__coachingSession,sessions:window.__coachingBaselines,onJump:t=>window.__jumps.push(t),disabled:false,canSeek}));
    window.__renderComparisonHarness=sessions=>root.render(React.createElement(ComparisonPanel,{sessions}));
    window.__renderCoachingHarness();
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
  await evaluate("window.__holdGetResponse=true"); await click("Load saved review");
  await wait("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop waiting')");
  check(await evaluate("[...document.querySelectorAll('.coaching-hosted input:not([type=checkbox])')].every(input=>input.disabled)"), "Saved-review identity fields remain editable during a request.");
  await click("Stop waiting");
  await evaluate(`(()=>{const input=document.querySelector('.coaching-hosted label:last-of-type input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'BBBBBBBBBBBBBBBBBBBBB');input.dispatchEvent(new Event('input',{bubbles:true}));window.__holdGetResponse=false;window.__heldResponses.shift()()})()`);
  await delay(60);
  check(await evaluate("document.querySelector('.coaching-hosted label:last-of-type input').value==='BBBBBBBBBBBBBBBBBBBBB' && !document.body.innerText.includes('Saved numeric review')"), "A cancelled archive response replaced the edited review ID or loaded stale data.");
  await evaluate(`(()=>{const input=document.querySelector('.coaching-hosted label:last-of-type input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'abcdefghijklmnopqrstu');input.dispatchEvent(new Event('input',{bubbles:true}));window.__wrongReviewId=true})()`);
  await delay(40); await click("Load saved review");
  await wait("document.body.innerText.includes('does not match the requested saved review')");
  check(await evaluate("!document.body.innerText.includes('Saved numeric review') && document.querySelector('.coaching-hosted label:last-of-type input').value==='abcdefghijklmnopqrstu'"), "A mismatched archive response changed the displayed review or requested ID.");
  await evaluate("window.__wrongReviewId=false"); await click("Load saved review");
  await wait("document.body.innerText.includes('Saved numeric review')");
  check(await evaluate("!document.querySelector('.coaching-result button')"), "Archived record has local-video seek links.");
  await evaluate(`(()=>{const select=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'start');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait("!document.querySelector('.coaching-result')");
  await click("Review my run"); await evaluate("window.__slow=true"); await click("Prioritize with NIM");
  await evaluate(`(()=>{const select=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'halves');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await delay(350);
  check(await evaluate("!document.querySelector('.coaching-result')"), "A stale in-flight response restored old evidence.");

  // Recovery keeps local evidence and the idempotency key. The mock deliberately
  // ignores abort so an old response can arrive during the replacement request.
  await evaluate("window.__slow=false;window.__holdResponse=true");
  await click("Review my run"); await click("Prioritize with NIM");
  await wait("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop waiting')");
  const stoppedRequestId = await evaluate("window.__calls.at(-1).requestId");
  await click("Stop waiting");
  check((await text()).includes("Local evidence review") && (await text()).includes("Stopped waiting"), "Stopping the request lost local evidence or did not recover controls.");
  await click("Prioritize with NIM");
  check(await evaluate("window.__calls.at(-1).requestId") === stoppedRequestId, "Retrying after stop changed the generation request ID.");
  await evaluate("window.__heldResponses.shift()()"); await delay(60);
  check(await evaluate("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop waiting') && !document.body.innerText.includes('AI-prioritized review')"), "An old response interrupted the replacement request.");
  await evaluate("window.__holdResponse=false;window.__heldResponses.shift()()");
  await wait("document.body.innerText.includes('AI-prioritized review')");

  await click("Review my run");
  await evaluate("window.__holdResponse=true;window.__nativeSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>window.__nativeSetTimeout(fn,ms===35000?100:ms,...args)");
  await click("Prioritize with NIM");
  await wait("document.body.innerText.includes('took too long')");
  await evaluate("window.setTimeout=window.__nativeSetTimeout;window.__holdResponse=false;window.__htmlResponse=true;window.__heldResponses.shift()()");
  const timedOutRequestId = await evaluate("window.__calls.at(-1).requestId");
  check((await text()).includes("Local evidence review") && await evaluate("![...document.querySelectorAll('button')].find(b=>b.textContent==='Prioritize with NIM').disabled"), "A timed-out response lost local evidence or left the action disabled.");
  await click("Prioritize with NIM");
  await wait("document.body.innerText.includes('unreadable response')");
  check(await evaluate("window.__calls.at(-1).requestId") === timedOutRequestId, "Retrying after timeout changed the generation request ID.");
  check((await text()).includes("Local evidence review"), "An HTML error response hid the local review.");
  await evaluate("window.__htmlResponse=false"); await click("Prioritize with NIM");
  await wait("document.body.innerText.includes('AI-prioritized review')");
  check(await evaluate("window.__calls.at(-1).requestId") === timedOutRequestId, "Error recovery started a distinct generation request.");

  // Canonical baseline math is visible without the hosted service choosing it.
  await evaluate(`(()=>{
    window.__slow=false;
    window.__coachingSession={...window.__coachingSession,timestamps:window.__coachingSession.timestamps.map(m=>m.id==='hold10'?{...m,acceptanceMode:'frame-review'}:m)};
    const baseline={...window.__coachingSession,id:'baseline',name:'Earlier timed attempt',timestamps:window.__coachingSession.timestamps.map(m=>m.id==='hold10'?{...m,rawTime:16.9}:m.id==='finishPad'?{...m,rawTime:22.055}:m)};
    window.__coachingBaselines=[window.__coachingSession,baseline];window.__renderCoachingHarness('comparison');
  })()`);
  await wait("document.querySelectorAll('select')[1]?.textContent.includes('Earlier timed attempt')");
  check(await evaluate("document.querySelectorAll('select')[1].querySelector('option[value=current]').disabled"), "The current attempt is selectable as its own baseline.");
  await evaluate(`(()=>{const select=document.querySelectorAll('select')[1];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'baseline');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait("!!document.querySelector('.coaching-check input')");
  check(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Review my run').disabled"), "Baseline comparison lacks comparability confirmation.");
  await evaluate("document.querySelector('.coaching-check input').click()");
  await click("Review my run");
  check((await text()).includes("0.400s shorter overall"), "The supported total change was not prioritized.");
  check(await evaluate("document.querySelectorAll('.coaching-comparison tbody tr').length===3"), "Reviewed phase comparison rows are missing.");
  check((await text()).includes("section changes offset each other"), "Offsetting phase changes are not explained.");
  check(await evaluate("document.querySelector('.coaching-focus')?.textContent.includes('before Hold 10')"), "The largest measured section change did not become the next review.");
  check(await evaluate("document.querySelector('.coaching-review-tasks')?.textContent.includes('Check tracking')"), "Unfinished evidence checks were hidden by useful timing data.");
  await mkdir('test-results',{recursive:true});
  for (const width of [390, 320]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+2"), `Comparison overflows the page at ${width}px.`);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(`test-results/coaching-comparison-${width}.png`,Buffer.from(shot.data,'base64'));
  }

  // Equal intervals at different raw source times must not retain old seek links.
  const jumpsBefore = await evaluate("window.__jumps.length");
  await evaluate("window.__coachingSession={...window.__coachingSession,timestamps:window.__coachingSession.timestamps.map(m=>({...m,rawTime:m.rawTime+2}))}");
  await click("View Start");
  check(await evaluate("window.__jumps.length") === jumpsBefore, "Stale raw-video evidence could still seek the current recording.");
  check(await evaluate("!document.querySelector('.coaching-result')"), "A stale source review remained displayed.");

  await evaluate("window.__renderCoachingHarness('saved-offline',false)");
  await wait("!!document.querySelector('.coaching-panel') && !document.querySelector('.coaching-result')");
  await click("Review my run");
  check((await text()).includes("saved measurements are available offline"), "Saved evidence is not usable without video.");
  check(await evaluate("!document.querySelector('.coaching-result button')"), "Offline saved evidence exposes invalid video-seek controls.");

  // The numeric packet is unchanged when all raw times move. Identity checking
  // must still reject a hosted response for the prior source recording.
  await evaluate("document.querySelector('.coaching-hosted').open=true");
  await evaluate(`(()=>{const input=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'workspace-test-code');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.coaching-hosted input[type=checkbox]').click();window.__slow=true})()`);
  await delay(40); await click("Prioritize with NIM");
  await evaluate("window.__coachingSession={...window.__coachingSession,timestamps:window.__coachingSession.timestamps.map(m=>({...m,rawTime:m.rawTime+1}))}");
  await delay(350);
  check(await evaluate("!document.querySelector('.coaching-result')"), "A numerically identical response was attached to changed source evidence.");

  // Explicit lineage prevents edited copies from becoming performance gains.
  await evaluate(`(()=>{
    const current=window.__coachingSession;
    const copy={...current,id:'annotation-copy',attemptLineageId:current.id,name:'Edited annotation copy',timestamps:current.timestamps.map(m=>m.id==='finishPad'?{...m,rawTime:m.rawTime-.4}:m)};
    window.__coachingBaselines=[current,copy];window.__renderCoachingHarness('lineage',false);
  })()`);
  await wait("document.querySelector('option[value=\"annotation-copy\"]')?.disabled");
  check((await text()).includes("Another analysis of the same attempt") || await evaluate("document.querySelector('option[value=\"annotation-copy\"]').textContent.includes('Another analysis')"), "Edited copy is available as a performance baseline.");
  await evaluate("window.__renderComparisonHarness(window.__coachingBaselines)");
  await wait("!!document.querySelector('.comparison-details')");
  await evaluate("document.querySelector('.comparison-details').open=true");
  check(await evaluate("document.querySelector('.comparison-insight').textContent.includes('Annotation comparison only') && document.querySelector('.comparison-insight').textContent.includes('same attempt')"), "Main comparison interprets a known copy as performance change.");
  check(await evaluate("!document.querySelector('.comparison-row.gained,.comparison-row.lost') && document.querySelector('.comparison-delta')?.textContent.includes('Annotation difference')"), "Known copies lost diagnostic timing or retained gain/loss styling.");

  // Metadata overlap remains an honest ambiguity and needs a second confirmation.
  await evaluate(`(()=>{
    const metadata={fileName:'coincident.mp4',duration:120,videoWidth:640,videoHeight:480,metadataLoaded:true};
    window.__coachingSession={...window.__coachingSession,videoMetadata:metadata};
    const baseline={...window.__coachingSession,id:'ambiguous-baseline',attemptLineageId:undefined,name:'Independent recording with matching metadata',timestamps:window.__coachingSession.timestamps.map(m=>m.id==='finishPad'?{...m,rawTime:m.rawTime+.4}:m)};
    window.__coachingBaselines=[window.__coachingSession,baseline];window.__renderCoachingHarness('metadata-collision',false);
  })()`);
  await wait("!!document.querySelector('option[value=\"ambiguous-baseline\"]')");
  check(await evaluate("!document.querySelector('option[value=\"ambiguous-baseline\"]').disabled"), "Metadata alone incorrectly hard-blocked a distinct file.");
  await evaluate(`(()=>{const select=document.querySelectorAll('select')[1];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'ambiguous-baseline');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait("!!document.querySelector('.coaching-identity-check input')");
  await evaluate("document.querySelector('.coaching-panel > .coaching-check input').click()");
  check(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Review my run').disabled"), "General comparability bypassed distinct-attempt confirmation.");
  await evaluate("document.querySelector('.coaching-identity-check input').click()");
  await click("Review my run");
  check((await text()).includes('0.400s shorter overall'), "Confirmed independent recordings could not be compared.");
  check(await evaluate("document.querySelector('.coaching-result').textContent.includes('Rule: 0.100s')"), "Per-interval comparison rules are not shown.");

  await evaluate("window.__renderComparisonHarness(window.__coachingBaselines)");
  await wait("!!document.querySelector('.comparison-identity-check input')");
  await evaluate("document.querySelector('.comparison-details').open=true");
  check(await evaluate("!document.querySelector('.comparison-row.gained,.comparison-row.lost')"), "Main comparison bypasses the overlap confirmation.");
  await evaluate("document.querySelector('.comparison-identity-check input').click()");
  await wait("!!document.querySelector('.comparison-row.gained,.comparison-row.lost')");
  await evaluate("window.__coachingBaselines=window.__coachingBaselines.map(s=>({...s,updatedAt:'2027-01-01'}));window.__renderComparisonHarness(window.__coachingBaselines)");
  await wait("!document.querySelector('.comparison-identity-check input').checked");
  check(await evaluate("!document.querySelector('.comparison-row.gained,.comparison-row.lost')"), "A saved version change retained stale identity confirmation.");

  // Evaluate the packaged-app policy in a fresh module. All network is mocked;
  // this checks routing, not an actual iOS/WKWebView device.
  await evaluate(`(async()=>{
    const {Capacitor}=await import('/node_modules/.vite/deps/@capacitor_core.js');
    const native=Capacitor.isNativePlatform;Capacitor.isNativePlatform=()=>true;
    try {const {default:NativePanel}=await import('/src/components/CoachingReviewPanel.tsx?native-coaching-test');window.__nativeStatusCount=window.__statusCalls;window.__renderCoachingHarness('native',false,NativePanel);}
    finally {Capacitor.isNativePlatform=native;}
  })()`);
  await wait("!!document.querySelector('.coaching-panel') && !document.querySelector('.coaching-hosted')");
  await delay(100);
  check(await evaluate("window.__statusCalls===window.__nativeStatusCount"), "Packaged-app review checked a hosted API.");
  await click("Review my run");
  await mkdir('test-results',{recursive:true});
  for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth+2"), `${name} overflows horizontally.`);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(`test-results/coaching-${name}.png`,Buffer.from(shot.data,'base64'));
  }
  console.log(JSON.stringify({passed:true,localFacts:true,contactGate:true,sourceLinks:true,optIn:true,privateMetadataExcluded:true,mandatoryLimits:true,archivedLinksWithheld:true,staleResponseRejected:true,stoppedRequestRecovery:true,timeoutRecovery:true,unreadableResponseRecovery:true,sameRequestIdOnRetry:true,comparisonPriorities:true,offsettingPhases:true,offlineSavedReview:true,sourceIdentityGuard:true,duplicateLineageGuard:true,distinctAttemptConfirmation:true,annotationComparison:true,nativeNoHostedRequests:true,responsive:true,provider:'mocked; no live NIM call'},null,2));
} finally { try { await browser.close(send); } finally { socket?.close(); } }
