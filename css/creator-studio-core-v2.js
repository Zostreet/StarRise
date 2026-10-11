(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StarRiseStudioCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DRUMS = ["Kick", "Snare", "Clap", "Closed hat", "Open hat", "Percussion"];
  const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  function fxDefaults() {return {enabled:false,highpass:20,low:0,mid:0,high:0,compressor:false,threshold:-18,ratio:3,attack:10,release:120,makeup:0,reverb:0,decay:1.5,delay:0,delayTime:.25,feedback:.25,saturation:0};}
  function normalizeFx(raw) {
    const f=fxDefaults();if(!raw||typeof raw!=="object")return f;
    f.enabled=raw.enabled===true;f.compressor=raw.compressor===true;
    for(const [key,min,max] of [["highpass",20,600],["low",-18,18],["mid",-18,18],["high",-18,18],["threshold",-60,0],["ratio",1,20],["attack",1,100],["release",20,1000],["makeup",-12,12],["reverb",0,60],["decay",.2,5],["delay",0,60],["delayTime",.05,1.5],["feedback",0,.75],["saturation",0,100]])f[key]=number(raw[key],min,max,f[key]);
    return f;
  }
  const emptyPattern = () => DRUMS.map(() => Array(16).fill(0));
  function groove(name = "hiphop") {
    const p = emptyPattern();
    const put = (row, steps, velocity = 1) => steps.forEach(step => { p[row][step - 1] = velocity; });
    if (name === "rnb") {
      put(0,[1,7,11]); put(1,[5,13]); put(3,[1,3,5,7,9,11,13,15],.6); put(5,[4,12],.45);
    } else if (name === "trap") {
      put(0,[1,4,9,12]); put(1,[9]); put(2,[9],.55); put(3,[1,3,5,7,9,11,13,14,15,16],.65); put(4,[7,15],.45);
    } else if (name === "house") {
      put(0,[1,5,9,13]); put(2,[5,13],.8); put(3,[3,7,11,15],.7); put(4,[7,15],.4);
    } else if (name !== "blank") {
      put(0,[1,7,9,12]); put(1,[5,13]); put(3,[1,3,5,7,9,11,13,15],.65); put(5,[8,16],.4);
    }
    return p;
  }
  function createProject(id, name = "Untitled session", now = new Date().toISOString()) {
    return {
      version:1, id, name, createdAt:now, updatedAt:now, archived:false,
      song:{key:"A minor",mood:"",sections:[{title:"Verse 1",text:""},{title:"Hook",text:""},{title:"Verse 2",text:""}]},
      beat:{bpm:92,swing:0,volume:45,bank:"A",arrangement:"AABB",cycles:1,patterns:{A:groove(),B:groove("rnb")},tracks:DRUMS.map((name,i)=>({name,volume:80,pan:i===3?-.15:i===4?.15:0,muted:false}))},
      audio:{name:"",start:0,end:0,rate:1,volume:80,fade:.02},
      recording:{beatEnabled:true,beatRepeats:4,master:75,countIn:1,tracks:[]},
      production:{sampleRate:48000,format:"pcm24",artist:"",credits:"",notes:"",masterFx:fxDefaults()},
      collaboration:{sessionId:"",baseVersionId:""},
      art:{background:"#f5efe4",active:0,layers:["Artwork","Details","Lettering"].map(name=>({name,visible:true,image:""}))},
      story:{logline:"",scenes:[{title:"Opening",location:"",shot:"Wide",seconds:15,action:"",dialogue:""},{title:"Turning point",location:"",shot:"Medium",seconds:15,action:"",dialogue:""},{title:"Resolution",location:"",shot:"Close",seconds:15,action:"",dialogue:""}]},
      stage:{minutes:3,prompter:"",speed:24,setlist:[{title:"Opening number",minutes:3,notes:""}],notes:""}
    };
  }
  const number = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
  function string(value, fallback = "", max = 150000) {
    if (typeof value !== "string") return fallback;
    if (value.length > max) throw new Error("A project field is too large to restore safely.");
    return value;
  }
  function normalizeProject(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) throw new Error("This is not a supported StarRise Studio project.");
    const p = createProject(string(raw.id,"",120),string(raw.name,"Untitled session",300));
    if (!p.id) throw new Error("This project has no identifier.");
    p.createdAt = string(raw.createdAt,p.createdAt,80); p.updatedAt = string(raw.updatedAt,p.updatedAt,80); p.archived = raw.archived === true;
    if (raw.song) {
      p.song.key = string(raw.song.key,"A minor",100); p.song.mood = string(raw.song.mood,"",1000);
      if (Array.isArray(raw.song.sections)) {
        if (raw.song.sections.length > 100) throw new Error("This project has too many song sections.");
        p.song.sections = raw.song.sections.map(s=>({title:string(s?.title,"Section",300),text:string(s?.text)}));
      }
    }
    if (raw.beat) {
      const b = raw.beat;
      p.beat.bpm = number(b.bpm,40,220,92); p.beat.swing = number(b.swing,0,50,0); p.beat.volume = number(b.volume,0,100,45);
      p.beat.bank = b.bank === "B" ? "B" : "A";
      p.beat.arrangement = ["A","B","AB","AABB"].includes(b.arrangement) ? b.arrangement : "AABB";
      p.beat.cycles = Math.round(number(b.cycles,1,8,1));
      for (const bank of ["A","B"]) {
        if (b.patterns?.[bank]) {
          if (!Array.isArray(b.patterns[bank]) || b.patterns[bank].length !== 6 || b.patterns[bank].some(row=>!Array.isArray(row)||row.length!==16)) throw new Error("Beat patterns must have six tracks and sixteen steps.");
          p.beat.patterns[bank] = b.patterns[bank].map(row=>row.map(v=>number(v,0,1,0)));
        }
      }
      p.beat.tracks = DRUMS.map((name,i)=>({name,volume:number(b.tracks?.[i]?.volume,0,100,80),pan:number(b.tracks?.[i]?.pan,-1,1,0),muted:b.tracks?.[i]?.muted===true}));
    }
    if (raw.audio) p.audio = {name:string(raw.audio.name,"",1000),start:number(raw.audio.start,0,86400,0),end:number(raw.audio.end,0,86400,0),rate:number(raw.audio.rate,.5,2,1),volume:number(raw.audio.volume,0,100,80),fade:number(raw.audio.fade,0,2,.02)};
    if (raw.recording) {
      const r = raw.recording;
      p.recording.beatEnabled = r.beatEnabled !== false; p.recording.beatRepeats = Math.round(number(r.beatRepeats,1,16,4));
      p.recording.master = number(r.master,0,100,75); p.recording.countIn = r.countIn === 0 ? 0 : 1;
      if (Array.isArray(r.tracks)) {
        if (r.tracks.length > 32) throw new Error("A recording project can restore up to 32 takes.");
        const ids = new Set();
        p.recording.tracks = r.tracks.map(t=>{
          const id = string(t?.id,"",80);
          if (!/^[a-z\d_-]+$/i.test(id) || ids.has(id)) throw new Error("Recording tracks need unique valid identifiers.");
          ids.add(id);
          return {id,name:string(t.name,"Untitled take",1000),start:number(t.start,0,3600,0),seconds:number(t.seconds,0,86400,0),volume:number(t.volume,0,100,80),pan:number(t.pan,-1,1,0),muted:t.muted===true,trimStart:number(t.trimStart,0,86400,0),trimEnd:number(t.trimEnd,0,86400,0),fade:number(t.fade,0,2,.01),fx:normalizeFx(t.fx)};
        });
      }
    }
    if(raw.production){const s=raw.production;p.production={sampleRate:s.sampleRate===44100?44100:48000,format:["pcm16","pcm24","float32"].includes(s.format)?s.format:"pcm24",artist:string(s.artist,"",1000),credits:string(s.credits,"",5000),notes:string(s.notes,"",150000),masterFx:normalizeFx(s.masterFx)};}
    if(raw.collaboration){p.collaboration={sessionId:UUID.test(raw.collaboration.sessionId)?raw.collaboration.sessionId:"",baseVersionId:UUID.test(raw.collaboration.baseVersionId)?raw.collaboration.baseVersionId:""};}
    if (raw.art) {
      p.art.background = /^#[a-f\d]{6}$/i.test(raw.art.background) ? raw.art.background : "#f5efe4";
      p.art.active = Math.round(number(raw.art.active,0,2,0));
      p.art.layers = p.art.layers.map((layer,i)=>{
        const source = raw.art.layers?.[i]; const image = string(source?.image,"",12000000);
        if (image && !/^data:image\/png;base64,[a-z\d+/=]+$/i.test(image)) throw new Error("Artwork in a project must be an embedded PNG.");
        return {name:string(source?.name,layer.name,300),visible:source?.visible!==false,image};
      });
    }
    if (raw.story) {
      p.story.logline = string(raw.story.logline);
      if (Array.isArray(raw.story.scenes)) {
        if (raw.story.scenes.length > 100) throw new Error("This project has too many scenes.");
        p.story.scenes = raw.story.scenes.map(s=>({title:string(s?.title,"Scene",300),location:string(s?.location,"",1000),shot:["Wide","Medium","Close","Detail","Tracking"].includes(s?.shot)?s.shot:"Medium",seconds:number(s?.seconds,0,3600,15),action:string(s?.action),dialogue:string(s?.dialogue)}));
      }
    }
    if (raw.stage) {
      p.stage.minutes = number(raw.stage.minutes,.25,120,3); p.stage.speed = number(raw.stage.speed,5,80,24);
      p.stage.prompter = string(raw.stage.prompter); p.stage.notes = string(raw.stage.notes);
      if (Array.isArray(raw.stage.setlist)) {
        if (raw.stage.setlist.length > 100) throw new Error("This project has too many setlist entries.");
        p.stage.setlist = raw.stage.setlist.map(s=>({title:string(s?.title,"Number",300),minutes:number(s?.minutes,0,120,3),notes:string(s?.notes)}));
      }
    }
    return p;
  }
  function songText(project) {
    return `${project.name}\nKey: ${project.song.key} · Tempo: ${project.beat.bpm} BPM\n${project.song.mood ? `Direction: ${project.song.mood}\n` : ""}\n` + project.song.sections.map(s=>`${s.title.toUpperCase()}\n${s.text}`).join("\n\n");
  }
  function scriptText(project) {
    return `${project.name}\n${project.story.logline ? `LOGLINE\n${project.story.logline}\n\n` : ""}` + project.story.scenes.map((s,i)=>`${i+1}. ${s.title}\nLocation: ${s.location}\nShot: ${s.shot} · ${s.seconds} sec\n\nACTION\n${s.action}\n\nDIALOGUE / VOICEOVER\n${s.dialogue}`).join("\n\n---\n\n");
  }
  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g,'""') + '"';
  }
  function shotCsv(project) {
    const rows = [["Scene","Title","Location","Shot","Seconds","Action","Dialogue"], ...project.story.scenes.map((s,i)=>[i+1,s.title,s.location,s.shot,s.seconds,s.action,s.dialogue])];
    return rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
  }
  function beatEvents(beat, stem = -1) {
    const stepSeconds = 60 / beat.bpm / 4;
    const banks = Array.from({length:beat.cycles},()=>beat.arrangement.split("")).flat();
    const events = [];
    banks.forEach((bank,bar)=>beat.patterns[bank].forEach((row,track)=>row.forEach((velocity,step)=>{
      if (velocity > 0 && !beat.tracks[track].muted && (stem < 0 || stem === track)) events.push({time:(bar*16+step)*stepSeconds+(step%2?stepSeconds*beat.swing/100:0),track,velocity,bank,step});
    })));
    return {events,duration:banks.length*16*stepSeconds,banks,stepSeconds};
  }
  function trimSettings(audio, duration) {
    const start = number(audio.start,0,Math.max(0,duration-.01),0);
    const end = number(audio.end,start+.01,duration,duration);
    const rate = number(audio.rate,.5,2,1);
    const seconds = (end-start)/rate;
    return {start,end,rate,seconds,volume:number(audio.volume,0,100,80)/100,fade:Math.min(number(audio.fade,0,2,.02),seconds/2)};
  }
  function wavBytes(channels, sampleRate, format = "pcm16") {
    if (!Array.isArray(channels) || channels.length<1 || channels.length>2 || !channels[0]?.length || channels.some(c=>c.length!==channels[0].length)) throw new Error("WAV export needs equal-length mono or stereo samples.");
    if (!Number.isInteger(sampleRate) || sampleRate<8000 || sampleRate>192000) throw new Error("Unsupported sample rate.");
    if(!["pcm16","pcm24","float32"].includes(format))throw new Error("Unsupported WAV format.");
    const bytes=format==="pcm24"?3:format==="float32"?4:2,header=format==="float32"?56:44;
    const size = channels[0].length*channels.length*bytes;
    if (size > 0xffffffff-header) throw new Error("This audio is too long for a WAV export.");
    const data = new ArrayBuffer(header+size); const view = new DataView(data);
    const text = (at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
    text(0,"RIFF"); view.setUint32(4,header-8+size,true); text(8,"WAVE"); text(12,"fmt "); view.setUint32(16,16,true);
    view.setUint16(20,format==="float32"?3:1,true); view.setUint16(22,channels.length,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*channels.length*bytes,true); view.setUint16(32,channels.length*bytes,true); view.setUint16(34,bytes*8,true);
    if(format==="float32"){text(36,"fact");view.setUint32(40,4,true);view.setUint32(44,channels[0].length,true);}
    text(header-8,"data");view.setUint32(header-4,size,true);
    let offset = header;
    for (let frame=0;frame<channels[0].length;frame++) for (const channel of channels) {
      const raw=Number.isFinite(channel[frame])?channel[frame]:0;
      const value = Math.max(-1,Math.min(1,raw));
      if(format==="float32")view.setFloat32(offset,Math.max(-3.402823466e38,Math.min(3.402823466e38,raw)),true);
      else if(format==="pcm24"){const n=Math.round(value*(value<0?8388608:8388607));view.setUint8(offset,n&255);view.setUint8(offset+1,(n>>8)&255);view.setUint8(offset+2,(n>>16)&255);}
      else view.setInt16(offset,value<0?Math.round(value*32768):Math.round(value*32767),true);
      offset+=bytes;
    }
    return data;
  }
  const filename = value => String(value).normalize("NFKD").replace(/[^a-z\d_-]+/gi,"-").replace(/^-|-$/g,"").slice(0,80) || "starrise-project";
  const words = text => String(text).trim().match(/\S+/g)?.length || 0;
  return {DRUMS,groove,emptyPattern,createProject,normalizeProject,fxDefaults,normalizeFx,songText,scriptText,csvCell,shotCsv,beatEvents,trimSettings,wavBytes,filename,words};
});
