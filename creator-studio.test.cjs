const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('./css/creator-studio-core-v3.js');

test('projects restore all rooms, original text and recording metadata without extra properties',()=>{
  const p=C.createProject('project-1','Original session','2026-10-11T05:00:00Z');
  p.song.sections[0].text='<script>original lyrics, rendered as text</script>';
  p.recording.tracks=[{id:'take-1',name:'Vocal',start:.15,seconds:12.5,volume:73,pan:-.2,muted:false,trimStart:0,trimEnd:0,fade:.01,fx:C.fxDefaults(),tuning:C.tuningDefaults()}];
  const input=JSON.parse(JSON.stringify(p));input.untrusted='<iframe>';input.__proto__={polluted:true};
  const restored=C.normalizeProject(input);
  assert.deepEqual(restored,p);assert.equal(restored.untrusted,undefined);assert.equal({}.polluted,undefined);
  assert.match(C.songText(restored),/<script>original lyrics/);
});
test('malformed pattern dimensions and duplicate recording identities cannot enter a project',()=>{
  const p=C.createProject('project-2');p.beat.patterns.A[0].pop();assert.throws(()=>C.normalizeProject(p),/six tracks/);
  const q=C.createProject('project-3');q.recording.tracks=[{id:'same'},{id:'same'}];assert.throws(()=>C.normalizeProject(q),/unique/);
  const r=C.createProject('project-4');r.art.layers[0].image='https://outside.example/track.png';assert.throws(()=>C.normalizeProject(r),/embedded PNG/);
  assert.throws(()=>C.normalizeProject({version:2,id:'future'}),/supported/);
});
test('imported numeric controls are finite and bounded without changing creative text',()=>{
  const p=C.createProject('project-5');p.beat.bpm=10000;p.beat.swing=-9;p.beat.patterns.A[0][0]=Infinity;p.recording.master=NaN;p.stage.minutes=-2;
  const r=C.normalizeProject(p);assert.equal(r.beat.bpm,220);assert.equal(r.beat.swing,0);assert.equal(r.beat.patterns.A[0][0],0);assert.equal(r.recording.master,75);assert.equal(r.stage.minutes,.25);
});
test('swing delays odd steps but preserves bar and arrangement duration',()=>{
  const b=C.createProject('project-6').beat;b.bpm=120;b.swing=40;b.arrangement='AB';b.cycles=2;b.patterns.A=C.emptyPattern();b.patterns.B=C.emptyPattern();b.patterns.A[0][0]=1;b.patterns.A[0][1]=1;b.patterns.B[1][0]=.8;
  const plan=C.beatEvents(b);assert.equal(plan.duration,8);assert.deepEqual(plan.banks,['A','B','A','B']);
  assert.equal(plan.events.find(e=>e.track===0&&e.step===1).time,.175);assert.equal(plan.events.find(e=>e.bank==='B').time,2);assert.equal(plan.events.length,6);
});
test('muted tracks and stem exports use the same arrangement and exclude other drums',()=>{
  const b=C.createProject('project-7').beat;const original=C.beatEvents(b);assert.ok(original.events.some(e=>e.track===1));b.tracks[1].muted=true;
  assert.ok(C.beatEvents(b).events.every(e=>e.track!==1));const stem=C.beatEvents(b,0);assert.ok(stem.events.length);assert.ok(stem.events.every(e=>e.track===0));assert.equal(stem.duration,original.duration);
});
test('stereo PCM WAV has correct sizes, interleaving, clipping and non-finite handling',()=>{
  const a=new Float32Array([-1,0,1,2,NaN]),b=new Float32Array([1,.5,-1,-2,0]);const data=C.wavBytes([a,b],44100),view=new DataView(data);
  assert.equal(Buffer.from(data).subarray(0,4).toString(),'RIFF');assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint32(24,true),44100);assert.equal(view.getUint32(40,true),20);assert.equal(data.byteLength,64);
  assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(46,true),32767);assert.equal(view.getInt16(50,true),16384);assert.equal(view.getInt16(56,true),32767);assert.equal(view.getInt16(58,true),-32768);assert.equal(view.getInt16(60,true),0);
  assert.throws(()=>C.wavBytes([a,b.subarray(1)],44100),/equal-length/);
});
test('audio trim stays inside the source and constrains fades at changed speed',()=>{
  assert.deepEqual(C.trimSettings({start:1,end:3,rate:2,volume:50,fade:2},4),{start:1,end:3,rate:2,seconds:1,volume:.5,fade:.5});
  const p=C.trimSettings({start:9,end:-2,rate:1,volume:200,fade:-1},2);assert.equal(p.start,1.99);assert.equal(p.end,2);assert.equal(p.volume,1);assert.equal(p.fade,0);
});
test('shot list CSV escapes quotes, keeps line breaks and neutralizes formulas',()=>{
  assert.equal(C.csvCell(' =HYPERLINK("x")'),'"\' =HYPERLINK(""x"")"');assert.equal(C.csvCell('a\nb'),'"a\nb"');
  const p=C.createProject('project-8');p.story.scenes[0].title='@evil';assert.match(C.shotCsv(p),/"'@evil"/);assert.match(C.scriptText(p),/DIALOGUE \/ VOICEOVER/);
});

