(function(root,factory){"use strict";const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StarRiseStudioPackage=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  const utf8=text=>new TextEncoder().encode(text);
  async function zip(files){
    const parts=[],central=[];let offset=0,centralSize=0;
    if(files.length>65535)throw new Error("Too many files for this session package.");
    for(const file of files){
      if(typeof file.name!=="string"||!file.name||file.name.startsWith("/")||file.name.includes("..")||file.name.includes("\\")||file.name.includes("\0"))throw new Error("Unsafe session filename.");
      const name=utf8(file.name),data=file.data instanceof Blob?new Uint8Array(await file.data.arrayBuffer()):typeof file.data==="string"?utf8(file.data):new Uint8Array(file.data),crc=crc32(data);
      if(name.length>65535||data.length>0xffffffff||offset+data.length+name.length+30>0xffffffff)throw new Error("This package is too large for ZIP.");
      const header=new Uint8Array(30+name.length),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,name.length,true);header.set(name,30);
      const dir=new Uint8Array(46+name.length),d=new DataView(dir.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);dir.set(name,46);
      parts.push(header,data);central.push(dir);centralSize+=dir.length;offset+=header.length+data.length;
    }
    const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:"application/zip"});
  }
  return {crc32,zip};
});
