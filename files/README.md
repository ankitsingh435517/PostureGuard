# 🦴 PostureGuard — Chrome Extension

## Installation

1. **Download** the zip file and extract it to a folder
2. Open Chrome → go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **"Load unpacked"** → select the extracted folder
5. Pin the extension from the puzzle icon in the toolbar

## How to Use

### Starting a Session
1. Click the PostureGuard icon in your toolbar
2. Click **"Open Monitor Dashboard"** — this opens the full monitoring page
3. Grant webcam access when prompted
4. **Sit in your best upright posture** and click **📐 Calibrate**
5. That's it! PostureGuard now watches your posture

### What It Tracks
| Feature | How It Works |
|---------|-------------|
| **Posture Detection** | Tracks your face position relative to your calibrated "good" posture. Detects slouching, forward lean, and side lean. |
| **Sitting Duration** | Counts how long you've been at your desk. Reminds you to stretch (default: every 30 min). |
| **Water Intake** | Manual logging with hourly reminders. Set your daily glass goal in settings. |

### Alerts
- **Posture Alert**: Chrome notification when you maintain bad posture for 3+ seconds (with 20s cooldown)
- **Stretch Reminder**: Notification every 30 min (configurable)
- **Water Reminder**: Notification every 60 min (configurable)

### Settings (in popup)
- Water reminder interval: 30 / 45 / 60 / 90 min
- Stretch reminder interval: 20 / 30 / 45 / 60 min
- Daily water goal: customizable

## Tips for Best Results
- **Lighting**: Ensure your face is well-lit (avoid strong backlighting)
- **Camera angle**: Position your camera at eye level for best tracking
- **Calibrate properly**: Sit with your ideal posture when calibrating
- **Recalibrate**: If you change chair height or camera position, recalibrate

## Privacy
🔒 **100% local processing** — no data leaves your device. All face detection runs entirely in your browser. No servers, no cloud, no tracking.

## Technical Notes
- Uses Chrome's FaceDetector API (Shape Detection API) when available
- Falls back to canvas-based skin-color detection otherwise
- For best results, enable `chrome://flags/#enable-experimental-web-platform-features`
