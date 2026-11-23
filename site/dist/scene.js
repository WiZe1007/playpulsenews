
const root=document.documentElement.style,$=id=>document.getElementById(id);
const motion=matchMedia('(prefers-reduced-motion:reduce)'),phone=matchMedia('(max-width:820px)');
const hero=$('hero');
let calm=motion.matches,visible=true,raf=0,last=0,clock=0;
hero.classList.toggle('is-static',calm);
for(const img of hero.querySelectorAll('img'))img.addEventListener('error',()=>{img.style.visibility='hidden';if(img.classList.contains('cut'))img.closest('.set').classList.add('is-fallback');});
// The exact reference artwork is self-hosted; the first view needs no third-party image request.
let morningReady=false,morningPromise;
function prepareMorning(){
 if(morningPromise)return morningPromise;
 morningPromise=Promise.all([...document.querySelectorAll('[data-scene-src]')].map(img=>new Promise(resolve=>{
  img.onload=()=>resolve(true);img.onerror=()=>resolve(false);img.src=img.dataset.sceneSrc;
  if(img.complete&&img.naturalWidth)resolve(true);
 }))).then(results=>{morningReady=results.every(Boolean);return morningReady;});
 return morningPromise;
}
const idleLoad=setTimeout(()=>{if(!navigator.connection?.saveData)prepareMorning();},2500);

const SINK=240,RISE=820,DEPTH=.27;
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const smooth=(a,b,x)=>{x=clamp((x-a)/(b-a));return x*x*(3-2*x)};
let night=1,target=1,from=1,start=-1e9,queued=null,swapped=true,k=1;

