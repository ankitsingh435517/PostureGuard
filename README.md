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
| **Slouch Detection** | TinyFaceDetector captures your face position at calibration. During monitoring it tracks whether your face-to-shoulder ratio changes — robust to moving closer or farther from the camera. |
| **Shoulder & Body Signals** | MediaPipe Pose tracks 33 body landmarks in real-time: shoulder drop, shoulder tilt, shoulder rounding, and head-forward posture. |
| **Sitting Duration** | Tracks how long you've been at your desk. Reminds you to stretch at a configurable interval. |
| **Water Intake** | Manual logging with periodic reminders. Set your daily glass goal in settings. |

### Detection Engine — Hybrid Mode

PostureGuard uses **two ML models simultaneously**:

- **TinyFaceDetector** (face-api.js) — fast, lightweight (~190 KB model). Captures a fixed calibrated face reference box on calibration. During monitoring the slouch signal is computed from the live face-to-shoulder ratio, which is camera-distance invariant — moving your chair back while slouching cannot fool it.

- **MediaPipe Pose** — 33-landmark full body skeleton. Handles shoulder tilt, shoulder rounding (ear-to-shoulder depth), head-forward (chin jut), and torso compression. The live skeleton overlay is drawn on the webcam feed every frame.

The two detectors run in parallel each cycle. The visual overlay shows:
- A **fixed dashed white box** labelled *"calibrated"* — where your face was during calibration (reference anchor, never moves)
- A **live colour skeleton** — where your body is now (green = good, red = bad)

When you slouch, the skeleton drifts away from the fixed reference box — the deviation is both visible and what triggers the alert.

### Head Turn Flexibility

Looking away briefly (checking your phone, glancing aside) is **not flagged** as bad posture. The face-based slouch check is automatically suppressed while your head is turned, so you won't get false alerts for normal neck movement.

### Alerts
- **Posture Alert**: In-page overlay + audio beep + Chrome notification when bad posture is held for 1.5+ seconds (10 s cooldown)
- **Stretch Reminder**: Notification every 30 min (configurable)
- **Water Reminder**: Notification every 60 min (configurable)

### Settings (in popup)
- Water reminder interval: 30 / 45 / 60 / 90 min
- Stretch reminder interval: 20 / 30 / 45 / 60 min
- Daily water goal: customizable

### Debug Panel
Click **🔧 Debug** in the monitor dashboard to see live detection metrics:

| Metric | What it measures |
|--------|-----------------|
| `[Face] Slouch dev` | Face-to-shoulder Y ratio deviation (threshold 0.10) |
| `[Face] Turn dev` | Face X deviation — suppresses slouch check when turned |
| `[Body] Shoulder drop` | Shoulder Y change from calibration |
| `[Body] Shoulder tilt` | Left-right shoulder asymmetry |
| `[Body] Head forward` | Nose Z relative to shoulders (chin jut) |
| `[Body] Shoulder round` | Ear-to-shoulder Z offset (back rounding) |

## Tips for Best Results
- **Lighting**: Ensure your face is well-lit (avoid strong backlighting). Both models work in dim conditions since the face is typically illuminated by the screen, but brighter is better for calibration.
- **Camera angle**: Position your webcam at roughly eye level
- **Calibrate properly**: Sit in your ideal upright posture before clicking Calibrate — both models capture a baseline at this moment
- **Recalibrate**: After changing chair height, desk position, or camera angle

## Privacy
🔒 **100% local processing** — no data ever leaves your device. All ML inference runs entirely in your browser using bundled models. No servers, no cloud, no tracking.

## Tech Stack
- Vanilla JS + HTML/CSS — no frameworks
- [face-api.js](https://github.com/justadudewhohacks/face-api.js) (TinyFaceDetector) — face bounding box, slouch detection
- [MediaPipe Pose](https://google.github.io/mediapipe/solutions/pose) — 33-landmark body skeleton, shoulder/head signals
- Chrome Extension Manifest V3
- Chrome APIs: `storage`, `alarms`, `notifications`
