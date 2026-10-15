const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { IDBFactory } = require('fake-indexeddb');

const html = fs.readFileSync('studio.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// DOM and IndexedDB run independently of the page code. Only audio hardware
// and drawing are stubbed: these tests check session data and UI controls.
class AudioBufferStub {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.channels[channel]; }
  copyToChannel(samples, channel, offset = 0) { this.channels[channel].set(samples, offset); }
}

function page(indexedDB = new IDBFactory(), confirmation = true) {
  const { window, document } = parseHTML(html);
  const storage = new Map();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
  });
  window.indexedDB = indexedDB;
  window.confirm = () => confirmation;
  // linkedom omits the native select.value setter used by project restore.
  for (const [id,value] of [['countIn','4'],['exportFormat','pcm24'],['exportRate','44100'],['stemMode','dry']]) {
    Object.defineProperty(document.getElementById(id), 'value', {
      value, writable:true, configurable:true
    });
  }
  window.StarRiseStudioCore = require('./css/creator-studio-core-v3.js');
  window.StarRiseStudioPackage = require('./css/studio-package.js');
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    createBuffer(channels, length, rate) { return new AudioBufferStub(channels, length, rate); }
    async resume() {}
  };
  const context = vm.createContext({
    window, document, indexedDB, console, Blob, URL, Float32Array, Uint8Array,
    ArrayBuffer, DataView, btoa, atob, setTimeout, clearTimeout, queueMicrotask,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    }
  });
  vm.runInContext(script, context);
  return context;
}
const run = (context, code) => vm.runInContext(code, context);
const plain = value => JSON.parse(JSON.stringify(value));

function seed(context) {
  run(context, `
    const voice = getContext().createBuffer(2, 4, 48000);
    voice.copyToChannel(new Float32Array([0, .00001, -.7, 1.2]), 0);
    voice.copyToChannel(new Float32Array([.5, -.25, .125, 0]), 1);
    const lead = makeTrack('Lead 🎤', voice, 'vocal', .125);
    Object.assign(lead, {volume: .63, pan: -.4, eq: 3, compression: 35, reverb: 20, delay: 15});
    const sample = getContext().createBuffer(1, 3, 44100);
    sample.copyToChannel(new Float32Array([-.25, .75, -.125]), 0);
    pads[12].name = 'Recorded Sample 1'; pads[12].buffer = sample; pads[12].pattern[3] = true;
    $('projectName').value = 'A real saved session'; $('bpm').value = '92';
    renderTracks();
  `);
}

async function portable(context) {
  run(context, 'download = (blob, name) => { window.testDownload = {blob, name}; };');
  await run(context, '$(' + JSON.stringify('exportProject') + ').onclick()');
  return run(context, 'window.testDownload');
}

async function importText(context, text) {
  context.importEvent = { target: { files: [{ text: async () => text }], value: 'selected-file' } };
  await run(context, '$(' + JSON.stringify('importProject') + ').onchange(importEvent)');
}

test('Save and Load reopen all track and pad PCM, sample rates, and mix settings in a new page', async () => {
  const database = new IDBFactory(), first = page(database);
  seed(first);
  const expected = plain(run(first, 'projectToJSON(projectSnapshot())'));
  await run(first, '$(' + JSON.stringify('saveProject') + ').onclick()');
  assert.match(run(first, '$(' + JSON.stringify('status') + ').textContent'), /Saved on this device, including 1 audio tracks and 1 imported samples/);
  // Reload means a fresh JS context with none of the old in-memory audio.
  const reopened = page(database);
  assert.equal(run(reopened, 'tracks.length'), 0);
  await run(reopened, '$(' + JSON.stringify('loadProject') + ').onclick()');
  const actual = plain(run(reopened, 'projectToJSON(projectSnapshot())'));
  delete actual.savedAt; delete expected.savedAt;
  assert.deepEqual(actual, expected);
  assert.equal(run(reopened, 'nextTrackId'), 2);
});

test('portable project restores sample-exact stereo and imported pad audio on another device', async () => {
  const source = page(); seed(source);
  const output = await portable(source);
  assert.equal(output.name, 'A-real-saved-session-project.json');
  const text = await output.blob.text(), destination = page();
  await importText(destination, text);
  assert.equal(run(destination, '$(' + JSON.stringify('projectName') + ').value'), 'A real saved session');
  assert.deepEqual(Array.from(run(destination, 'tracks[0].buffer.getChannelData(0)')), Array.from(new Float32Array([0, .00001, -.7, 1.2])));
  assert.deepEqual(Array.from(run(destination, 'tracks[0].buffer.getChannelData(1)')), [.5, -.25, .125, 0]);
  assert.equal(run(destination, 'tracks[0].buffer.sampleRate'), 48000);
  assert.equal(run(destination, 'pads[12].buffer.sampleRate'), 44100);
  assert.equal(run(destination, 'pads[12].pattern[3]'), true);
  assert.match(run(destination, '$(' + JSON.stringify('status') + ').textContent'), /Full project imported with its audio/);
  assert.equal(destination.importEvent.target.value, '');
});

test('damaged or missing audio is rejected before replacing a current session', async () => {
  const source = page(); seed(source);
  const output = await portable(source), original = JSON.parse(await output.blob.text());
  for (const mutate of [
    data => { data.tracks[0].audio = null; },
    data => { data.tracks[0].audio.channels[0] = 'AA=='; },
    data => { data.tracks[0].pan = 100; },
    data => { data.pads[0].pattern = [true]; },
    data => { data.tracks[0].audio.channels[0] = '!!!!'; }
  ]) {
    const destination = page(); seed(destination);
    const expected = plain(run(destination, 'projectToJSON(projectSnapshot())'));
    const damaged = structuredClone(original); mutate(damaged);
    await importText(destination, JSON.stringify(damaged));
    const actual = plain(run(destination, 'projectToJSON(projectSnapshot())'));
    delete actual.savedAt; delete expected.savedAt;
    assert.deepEqual(actual, expected);
    assert.match(run(destination, '$(' + JSON.stringify('status') + ').textContent'), /Project action failed:/);
    assert.equal(run(destination, 'projectBusy'), false);
  }
});

