/* Patamu printable geometry. Binary STL stores geometry only; use the accompanying
 * print-settings text for units, source notes and slicer recommendations. */
export const PRINTER_PRESETS = Object.freeze([
  {id:'ender3',name:'Creality Ender-3 V3 SE',bed:[220,220,250],nozzle:0.4,layer:0.2,source:'https://www.creality.com/products/creality-ender-3-v3-se',profileSource:'https://github.com/CrealityOfficial/CrealityPrint/blob/master/resources/profiles/Creality/machine/Creality%20Ender-3%20V3%20SE%200.4%20nozzle.json'},
  {id:'a1mini',name:'Bambu Lab A1 mini',bed:[180,180,180],nozzle:0.4,layer:0.2,source:'https://bambulab.com/en/a1-mini/tech-specs',profileSource:'https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20A1%20mini%200.4%20nozzle.json'},
  {id:'a1',name:'Bambu Lab A1',bed:[256,256,256],nozzle:0.4,layer:0.2,source:'https://bambulab.com/en/a1/tech-specs',profileSource:'https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/Bambu%20Lab%20A1%200.4%20nozzle.json'},
  {id:'generic',name:'Generic 200 mm FDM printer',bed:[200,200,200],nozzle:0.4,layer:0.2,source:null}
]);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const safeName=s=>String(s||'patamu').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,65)||'patamu';
function sample(grid,u,v){const h=grid.length,w=grid[0].length,x=clamp(u,0,1)*(w-1),y=clamp(v,0,1)*(h-1),i=Math.floor(x),j=Math.floor(y),a=x-i,b=y-j;return grid[j][i]*(1-a)*(1-b)+grid[j][Math.min(i+1,w-1)]*a*(1-b)+grid[Math.min(j+1,h-1)][i]*(1-a)*b+grid[Math.min(j+1,h-1)][Math.min(i+1,w-1)]*a*b;}
function inPolygon(x,y,poly){let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function validateInput(state,terrain){
  const b=state?.bounds,g=terrain?.grid;
  if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<=b[2]||b[3]<=b[1])throw new Error('Load a valid region before exporting an STL.');
  if(!Array.isArray(g)||g.length<2||g.length>512||!Array.isArray(g[0])||g[0].length<2||g[0].length>512||g.some(r=>!Array.isArray(r)||r.length!==g[0].length||!r.every(Number.isFinite)))throw new Error('The model does not contain a valid elevation grid.');
}
function normal(a,b,c){const x1=b[0]-a[0],y1=b[1]-a[1],z1=b[2]-a[2],x2=c[0]-a[0],y2=c[1]-a[1],z2=c[2]-a[2],x=y1*z2-z1*y2,y=z1*x2-x1*z2,z=x1*y2-y1*x2,l=Math.hypot(x,y,z);if(l<1e-10)throw new Error('The print geometry contains a degenerate triangle. Increase its size.');return [x/l,y/l,z/l];}
export function inspectPrintMesh(triangles){
  const edges=new Map(),vertices=new Set(),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];let volume=0;
  const key=p=>p.map(v=>Math.fround(v).toString()).join(',');
  for(const t of triangles){if(t.length!==3||t.some(p=>p.length!==3||!p.every(Number.isFinite)))throw new Error('The print geometry contains invalid coordinates.');normal(...t);const keys=t.map(p=>{for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p[k]);hi[k]=Math.max(hi[k],p[k]);}const q=key(p);vertices.add(q);return q;});for(let k=0;k<3;k++){const a=keys[k],b=keys[(k+1)%3],e=a<b?a+'|'+b:b+'|'+a;const val=edges.get(e)||[0,0];val[0]++;val[1]+=a<b?1:-1;edges.set(e,val);}const [a,b,c]=t;volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;}
  const badEdges=[...edges.values()].filter(([count,balance])=>count!==2||balance!==0).length;
  return {triangles:triangles.length,vertices:vertices.size,edges:edges.size,badEdges,watertight:badEdges===0&&volume>0,volumeMm3:volume,bounds:{min:lo,max:hi},dimensionsMm:hi.map((v,k)=>v-lo[k])};
}
function binarySTL(triangles,label){const bytes=new ArrayBuffer(84+triangles.length*50),view=new DataView(bytes);new Uint8Array(bytes,0,80).set(new TextEncoder().encode(('Patamu mm | '+label).slice(0,79)));view.setUint32(80,triangles.length,true);let at=84;for(const t of triangles){for(const p of [normal(...t),...t])for(const n of p){view.setFloat32(at,n,true);at+=4;}view.setUint16(at,0,true);at+=2;}return bytes;}

/** A terrain block or one aquifer solid at the current edited footprint.
 * Coordinates are millimetres, Z up. mode is 'terrain' or 'layer'. */
