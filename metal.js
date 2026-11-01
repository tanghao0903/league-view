/* Chrome liquid-metal background + HUD clock/coords, shared by every page.
 *
 * Two layers make up the liquid:
 *  1. a slow, heavy "base" surface (domain-warped noise + drifting blobs) computed in the shader;
 *  2. a real-time wave simulation (ping-pong framebuffers) that the pointer pushes around,
 *     so ripples follow the cursor exactly, spread out and settle with inertia.
 * The surface is shaded as mirror chrome reflecting a dark studio with softbox strips,
 * plus pink / cyan neon rim lights for the cyberpunk look.
 */
(function(){
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(function(){document.body.classList.add('ready')},250);

  var clock=document.getElementById('clock')||{},coord=document.getElementById('coord')||{};
  function pad(n,w){n=String(Math.floor(Math.abs(n)));while(n.length<w)n='0'+n;return n}
  function tick(){var d=new Date();clock.textContent='T '+pad(d.getHours(),2)+':'+pad(d.getMinutes(),2)+':'+pad(d.getSeconds(),2)}
  tick();setInterval(tick,1000);

  var c=document.getElementById('metal');
  var gl=c.getContext('webgl',{antialias:false,premultipliedAlpha:false})||c.getContext('experimental-webgl');
  if(!gl){c.style.background='radial-gradient(circle at 40% 35%,#fff,#9aa0aa 18%,#16161c 45%,#000 75%)';return;}

  /* ---------- float render targets for the wave simulation ---------- */
  var hf=gl.getExtension('OES_texture_half_float'),hfl=gl.getExtension('OES_texture_half_float_linear');
  var ff=gl.getExtension('OES_texture_float'),ffl=gl.getExtension('OES_texture_float_linear');
  gl.getExtension('EXT_color_buffer_half_float');gl.getExtension('WEBGL_color_buffer_float');
  var simType=null,simLinear=false;
  function tryType(type,lin){
    var t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,4,4,0,gl.RGBA,type,null);
    var fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    var ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fb);gl.deleteTexture(t);
    if(ok){simType=type;simLinear=lin;}return ok;
  }
  if(!(hf&&tryType(hf.HALF_FLOAT_OES,!!hfl)))if(!(ff&&tryType(gl.FLOAT,!!ffl)))simType=null;
  var useSim=simType!==null;

  /* ---------- shaders ---------- */
  var VS='attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

  var SIM=[
  'precision highp float;',
  'uniform sampler2D S;uniform vec2 px;uniform vec2 A;uniform vec2 B;uniform float F;uniform float RAD;uniform float asp;',
  'void main(){',
  ' vec2 uv=gl_FragCoord.xy*px;',
  ' vec4 c=texture2D(S,uv);',
  ' float l=texture2D(S,uv-vec2(px.x,0.)).r,r=texture2D(S,uv+vec2(px.x,0.)).r;',
  ' float d=texture2D(S,uv-vec2(0.,px.y)).r,u=texture2D(S,uv+vec2(0.,px.y)).r;',
  /* wave equation step; the small blend toward the neighbour average acts as viscosity */
  ' float avg=(l+r+u+d)*.25;',
  ' float h=(l+r+u+d)*.5-c.g;',
  ' h=mix(h,avg,.05)*.994;',
  /* pointer: press a trough along the segment the cursor travelled this frame */
  ' vec2 p=uv;p.x*=asp;vec2 a=A;a.x*=asp;vec2 b=B;b.x*=asp;',
  ' vec2 ab=b-a;float t=clamp(dot(p-a,ab)/max(dot(ab,ab),1e-6),0.,1.);',
  ' float dd=length(p-a-ab*t);',
  ' h-=F*exp(-dd*dd/(RAD*RAD));',
  ' gl_FragColor=vec4(h,c.r,0.,1.);',
  '}'].join('\n');

  var REN=[
  'precision highp float;',
  'uniform vec2 R;uniform float T;uniform sampler2D S;uniform vec2 spx;uniform float useSim;',
  'float SS(float a,float b,float x){return a<b?smoothstep(a,b,x):1.-smoothstep(b,a,x);}',
  'float h1(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
  'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
  ' return mix(mix(h1(i),h1(i+vec2(1,0)),f.x),mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x),f.y);}',
  'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*n(p);p=p*2.02+vec2(3.1,1.7);a*=.5;}return v;}',
  /* heavy, slow base surface: large warped swells */
  'float base(vec2 p){',
  ' float t=T*.05;',
  ' vec2 q=vec2(fbm(p*.55+vec2(t,-t*.7)),fbm(p*.55+vec2(4.3-t*.6,2.1+t)));',
  ' float v=fbm(p*.6+q*1.6+vec2(-t*.4,t*.3));',
  ' v+=.35*sin(p.x*1.3+t*3.+q.y*3.)*sin(p.y*1.1-t*2.+q.x*3.);',
  ' return v*1.35;}',
  'float sim(vec2 uv){return useSim>.5?texture2D(S,uv).r:0.;}',
  /* dark studio + softbox strips + neon rim lights */
  'vec3 env(vec3 d){',
  ' float e=d.z;float az=atan(d.y,d.x);',
  ' float hz=.5+.05*sin(az*2.);',
  /* sky: bright near the horizon, cooler grey higher up */
  ' float pan=.5+.5*cos(az*1.7+1.4);',
  ' vec3 sky=mix(vec3(.04,.04,.06),vec3(1.,1.,1.02),SS(.3,.92,pan));',
  ' sky=mix(sky,vec3(.92,.94,1.),SS(hz+.1,hz+.02,e));',
  /* ground: deep black with a faint reflected glow */
  ' vec3 gnd=mix(vec3(.11,.1,.13),vec3(.0,.0,.01),SS(hz,hz-.45,e));',
  ' vec3 c=mix(gnd,sky,SS(hz-.025,hz+.025,e));',
  /* thin dark line right on the horizon gives the crisp chrome edge */
  ' c*=1.-.85*SS(.045,0.,abs(e-hz-.035));',
  /* softbox strips */
  ' float s1=SS(.2,.1,abs(az-.9))*SS(.6,.68,e)*SS(.98,.88,e);',
  ' float s2=SS(.13,.05,abs(az+2.1))*SS(.58,.66,e)*SS(.97,.88,e);',
  ' c+=vec3(1.)*s1*mix(.6,1.5,SS(.62,.97,e))+vec3(1.)*s2*mix(.5,1.3,SS(.97,.6,e));',
  /* neon rim lights reflected low in the room */
  ' c+=vec3(1.,.15,.8)*SS(.8,0.,abs(az-2.5))*SS(hz-.35,hz-.05,e)*SS(hz+.01,hz-.03,e)*1.6;',
  ' c+=vec3(0.,.9,1.)*SS(.8,0.,abs(az+.6))*SS(hz-.35,hz-.05,e)*SS(hz+.01,hz-.03,e)*1.5;',
  ' return c;}',
  'void main(){',
  ' vec2 sp=gl_FragCoord.xy/R;',
  ' float m=min(R.x,R.y);',
  ' vec2 uv=(gl_FragCoord.xy-.5*R)/m*1.6;',
  ' float e=2./m;',
  ' float b0=base(uv),bx=base(uv+vec2(e,0.)),by=base(uv+vec2(0.,e));',
  ' vec2 g=vec2(bx-b0,by-b0)/e;',
  ' if(useSim>.5){',
  '  float s0=sim(sp),sx=sim(sp+vec2(spx.x,0.)),sy=sim(sp+vec2(0.,spx.y));',
  '  float sxm=sim(sp-vec2(spx.x,0.)),sym=sim(sp-vec2(0.,spx.y));',
  '  g+=vec2(sx-sxm,sy-sym)*vec2(R.x/m,R.y/m)/(2.*spx)*.04;',
  ' }',
  ' vec3 N=normalize(vec3(-g*.5,1.));',
  /* camera looks down at the sheet with a slight perspective so flat areas still mirror the room */
  ' vec3 V=normalize(vec3(uv*.32+vec2(0.,-.55),-1.));',
  ' vec3 Rf=reflect(V,N);',
  ' vec3 col=env(Rf);',
  ' float fr=.9+.1*pow(1.-max(dot(-V,N),0.),5.);',
  ' col*=fr;',
  /* chrome tint: cool shadows, warm-white highlights */
  ' col=mix(col*vec3(.86,.9,1.),col,smoothstep(.2,1.,col.g));',
  /* sharp key-light glint */
  ' vec3 L=normalize(vec3(-.35,.55,.75));',
  ' col+=pow(max(dot(Rf,L),0.),180.)*2.2;',
  /* faint neon grid floor at the bottom */
  ' float hz=.26;',
  ' if(sp.y<hz){',
  '  float z=hz/(hz-sp.y+.001);',
  '  vec2 gg=vec2((sp.x-.5)*z*6.,z*1.4+T*.5);',
  '  vec2 gf=abs(fract(gg)-.5);',
  '  float ln=smoothstep(.47,.5,max(gf.x,gf.y));',
  '  col+=mix(vec3(1.,.17,.84),vec3(0.,.94,1.),sp.y/hz)*ln*.28*smoothstep(0.,.08,hz-sp.y);',
  ' }',
  ' vec2 vg=sp-.5;col*=1.-dot(vg,vg)*.8;',
  /* filmic-ish tone curve keeps the blacks deep and highlights crisp */
  ' col=col/(1.+col*.12);',
  ' gl_FragColor=vec4(col,1.);',
  '}'].join('\n');

  function sh(t,s){var o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))console.error(gl.getShaderInfoLog(o));return o;}
  function prog(fs){var p=gl.createProgram();gl.attachShader(p,sh(gl.VERTEX_SHADER,VS));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fs));gl.bindAttribLocation(p,0,'p');gl.linkProgram(p);return p;}
  var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);

  var pRen=prog(REN),pSim=useSim?prog(SIM):null;
  function U(p,n){return gl.getUniformLocation(p,n)}
  var rR=U(pRen,'R'),rT=U(pRen,'T'),rS=U(pRen,'S'),rSpx=U(pRen,'spx'),rUse=U(pRen,'useSim');
  var sS,sPx,sA,sB,sF,sRad,sAsp;
  if(useSim){sS=U(pSim,'S');sPx=U(pSim,'px');sA=U(pSim,'A');sB=U(pSim,'B');sF=U(pSim,'F');sRad=U(pSim,'RAD');sAsp=U(pSim,'asp');}

  var scale=Math.min(window.devicePixelRatio||1,1.5)*.8;
  var SW=0,SH=0,tex=[],fbs=[],cur=0;
  function makeTarget(w,h){
    var t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    var f=simLinear?gl.LINEAR:gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,f);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,f);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,simType,null);
    var fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return [t,fb];
  }
  function resize(){
    c.width=Math.floor(innerWidth*scale);c.height=Math.floor(innerHeight*scale);
    if(useSim){
      var w=Math.round(Math.min(320,Math.max(160,innerWidth/4))),h=Math.round(w*innerHeight/innerWidth);
      if(w!==SW||h!==SH){
        tex.forEach(function(t){gl.deleteTexture(t)});fbs.forEach(function(f){gl.deleteFramebuffer(f)});
        var a=makeTarget(w,h),b=makeTarget(w,h);tex=[a[0],b[0]];fbs=[a[1],b[1]];SW=w;SH=h;
      }
    }
  }
  addEventListener('resize',resize);resize();

  /* pointer: raw positions (no smoothing) so the liquid tracks the cursor 1:1 */
  var px=-1,py=-1,lx=-1,ly=-1,force=0,has=false,idle=0;
  function mv(x,y){
    px=x/innerWidth;py=1-y/innerHeight;
    if(!has){lx=px;ly=py;has=true;}
    coord.textContent='X '+pad(x,4)+' · Y '+pad(y,4);
  }
  addEventListener('pointermove',function(e){mv(e.clientX,e.clientY)},{passive:true});
  addEventListener('pointerdown',function(e){mv(e.clientX,e.clientY);force=Math.max(force,.25)},{passive:true});
  addEventListener('touchmove',function(e){var t=e.touches[0];if(t)mv(t.clientX,t.clientY)},{passive:true});
  addEventListener('pointerleave',function(){has=false});

  /* gentle self-stirring when nobody touches it, so the page never looks frozen */
  var auto=0;
  var t0=performance.now(),last=t0;
  function step(ax,ay,bx,by,f){
    gl.useProgram(pSim);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbs[1-cur]);gl.viewport(0,0,SW,SH);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex[cur]);
    gl.uniform1i(sS,0);gl.uniform2f(sPx,1/SW,1/SH);gl.uniform2f(sA,ax,ay);gl.uniform2f(sB,bx,by);
    gl.uniform1f(sF,f);gl.uniform1f(sRad,.055);gl.uniform1f(sAsp,SW/SH);
    gl.drawArrays(gl.TRIANGLES,0,3);
    cur=1-cur;
  }
  function frame(now){
    var t=(now-t0)/1000,dt=Math.min(.05,(now-last)/1000);last=now;
    if(useSim){
      var ax=lx,ay=ly,bx=px,by=py,f=0;
      if(has){
        var dx=(bx-ax)*innerWidth,dy=(by-ay)*innerHeight,sp=Math.sqrt(dx*dx+dy*dy);
        f=Math.min(.3,sp*.014)+force;force*=.6;
        idle=sp>0.5?0:idle+dt;
      } else idle+=dt;
      if(!has||idle>2.5){ /* idle drop: a slow orbiting stir */
        auto+=dt;var k=auto*.35;
        bx=.5+Math.cos(k)*.3;by=.5+Math.sin(k*1.3)*.22;ax=.5+Math.cos(k-.05)*.3;ay=.5+Math.sin((k-.05)*1.3)*.22;f=.025;
      }
      step(ax,ay,bx,by,f);
      step(bx,by,bx,by,0);
      step(bx,by,bx,by,0);
      lx=px;ly=py;
    }
    gl.useProgram(pRen);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,c.width,c.height);
    if(useSim){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex[cur]);}
    gl.uniform1i(rS,0);gl.uniform2f(rSpx,1/(SW||1),1/(SH||1));gl.uniform1f(rUse,useSim?1:0);
    gl.uniform2f(rR,c.width,c.height);gl.uniform1f(rT,reduce?10:t);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(!reduce)requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
