// NABOKO MVP — app.js (works on desktop and mobile)
// Requirements: html5-qrcode included and index.html may contain:
// optional: <button id="start-button">Start NABOKO</button>
// optional: <button id="toggle-camera" style="display:none;">Switch to Rear Camera</button>
// required: <div id="qr-reader" style="width:320px; display:none;"></div>
// required: <div id="hits"></div>

(function () {
  const AUDIO_CTX = new (window.AudioContext || window.webkitAudioContext)();
  const DEBOUNCE_MS = 700;
  const MAX_SIMULTANEOUS_VOICES = 6;

  let figuresMap = {};
  let audioBuffers = {};
  let lastPlayed = {};

  // DOM elements will be resolved after DOMContentLoaded
  let startBtn = null;
  let toggleBtn = null;
  const readerDivId = 'qr-reader';
  const QR_CONFIG = { fps: 10, qrbox: 300 };

  // 1. Load mapping
  async function loadMapping() {
    const res = await fetch('data/figures.json');
    if (!res.ok) throw new Error('Failed to load data/figures.json: ' + res.status);
    const json = await res.json();
    (json.figures || []).forEach(f => { figuresMap[f.id] = Object.assign({}, f, { id: f.id }); });
    console.log('Loaded mapping keys:', Object.keys(figuresMap));
  }

  // 2. loadAudio robust
  async function loadAudio(url) {
    if (audioBuffers[url]) return audioBuffers[url];
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Failed to fetch audio: ' + url + ' status=' + resp.status);
    const ab = await resp.arrayBuffer();
    try {
      const decoded = await AUDIO_CTX.decodeAudioData(ab);
      audioBuffers[url] = decoded;
      return decoded;
    } catch (err) {
      return new Promise((resolve, reject) => {
        try {
          AUDIO_CTX.decodeAudioData(ab, decoded => {
            audioBuffers[url] = decoded;
            resolve(decoded);
          }, e => {
            console.error('decodeAudioData callback error for', url, e);
            reject(e);
          });
        } catch (e) {
          console.error('decode fallback failed for', url, e);
          reject(e);
        }
      });
    }
  }

  // 3. playBuffer with panner fallback
  function playBuffer(audioBuf, pan = 0, when = 0) {
    try {
      const src = AUDIO_CTX.createBufferSource();
      src.buffer = audioBuf;
      let node;
      if (typeof AUDIO_CTX.createStereoPanner === 'function') {
        const p = AUDIO_CTX.createStereoPanner();
        try { p.pan.value = pan; } catch (e) { /* ignore */ }
        node = p;
      } else {
        node = AUDIO_CTX.createGain();
      }
      src.connect(node);
      node.connect(AUDIO_CTX.destination);
      src.start(AUDIO_CTX.currentTime + when);
    } catch (e) {
      console.error('playBuffer error', e);
    }
  }

  // 4. handle decoded array
  async function handleDecodedArray(decodedArray) {
    const now = Date.now();
    const uniqueIds = [...new Set(decodedArray.map(d => (d || '').trim()))];
    const playable = [];

    for (const id of uniqueIds) {
      const meta = figuresMap[id];
      if (!meta) {
        console.warn('No mapping for decoded id:', id);
        continue;
      }
      const last = lastPlayed[id] || 0;
      if (now - last < DEBOUNCE_MS) continue;
      lastPlayed[id] = now;
      playable.push(meta);
    }

    if (playable.length === 0) return;

    const toPlay = playable.slice(0, MAX_SIMULTANEOUS_VOICES);
    console.log('Playable items', toPlay.map(p => ({ id: p.id, sound: p.sound })));

    await Promise.all(toPlay.map(async m => {
      if (!audioBuffers[m.sound]) {
        try { await loadAudio(m.sound); console.log('Loaded audio for', m.sound); }
        catch (e) { console.error('Failed to load', m.sound, e); }
      }
    }));

    toPlay.forEach((m, idx) => {
      const buf = audioBuffers[m.sound];
      if (!buf) { console.error('No buffer for', m.sound); return; }
      const pan = (idx / Math.max(1, toPlay.length - 1)) * 2 - 1;
      playBuffer(buf, pan);
      showUIHit(m);
    });
  }

  // 5. UI feedback
  function showUIHit(meta) {
    const out = document.getElementById('hits');
    if (!out) return;
    const el = document.createElement('div');
    el.className = 'hit';
    el.textContent = `${meta.label} (${meta.role})`;
    out.prepend(el);
    setTimeout(() => el.remove(), 1500);
  }

  // 6. Scanner helpers
  let html5QrCodeInstance = null;
  let usingFacing = 'user';

  async function pickCameraIdForFacing(facing) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      if (videoInputs.length === 0) return null;
      if (facing === 'environment') {
        const match = videoInputs.find(d => /back|rear|environment|wide|ultrawide/i.test(d.label));
        if (match) return match.deviceId;
      } else {
        const front = videoInputs.find(d => /front|user|selfie/i.test(d.label));
        if (front) return front.deviceId;
      }
      return facing === 'environment' ? videoInputs[videoInputs.length - 1].deviceId : videoInputs[0].deviceId;
    } catch (e) {
      console.warn('Could not enumerate devices', e);
      return null;
    }
  }

  async function startScanner(facingPref = 'user') {
    if (html5QrCodeInstance) {
      try { await html5QrCodeInstance.stop(); } catch (e) {}
      try { html5QrCodeInstance.clear(); } catch (e) {}
      html5QrCodeInstance = null;
    }

    html5QrCodeInstance = new Html5Qrcode(readerDivId, false);

    let constraints;
    const id = await pickCameraIdForFacing(facingPref);
    if (id) constraints = { deviceId: { exact: id } };
    else constraints = { facingMode: facingPref };

    const rd = document.getElementById(readerDivId);
    if (rd) rd.style.display = 'block';
    if (toggleBtn) toggleBtn.style.display = 'inline-block';

    let frameBuffer = [];
    let frameTimer = null;
    const FRAME_WINDOW_MS = 120;

    function onSuccess(decodedText) {
      frameBuffer.push(decodedText);
      if (frameTimer) return;
      frameTimer = setTimeout(() => {
        const batch = frameBuffer.slice();
        frameBuffer = [];
        frameTimer = null;
        handleDecodedArray(batch).catch(err => console.error(err));
      }, FRAME_WINDOW_MS);
    }

    function onError(err) { /* ignore */ }

    try {
      await html5QrCodeInstance.start(constraints, QR_CONFIG, onSuccess, onError);
      usingFacing = facingPref;
      if (toggleBtn) toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
      console.log('Scanner started with', constraints);
    } catch (err) {
      console.error('Failed to start scanner', constraints, err);
      if (constraints && constraints.deviceId) {
        try {
          await html5QrCodeInstance.start({ facingMode: facingPref }, QR_CONFIG, onSuccess, onError);
          usingFacing = facingPref;
          if (toggleBtn) toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
        } catch (e) {
          console.error('Fallback also failed', e);
        }
      }
    }
  }

  // Toggle camera handler (safe when toggleBtn missing)
  function setupToggle() {
    if (!toggleBtn) return;
    toggleBtn.addEventListener('click', async () => {
      const newFacing = usingFacing === 'user' ? 'environment' : 'user';
      toggleBtn.disabled = true;
      try { await startScanner(newFacing); } finally { toggleBtn.disabled = false; }
    });
  }

  // Diagnostic helper
  async function diagnosticPlayTest(url = 'sounds/C.mp3') {
    console.log('diagnosticPlayTest start for', url);
    try {
      if (AUDIO_CTX.state === 'suspended') {
        console.log('resuming audio context');
        await AUDIO_CTX.resume();
      }
      const r = await fetch(url);
      console.log('fetch', url, 'status', r.status, 'type', r.headers.get('content-type'), 'len', r.headers.get('content-length'));
      if (!r.ok) throw new Error('fetch failed ' + r.status);
      const buf = await loadAudio(url);
      console.log('decoded duration', buf && buf.duration);
      playBuffer(buf, 0);
      console.log('played', url);
    } catch (e) {
      console.error('diagnostic error', e);
    }
  }

  // Boot sequence: wait for DOM and try to attach handlers
  async function boot() {
    try { await loadMapping(); } catch (e) { console.error('Failed loadMapping', e); return; }

    // Resolve DOM elements now that DOM is ready
    startBtn = document.getElementById('start-button');
    toggleBtn = document.getElementById('toggle-camera');

    setupToggle();

    if (startBtn) {
      startBtn.addEventListener('click', async function onStart() {
        try {
          if (AUDIO_CTX.state === 'suspended') { await AUDIO_CTX.resume(); console.log('AudioContext resumed'); }
        } catch (e) { console.warn('Audio resume failed', e); }

        // Preload sounds after user gesture (mobile)
        try {
          const urls = Array.from(new Set(Object.values(figuresMap).map(f => f.sound)));
          console.log('Preloading', urls);
          await Promise.all(urls.map(u => loadAudio(u).catch(err => { console.warn('preload fail', u, err); })));
          console.log('Preload complete');
        } catch (e) { console.warn('Preload error', e); }

        startBtn.style.display = 'none';
        await startScanner('user').catch(err => console.error('Scanner start failed', err));
      });
      // On desktop also allow immediate start by clicking Start
    } else {
      // No Start button found: try auto-starting scanner (desktop)
      try {
        // Attempt to resume audio if possible (won't require user gesture on many desktops)
        if (AUDIO_CTX.state === 'suspended') {
          try { await AUDIO_CTX.resume(); console.log('AudioContext resumed (auto)'); } catch (e) { /* ignore */ }
        }
        // Preload sounds (best-effort)
        const urls = Array.from(new Set(Object.values(figuresMap).map(f => f.sound)));
        await Promise.all(urls.map(u => loadAudio(u).catch(() => {})));
      } catch (e) { /* ignore preload errors on auto start */ }

      // Start scanner automatically for desktop
      startScanner('user').catch(err => console.error('Auto scanner start failed', err));
    }
  }

  // Wait for DOM then boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose diagnostic function for console use
  window.nabokoDiagnosticPlayTest = diagnosticPlayTest;
})();