test('an aborted save reports failure and keeps the previous committed audio', async () => {
  const context = page(); seed(context);
  await run(context, '$(' + JSON.stringify('saveProject') + ').onclick()');
  const before = await run(context, 'readProject()');
  const db = await run(context, 'openProjectDatabase()');
  const transaction = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = transaction(...args);
    if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
    return tx;
  };
  run(context, '$(' + JSON.stringify('projectName') + ').value = "Unsaved revision"');
  await run(context, '$(' + JSON.stringify('saveProject') + ').onclick()');
  const after = await run(context, 'readProject()');
  assert.equal(after.name, before.name);
  assert.deepEqual(after.tracks[0].audio, before.tracks[0].audio);
  assert.match(run(context, '$(' + JSON.stringify('status') + ').textContent'), /Project action failed:/);
  assert.equal(run(context, '$(' + JSON.stringify('saveProject') + ').disabled'), false);
});

test('unavailable storage keeps audio in-session and full-file backup still works', async () => {
  const context = page(); seed(context);
  context.window.indexedDB = undefined;
  await run(context, '$(' + JSON.stringify('saveProject') + ').onclick()');
  assert.match(run(context, '$(' + JSON.stringify('status') + ').textContent'), /Device storage is unavailable/);
  assert.equal(run(context, 'tracks.length'), 1);
  const output = await portable(context);
  assert.equal(JSON.parse(await output.blob.text()).tracks[0].audio.channels.length, 2);
});

test('older settings remain importable without removing current audio', async () => {
  const context = page(); seed(context);
  const legacy = plain(run(context, 'projectSettings()'));
  legacy.version = 1; delete legacy.format; legacy.name = 'Older session'; legacy.tracks[0].volume = .2;
  await importText(context, JSON.stringify(legacy));
  assert.equal(run(context, 'tracks[0].buffer.length'), 4);
  assert.equal(run(context, 'pads[12].buffer.length'), 3);
  assert.equal(run(context, 'tracks[0].volume'), .2);
  assert.match(run(context, '$(' + JSON.stringify('status') + ').textContent'), /backup contains no audio/);
});

test('declining project replacement keeps the current tracks and settings', async () => {
  const source = page(); seed(source);
  const output = await portable(source), destination = page(new IDBFactory(), false);
  seed(destination); run(destination, '$(' + JSON.stringify('projectName') + ').value = "Keep this one"');
  await importText(destination, await output.blob.text());
  assert.equal(run(destination, '$(' + JSON.stringify('projectName') + ').value'), 'Keep this one');
  assert.equal(run(destination, 'tracks.length'), 1);
  assert.match(run(destination, '$(' + JSON.stringify('status') + ').textContent'), /Import cancelled/);
});

test('mixer controls change actual track volume/mute and Remove works from the mixer', () => {
  const context = page(); seed(context);
  run(context, `
    const mixerVolume = $('mixerTracks').querySelector('input[data-setting="volume"]');
    mixerVolume.value = '.37'; mixerVolume.oninput({currentTarget: mixerVolume});
    const mixerMute = $('mixerTracks').querySelector('input[data-setting="mute"]');
    mixerMute.checked = true; mixerMute.onchange({currentTarget: mixerMute});
  `);
  assert.equal(run(context, 'tracks[0].volume'), .37);
  assert.equal(run(context, 'tracks[0].mute'), true);
  assert.equal(run(context, '$(' + JSON.stringify('recordTracks') + ').querySelector(\'input[data-setting="volume"]\').value'), '0.37');
  assert.equal(run(context, '$(' + JSON.stringify('recordTracks') + ').querySelector(\'input[data-setting="mute"]\').checked'), true);
  run(context, '[...$("mixerTracks").querySelectorAll("button")].find(b=>b.textContent==="Remove").onclick()');
  assert.equal(run(context, 'tracks.length'), 0);
});

test('all dry, reverb, and delay paths pass through track volume', () => {
  const context = page(); seed(context);
  const nodes = [];
  const node = () => {
    const value = { value: 0 };
    const result = { edges: [], gain: {...value}, frequency: {...value},
      threshold: {...value}, ratio: {...value}, attack: {...value},
      release: {...value}, pan: {...value}, delayTime: {...value},
      connect(target) { this.edges.push(target); return target; } };
    nodes.push(result); return result;
  };
  context.graph = { sampleRate: 8000, createBufferSource: node, createGain: node,
    createBiquadFilter: node, createDynamicsCompressor: node,
    createStereoPanner: node, createConvolver: node, createDelay: node,
    createBuffer: (channels, length, rate) => new AudioBufferStub(channels, length, rate) };
  context.output = { edges: [] };
  run(context, 'Object.assign(tracks[0], {volume:0, reverb:100, delay:100}); connectTrack(tracks[0], graph, output)');
  const volume = nodes.find(n => n.gain.value === 0 && n.edges.some(next => next.pan));
  assert.ok(volume, 'track-volume node exists');
  const reachable = (start, excluded) => {
    const queue = [start], visited = new Set();
    while (queue.length) {
      const next = queue.shift();
      if (next === excluded || visited.has(next)) continue;
      if (next === context.output) return true;
      visited.add(next); queue.push(...next.edges);
    }
    return false;
  };
  assert.equal(reachable(nodes[0]), true);
  assert.equal(reachable(nodes[0], volume), false, 'effects cannot bypass track volume');
});

test('ending the final source clears playback state and all-muted sessions do not start', async () => {
  const context = page(); seed(context);
  run(context, 'const finishedSource = {stop(){}}; addSource(finishedSource, getContext()); playing=true; finishedSource.onended()');
  assert.equal(run(context, 'playing'), false);
  assert.match(run(context, '$(' + JSON.stringify('status') + ').textContent'), /Playback finished/);
  run(context, 'tracks[0].mute=true');
  await run(context, 'playSession()');
  assert.equal(run(context, 'playing'), false);
  assert.match(run(context, '$(' + JSON.stringify('status') + ').textContent'), /All tracks are muted/);
});

