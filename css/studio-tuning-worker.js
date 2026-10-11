"use strict";
importScripts("studio-vocal-tuning.js");
self.onmessage=event=>{try{const result=self.StarRiseVocalTuning.process(event.data.channels,event.data.rate,event.data.options,value=>self.postMessage({progress:value}));self.postMessage({result},result.channels.map(c=>c.buffer));}catch(error){self.postMessage({error:error.message||"Vocal tuning could not finish."});}};
