const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  copyToChannel(samples, channel) { this.channels[channel].set(samples); }
}

function page(indexedDB = new IDBFactory(), confirmation = true) {
  const { window, document } = parseHTML(html);
  const storage = new Map();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
  });
  window.indexedDB = indexedDB;
  window.confirm = () => confirmation;
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