function seedEditable(context) {
  run(context, `
    const originalAudio = getContext().createBuffer(2, 16000, 8000);
    originalAudio.getChannelData(0)[2000] = .8;
    originalAudio.getChannelData(1)[6000] = -.7;
    makeTrack('Lead Vocal', originalAudio, 'vocal');
  `);
}

function applyFromView(context, view, values) {
  context.editValues = values;
  context.editView = view;
  return run(context, `
    (() => {
      const row = $(editView).querySelector('.track');
      for (const [key, value] of Object.entries(editValues)) row.querySelector('[data-edit="'+key+'"]').value = String(value);
      [...row.querySelectorAll('button')].find(b=>b.textContent==='Apply Track Edit').onclick();
    })()
  `);
}

test('recording and mixer editors position and trim audio without changing original PCM', () => {
  const context = page(); seedEditable(context);
  applyFromView(context, 'recordTracks', {name:'Chorus',offset:2.5,trimStart:.25,trimEnd:1.25});
  assert.equal(run(context, 'tracks[0].name'), 'Chorus');
  assert.equal(run(context, 'tracks[0].buffer===originalAudio'), true);
  assert.equal(run(context, 'tracks[0].buffer.length'), 16000);
  assert.equal(run(context, 'sessionDuration()'), 3.5);
  assert.match(run(context, '$("arrangement").querySelector("[role=img]").getAttribute("aria-label")'), /Chorus: starts at 2.5 seconds, plays 1 seconds/);
  assert.equal(run(context, '$("mixerTracks").querySelector("[data-edit=offset]").value'), '2.5');
  applyFromView(context, 'mixerTracks', {offset:4,trimStart:.5,trimEnd:1.5});
  assert.equal(run(context, 'tracks[0].offset'), 4);
  assert.equal(run(context, '$("recordTracks").querySelector("[data-edit=trimStart]").value'), '0.5');
  assert.equal(run(context, 'tracks[0].buffer.getChannelData(0)[2000]'), Math.fround(.8));
  assert.equal(run(context, 'tracks[0].buffer.getChannelData(1)[6000]'), Math.fround(-.7));
});

test('playback, full mix, and stems use the selected source interval at the arranged start', async () => {
  const context = page(); seedEditable(context);
  applyFromView(context, 'recordTracks', {offset:2.5,trimStart:.25,trimEnd:1.25});
  run(context, `
    connectTrack = () => ({start(...args){window.scheduled = args;}});
    scheduleTrack(tracks[0], getContext(), 10, {});
  `);
  assert.deepEqual(plain(run(context, 'window.scheduled')), [12.5,.25,1]);
  context.OfflineAudioContext = class {
    constructor(channels, frames, rate) { this.destination = {}; this.frames=frames; this.rate=rate; }
    async startRendering() { return {frames:this.frames,rate:this.rate}; }
  };
  const mix = await run(context, 'renderSession()');
  assert.equal(mix.frames, Math.ceil(6.5*44100));
  assert.deepEqual(plain(run(context, 'window.scheduled')), [2.5,.25,1]);
  const stem = await run(context, 'renderSession(tracks[0])');
  assert.equal(stem.frames, mix.frames, 'stem uses the trimmed length plus its song position and FX tail');
});

test('invalid and empty trim windows leave the current track and undo history intact', () => {
  const context = page(); seedEditable(context);
  const before = plain(run(context, 'projectSettings()'));
  for (const changes of [
    {offset:-1,trimStart:0,trimEnd:2},
    {offset:0,trimStart:.5,trimEnd:.5},
    {offset:0,trimStart:0,trimEnd:2.1},
    {offset:0,trimStart:-.1,trimEnd:1},
    {offset:0,trimStart:0,trimEnd:Infinity}
  ]) {
    context.badChanges = changes;
    assert.equal(run(context, 'editTrack(tracks[0],{name:"Bad edit",...badChanges})'), false);
    assert.deepEqual(plain(run(context, 'projectSettings()')), before);
    assert.equal(run(context, 'trackEditHistory.length'), 0);
  }
  applyFromView(context,'recordTracks',{offset:'',trimStart:0,trimEnd:2});
  assert.deepEqual(plain(run(context, 'projectSettings()')), before);
  assert.match(run(context, '$("status").textContent'), /Enter a number/);
});

test('duplicates follow the trimmed section and undo restores removed audio without dropping newer tracks', () => {
  const context = page(); seedEditable(context);
  applyFromView(context,'recordTracks',{offset:2.5,trimStart:.25,trimEnd:1.25});
  run(context, '[...$("mixerTracks").querySelectorAll("button")].find(b=>b.textContent==="Duplicate").onclick()');
  assert.equal(run(context, 'tracks.length'), 2);
  assert.equal(run(context, 'tracks[1].offset'), 3.5);
  assert.equal(run(context, 'tracks[1].trimStart'), .25);
  assert.equal(run(context, 'tracks[1].buffer===tracks[0].buffer'), true);
  run(context, 'tracks[1].volume=.3; removeTrack(tracks[0]); makeTrack("New audio",originalAudio)');
  assert.equal(run(context, 'tracks.length'), 2);
  run(context, '$("undoTrackEdit").onclick()');
  assert.deepEqual(plain(run(context, 'tracks.map(t=>t.name)')), ['Lead Vocal','Lead Vocal copy','New audio']);
  assert.equal(run(context, 'tracks[0].buffer===originalAudio'), true);
  assert.equal(run(context, 'tracks[0].volume'), 1);
  assert.equal(run(context, 'tracks[1].volume'), .3);
  run(context, '$("undoTrackEdit").onclick()');
  assert.deepEqual(plain(run(context, 'tracks.map(t=>t.name)')), ['Lead Vocal','New audio']);
});

