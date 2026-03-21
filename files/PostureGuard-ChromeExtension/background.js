// ── PostureGuard Background Service Worker ──

const DEFAULTS = {
  waterIntervalMin: 60,
  stretchIntervalMin: 30,
  monitoringActive: false,
  waterCount: 0,
  waterGoal: 8,
  sessionStart: null,
  totalSittingMs: 0,
  lastPostureState: 'unknown',
  postureAlertCooldownSec: 30,
};

// ── Alarm Setup ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(DEFAULTS);
  console.log('PostureGuard installed.');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const data = await chrome.storage.local.get(null);
  if (!data.monitoringActive) return;

  if (alarm.name === 'water-reminder') {
    chrome.notifications.create('water-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '💧 Hydration Check',
      message: `Time to drink water! You've had ${data.waterCount || 0} of ${data.waterGoal || 8} glasses today.`,
      priority: 2,
    });
  }

  if (alarm.name === 'stretch-reminder') {
    const sittingMin = Math.round((data.totalSittingMs || 0) / 60000);
    chrome.notifications.create('stretch-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🧘 Stretch Break!',
      message: `You've been sitting for ~${sittingMin} min. Stand up, stretch your neck, roll your shoulders!`,
      priority: 2,
    });
  }
});

// ── Message Handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_MONITORING') {
    chrome.storage.local.set({
      monitoringActive: true,
      sessionStart: Date.now(),
      totalSittingMs: 0,
    });
    chrome.alarms.create('water-reminder', {
      delayInMinutes: msg.waterInterval || 60,
      periodInMinutes: msg.waterInterval || 60,
    });
    chrome.alarms.create('stretch-reminder', {
      delayInMinutes: msg.stretchInterval || 30,
      periodInMinutes: msg.stretchInterval || 30,
    });
    sendResponse({ ok: true });
  }

  if (msg.type === 'STOP_MONITORING') {
    chrome.storage.local.set({ monitoringActive: false });
    chrome.alarms.clearAll();
    sendResponse({ ok: true });
  }

  if (msg.type === 'LOG_WATER') {
    chrome.storage.local.get(['waterCount', 'waterGoal'], (data) => {
      const newCount = (data.waterCount || 0) + 1;
      chrome.storage.local.set({ waterCount: newCount });
      if (newCount >= (data.waterGoal || 8)) {
        chrome.notifications.create('water-goal-' + Date.now(), {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '🎉 Hydration Goal Reached!',
          message: `You've hit your daily water goal of ${data.waterGoal || 8} glasses!`,
          priority: 1,
        });
      }
      sendResponse({ waterCount: newCount });
    });
    return true; // async
  }

  if (msg.type === 'BAD_POSTURE_ALERT') {
    chrome.notifications.create('posture-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '⚠️ Posture Alert!',
      message: msg.detail || 'Straighten up! Your posture needs correction.',
      priority: 2,
    });
    sendResponse({ ok: true });
  }

  if (msg.type === 'UPDATE_SITTING') {
    chrome.storage.local.set({ totalSittingMs: msg.totalSittingMs });
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  if (msg.type === 'RESET_WATER') {
    chrome.storage.local.set({ waterCount: 0 });
    sendResponse({ ok: true });
  }
});