const cv=$('fog');let gl=null;
if(!calm)try{gl=cv.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,powerPreference:'low-power'});}catch{}
let U={};
if(gl)try{
  const vs=`#version 300 es
  void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;
  const fs=`#version 300 es
  precision highp float;
  uniform vec2 R;uniform float T,S,K;out vec4 O;
  float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
  float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
  float fbm(vec2 p){float a=.5,s=0.;mat2 m=mat2(1.6,1.2,-1.2,1.6);p=mat2(.8,.6,-.6,.8)*p+5.3;for(int i=0;i<5;i++){s+=a*n(p);p=m*p;a*=.5;}return s;}
  void main(){
    vec2 uv=gl_FragCoord.xy/R;uv.y=1.-uv.y;
    float asp=R.x/R.y;vec2 p=vec2(uv.x*asp,uv.y);
    float t=T*.05;
    vec2 w=vec2(fbm(p*1.3+vec2(t,-t*.6)),fbm(p*1.3+vec2(-t*.8,t)+7.));
    float d=fbm(p*1.9+w*1.7+vec2(t*1.6,-t*1.1+S*.5));
    float e=fbm(p*.9-w+vec2(-t,t*.5)+3.);
    float low=smooth2(.70,1.04,uv.y+(d-.5)*.34);
    float side=smooth2(.2,.0,uv.x+(e-.5)*.28)+smooth2(.8,1.,uv.x+(e-.5)*.28);
    side*=smooth2(.25,.6,uv.y)*.2;
    float wisps=smooth2(.5,.78,d)*smooth2(.22,.5,uv.y)*smooth2(.86,.6,uv.y)*.18;
    float rest=clamp(low+side+wisps,0.,1.);
    float front=1.02-S*.68;
    float rise=smooth2(front-.02,front+.26,uv.y+(d-.5)*.5);
    float haze=S*(.3+.46*d);
    float a=clamp(max(rest,max(rise*.97,haze)),0.,1.);
    vec3 dayA=vec3(.97,.93,.84),dayB=vec3(.79,.78,.71);
    vec3 nitA=vec3(.40,.45,.57),nitB=vec3(.15,.19,.29);
    vec3 c=mix(mix(dayB,dayA,d*1.15),mix(nitB,nitA,d*1.1),K);
    float porch=exp(-dot((uv-vec2(.72,.74))*vec2(1.7,2.6),(uv-vec2(.72,.74))*vec2(1.7,2.6))*3.2);
    c=mix(c,vec3(.86,.55,.27),K*porch*.42*(1.-S));
    O=vec4(c*a,a);
  }`.replace(/smooth2/g,'smoothstep');
  const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw Error('Fog unavailable');return o};
  const pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,vs));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw Error('Fog unavailable');gl.useProgram(pr);hero.classList.add('has-fog');
  for(const u of['R','T','S','K'])U[u]=gl.getUniformLocation(pr,u);
}catch{gl=null;hero.classList.remove('has-fog');}
function size(){
  if(!gl)return;
  const r=hero.getBoundingClientRect();const w=Math.round(Math.min(r.width,phone.matches?480:960)),h=Math.round(w*r.height/r.width);
  if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;gl.viewport(0,0,w,h)}
}
addEventListener('resize',size);size();

function show(n){
  $('setM').classList.toggle('is-on',!n);$('setN').classList.toggle('is-on',!!n);
}
let animating=false;
function settle(n){
 target=night=n;k=n;animating=false;queued=null;show(n);
 root.setProperty('--k',n);root.setProperty('--k2',n);root.setProperty('--sink','0px');root.setProperty('--dip',0);
 $('bm').setAttribute('aria-pressed',String(!n));$('bn').setAttribute('aria-pressed',String(!!n));
}
let pickVersion=0;
async function pick(n){
 const version=++pickVersion;
 if(n===0&&!morningReady){
  $('bm').setAttribute('aria-busy','true');
  const ready=await prepareMorning();
  $('bm').removeAttribute('aria-busy');
  if(!ready){morningPromise=null;return;}
  if(version!==pickVersion)return;
 }
 if(n===target&&queued===null)return;
 $('bm').setAttribute('aria-pressed',String(!n));$('bn').setAttribute('aria-pressed',String(!!n));
 if(calm){settle(n);return;}
 if(animating)queued=n;else begin(n,performance.now());
 wake();
}
function begin(n,now){target=n;from=k;start=now;swapped=false;animating=true}
$('bm').onclick=()=>pick(0);$('bn').onclick=()=>pick(1);

function frame(now){
  clock=now;
  const d=now-start;let y=0,s=0,dip=0,k2=k;
  if(animating){
    if(d<SINK){const x=d/SINK;y=x*x*(3-2*x)*DEPTH}
    else{
      if(!swapped){swapped=true;night=target;show(target)}
      const x=clamp((d-SINK)/RISE);y=Math.pow(1-x,3.4)*DEPTH;
    }
    s=smooth(0,SINK*.92,d)*(1-smooth(SINK+70,SINK+RISE*.92,d));
    dip=smooth(30,190,d)*(1-smooth(330,720,d));
    k=from+(target-from)*smooth(120,520,d);
    k2=from+(target-from)*smooth(340,760,d);
    if(d>=SINK+RISE){animating=false;k=k2=target;y=s=dip=0;if(queued!==null&&queued!==target){const q=queued;queued=null;begin(q,now)}else queued=null}
  }
  if(animating||d<SINK+RISE+50){root.setProperty('--sink',(y*hero.clientHeight).toFixed(1)+'px');root.setProperty('--k',k.toFixed(3));root.setProperty('--k2',k2.toFixed(3));root.setProperty('--dip',dip.toFixed(3));}
  if(gl&&!calm){gl.uniform2f(U.R,cv.width,cv.height);gl.uniform1f(U.T,now/1000);gl.uniform1f(U.S,s);gl.uniform1f(U.K,k);gl.drawArrays(gl.TRIANGLES,0,3)}
}
// Draw only while the hero is visible; mobile fog uses a smaller canvas and lower idle frame rate.
function loop(t){
 raf=0;if(!visible||document.hidden||calm)return;
 if(animating||t-last>=(phone.matches?48:32)){frame(t);last=t;}
 if(gl||animating)raf=requestAnimationFrame(loop);
}
function wake(){if(!raf&&visible&&!document.hidden&&!calm)raf=requestAnimationFrame(loop);}
const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible&&animating)settle(target);if(visible)wake();else if(raf){cancelAnimationFrame(raf);raf=0;}},{threshold:0});
observer.observe(hero);
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(animating)settle(target);if(raf)cancelAnimationFrame(raf);raf=0;}else wake();});
function changeMotion(){calm=motion.matches;hero.classList.toggle('is-static',calm);hero.classList.toggle('has-fog',!!gl&&!calm);if(calm){settle(target);if(raf)cancelAnimationFrame(raf);raf=0;}else{size();wake();}}
motion.addEventListener('change',changeMotion);phone.addEventListener('change',changeMotion);
cv.addEventListener('webglcontextlost',event=>{event.preventDefault();gl=null;hero.classList.remove('has-fog');});
window.addEventListener('pagehide',()=>{clearTimeout(idleLoad);if(raf)cancelAnimationFrame(raf);observer.disconnect();});
wake();