test('restoring full audio and undoing edits recover source bounds while retaining later mix changes', () => {
  const context = page(); seedEditable(context);
  applyFromView(context,'recordTracks',{offset:1,trimStart:.25,trimEnd:1.5});
  run(context, '[...$("recordTracks").querySelectorAll("button")].find(b=>b.textContent==="Restore Full Audio").onclick()');
  assert.equal(run(context, 'clipRange(tracks[0]).duration'), 2);
  assert.equal(run(context, 'tracks[0].offset'), 1);
  run(context, 'tracks[0].volume=.37; $("undoTrackEdit").onclick()');
  assert.equal(run(context, 'clipRange(tracks[0]).duration'), 1.25);
  assert.equal(run(context, 'tracks[0].volume'), .37);
  run(context, '$("undoTrackEdit").onclick()');
  assert.equal(run(context, 'tracks[0].offset'), 0);
  assert.equal(run(context, 'clipRange(tracks[0]).duration'), 2);
  assert.equal(run(context, 'tracks[0].volume'), .37);
  assert.equal(run(context, '$("undoTrackEdit").disabled'), true);
});

test('edited arrangements survive device saves and portable backups with full original stereo audio', async () => {
  const database=new IDBFactory(), first=page(database); seedEditable(first);
  applyFromView(first,'recordTracks',{name:'Edited lead',offset:4,trimStart:.25,trimEnd:1.25});
  run(first, 'duplicateTrack(tracks[0])');
  await run(first, '$("saveProject").onclick()');
  const output=await portable(first);
  const saved=page(database);
  await run(saved, '$("loadProject").onclick()');
  const imported=page();
  await importText(imported,await output.blob.text());
  for (const context of [saved,imported]) {
    assert.equal(run(context, 'tracks.length'), 2);
    assert.equal(run(context, 'tracks[0].trimStart'), .25);
    assert.equal(run(context, 'tracks[0].trimEnd'), 1.25);
    assert.equal(run(context, 'tracks[1].offset'), 5);
    assert.equal(run(context, 'sessionDuration()'), 6);
    assert.equal(run(context, 'tracks[0].buffer.length'), 16000);
    assert.equal(run(context, 'tracks[0].buffer.getChannelData(1)[6000]'), Math.fround(-.7));
    assert.equal(run(context, 'trackEditHistory.length'), 0);
    assert.equal(run(context, '$("undoTrackEdit").disabled'), true);
  }
});

test('older full-audio backups remain compatible and invalid saved trim bounds cannot replace a session', async () => {
  const source=page(); seedEditable(source);
  const output=await portable(source), original=JSON.parse(await output.blob.text());
  delete original.tracks[0].trimStart; delete original.tracks[0].trimEnd;
  const destination=page();
  await importText(destination,JSON.stringify(original));
  assert.equal(run(destination, 'clipRange(tracks[0]).duration'), 2);
  assert.equal(run(destination, 'tracks[0].trimStart'), 0);
  for (const end of [0,-1,2.1]) {
    const broken=structuredClone(original); broken.tracks[0].trimEnd=end; broken.name='Damaged';
    await importText(destination,JSON.stringify(broken));
    assert.equal(run(destination, 'tracks[0].name'), 'Lead Vocal');
    assert.equal(run(destination, 'clipRange(tracks[0]).duration'), 2);
    assert.match(run(destination, '$("status").textContent'), /Project action failed/);
  }
});

test('edits and undo are blocked during playback or recording and history holds at most twenty edits', () => {
  const context=page(); seedEditable(context);
  for(let i=1;i<=25;i++)applyFromView(context,'recordTracks',{offset:i,trimStart:0,trimEnd:2});
  assert.equal(run(context, 'trackEditHistory.length'), 20);
  for (const state of ['playing','recording']) {
    run(context, state+'=true; $("undoTrackEdit").onclick(); duplicateTrack(tracks[0]); removeTrack(tracks[0])');
    assert.equal(run(context, 'tracks.length'), 1);
    assert.equal(run(context, 'tracks[0].offset'), 25);
    assert.equal(run(context, 'trackEditHistory.length'), 20);
    run(context, state+'=false');
  }
  for(let i=0;i<20;i++)run(context,'$("undoTrackEdit").onclick()');
  assert.equal(run(context, 'tracks[0].offset'), 5);
  assert.equal(run(context, '$("undoTrackEdit").disabled'), true);
});

