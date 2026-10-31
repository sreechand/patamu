import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {SoftwareRenderer} from './software-renderer.js';
import {USDZExporter} from './vendor/USDZExporter.js';

// Surface tracking is a device capability, not a browser-wide guarantee.
// WebXR uses real hit tests. Quick Look uses the current edited model.
// The camera preview deliberately never claims to be spatially anchored.
let activeViewer = null;
const WIDTH_METRES = .25;

function addStyles() {
  if (document.querySelector('link[data-patamu-ar]')) return;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('./ar-viewer.css', import.meta.url).href;
  style.dataset.patamuAr = '';
  document.head.append(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(text, handler, primary = false) {
  const button = el('button', `patamu-ar-action${primary ? ' patamu-ar-primary' : ''}`, text);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function disposeObject(object) {
  object?.traverse(item => {
    item.geometry?.dispose();
    for (const material of item.material ? [].concat(item.material) : []) {
      // Original satellite textures are shared with the main viewer.
      if (material.map?.userData.arOwned) material.map.dispose();
      material.dispose();
    }
  });
}

function fitLabel(ctx, text, width, startSize) {
  let size = startSize;
  do { ctx.font = `600 ${size}px system-ui, sans-serif`; size--; }
  while (ctx.measureText(text).width > width && size > 13);
  return text;
}

/** Independent, metre-scaled model. The label remains in the exported USDZ. */
export function cloneARModel(model, title = 'Patamu teaching model', provenance = '') {
  if (!model) throw new Error('Wait for the model to finish loading.');
  const clone = model.clone(true);
  clone.traverse(item => {
    if (item.geometry) item.geometry = item.geometry.clone();
    if (item.material) item.material = Array.isArray(item.material)
      ? item.material.map(material => material.clone()) : item.material.clone();
  });
  clone.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(clone);
  if (bounds.isEmpty()) { disposeObject(clone); throw new Error('The model has no geometry yet.'); }
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const footprint = Math.max(size.x, size.z);
  if (!Number.isFinite(footprint) || footprint <= 0) {
    disposeObject(clone); throw new Error('The model dimensions are invalid.');
  }
  const scale = WIDTH_METRES / footprint;
  // Native USDZ supports meshes, not Three.js line primitives. Turn the
  // existing mapped polylines into narrow tubes so watershed/drainage lines
  // travel with the same model instead of silently disappearing in Quick Look.
  const lines = [];
  clone.traverse(item => {if(item.isLine && item.geometry?.attributes.position)lines.push(item);});
  for (const line of lines) {
    const positions=line.geometry.attributes.position, points=[];
    for(let i=0;i<positions.count;i++){
      const point=new THREE.Vector3().fromBufferAttribute(positions,i);
      if(!points.length||point.distanceToSquared(points[points.length-1])>1e-12)points.push(point);
    }
    if(points.length<2)continue;
    if(line.isLineLoop)points.push(points[0].clone());
    const path=new THREE.CurvePath();
    for(let i=1;i<points.length;i++)path.add(new THREE.LineCurve3(points[i-1],points[i]));
    const geometry=new THREE.TubeGeometry(path,Math.min(800,Math.max(24,points.length*2)),footprint*.0012,5,false);
    const material=new THREE.MeshStandardMaterial({color:line.material.color,opacity:line.material.opacity,transparent:line.material.transparent,roughness:1});
    const tube=new THREE.Mesh(geometry,material);tube.name=line.name;tube.visible=line.visible;
    tube.position.copy(line.position);tube.quaternion.copy(line.quaternion);tube.scale.copy(line.scale);
    line.parent.add(tube);line.removeFromParent();line.geometry.dispose();line.material.dispose();
  }
  const content = new THREE.Group();
  // Do not mutate the app's shared world, layers, flags or camera.
  const offset = new THREE.Group();
  offset.add(clone);
  offset.position.set(-center.x, -bounds.min.y, -center.z);
  content.add(offset);
  content.scale.setScalar(scale);
  content.position.y = .022;
  const root = new THREE.Group();
  root.name = title;
  root.userData = {title, provenance, units:'metres', nominalFootprintMetres:WIDTH_METRES};
  root.add(content);
  const width = size.x * scale, depth = size.z * scale;
  const base = new THREE.Mesh(new THREE.BoxGeometry(width, .022, depth),
    new THREE.MeshStandardMaterial({color:'#163d3b', roughness:1}));
  base.position.y = .011;
  root.add(base);
  const canvas = document.createElement('canvas');
  canvas.width = 1536; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#163d3b'; ctx.fillRect(0,0,1536,160);
  ctx.fillStyle = '#fffef3'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  fitLabel(ctx, title, 1460, 42); ctx.fillText(title,768,47);
  const label = provenance || 'Teaching model · verify the terrain and aquifer interpretation';
  fitLabel(ctx,label,1460,30);ctx.fillStyle='#d3e7da';ctx.fillText(label,768,111);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.arOwned = true;
  const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(width, .021),
    new THREE.MeshStandardMaterial({map:texture,roughness:1,side:THREE.DoubleSide}));
  labelMesh.position.set(0,.011,depth/2+.0004);
  root.add(labelMesh);
  root.updateMatrixWorld(true);
  return root;
}

export async function openAR({model, title = 'Patamu teaching model', provenance = '', onClose} = {}) {
  activeViewer?.close();
  addStyles();
  const returnFocus = document.activeElement;
  const localModel = cloneARModel(model, title, provenance);
  let renderer, camera, scene, controls, stream, session, hitSource, reticle, placed = false;
  let animationId = 0, mode = 'choose', closed = false, sessionClosing = false;
  let exportUrl = null, exportPending = null, exporterClosed = false;
  const dialog = el('dialog','patamu-ar-dialog');
  dialog.setAttribute('aria-label','View this model in your space');
  const header = el('div','patamu-ar-header');
  const heading = el('div');
  heading.append(el('div','patamu-ar-eyebrow','YOUR VILLAGE, IN THE ROOM'),el('h2','', 'View in your space'));
  const closeButton = action('Close ×', () => close());
  closeButton.setAttribute('aria-label','Close camera and augmented reality');
  header.append(heading,closeButton);
  const chooser = el('div','patamu-ar-chooser');
  chooser.append(el('p','patamu-ar-intro', `${title} · a 25 cm teaching model you can resize.`));
  chooser.append(el('p','patamu-ar-provenance', provenance || 'Teaching model. Review all terrain and aquifer interpretations before training.'));
  const surfaceButton = action('Checking surface AR…', startXR, true);
  surfaceButton.disabled = true;
  const surfaceHint = el('p','patamu-ar-hint','Checking this browser’s surface-tracking capability.');
  const quickButton = action('Prepare iPhone / iPad AR', prepareQuickLook);
  const quickHint = el('p','patamu-ar-hint','Creates a USDZ of your current edited model. Open it in Safari on a compatible iPhone or iPad to place it on a surface.');
  const quickLink = el('a','patamu-ar-action patamu-ar-primary','Open model in Apple Quick Look ↗');
  quickLink.rel = 'ar'; quickLink.hidden = true;
  // An image child is required for Safari's AR link recognition.
  const quickIcon = el('img');quickIcon.alt='';quickIcon.width=1;quickIcon.height=1;
  quickIcon.src='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E';
  quickLink.prepend(quickIcon);
  const downloadLink = el('a','patamu-ar-download','Download the same USDZ file ↓');
  downloadLink.hidden = true;
  const previewButton = action('Camera preview', startPreview);
  const previewHint = el('p','patamu-ar-hint','For other browsers: see the model over your camera. This preview stays on screen and does not attach to a real surface.');
  chooser.append(surfaceButton,surfaceHint,quickButton,quickHint,quickLink,downloadLink,previewButton,previewHint);
  const privacy = el('p','patamu-ar-privacy','Camera access starts only when you choose a camera mode. No camera frames are uploaded. AR support depends on your phone and browser.');
  chooser.append(privacy);
  const status = el('p','patamu-ar-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const stage = el('div','patamu-ar-stage');stage.hidden=true;
  const video = el('video','patamu-ar-video');video.muted=true;video.playsInline=true;video.autoplay=true;
  const canvasHost = el('div','patamu-ar-canvas');
  const overlay = el('div','patamu-ar-overlay');
  const cameraNotice = el('p','patamu-ar-camera-notice');
  const provenanceNotice = el('p','patamu-ar-camera-provenance',provenance || 'Teaching model · verify all interpretations');
  const sessionActions = el('div','patamu-ar-session-actions');
  const placeButton = action('Place model', placeModel, true);placeButton.disabled=true;
  const resetButton = action('Move model', resetPlacement);
  const backButton = action('Back', async () => { await stopMode(); });
  sessionActions.append(placeButton,resetButton,backButton);
  const scaleLabel = el('label','patamu-ar-scale');
  const scaleText = el('span','','Model width: 25 cm');
  const scaleInput = el('input');scaleInput.type='range';scaleInput.min='15';scaleInput.max='70';scaleInput.value='25';scaleInput.step='1';scaleInput.setAttribute('aria-label','AR model footprint in centimetres');
  scaleLabel.append(scaleText,scaleInput);
  scaleInput.addEventListener('input',()=>{const cm=Number(scaleInput.value);localModel.scale.setScalar(cm/25);scaleText.textContent=`Model width: ${cm} cm`;});
  const rotateButton = action('Rotate 45°',()=>{localModel.rotation.y += Math.PI/4;});
  sessionActions.append(rotateButton);
  overlay.append(cameraNotice,provenanceNotice,sessionActions,scaleLabel);
  overlay.addEventListener('beforexrselect',event=>event.preventDefault());
  stage.append(video,canvasHost,overlay);
  dialog.append(header,chooser,status,stage);
  document.body.append(dialog);dialog.showModal();
  const resizeObserver = new ResizeObserver(resize);resizeObserver.observe(stage);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  document.addEventListener('visibilitychange',onVisibility);
  window.addEventListener('pagehide',close);
  activeViewer = {close};

  const quickLookSupported = (()=>{try{return quickLink.relList.supports('ar');}catch{return false;}})();
  quickButton.textContent=quickLookSupported?'Prepare surface AR for this iPhone / iPad':'Create iPhone / iPad AR file';
  if (!window.isSecureContext) {
    surfaceButton.textContent='Surface AR needs a secure connection';
    surfaceHint.textContent='Open this app using its HTTPS address.';
    previewButton.disabled=true;
  } else {
    if (!navigator.mediaDevices?.getUserMedia) {
      previewButton.disabled=true;previewHint.textContent='This browser does not expose camera access. Try the system browser.';
    }
    Promise.resolve(navigator.xr?.isSessionSupported?.('immersive-ar') || false).then(supported=>{
      if(closed)return;
      surfaceButton.disabled=!supported;
      surfaceButton.textContent=supported?'Place on a surface':'Surface AR unavailable in this browser';
      surfaceHint.textContent=supported?'Move your phone slowly to find a floor or table, then tap Place model.':'Use Apple Quick Look on a compatible iPhone / iPad, or try Chrome on an ARCore-compatible Android phone. Camera preview remains available where camera access is supported.';
    }).catch(()=>{surfaceButton.textContent='Surface AR unavailable';surfaceHint.textContent='Try Apple Quick Look or the camera preview below.';});
  }

  function setStatus(message, error = false) {status.textContent=message;status.classList.toggle('patamu-ar-error',error);}

  function createScene(allowSoftware) {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(48,1,.005,30);
    camera.position.set(.32,.32,.47);
    scene.add(new THREE.HemisphereLight(0xffffff,0x556b64,2.8));
    const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(1,2,1);scene.add(sun);
    const anchor = new THREE.Group();anchor.name='PatamuSurfaceAnchor';anchor.add(localModel);scene.add(anchor);
    try {renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});}
    catch (error) {if(!allowSoftware)throw new Error('WebGL is unavailable. Use the camera preview or the iPhone / iPad file.');renderer=new SoftwareRenderer();}
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
    renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
    renderer.domElement.setAttribute('aria-label','Augmented reality teaching model');
    canvasHost.replaceChildren(renderer.domElement);resize();
    return anchor;
  }

  function resize() {
    if(!renderer||!camera||mode==='xr')return;
    const rect=stage.getBoundingClientRect();if(!rect.width||!rect.height)return;
    renderer.setSize(rect.width,rect.height);camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();
  }

  async function startXR() {
    if(mode!=='choose'||closed)return;
    mode='starting-xr';
    surfaceButton.disabled=true;setStatus('Opening surface AR…');
    try {
      // requestSession must run directly from the user's click, before await.
      const requested = navigator.xr.requestSession('immersive-ar',{
        requiredFeatures:['hit-test'],optionalFeatures:['dom-overlay'],domOverlay:{root:dialog}
      });
      session = await requested;
      if(closed){await session.end();return;}
      mode='xr';chooser.hidden=true;stage.hidden=false;video.hidden=true;
      dialog.classList.add('patamu-ar-active','patamu-ar-xr');
      cameraNotice.textContent='Move your phone slowly. A ring appears when a horizontal surface is found.';
      placeButton.hidden=false;resetButton.hidden=false;scaleLabel.hidden=false;
      const anchor=createScene(false);anchor.visible=false;
      renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local');
      renderer.setSize(window.innerWidth,window.innerHeight);
      reticle = new THREE.Mesh(new THREE.RingGeometry(.045,.055,32).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({color:0xb8f0bb,side:THREE.DoubleSide}));
      reticle.matrixAutoUpdate=false;reticle.visible=false;scene.add(reticle);
      session.addEventListener('end',onSessionEnd,{once:true});
      session.addEventListener('select',placeModel);
      await renderer.xr.setSession(session);
      const viewerSpace=await session.requestReferenceSpace('viewer');
      hitSource=await session.requestHitTestSource({space:viewerSpace});
      setStatus('');
      renderer.setAnimationLoop((time,frame)=>{
        if(!frame||closed)return;
        if(!placed&&hitSource){
          const hit=frame.getHitTestResults(hitSource)[0];
          const pose=hit?.getPose(renderer.xr.getReferenceSpace());
          // Ignore wall-like hits: the intended placement is a floor/table.
          const matrix=pose?new THREE.Matrix4().fromArray(pose.transform.matrix):null;
          const up=matrix?new THREE.Vector3(0,1,0).transformDirection(matrix):null;
          reticle.visible=!!pose&&Math.abs(up.y)>.8;
          if(reticle.visible)reticle.matrix.copy(matrix);
          placeButton.disabled=!reticle.visible;
          cameraNotice.textContent=reticle.visible?'Surface found. Tap Place model, or tap the screen.':'Move slowly over a well-lit floor or table to find a surface.';
        }
        renderer.render(scene,camera);
      });
    } catch(error) {
      await stopMode();
      setStatus(error.name==='NotAllowedError'?'Camera / AR access was not allowed. You can try again or use the iPhone / iPad file.':`Could not start surface AR. ${error.message||'Try a supported device or camera preview.'}`,true);
    } finally {if(!closed)surfaceButton.disabled=false;}
  }

  function placeModel() {
    if(mode!=='xr'||!reticle?.visible)return;
    const anchor=scene.getObjectByName('PatamuSurfaceAnchor');
    reticle.matrix.decompose(anchor.position,anchor.quaternion,anchor.scale);
    anchor.visible=true;placed=true;reticle.visible=false;placeButton.disabled=true;
    cameraNotice.textContent='Pinned to this surface. Walk around the model. Use Move model to place it elsewhere.';
  }

  function resetPlacement() {
    if(mode!=='xr')return;
    placed=false;const anchor=scene?.getObjectByName('PatamuSurfaceAnchor');if(anchor)anchor.visible=false;
    cameraNotice.textContent='Move your phone to find a new surface.';
  }

  async function startPreview() {
    if(mode!=='choose'||closed)return;
    mode='starting-preview';
    previewButton.disabled=true;setStatus('Waiting for camera permission…');
    try {
      const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
      if(closed){newStream.getTracks().forEach(track=>track.stop());return;}
      stream=newStream;video.srcObject=stream;await video.play();
      if(closed){newStream.getTracks().forEach(track=>track.stop());return;}
      mode='preview';chooser.hidden=true;stage.hidden=false;video.hidden=false;
      dialog.classList.add('patamu-ar-active');
      cameraNotice.textContent='CAMERA PREVIEW · stays on screen, not attached to a surface. Drag to rotate; pinch to zoom.';
      placeButton.hidden=true;resetButton.hidden=true;scaleLabel.hidden=true;
      createScene(true);localModel.parent.visible=true;
      controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.07,0);controls.enableDamping=true;controls.minDistance=.15;controls.maxDistance=2;controls.update();
      setStatus('');let lastFrame=0;
      const render=(time)=>{if(closed||mode!=='preview')return;animationId=requestAnimationFrame(render);if(time-lastFrame<(renderer.isSoftware?100:32))return;lastFrame=time;controls.update();renderer.render(scene,camera);};
      animationId=requestAnimationFrame(render);
    } catch(error) {
      await stopMode();
      const message=error.name==='NotAllowedError'?'Camera permission was denied. Allow camera access in your browser settings, then try again.':error.name==='NotFoundError'?'No camera was found on this device.':`Camera preview could not start. ${error.message||''}`;
      setStatus(message,true);
    } finally {if(!closed)previewButton.disabled=false;}
  }

  async function prepareQuickLook() {
    if(closed||exportPending)return;
    quickButton.disabled=true;quickButton.textContent='Preparing your edited model…';setStatus('Creating the AR file on this device. This may take a moment for detailed terrain.');
    exportPending=(async()=>{
      const exportScene=new THREE.Scene();
      // Export a separate clone so camera sessions cannot change transforms.
      const copy=localModel.clone(true);copy.position.set(0,0,0);copy.quaternion.identity();copy.scale.setScalar(1);exportScene.add(copy);exportScene.updateMatrixWorld(true);
      const bytes=await new USDZExporter().parseAsync(exportScene,{quickLookCompatible:true,maxTextureSize:1024});
      if(closed)return;
      if(exportUrl)URL.revokeObjectURL(exportUrl);
      exportUrl=URL.createObjectURL(new Blob([bytes],{type:'model/vnd.usdz+zip'}));
      const filename=(title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'patamu-model')+'.usdz';
      quickLink.href=exportUrl+'#allowsContentScaling=1';quickLink.download=filename;
      downloadLink.href=exportUrl;downloadLink.download=filename;
      quickLink.hidden=!quickLookSupported;downloadLink.hidden=false;
      quickButton.hidden=true;
      setStatus(quickLookSupported?'Ready. Tap Open model in Apple Quick Look, select AR, then move your phone to find a surface.':'AR file ready. Download it and open it in Safari / Files on a compatible iPhone or iPad.');
    })();
    try {await exportPending;}
    catch(error){if(!closed){setStatus(`Could not create the AR file. ${error.message||'Try again with fewer layers.'}`,true);quickButton.disabled=false;quickButton.textContent='Try preparing the AR file again';}}
    finally{exportPending=null;if(exporterClosed)disposeObject(localModel);}
  }

  function onSessionEnd() {session=null;if(!closed)stopMode();}
  function onVisibility() {if(document.hidden&&mode==='preview')stopMode();}

  async function stopMode() {
    if(session&&!sessionClosing){sessionClosing=true;try{await session.end();}catch{}session=null;sessionClosing=false;}
    hitSource?.cancel();hitSource=null;
    cancelAnimationFrame(animationId);animationId=0;
    renderer?.setAnimationLoop?.(null);controls?.dispose();controls=null;
    stream?.getTracks().forEach(track=>track.stop());stream=null;video.pause();video.srcObject=null;
    if(scene){localModel.removeFromParent();disposeObject(scene);scene=null;}
    renderer?.dispose?.();renderer?.forceContextLoss?.();renderer=null;reticle=null;camera=null;
    canvasHost.replaceChildren();mode='choose';placed=false;
    if(!closed){chooser.hidden=false;stage.hidden=true;dialog.classList.remove('patamu-ar-active','patamu-ar-xr');setStatus('');}
  }

  function close() {
    if(closed)return;closed=true;
    stopMode();resizeObserver.disconnect();
    document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',close);
    if(exportUrl)URL.revokeObjectURL(exportUrl);
    if(exportPending)exporterClosed=true;else disposeObject(localModel);
    dialog.close();dialog.remove();
    if(activeViewer?.close===close)activeViewer=null;
    returnFocus?.focus?.();onClose?.();
  }
  return {close};
}
