// Complete NABOKO MVP app.js with front/rear camera toggle
// Assumes html5-qrcode is included and you have these HTML elements:
// <button id="start-button">Start NABOKO</button>
// <button id="toggle-camera" style="display:none;">Switch to Rear Camera</button>
// <div id="qr-reader" style="width:320px; display:none;"></div>
// <div id="hits"></div>

const AUDIO_CTX = new (window.AudioContext || window.webkitAudioContext)();
const DEBOUNCE_MS = 700;
const MAX_SIMULTANEOUS_VOICES = 6;

let figuresMap = {};        // { "qr-001": { label, role, sound } }
let audioBuffers = {};      // { "sounds/C.mp3": AudioBuffer }
let lastPlayed = {};        // { "qr-001": timestamp }

// --------- 1. Load JSON mapping
async function loadMapping() {
  const res = await fetch('data/figures.json');
  if (!res.ok) throw new Error('Failed to load data/figures.json: ' + res.status);
  const json = await res.json();
  (json.figures || []).forEach(f => { figuresMap[f.id] = f; });
  console.log('Loaded mapping', figuresMap);
}

// --------- 2. Preload audio (or lazy-load on first use)
async function loadAudio(url) {
  if (audioBuffers[url]) return audioBuffers[url];
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch audio: ' + url);
  const ab = await resp.arrayBuffer();
  const audioBuf = await AUDIO_CTX.decodeAudioData(ab);
  audioBuffers[url] = audioBuf;
  return audioBuf;
}

// --------- 3. Play an AudioBuffer (simple one-shot)
function playBuffer(audioBuf, pan = 0, when = 0) {
  try {
    const src = AUDIO_CTX.createBufferSource();
    src.buffer = audioBuf;

    const panner = AUDIO_CTX.createStereoPanner();
    panner.pan.value = pan;

    src.connect(panner);
    panner.connect(AUDIO_CTX.destination);

    src.start(AUDIO_CTX.currentTime + when);
  } catch (e) {
    console.error('playBuffer error', e);
  }
}

// --------- 4. Handle decoded QR results (array of decoded text values)
async function handleDecodedArray(decodedArray) {
  const now = Date.now();
  const uniqueIds = [...new Set(decodedArray.map(d => d.trim()))];
  const playable = [];

  for (const id of uniqueIds) {
    const meta = figuresMap[id];
    if (!meta) continue;
    const last = lastPlayed[id] || 0;
    if (now - last < DEBOUNCE_MS) continue;
    lastPlayed[id] = now;
    playable.push(meta);
  }

  if (playable.length === 0) return;

  const toPlay = playable.slice(0, MAX_SIMULTANEOUS_VOICES);

  await Promise.all(toPlay.map(async m => {
    if (!audioBuffers[m.sound]) await loadAudio(m.sound);
  }));

  toPlay.forEach((m, idx) => {
    const buf = audioBuffers[m.sound];
    if (!buf) return;
    const pan = (idx / Math.max(1, toPlay.length - 1)) * 2 - 1; // -1..1
    playBuffer(buf, pan);
    showUIHit(m);
  });
}

// --------- 5. Simple UI feedback function
function showUIHit(meta) {
  const out = document.getElementById('hits');
  if (!out) return;
  const el = document.createElement('div');
  el.className = 'hit';
  el.textContent = `${meta.label} (${meta.role})`;
  out.prepend(el);
  setTimeout(() => el.remove(), 1500);
}

// --------- 6. Scanner + camera selection utilities
let html5QrCodeInstance = null;
let usingFacing = 'user'; // 'user' (front) or 'environment' (rear)
const startBtn = document.getElementById('start-button');
const toggleBtn = document.getElementById('toggle-camera');
const readerDivId = 'qr-reader';
const QR_CONFIG = { fps: 10, qrbox: 300 };