function recordingHarness({fallback=false,workletFailure=false,permission}={}) {
  const context=page(), h={context,nodes:[],worklets:[],timers:new Map(),requests:0};
  let timerId=0;
  context.setTimeout=(fn,ms)=>{const id=++timerId;h.timers.set(id,{fn,ms});return id;};
  context.clearTimeout=id=>h.timers.delete(id);
  h.track={stops:0,handlers:[],stop(){this.stops++;},addEventListener(type,handler){if(type==='ended')this.handlers.push(handler);}};
  h.stream={getTracks:()=>[h.track],getAudioTracks:()=>[h.track]};
  context.navigator={mediaDevices:{getUserMedia:async()=>{h.requests++;return permission?permission():h.stream;}}};
  function node(kind) {
    const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
    const n={kind,starts:[],stops:0,disconnected:false,gain:param(),frequency:param(),threshold:param(),ratio:param(),attack:param(),release:param(),pan:param(),delayTime:param(),
      connect(target){return target;},disconnect(){this.disconnected=true;},start(...args){this.starts.push(args);},stop(){this.stops++;}};
    h.nodes.push(n);return n;
  }
  h.ac=run(context,'getContext()');
  Object.assign(h.ac,{sampleRate:8000,destination:{},createOscillator:()=>node('click'),createGain:()=>node('gain'),
    createBufferSource:()=>node('backing'),createBiquadFilter:()=>node('eq'),createDynamicsCompressor:()=>node('compressor'),createStereoPanner:()=>node('pan'),
    createMediaStreamSource:()=>node('microphone')});
  if(!fallback)h.ac.audioWorklet={addModule:async path=>{
    assert.equal(path,'css/studio-recorder-worklet.js');
    if(workletFailure)throw Error('Worklet unavailable');
  }};
  context.window.AudioWorkletNode=class {
    constructor(ac,name) {
      assert.equal(name,'starrise-recorder');
      let Processor;
      const main=this;
      this.connected=false;this.disconnected=false;
      this.port={postMessage:message=>queueMicrotask(()=>{if(!h.ignoreStop||message.type!=='stop')this.worker.port.onmessage({data:message});})};
      class Base { constructor(){this.port={postMessage:message=>queueMicrotask(()=>main.port.onmessage?.({data:message}))};} }
      this.workerContext=vm.createContext({AudioWorkletProcessor:Base,Float32Array,currentFrame:0,registerProcessor:(_,type)=>Processor=type});
      vm.runInContext(fs.readFileSync('css/studio-recorder-worklet.js','utf8'),this.workerContext);
      this.worker=new Processor();h.worklets.push(this);
    }
    connect(){this.connected=true;}
    disconnect(){this.disconnected=true;}
  };
  context.window.MediaRecorder=class {
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.mimeType='audio/webm';h.encoded=this;}
    start(){this.state='recording';this.onstart?.();}
    stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['encoded audio'])});void this.onstop?.();});}
  };
  h.feed=(frame,...channels)=>{
    const processor=h.worklets.at(-1);
    processor.workerContext.currentFrame=frame;
    const output=new Float32Array(channels[0].length);output.fill(9);
    processor.worker.process([channels],[[output]]);
    assert.ok(output.every(value=>value===0),'live microphone never reaches the output');
    h.ac.currentTime=(frame+channels[0].length)/h.ac.sampleRate;
  };
  h.advance=seconds=>{
    h.ac.currentTime=seconds;
    const timer=[...h.timers].find(([,value])=>value.ms===40);
    if(timer){h.timers.delete(timer[0]);timer[1].fn();}
  };
  h.fire=ms=>{
    const timer=[...h.timers].find(([,value])=>value.ms===ms);
    assert.ok(timer,'expected timer '+ms);h.timers.delete(timer[0]);timer[1].fn();
  };
  run(context,'$("bpm").value="120"');
  return h;
}

test('recording from a song position schedules only the remaining trimmed backing audio', () => {
  const h=recordingHarness(),context=h.context;seedEditable(context);
  run(context, 'Object.assign(tracks[0],{offset:0,trimStart:.25,trimEnd:1.25}); scheduleTrack(tracks[0],getContext(),10,{},.5)');
  assert.deepEqual(h.nodes.filter(n=>n.kind==='backing')[0].starts[0],[10,.75,.5]);
  run(context,'scheduleTrack(tracks[0],getContext(),10,{},1.1)');
  assert.equal(h.nodes.filter(n=>n.kind==='backing').length,1,'completed tracks are skipped');
  run(context,'tracks[0].offset=2; scheduleTrack(tracks[0],getContext(),10,{},.5)');
  assert.deepEqual(h.nodes.filter(n=>n.kind==='backing')[1].starts[0],[11.5,.25,1]);
});

test('PCM recording excludes the full count-in, captures only microphone PCM, and positions the take', async () => {
  const h=recordingHarness(),context=h.context;
  run(context,'$("recordFrom").value="5"');
  await run(context,'beginVocal()');
  assert.equal(run(context,'recordingSession.mode'),'pcm');
  assert.equal(run(context,'recordingSession.startAt'),2.15);
  assert.equal(run(context,'$("recordVocal").disabled'),true);
  assert.equal(run(context,'$("bpm").disabled'),true);
  h.feed(0,new Float32Array(17200).fill(.9));
  h.feed(17200,new Float32Array(800).fill(.6),new Float32Array(800).fill(.2));
  await run(context,'$("stop").onclick()');
  assert.equal(run(context,'tracks.length'),1);
  assert.equal(run(context,'tracks[0].offset'),5);
  assert.equal(run(context,'tracks[0].buffer.length'),800);
  assert.equal(run(context,'tracks[0].buffer.numberOfChannels'),1);
  assert.ok(Math.abs(run(context,'tracks[0].buffer.getChannelData(0)[0]')-.4)<1e-6);
  assert.equal(run(context,'recording'),false);
  assert.equal(run(context,'$("recordVocal").disabled'),false);
  assert.equal(run(context,'$("stopVocal").disabled'),true);
  assert.ok(h.track.stops>0);
  assert.equal(h.worklets[0].disconnected,true);
});

test('count-in clicks use the audio clock and optional recording clicks never enter the track list', async () => {
  const h=recordingHarness(),context=h.context;
  run(context,'$("recordMetronome").checked=true');
  await run(context,'beginVocal()');
  h.advance(.1);h.advance(.6);h.advance(1.1);h.advance(1.6);h.advance(2.1);
  const clicks=h.nodes.filter(n=>n.kind==='click');
  assert.deepEqual(clicks.map(n=>n.starts[0][0]),[.15,.65,1.15,1.65,2.15]);
  assert.deepEqual(clicks.map(n=>n.frequency.value),[1000,750,750,750,1000]);
  assert.match(run(context,'$("recordClock").textContent'),/Count-in/);
  h.feed(17200,new Float32Array(800).fill(.25));h.advance(2.25);
  assert.match(run(context,'$("recordClock").textContent'),/Recording 0:00/);
  await run(context,'stopVocal()');
  assert.equal(run(context,'tracks.length'),1);
  assert.equal(run(context,'tracks[0].type'),'vocal');
  assert.ok(clicks.every(n=>n.stops>0));
  assert.equal(h.timers.size,0);
});

test('metronome-off records without a click at the first recorded beat and skips stale beats after a pause', async () => {
  const h=recordingHarness(),context=h.context;
  await run(context,'beginVocal()');
  h.advance(.1);h.advance(2.1);
  assert.equal(h.nodes.filter(n=>n.kind==='click').length,1);
  assert.equal(h.nodes.filter(n=>n.kind==='click')[0].starts[0][0],.15);
  h.advance(10);
  assert.equal(h.nodes.filter(n=>n.kind==='click').length,1,'missed count-in clicks are not replayed as a burst');
  await run(context,'stopVocal()');
  assert.equal(run(context,'tracks.length'),0);
});

