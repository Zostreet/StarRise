(() => {
  "use strict";
  const C = window.StarRiseStudioCore;
  const $ = id => document.getElementById(id);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const uid = () => crypto.randomUUID();
  const clone = value => structuredClone(value);
  const note = text => { $("studioStatus").textContent = text; };
  const clock = seconds => `${String(Math.floor(Math.max(0,seconds)/60)).padStart(2,"0")}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,"0")}`;
  let project = C.createProject(uid());
  let database = null;
  const projects = new Map();
  let audioBlob = null;
  let clipBuffer = null;
  let takeBlobs = Object.create(null);
  let takeBuffers = Object.create(null);
  let loading = true;
  let projectEpoch = 0;
  let revision = 0;
  let savedRevision = -1;
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let confirmResolve = null;
  function element(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key,value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key === "onClick") node.addEventListener("click",value);
      else node.setAttribute(key,value);
    }
    node.append(...children); return node;
  }
  function inputField(label,value,onInput,options = {}) {
    const control = element(options.tag || "input",options.tag === "textarea" ? {rows:options.rows||3} : {type:options.type||"text"});
    control.value = value;
    if (options.min !== undefined) control.min = options.min;
    if (options.max !== undefined) control.max = options.max;
    if (options.step !== undefined) control.step = options.step;
    control.addEventListener("input",()=>{ if (!loading) {onInput(control.value,control); changed();} });
    return element("label",{text:label},[control]);
  }
  function selectField(label,value,items,onChange) {
    const control = element("select");
    control.append(...items.map(item=>element("option",{value:item,text:item}))); control.value=value;
    control.addEventListener("change",()=>{if(!loading){onChange(control.value);changed();}});
    return element("label",{text:label},[control]);
  }
  function action(text,handler,label) { return element("button",{type:"button",class:"button quiet",text,...(label?{"aria-label":label}:{}),onClick:()=>{if(!loading)Promise.resolve().then(handler).catch(error=>note(error.message));}}); }
  function ask(title,description,yes = "Continue") {
    if (confirmResolve) confirmResolve(false);
    $("confirmTitle").textContent=title; $("confirmDescription").textContent=description; $("confirmYes").textContent=yes;
    if (!$("confirmDialog").open) $("confirmDialog").showModal();
    return new Promise(resolve=>{confirmResolve=resolve;});
  }
  function finishAsk(value) { const resolve=confirmResolve;confirmResolve=null;$("confirmDialog").close();resolve?.(value); }
  $("confirmYes").addEventListener("click",()=>finishAsk(true)); $("confirmNo").addEventListener("click",()=>finishAsk(false));
  $("confirmDialog").addEventListener("cancel",event=>{event.preventDefault();finishAsk(false);});
  $("closeCopy").addEventListener("click",()=>$("copyDialog").close());
  async function copy(text) {
    if (!text.trim()) return note("Add something to your project first.");
    try {await navigator.clipboard.writeText(text);note("Copied. Your creation is ready for your next step.");}
    catch {$("copyText").value=text;$("copyDialog").showModal();$("copyText").focus();$("copyText").select();}
  }
  function download(blob,suffix) {
    const url=URL.createObjectURL(blob);const link=element("a",{href:url,download:`${C.filename(project.name)}-${suffix}`});
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    note("Export sent to your browser. Check Downloads for your file.");
  }
  function textExport(text,suffix,type="text/plain;charset=utf-8") {download(new Blob([text],{type}),suffix);}
  function saveLabel(text,state="saved") {$("saveState").textContent=text;$("saveState").dataset.state=state;}
  function changed() {
    if(loading)return;revision++;saveLabel("Saving changes…","pending");clearTimeout(saveTimer);saveTimer=setTimeout(()=>void saveNow(),650);
  }
  function openDatabase() {
    return new Promise((resolve,reject)=>{
      if(!window.indexedDB)return reject(new Error("Browser storage is unavailable."));
      const request=indexedDB.open("starrise-creator-studio",1);let settled=false;
      const timeout=setTimeout(()=>{settled=true;reject(new Error("Browser storage did not open."));},5000);
      request.onupgradeneeded=()=>{request.result.createObjectStore("projects",{keyPath:"id"});request.result.createObjectStore("settings");};
      request.onsuccess=()=>{clearTimeout(timeout);if(settled){request.result.close();return;}settled=true;resolve(request.result);};
      request.onerror=()=>{clearTimeout(timeout);settled=true;reject(request.error);};
    });
  }
  function dbRead(store,key) {
    return new Promise((resolve,reject)=>{const tx=database.transaction(store,"readonly");const req=key===undefined?tx.objectStore(store).getAll():tx.objectStore(store).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  }
  function dbWrite(record,makeActive=true) {
    return new Promise((resolve,reject)=>{
      const tx=database.transaction(["projects","settings"],"readwrite");tx.objectStore("projects").put(record);if(makeActive)tx.objectStore("settings").put(record.id,"active");
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("Save interrupted."));
    });
  }
  function snapshot() {serializeArt();project.updatedAt=new Date().toISOString();return {...clone(project),audioBlob, takeBlobs:{...takeBlobs}};}
  function saveNow() {
    clearTimeout(saveTimer);
    if(loading)return saveQueue;
    const record=snapshot();const version=revision;
    saveQueue=saveQueue.catch(()=>{}).then(async()=>{
      projects.set(record.id,record);
      try {
        if(database)await dbWrite(record,project.id===record.id);
        if(project.id===record.id&&revision===version){savedRevision=version;saveLabel(database?"Saved on this browser":"Session only · export a backup",database?"saved":"error");}
      } catch {if(project.id===record.id)saveLabel("Save failed · export a backup","error");note("Browser storage couldn't save this change. Export a project backup before leaving.");}
    });return saveQueue;
  }
  async function readFileData(blob) {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
  function dataBlob(data) {
    if(typeof data!=="string"||!/^data:[a-z\d.+/-]*;base64,[a-z\d+/=]*$/i.test(data))throw new Error("A backup audio asset is invalid.");
    const [head,body]=data.split(",");const bytes=atob(body);const array=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)array[i]=bytes.charCodeAt(i);
    return new Blob([array],{type:head.slice(5,-7)||"application/octet-stream"});
  }
  async function loadProject(record) {
    await stopSession();loading=true;projectEpoch++;stopBeat();stopClip();stopStage();removedTake=null;
    project=C.normalizeProject(record);audioBlob=record.audioBlob||null;takeBlobs=Object.assign(Object.create(null),record.takeBlobs||{});clipBuffer=null;takeBuffers=Object.create(null);
    await loadArt();renderProject();revision=0;savedRevision=0;loading=false;
    saveLabel(database?"Saved on this browser":"Session only · export a backup",database?"saved":"error");
    await saveNow();
    const epoch=projectEpoch;
    if(audioBlob){try{const b=await decodeBlob(audioBlob);if(epoch===projectEpoch){clipBuffer=b;renderClip();}}catch{note("The saved audio clip couldn't be decoded in this browser. Your file is still in the project backup.");}}
    for(const track of project.recording.tracks){try{if(takeBlobs[track.id]){const b=await decodeBlob(takeBlobs[track.id]);if(epoch===projectEpoch)takeBuffers[track.id]=b;}}catch{note("A saved take couldn't be decoded here. Import its original file to use it in this browser.");}}
    if(epoch===projectEpoch)renderTakes();
  }
  function renderProject() {
    $("projectName").value=project.name;$("songKey").value=project.song.key;$("songMood").value=project.song.mood;
    renderSong();renderBeat();renderMixer();renderClip();renderLayers();renderArt();renderStory();renderStage();renderTakes();
    $("recordBeat").checked=project.recording.beatEnabled;$("recordRepeats").value=project.recording.beatRepeats;$("recordMaster").value=project.recording.master;$("recordCountIn").value=project.recording.countIn;
  }
  async function createNew() {
    if(loading)return;await stopSession();await saveNow();const next=C.createProject(uid());await loadProject(next);revision++;await saveNow();note("New project ready. Your previous project is in Saved projects.");
  }
  $("projectName").addEventListener("input",()=>{if(!loading){project.name=$("projectName").value||"Untitled session";changed();}});
  $("newProject").addEventListener("click",()=>void createNew());
  $("exportProject").addEventListener("click",async()=>{
    if(loading)return;const button=$("exportProject");button.disabled=true;
    try{
      await stopSession();await saveNow();const record=snapshot();delete record.audioBlob;delete record.takeBlobs;
      const assets={clip:audioBlob?await readFileData(audioBlob):null,takes:{}};
      for(const track of project.recording.tracks)if(takeBlobs[track.id])assets.takes[track.id]=await readFileData(takeBlobs[track.id]);
      textExport(JSON.stringify({format:"starrise-creator-studio",version:1,project:record,assets}),"project.json","application/json");
    }catch(error){note(`Couldn't export the backup: ${error.message}`);}finally{button.disabled=false;}
  });
  $("projectImport").addEventListener("change",async()=>{
    const file=$("projectImport").files[0];$("projectImport").value="";if(!file||loading)return;
    try{
      const backup=JSON.parse(await file.text());if(backup.format!=="starrise-creator-studio"||backup.version!==1)throw new Error("Choose a StarRise project JSON backup.");
      const next=C.normalizeProject(backup.project);next.id=uid();next.name=`${next.name.slice(0,289)} (imported)`;next.archived=false;
      next.audioBlob=backup.assets?.clip?dataBlob(backup.assets.clip):null;next.takeBlobs=Object.create(null);
      for(const t of next.recording.tracks)if(backup.assets?.takes?.[t.id])next.takeBlobs[t.id]=dataBlob(backup.assets.takes[t.id]);
      await stopSession();await saveNow();await loadProject(next);revision++;await saveNow();note("Backup imported as a new project. Existing projects are kept.");
    }catch(error){note(`Couldn't import this project: ${error.message}`);}
  });
  async function renderLibrary() {
    await saveNow();const list=$("projectList");list.replaceChildren();
    const archived=$("showArchived").checked;const records=[...projects.values()].filter(p=>!!p.archived===archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    if(!records.length)list.append(element("p",{text:archived?"No projects in trash.":"Your saved projects will appear here."}));
    for(const record of records){
      const buttons=element("div",{class:"actions"});
      if(!archived)buttons.append(action(record.id===project.id?"Current project":"Open",async()=>{$("libraryDialog").close();await stopSession();await saveNow();await loadProject(record);note("Project opened.");},`Open ${record.name}`));
      buttons.append(action(archived?"Restore":"Duplicate",async()=>{
        const copy=clone(record);
        if(archived){copy.archived=false;projects.set(copy.id,copy);if(database)await dbWrite(copy,false);if(copy.id===project.id)project.archived=false;}
        else{copy.id=uid();copy.name=`${copy.name.slice(0,293)} (copy)`;copy.updatedAt=new Date().toISOString();projects.set(copy.id,copy);if(database)await dbWrite(copy,false);}
        await renderLibrary();
      },`${archived?"Restore":"Duplicate"} ${record.name}`));
      if(!archived)buttons.append(action("Move to trash",async()=>{
        if(!await ask("Move this project to trash?","You can restore it from Saved projects. Export a backup first if you want a separate copy.","Move to trash"))return;
        const copy=clone(record);copy.archived=true;projects.set(copy.id,copy);if(database)await dbWrite(copy,false);
        if(copy.id===project.id){project.archived=true;await createNew();}
        await renderLibrary();
      },`Move ${record.name} to trash`));
      list.append(element("article",{class:"project-card"},[element("h3",{text:record.name}),element("p",{text:`${record.song.sections.length} song sections · ${record.recording?.tracks?.length||0} takes · Updated ${new Date(record.updatedAt).toLocaleString()}`}),buttons]));
    }
  }
  $("openProjects").addEventListener("click",async()=>{if(loading)return;await renderLibrary();$("libraryDialog").showModal();});
  $("closeLibrary").addEventListener("click",()=>$("libraryDialog").close());$("showArchived").addEventListener("change",()=>void renderLibrary());
  function selectRoom(name) {
    stopBeat();stopClip();stopStage();void stopSession();
    $$("[data-room]").forEach(button=>{const active=button.dataset.room===name;button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;$("room-"+button.dataset.room).hidden=!active;});
  }
  $$("[data-room]").forEach((button,index,buttons)=>{
    button.addEventListener("click",()=>selectRoom(button.dataset.room));
    button.addEventListener("keydown",event=>{if(!["ArrowDown","ArrowUp","ArrowRight","ArrowLeft","Home","End"].includes(event.key))return;event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(["ArrowDown","ArrowRight"].includes(event.key)?1:-1)+buttons.length)%buttons.length;selectRoom(buttons[next].dataset.room);buttons[next].focus();});
  });

  const prompts={song:["Write about a promise you kept when it would have been easier to walk away.","Turn a late-night conversation into a hook. Let the verses show how the story changes.","Write from the perspective of your future self, looking back at this chapter.","Find a small detail in a complicated relationship. Let that detail carry the feeling.","Build a song around the moment you stopped asking permission to be yourself."],story:["A creator returns to a familiar street and sees the person they used to be.","Two versions of the same person meet before a life-changing performance.","An ordinary workday becomes the opening scene of an unexpected comeback.","A song travels through three generations, changing with each voice."]};
  const pick=list=>list[Math.floor(Math.random()*list.length)];
  function moveItem(list,index,direction,render){const next=index+direction;if(next<0||next>=list.length)return;[list[index],list[next]]=[list[next],list[index]];render();changed();}
  function reorderActions(list,index,render,label,onRemove){return element("div",{class:"actions"},[
    action("↑",()=>moveItem(list,index,-1,render),`Move ${label} up`),action("↓",()=>moveItem(list,index,1,render),`Move ${label} down`),action("Remove",async()=>{if(await ask(`Remove ${label}?`,"This removes this part from the current draft. Export a backup first if you want a separate copy.","Remove")){list.splice(index,1);onRemove?.();render();changed();}},`Remove ${label}`)
  ]);}
  function updateSongCount(){$("songWordCount").textContent=`${C.words(project.song.sections.map(s=>s.text).join(" "))} words · ${project.song.sections.length} sections`;}
  function renderSong(){
    $("songSections").replaceChildren(...project.song.sections.map((section,index)=>{
      const top=element("div",{class:"draft-top"},[inputField(`Section ${index+1} name`,section.title,value=>section.title=value),reorderActions(project.song.sections,index,renderSong,`section ${index+1}`)]);
      return element("article",{class:"draft-card"},[top,inputField(`Section ${index+1} lyrics`,section.text,value=>{section.text=value;updateSongCount();},{tag:"textarea",rows:5})]);
    }));updateSongCount();
  }
  $("songKey").addEventListener("input",()=>{if(!loading){project.song.key=$("songKey").value;changed();}});
  $("songMood").addEventListener("input",()=>{if(!loading){project.song.mood=$("songMood").value;changed();}});
  $("songPrompt").addEventListener("click",()=>$("songPromptText").textContent=pick(prompts.song));
  $("addSongSection").addEventListener("click",()=>{if(loading)return;if(project.song.sections.length>=100)return note("This project has 100 sections. Start another project to keep working.");project.song.sections.push({title:$("sectionType").value,text:""});renderSong();changed();});
  $("copySong").addEventListener("click",()=>void copy(C.songText(project)));$("exportSong").addEventListener("click",()=>textExport(C.songText(project),"lyrics.txt"));

  let audioContext=null;let workletReady=false;let beatRun=null;let clipSource=null;
  async function getAudio(){const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error("This browser doesn't support audio tools.");if(!audioContext)audioContext=new Audio();if(audioContext.state!=="running")await audioContext.resume();return audioContext;}
  function outputBus(context,level){
    const gain=context.createGain();gain.gain.value=level/100*.75;const limiter=context.createDynamicsCompressor();limiter.threshold.value=-8;limiter.knee.value=6;limiter.ratio.value=12;limiter.attack.value=.003;limiter.release.value=.15;gain.connect(limiter);limiter.connect(context.destination);return {gain,limiter};
  }
  function drum(context,destination,instrument,when,velocity,track,voices=new Set()){
    const gain=context.createGain();const pan=context.createStereoPanner();pan.pan.value=track.pan;gain.connect(pan);pan.connect(destination);
    const level=velocity*track.volume/100;let source;let filter=null;
    if(instrument===0||instrument===5){
      source=context.createOscillator();source.type=instrument===0?"sine":"triangle";source.frequency.setValueAtTime(instrument===0?145:390,when);source.frequency.exponentialRampToValueAtTime(instrument===0?42:160,when+.16);
      gain.gain.setValueAtTime((instrument===0?.8:.3)*level,when);gain.gain.exponentialRampToValueAtTime(.0001,when+.23);source.connect(gain);source.start(when);source.stop(when+.25);
    }else{
      const duration=instrument===4?.35:instrument===1?.19:instrument===2?.13:.055;
      const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate);const samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=Math.random()*2-1;
      source=context.createBufferSource();source.buffer=buffer;filter=context.createBiquadFilter();filter.type=instrument===2?"bandpass":"highpass";filter.frequency.value=instrument===1?1200:instrument===2?1500:6800;filter.Q.value=.7;
      source.connect(filter);filter.connect(gain);gain.gain.setValueAtTime((instrument===1?.45:instrument===2?.55:.25)*level,when);gain.gain.exponentialRampToValueAtTime(.0001,when+duration);source.start(when);source.stop(when+duration);
    }
    voices.add(source);source.onended=()=>{voices.delete(source);source.disconnect();filter?.disconnect();gain.disconnect();pan.disconnect();};return source;
  }
  function stopBeat(){
    if(beatRun){clearInterval(beatRun.interval);cancelAnimationFrame(beatRun.raf);for(const node of beatRun.voices){try{node.stop();}catch{}}beatRun.bus.gain.disconnect();beatRun.bus.limiter.disconnect();beatRun=null;}
    $$(".step.is-playing").forEach(node=>node.classList.remove("is-playing"));$("playBeat").textContent="Play arrangement";$("playBeat").setAttribute("aria-pressed","false");$("beatState").textContent="Ready to play";
  }
  function renderGrid(){
    const bank=project.beat.bank;$("beatGrid").replaceChildren(...C.DRUMS.map((name,track)=>{
      const row=element("div",{class:"beat-row"},[element("span",{class:"drum-label",text:name})]);
      project.beat.patterns[bank][track].forEach((velocity,step)=>{
        const button=element("button",{type:"button",class:"step",text:step+1,"data-step":step,"data-track":track,"aria-label":`${name}, step ${step+1}`,"aria-pressed":String(velocity>0),"data-velocity":velocity<.6?"soft":velocity<.9?"medium":"strong"});
        button.addEventListener("click",event=>{if(loading)return;const old=project.beat.patterns[bank][track][step];const values=[0,.45,.8,1];const value=event.shiftKey?values[(values.indexOf(old)+1)%4]:old?0:1;project.beat.patterns[bank][track][step]=value;button.setAttribute("aria-pressed",String(value>0));button.dataset.velocity=value<.6?"soft":value<.9?"medium":"strong";button.title=`${Math.round(value*100)}% velocity`;changed();});row.append(button);
      });return row;
    }));
  }
  function renderBeat(){
    $("beatTempo").value=project.beat.bpm;$("beatTempoValue").textContent=`${project.beat.bpm} BPM`;$("beatSwing").value=project.beat.swing;$("beatSwingValue").textContent=`${project.beat.swing}%`;$("beatMaster").value=project.beat.volume;$("beatMasterValue").textContent=`${project.beat.volume}%`;$("beatArrangement").value=project.beat.arrangement;$("beatCycles").value=project.beat.cycles;
    $$("[data-bank]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.bank===project.beat.bank)));$("copyBank").textContent=`Copy ${project.beat.bank} to ${project.beat.bank==="A"?"B":"A"}`;renderGrid();
  }
  function renderMixer(){
    $("beatMixer").replaceChildren(...project.beat.tracks.map((track,i)=>{
      const mute=action(track.muted?"Muted":"Mute",()=>{track.muted=!track.muted;mute.textContent=track.muted?"Muted":"Mute";mute.setAttribute("aria-pressed",String(track.muted));changed();},`Mute ${track.name}`);mute.classList.add("mute");mute.setAttribute("aria-pressed",String(track.muted));
      return element("div",{class:"mixer-strip"},[element("strong",{text:track.name}),inputField(`${track.name} level`,track.volume,v=>track.volume=Number(v),{type:"range",min:0,max:100}),inputField(`${track.name} pan`,track.pan,v=>track.pan=Number(v),{type:"range",min:-1,max:1,step:.05}),mute]);
    }));
  }
  $$("[data-bank]").forEach(button=>button.addEventListener("click",()=>{if(loading)return;project.beat.bank=button.dataset.bank;renderBeat();changed();}));
  $("loadGroove").addEventListener("click",async()=>{if(loading)return;if(!await ask("Load this starter groove?",`This replaces Pattern ${project.beat.bank}. Your other pattern bank is kept.`,"Load groove"))return;stopBeat();project.beat.patterns[project.beat.bank]=C.groove($("grooveType").value);renderGrid();changed();});
  $("copyBank").addEventListener("click",async()=>{const from=project.beat.bank,to=from==="A"?"B":"A";if(loading||!await ask(`Copy Pattern ${from} to ${to}?`,`Pattern ${to} will be replaced by a copy of ${from}.`,"Copy pattern"))return;project.beat.patterns[to]=clone(project.beat.patterns[from]);changed();note(`Pattern ${from} copied to ${to}.`);});
  for(const [id,key,output,suffix]of[["beatTempo","bpm","beatTempoValue"," BPM"],["beatSwing","swing","beatSwingValue","%"],["beatMaster","volume","beatMasterValue","%"]])$(id).addEventListener("input",()=>{if(loading)return;project.beat[key]=Number($(id).value);$(output).textContent=$(id).value+suffix;if(key==="volume"&&beatRun)beatRun.bus.gain.gain.value=project.beat.volume/100*.75;else if(beatRun)stopBeat();changed();});
  $("beatArrangement").addEventListener("change",()=>{stopBeat();project.beat.arrangement=$("beatArrangement").value;changed();});$("beatCycles").addEventListener("input",()=>{project.beat.cycles=Math.max(1,Math.min(8,Math.round(Number($("beatCycles").value)||1)));changed();});
  $("playBeat").addEventListener("click",async()=>{
    if(loading)return;if(beatRun){stopBeat();return;}const button=$("playBeat");button.disabled=true;
    try{
      await stopSession();stopClip();const context=await getAudio();const base=60/project.beat.bpm/4;const banks=project.beat.arrangement.split("");
      const run={context,bus:outputBus(context,project.beat.volume),voices:new Set(),origin:context.currentTime+.08,step:0,interval:null,raf:null};beatRun=run;
      const schedule=()=>{if(beatRun!==run)return;let time=run.origin+run.step*base+(run.step%2?base*project.beat.swing/100:0);while(time<context.currentTime+.12){const bank=banks[Math.floor(run.step/16)%banks.length];const step=run.step%16;project.beat.patterns[bank].forEach((row,i)=>{if(row[step]&&!project.beat.tracks[i].muted)drum(context,run.bus.gain,i,time,row[step],project.beat.tracks[i],run.voices);});run.step++;time=run.origin+run.step*base+(run.step%2?base*project.beat.swing/100:0);}};
      const paint=()=>{if(beatRun!==run)return;const elapsed=Math.max(0,context.currentTime-run.origin);let step=Math.floor(elapsed/base);if(step%2&&elapsed<step*base+base*project.beat.swing/100)step--;const bank=banks[Math.floor(step/16)%banks.length];$$(".step").forEach(b=>b.classList.toggle("is-playing",bank===project.beat.bank&&Number(b.dataset.step)===step%16));$("beatState").textContent=`Pattern ${bank} · beat ${Math.floor(step%16/4)+1} / 4`;run.raf=requestAnimationFrame(paint);};
      schedule();run.interval=setInterval(schedule,25);run.raf=requestAnimationFrame(paint);button.textContent="Stop arrangement";button.setAttribute("aria-pressed","true");
    }catch(error){stopBeat();note(error.message);}finally{button.disabled=false;}
  });
  async function renderBeatAudio(beat,stem=-1){
    const plan=C.beatEvents(beat,stem);const context=new OfflineAudioContext(2,Math.ceil((plan.duration+.55)*44100),44100);const bus=outputBus(context,beat.volume);
    for(const e of plan.events)drum(context,bus.gain,e.track,e.time,e.velocity,beat.tracks[e.track]);return context.startRendering();
  }
  function wavBlob(buffer){return new Blob([C.wavBytes(Array.from({length:Math.min(2,buffer.numberOfChannels)},(_,i)=>buffer.getChannelData(i)),buffer.sampleRate)],{type:"audio/wav"});}
  $("exportBeat").addEventListener("click",async()=>{const button=$("exportBeat");button.disabled=true;try{const stem=Number($("beatStem").value);const buffer=await renderBeatAudio(clone(project.beat),stem);download(wavBlob(buffer),stem<0?"beat-mix.wav":`${C.filename(C.DRUMS[stem])}-stem.wav`);}catch(error){note(`Beat export couldn't finish: ${error.message}`);}finally{button.disabled=false;}});

  async function decodeBlob(blob){
    if(!audioContext){const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error("Audio decoding is unavailable.");audioContext=new Audio();}
    return audioContext.decodeAudioData(await blob.arrayBuffer());
  }
  function drawWave(canvas,buffer,range=null){
    const pen=canvas.getContext("2d");const w=canvas.width,h=canvas.height;pen.fillStyle="#0d1420";pen.fillRect(0,0,w,h);
    if(!buffer)return;const samples=buffer.getChannelData(0);const step=Math.max(1,Math.floor(samples.length/w));
    if(range){pen.fillStyle="#2e2b49";pen.fillRect(range.start/buffer.duration*w,0,(range.end-range.start)/buffer.duration*w,h);}
    pen.strokeStyle="#b4a1ff";pen.lineWidth=1;pen.beginPath();
    for(let x=0;x<w;x++){let min=0,max=0;const start=Math.floor(x/w*samples.length);const end=Math.min(samples.length,start+step);const stride=Math.max(1,Math.floor(step/80));for(let i=start;i<end;i+=stride){min=Math.min(min,samples[i]);max=Math.max(max,samples[i]);}pen.moveTo(x,h/2+min*h*.44);pen.lineTo(x,h/2+max*h*.44);}pen.stroke();
    if(range){pen.strokeStyle="#ecc27b";pen.lineWidth=2;for(const time of [range.start,range.end]){const x=time/buffer.duration*w;pen.beginPath();pen.moveTo(x,0);pen.lineTo(x,h);pen.stroke();}}
  }
  function renderClip(){
    $("audioEmpty").hidden=!!clipBuffer;$("audioLoaded").hidden=!clipBuffer;if(!clipBuffer)return;
    const settings=C.trimSettings(project.audio,clipBuffer.duration);project.audio.start=settings.start;project.audio.end=settings.end;
    $("audioName").textContent=project.audio.name;$("audioLength").textContent=`${clipBuffer.duration.toFixed(2)} seconds · ${clipBuffer.numberOfChannels} channel${clipBuffer.numberOfChannels===1?"":"s"}`;
    $("audioStart").value=settings.start.toFixed(2);$("audioStart").max=Math.max(0,clipBuffer.duration-.01);$("audioEnd").value=settings.end.toFixed(2);$("audioEnd").max=clipBuffer.duration;$("audioRate").value=project.audio.rate;$("audioFade").value=project.audio.fade;$("audioVolume").value=project.audio.volume;
    drawWave($("audioWave"),clipBuffer,settings);$("clipState").textContent=`Selected export: ${settings.seconds.toFixed(2)} seconds`;
  }
  function stopClip(){if(clipSource){const source=clipSource;clipSource=null;try{source.stop();}catch{}}$("previewAudio").textContent="Preview region";}
  function clipGain(context,settings,destination,at){
    const gain=context.createGain();gain.connect(destination);gain.gain.setValueAtTime(settings.fade?0:settings.volume,at);
    if(settings.fade){gain.gain.linearRampToValueAtTime(settings.volume,at+settings.fade);gain.gain.setValueAtTime(settings.volume,at+settings.seconds-settings.fade);gain.gain.linearRampToValueAtTime(0,at+settings.seconds);}return gain;
  }
  $("audioImport").addEventListener("change",async()=>{
    const file=$("audioImport").files[0];$("audioImport").value="";if(!file||loading)return;const epoch=projectEpoch;
    try{stopClip();note("Reading your audio file…");const decoded=await decodeBlob(file);if(epoch!==projectEpoch)return;
      if(decoded.duration<.01)throw new Error("The clip is too short to edit.");audioBlob=file;clipBuffer=decoded;project.audio={name:file.name,start:0,end:decoded.duration,rate:1,volume:80,fade:.02};renderClip();changed();note("Audio loaded into this project. Choose the region you want to keep.");
    }catch(error){note(`Couldn't read this audio file: ${error.message}`);}
  });
  for(const [id,key]of[["audioStart","start"],["audioEnd","end"],["audioRate","rate"],["audioFade","fade"],["audioVolume","volume"]])$(id).addEventListener("change",()=>{if(loading||!clipBuffer)return;stopClip();project.audio[key]=Number($(id).value);project.audio=C.normalizeProject(project).audio;renderClip();changed();});
  $("previewAudio").addEventListener("click",async()=>{
    if(!clipBuffer||loading)return;if(clipSource){stopClip();return;}try{await stopSession();stopBeat();const context=await getAudio();const settings=C.trimSettings(project.audio,clipBuffer.duration);const source=context.createBufferSource();source.buffer=clipBuffer;source.playbackRate.value=settings.rate;const gain=clipGain(context,settings,context.destination,context.currentTime);source.connect(gain);clipSource=source;
      source.onended=()=>{source.disconnect();gain.disconnect();if(clipSource===source){clipSource=null;$("previewAudio").textContent="Preview region";$("clipState").textContent="Preview finished";}};source.start(0,settings.start,settings.end-settings.start);$("previewAudio").textContent="Stop preview";$("clipState").textContent="Playing selected region";
    }catch(error){stopClip();note(error.message);}
  });
  async function renderedClip(){const settings=C.trimSettings(project.audio,clipBuffer.duration);const context=new OfflineAudioContext(Math.min(2,clipBuffer.numberOfChannels),Math.max(1,Math.ceil(settings.seconds*44100)),44100);const source=context.createBufferSource();source.buffer=clipBuffer;source.playbackRate.value=settings.rate;source.connect(clipGain(context,settings,context.destination,0));source.start(0,settings.start,settings.end-settings.start);return context.startRendering();}
  $("exportAudio").addEventListener("click",async()=>{if(!clipBuffer)return;const button=$("exportAudio");button.disabled=true;try{download(wavBlob(await renderedClip()),"edited-clip.wav");}catch(error){note(error.message);}finally{button.disabled=false;}});

  let sessionRun=null;let capture=null;let recordingRequest=0;let recordRequestPending=false;let removedTake=null;
  function sessionDuration(beatBuffer){return Math.max(beatBuffer?.duration||0,...project.recording.tracks.filter(t=>!t.muted&&takeBuffers[t.id]).map(t=>t.start+takeBuffers[t.id].duration),.1);}
  async function sessionBeat(){if(!project.recording.beatEnabled)return null;const beat=clone(project.beat);beat.cycles=project.recording.beatRepeats;return renderBeatAudio(beat);}
  function addSessionSources(context,bus,at,beatBuffer){
    const sources=new Set(),trackNodes=Object.create(null);
    if(beatBuffer){const source=context.createBufferSource();source.buffer=beatBuffer;source.connect(bus.gain);source.start(at);sources.add(source);source.onended=()=>{sources.delete(source);source.disconnect();};}
    for(const track of project.recording.tracks){const buffer=takeBuffers[track.id];if(!buffer)continue;const source=context.createBufferSource();source.buffer=buffer;const gain=context.createGain();gain.gain.value=track.muted?0:track.volume/100;const pan=context.createStereoPanner();pan.pan.value=track.pan;source.connect(gain);gain.connect(pan);pan.connect(bus.gain);source.start(at+track.start);sources.add(source);trackNodes[track.id]={gain,pan};source.onended=()=>{sources.delete(source);source.disconnect();gain.disconnect();pan.disconnect();delete trackNodes[track.id];};}
    return {sources,trackNodes};
  }
  function clearPlayback(){if(sessionRun){clearInterval(sessionRun.timer);for(const node of sessionRun.sources){try{node.stop();}catch{}}sessionRun.bus.gain.disconnect();sessionRun.bus.limiter.disconnect();sessionRun=null;}$("playMix").textContent="Play session";if(!capture){$("stopRecording").disabled=true;$("recordState").textContent="Ready for your next take";}}
  function syncTakeMix(track){const nodes=sessionRun?.trackNodes[track.id];if(nodes){nodes.gain.gain.value=track.muted?0:track.volume/100;nodes.pan.pan.value=track.pan;}}
  async function addTake(blob,buffer,name){
    if(project.recording.tracks.length>=32)throw new Error("This project has 32 takes. Start another project for more tracks.");
    const id=uid();takeBlobs[id]=blob;takeBuffers[id]=buffer;project.recording.tracks.push({id,name,start:0,seconds:buffer.duration,volume:80,pan:0,muted:false});renderTakes();changed();await saveNow();
  }
  function renderTakes(){
    const container=$("recordTracks");container.replaceChildren();
    if(!project.recording.tracks.length)container.append(element("p",{class:"empty-note",text:"Record a take or import audio to start layering your session."}));
    project.recording.tracks.forEach((track,index)=>{
      const mute=action(track.muted?"Unmute":"Mute",()=>{track.muted=!track.muted;mute.textContent=track.muted?"Unmute":"Mute";mute.setAttribute("aria-pressed",String(track.muted));syncTakeMix(track);changed();},`Mute take ${index+1}`);mute.classList.add("mute");mute.setAttribute("aria-pressed",String(track.muted));
      const remove=action("Remove",async()=>{if(capture)return note("Stop recording before changing the track list.");if(!await ask("Remove this take?","This removes the take from this project. You can undo the removal while this project stays open, or restore an exported backup.","Remove take"))return;await stopSession();removedTake={track:clone(track),blob:takeBlobs[track.id],buffer:takeBuffers[track.id],index,projectId:project.id};project.recording.tracks.splice(index,1);delete takeBlobs[track.id];delete takeBuffers[track.id];renderTakes();changed();},`Remove take ${index+1}`);
      const wave=element("canvas",{class:"take-wave",width:1100,height:90,"aria-label":`${track.name} waveform`});drawWave(wave,takeBuffers[track.id]);
      container.append(element("article",{class:"take-track"},[element("div",{class:"take-heading"},[inputField(`Take ${index+1} name`,track.name,v=>track.name=v),mute,remove]),wave,element("span",{class:"take-length",text:takeBuffers[track.id]?`${takeBuffers[track.id].duration.toFixed(2)} seconds`:(takeBlobs[track.id]?"Reading saved audio…":"Audio file missing · import the original take")}),element("div",{class:"take-mixer"},[
        inputField(`Take ${index+1} level`,track.volume,v=>{track.volume=Number(v);syncTakeMix(track);},{type:"range",min:0,max:100}),inputField(`Take ${index+1} pan`,track.pan,v=>{track.pan=Number(v);syncTakeMix(track);},{type:"range",min:-1,max:1,step:.05}),inputField(`Take ${index+1} offset (sec)`,track.start,v=>{track.start=Math.max(0,Math.min(3600,Number(v)||0));if(sessionRun&&!capture)clearPlayback();},{type:"number",min:0,max:3600,step:.01})
      ])]));
    });
    if(removedTake&&removedTake.projectId===project.id)container.append(action("Undo take removal",()=>{project.recording.tracks.splice(removedTake.index,0,removedTake.track);takeBlobs[removedTake.track.id]=removedTake.blob;takeBuffers[removedTake.track.id]=removedTake.buffer;removedTake=null;renderTakes();changed();}));
  }
  $("takeImport").addEventListener("change",async()=>{const files=[...$("takeImport").files];$("takeImport").value="";if(loading||capture)return;const epoch=projectEpoch;for(const file of files){try{note(`Reading ${file.name}…`);const buffer=await decodeBlob(file);if(epoch!==projectEpoch)return;await addTake(file,buffer,file.name);note("Take imported. Set its level, pan, and offset, then play your session.");}catch(error){note(`Couldn't import ${file.name}: ${error.message}`);}}});
  for(const [id,key]of[["recordBeat","beatEnabled"],["recordRepeats","beatRepeats"],["recordMaster","master"],["recordCountIn","countIn"]])$(id).addEventListener("input",()=>{if(loading)return;project.recording[key]=key==="beatEnabled"?$(id).checked:Number($(id).value);project.recording=C.normalizeProject(project).recording;if(key==="master"&&sessionRun)sessionRun.bus.gain.gain.value=project.recording.master/100*.75;changed();});
  $("playMix").addEventListener("click",async()=>{
    if(loading||capture||recordRequestPending)return;if(sessionRun){clearPlayback();return;}const button=$("playMix");button.disabled=true;
    try{stopBeat();stopClip();const context=await getAudio();const epoch=projectEpoch;const beatBuffer=await sessionBeat();if(epoch!==projectEpoch)return;const bus=outputBus(context,project.recording.master);const at=context.currentTime+.08;const sources=addSessionSources(context,bus,at,beatBuffer);const duration=sessionDuration(beatBuffer);const run={bus,...sources,at,timer:null};sessionRun=run;button.textContent="Stop session";$("stopRecording").disabled=false;$("recordState").textContent="Session playing";
      run.timer=setInterval(()=>{if(sessionRun!==run)return;const elapsed=Math.max(0,context.currentTime-at);$("recordClock").textContent=clock(elapsed);if(elapsed>=duration){clearPlayback();$("recordState").textContent="Playback complete";}},100);
    }catch(error){clearPlayback();note(error.message);}finally{button.disabled=false;}
  });
  $("exportMix").addEventListener("click",async()=>{
    if(capture)return note("Stop recording before exporting your session.");const button=$("exportMix");button.disabled=true;
    try{for(const t of project.recording.tracks)if(!t.muted&&!takeBuffers[t.id])throw new Error(`The audio for ${t.name} isn't loaded. Import it or mute that track.`);
      const beatBuffer=await sessionBeat();const duration=sessionDuration(beatBuffer);const context=new OfflineAudioContext(2,Math.ceil((duration+.05)*44100),44100);const bus=outputBus(context,project.recording.master);addSessionSources(context,bus,0,beatBuffer);download(wavBlob(await context.startRendering()),"recording-session.wav");
    }catch(error){note(`Session export couldn't finish: ${error.message}`);}finally{button.disabled=false;}
  });

  function recordButtons(busy){$("recordTake").disabled=busy;$("demoTake").disabled=busy;$("playMix").disabled=busy;$("takeImport").disabled=busy;$("stopRecording").disabled=!busy;$("recordTake").setAttribute("aria-pressed",String(!!capture));}
  async function stopSession(){
    recordingRequest++;recordRequestPending=false;
    if(capture){capture.stop();return capture.done;}
    clearPlayback();recordButtons(false);
  }
  async function beginCapture(demo=false){
    if(loading||capture||recordRequestPending)return;
    if(project.recording.tracks.length>=32)return note("This project has 32 takes. Start another project to keep recording.");
    await stopSession();stopBeat();stopClip();const request=++recordingRequest,epoch=projectEpoch;recordRequestPending=true;recordButtons(true);let stream=null;
    try{
      const context=await getAudio();if(!context.audioWorklet)throw new Error("This browser needs AudioWorklet support for recording. Imported takes and mixing are still available.");
      if(!workletReady){await context.audioWorklet.addModule("css/studio-recorder-worklet.js");workletReady=true;}
      const beatBuffer=demo?null:await sessionBeat();
      if(request!==recordingRequest||epoch!==projectEpoch)return;
      if(!demo){if(!navigator.mediaDevices?.getUserMedia)throw new Error("Microphone access is unavailable. Open the HTTPS studio in a supported browser.");$("recordState").textContent="Waiting for microphone permission…";stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});}
      if(request!==recordingRequest||epoch!==projectEpoch){stream?.getTracks().forEach(t=>t.stop());return;}
      const countIn=demo?0:project.recording.countIn*4*60/project.beat.bpm;const at=context.currentTime+.12+countIn;
      const processor=new AudioWorkletNode(context,"starrise-recorder",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});processor.connect(context.destination);
      let input,demoGain=null;
      if(demo){input=context.createOscillator();input.type="sine";input.frequency.setValueAtTime(220,at);input.frequency.setValueAtTime(330,at+.6);input.frequency.setValueAtTime(440,at+1.2);demoGain=context.createGain();demoGain.gain.value=.18;input.connect(demoGain);demoGain.connect(processor);}
      else {input=context.createMediaStreamSource(stream);input.connect(processor);}
      const bus=outputBus(context,project.recording.master);const backing=demo?{sources:new Set(),trackNodes:Object.create(null)}:addSessionSources(context,bus,at,beatBuffer);
      let resolveDone;const run={processor,input,demoGain,stream,chunks:[],sampleRate:context.sampleRate,epoch,projectId:project.id,stopping:false,finished:false,timer:null,fallback:null,done:new Promise(resolve=>{resolveDone=resolve;})};
      const finalize=async()=>{
        if(run.finished)return;run.finished=true;clearInterval(run.timer);clearTimeout(run.fallback);
        run.stream?.getTracks().forEach(t=>t.stop());try{if(demo)run.input.stop();}catch{}run.input.disconnect();run.demoGain?.disconnect();run.processor.disconnect();clearPlayback();
        try{
          const length=run.chunks.reduce((total,chunk)=>total+chunk.length,0);
          if(length&&project.id===run.projectId){const samples=new Float32Array(length);let offset=0;for(const chunk of run.chunks){samples.set(chunk,offset);offset+=chunk.length;}const buffer=context.createBuffer(1,length,run.sampleRate);buffer.copyToChannel(samples,0);const blob=wavBlob(buffer);await addTake(blob,buffer,demo?"Demo take (synthesized tone)":`Vocal take ${project.recording.tracks.length+1}`);$("recordState").textContent=demo?"Demo take saved":"Vocal take saved";note(demo?"Demo captured through the recording engine. Play or export the session to hear it.":"Vocal take saved to this project. Adjust its level and alignment, then play your mix.");}
          else note("Recording stopped before a take began.");
        }catch(error){note(`Couldn't finish this take: ${error.message}`);}
        finally{if(capture===run)capture=null;recordRequestPending=false;recordButtons(false);resolveDone();}
      };
      run.stop=()=>{if(run.stopping)return;run.stopping=true;$("recordState").textContent="Finishing take…";processor.port.postMessage({type:"stop"});run.stream?.getTracks().forEach(t=>t.stop());run.fallback=setTimeout(()=>void finalize(),1200);};
      processor.port.onmessage=event=>{if(event.data?.type==="samples"&&!run.finished)run.chunks.push(event.data.samples);if(event.data?.type==="done")void finalize();};
      processor.onprocessorerror=()=>{note("The recording engine stopped. Finishing the captured part of this take.");run.stop();};
      capture=run;recordRequestPending=false;sessionRun={bus,...backing,at,timer:null};
      processor.port.postMessage({type:"start",startFrame:Math.round(at*context.sampleRate)});
      if(demo){input.onended=()=>run.stop();input.start(at);input.stop(at+2);}else stream.getAudioTracks().forEach(track=>track.addEventListener("ended",()=>run.stop(),{once:true}));
      if(countIn){for(let i=0;i<4;i++){const when=at-countIn+i*60/project.beat.bpm;const beep=context.createOscillator(),gain=context.createGain();beep.frequency.value=i===0?880:660;gain.gain.setValueAtTime(.1,when);gain.gain.exponentialRampToValueAtTime(.0001,when+.08);beep.connect(gain);gain.connect(bus.gain);beep.start(when);beep.stop(when+.09);backing.sources.add(beep);beep.onended=()=>{backing.sources.delete(beep);beep.disconnect();gain.disconnect();};}}
      run.timer=setInterval(()=>{const elapsed=context.currentTime-at;$("recordClock").textContent=clock(Math.max(0,elapsed));$("recordState").textContent=elapsed<0?`Count-in · ${Math.ceil(-elapsed/(60/project.beat.bpm))} beats`:(demo?"Capturing demo tone…":"Recording vocal take…");if(elapsed>=600)run.stop();},100);
      recordButtons(true);
    }catch(error){stream?.getTracks().forEach(t=>t.stop());clearPlayback();$("recordState").textContent="Recording not started";note(error.name==="NotAllowedError"?"Microphone permission wasn't granted. You can still import takes or try the recording demo.":error.message);}
    finally{if(!capture&&request===recordingRequest){recordRequestPending=false;recordButtons(false);}}
  }
  $("recordTake").addEventListener("click",()=>void beginCapture(false));$("demoTake").addEventListener("click",()=>void beginCapture(true));$("stopRecording").addEventListener("click",()=>void stopSession());

  const artCanvas=$("artCanvas"),artPen=artCanvas.getContext("2d");
  const layerCanvases=Array.from({length:3},()=>{const canvas=document.createElement("canvas");canvas.width=1200;canvas.height=1200;return canvas;});
  let artDirty=false;const artUndo=[],artRedo=[];let drawing=null;let brushPoint={x:600,y:600};
  function serializeArt(){if(!artDirty)return;project.art.layers.forEach((layer,i)=>layer.image=layerCanvases[i].toDataURL("image/png"));artDirty=false;}
  async function loadArt(){
    artUndo.length=0;artRedo.length=0;drawing=null;brushPoint={x:600,y:600};
    await Promise.all(project.art.layers.map(async(layer,index)=>{
      const pen=layerCanvases[index].getContext("2d");pen.clearRect(0,0,1200,1200);if(!layer.image)return;
      try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=layer.image;});pen.drawImage(image,0,0,1200,1200);}catch{note("A saved art layer couldn't be drawn here. Its original data remains in the project backup until you change the artwork.");}
    }));artDirty=false;$("artBackground").value=project.art.background;
  }
  function renderArt(preview=null){
    artPen.globalCompositeOperation="source-over";artPen.fillStyle=project.art.background;artPen.fillRect(0,0,1200,1200);project.art.layers.forEach((layer,i)=>{if(layer.visible)artPen.drawImage(layerCanvases[i],0,0);});
    if(preview){artPen.strokeStyle=$("artColor").value;artPen.lineWidth=Number($("artSize").value);artPen.lineCap="round";artPen.beginPath();if(preview.tool==="line"){artPen.moveTo(preview.start.x,preview.start.y);artPen.lineTo(preview.end.x,preview.end.y);}else artPen.rect(preview.start.x,preview.start.y,preview.end.x-preview.start.x,preview.end.y-preview.start.y);artPen.stroke();}
    $("undoArt").disabled=!artUndo.length;$("redoArt").disabled=!artRedo.length;
  }
  function rememberArt(index=project.art.active){artUndo.push({index,pixels:layerCanvases[index].getContext("2d").getImageData(0,0,1200,1200)});if(artUndo.length>8)artUndo.shift();artRedo.length=0;}
  function artChanged(){artDirty=true;renderArt();changed();}
  function renderLayers(){
    $("artLayers").replaceChildren(...project.art.layers.map((layer,i)=>{
      const button=element("button",{type:"button",text:layer.name,"aria-pressed":String(project.art.active===i),"aria-label":`Select ${layer.name} layer`,onClick:()=>{project.art.active=i;layer.visible=true;renderLayers();renderArt();changed();}});
      const visible=element("input",{type:"checkbox","aria-label":`Show ${layer.name} layer`});visible.checked=layer.visible;visible.addEventListener("change",()=>{layer.visible=visible.checked;renderArt();changed();});return element("div",{class:"layer-item"},[visible,button]);
    }));
  }
  function artPoint(event){const bounds=artCanvas.getBoundingClientRect();return {x:(event.clientX-bounds.left)/bounds.width*1200,y:(event.clientY-bounds.top)/bounds.height*1200};}
  function drawStroke(from,to,tool,index){
    const pen=layerCanvases[index].getContext("2d");pen.globalCompositeOperation=tool==="eraser"?"destination-out":"source-over";pen.strokeStyle=$("artColor").value;pen.lineWidth=Number($("artSize").value);pen.lineCap="round";pen.lineJoin="round";pen.beginPath();pen.moveTo(from.x,from.y);pen.lineTo(to.x,to.y);pen.stroke();pen.globalCompositeOperation="source-over";
  }
  function drawDot(point,tool,index){const pen=layerCanvases[index].getContext("2d");pen.globalCompositeOperation=tool==="eraser"?"destination-out":"source-over";pen.fillStyle=$("artColor").value;pen.beginPath();pen.arc(point.x,point.y,Number($("artSize").value)/2,0,Math.PI*2);pen.fill();pen.globalCompositeOperation="source-over";}
  artCanvas.addEventListener("pointerdown",event=>{
    if(loading||event.button!==0||drawing)return;if(!project.art.layers[project.art.active].visible)return note("Show the selected layer before drawing on it.");
    event.preventDefault();const point=artPoint(event);rememberArt();drawing={id:event.pointerId,start:point,last:point,end:point,index:project.art.active,tool:$("artTool").value};brushPoint=point;artCanvas.setPointerCapture(event.pointerId);
    if(["brush","eraser"].includes(drawing.tool))drawDot(point,drawing.tool,drawing.index);renderArt();
  });
  artCanvas.addEventListener("pointermove",event=>{if(!drawing||event.pointerId!==drawing.id)return;const point=artPoint(event);if(["brush","eraser"].includes(drawing.tool)){drawStroke(drawing.last,point,drawing.tool,drawing.index);renderArt();}else renderArt({...drawing,end:point});drawing.last=point;drawing.end=point;brushPoint=point;});
  function endArt(event){
    if(!drawing||event.pointerId!==drawing.id)return;const current=drawing;
    if(current.tool==="line")drawStroke(current.start,current.end,"brush",current.index);
    if(current.tool==="rectangle"){const pen=layerCanvases[current.index].getContext("2d");pen.strokeStyle=$("artColor").value;pen.lineWidth=Number($("artSize").value);pen.strokeRect(current.start.x,current.start.y,current.end.x-current.start.x,current.end.y-current.start.y);}
    if(artCanvas.hasPointerCapture(current.id))artCanvas.releasePointerCapture(current.id);drawing=null;artChanged();
  }
  artCanvas.addEventListener("pointerup",endArt);artCanvas.addEventListener("pointercancel",endArt);
  artCanvas.addEventListener("keydown",event=>{
    if(loading||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(event.key))return;event.preventDefault();
    if(event.key===" "){if(!project.art.layers[project.art.active].visible)return note("Show the selected layer first.");rememberArt();drawDot(brushPoint,$("artTool").value,project.art.active);artChanged();$("artState").textContent="Brush mark added.";return;}
    const distance=event.shiftKey?50:10;if(event.key==="ArrowLeft")brushPoint.x-=distance;if(event.key==="ArrowRight")brushPoint.x+=distance;if(event.key==="ArrowUp")brushPoint.y-=distance;if(event.key==="ArrowDown")brushPoint.y+=distance;brushPoint.x=Math.max(0,Math.min(1200,brushPoint.x));brushPoint.y=Math.max(0,Math.min(1200,brushPoint.y));$("artState").textContent=`Brush position: ${Math.round(brushPoint.x)}, ${Math.round(brushPoint.y)}. Space adds a mark.`;
  });
  $("artBackground").addEventListener("input",()=>{if(loading)return;project.art.background=$("artBackground").value;renderArt();changed();});$("artSize").addEventListener("input",()=>$("artSizeValue").textContent=`${$("artSize").value} px`);
  function artHistory(from,to){const snapshot=from.pop();if(!snapshot)return;const pen=layerCanvases[snapshot.index].getContext("2d");to.push({index:snapshot.index,pixels:pen.getImageData(0,0,1200,1200)});pen.putImageData(snapshot.pixels,0,0);artChanged();}
  $("undoArt").addEventListener("click",()=>artHistory(artUndo,artRedo));$("redoArt").addEventListener("click",()=>artHistory(artRedo,artUndo));
  $("clearLayer").addEventListener("click",async()=>{if(loading||!await ask("Clear the selected layer?","Other layers are kept. Undo can bring this layer back during this session.","Clear layer"))return;rememberArt();layerCanvases[project.art.active].getContext("2d").clearRect(0,0,1200,1200);artChanged();});
  $("stampText").addEventListener("click",()=>{if(loading)return;const text=$("artText").value.trim();if(!text)return note("Add the lettering you want on your cover.");rememberArt();const pen=layerCanvases[project.art.active].getContext("2d");pen.fillStyle=$("artColor").value;pen.textAlign="center";pen.textBaseline="middle";pen.font=`800 ${Math.max(12,Math.min(200,Number($("artFontSize").value)||90))}px Arial`;pen.fillText(text,600,brushPoint.y,1120);artChanged();note("Lettering added to the selected layer.");});
  $("imageImport").addEventListener("change",async()=>{const file=$("imageImport").files[0];$("imageImport").value="";if(!file||loading)return;const epoch=projectEpoch,index=project.art.active;const url=URL.createObjectURL(file);
    try{if(!["image/png","image/jpeg","image/webp"].includes(file.type)&&!(file.type===""&&/\.(png|jpe?g|webp)$/i.test(file.name)))throw new Error("Choose a PNG, JPEG, or WebP image.");const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error("This image couldn't be decoded."));image.src=url;});if(epoch!==projectEpoch)return;rememberArt(index);const scale=Math.min(1200/image.width,1200/image.height);const w=image.width*scale,h=image.height*scale;layerCanvases[index].getContext("2d").drawImage(image,(1200-w)/2,(1200-h)/2,w,h);artChanged();note("Image added to the selected layer.");}catch(error){note(error.message);}finally{URL.revokeObjectURL(url);}
  });
  $("exportArt").addEventListener("click",()=>{renderArt();artCanvas.toBlob(blob=>{if(blob)download(blob,"cover.png");else note("Your browser couldn't export this artwork.");},"image/png");});

  function storySummary(){const seconds=project.story.scenes.reduce((total,s)=>total+s.seconds,0);$("storyDuration").textContent=`${project.story.scenes.length} scenes · ${seconds} seconds planned`;}
  function renderStory(){
    $("storyLogline").value=project.story.logline;$("storyScenes").replaceChildren(...project.story.scenes.map((scene,index)=>element("article",{class:"draft-card"},[
      element("div",{class:"draft-top"},[inputField(`Scene ${index+1} title`,scene.title,v=>scene.title=v),reorderActions(project.story.scenes,index,renderStory,`scene ${index+1}`)]),
      element("div",{class:"scene-fields"},[inputField(`Scene ${index+1} location`,scene.location,v=>scene.location=v),selectField(`Scene ${index+1} shot`,scene.shot,["Wide","Medium","Close","Detail","Tracking"],v=>scene.shot=v),inputField(`Scene ${index+1} seconds`,scene.seconds,v=>{scene.seconds=Math.max(0,Math.min(3600,Number(v)||0));storySummary();},{type:"number",min:0,max:3600})]),
      element("div",{class:"scene-texts"},[inputField(`Scene ${index+1} action`,scene.action,v=>scene.action=v,{tag:"textarea",rows:4}),inputField(`Scene ${index+1} dialogue or voiceover`,scene.dialogue,v=>scene.dialogue=v,{tag:"textarea",rows:4})])
    ])));storySummary();
  }
  $("storyLogline").addEventListener("input",()=>{if(!loading){project.story.logline=$("storyLogline").value;changed();}});$("storyPrompt").addEventListener("click",()=>$("storyPromptText").textContent=pick(prompts.story));
  $("addScene").addEventListener("click",()=>{if(loading)return;if(project.story.scenes.length>=100)return note("This project has 100 scenes. Start another project to continue planning.");project.story.scenes.push({title:`Scene ${project.story.scenes.length+1}`,location:"",shot:"Medium",seconds:15,action:"",dialogue:""});renderStory();changed();});
  $("copyScript").addEventListener("click",()=>void copy(C.scriptText(project)));$("exportScript").addEventListener("click",()=>textExport(C.scriptText(project),"script.txt"));$("exportShotlist").addEventListener("click",()=>textExport(C.shotCsv(project),"shot-list.csv","text/csv;charset=utf-8"));
  let rehearsalTimer=null,rehearsalEnd=0,rehearsalRemaining=180,prompterFrame=null,prompterLast=0;
  function stopScroll(){cancelAnimationFrame(prompterFrame);prompterFrame=null;prompterLast=0;$("scrollPrompter").textContent="Start scrolling";}
  function stopStage(){clearInterval(rehearsalTimer);rehearsalTimer=null;rehearsalRemaining=project.stage.minutes*60;$("stageClock").textContent=clock(rehearsalRemaining);$("startTimer").textContent="Start rehearsal";stopScroll();}
  function setSummary(){const minutes=project.stage.setlist.reduce((total,s)=>total+s.minutes,0);$("setDuration").textContent=`${project.stage.setlist.length} ${project.stage.setlist.length===1?"entry":"entries"} · ${minutes.toFixed(1).replace(/\.0$/,"")} minutes`;}
  function renderStage(){
    $("setlist").replaceChildren(...project.stage.setlist.map((item,index)=>element("article",{class:"draft-card"},[
      element("div",{class:"draft-top"},[inputField(`Setlist ${index+1} title`,item.title,v=>item.title=v),reorderActions(project.stage.setlist,index,renderStage,`setlist entry ${index+1}`)]),
      element("div",{class:"set-fields"},[inputField(`Setlist ${index+1} minutes`,item.minutes,v=>{item.minutes=Math.max(0,Math.min(120,Number(v)||0));setSummary();},{type:"number",min:0,max:120,step:.25}),inputField(`Setlist ${index+1} cues`,item.notes,v=>item.notes=v,{tag:"textarea",rows:2})])
    ])));setSummary();$("stageNotes").value=project.stage.notes;$("stageMinutes").value=project.stage.minutes;$("stagePrompter").value=project.stage.prompter;$("prompterText").textContent=project.stage.prompter||"Your words will appear here.";$("prompterSpeed").value=project.stage.speed;$("stageClock").textContent=clock(project.stage.minutes*60);
  }
  $("addSetNumber").addEventListener("click",()=>{if(loading)return;if(project.stage.setlist.length>=100)return note("This project has 100 setlist entries. Create another project for the next set.");project.stage.setlist.push({title:`Number ${project.stage.setlist.length+1}`,minutes:3,notes:""});renderStage();changed();});
  for(const [id,key]of[["stageNotes","notes"],["stagePrompter","prompter"]])$(id).addEventListener("input",()=>{if(loading)return;project.stage[key]=$(id).value;if(key==="prompter"){stopScroll();$("prompterText").textContent=project.stage.prompter||"Your words will appear here.";$("prompterWindow").scrollTop=0;}changed();});
  $("stageMinutes").addEventListener("change",()=>{if(loading)return;project.stage.minutes=Math.max(.25,Math.min(120,Number($("stageMinutes").value)||3));$("stageMinutes").value=project.stage.minutes;stopStage();changed();});
  $("startTimer").addEventListener("click",()=>{
    if(rehearsalTimer){rehearsalRemaining=Math.max(0,(rehearsalEnd-performance.now())/1000);clearInterval(rehearsalTimer);rehearsalTimer=null;$("startTimer").textContent="Resume rehearsal";note("Rehearsal paused.");return;}
    if(rehearsalRemaining<=0)rehearsalRemaining=project.stage.minutes*60;rehearsalEnd=performance.now()+rehearsalRemaining*1000;$("startTimer").textContent="Pause rehearsal";note("Rehearsal started. Make the most of your time.");
    rehearsalTimer=setInterval(()=>{rehearsalRemaining=Math.max(0,(rehearsalEnd-performance.now())/1000);$("stageClock").textContent=clock(Math.ceil(rehearsalRemaining));if(!rehearsalRemaining){clearInterval(rehearsalTimer);rehearsalTimer=null;$("startTimer").textContent="Rehearse again";note("Rehearsal complete. Capture one thing to improve in your notes.");}},100);
  });
  $("resetTimer").addEventListener("click",()=>stopStage());$("useLyrics").addEventListener("click",()=>{stopScroll();project.stage.prompter=C.songText(project);$("stagePrompter").value=project.stage.prompter;$("prompterText").textContent=project.stage.prompter;$("prompterWindow").scrollTop=0;changed();note("Song draft added to your rehearsal prompt.");});
  $("prompterSpeed").addEventListener("input",()=>{project.stage.speed=Number($("prompterSpeed").value);changed();});
  $("scrollPrompter").addEventListener("click",()=>{
    if(prompterFrame){stopScroll();return;}if(!project.stage.prompter.trim())return note("Add lyrics or a script before starting the prompt.");const view=$("prompterWindow");if(view.scrollTop>=view.scrollHeight-view.clientHeight-1)view.scrollTop=0;
    const frame=time=>{if(prompterLast)view.scrollTop+=(time-prompterLast)/1000*project.stage.speed;prompterLast=time;if(view.scrollTop>=view.scrollHeight-view.clientHeight-1){stopScroll();note("Rehearsal prompt finished.");}else prompterFrame=requestAnimationFrame(frame);};prompterFrame=requestAnimationFrame(frame);$("scrollPrompter").textContent="Pause scrolling";
  });
  $("exportSetlist").addEventListener("click",()=>textExport(`${project.name}\n\nSETLIST\n\n${project.stage.setlist.map((s,i)=>`${i+1}. ${s.title} · ${s.minutes} minutes\n${s.notes}`).join("\n\n")}\n\nREHEARSAL NOTES\n${project.stage.notes}\n\nPROMPT\n${project.stage.prompter}`,"setlist.txt"));
  document.addEventListener("visibilitychange",()=>{if(document.hidden){stopBeat();stopClip();stopStage();void stopSession().then(()=>saveNow());}});
  window.addEventListener("pagehide",()=>{stopBeat();stopClip();stopStage();void stopSession().then(()=>saveNow());});
  window.addEventListener("beforeunload",event=>{if(capture||revision>savedRevision){event.preventDefault();event.returnValue="";}});
  async function initialize(){
    let record=null;
    try{database=await openDatabase();database.onversionchange=()=>{database.close();database=null;saveLabel("Storage closed · export a backup","error");};const [stored,active]=await Promise.all([dbRead("projects"),dbRead("settings","active")]);
      for(const item of stored){try{C.normalizeProject(item);projects.set(item.id,item);}catch{}}
      record=projects.get(active);if(record?.archived)record=null;if(!record)record=[...projects.values()].filter(p=>!p.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    }catch{database=null;$("storageNote").textContent="This browser couldn't open project storage. Your work stays in this session; export a backup before leaving.";}
    try{await loadProject(record||project);if(!record){revision++;await saveNow();}const room=new URLSearchParams(location.search).get("room");if(["song","beat","audio","art","story","stage"].includes(room))selectRoom(room);}
    catch(error){loading=false;saveLabel("Project couldn't open","error");note(`Try importing a backup or creating a new project: ${error.message}`);}
  }
  void initialize();
})();
