// ── PostureGuard Popup ──

const $ = (id) => document.getElementById(id);

// ── State Refresh ──
async function refreshUI() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!state) return;

  // Status strip
  const strip = $('statusStrip');
  const statusText = $('statusText');
  if (state.monitoringActive) {
    strip.className = 'status-strip active';
    statusText.textContent = 'Monitoring active';
    $('btnStop').classList.remove('hidden');
    $('btnMonitor').textContent = '🎥 Open Monitor Dashboard';
  } else {
    strip.className = 'status-strip inactive';
    statusText.textContent = 'Monitoring inactive';
    $('btnStop').classList.add('hidden');
  }

  // Posture
  const pv = $('postureValue');
  const ps = $('postureSub');
  if (!state.monitoringActive) {
    pv.textContent = '--';
    pv.className = 'card-value posture-unknown';
    ps.textContent = 'Start monitoring to track';
  } else if (state.lastPostureState === 'good') {
    pv.textContent = 'Good ✓';
    pv.className = 'card-value posture-good';
    ps.textContent = 'Keep it up!';
  } else if (state.lastPostureState === 'bad') {
    pv.textContent = 'Fix it!';
    pv.className = 'card-value posture-bad';
    ps.textContent = 'Straighten up and pull shoulders back';
  } else {
    pv.textContent = 'Detecting…';
    pv.className = 'card-value posture-unknown';
    ps.textContent = 'Calibrating your position';
  }

  // Sitting
  const totalMs = state.totalSittingMs || 0;
  const mins = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  $('sittingValue').textContent =
    String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');

  const stretchInt = state.stretchIntervalMin || 30;
  const nextStretch = stretchInt - (mins % stretchInt);
  $('sittingSub').textContent = state.monitoringActive
    ? `Next stretch break: ~${nextStretch} min`
    : 'Next stretch break: --';

  // Water
  const wc = state.waterCount || 0;
  const wg = state.waterGoal || 8;
  $('waterCount').textContent = wc;
  $('waterGoal').textContent = wg;
  $('waterBar').style.width = Math.min((wc / wg) * 100, 100) + '%';
  $('goalInput').value = wg;
}

// ── Open Monitor ──
$('btnMonitor').addEventListener('click', () => {
  const waterInt = parseInt($('waterInterval').value);
  const stretchInt = parseInt($('stretchInterval').value);
  const waterGoal = parseInt($('goalInput').value) || 8;

  chrome.storage.local.set({
    waterIntervalMin: waterInt,
    stretchIntervalMin: stretchInt,
    waterGoal,
  });

  chrome.tabs.create({ url: chrome.runtime.getURL('monitor.html') });
});

// ── Log Water ──
$('btnWater').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'LOG_WATER' });
  if (resp) {
    $('waterCount').textContent = resp.waterCount;
    const goal = parseInt($('goalInput').value) || 8;
    $('waterBar').style.width = Math.min((resp.waterCount / goal) * 100, 100) + '%';
  }
});

// ── Stop Monitoring ──
$('btnStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_MONITORING' });
  refreshUI();
});

// ── Save settings on change ──
$('goalInput').addEventListener('change', () => {
  chrome.storage.local.set({ waterGoal: parseInt($('goalInput').value) || 8 });
  refreshUI();
});

// ── Init ──
refreshUI();
setInterval(refreshUI, 2000);