test('stopping during count-in cancels both backing audio and microphone without an empty take', async () => {
  const h=recordingHarness(),context=h.context;seedEditable(context);
  await run(context,'beginVocal()');h.advance(.1);
  await run(context,'stopAll()');
  assert.equal(run(context,'tracks.length'),1,'existing audio remains');
  assert.equal(run(context,'recordingSession'),null);
  assert.match(run(context,'$("status").textContent'),/cancelled before the take began/);
  assert.ok(h.nodes.filter(n=>['backing','click'].includes(n.kind)).every(n=>n.stops>0));
  assert.ok(h.track.stops>0);
  assert.equal(h.timers.size,0);
});

test('cancelling a pending microphone request blocks duplicate starts and stops a late stream', async () => {
  let grant;
  const h=recordingHarness({permission:()=>new Promise(resolve=>grant=resolve)}),context=h.context;
  const pending=run(context,'beginVocal()');
  await new Promise(resolve=>setImmediate(resolve));
  await run(context,'beginVocal()');
  assert.equal(h.requests,1);
  await run(context,'stopAll()');
  grant(h.stream);await pending;
  assert.equal(run(context,'recording'),false);
  assert.equal(run(context,'tracks.length'),0);
  assert.ok(h.track.stops>0);
  assert.equal(h.worklets.length,0);
});

for (const mode of ['unsupported','load failure']) {
  test('encoded recording fallback excludes count-in when PCM is '+mode, async () => {
    const h=recordingHarness({fallback:mode==='unsupported',workletFailure:mode==='load failure'}),context=h.context;
    const decoded=new AudioBufferStub(1,20000,8000);
    decoded.channels[0].fill(.1,0,17200);decoded.channels[0].fill(.6,17200);
    h.ac.decodeAudioData=async()=>decoded;
    run(context,'$("recordFrom").value="3"');
    await run(context,'beginVocal()');
    assert.equal(run(context,'recordingSession.mode'),'encoded');
    h.advance(2.5);await run(context,'stopVocal()');
    assert.equal(run(context,'tracks[0].buffer.length'),2800);
    assert.equal(run(context,'tracks[0].offset'),3);
    assert.equal(run(context,'tracks[0].buffer.getChannelData(0)[0]'),Math.fround(.6));
    assert.equal(run(context,'recording'),false);
    assert.ok(h.track.stops>0);
  });
}

test('microphone denial and decode errors release controls while retaining existing tracks', async () => {
  const denied=recordingHarness({permission:()=>Promise.reject(Error('Permission denied'))});seedEditable(denied.context);
  await run(denied.context,'beginVocal()');
  assert.equal(run(denied.context,'recording'),false);
  assert.equal(run(denied.context,'tracks.length'),1);
  assert.equal(run(denied.context,'$("recordVocal").disabled'),false);
  const broken=recordingHarness({fallback:true});seedEditable(broken.context);
  broken.ac.decodeAudioData=async()=>{throw Error('Damaged capture');};
  await run(broken.context,'beginVocal()');broken.advance(3);await run(broken.context,'stopVocal()');
  assert.equal(run(broken.context,'tracks.length'),1);
  assert.equal(run(broken.context,'recording'),false);
  assert.equal(run(broken.context,'$("bpm").disabled'),false);
  assert.match(run(broken.context,'$("status").textContent'),/Recording decode failed/);
  assert.ok(broken.track.stops>0);
});

test('a stalled PCM stop keeps the received portion and reports a partial take', async () => {
  const h=recordingHarness(),context=h.context;h.ignoreStop=true;
  run(context,'$("countIn").value="0"');
  await run(context,'beginVocal()');
  h.feed(1200,new Float32Array(8200).fill(.4));
  await new Promise(resolve=>setImmediate(resolve));
  const finishing=run(context,'stopVocal()');h.fire(1500);await finishing;
  assert.equal(run(context,'tracks[0].buffer.length'),8192);
  assert.match(run(context,'$("status").textContent'),/partial vocal take was kept/);
  assert.equal(run(context,'recording'),false);
});

test('recording settings survive project saves and old projects receive safe defaults', async () => {
  const database=new IDBFactory(),source=page(database);seedEditable(source);
  run(source,'$("recordFrom").value="6.5"; $("countIn").value="8"; $("recordMetronome").checked=true');
  await run(source,'$("saveProject").onclick()');
  const reopened=page(database);await run(reopened,'$("loadProject").onclick()');
  assert.deepEqual(plain(run(reopened,'recordingSettings()')),{from:6.5,countIn:8,metronome:true});
  const output=await portable(source),data=JSON.parse(await output.blob.text());
  const restored=page();await importText(restored,JSON.stringify(data));
  assert.deepEqual(plain(run(restored,'recordingSettings()')),{from:6.5,countIn:8,metronome:true});
  delete data.recording;await importText(restored,JSON.stringify(data));
  assert.deepEqual(plain(run(restored,'recordingSettings()')),{from:0,countIn:4,metronome:false});
  data.recording={from:-1,countIn:4,metronome:false};data.name='Bad';
  await importText(restored,JSON.stringify(data));
  assert.equal(run(restored,'$("projectName").value'),'My StarRise Song');
  assert.match(run(restored,'$("status").textContent'),/Project action failed/);
});

test('direct capture joins complete and final partial PCM chunks in the original order', async () => {
  const h=recordingHarness(),context=h.context;
  run(context,'$("countIn").value="0"');
  await run(context,'beginVocal()');
  const input=new Float32Array(9000);input.fill(.2,0,8192);input.fill(.7,8192);
  h.feed(1200,input);await run(context,'stopVocal()');
  assert.equal(run(context,'tracks[0].buffer.length'),9000);
  assert.equal(run(context,'tracks[0].buffer.getChannelData(0)[8191]'),Math.fround(.2));
  assert.equal(run(context,'tracks[0].buffer.getChannelData(0)[8192]'),Math.fround(.7));
  assert.equal(run(context,'tracks[0].buffer.getChannelData(0)[8999]'),Math.fround(.7));
});

