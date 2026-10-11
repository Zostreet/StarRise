(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const activities = [
    { id:"first-hook", category:"music", label:"Music & words", icon:"♪", title:"Your first hook", description:"Turn one bright idea into four lines you can sing or speak.", time:"10 minutes", tool:"words", steps:["Choose a feeling or an imaginary place.","Write four lines about it. Try a word or phrase that repeats.","Read or sing the lines with a rhythm you like.","Choose your favorite line and build from there."] },
    { id:"starter-beat", category:"music", label:"Music & words", icon:"♫", title:"Build a little beat", description:"Give kick, snare, and hi-hat their own place in a rhythm.", time:"10 minutes", tool:"beats", steps:["Listen to the starter beat at a comfortable volume.","Tap squares to change when each sound plays.","Try a slower speed, then a faster one.","Save a beat you like or practice clapping along."] },
    { id:"album-cover", category:"art", label:"Art & design", icon:"✦", title:"A cover with a story", description:"Draw the cover for an album that doesn't exist yet.", time:"15 minutes", tool:"art", steps:["Imagine a title such as A Brighter Tomorrow or Moonlight Dance.","Choose two or three colors that fit its feeling.","Draw shapes and symbols that tell the story.","Save your artwork and talk about your choices with a parent or teacher."] },
    { id:"imaginary-poster", category:"art", label:"Art & design", icon:"✎", title:"Your dream show poster", description:"Design an imaginary stage, festival, or creative event.", time:"15 minutes", tool:"art", steps:["Imagine a concert for robots, animals, or space explorers.","Draw a main image that makes the event feel exciting.","Try a bold color and a small surprising detail.","Explain your idea without using a real address or contact details."] },
    { id:"emotion-scene", category:"stage", label:"Stage & acting", icon:"◒", title:"One scene, three feelings", description:"Explore how a character changes with your voice and expression.", time:"5 minutes", tool:"stage", steps:["Read the imaginary scene in Stage practice.","Try it with excitement, surprise, and quiet confidence.","Notice how your posture and pace change the scene.","Pick your favorite version. You can write or draw it instead of performing."] },
    { id:"spoken-verse", category:"stage", label:"Stage & acting", icon:"◉", title:"Bring your words to life", description:"Practice a short verse with rhythm, pauses, and confidence.", time:"10 minutes", tool:"words", steps:["Write a few lines about an imaginary adventure.","Read them slowly, then find a natural rhythm.","Pause where you want the listener to picture something.","Try once more, or ask a trusted adult for kind feedback."] },
    { id:"three-scene-story", category:"film", label:"Film & stories", icon:"▣", title:"A story in three scenes", description:"Give an original character a beginning, surprise, and ending.", time:"15 minutes", tool:"film", steps:["Choose an imaginary character and place.","Write a beginning that shows what the character wants.","Add a surprise and decide how the character responds.","Write an ending and save the story plan. No filming is needed."] },
    { id:"sound-adventure", category:"film", label:"Film & stories", icon:"✧", title:"An adventure made of sound", description:"Imagine a short animation and give it a rhythm of its own.", time:"15 minutes", tool:"beats", steps:["Imagine a character walking, exploring, or dancing.","Build a beat that matches the character's pace.","Change one sound when a surprise happens in your story.","Save the beat and describe the scene to a parent or teacher."] }
  ];
  const prompts = {
    words:["Write four lines about a bird that teaches the wind a new melody.","Imagine a city where music makes the streetlights glow. What would your first song sound like?","Write a hook about trying again when an idea doesn't work the first time.","A box of crayons wants to start a band. Give each color a line.","Write a short verse about a door that leads to an imaginary ocean.","Describe an ordinary sound as if you are hearing it for the very first time."],
    art:["Design the cover for an album called A Brighter Tomorrow.","Draw a stage for a concert on the moon.","Create a colorful symbol for kindness.","Imagine a musical instrument made from clouds. Draw its shape.","Draw a garden where every flower makes a different sound."],
    film:["A tiny robot finds a musical note that has lost its song. How can they find the rest of the melody?","Two crayons disagree about the color of the sky. What do they create together?","A quiet library suddenly starts humming. Who discovers why?","A paper boat wants to become a spaceship. What helps it on its way?","A dancing cloud forgets its favorite move. How does a friend help?"],
    stage:["You are the first explorer to find a garden on the moon. Show the moment you discover it.","You are a tiny dragon learning to sing instead of roar.","You open an imaginary suitcase and find a miniature orchestra.","You are a robot hearing music for the first time.","You are a friendly magician whose hat has started telling jokes."]
  };
  const practiced = new Set();
  let selectedActivity = null;

  function status(message) { byId("toolStatus").textContent = message; }
  function pick(items) { return items[Math.floor(Math.random() * items.length)]; }
  function renderActivities(path = "all") {
    const container = byId("activities");
    container.replaceChildren();
    for (const activity of activities.filter(a => path === "all" || a.category === path)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "activity-card";
      button.dataset.category = activity.category;
      button.dataset.activity = activity.id;
      const icon = document.createElement("span");
      icon.className = "activity-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = activity.icon;
      const title = document.createElement("h3");
      title.textContent = activity.title;
      const description = document.createElement("p");
      description.textContent = activity.description;
      const meta = document.createElement("span");
      meta.className = "activity-meta";
      const time = document.createElement("span");
      time.textContent = activity.time;
      const action = document.createElement("span");
      action.textContent = practiced.has(activity.id) ? "Tried ✓" : "Try it ↗";
      meta.append(time, action);
      button.append(icon, title, description, meta);
      button.addEventListener("click", () => openActivity(activity));
      container.append(button);
    }
  }
  function openActivity(activity) {
    selectedActivity = activity;
    byId("activityTitle").textContent = activity.title;
    byId("activityCategory").textContent = activity.label;
    byId("activityDescription").textContent = activity.description;
    byId("activitySteps").replaceChildren(...activity.steps.map(step => {
      const li = document.createElement("li"); li.textContent = step; return li;
    }));
    byId("activityComplete").textContent = practiced.has(activity.id) ? "Already tried ✓" : "I've tried this";
    byId("activityDialog").showModal();
  }
  all("[data-path]").forEach(button => button.addEventListener("click", () => {
    all("[data-path]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    renderActivities(button.dataset.path);
  }));
  byId("closeActivity").addEventListener("click", () => byId("activityDialog").close());
  byId("activityOpen").addEventListener("click", () => {
    if (!selectedActivity) return;
    const tool = selectedActivity.tool;
    byId("activityDialog").close();
    selectTool(tool);
    byId("studio").scrollIntoView({behavior:"smooth", block:"start"});
    byId(`tab-${tool}`).focus({preventScroll:true});
  });
  byId("activityComplete").addEventListener("click", () => {
    if (!selectedActivity) return;
    practiced.add(selectedActivity.id);
    byId("progressCount").textContent = `${practiced.size} of ${activities.length} activities tried`;
    byId("journeyProgress").value = practiced.size;
    const path = document.querySelector("[data-path][aria-pressed=true]").dataset.path;
    renderActivities(path);
    byId("activityDialog").close();
    status("Another idea explored. Keep creating at your own pace.");
  });
  function openGrownup() { stopBeat(); stopPractice(); byId("grownupDialog").showModal(); }
  ["grownupLink","grownupCard","grownupFooter"].forEach(id => byId(id).addEventListener("click", openGrownup));
  byId("stayYouth").addEventListener("click", () => byId("grownupDialog").close());

  function selectTool(name) {
    stopBeat(); stopPractice(); status("");
    all("[data-tool]").forEach(button => {
      const active = button.dataset.tool === name;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      byId(`tool-${button.dataset.tool}`).hidden = !active;
    });
  }
  all("[data-tool]").forEach((button, index, buttons) => {
    button.addEventListener("click", () => selectTool(button.dataset.tool));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      selectTool(buttons[next].dataset.tool); buttons[next].focus();
    });
  });
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status("Your browser has received the file. Check Downloads or ask a trusted adult for help saving it.");
  }
  async function copy(text) {
    if (!text.trim()) { status("Add some words first."); return; }
    try {
      await navigator.clipboard.writeText(text);
      status("Copied. Ask a parent or teacher before sharing it outside this space.");
    } catch {
      byId("copyText").value = text;
      byId("copyDialog").showModal();
      byId("copyText").focus(); byId("copyText").select();
    }
  }
  byId("closeCopy").addEventListener("click", () => byId("copyDialog").close());
  byId("writing").addEventListener("input", () => {
    const words = byId("writing").value.trim().match(/\S+/g)?.length ?? 0;
    byId("wordCount").textContent = `${words} ${words === 1 ? "word" : "words"}`;
  });
  byId("wordsPrompt").addEventListener("click", () => { byId("writingPrompt").textContent = pick(prompts.words); });
  byId("addStructure").addEventListener("click", () => {
    const field = byId("writing");
    const structure = "Verse\n\n\nHook\n\n\nVerse\n\n\nHook\n";
    if (field.value.length + structure.length + 2 > field.maxLength) { status("Save your draft first; there isn't room for more headings."); return; }
    field.value += (field.value ? "\n\n" : "") + structure;
    field.dispatchEvent(new Event("input")); field.focus();
  });
  byId("copyWords").addEventListener("click", () => copy(byId("writing").value));
  byId("saveWords").addEventListener("click", () => {
    const text = byId("writing").value;
    if (!text.trim()) { status("Add some words before saving."); return; }
    download(new Blob([text], {type:"text/plain;charset=utf-8"}), "my-starrise-words.txt");
  });
  const storyText = () => `MY STORY PLAN\n\nBEGINNING\n${byId("sceneStart").value}\n\nSURPRISE\n${byId("sceneMiddle").value}\n\nENDING\n${byId("sceneEnd").value}\n`;
  const hasStory = () => ["sceneStart","sceneMiddle","sceneEnd"].some(id => byId(id).value.trim());
  byId("filmPrompt").addEventListener("click", () => { byId("storyPrompt").textContent = pick(prompts.film); });
  byId("copyStory").addEventListener("click", () => {
    if (!hasStory()) { status("Add a scene before copying your story."); return; }
    copy(storyText());
  });
  byId("saveStory").addEventListener("click", () => {
    if (!hasStory()) { status("Add a scene before saving your story."); return; }
    download(new Blob([storyText()], {type:"text/plain;charset=utf-8"}), "my-starrise-story.txt");
  });

  const starterPattern = [[1,0,0,0,1,0,0,0],[0,0,1,0,0,0,1,0],[1,1,1,1,1,1,1,1]];
  let pattern = starterPattern.map(row => [...row]);
  let audio = null;
  let master = null;
  let beatTimer = null;
  let beatPlaying = false;
  let beatStep = 0;
  const drumNames = ["Kick","Snare","Hi-hat"];
  function renderPattern() {
    byId("sequencer").replaceChildren();
    pattern.forEach((row, rowIndex) => {
      const element = document.createElement("div"); element.className = "beat-row";
      const label = document.createElement("span"); label.textContent = drumNames[rowIndex]; element.append(label);
      row.forEach((active, column) => {
        const button = document.createElement("button"); button.type = "button"; button.className = "beat-step";
        button.dataset.step = String(column); button.textContent = String(column + 1);
        button.setAttribute("aria-label", `${drumNames[rowIndex]}, step ${column + 1}`);
        button.setAttribute("aria-pressed", String(Boolean(active)));
        button.addEventListener("click", () => {
          pattern[rowIndex][column] = pattern[rowIndex][column] ? 0 : 1;
          button.setAttribute("aria-pressed", String(Boolean(pattern[rowIndex][column])));
        }); element.append(button);
      }); byId("sequencer").append(element);
    });
  }
  function drum(context, destination, instrument, when) {
    const gain = context.createGain(); gain.connect(destination);
    if (instrument === 0) {
      const oscillator = context.createOscillator(); oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(145, when); oscillator.frequency.exponentialRampToValueAtTime(45, when + .14);
      gain.gain.setValueAtTime(.75, when); gain.gain.exponentialRampToValueAtTime(.001, when + .19);
      oscillator.connect(gain); oscillator.start(when); oscillator.stop(when + .2);
    } else {
      const duration = instrument === 1 ? .14 : .045;
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      const source = context.createBufferSource(); source.buffer = buffer;
      const filter = context.createBiquadFilter(); filter.type = "highpass"; filter.frequency.value = instrument === 1 ? 1300 : 6500;
      gain.gain.setValueAtTime(instrument === 1 ? .4 : .25, when); gain.gain.exponentialRampToValueAtTime(.001, when + duration);
      source.connect(filter); filter.connect(gain); source.start(when); source.stop(when + duration);
    }
  }
  function tickBeat() {
    if (!beatPlaying || !audio) return;
    all(".beat-step").forEach(button => button.classList.toggle("current-step", Number(button.dataset.step) === beatStep));
    pattern.forEach((row, instrument) => { if (row[beatStep]) drum(audio, master, instrument, audio.currentTime + .015); });
    beatStep = (beatStep + 1) % 8;
    beatTimer = setTimeout(tickBeat, (60 / Number(byId("tempo").value) / 2) * 1000);
  }
  function stopBeat() {
    beatPlaying = false; clearTimeout(beatTimer); beatTimer = null;
    all(".beat-step").forEach(button => button.classList.remove("current-step"));
    byId("playBeat").textContent = "Play beat"; byId("playBeat").setAttribute("aria-pressed", "false");
    byId("beatState").textContent = "Ready when you are.";
  }
  byId("playBeat").addEventListener("click", async () => {
    if (beatPlaying) { stopBeat(); return; }
    const button = byId("playBeat"); button.disabled = true;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error("Audio isn't supported in this browser.");
      if (!audio) { audio = new Audio(); master = audio.createGain(); master.connect(audio.destination); }
      await audio.resume();
      master.gain.value = Number(byId("beatVolume").value) / 100 * .4;
      beatPlaying = true; beatStep = 0; button.textContent = "Stop beat"; button.setAttribute("aria-pressed", "true");
      byId("beatState").textContent = "Your beat is playing."; tickBeat();
    } catch { status("This browser couldn't play audio. You can still build a pattern or try another browser with a trusted adult."); }
    finally { button.disabled = false; }
  });
  byId("tempo").addEventListener("input", () => { byId("tempoValue").textContent = `${byId("tempo").value} BPM`; });
  byId("beatVolume").addEventListener("input", () => { if (master) master.gain.value = Number(byId("beatVolume").value) / 100 * .4; });
  byId("resetBeat").addEventListener("click", () => { stopBeat(); pattern = starterPattern.map(row => [...row]); renderPattern(); status("Starter pattern restored."); });
  byId("saveBeat").addEventListener("click", async () => {
    const button = byId("saveBeat"); button.disabled = true;
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) throw new Error("Audio export is unavailable.");
      const stepLength = 60 / Number(byId("tempo").value) / 2;
      const length = Math.ceil((stepLength * 16 + .3) * 22050);
      const context = new Offline(1, length, 22050);
      const output = context.createGain(); output.gain.value = Number(byId("beatVolume").value) / 100 * .4; output.connect(context.destination);
      for (let step = 0; step < 16; step++) pattern.forEach((row, instrument) => { if (row[step % 8]) drum(context, output, instrument, step * stepLength); });
      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0); const bytes = new ArrayBuffer(44 + data.length * 2); const view = new DataView(bytes);
      const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
      ascii(0,"RIFF"); view.setUint32(4,36 + data.length * 2,true); ascii(8,"WAVE"); ascii(12,"fmt "); view.setUint32(16,16,true);
      view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,22050,true); view.setUint32(28,44100,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
      ascii(36,"data"); view.setUint32(40,data.length * 2,true);
      for (let i = 0; i < data.length; i++) { const sample = Math.max(-1, Math.min(1, data[i])); view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true); }
      download(new Blob([bytes], {type:"audio/wav"}), "my-starrise-beat.wav");
    } catch { status("Audio export isn't available here. Try clapping your pattern, or ask a trusted adult to try a supported browser."); }
    finally { button.disabled = false; }
  });

  const canvas = byId("artCanvas");
  const pen = canvas.getContext("2d");
  let brushColor = "#14253d";
  let drawing = false;
  let lastPoint = null;
  let pointerId = null;
  const undo = [];
  let keyboardPoint = {x:450,y:280};
  function whiteCanvas() { pen.fillStyle = "#ffffff"; pen.fillRect(0,0,canvas.width,canvas.height); }
  function rememberDrawing() { undo.push(pen.getImageData(0,0,canvas.width,canvas.height)); if (undo.length > 8) undo.shift(); }
  function point(event) { const bounds = canvas.getBoundingClientRect(); return {x:(event.clientX-bounds.left)*canvas.width/bounds.width, y:(event.clientY-bounds.top)*canvas.height/bounds.height}; }
  function stroke(from,to) { pen.strokeStyle = brushColor; pen.lineWidth = Number(byId("brushSize").value); pen.lineCap = "round"; pen.lineJoin = "round"; pen.beginPath(); pen.moveTo(from.x,from.y); pen.lineTo(to.x,to.y); pen.stroke(); }
  function dot(position) { pen.fillStyle = brushColor; pen.beginPath(); pen.arc(position.x,position.y,Number(byId("brushSize").value)/2,0,Math.PI*2); pen.fill(); }
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drawing) return;
    event.preventDefault(); rememberDrawing(); drawing = true; pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId); lastPoint = point(event); keyboardPoint = lastPoint; dot(lastPoint);
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing || event.pointerId !== pointerId) return;
    const next = point(event); stroke(lastPoint,next); lastPoint = next; keyboardPoint = next;
  });
  function endDrawing(event) {
    if (event.pointerId !== pointerId) return;
    drawing = false; if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId); pointerId = null;
  }
  canvas.addEventListener("pointerup", endDrawing); canvas.addEventListener("pointercancel", endDrawing);
  canvas.addEventListener("keydown", event => {
    if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(event.key)) return;
    event.preventDefault();
    if (event.key === " ") { rememberDrawing(); dot(keyboardPoint); status("Brush mark added."); return; }
    const distance = event.shiftKey ? 30 : 10;
    if (event.key === "ArrowLeft") keyboardPoint.x -= distance;
    if (event.key === "ArrowRight") keyboardPoint.x += distance;
    if (event.key === "ArrowUp") keyboardPoint.y -= distance;
    if (event.key === "ArrowDown") keyboardPoint.y += distance;
    keyboardPoint.x = Math.max(0,Math.min(canvas.width,keyboardPoint.x)); keyboardPoint.y = Math.max(0,Math.min(canvas.height,keyboardPoint.y));
    status(`Brush position: ${Math.round(keyboardPoint.x)}, ${Math.round(keyboardPoint.y)}. Press Space to add a mark.`);
  });
  all("[data-color]").forEach(button => button.addEventListener("click", () => {
    brushColor = button.dataset.color;
    all("[data-color]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  }));
  byId("artPrompt").addEventListener("click", () => { byId("drawingPrompt").textContent = pick(prompts.art); });
  byId("undoArt").addEventListener("click", () => {
    if (drawing) return;
    const snapshot = undo.pop();
    if (snapshot) { pen.putImageData(snapshot,0,0); status("Last drawing step undone."); }
    else status("There isn't a drawing step to undo yet.");
  });
  byId("clearArt").addEventListener("click", () => byId("clearDialog").showModal());
  byId("cancelClear").addEventListener("click", () => byId("clearDialog").close());
  byId("confirmClear").addEventListener("click", () => { rememberDrawing(); whiteCanvas(); byId("clearDialog").close(); status("Fresh canvas ready. Undo can bring the last drawing back."); });
  byId("saveArt").addEventListener("click", () => {
    canvas.toBlob(blob => { if (blob) download(blob,"my-starrise-art.png"); else status("Your browser couldn't save this drawing. Ask a trusted adult for help."); },"image/png");
  });
  let practiceInterval = null;
  function stopPractice() { clearInterval(practiceInterval); practiceInterval = null; byId("practiceTimer").textContent = "30 seconds"; byId("startPractice").textContent = "Start 30-second practice"; }
  byId("stagePrompt").addEventListener("click", () => { stopPractice(); byId("actingPrompt").textContent = pick(prompts.stage); });
  byId("startPractice").addEventListener("click", () => {
    stopPractice(); let remaining = 30; const until = Date.now() + 30000;
    byId("startPractice").textContent = "Restart practice";
    status("Your 30-second practice has started. Go at your own pace.");
    practiceInterval = setInterval(() => {
      remaining = Math.max(0,Math.ceil((until-Date.now())/1000)); byId("practiceTimer").textContent = `${remaining} seconds`;
      if (!remaining) { clearInterval(practiceInterval); practiceInterval = null; byId("practiceTimer").textContent = "Practice complete"; byId("startPractice").textContent = "Try again"; status("Practice complete. Notice one thing you liked about your idea."); }
    },250);
  });
  byId("stopPractice").addEventListener("click", stopPractice);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopBeat(); stopPractice(); } });
  window.addEventListener("pagehide", () => { stopBeat(); stopPractice(); });
  renderActivities(); renderPattern(); whiteCanvas();
})();
