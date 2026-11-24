import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
// Offline import of Unity Labs Flame02/03 (CC0). Not used by the game/build.
const [input,output]=process.argv.slice(2).map(file=>path.resolve(file));
if(!input||!output||fs.existsSync(output))throw Error('Use: node scripts/prepare-fire-flipbook.ts input.tga new-output.png');
const bytes=fs.readFileSync(input),w=bytes.readUInt16LE(12),h=bytes.readUInt16LE(14);
const byte=(index:number):number=>{const value=bytes[index];if(value===undefined)throw Error('Truncated TGA flipbook.');return value;};
if(byte(1)!==0||byte(2)!==2||byte(16)!==32||byte(17)&16||w%16||h%4)throw Error('Expected the original uncompressed 32-bit TGA flipbook.');
const size=128,cols=8,frames=64,sw=w/16,sh=h/4,offset=18+byte(0),top=!!(byte(17)&32),rgba=new Uint8Array(512*1024*4),
  pixel=(x:number,y:number):[number,number,number,number]=>{const i=offset+((top?y:h-1-y)*w+x)*4;return [byte(i+2),byte(i+1),byte(i),byte(i+3)];};
for(let frame=0;frame<frames;frame++){
 const sx=frame%16*sw,sy=Math.floor(frame/16)*sh;
 for(let y=18;y<122;y++)for(let x=6;x<58;x++){
  const u=(x-6+.5)/52*sw-.5,v=sh-1-((y-18+.5)/104*sh-.5),ix=Math.floor(u),iy=Math.floor(v),fx=u-ix,fy=v-iy;
  let a=0,r=0,g=0,b=0;
  for(let j=0;j<2;j++)for(let k=0;k<2;k++){
   const p=pixel(sx+Math.max(0,Math.min(sw-1,ix+k)),sy+Math.max(0,Math.min(sh-1,iy+j))),weight=(k?fx:1-fx)*(j?fy:1-fy),alpha=p[3]*weight;
   a+=alpha;r+=p[0]*alpha;g+=p[1]*alpha;b+=p[2]*alpha;
  }
  const i=((Math.floor(frame/cols)*size+y)*512+frame%cols*64+x)*4;
  if(a){rgba[i]=Math.round(r/a);rgba[i+1]=Math.round(g/a);rgba[i+2]=Math.round(b/a);rgba[i+3]=Math.round(a);}
 }
}
const raw=path.join(os.tmpdir(),'impacto-fire-'+randomUUID()+'.rgba');
try{
 fs.writeFileSync(raw,rgba);
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','rawvideo','-pixel_format','rgba','-video_size','512x1024','-i',raw,'-frames:v','1','-compression_level','9',output],{windowsHide:true});
}finally{if(fs.existsSync(raw))fs.unlinkSync(raw);}
console.log(JSON.stringify({inputSHA256:createHash('sha256').update(bytes).digest('hex'),outputSHA256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'),bytes:fs.statSync(output).size,frames}));
