/** Exercises real browser workers without modifying a user's browser profile. */
export async function verifyPoseWorkerContract(evaluate, { options, poseModule }) {
  return evaluate(`(async () => {
    const { analyzePoseVideo, PoseAnalysisCancelledError } = await import(${JSON.stringify(poseModule)});
    const { DEFAULT_BIOMECHANICS_SETTINGS } = await import('/src/lib/biomechanics.ts');
    const video = document.querySelector('#pose-benchmark-video');
    const NativeWorker = window.Worker, NativeOffscreenCanvas = window.OffscreenCanvas;
    const live = new Set(); let created = 0, terminated = 0, duplicateTerminations = 0;
    let cancelOn, controller, abortedAt, seenCancelTrigger;
    const cases = [];
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args); created++; live.add(worker);
      const terminate = worker.terminate.bind(worker), post = worker.postMessage.bind(worker);
      worker.terminate = () => { if (live.delete(worker)) terminated++; else duplicateTerminations++; terminate(); };
      worker.postMessage = (message, transfer) => {
        post(message, transfer);
        if (message.kind === cancelOn && !seenCancelTrigger) {
          seenCancelTrigger = true;
          setTimeout(() => { abortedAt=performance.now();controller.abort(); }, cancelOn === 'initialize' ? 0 : 10);
        }
      };
      return worker;
    }});
    async function run(mode, signal) {
      let selection;
      const result = await analyzePoseVideo({ video, ...${JSON.stringify(options)}, settings:DEFAULT_BIOMECHANICS_SETTINGS,
        executionMode:mode, signal, onBackendSelected:value=>{selection=value;} });
      return { selection, validFrames:result.metrics.validFrames, requestedFrames:result.metrics.requestedFrames };
    }
    try {
      for (const stage of ['initialize','detect']) {
        cancelOn=stage;seenCancelTrigger=false;abortedAt=undefined;controller=new AbortController();
        let cancelled=false;
        try { await run('worker',controller.signal); }
        catch(error) { if (!(error instanceof PoseAnalysisCancelledError)) throw error; cancelled=true; }
        if(!cancelled || !seenCancelTrigger || abortedAt===undefined) throw new Error('Worker cancellation case did not execute: '+stage);
        const cancellationLatencyMs=performance.now()-abortedAt;
        if(cancellationLatencyMs>250) throw new Error('Worker cancellation did not settle promptly: '+stage);
        if(live.size) throw new Error('Worker survived cancellation: '+stage);
        cases.push({stage,cancelled,cancellationLatencyMs,activeWorkers:live.size});
      }
      cancelOn=undefined;controller=undefined;
      const retry=await run('worker');
      if(retry.selection?.backend!=='worker' || !retry.validFrames || live.size) throw new Error('Fresh worker retry failed or leaked a worker.');
      const createdBeforeFallback=created;
      window.OffscreenCanvas=undefined;
      const fallback=await run('auto');
      if(fallback.selection?.backend!=='main-thread' || !fallback.validFrames || created!==createdBeforeFallback) throw new Error('Unsupported-worker fallback failed.');
      window.OffscreenCanvas=NativeOffscreenCanvas;
      const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="worker-src 'none'";document.head.append(policy);
      const cspFallback=await run('auto');
      if(cspFallback.selection?.backend!=='main-thread' || !cspFallback.selection?.fallbackReason || !cspFallback.validFrames) throw new Error('CSP-blocked worker did not fall back before processing.');
      if(created!==terminated || live.size || duplicateTerminations) throw new Error('Worker ownership/termination mismatch.');
      return {passed:true,cases,retry,fallback,cspFallback,created,terminated,activeWorkers:live.size,duplicateTerminations};
    } finally {
      window.Worker=NativeWorker;window.OffscreenCanvas=NativeOffscreenCanvas;
      for(const worker of live) worker.terminate();
    }
  })()`);
}