function recorderHarness(){
  let Recorder;const messages=[];
  class Processor{constructor(){this.port={postMessage:message=>messages.push(message),onmessage:null};}}
  const context=vm.createContext({AudioWorkletProcessor:Processor,Float32Array,currentFrame:0,registerProcessor:(name,type)=>{assert.equal(name,'starrise-recorder');Recorder=type;}});
  vm.runInContext(fs.readFileSync(require.resolve('./css/studio-recorder-worklet.js'),'utf8'),context);
  return {recorder:new Recorder(),messages,context};
}
test('recording discards count-in, folds stereo to mono, and produces no live monitor output',()=>{
  const {recorder,messages,context}=recorderHarness();recorder.port.onmessage({data:{type:'start',startFrame:2}});
  const output=new Float32Array([9,9,9,9]);recorder.process([[new Float32Array([.1,.2,.6,.8]),new Float32Array([.1,.2,.2,.4])]],[ [output] ]);
  assert.deepEqual(Array.from(output),[0,0,0,0]);recorder.port.onmessage({data:{type:'stop'}});
  assert.equal(messages[0].type,'samples');assert.equal(messages[0].samples.length,2);assert.ok(Math.abs(messages[0].samples[0]-.4)<1e-6);assert.ok(Math.abs(messages[0].samples[1]-.6)<1e-6);assert.equal(messages[1].type,'done');
  context.currentFrame=4;recorder.process([[new Float32Array([1,1])]],[ [new Float32Array(2)] ]);assert.equal(messages.length,2);
});
test('recording flushes a full chunk and the final partial chunk exactly once',()=>{
  const {recorder,messages}=recorderHarness();recorder.port.onmessage({data:{type:'start',startFrame:0}});
  const input=new Float32Array(8200);input.fill(.25);recorder.process([[input]],[ [new Float32Array(8200)] ]);assert.equal(messages.length,1);assert.equal(messages[0].samples.length,8192);
  recorder.port.onmessage({data:{type:'stop'}});assert.deepEqual(messages.map(x=>x.type),['samples','samples','done']);assert.equal(messages[1].samples.length,8);assert.equal(messages[1].samples[7],.25);
});
test('stopping before the count-in ends yields no phantom take',()=>{
  const {recorder,messages}=recorderHarness();recorder.port.onmessage({data:{type:'start',startFrame:100}});recorder.process([[new Float32Array([1,1,1])]],[ [new Float32Array(3)] ]);recorder.port.onmessage({data:{type:'stop'}});assert.deepEqual(messages.map(x=>x.type),['done']);
});
