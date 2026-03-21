# 🦴 PostureGuard — Chrome Extension

> AI-powered posture monitor, sitting tracker, and hydration reminder — 100% local, no servers, no data collection.

## Installation

1. **Download** the zip and extract it to a folder
2. Open Chrome → go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **"Load unpacked"** → select the extracted folder
5. Pin the extension from the puzzle icon in the toolbar

## How to Use

### Starting a Session
1. Click the PostureGuard icon in your toolbar
2. Click **"Open Monitor Dashboard"** — opens the full monitoring page
3. Grant webcam access when prompted
4. **Sit in your best upright posture** and click **📐 Calibrate**
5. Done — PostureGuard is now watching your posture in real-time

### What It Tracks
| Feature | How It Works |
|---------|-------------|
| **Posture Detection** | ML-based face detection (TinyFaceDetector) tracks your face position relative to your calibrated baseline. Detects slouching, forward lean, backward lean, and side lean. |
| **Sitting Duration** | Tracks how long you've been at your desk. Reminds you to stretch at a configurable interval. |
| **Water Intake** | Manual logging with periodic reminders. Set your daily glass goal in settings. |

### Alerts
- **Posture Alert**: In-page overlay + audio beep + Chrome notification when bad posture is held for 1.5+ seconds (10s cooldown)
- **Stretch Reminder**: Notification every 30 min (configurable)
- **Water Reminder**: Notification every 60 min (configurable)

### Settings (in popup)
- Water reminder interval: 30 / 45 / 60 / 90 min
- Stretch reminder interval: 20 / 30 / 45 / 60 min
- Daily water goal: customizable

### Debug Panel
Click **🔧 Debug** in the monitor dashboard to see live detection metrics — useful for tuning calibration or verifying detection is working.

## Tips for Best Results
- **Lighting**: Ensure your face is well-lit (avoid strong backlighting)
- **Camera angle**: Position your webcam at eye level
- **Calibrate properly**: Sit in your ideal posture before clicking Calibrate
- **Recalibrate**: After changing chair height or camera position

## Privacy
🔒 **100% local processing** — no data ever leaves your device. Face detection runs entirely in your browser using a bundled ML model. No servers, no cloud, no tracking.

## Tech Stack
- Vanilla JS + HTML/CSS — no frameworks
- [face-api.js](https://github.com/justadudewhohacks/face-api.js) (TinyFaceDetector) for ML-based face detection
- Chrome Extension Manifest V3
- Chrome APIs: `storage`, `alarms`, `notifications`
