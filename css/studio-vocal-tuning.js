(function(root,factory){"use strict";const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StarRiseVocalTuning=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  // YIN-style difference / cumulative-mean pitch detection; time-domain,
  // pitch-synchronous overlap/add resynthesis. No licensed plug-in binaries.
  const SCALES={chromatic:[0,1,2,3,4,5,6,7,8,9,10,11],major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],pentatonic:[0,2,4,7,9]};
  const clamp=(v,lo,hi,fallback)=>Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):fallback;
  function targetNote(midi,key=0,scale="chromatic"){let best=0,distance=Infinity;for(let note=Math.floor(midi)-12;note<=Math.ceil(midi)+12;note++)if((SCALES[scale]||SCALES.chromatic).includes(((note-key)%12+12)%12)){const d=Math.abs(note-midi);if(d<distance){distance=d;best=note;}}return best;}
  function detect(frame,rate){
    let energy=0;for(const x of frame)energy+=x*x;if(energy/frame.length<.000012)return null;
    const size=Math.floor(frame.length/2),lo=Math.max(2,Math.floor(rate/1000)),hi=Math.min(size-2,Math.ceil(rate/70)),difference=new Float64Array(hi+1);let sum=0,tau=0;
    for(let t=1;t<=hi;t++){let d=0;for(let i=0;i<size;i++){const delta=frame[i]-frame[i+t];d+=delta*delta;}sum+=d;difference[t]=sum?d*t/sum:1;}
    for(let t=lo;t<hi;t++)if(difference[t]<.16){while(t+1<hi&&difference[t+1]<difference[t])t++;tau=t;break;}
    if(!tau)return null;const left=difference[tau-1],center=difference[tau],right=difference[tau+1],denominator=2*(2*center-left-right),refined=tau+(denominator?(right-left)/denominator:0),frequency=rate/refined;
    return frequency>=70&&frequency<=1000?{frequency,confidence:1-center}:null;
  }
  function process(channels,rate,options={},progress=()=>{}){
    if(!Array.isArray(channels)||channels.length<1||channels.length>2||!channels[0]?.length||channels.some(c=>!(c instanceof Float32Array)||c.length!==channels[0].length)||!Number.isFinite(rate)||rate<8000||rate>192000)throw new Error("Tuning needs equal-length mono or stereo audio.");
    const length=channels[0].length;if(length/rate>300||length*channels.length*4>96*1024*1024)throw new Error("Tune a vocal source up to five minutes, or split a longer recording into separate takes.");
    const strength=clamp(options.strength,0,100,85)/100,transpose=clamp(options.transpose,-12,12,0),speed=clamp(options.speed,0,100,70),key=Math.round(clamp(options.key,0,11,0)),scale=SCALES[options.scale]?options.scale:"chromatic";
    const out=channels.map(c=>Float32Array.from(c,x=>Number.isFinite(x)?x:0));if(!options.enabled||(!strength&&!transpose))return {channels:out,voicedFrames:0,changedFrames:0,totalFrames:0};
    const factor=Math.max(1,Math.round(rate/8000)),analysisRate=rate/factor,mono=new Float32Array(Math.ceil(length/factor));for(let i=0;i<mono.length;i++){let sum=0,count=0;for(let j=i*factor;j<Math.min(length,(i+1)*factor);j++)for(const channel of out){sum+=channel[j];count++;}mono[i]=count?sum/count:0;}
    const hop=Math.round(analysisRate*.02),window=512,frames=[],smoothing=.004+(1-speed/100)*.15;let smoothed=0,voicedFrames=0,changedFrames=0;
    for(let at=0;at<mono.length;at+=hop){const frame=new Float32Array(window);for(let i=0;i<window;i++)frame[i]=mono[at+i-window/2]||0;const pitch=detect(frame,analysisRate);let ratio=1;if(pitch){const midi=69+12*Math.log2(pitch.frequency/440),correction=(targetNote(midi,key,scale)-midi)*strength+transpose;smoothed+=(correction-smoothed)*(1-Math.exp(-.02/smoothing));ratio=Math.pow(2,smoothed/12);voicedFrames++;if(Math.abs(smoothed)>.02)changedFrames++;}else smoothed=0;frames.push({at:at*factor,period:pitch?rate/pitch.frequency:0,ratio});if(frames.length%50===0)progress(.45*at/mono.length);}
    if(!changedFrames){progress(1);return {channels:out,voicedFrames,changedFrames,totalFrames:frames.length};}
    const wet=channels.map(()=>new Float32Array(length)),weights=new Float32Array(length),segments=[];let begin=-1;for(let i=0;i<=frames.length;i++){if(frames[i]?.period){if(begin<0)begin=i;}else if(begin>=0){if((i-begin)*.02>=.06)segments.push([begin,i-1]);begin=-1;}}
    const frameAt=at=>frames[Math.max(0,Math.min(frames.length-1,Math.round(at/(hop*factor))))];
    for(let segment=0;segment<segments.length;segment++){
      const [first,last]=segments[segment],start=Math.max(0,frames[first].at),end=Math.min(length,frames[last].at+hop*factor),marks=[];let mark=start+frames[first].period;
      while(mark<end){const f=frameAt(mark),period=f.period||frames[first].period,radius=Math.max(2,Math.floor(period*.18));let chosen=Math.round(mark),peak=-Infinity;for(let i=Math.max(start,Math.round(mark)-radius);i<=Math.min(end-1,Math.round(mark)+radius);i++){let sum=0;for(const channel of out)sum+=channel[i];if(sum>peak){peak=sum;chosen=i;}}marks.push({at:chosen,period});mark=chosen+period;}
      if(marks.length<3)continue;let index=0,target=marks[0].at;
      while(target<end){while(index+1<marks.length&&Math.abs(marks[index+1].at-target)<Math.abs(marks[index].at-target))index++;const source=marks[index],period=source.period,half=Math.max(2,Math.round(period)),center=Math.round(target);for(let j=-half;j<=half;j++){const dest=center+j,src=source.at+j;if(dest<start||dest>=end||src<0||src>=length)continue;const weight=.5+.5*Math.cos(Math.PI*j/half);weights[dest]+=weight;for(let c=0;c<wet.length;c++)wet[c][dest]+=out[c][src]*weight;}const f=frameAt(target),ratio=f.period?f.ratio:1;target+=period/Math.max(.45,Math.min(2.3,ratio));}
      const fade=Math.min(rate*.025,(end-start)/3);for(let i=start;i<end;i++){if(weights[i]<=.02)continue;const blend=Math.min(1,(i-start)/fade,(end-1-i)/fade,weights[i]/.5);for(let c=0;c<out.length;c++){const value=wet[c][i]/weights[i];out[c][i]=Number.isFinite(value)?out[c][i]*(1-blend)+value*blend:out[c][i];}}
      progress(.45+.55*(segment+1)/Math.max(1,segments.length));
    }
    progress(1);return {channels:out,voicedFrames,changedFrames,totalFrames:frames.length};
  }
  return {SCALES,targetNote,detect,process};
});
