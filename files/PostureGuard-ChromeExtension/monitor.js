// ── PostureGuard Monitor v2 ──
// Fixes: lower thresholds, in-page alerts, audio beep, debug panel, better detection

const $ = (id) => document.getElementById(id);

// ═══ CONFIG ═══
const CONFIG = {
  SLOUCH_THRESHOLD: 10,      // % of face height (distance-invariant)
  LEAN_FORWARD_THRESHOLD: 12,
  LEAN_BACK_THRESHOLD: 18,   // % face size decrease = leaning back
  SIDE_LEAN_THRESHOLD: 8,    // % of face width (distance-invariant)
  ALERT_COOLDOWN_MS: 10000,
  BAD_POSTURE_DELAY_MS: 1500,
  DETECTION_INTERVAL_MS: 300,
  STRETCH_INTERVAL_MIN: 30,
  WATER_INTERVAL_MIN: 60,
};

// ═══ STATE ═══
let state = {
  phase: 'setup',
  stream: null,
  detector: null,
  detectionTimer: null,
  calibration: null,
  currentPosture: 'unknown',
  badPostureSince: null,
  lastAlertTime: 0,
  sittingStartTime: null,
  totalSittingMs: 0,
  paused: false,
  waterCount: 0,
  waterGoal: 8,
  logs: [],
  alertSound: null,
  detectionMethod: 'none',
};

// ═══ AUDIO BEEP ═══
function initAudio() {
  try { state.alertSound = new AudioContext(); } catch (e) {}
}

