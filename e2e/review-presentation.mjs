import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Optional real-video presentation checks; screenshots stay in ignored local output.
export async function verifyReviewPresentation({evaluate,send}) {
  const readMarkers = `JSON.stringify([...document.querySelectorAll('tbody tr')].map(r=>r.textContent))`;
  const before=await evaluate(readMarkers);
  const fileName=await evaluate(`document.querySelector('.upload-copy strong').textContent.trim()`);
  const prefix=fileName.replace(/[^a-zA-Z0-9_-]/g,'_');
  const screenshots=[];
  await mkdir('test-results',{recursive:true});
  const snapshot = async (selector,name) => {
    const clip=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
      return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1};})()`);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
    const target=path.resolve('test-results',`review-presentation-${prefix}-${name}.png`);
    await writeFile(target,Buffer.from(shot.data,'base64'));screenshots.push(target);
  };
  try {
    for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});
      await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const layout=await evaluate(`(()=>{
        const plot=document.querySelector('.wall-map-background').getBoundingClientRect();
        const strip=document.querySelector('.hold10-evidence-frames');
        return {aspect:plot.width/plot.height,overflow:document.documentElement.scrollWidth>innerWidth+2,
          images:[...strip.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0),
          gaps:document.querySelectorAll('.speed-missing-interval').length,
          quality:document.querySelector('.velocity-chart-figure .chart-quality-note')?.textContent};
      })()`);
      if (Math.abs(layout.aspect-.2)>.001 || layout.overflow || !layout.images || !layout.quality)
        throw new Error(`Review presentation failed at ${name}: ${JSON.stringify(layout)}`);
      await snapshot('.hold10-second-pass',`${name}-hold10`);
      await snapshot('.biomechanics-visual-grid',`${name}-charts`);
    }
    const targets=await evaluate(`[...document.querySelectorAll('.hold10-evidence-frames button')]
      .map((b,index)=>({index,time:Number(b.dataset.rawTime),label:b.textContent}))
      .filter((b,index)=>index===0||b.label.includes('Closer estimate')||b.label.includes('Broad cursor'))`);
    for (const target of targets) {
      await evaluate(`document.querySelectorAll('.hold10-evidence-frames button')[${target.index}].click()`);
      let ready=false;
      for(let i=0;i<100;i++) {
        ready=await evaluate(`(()=>{const v=document.querySelector('video');return !v.seeking&&Math.abs(v.currentTime-${target.time})<.04;})()`);
        if(ready)break;
        await new Promise(r=>setTimeout(r,50));
      }
      if(!ready)throw new Error('Filmstrip did not navigate to its captioned source frame.');
      if(await evaluate(readMarkers)!==before)throw new Error('Filmstrip navigation changed a timing marker.');
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Close review').click()`);
    }
    return {passed:true,screenshots,navigationPreservedMarkers:true,equalMetricScale:true};
  } finally {
    await send('Emulation.clearDeviceMetricsOverride');
  }
}