export function createSTLExport({state,terrain,fieldData,selected=0,presetId='ender3',widthMm=150,exaggeration=5,mode='terrain',resolution=80}={}){
  validateInput(state,terrain);
  if(!['terrain','layer'].includes(mode))throw new Error('Choose a terrain block or an aquifer layer.');
  const preset=PRINTER_PRESETS.find(p=>p.id===presetId)||PRINTER_PRESETS[0],b=state.bounds,grid=terrain.grid;
  const requestedWidth=Number(widthMm),requestedExaggeration=Number(exaggeration);
  if(!Number.isFinite(requestedWidth)||requestedWidth<20||requestedWidth>1000)throw new Error('Choose a print width between 20 and 1,000 mm.');
  if(!Number.isFinite(requestedExaggeration)||requestedExaggeration<0.1||requestedExaggeration>100)throw new Error('Choose vertical exaggeration between 0.1× and 100×.');
  const eastWestM=(b[3]-b[1])*111320*Math.cos((b[0]+b[2])/2*Math.PI/180),northSouthM=(b[0]-b[2])*111320;
  if(eastWestM<1||northSouthM<1)throw new Error('The region is too small for this print preset.');
  const xyScale=Math.min(requestedWidth/eastWestM,(preset.bed[0]-10)/eastWestM,(preset.bed[1]-10)/northSouthM),width=eastWestM*xyScale,depth=northSouthM*xyScale;
  const res=clamp(Math.round(resolution),8,128),layer=state.layers?.[selected],local=state.dataset==='gadakwadi';
  if(mode==='layer'&&(!layer||!Number.isFinite(layer.thickness)||layer.thickness<=0||!Number.isFinite(layer.width)||layer.width<=0||!Number.isFinite(local?layer.top:layer.depth)))throw new Error('Select a layer with valid dimensions before exporting.');
  const base=mode==='terrain'?3:0;let minSurface=Infinity,maxSurface=-Infinity;for(const row of grid)for(const value of row){minSurface=Math.min(minSurface,value);maxSurface=Math.max(maxSurface,value);}
  let poly=null;if(mode==='layer'&&local&&Number.isInteger(layer.footprint)){poly=fieldData?.aquifers?.find(a=>a.name===`Aquifer ${['I','II','III'][layer.footprint]}`)?.points;if(!poly)throw new Error('The mapped aquifer footprint is unavailable. Reload Gadakwadi before printing this layer.');}
  const inside=(u,v)=>{if(mode==='terrain')return true;const half=layer.width/200;if(Math.abs(u-.5)>half||Math.abs(v-.5)>half)return false;if(!poly)return true;const su=(u-.5)/(layer.width/100)+.5,sv=(v-.5)/(layer.width/100)+.5;return inPolygon(b[1]+su*(b[3]-b[1]),b[0]-sv*(b[0]-b[2]),poly);};
  const mask=Array.from({length:res},(_,j)=>Array.from({length:res},(_,i)=>inside((i+.5)/res,(j+.5)/res)));
  const topAt=(u,v)=>{const surface=sample(grid,u,v);return mode==='terrain'?surface:local?Math.min(layer.top,surface-2):surface-2-layer.depth;};
  let minTop=Infinity,maxTop=-Infinity,active=0;
  for(let j=0;j<res;j++)for(let i=0;i<res;i++)if(mask[j][i]){active++;for(const [ci,cj] of [[i,j],[i+1,j],[i+1,j+1],[i,j+1]]){const h=topAt(ci/res,cj/res);minTop=Math.min(minTop,h);maxTop=Math.max(maxTop,h);}}
  if(!active)throw new Error('This layer has no printable area inside the selected region.');
  const bottomElev=mode==='terrain'?minSurface:minTop-layer.thickness,range=mode==='terrain'?maxSurface-minSurface:maxTop-bottomElev;
  const zScale=Math.min(xyScale*requestedExaggeration,(preset.bed[2]-10-base)/Math.max(range,.0001));
  const effectiveExaggeration=zScale/xyScale,triangles=[];let separatedContacts=0;
  const isActive=(i,j)=>!!mask[j]?.[i];
  // Resolve point-only contact between diagonal footprint cells into two small
  // separate corners. This prevents a four-face non-manifold vertical edge.
  function point(ci,cj,cellI,cellJ,bottom=false){let u=ci/res,v=cj/res;if(mode==='layer'){
    const nw=isActive(ci-1,cj-1),ne=isActive(ci,cj-1),sw=isActive(ci-1,cj),se=isActive(ci,cj);
    if((nw&&se&&!ne&&!sw)||(ne&&sw&&!nw&&!se)){
      const gap=Math.min(.1,width/res*.05,depth/res*.05);u+=(cellI+.5-ci)*2*gap/width;v+=(cellJ+.5-cj)*2*gap/depth;separatedContacts++;
    }
  }const h=topAt(u,v);return [u*width,(1-v)*depth,mode==='terrain'&&bottom?0:base+(h-(bottom?layer.thickness:0)-bottomElev)*zScale];}
  const tri=(a,b,c)=>triangles.push([a,b,c]),quad=(a,b,c,d)=>{tri(a,b,c);tri(a,c,d);};
  for(let j=0;j<res;j++)for(let i=0;i<res;i++)if(mask[j][i]){
    const a=point(i,j,i,j),c=point(i+1,j+1,i,j),bb=point(i+1,j,i,j),dd=point(i,j+1,i,j),A=point(i,j,i,j,true),C=point(i+1,j+1,i,j,true),B=point(i+1,j,i,j,true),D=point(i,j+1,i,j,true);
    tri(a,dd,bb);tri(dd,c,bb);tri(A,B,D);tri(D,B,C);
    if(!isActive(i,j-1))quad(a,bb,B,A);
    if(!isActive(i,j+1))quad(dd,D,C,c);
    if(!isActive(i-1,j))quad(a,A,D,dd);
    if(!isActive(i+1,j))quad(bb,c,C,B);
  }
  const mesh=inspectPrintMesh(triangles);
  if(!mesh.watertight)throw new Error('This footprint did not produce a closed printable solid. Try the terrain block or revise the layer extent.');
  const warnings=[];
  if(width<requestedWidth-.1)warnings.push('Width reduced automatically to fit the printer bed with 5 mm clearance on each edge.');
  if(effectiveExaggeration<requestedExaggeration-.001)warnings.push('Vertical exaggeration reduced automatically to fit the printer height.');
  if(mode==='layer'&&layer.thickness*zScale<.6)warnings.push('This layer is thinner than 0.6 mm. Increase vertical exaggeration or print size before slicing.');
  if(mode==='layer')warnings.push('The aquifer underside may be uneven. Inspect orientation and supports in your slicer; disconnected islands are separate pieces.');
  if(separatedContacts)warnings.push('Point-only footprint contacts are separated by up to 0.2 mm to keep the mesh manifold.');
  const label=mode==='terrain'?'terrain-block':safeName(layer.name),filename=`${safeName(state.name)}-${label}.stl`;
  const evidence=local?'Local mapped aquifer footprints; vertical geometry is an editable interpretation.':'Reference layers do not reflect real-world data.';
  const settings={format:'STL',units:'mm',printer:preset.name,printerBedMm:preset.bed,printerSource:preset.source,manufacturerProfile:preset.profileSource||null,mode,model:state.name,layer:mode==='layer'?layer.name:null,dimensionsMm:mesh.dimensionsMm.map(n=>+n.toFixed(2)),requestedWidthMm:requestedWidth,requestedVerticalExaggeration:requestedExaggeration,effectiveVerticalExaggeration:+effectiveExaggeration.toFixed(3),horizontalMetresPerMillimetre:+(1/xyScale).toFixed(4),horizontalScaleDenominator:Math.round(1000/xyScale),baseThicknessMm:base,triangles:mesh.triangles,watertight:mesh.watertight,volumeMm3:+mesh.volumeMm3.toFixed(2),material:'PLA',nozzleMm:preset.nozzle,layerHeightMm:preset.layer,walls:3,infillPercent:15,supports:mode==='terrain'?'Normally not needed for the vertical-sided block; inspect preview.':'Inspect underside; supports may be needed.',slicer:'Use the manufacturer profile for your exact machine and filament. STL does not store these settings.',terrainSource:terrain.source||'Current elevation grid',evidence,layerSource:mode==='layer'?layer.source:null,review:state.review||null,bounds:[...b],warnings,scope:mode==='terrain'?'Terrain surface with a flat solid base. Hidden aquifer layers, satellite colours, wells and drainage are not encoded in STL.':'One edited aquifer layer, rasterized at the chosen print resolution. Terrain, other layers and colours are not included.'};
  const settingsText=`PATAMU — 3D PRINT SETTINGS\n\n${JSON.stringify(settings,null,2)}\n\nImport ${filename} into your slicer as MILLIMETRES.\nCheck the slicer preview, bed placement, wall thickness and support requirements before printing.\nThis is a teaching model, not a subsurface survey.\n`;
  const buffer=binarySTL(triangles,`${state.name} | ${evidence}`);
  return {blob:new Blob([buffer],{type:'model/stl'}),buffer,filename,settings,settingsText,settingsBlob:new Blob([settingsText],{type:'text/plain;charset=utf-8'}),settingsFilename:filename.replace(/\.stl$/, '-print-settings.txt'),mesh};
}
