// ── PostureGuard Monitor v3 ──
// Hybrid detection: tinyFaceDetector (face box slouch) + MediaPipe Pose (shoulders/body)

const $ = (id) => document.getElementById(id);

// ═══ CONFIG ═══
const CONFIG = {
  // MediaPipe body thresholds (shoulder-width units, scale-invariant)
  SLOUCH_THRESHOLD: 0.15,
  SIDE_LEAN_THRESHOLD: 0.12,
  FORWARD_HEAD_THRESHOLD: 0.20,
  SHOULDER_ROUND_THRESHOLD: 0.10,
  // Face-based thresholds
  FACE_SLOUCH_THRESHOLD: 0.10,   // face drops relative to shoulders (normalised by shoulder width)
  FACE_TURN_THRESHOLD: 0.15,     // face X deviation as fraction of face width — suppresses slouch check when turned
  // General
  MIN_SHOULDER_WIDTH: 0.12,     // shoulder width below this → too far from camera
  MAX_SHOULDER_DRIFT: 0.6,      // >60% width change from calibration → different person, ignore
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
  calibrations: { sitting: null },
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
  faceReady: false,
  _lastStretchCycle: 0,
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

// ═══ POSE DETECTOR (MediaPipe Pose Landmarker) ═══
// 33 body landmarks — shoulders, hips, nose used for posture analysis
let poseDetector = null;
let poseReady = false;
let lastPose = null;

async function initDetector() {
  if (typeof Pose === 'undefined') {
    state.detectionMethod = 'none';
    addLog('❌', 'MediaPipe Pose not loaded — check mediapipe/pose.js');
    return;
  }
  try {
    poseDetector = new Pose({
      locateFile: (file) => chrome.runtime.getURL(`mediapipe/${file}`),
    });

    poseDetector.setOptions({
      modelComplexity: 0,          // lite — fastest, sufficient for posture
      smoothLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    // onResults fires before send() resolves — safe to read lastPose after await
    poseDetector.onResults((results) => {
      lastPose = results.poseLandmarks || null;
    });

    // Warm-up: triggers model load now so first real detection isn't slow
    const video = $('webcam');
    if (video && video.readyState >= 2) await poseDetector.send({ image: video });

    poseReady = true;
    state.detectionMethod = 'MediaPipe Pose Landmarker';
    addLog('✅', 'Pose detection ready — 33 body landmarks active');
  } catch (err) {
    poseReady = false;
    state.detectionMethod = 'none';
    addLog('❌', `Pose init failed: ${err.message}`);
    console.error('initDetector error:', err);
  }
}

async function detectPose(video) {
  if (!poseReady || !poseDetector || video.readyState < 2) return null;
  try {
    lastPose = undefined;
    await poseDetector.send({ image: video });
    return lastPose ?? null;
  } catch (_) {
    return null;
  }
}

// ═══ FACE DETECTOR (tinyFaceDetector via face-api.js) ═══
async function initFaceDetector() {
  if (typeof faceapi === 'undefined') {
    addLog('⚠️', 'face-api.js not loaded — face-based slouch detection disabled');
    return;
  }
  try {
    // TF.js's internal HTTP handler fails for chrome-extension:// URLs in MV3.
    // Fix: fetch model files ourselves (always works from extension pages),
    // decode weights manually, and load directly via loadFromWeightMap.
    const base = chrome.runtime.getURL('models');

    const manifest = await fetch(`${base}/tiny_face_detector_model-weights_manifest.json`)
      .then(r => r.json());

    const shardBuffers = await Promise.all(
      manifest[0].paths.map(p => fetch(`${base}/${p}`).then(r => r.arrayBuffer()))
    );

    // Concatenate shards into one ArrayBuffer (model has a single shard)
    const totalBytes = shardBuffers.reduce((s, b) => s + b.byteLength, 0);
    const combined   = new Uint8Array(totalBytes);
    let off = 0;
    for (const buf of shardBuffers) { combined.set(new Uint8Array(buf), off); off += buf.byteLength; }

    const weightMap = faceapi.tf.io.decodeWeights(combined.buffer, manifest[0].weights);
    await faceapi.nets.tinyFaceDetector.loadFromWeightMap(weightMap);

    state.faceReady = true;
    state.detectionMethod = 'MediaPipe Pose + TinyFaceDetector';
    addLog('✅', 'Face detector ready — hybrid mode active');
  } catch (err) {
    addLog('⚠️', `Face detector init failed: ${err.message} — using pose-only mode`);
    console.error('[PostureGuard] Face detector:', err);
  }
}

async function detectFaceBox(video) {
  if (!state.faceReady || video.readyState < 2) return null;
  try {
    return await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()) ?? null;
  } catch (_) {
    return null;
  }
}

// ═══ FACE POSTURE ANALYSIS ═══
// Uses tinyFaceDetector bounding box + MediaPipe shoulder landmarks.
// Key signal: (shoulderMidY - faceCenterY) / shoulderWidth
//   — camera-distance invariant because both face and shoulders scale together
//   — cannot be fooled by leaning back: face width shrinks AND shoulder width shrinks proportionally
// Head turns (looking at phone etc.) suppress the slouch check rather than triggering an alert.
function analyzeFace(det, landmarks) {
  if (!det || !state.calibration?.faceCal) return { issues: [], faceMetrics: {} };
  const cal = state.calibration.faceCal;

  const box = det.box; // { x, y, width, height } in pixel space
  const video = $('webcam');
  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 480;

  // Normalise face box to [0,1] space to match MediaPipe landmark coordinates
  const faceCenterYn = (box.y + box.height / 2) / vh;
  const faceCenterXn = (box.x + box.width  / 2) / vw;
  const faceWidthn   = box.width / vw;

  const ls = landmarks[11], rs = landmarks[12];
  const shoulderMidY  = (ls.y + rs.y) / 2;
  const shoulderWidth = Math.abs(rs.x - ls.x) || 0.01;

  // Head turn: face X deviates from calibrated centre (normalised by face width)
  const turnDev = Math.abs(faceCenterXn - cal.faceCenterX) / (faceWidthn || 0.01);
  const isTurned = turnDev > CONFIG.FACE_TURN_THRESHOLD;

  // Slouch: face centre drops toward shoulders relative to calibration
  // Skip when head is turned — the box shifts and would give a false reading
  const faceToShoulderRatio = (shoulderMidY - faceCenterYn) / shoulderWidth;
  const slouchDev = isTurned ? 0 : cal.faceToShoulderRatio - faceToShoulderRatio;

  const issues = [];
  if (slouchDev > CONFIG.FACE_SLOUCH_THRESHOLD) issues.push('Slouching — sit upright');

  return {
    issues,
    faceMetrics: {
      faceSlouchDev: +slouchDev.toFixed(3),
      faceTurnDev:   +turnDev.toFixed(3),
    },
    isTurned,
  };
}

// ═══ POSTURE ANALYSIS ═══
// landmarks[0]=nose  [7]=leftEar  [8]=rightEar
// landmarks[11]=leftShoulder  [12]=rightShoulder
// landmarks[23]=leftHip       [24]=rightHip
// All coords normalized 0-1; Y increases downward; Z negative = closer to camera
function analyzePosture(landmarks) {
  if (!state.calibration || !landmarks) return { status: 'unknown' };
  const cal = state.calibration;

  const nose = landmarks[0];
  const ls   = landmarks[11]; // left shoulder
  const rs   = landmarks[12]; // right shoulder
  const lh   = landmarks[23]; // left hip
  const rh   = landmarks[24]; // right hip

  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5) return { status: 'unknown' };

  const shoulderMidY  = (ls.y + rs.y) / 2;
  const shoulderMidZ  = (ls.z + rs.z) / 2;
  const shoulderWidth = Math.abs(rs.x - ls.x) || 0.01;

  // 1. Shoulder tilt — side lean
  const shoulderTilt    = (ls.y - rs.y) / shoulderWidth;
  const shoulderTiltDev = Math.abs(shoulderTilt - cal.shoulderTilt);

  // 2. Forward head — nose z relative to shoulders
  const headForwardZ   = (shoulderMidZ - nose.z) / shoulderWidth;
  const headForwardDev = headForwardZ - cal.headForwardZ;

  // 3. Shoulder drop — shoulders physically sink in the frame when slouching.
  //    Directly tracks shoulder Y against calibrated good-posture shoulder Y.
  //    When head-to-shoulder ratio stays constant (both sink together), this still fires.
  const shoulderDrop = (shoulderMidY - cal.shoulderMidY) / cal.shoulderWidth; // positive = dropped

  // 4. Torso compression (bonus check when hips are visible)
  const hipsVisible = (lh.visibility ?? 0) > 0.3 && (rh.visibility ?? 0) > 0.3;
  const hipMidY     = hipsVisible ? (lh.y + rh.y) / 2 : null;
  const torsoRatio  = hipMidY !== null ? (hipMidY - shoulderMidY) / shoulderWidth : null;
  const torsoSlouchDev = torsoRatio !== null ? cal.torsoRatio - torsoRatio : 0;

  // Use whichever slouch signal is strongest
  const slouchDev = Math.max(shoulderDrop, torsoSlouchDev);

  // 5. Shoulder rounding — catches natural back slouch (spine curves, head stays upright).
  //    Uses ear-to-shoulder Z offset: when shoulders round forward, they push toward the
  //    camera while ears stay back, increasing (earMidZ - shoulderMidZ).
  //    This is camera-distance invariant — moving back shifts both ear and shoulder Z equally
  //    so the difference stays constant. Only actual shoulder rounding changes it.
  //    Guard: skip if calibration predates this field.
  let shoulderRoundScore = 0;
  if (cal.earShoulderZDiff !== undefined) {
    const le = landmarks[7]; // left ear
    const re = landmarks[8]; // right ear
    const earMidZ = (le.z + re.z) / 2;
    const earShoulderZDiff = (earMidZ - shoulderMidZ) / shoulderWidth; // positive = ear behind shoulders
    shoulderRoundScore = earShoulderZDiff - cal.earShoulderZDiff;      // positive = shoulders rounded forward vs calibration
  }

  const issues = [];
  if (slouchDev          > CONFIG.SLOUCH_THRESHOLD)        issues.push('Slouching — sit upright');
  if (shoulderTiltDev    > CONFIG.SIDE_LEAN_THRESHOLD)     issues.push('Shoulders uneven — level up');
  if (headForwardDev     > CONFIG.FORWARD_HEAD_THRESHOLD)  issues.push('Head forward — pull back');
  if (shoulderRoundScore > CONFIG.SHOULDER_ROUND_THRESHOLD) issues.push('Back rounded — open your chest');

  return {
    status: issues.length > 0 ? 'bad' : 'good',
    issues,
    metrics: {
      headPos:       +slouchDev.toFixed(3),
      bodyLean:      +shoulderTiltDev.toFixed(3),
      distance:      +headForwardDev.toFixed(3),
      shoulderRound: +shoulderRoundScore.toFixed(3),
    },
    landmarks,
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
    icon.textContent = '👤'; label.textContent = 'No Pose'; label.style.color = 'var(--text-dim)';
    detail.textContent = 'Make sure face and shoulders are visible';
    badge.className = 'video-badge badge-calibrating'; badge.textContent = 'SEARCHING…';
  }

  if (analysis.metrics) {
    const m = analysis.metrics;
    $('scoreHead').textContent     = (m.headPos  > 0 ? '+' : '') + m.headPos;
    $('scoreHead').style.color     = m.headPos  > CONFIG.SLOUCH_THRESHOLD       ? 'var(--red)' : 'var(--green)';
    $('scoreLean').textContent     = (m.bodyLean > 0 ? '+' : '') + m.bodyLean;
    $('scoreLean').style.color     = m.bodyLean > CONFIG.SIDE_LEAN_THRESHOLD     ? 'var(--red)' : 'var(--green)';
    $('scoreDistance').textContent = (m.distance > 0 ? '+' : '') + m.distance;
    $('scoreDistance').style.color = m.distance > CONFIG.FORWARD_HEAD_THRESHOLD  ? 'var(--red)' : 'var(--green)';
  }

  updateDebug(analysis);
}

function updateDebug(analysis) {
  const dbg = $('debugContent');
  if (!dbg || $('debugPanel').classList.contains('hidden')) return;
  const m   = analysis.metrics || {};
  const cal = state.calibration;
  const statusColor = analysis.status === 'good' ? 'var(--green)' : analysis.status === 'bad' ? 'var(--red)' : 'var(--yellow)';

  const faceMode = state.faceReady ? (cal?.faceCal ? '✓ hybrid' : '⚠ pose-only (no face cal)') : '✗ pose-only';

  dbg.innerHTML = `
    <b>Method:</b> ${state.detectionMethod}<br>
    <b>Face:</b> ${faceMode}<br>
    <b>Status:</b> <span style="color:${statusColor}">${analysis.status.toUpperCase()}</span><br>
    ─────────────────────<br>
    <b>[Face] Slouch dev:</b> ${m.faceSlouchDev ?? '–'} <span style="color:var(--text-dim)">(thresh ${CONFIG.FACE_SLOUCH_THRESHOLD})</span><br>
    <b>[Face] Turn dev:</b> ${m.faceTurnDev ?? '–'} <span style="color:var(--text-dim)">(turn suppress >${CONFIG.FACE_TURN_THRESHOLD})</span><br>
    ─────────────────────<br>
    <b>[Body] Shoulder drop:</b> ${m.headPos ?? '–'} <span style="color:var(--text-dim)">(thresh ${CONFIG.SLOUCH_THRESHOLD})</span><br>
    <b>[Body] Shoulder tilt:</b> ${m.bodyLean ?? '–'} <span style="color:var(--text-dim)">(thresh ${CONFIG.SIDE_LEAN_THRESHOLD})</span><br>
    <b>[Body] Head forward:</b> ${m.distance ?? '–'} <span style="color:var(--text-dim)">(thresh ${CONFIG.FORWARD_HEAD_THRESHOLD})</span><br>
    <b>[Body] Shoulder round:</b> ${m.shoulderRound ?? '–'} <span style="color:var(--text-dim)">(thresh ${CONFIG.SHOULDER_ROUND_THRESHOLD})</span><br>
    ${cal ? `─────────────────────<br><b>Cal sw:</b> ${cal.shoulderWidth.toFixed(3)} | <b>headH:</b> ${cal.headHeight.toFixed(3)}${cal.faceCal ? ` | <b>f2s:</b> ${cal.faceCal.faceToShoulderRatio.toFixed(3)}` : ''}` : ''}
  `;
}

function updateTimerUI() {
  if (!state.sittingStartTime || state.paused) return;
  const elapsed = Date.now() - state.sittingStartTime;
  state.totalSittingMs = elapsed;
  const hrs  = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  $('timerDisplay').textContent = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

  const stretchMs   = CONFIG.STRETCH_INTERVAL_MIN * 60000;
  const cycle       = Math.floor(elapsed / stretchMs);
  const cycleElapsed = elapsed % stretchMs;

  // Fire stretch reminder the moment the timer cycles — immediate, pause-aware
  if (cycle > 0 && cycle !== state._lastStretchCycle) {
    state._lastStretchCycle = cycle;
    try { chrome.runtime.sendMessage({ type: 'STRETCH_NOW', sittingMin: Math.round(elapsed / 60000) }); } catch (_) {}
    addLog('🧘', `Stretch break! You've been sitting ${Math.round(elapsed / 60000)} min.`);
  }

  $('stretchFill').style.width = `${(cycleElapsed / stretchMs) * 100}%`;
  const remaining = stretchMs - cycleElapsed;
  $('timerSub').textContent = `Stretch break in ${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`;

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
// Skeleton connections: [from, to] using MediaPipe landmark indices
const POSE_CONNECTIONS = [
  [11,12],          // shoulder bar
  [11,13],[13,15],  // left arm
  [12,14],[14,16],  // right arm
  [11,23],[12,24],  // torso sides
  [23,24],          // hip bar
];
const KEY_POINTS = [0, 7, 8, 11, 12, 23, 24]; // nose, ears, shoulders, hips

function drawOverlay(landmarks) {
  const canvas = $('overlay');
  const video  = $('webcam');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const W = canvas.width, H = canvas.height;
  const isGood = state.currentPosture === 'good';
  const color  = isGood ? '#6ee7b7' : '#f87171';

  // Mirror x so overlay matches the CSS-mirrored video display
  const px = (lm) => (W - lm.x * W);
  const py = (lm) => (lm.y * H);

  // ── Fixed calibrated face reference box ──
  // Drawn at the calibrated position, not the live position.
  // Shows where the face/head should be when posture is correct.
  // Live face detection still runs for analysis; it's not drawn here.
  if (state.calibration?.faceCal) {
    const fc  = state.calibration.faceCal;
    const bw  = fc.faceWidth  * W;
    const bh  = fc.faceHeight * H;
    const bcx = (1 - fc.faceCenterX) * W;  // mirrored X
    const bcy = fc.faceCenterY * H;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(bcx - bw / 2, bcy - bh / 2, bw, bh);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px monospace';
    ctx.fillText('calibrated', bcx - bw / 2 + 3, bcy - bh / 2 + 13);
  }

  if (!landmarks) return;

  // ── MediaPipe skeleton ──
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([]);
  for (const [a, b] of POSE_CONNECTIONS) {
    const la = landmarks[a], lb = landmarks[b];
    if ((la.visibility ?? 1) < 0.4 || (lb.visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(px(la), py(la));
    ctx.lineTo(px(lb), py(lb));
    ctx.stroke();
  }

  ctx.fillStyle = color;
  for (const idx of KEY_POINTS) {
    const lm = landmarks[idx];
    if ((lm.visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(px(lm), py(lm), idx === 0 ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Calibration shoulder reference line
  if (state.calibration) {
    const ls = landmarks[11], rs = landmarks[12];
    const refY = ((ls.y + rs.y) / 2) * H;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, refY); ctx.lineTo(W, refY); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ═══ DETECTION LOOP ═══
async function detectionLoop() {
  if (state.phase !== 'monitoring' || state.paused) return;
  const video = $('webcam');
  if (video.readyState < 2) return;

  // Run both detectors in parallel each cycle
  const [body, faceDetection] = await Promise.all([
    detectPose(video),
    detectFaceBox(video),
  ]);

  drawOverlay(body);

  if (!body) {
    updatePostureUI({ status: 'unknown', metrics: null });
    $('postureDetail').textContent = 'No body detected — are you away?';
    state.currentPosture = 'unknown'; state.badPostureSince = null;
    return;
  }

  // Too far from camera check
  const shoulderWidth = Math.abs(body[12].x - body[11].x);
  if (shoulderWidth < CONFIG.MIN_SHOULDER_WIDTH) {
    updatePostureUI({ status: 'unknown', metrics: null });
    $('postureDetail').textContent = 'Too far from camera — move closer';
    state.currentPosture = 'unknown'; state.badPostureSince = null;
    return;
  }

  if (!state.calibration) {
    updatePostureUI({ status: 'unknown', metrics: null });
    $('postureDetail').textContent = 'Click "Calibrate" to set your posture baseline';
    $('calibInfo').textContent = '🪑 Sit upright, then click Calibrate';
    return;
  }

  // Analyse body (MediaPipe) + face (tinyFaceDetector) and fuse
  const bodyAnalysis = analyzePosture(body);
  const faceAnalysis = analyzeFace(faceDetection, body);

  // Face-based slouch replaces MediaPipe's shoulder-drop slouch (more robust)
  // All other body signals (shoulder tilt, head forward, shoulder rounding) are kept
  const bodyIssuesFiltered = bodyAnalysis.issues.filter(i => !i.startsWith('Slouching'));
  const allIssues = [...bodyIssuesFiltered, ...faceAnalysis.issues];

  const analysis = {
    status: allIssues.length > 0 ? 'bad' : (bodyAnalysis.status === 'unknown' ? 'unknown' : 'good'),
    issues: allIssues,
    metrics: { ...bodyAnalysis.metrics, ...faceAnalysis.faceMetrics },
  };

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

  // Collect pose + face samples in parallel
  const poseSamples = [], faceSamples = [];
  for (let i = 0; i < 6; i++) {
    const [pose, faceDetection] = await Promise.all([detectPose(video), detectFaceBox(video)]);
    if (pose) poseSamples.push(pose);
    if (faceDetection) faceSamples.push(faceDetection);
    await new Promise(r => setTimeout(r, 350));
  }
  $('btnCalibrate').disabled = false;

  if (poseSamples.length < 3) {
    addLog('❌', 'Calibration failed — ensure your upper body is fully visible');
    $('calibInfo').textContent = 'Failed — make sure shoulders are visible and well-lit.';
    return;
  }

  // Average each landmark across all pose samples
  const avgLM = (idx) => ({
    x: poseSamples.reduce((s, l) => s + l[idx].x, 0) / poseSamples.length,
    y: poseSamples.reduce((s, l) => s + l[idx].y, 0) / poseSamples.length,
    z: poseSamples.reduce((s, l) => s + l[idx].z, 0) / poseSamples.length,
  });

  const nose = avgLM(0);
  const ls   = avgLM(11); // left shoulder
  const rs   = avgLM(12); // right shoulder
  const lh   = avgLM(23); // left hip
  const rh   = avgLM(24); // right hip
  const le   = avgLM(7);  // left ear
  const re   = avgLM(8);  // right ear

  const shoulderMidY     = (ls.y + rs.y) / 2;
  const shoulderMidZ     = (ls.z + rs.z) / 2;
  const shoulderWidth    = Math.abs(rs.x - ls.x) || 0.01;
  const hipMidY          = (lh.y + rh.y) / 2;
  const torsoRatio       = (hipMidY - shoulderMidY) / shoulderWidth;
  const earMidZ          = (le.z + re.z) / 2;
  const earShoulderZDiff = (earMidZ - shoulderMidZ) / shoulderWidth;

  // Average face bounding box across face samples (null if face not detected)
  let faceCal = null;
  if (faceSamples.length >= 3) {
    const vw = video.videoWidth  || 640;
    const vh = video.videoHeight || 480;
    const avgCX = faceSamples.reduce((s, d) => s + (d.box.x + d.box.width  / 2) / vw, 0) / faceSamples.length;
    const avgCY = faceSamples.reduce((s, d) => s + (d.box.y + d.box.height / 2) / vh, 0) / faceSamples.length;
    const avgFW = faceSamples.reduce((s, d) => s + d.box.width  / vw, 0) / faceSamples.length;
    const avgFH = faceSamples.reduce((s, d) => s + d.box.height / vh, 0) / faceSamples.length;
    faceCal = {
      faceCenterX:         avgCX,
      faceCenterY:         avgCY,  // needed to draw the fixed reference box
      faceWidth:           avgFW,
      faceHeight:          avgFH,
      faceToShoulderRatio: (shoulderMidY - avgCY) / shoulderWidth,
    };
    addLog('👤', `Face calibrated — faceToShoulder: ${faceCal.faceToShoulderRatio.toFixed(3)}`);
  } else {
    addLog('⚠️', 'Face not detected during calibration — using pose-only slouch detection');
  }

  const calData = {
    headHeight:      (shoulderMidY - nose.y) / shoulderWidth,
    shoulderTilt:    (ls.y - rs.y) / shoulderWidth,
    headForwardZ:    (shoulderMidZ - nose.z) / shoulderWidth,
    torsoRatio,
    shoulderWidth,
    shoulderMidY,
    earShoulderZDiff,
    faceCal,  // null if face was not visible during calibration
  };

  state.calibrations.sitting = calData;
  state.calibration = calData;

  chrome.storage.local.set({ calibrations: state.calibrations });

  state.phase = 'monitoring';
  state.badPostureSince = null;
  state.lastAlertTime = 0;

  $('calibInfo').innerHTML = `<strong>🪑 Calibrated!</strong> SW: ${shoulderWidth.toFixed(3)} · Torso: ${torsoRatio.toFixed(3)}${faceCal ? ' · Face ✓' : ''}`;
  addLog('✅', 'Posture calibrated!');

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
    await Promise.all([initDetector(), initFaceDetector()]);

    state.detectionTimer = setInterval(detectionLoop, CONFIG.DETECTION_INTERVAL_MS);
    setInterval(updateTimerUI, 1000);

    const data = await chrome.storage.local.get(['waterCount', 'waterGoal', 'calibrations']);
    state.waterCount = data.waterCount || 0;
    state.waterGoal  = data.waterGoal  || 8;

    // Restore saved sitting calibration
    if (data.calibrations?.sitting) {
      state.calibrations.sitting = data.calibrations.sitting;
      state.calibration = data.calibrations.sitting;
      addLog('💾', 'Restored sitting calibration');
    }

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
