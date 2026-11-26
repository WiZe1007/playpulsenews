// An indexed-colour editorial print for days when the image model is unavailable.
// All randomness comes from the article seed, so retries reproduce the same print.
import {Buffer} from 'node:buffer';

const palettes=[
 ['132c34','e5edcf','a3c49c','fb765d'],['212237','eadfc6','678896','f2ac69'],
 ['292d29','ede3ce','729689','d76a4e'],['153847','d3e6d8','70b4a7','f1ac74'],
 ['402a37','f5dec2','e99976','8fb695'],['1d3151','f5e5b9','89a8c3','ec825c']
];
const crcTable=Uint32Array.from({length:256},(_,value)=>{
 for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;
 return value>>>0;
});
function chunk(type,bytes){
 const body=Buffer.concat([Buffer.from(type),bytes]),result=Buffer.alloc(body.length+8);
 result.writeUInt32BE(bytes.length);body.copy(result,4);
 let crc=0xffffffff;
 for(const byte of body)crc=crcTable[(crc^byte)&255]^(crc>>>8);
 result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);
 return result;
}

export async function coverPrint(seed){
 const width=480,height=288,stride=width+1;
 const pixels=new Uint8Array(stride*height);
 const palette=Buffer.from(palettes[seed[0]%palettes.length].join(''),'hex');
 const centers=Array.from({length:4},(_,i)=>({
  x:(i%2)*245+seed[1+i*4]%165,y:Math.floor(i/2)*160+seed[2+i*4]%130,
  radius:56+seed[3+i*4]%105,shape:seed[4+i*4]%4
 }));
 for(const [i,c] of centers.entries()){
  const ink=1+(i+seed[18])%3,striped=(i+seed[19])%3===0;
  const r=c.radius;
  for(let y=Math.max(0,c.y-r);y<Math.min(height,c.y+r+1);y++){
   const dy=y-c.y;
   const half=c.shape===0?r:c.shape===1?r-Math.abs(dy):Math.sqrt(r*r-dy*dy);
   const hole=c.shape===3?Math.sqrt((r*0.58)**2-dy*dy):NaN;
   const left=Math.max(0,Math.ceil(c.x-half)),right=Math.min(width-1,Math.floor(c.x+half));
   const start=y*stride+1;
   if(!striped&&Number.isNaN(hole)){pixels.fill(ink,start+left,start+right+1);continue;}
   for(let x=left;x<=right;x++){
    if(Math.abs(x-c.x)<hole)continue;
    pixels[start+x]=striped&&(x-c.x+2*dy+1024)%12<3?0:ink;
   }
  }
 }
 const compressed=new Blob([pixels]).stream().pipeThrough(new CompressionStream('deflate'));
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);
 header[8]=8;header[9]=3;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('PLTE',palette),
  chunk('IDAT',Buffer.from(await new Response(compressed).arrayBuffer())),chunk('IEND',Buffer.alloc(0))]);
}