function playBeep(freq = 520, duration = 0.25) {
  if (!state.alertSound) return;
  try {
    const ctx = state.alertSound;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function playAlertBeeps() {
  playBeep(520, 0.15);
  setTimeout(() => playBeep(680, 0.15), 200);
  setTimeout(() => playBeep(520, 0.25), 400);
}

// ═══ FACE DETECTOR (face-api.js TinyFaceDetector) ═══
let faceApiReady = false;

async function initDetector() {
  if (typeof faceapi === 'undefined') {
    state.detectionMethod = 'none';
    addLog('❌', 'face-api.js not loaded — check libs/face-api.min.js');
    return;
  }
  try {
    // TF.js internally fetches with mode:'cors' which fails for chrome-extension:// URLs.
    // Instead, fetch files ourselves (no CORS restriction for extension pages accessing
    // their own resources), then load the weight map directly into the network.
    const base = chrome.runtime.getURL('models');
    const [manifestRes, shardRes] = await Promise.all([
      fetch(`${base}/tiny_face_detector_model-weights_manifest.json`),
      fetch(`${base}/tiny_face_detector_model-shard1`),
    ]);
    if (!manifestRes.ok) throw new Error(`Manifest: HTTP ${manifestRes.status}`);
    if (!shardRes.ok) throw new Error(`Weights: HTTP ${shardRes.status}`);

    const manifest = await manifestRes.json();
    const shardBuffer = await shardRes.arrayBuffer();

    // faceapi re-exports all TF.js core functions including io.decodeWeights
    const weightMap = faceapi.tf.io.decodeWeights(shardBuffer, manifest[0].weights);
    await faceapi.nets.tinyFaceDetector.loadFromWeightMap(weightMap);

    faceApiReady = true;
    state.detectionMethod = 'face-api.js (TinyFaceDetector)';
    addLog('✅', 'ML face detection ready');
  } catch (err) {
    faceApiReady = false;
    state.detectionMethod = 'none';
    addLog('❌', `Model load failed: ${err.message}`);
    console.error('initDetector error:', err);
  }
}

async function detectFace(video) {
  if (!faceApiReady || video.readyState < 2) return null;
  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const detection = await faceapi.detectSingleFace(video, options);
    if (!detection) return null;
    const box = detection.box;
    return {
      x: box.x, y: box.y, width: box.width, height: box.height,
      centerX: box.x + box.width / 2,
      centerY: box.y + box.height / 2,
      confidence: detection.score > 0.75 ? 'high' : 'low',
    };
  } catch (err) {
    return null;
  }
}

// ═══ POSTURE ANALYSIS ═══
function analyzePosture(face) {
  if (!state.calibration || !face) return { status: 'unknown' };
  const cal = state.calibration;

  // Normalize by face dimensions (not frame size) so detection is distance-invariant.
  // A lean of the same angle triggers at any distance from the camera.
  const yDev = ((face.centerY - cal.centerY) / cal.faceHeight) * 100;
  const sizeDev = ((face.width - cal.faceWidth) / cal.faceWidth) * 100;
  const xDev = ((face.centerX - cal.centerX) / cal.faceWidth) * 100;

  const issues = [];
  if (yDev > CONFIG.SLOUCH_THRESHOLD) issues.push('Slouching — sit upright');
  if (sizeDev > CONFIG.LEAN_FORWARD_THRESHOLD) issues.push('Too close — sit back');
  if (sizeDev < -CONFIG.LEAN_BACK_THRESHOLD) issues.push('Leaning back — sit upright');
  if (Math.abs(xDev) > CONFIG.SIDE_LEAN_THRESHOLD) issues.push(`Leaning ${xDev > 0 ? 'right' : 'left'} — center yourself`);

  return {
    status: issues.length > 0 ? 'bad' : 'good',
    issues,
    metrics: {
      headPos: Math.round(yDev * 10) / 10,
      bodyLean: Math.round(xDev * 10) / 10,
      distance: Math.round(sizeDev * 10) / 10,
    },
    rawFace: face,
  };
}

// ═══ IN-PAGE ALERT ═══
function showInPageAlert(message) {
  let overlay = $('alertOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'alertOverlay';
    overlay.innerHTML = `
      <div class="alert-overlay-inner">
        <div class="alert-overlay-icon">⚠️</div>
        <div class="alert-overlay-title">Fix Your Posture!</div>
        <div class="alert-overlay-msg" id="alertOverlayMsg"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  $('alertOverlayMsg').textContent = message;
  overlay.classList.add('visible');
  clearTimeout(overlay._hideTimer);
  overlay._hideTimer = setTimeout(() => overlay.classList.remove('visible'), 4000);
}

// ═══ UI UPDATES ═══
function updatePostureUI(analysis) {
  const icon = $('postureIcon');
  const label = $('postureLabel');
  const detail = $('postureDetail');
  const badge = $('videoBadge');

  if (analysis.status === 'good') {
    icon.textContent = '✅'; label.textContent = 'Excellent'; label.style.color = 'var(--green)';
    detail.textContent = 'Your posture looks great!';
    badge.className = 'video-badge badge-good'; badge.textContent = '✓ GOOD POSTURE';
  } else if (analysis.status === 'bad') {
    icon.textContent = '⚠️'; label.textContent = 'Needs Fix'; label.style.color = 'var(--red)';
    detail.textContent = analysis.issues.join(' · ');
    badge.className = 'video-badge badge-bad'; badge.textContent = '⚠ FIX POSTURE';
  } else {
    icon.textContent = '👤'; label.textContent = 'No Face'; label.style.color = 'var(--text-dim)';
    detail.textContent = 'Make sure your face is visible';
    badge.className = 'video-badge badge-calibrating'; badge.textContent = 'SEARCHING…';
  }

  if (analysis.metrics) {
    const m = analysis.metrics;
    $('scoreHead').textContent = (m.headPos > 0 ? '+' : '') + m.headPos + '%';
    $('scoreHead').style.color = Math.abs(m.headPos) > CONFIG.SLOUCH_THRESHOLD ? 'var(--red)' : 'var(--green)';
    $('scoreLean').textContent = (m.bodyLean > 0 ? '+' : '') + m.bodyLean + '%';
    $('scoreLean').style.color = Math.abs(m.bodyLean) > CONFIG.SIDE_LEAN_THRESHOLD ? 'var(--red)' : 'var(--green)';
    $('scoreDistance').textContent = (m.distance > 0 ? '+' : '') + m.distance + '%';
    $('scoreDistance').style.color = m.distance > CONFIG.LEAN_FORWARD_THRESHOLD ? 'var(--red)' : 'var(--green)';
  }

  updateDebug(analysis);
}

function updateDebug(analysis) {
  const dbg = $('debugContent');
  if (!dbg || $('debugPanel').classList.contains('hidden')) return;
  const m = analysis.metrics || { headPos: 0, bodyLean: 0, distance: 0 };
  const cal = state.calibration;

  dbg.innerHTML = `
    <b>Method:</b> ${state.detectionMethod} | <b>Confidence:</b> ${analysis.rawFace?.confidence || '--'}<br>
    <b>Status:</b> <span style="color:${analysis.status==='good'?'var(--green)':analysis.status==='bad'?'var(--red)':'var(--yellow)'}">${analysis.status.toUpperCase()}</span><br>
    ─────────────────────<br>
    <b>Head Y:</b> ${m.headPos}% <span style="color:var(--text-dim)">(thresh ±${CONFIG.SLOUCH_THRESHOLD}% of face-h)</span><br>
    <b>Side X:</b> ${m.bodyLean}% <span style="color:var(--text-dim)">(thresh ±${CONFIG.SIDE_LEAN_THRESHOLD}% of face-w)</span><br>
    <b>Dist Δ:</b> ${m.distance}% <span style="color:var(--text-dim)">(thresh +${CONFIG.LEAN_FORWARD_THRESHOLD}% of face-w)</span><br>
    ${cal ? `─────────────────────<br><b>Cal:</b> (${Math.round(cal.centerX)},${Math.round(cal.centerY)}) ${Math.round(cal.faceWidth)}×${Math.round(cal.faceHeight)}` : ''}
    ${analysis.rawFace ? `<br><b>Now:</b> (${Math.round(analysis.rawFace.centerX)},${Math.round(analysis.rawFace.centerY)}) ${Math.round(analysis.rawFace.width)}×${Math.round(analysis.rawFace.height)}` : ''}
  `;
}

function updateTimerUI() {
  if (!state.sittingStartTime || state.paused) return;
  const elapsed = Date.now() - state.sittingStartTime;
  state.totalSittingMs = elapsed;
  const hrs = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  $('timerDisplay').textContent = String(hrs).padStart(2,'0') + ':' + String(mins).padStart(2,'0') + ':' + String(secs).padStart(2,'0');

  const stretchMs = CONFIG.STRETCH_INTERVAL_MIN * 60000;
  const cycleElapsed = elapsed % stretchMs;
  $('stretchFill').style.width = (cycleElapsed / stretchMs * 100) + '%';
  const remaining = stretchMs - cycleElapsed;
  $('timerSub').textContent = `Stretch break in ${Math.floor(remaining/60000)}:${String(Math.floor((remaining%60000)/1000)).padStart(2,'0')}`;

  chrome.runtime.sendMessage({ type: 'UPDATE_SITTING', totalSittingMs: elapsed });
}

function updateWaterUI() {
  const c = $('waterGlasses');
  c.innerHTML = '';
  for (let i = 0; i < state.waterGoal; i++) {
    const g = document.createElement('div');
    g.className = 'glass' + (i < state.waterCount ? ' filled' : '');
    g.innerHTML = '<div class="glass-fill"></div>';
    c.appendChild(g);
  }
  $('waterCounter').textContent = `${state.waterCount} / ${state.waterGoal} glasses`;
}

function addLog(emoji, message) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.logs.unshift({ emoji, message, time });
  if (state.logs.length > 50) state.logs.pop();
  $('alertLog').innerHTML = state.logs.map(l =>
    `<div class="alert-entry"><span style="font-size:16px">${l.emoji}</span><span class="msg">${l.message}</span><span class="time">${l.time}</span></div>`
  ).join('');
}

// ═══ DRAW OVERLAY ═══
function drawOverlay(face) {
  const canvas = $('overlay');
  const video = $('webcam');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!face) return;

  const mx = canvas.width - face.x - face.width;
  const isGood = state.currentPosture === 'good';
  const color = isGood ? '#6ee7b7' : '#f87171';

  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash([8,4]);
  ctx.strokeRect(mx, face.y, face.width, face.height);
  ctx.setLineDash([]);

  const cx = mx + face.width/2, cy = face.y + face.height/2;
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2); ctx.fillStyle = color; ctx.fill();

  if (state.calibration) {
    const cal = state.calibration;
    const calCX = canvas.width - cal.centerX;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(0, cal.centerY); ctx.lineTo(canvas.width, cal.centerY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(calCX, 0); ctx.lineTo(calCX, canvas.height); ctx.stroke();
    ctx.setLineDash([]);
    const calMX = canvas.width - (cal.centerX - cal.faceWidth/2) - cal.faceWidth;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.strokeRect(calMX, cal.centerY - cal.faceHeight/2, cal.faceWidth, cal.faceHeight);
  }
}

// ═══ DETECTION LOOP ═══
async function detectionLoop() {
  if (state.phase !== 'monitoring' || state.paused) return;
  const video = $('webcam');
  if (video.readyState < 2) return;

  const face = await detectFace(video);
  drawOverlay(face);

  if (!face) {
    updatePostureUI({ status: 'unknown', metrics: null, rawFace: null });
    state.currentPosture = 'unknown'; state.badPostureSince = null;
    return;
  }
  if (!state.calibration) {
    updatePostureUI({ status: 'unknown', metrics: null, rawFace: face });
    $('postureDetail').textContent = 'Click "Calibrate" while sitting upright';
    return;
  }

  const analysis = analyzePosture(face);
  updatePostureUI(analysis);

  if (analysis.status === 'bad') {
    if (state.currentPosture !== 'bad') state.badPostureSince = Date.now();
    state.currentPosture = 'bad';

    const badDur = Date.now() - (state.badPostureSince || Date.now());
    const cooldownOk = Date.now() - state.lastAlertTime > CONFIG.ALERT_COOLDOWN_MS;

    if (badDur > CONFIG.BAD_POSTURE_DELAY_MS && cooldownOk) {
      state.lastAlertTime = Date.now();
      const detail = analysis.issues.join('. ');
      showInPageAlert(detail);
      playAlertBeeps();
      try { chrome.runtime.sendMessage({ type: 'BAD_POSTURE_ALERT', detail }); } catch(e){}
      addLog('🚨', detail);
      chrome.storage.local.set({ lastPostureState: 'bad' });
    }
  } else if (analysis.status === 'good') {
    if (state.currentPosture === 'bad') addLog('✅', 'Posture corrected!');
    state.currentPosture = 'good'; state.badPostureSince = null;
    chrome.storage.local.set({ lastPostureState: 'good' });
  }

  const dot = $('topDot'), ts = $('topStatus');
  if (state.currentPosture === 'good') { dot.className='dot dot-green'; ts.textContent='Posture OK'; ts.style.color='var(--green)'; }
  else if (state.currentPosture === 'bad') { dot.className='dot dot-red'; ts.textContent='Fix posture!'; ts.style.color='var(--red)'; }
  else { dot.className='dot dot-yellow'; ts.textContent='Detecting…'; ts.style.color='var(--yellow)'; }
}

// ═══ CALIBRATION ═══
async function calibrate() {
  const video = $('webcam');
  addLog('📐', 'Calibrating — hold your best posture…');
  $('calibInfo').textContent = 'Hold still for 2 seconds…';
  $('btnCalibrate').disabled = true;

  const samples = [];
  for (let i = 0; i < 6; i++) {
    const face = await detectFace(video);
    if (face) samples.push(face);
    await new Promise(r => setTimeout(r, 350));
  }
  $('btnCalibrate').disabled = false;

  if (samples.length < 3) {
    addLog('❌', 'Calibration failed — face not detected consistently');
    $('calibInfo').textContent = 'Failed — ensure face is visible and well-lit.';
    return;
  }

  const avg = {
    centerX: samples.reduce((s,f) => s+f.centerX, 0) / samples.length,
    centerY: samples.reduce((s,f) => s+f.centerY, 0) / samples.length,
    faceWidth: samples.reduce((s,f) => s+f.width, 0) / samples.length,
    faceHeight: samples.reduce((s,f) => s+f.height, 0) / samples.length,
    frameW: video.videoWidth, frameH: video.videoHeight,
  };

  state.calibration = avg;
  state.phase = 'monitoring';
  state.badPostureSince = null;
  state.lastAlertTime = 0;

  $('calibInfo').innerHTML = `<strong>Calibrated!</strong> Ref: (${Math.round(avg.centerX)},${Math.round(avg.centerY)}), ${Math.round(avg.faceWidth)}×${Math.round(avg.faceHeight)}`;
  addLog('✅', 'Calibration complete — now monitoring!');

  const d = await chrome.storage.local.get(['waterIntervalMin','stretchIntervalMin','waterCount','waterGoal']);
  CONFIG.STRETCH_INTERVAL_MIN = d.stretchIntervalMin || 30;
  CONFIG.WATER_INTERVAL_MIN = d.waterIntervalMin || 60;
  state.waterCount = d.waterCount || 0;
  state.waterGoal = d.waterGoal || 8;

  chrome.runtime.sendMessage({ type: 'START_MONITORING', waterInterval: CONFIG.WATER_INTERVAL_MIN, stretchInterval: CONFIG.STRETCH_INTERVAL_MIN });
  updateWaterUI();

  playBeep(880, 0.1);
  setTimeout(() => playBeep(1100, 0.15), 150);
}

// ═══ WEBCAM ═══
async function startWebcam() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false,
    });
    $('webcam').srcObject = state.stream;
    await new Promise(r => { $('webcam').onloadedmetadata = r; });

    $('setupScreen').classList.add('hidden');
    $('monitorScreen').classList.remove('hidden');
    state.phase = 'monitoring';
    state.sittingStartTime = Date.now();

    addLog('🎥', 'Webcam connected');
    initAudio();
    await initDetector();

    state.detectionTimer = setInterval(detectionLoop, CONFIG.DETECTION_INTERVAL_MS);
    setInterval(updateTimerUI, 1000);

    const data = await chrome.storage.local.get(['waterCount','waterGoal']);
    state.waterCount = data.waterCount || 0;
    state.waterGoal = data.waterGoal || 8;
    updateWaterUI();
  } catch (err) {
    console.error('Webcam error:', err);
    alert('Camera access denied. PostureGuard needs your webcam.\n\nAllow camera access and try again.');
  }
}

// ═══ EVENT HANDLERS ═══
$('btnStart').addEventListener('click', startWebcam);
$('btnCalibrate').addEventListener('click', calibrate);

$('btnPause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('btnPause').innerHTML = state.paused ? '▶ Resume' : '⏸ Pause';
  if (state.paused) { addLog('⏸','Paused'); $('topDot').className='dot dot-yellow'; $('topStatus').textContent='Paused'; }
  else { addLog('▶️','Resumed'); state.sittingStartTime = Date.now() - state.totalSittingMs; }
});

$('btnStopMonitor').addEventListener('click', () => {
  if (state.stream) state.stream.getTracks().forEach(t => { t.stop(); });
  clearInterval(state.detectionTimer);
  chrome.runtime.sendMessage({ type: 'STOP_MONITORING' });
  addLog('⏹','Stopped');
  const mins = Math.round(state.totalSittingMs / 60000);
  alert(`Session Summary:\n\n⏱ Sitting: ${mins} min\n💧 Water: ${state.waterCount} glasses`);
  window.close();
});

$('btnDrink').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'LOG_WATER' });
  if (resp) { state.waterCount = resp.waterCount; updateWaterUI(); addLog('💧',`Water logged (${state.waterCount}/${state.waterGoal})`); }
});

$('btnResetWater').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_WATER' });
  state.waterCount = 0; updateWaterUI(); addLog('↺','Water count reset');
});

// Debug toggle
document.addEventListener('DOMContentLoaded', () => {
  const t = $('toggleDebug');
  if (t) t.addEventListener('click', () => {
    const p = $('debugPanel');
    p.classList.toggle('hidden');
    t.textContent = p.classList.contains('hidden') ? '🔧 Debug' : '🔧 Hide Debug';
  });
});