// Try to pick a deviceId matching facing preference; falls back to heuristic
async function pickCameraIdForFacing(facing) {
  try {
    // Ensure enumerateDevices can return labels after permission; labels may be empty until permission granted.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    if (videoInputs.length === 0) return null;

    // Try to match by label if available
    if (facing === 'environment') {
      const match = videoInputs.find(d => /back|rear|environment|wide|ultrawide/i.test(d.label));
      if (match) return match.deviceId;
    } else {
      const front = videoInputs.find(d => /front|user|selfie/i.test(d.label));
      if (front) return front.deviceId;
    }

    // Fallback heuristics: many devices list rear camera last
    return facing === 'environment' ? videoInputs[videoInputs.length - 1].deviceId : videoInputs[0].deviceId;
  } catch (e) {
    console.warn('Could not enumerate devices', e);
    return null;
  }
}

// Start scanner with either deviceId or facingMode hint
async function startScanner(facingPref = 'user') {
  // Stop any running instance
  if (html5QrCodeInstance) {
    try { await html5QrCodeInstance.stop(); } catch (e) { /* ignore */ }
    try { html5QrCodeInstance.clear(); } catch (e) { /* ignore */ }
    html5QrCodeInstance = null;
  }

  html5QrCodeInstance = new Html5Qrcode(readerDivId, false);

  // determine constraints
  let constraints;
  const id = await pickCameraIdForFacing(facingPref);
  if (id) constraints = { deviceId: { exact: id } };
  else constraints = { facingMode: facingPref };

  // show UI
  document.getElementById('qr-reader').style.display = 'block';
  toggleBtn.style.display = 'inline-block';

  // frame batching logic
  let frameBuffer = [];
  let frameTimer = null;
  const FRAME_WINDOW_MS = 120;

  function onSuccess(decodedText, decodedResult) {
    frameBuffer.push(decodedText);
    if (frameTimer) return;
    frameTimer = setTimeout(() => {
      const batch = frameBuffer.slice();
      frameBuffer = [];
      frameTimer = null;
      handleDecodedArray(batch).catch(err => console.error(err));
    }, FRAME_WINDOW_MS);
  }

  function onError(err) {
    // ignore noisy errors
  }

  try {
    await html5QrCodeInstance.start(constraints, QR_CONFIG, onSuccess, onError);
    usingFacing = facingPref;
    toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
  } catch (err) {
    console.error('Failed to start scanner with constraints', constraints, err);
    // Fallback: try facingMode hint if deviceId constraining failed
    if (constraints && constraints.deviceId) {
      try {
        await html5QrCodeInstance.start({ facingMode: facingPref }, QR_CONFIG, onSuccess, onError);
        usingFacing = facingPref;
        toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
      } catch (e) {
        console.error('Fallback start also failed', e);
      }
    }
  }
}

// Toggle camera button handler
toggleBtn.addEventListener('click', async () => {
  const newFacing = usingFacing === 'user' ? 'environment' : 'user';
  toggleBtn.disabled = true;
  try {
    await startScanner(newFacing);
  } finally {
    toggleBtn.disabled = false;
  }
});

// --------- 7. Boot / initialization
async function boot() {
  try {
    await loadMapping();
  } catch (e) {
    console.error('Failed to load mapping', e);
    return;
  }

  // Ensure a clear user gesture is available to resume audio
  document.body.addEventListener('click', function unlock() {
    if (AUDIO_CTX.state === 'suspended') AUDIO_CTX.resume().catch(e => console.warn('Resume failed', e));
    document.body.removeEventListener('click', unlock);
  });

  // Start button: resume audio then start front camera scanner
  startBtn.addEventListener('click', async function onStart() {
    try {
      if (AUDIO_CTX.state === 'suspended') await AUDIO_CTX.resume();
    } catch (e) {
      console.warn('Audio resume failed', e);
    }
    startBtn.style.display = 'none';
    // start with front camera by default
    await startScanner('user').catch(err => console.error('Scanner start failed', err));
  });

  // Optionally auto-start on desktop environments (commented out for mobile safety)
  // await startScanner('user').catch(err => console.error('Auto-start failed', err));
}

boot().catch(err => console.error('Boot failed', err));