test('a late cancelled microphone permission cannot stop a newer recording request', async () => {
  let grant,calls=0,h;
  h=recordingHarness({permission:()=>++calls===1?new Promise(resolve=>grant=resolve):h.stream});
  const context=h.context,first=run(context,'beginVocal()');
  await new Promise(resolve=>setImmediate(resolve));await run(context,'stopVocal()');
  await run(context,'beginVocal()');
  const oldTrack={stops:0,stop(){this.stops++;}};
  grant({getTracks:()=>[oldTrack]});await first;
  assert.equal(oldTrack.stops,1);
  assert.equal(h.track.stops,0);
  assert.equal(run(context,'recording'),true);
  assert.equal(run(context,'recordingSession.mode'),'pcm');
  await run(context,'stopVocal()');
});

function exportHarness({failAt=0,holdFirst=false}={}) {
  const context=page(), renders=[], downloads=[];
  let release;
  context.OfflineAudioContext=class {
    constructor(channels,frames,sampleRate) {
      Object.assign(this,{channels,frames,sampleRate,destination:{kind:'destination'},nodes:[]});
      renders.push(this);
    }
    node(kind) {
      const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
      const result={kind,edges:[],starts:[],gain:param(),frequency:param(),threshold:param(),ratio:param(),attack:param(),release:param(),pan:param(),delayTime:param(),
        connect(target){this.edges.push(target);return target;},start(...args){this.starts.push(args);},stop(){}};
      this.nodes.push(result);return result;
    }
    createBufferSource(){return this.node('source');}
    createOscillator(){return this.node('oscillator');}
    createGain(){return this.node('gain');}
    createBiquadFilter(){return this.node('eq');}
    createDynamicsCompressor(){return this.node('compressor');}
    createStereoPanner(){return this.node('pan');}
    createConvolver(){return this.node('reverb');}
    createDelay(){return this.node('delay');}
    createBuffer(channels,frames,rate){return new AudioBufferStub(channels,frames,rate);}
    async startRendering(){
      if(holdFirst&&renders.length===1)await new Promise(resolve=>release=resolve);
      if(failAt&&renders.length===failAt)throw Error('Render interrupted');
      const buffer=new AudioBufferStub(this.channels,this.frames,this.sampleRate);
      buffer.getChannelData(0)[0]=.00001;
      return buffer;
    }
  };
  context.captureDownload=(blob,name)=>downloads.push({blob,name});
  run(context,'download=(blob,name)=>captureDownload(blob,name)');
  return{context,renders,downloads,release:()=>release()};
}

async function inspectTrackZip(blob) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'starrise-tracks-'));
  const archive=path.join(directory,'tracks.zip');
  fs.writeFileSync(archive,Buffer.from(await blob.arrayBuffer()));
  try {
    return JSON.parse(execFileSync('python3',['-c',[
      'import json,sys,zipfile,struct',
      'z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',
      'result={"names":z.namelist(),"notes":json.loads(z.read("session-notes.json")),"readme":z.read("README.txt").decode(),"wavs":[]}',
      'for name in z.namelist():',
      ' if not name.endswith(".wav"): continue',
      ' b=z.read(name); assert b[:4]==b"RIFF" and b[8:12]==b"WAVE"',
      ' assert struct.unpack_from("<I",b,4)[0]+8==len(b)',
      ' fmt,channels,rate,byte_rate,align,bits=struct.unpack_from("<HHIIHH",b,20)',
      ' offset=12; chunks={}',
      ' while offset+8<=len(b):',
      '  size=struct.unpack_from("<I",b,offset+4)[0]; chunks[b[offset:offset+4]]=b[offset+8:offset+8+size]; offset+=8+size+(size%2)',
      ' samples=chunks[b"data"]; frames=len(samples)//align',
      ' result["wavs"].append({"name":name,"format":fmt,"channels":channels,"rate":rate,"bits":bits,"frames":frames,"first24":int.from_bytes(samples[:3],"little",signed=True) if bits==24 else None})',
      'print(json.dumps(result))'
    ].join('\n'),archive],{encoding:'utf8'}));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}

test('one ZIP contains safe named WAVs with common lengths, reference mix and independent readable notes', async () => {
  const h=exportHarness(),context=h.context;seedEditable(context);
  run(context,`
    Object.assign(tracks[0],{name:'../Lead / 🎤',offset:.125,trimStart:.25,trimEnd:1.25,volume:.25,pan:-.5,reverb:20});
    duplicateTrack(tracks[0]);tracks[1].offset=2;
    $('projectName').value='Engineer / Test';$('bpm').value='92';
  `);
  const before=plain(run(context,'projectToJSON(projectSnapshot())'));
  await run(context,'$("exportStems").onclick()');
  assert.equal(h.downloads.length,1,'one download avoids mobile multi-download permissions');
  assert.equal(h.downloads[0].name,'Engineer-Test-tracks.zip');
  const zip=await inspectTrackZip(h.downloads[0].blob);
  assert.deepEqual(zip.names,['tracks/01-Lead.wav','tracks/02-Lead-copy.wav','reference-mix.wav','session-notes.json','README.txt']);
  for(const wav of zip.wavs){
    assert.equal(wav.rate,44100);assert.equal(wav.bits,24);assert.equal(wav.format,1);
    assert.equal(wav.channels,2);assert.equal(wav.frames,6*44100);assert.equal(wav.first24,84);
  }
  assert.equal(zip.notes.bpm,92);assert.equal(zip.notes.frames,6*44100);assert.equal(zip.notes.trackSound,'dry');
  assert.equal(zip.notes.tracks[0].name,'../Lead / 🎤');assert.equal(zip.notes.tracks[0].offset,.125);
  assert.equal(zip.notes.tracks[0].volume,.25);assert.equal(zip.notes.tracks[0].sourceSampleRate,8000);
  assert.match(zip.readme,/song time 0/);assert.match(zip.readme,/not a StarRise project backup/);
  assert.deepEqual(plain(h.renders[0].nodes[0].starts),[[.125,.25,1]]);
  assert.deepEqual(plain(h.renders[1].nodes[0].starts),[[2,.25,1]]);
  assert.deepEqual(h.renders[0].nodes.map(n=>n.kind),['source'],'dry export bypasses mixer and effects');
  assert.ok(h.renders[2].nodes.some(n=>n.kind==='compressor'),'reference mix retains mixer processing');
  const after=plain(run(context,'projectToJSON(projectSnapshot())'));
  delete before.savedAt;delete after.savedAt;assert.deepEqual(after,before,'export preserves full original audio and all settings');
  assert.equal(run(context,'projectBusy'),false);assert.equal(run(context,'$("exportStems").disabled'),false);
});

