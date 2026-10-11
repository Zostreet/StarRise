(function(root,factory){"use strict";const api=factory(typeof module==="object"&&module.exports?require("./creator-studio-core-v2.js"):root.StarRiseStudioCore);if(typeof module==="object"&&module.exports)module.exports=api;else root.StarRiseStudioAudio=api;})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";
  function curve(amount){const n=4097,out=new Float32Array(n),drive=1+amount/100*12,scale=Math.tanh(drive);for(let i=0;i<n;i++){const x=i/(n-1)*2-1;out[i]=amount?Math.tanh(x*drive)/scale:x;}return out;}
  function impulseChannels(rate,seconds){
    const length=Math.ceil(rate*seconds),channels=[new Float32Array(length),new Float32Array(length)];let seed=918273;
    for(let c=0;c<2;c++)for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;channels[c][i]=(seed/4294967296*2-1)*Math.pow(1-i/length,3);}
    return channels;
  }
  function tail(raw){const f=C.normalizeFx(raw);if(!f.enabled)return 0;return Math.max(f.reverb?f.decay:0,f.delay?(f.feedback?Math.min(12,f.delayTime*Math.ceil(Math.log(.001)/Math.log(f.feedback))):f.delayTime):0);}
  function region(track,duration){if(!Number.isFinite(duration)||duration<=0)throw new Error("The audio source has no playable samples.");const minimum=Math.min(.001,duration),start=Math.max(0,Math.min(duration-minimum,Number(track.trimStart)||0));const end=Math.max(start+minimum,Math.min(duration,Number(track.trimEnd)||duration));return {start,end,seconds:end-start,fade:Math.min(Math.max(0,Number(track.fade)||0),(end-start)/2)};}
  function frames(seconds,rate,channels){const count=Math.ceil(seconds*rate);if(!Number.isFinite(count)||count<1||count*channels*4>128*1024*1024)throw new Error("This audio render exceeds the browser's memory limit. Split a long session into shorter projects or use the original source files in your studio.");return count;}
  function buildFx(context,raw){
    let settings=C.normalizeFx(raw),lastDecay=0,initialized=false;const nodes=[];const gain=()=>{const n=context.createGain();nodes.push(n);return n;};
    const input=gain(),output=gain(),bypass=gain(),active=gain();input.connect(bypass);bypass.connect(output);input.connect(active);
    const highpass=context.createBiquadFilter(),low=context.createBiquadFilter(),mid=context.createBiquadFilter(),high=context.createBiquadFilter();nodes.push(highpass,low,mid,high);
    highpass.type="highpass";low.type="lowshelf";low.frequency.value=160;mid.type="peaking";mid.frequency.value=1200;mid.Q.value=.9;high.type="highshelf";high.frequency.value=8000;
    active.connect(highpass);highpass.connect(low);low.connect(mid);mid.connect(high);
    const compressor=context.createDynamicsCompressor(),shape=context.createWaveShaper(),makeup=gain();nodes.push(compressor,shape);shape.oversample="4x";high.connect(compressor);compressor.connect(makeup);makeup.connect(shape);
    const dry=gain(),reverbWet=gain(),delayWet=gain(),feedback=gain();const convolver=context.createConvolver(),delay=context.createDelay(1.5),damping=context.createBiquadFilter();nodes.push(convolver,delay,damping);damping.type="lowpass";damping.frequency.value=5500;
    shape.connect(dry);dry.connect(output);shape.connect(convolver);convolver.connect(reverbWet);reverbWet.connect(output);shape.connect(delay);delay.connect(damping);damping.connect(delayWet);delayWet.connect(output);damping.connect(feedback);feedback.connect(delay);
    function set(raw){settings=C.normalizeFx(raw);const f=settings;const at=context.currentTime;const param=(p,v)=>{p.cancelScheduledValues(at);if(initialized)p.setTargetAtTime(v,at,.01);else p.value=v;};
      param(bypass.gain,f.enabled?0:1);param(active.gain,f.enabled?1:0);param(highpass.frequency,f.highpass);param(low.gain,f.low);param(mid.gain,f.mid);param(high.gain,f.high);
      param(compressor.threshold,f.compressor?f.threshold:0);param(compressor.ratio,f.compressor?f.ratio:1);compressor.knee.value=6;param(compressor.attack,f.attack/1000);param(compressor.release,f.release/1000);param(makeup.gain,Math.pow(10,f.makeup/20));shape.curve=curve(f.saturation);
      dry.gain.value=1;param(reverbWet.gain,f.reverb/100);param(delayWet.gain,f.delay/100);param(delay.delayTime,f.delayTime);param(feedback.gain,f.feedback);
      if(lastDecay!==f.decay){const channels=impulseChannels(context.sampleRate,f.decay);const b=context.createBuffer(2,channels[0].length,context.sampleRate);channels.forEach((samples,i)=>b.copyToChannel(samples,i));convolver.buffer=b;lastDecay=f.decay;}initialized=true;
    }
    set(settings);return {input,output,set,disconnect:()=>nodes.forEach(n=>n.disconnect()),get settings(){return settings;}};
  }
  function meterSamples(channels){let peak=0,sum=0,count=0,clipped=0;for(const samples of channels)for(const s of samples){if(!Number.isFinite(s))continue;peak=Math.max(peak,Math.abs(s));sum+=s*s;count++;if(Math.abs(s)>=1)clipped++;}const rms=count?Math.sqrt(sum/count):0;return {peak,peakDb:peak?20*Math.log10(peak):-Infinity,rmsDb:rms?20*Math.log10(rms):-Infinity,clipped};}
  function extension(blob,name){const matched=String(name||"").match(/\.([a-z\d]{1,6})$/i);if(matched)return matched[1].toLowerCase();return ({"audio/wav":"wav","audio/x-wav":"wav","audio/mpeg":"mp3","audio/mp4":"m4a","audio/ogg":"ogg","audio/flac":"flac"})[blob.type]||"audio";}
  return {curve,impulseChannels,tail,region,frames,buildFx,meterSamples,extension};
});
