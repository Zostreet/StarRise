const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const C=require('./css/creator-studio-core-v2.js'),A=require('./css/studio-audio.js'),P=require('./css/studio-package.js');
test('older projects restore safe production defaults and reject arbitrary plug-in code',()=>{
  const p=C.createProject('legacy');delete p.production;delete p.collaboration;p.recording.tracks=[{id:'voice',seconds:5}];
  const restored=C.normalizeProject(p);assert.equal(restored.production.sampleRate,48000);assert.equal(restored.production.format,'pcm24');assert.equal(restored.recording.tracks[0].fx.enabled,false);
  restored.production.masterFx={enabled:true,highpass:Infinity,feedback:100,ratio:-1,pluginCode:'execute me'};restored.collaboration={sessionId:'untrusted-url',baseVersionId:'00000000-0000-0000-0000-000000000001'};
  const safe=C.normalizeProject(restored);assert.equal(safe.production.masterFx.highpass,20);assert.equal(safe.production.masterFx.feedback,.75);assert.equal(safe.production.masterFx.ratio,1);assert.equal(safe.production.masterFx.pluginCode,undefined);assert.equal(safe.collaboration.sessionId,'');assert.ok(safe.collaboration.baseVersionId);
});
test('24-bit PCM preserves samples smaller than the 16-bit quantization step',()=>{
  const samples=new Float32Array([-1,1,.00001,-.00001,NaN,2]);const data=C.wavBytes([samples],48000,'pcm24'),v=new DataView(data),b=Buffer.from(data);
  assert.equal(v.getUint16(20,true),1);assert.equal(v.getUint16(34,true),24);assert.equal(v.getUint16(32,true),3);assert.equal(v.getUint32(28,true),144000);assert.equal(v.getUint32(40,true),18);assert.equal(v.getUint32(4,true),data.byteLength-8);
  assert.equal(b.readIntLE(44,3),-8388608);assert.equal(b.readIntLE(47,3),8388607);assert.equal(b.readIntLE(50,3),84);assert.equal(b.readIntLE(53,3),-84);assert.equal(b.readIntLE(56,3),0);assert.equal(b.readIntLE(59,3),8388607);
  assert.equal(new DataView(C.wavBytes([samples],48000)).getInt16(48,true),0);
});
test('32-bit float WAV preserves headroom, has a fact chunk, and sanitizes nonfinite values',()=>{
  const data=C.wavBytes([new Float32Array([1.5,-2,NaN]),new Float32Array([.25,.5,Infinity])],44100,'float32'),v=new DataView(data),b=Buffer.from(data);
  assert.equal(v.getUint16(20,true),3);assert.equal(v.getUint16(34,true),32);assert.equal(v.getUint16(22,true),2);assert.equal(b.subarray(36,40).toString(),'fact');assert.equal(v.getUint32(44,true),3);assert.equal(b.subarray(48,52).toString(),'data');assert.equal(v.getUint32(52,true),24);
  assert.deepEqual(Array.from({length:6},(_,i)=>v.getFloat32(56+i*4,true)),[1.5,.25,-2,.5,0,0]);assert.equal(v.getUint32(4,true),data.byteLength-8);
  assert.throws(()=>C.wavBytes([new Float32Array(1)],48000,'plugin'),/format/);
});
test('trims, fades and effect tails stay bounded for tiny and reversed regions',()=>{
  assert.deepEqual(A.region({trimStart:1,trimEnd:4,fade:9},5),{start:1,end:4,seconds:3,fade:1.5});const tiny=A.region({trimStart:9,trimEnd:-1,fade:1},.0002);assert.equal(tiny.end,.0002);assert.ok(tiny.start>=0);assert.ok(tiny.fade<=tiny.seconds/2);
  assert.equal(A.tail({enabled:false,reverb:60,decay:5}),0);assert.equal(A.tail({enabled:true,reverb:50,decay:2}),2);assert.ok(A.tail({enabled:true,delay:50,feedback:.75,delayTime:1.5})<=12);assert.throws(()=>A.region({},0),/playable/);
  assert.equal(A.frames(2,48000,2),96000);assert.throws(()=>A.frames(3600,48000,2),/memory/);
});
test('reverb is deterministic stereo and saturation is finite, odd and monotonic',()=>{
  const a=A.impulseChannels(8000,.2),b=A.impulseChannels(8000,.2);assert.deepEqual(a,b);assert.notDeepEqual(a[0],a[1]);assert.equal(a[0].length,1600);assert.ok(Math.abs(a[0].at(-1))<1e-8);
  const curve=A.curve(70);for(let i=0;i<curve.length;i++){assert.ok(Number.isFinite(curve[i]));assert.ok(Math.abs(curve[i]+curve[curve.length-1-i])<1e-6);if(i)assert.ok(curve[i]>=curve[i-1]);}assert.equal(curve[0],-1);assert.equal(curve.at(-1),1);
});
test('sample peak and RMS correctly report clipping and silent samples',()=>{
  const result=A.meterSamples([new Float32Array([.5,-.5,NaN])]);assert.ok(Math.abs(result.peakDb+6.0206)<.001);assert.ok(Math.abs(result.rmsDb+6.0206)<.001);assert.equal(result.clipped,0);
  assert.equal(A.meterSamples([new Float32Array([1,-1,1.5])]).clipped,3);assert.equal(A.meterSamples([new Float32Array(3)]).peakDb,-Infinity);
});
test('effect bypass and enable do not double the initial dry signal',()=>{
  const param=()=>({value:0,cancelScheduledValues(){},setTargetAtTime(value){this.value=value;}}),nodes=[];
  const node=()=>{const n={connect(){},disconnect(){},gain:param(),frequency:param(),Q:param(),threshold:param(),ratio:param(),attack:param(),release:param(),knee:param(),delayTime:param()};nodes.push(n);return n;};
  const context={currentTime:0,sampleRate:8000,createGain:node,createBiquadFilter:node,createDynamicsCompressor:node,createWaveShaper:node,createConvolver:node,createDelay:node,createBuffer:(channels,length)=>({copyToChannel(){},length,numberOfChannels:channels})};
  const fx=A.buildFx(context,C.fxDefaults());assert.equal(nodes[2].gain.value,1);assert.equal(nodes[3].gain.value,0);fx.set({enabled:true});assert.equal(nodes[2].gain.value,0);assert.equal(nodes[3].gain.value,1);fx.disconnect();
});
test('ZIP can be extracted by an independent reader with exact originals, UTF8 and valid CRCs',async()=>{
  const original=Buffer.from([0,255,10,13,128,7]),zip=await P.zip([{name:'originals/voice.wav',data:new Blob([original])},{name:'notes/café.txt',data:'Artist notes\noriginal text'}]);
  assert.equal(P.crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'starrise-zip-'));const archive=path.join(directory,'session.zip');fs.writeFileSync(archive,Buffer.from(await zip.arrayBuffer()));
  try{execFileSync('python3',['-c',"import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('originals/voice.wav') == bytes([0,255,10,13,128,7]); assert z.read('notes/café.txt').decode() == 'Artist notes\\noriginal text'",archive]);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('ZIP refuses unsafe paths and keeps source file extensions',async()=>{
  for(const name of ['../voice.wav','/voice.wav','folder\\voice.wav'])await assert.rejects(P.zip([{name,data:'x'}]),/Unsafe/);
  assert.equal(A.extension(new Blob([],{type:'audio/mpeg'}),'demo.MP3'),'mp3');assert.equal(A.extension(new Blob([],{type:'audio/flac'}),''),'flac');
});