test('muted tracks are omitted by default, optionally exported with sound, and stay out of the reference mix', async () => {
  for(const include of [false,true]) {
    const h=exportHarness(),context=h.context;seedEditable(context);
    run(context,'duplicateTrack(tracks[0]);tracks[1].mute=true;tracks[1].name="Alternate take"');
    context.includeMuted=include;run(context,'$("stemMuted").checked=includeMuted');
    await run(context,'$("exportStems").onclick()');
    const zip=await inspectTrackZip(h.downloads[0].blob);
    assert.equal(zip.notes.tracks.length,include?2:1);
    if(include){assert.equal(zip.notes.tracks[1].mute,true);assert.equal(h.renders[1].nodes[0].starts.length,1);}
    assert.equal(h.renders.at(-1).nodes.filter(n=>n.kind==='source').length,1);
    assert.equal(run(context,'tracks[1].mute'),true);
  }
});

test('mixed track export retains the selected mixer sound and supports 48 kHz float WAVs', async () => {
  const h=exportHarness(),context=h.context;seedEditable(context);
  run(context,'$("stemMode").value="mixed";$("exportFormat").value="float32";$("exportRate").value="48000";tracks[0].volume=.37;tracks[0].pan=-.6');
  await run(context,'$("exportStems").onclick()');
  const zip=await inspectTrackZip(h.downloads[0].blob);
  assert.equal(zip.notes.trackSound,'mixed');
  for(const wav of zip.wavs){assert.equal(wav.format,3);assert.equal(wav.bits,32);assert.equal(wav.rate,48000);assert.equal(wav.frames,5*48000);}
  assert.equal(h.renders[0].nodes.find(n=>n.kind==='gain').gain.value,.37);
  assert.equal(h.renders[0].nodes.find(n=>n.kind==='pan').pan.value,-.6);
});

test('empty, all-muted and oversized packages fail before rendering and preserve the session', async () => {
  for(const state of ['empty','muted','oversized']) {
    const h=exportHarness(),context=h.context;
    if(state!=='empty')seedEditable(context);
    if(state==='muted')run(context,'tracks[0].mute=true');
    if(state==='oversized')run(context,'tracks[0].offset=3600');
    await run(context,'$("exportStems").onclick()');
    assert.equal(h.renders.length,0);assert.equal(h.downloads.length,0);
    assert.match(run(context,'$("status").textContent'),state==='empty'?/No tracks/:state==='muted'?/All tracks are muted/:/too large/);
    assert.equal(run(context,'projectBusy'),false);assert.equal(run(context,'$("exportStems").disabled'),false);
  }
});

test('an interrupted export restores controls and never downloads an incomplete package', async () => {
  const h=exportHarness({failAt:2}),context=h.context;seedEditable(context);
  run(context,'duplicateTrack(tracks[0])');
  await run(context,'$("exportStems").onclick()');
  assert.equal(h.renders.length,2);assert.equal(h.downloads.length,0);
  assert.match(run(context,'$("status").textContent'),/Render interrupted.*current audio remains/);
  assert.equal(run(context,'tracks.length'),2);assert.equal(run(context,'projectBusy'),false);
  assert.equal(run(context,'$("recordVocal").disabled'),false);assert.equal(run(context,'$("stopVocal").disabled'),true);
});

test('export blocks concurrent requests, track edits and recording until the package is finished', async () => {
  const h=exportHarness({holdFirst:true}),context=h.context;seedEditable(context);
  const exporting=run(context,'$("exportStems").onclick()');
  assert.equal(run(context,'projectBusy'),true);assert.equal(run(context,'$("recordVocal").disabled'),true);
  await run(context,'$("exportStems").onclick();$("exportMix").onclick();beginVocal()');
  run(context,'duplicateTrack(tracks[0])');
  assert.equal(h.renders.length,1);assert.equal(run(context,'tracks.length'),1);assert.equal(run(context,'recording'),false);
  h.release();await exporting;
  assert.equal(h.downloads.length,1);assert.equal(run(context,'projectBusy'),false);
});

test('recording blocks exports and single WAV exports honor the chosen quality and sample rate', async () => {
  const h=exportHarness(),context=h.context;seedEditable(context);
  run(context,'recording=true');await run(context,'$("exportStems").onclick()');
  assert.equal(h.renders.length,0);assert.match(run(context,'$("status").textContent'),/Stop recording before exporting/);
  run(context,'recording=false;$("exportFormat").value="pcm16";$("exportRate").value="48000"');
  await run(context,'$("exportMix").onclick()');
  let view=new DataView(await h.downloads[0].blob.arrayBuffer());
  assert.equal(view.getUint16(34,true),16);assert.equal(view.getUint32(24,true),48000);
  run(context,'$("exportFormat").value="pcm24"');
  await run(context,'$("exportBeat").onclick()');
  view=new DataView(await h.downloads[1].blob.arrayBuffer());
  assert.equal(view.getUint16(34,true),24);assert.equal(view.getUint32(24,true),48000);
});
