/* ══════════════════════════════════════════════════
   DADGA — Kurdish Voice Transcription Platform
   Main Application Script v1.0
   ══════════════════════════════════════════════════ */

'use strict';

// ═══════════ CONFIGURATION ═══════════
const CONFIG = {
  API_URL: '/transcribe',   // relative — works on Netlify AND localhost:5050
  CHUNK_DURATION_MS: 30000,
  MIN_SPEECH_DURATION_MS: 2000,
  WAVEFORM_BARS: 60,
  STORAGE_KEY: 'dadga_history',
  RETRY_DELAY_MS: 3500,
  MAX_RETRIES: 2,
};

// ═══════════ STATE ═══════════
const state = {
  isRecording: false,
  recordingMode: 'manual',     // 'vad' | 'manual'
  vadThreshold: 15,
  silenceDelay: 2000,   // wait 2s of silence before cutting a segment

  // Audio pipeline
  audioCtx: null,
  analyser: null,
  mediaStream: null,
  mediaRecorder: null,
  scriptProcessor: null,
  audioChunks: [],

  // VAD
  isSpeaking: false,
  silenceTimer: null,
  speechStartTime: null,

  // Session
  segments: [],               // [{id, text, timestamp, duration}]
  sessionStartTime: null,
  timerInterval: null,

  // Waveform
  animFrame: null,
  waveDataArray: null,
  freqDataArray: null,

  // History
  history: [],
};

// ═══════════ DOM REFS ═══════════
const $ = id => document.getElementById(id);

const dom = {
  micBtn: $('micBtn'),
  micContainer: $('micContainer'),
  micIcon: document.querySelector('.mic-icon'),
  stopIcon: document.querySelector('.stop-icon'),
  statusText: $('statusText'),
  statusIndicator: document.querySelector('.status-indicator'),
  recorderStatusLabel: $('recorderStatusLabel'),

  waveCanvas: $('waveCanvas'),
  levelFill: $('levelFill'),
  thresholdMarker: $('thresholdMarker'),

  transcriptBadge: $('transcriptBadge'),
  transcriptPlaceholder: $('transcriptPlaceholder'),
  transcriptSegments: $('transcriptSegments'),
  transcriptScroll: $('transcriptScroll'),

  statSegments: $('statSegments'),
  statWords: $('statWords'),
  statTime: $('statTime'),

  vadThreshold: $('vadThreshold'),
  vadThresholdVal: $('vadThresholdVal'),
  silenceDelay: $('silenceDelay'),
  silenceDelayVal: $('silenceDelayVal'),
  langSelect: $('langSelect'),

  apiStatus: $('apiStatus'),
  apiStatusDot: document.querySelector('#apiStatus .status-dot'),
  apiStatusText: document.querySelector('#apiStatus span'),

  toastContainer: $('toastContainer'),
  loadingOverlay: $('loadingOverlay'),

  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
};

// ═══════════ QUILL EDITOR ═══════════
let quill = null;
let editorWordCount = $('editorWordCount');
let editorCharCount = $('editorCharCount');

function initQuill() {
  quill = new Quill('#quillEditor', {
    modules: {
      toolbar: '#quillToolbar',
    },
    placeholder: 'دەقی وەرگێڕدراو لێرەدا دەردەکەوێت... دەتوانی دەستی بنووسیت یان بیناردیتە وێرایەر',
    theme: 'snow',
  });

  quill.on('text-change', () => {
    const text = quill.getText();
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    editorWordCount.textContent = `${words.length} وشە`;
    editorCharCount.textContent = `${text.length - 1} پیت`;
  });
}

// ═══════════ TAB NAVIGATION ═══════════
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`panel-${tab}`).classList.add('active');
    });
  });
}

// ═══════════ SETTINGS CONTROLS ═══════════
function initSettings() {
  dom.vadThreshold.addEventListener('input', () => {
    state.vadThreshold = parseInt(dom.vadThreshold.value);
    dom.vadThresholdVal.textContent = state.vadThreshold;
    updateThresholdMarker();
  });

  dom.silenceDelay.addEventListener('input', () => {
    state.silenceDelay = parseInt(dom.silenceDelay.value);
    dom.silenceDelayVal.textContent = state.silenceDelay;
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.recordingMode = btn.dataset.mode;
    });
  });
}

function updateThresholdMarker() {
  const pct = (state.vadThreshold / 50) * 100;
  dom.thresholdMarker.style.left = `${pct}%`;
}

// ═══════════ AUDIO SETUP ═══════════
async function initAudio() {
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = state.audioCtx.createMediaStreamSource(state.mediaStream);
    state.audioSource = source;

    // Analyser for waveform only
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.75;
    state.waveDataArray = new Uint8Array(state.analyser.frequencyBinCount);
    state.freqDataArray = new Uint8Array(state.analyser.frequencyBinCount);
    source.connect(state.analyser);

    // ScriptProcessor — fires every 128 ms, ALWAYS, regardless of rAF.
    // Does: (1) RMS for VAD, (2) ALL VAD state transitions, (3) PCM accumulation.
    // Output silenced via gain=0 — no speaker feedback.
    state.scriptProcessor = state.audioCtx.createScriptProcessor(2048, 1, 1);
    state.scriptProcessor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);

      // 1. Compute RMS
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length) * 100;
      state._rmsLevel = rms;

      if (!state.isRecording) return;

      // 2. Accumulate PCM during speech
      if (state.isSpeaking) {
        state._pcmChunks.push(new Float32Array(data));
      }

      // 3. VAD decisions (VAD mode only)
      if (state.recordingMode !== 'vad') return;
      const speaking = rms > state.vadThreshold;

      if (speaking && !state.isSpeaking) {
        // ── Speech started ──
        state.isSpeaking = true;
        state._pcmChunks = [new Float32Array(data)]; // include this frame
        state.speechStartTime = Date.now();
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
        // Update UI from main thread
        setTimeout(() => setStatus('recording', 'دەنگ تۆماردەکرێت...'), 0);

      } else if (!speaking && state.isSpeaking && !state.silenceTimer) {
        // ── Silence detected — start countdown ──
        state.silenceTimer = setTimeout(() => {
          state.silenceTimer = null;
          if (!state.isRecording || !state.isSpeaking) return;
          const duration = Date.now() - state.speechStartTime;
          state.isSpeaking = false;

          if (duration >= CONFIG.MIN_SPEECH_DURATION_MS) {
            const wav = flushPCMtoWAV();
            if (wav) {
              sendToAPI(wav);
              setStatus('processing', 'وەرگێڕان...');
            }
          } else {
            state._pcmChunks = [];
            setStatus('ready', 'چاوەروانی دەنگ...');
          }
        }, state.silenceDelay);

      } else if (speaking && state.isSpeaking && state.silenceTimer) {
        // ── Speech resumed before silence timeout — cancel it ──
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
      }
    };

    const silentGain = state.audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(state.scriptProcessor);
    state.scriptProcessor.connect(silentGain);
    silentGain.connect(state.audioCtx.destination);

    state._rmsLevel = 0;
    state._pcmChunks = [];

    console.log('[Audio] Ready — 16kHz WAV, VAD in audio thread');
    setApiStatus('ready', 'مایکرۆفۆن ئامادەیە');
    return true;
  } catch (err) {
    console.error('Mic error:', err);
    setApiStatus('error', 'مایکرۆفۆن نەدۆزرایەوە');
    showToast('دەستگەیشتن بە مایکرۆفۆن ڕەتکرایەوە. تکایە مۆڵەت بدە.', 'error');
    return false;
  }
}

// ═══════════ WAV ENCODER ═══════════
function flushPCMtoWAV() {
  const chunks = state._pcmChunks;
  state._pcmChunks = [];
  if (!chunks.length) return null;

  const sr = state.audioCtx.sampleRate;
  const totalLen = chunks.reduce((a, c) => a + c.length, 0);
  if (totalLen < sr * 0.1) return null;

  const pcm = new Float32Array(totalLen);
  let pos = 0;
  for (const c of chunks) { pcm.set(c, pos); pos += c.length; }

  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const wr = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };

  wr(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true);
  wr(8, 'WAVE'); wr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);  v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const n = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, n < 0 ? n * 0x8000 : n * 0x7FFF, true);
    off += 2;
  }

  const blob = new Blob([buf], { type: 'audio/wav' });
  console.log(`[WAV] ${(pcm.length / sr).toFixed(1)}s → ${blob.size} bytes`);
  return blob;
}


// ═══════════ RECORDING ═══════════
function startRecording() {
  if (!state.audioCtx) return;
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

  state._pcmChunks = [];
  state.isRecording = true;
  state.isSpeaking = false;
  state.sessionStartTime = Date.now();

  state.timerInterval = setInterval(updateTimer, 1000);
  drawWaveform();
  vadUILoop();   // UI-only rAF loop for level bar

  if (state.recordingMode === 'vad') {
    // VAD logic runs in onaudioprocess — just set initial status
    setStatus('ready', 'چاوەروانی دەنگ...');
  } else {
    state.isSpeaking = true;
    setStatus('recording', 'تۆمارکردن دەکرێت...');
  }

  dom.micBtn.classList.add('recording');
  dom.micContainer.classList.add('active');
  dom.micIcon.classList.add('hidden');
  dom.stopIcon.classList.remove('hidden');
  setApiStatus('loading', 'تۆمارکردن...');
}

function stopRecording() {
  state.isRecording = false;
  clearInterval(state.timerInterval);
  clearTimeout(state.silenceTimer);
  state.silenceTimer = null;

  // Flush all accumulated PCM and send
  if (state.isSpeaking) {
    state.isSpeaking = false;
    const wav = flushPCMtoWAV();
    if (wav) {
      sendToAPI(wav);
      setStatus('processing', 'وەرگێڕان...');
    }
  }

  cancelAnimationFrame(state.animFrame);
  clearWaveform();

  dom.micBtn.classList.remove('recording');
  dom.micContainer.classList.remove('active');
  dom.micIcon.classList.remove('hidden');
  dom.stopIcon.classList.add('hidden');
  dom.levelFill.style.width = '0%';

  setStatus('ready', 'بۆ دەستپێکردن کلیک بکە');
  setApiStatus('ready', 'سیستەم ئامادەیە');

  if (state.segments.length > 0) {
    saveToHistory(state.segments);
    state.segments = [];
    dom.statSegments.textContent = '0';
    dom.statWords.textContent = '0';
  }
}



// ═══════════ VAD UI LOOP ═══════════
// Only updates visual elements. All real VAD decisions are in onaudioprocess.
function vadUILoop() {
  if (!state.isRecording) return;

  const level = state._rmsLevel || 0;
  const speaking = level > state.vadThreshold;

  dom.levelFill.style.width = `${Math.min(level * 4, 100)}%`;
  dom.levelFill.style.background = speaking
    ? 'linear-gradient(90deg, #7c3aed, #10b981)'
    : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)';

  requestAnimationFrame(vadUILoop);
}

function getAudioLevel(freqData) {
  let sum = 0;
  const relevant = freqData.slice(0, freqData.length / 4);
  for (let i = 0; i < relevant.length; i++) sum += relevant[i];
  return (sum / relevant.length / 255) * 100;
}




// ═══════════ API CALL ═══════════
async function sendToAPI(audioBlob, retryCount = 0) {
  if (!audioBlob || audioBlob.size < 500) return;

  console.log(`[API] Sending WAV: ${audioBlob.size} bytes, attempt ${retryCount + 1}`);

  const processingId = retryCount === 0 ? `proc-${Date.now()}` : null;
  if (processingId) {
    showProcessingSegment(processingId);
    setBadge('processing', 'وەرگێڕان...');
  }

  const formData = new FormData();
  formData.append('audio_file', audioBlob, 'recording.wav');

  try {
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'accept': 'application/json' },
      body: formData,
    });

    if (processingId) removeProcessingSegment(processingId);

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[API] Error ${response.status}:`, errBody);

      // Auto-retry on Google File API race condition
      const isNotActive = errBody.includes('FAILED_PRECONDITION') || errBody.includes('not in an ACTIVE state');
      if (response.status === 500 && isNotActive && retryCount < CONFIG.MAX_RETRIES) {
        const wait = (retryCount + 1) * CONFIG.RETRY_DELAY_MS;
        console.log(`[API] Retrying in ${wait}ms (attempt ${retryCount + 1}/${CONFIG.MAX_RETRIES})`);
        showToast(`وەرگێڕان دووبارە دەکرێتەوە... (${retryCount + 1})`, 'warning', 3000);
        setBadge('processing', 'دووبارەکردنەوە...');
        await new Promise(r => setTimeout(r, wait));
        return sendToAPI(audioBlob, retryCount + 1);
      }

      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[API] →', data);
    const text = (data.transcription || '').trim();

    if (text) {
      addSegment(text, audioBlob);   // pass blob so segment gets audio player
      setBadge('ready', 'ئامادە');
      setApiStatus('ready', 'وەرگێڕان سەرکەوتوو');
    } else {
      setBadge('ready', 'ئامادە');
      setApiStatus('ready', 'دەنگ نەدۆزرایەوە');
    }
  } catch (err) {
    console.error('API Error:', err);
    if (processingId) removeProcessingSegment(processingId);
    setBadge('error', 'هەڵە');
    setApiStatus('error', 'هەڵەی تۆڕ');
    // Show a persistent failed card — audio is saved for retry
    showFailedSegment(audioBlob, err.message);
  }
}



// ═══════════ FAILED SEGMENT ═══════════
// Called when API fails after all retries — keeps the audio so user can retry
const _failedBlobs = {};   // id → Blob

function showFailedSegment(audioBlob, errMsg) {
  const id  = `fail-${Date.now()}`;
  const audioUrl = audioBlob ? URL.createObjectURL(audioBlob) : null;
  if (audioBlob) _failedBlobs[id] = audioBlob;

  dom.transcriptPlaceholder.style.display = 'none';

  const el = document.createElement('div');
  el.className = 'segment segment-failed';
  el.id = id;
  el.innerHTML = `
    <div class="segment-meta">
      <span class="segment-time">${new Date().toLocaleTimeString('ku')}</span>
      <span class="segment-fail-badge">وەرگێڕان سەرکەوتوو نەبوو</span>
      <button class="segment-delete-btn" title="سڕینەوە" onclick="removeFailedSegment('${id}')"
        style="opacity:1">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </button>
    </div>
    <p class="segment-fail-msg">⚠ ${escapeHtml(errMsg || 'هەڵەی نەزانراو')}</p>
    ${audioUrl ? `
    <div class="segment-audio">
      <audio controls preload="none" src="${audioUrl}" class="segment-audio-player"></audio>
      <a href="${audioUrl}" download="dadga_failed_${id}.wav" class="segment-dl-btn" title="دەربژێن">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </a>
    </div>` : ''}
    ${audioBlob ? `
    <button class="segment-retry-btn" id="retry-${id}" onclick="retrySegment('${id}')">
      <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15">
        <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/>
      </svg>
      دووبارە ناردن بۆ وەرگێڕان
    </button>` : ''}
  `;

  dom.transcriptSegments.appendChild(el);
  dom.transcriptScroll.scrollTop = dom.transcriptScroll.scrollHeight;
  showToast('دەنگەکە پاشەکەوت کرا — دووبارە هەوڵبدەرەوە', 'warning', 4000);
}

function retrySegment(id) {
  const blob = _failedBlobs[id];
  if (!blob) return;

  // Replace the failed card with a processing indicator
  const el = document.getElementById(id);
  if (el) {
    el.style.transition = 'opacity 0.2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }
  delete _failedBlobs[id];

  // Resend
  sendToAPI(blob);
  showToast('دووبارە ناردن...', 'info', 2000);
}

function removeFailedSegment(id) {
  if (_failedBlobs[id]) {
    URL.revokeObjectURL(_failedBlobs[id]);
    delete _failedBlobs[id];
  }
  const el = document.getElementById(id);
  if (el) {
    el.style.transition = 'opacity 0.25s, transform 0.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(30px)';
    setTimeout(() => {
      el.remove();
      if (dom.transcriptSegments.querySelectorAll('.segment').length === 0) {
        dom.transcriptPlaceholder.style.display = '';
      }
    }, 260);
  }
}

// ═══════════ INDEXEDDB PERSISTENCE ═══════════
const IDB_NAME  = 'dadga_segments';
const IDB_VER   = 1;
const IDB_STORE = 'segments';

function openSegmentDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbPut(record) {
  const db = await openSegmentDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

async function idbDelete(id) {
  const db = await openSegmentDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

async function idbClear() {
  const db = await openSegmentDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

async function idbGetAll() {
  const db = await openSegmentDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// Restore all saved segments on page load
async function restoreSegments() {
  try {
    const saved = await idbGetAll();
    if (!saved || saved.length === 0) return;
    // Sort by saved order (id is timestamp-based)
    saved.sort((a, b) => a.id.localeCompare(b.id));
    for (const record of saved) {
      const audioUrl = record.audioBlob ? URL.createObjectURL(record.audioBlob) : null;
      const seg = { ...record, audioUrl };
      state.segments.push(seg);
      renderSegmentEl(seg);
    }
    updateStats();
    dom.transcriptPlaceholder.style.display = 'none';
    showToast(`💾 ${saved.length} بەش گەڕاندراوەتەوە`, 'info', 3000);
  } catch (err) {
    console.error('[IDB] Restore failed:', err);
  }
}

// ═══════════ TRANSCRIPT UI ═══════════
function addSegment(text, audioBlob) {
  const audioUrl = audioBlob ? URL.createObjectURL(audioBlob) : null;
  const seg = {
    id: `seg-${Date.now()}`,
    text,
    audioUrl,
    timestamp: new Date().toLocaleTimeString('ku'),
    wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
  };
  state.segments.push(seg);
  renderSegmentEl(seg);
  updateStats();
  // Persist to IndexedDB (audio blob + text)
  idbPut({ id: seg.id, text: seg.text, audioBlob: audioBlob || null,
           timestamp: seg.timestamp, wordCount: seg.wordCount })
    .catch(e => console.error('[IDB] Save failed:', e));
  showToast(`دەق زیادکرا: ${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`, 'success');
}

// Pure DOM renderer — used by addSegment AND restoreSegments
function renderSegmentEl(seg) {
  dom.transcriptPlaceholder.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'segment';
  el.id = seg.id;

  const audioRow = seg.audioUrl ? `
    <div class="segment-audio">
      <audio controls preload="none" src="${seg.audioUrl}" class="segment-audio-player"></audio>
      <a href="${seg.audioUrl}" download="dadga_${seg.id}.wav" class="segment-dl-btn" title="دەربژێن">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </a>
    </div>` : '';

  el.innerHTML = `
    <div class="segment-meta">
      <span class="segment-time">${seg.timestamp}</span>
      <span class="segment-num">بەش ${state.segments.length}</span>
      <button class="segment-delete-btn" title="سڕینەوە" onclick="deleteSegment('${seg.id}')">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </button>
    </div>
    <div class="segment-text">${escapeHtml(seg.text)}</div>
    ${audioRow}
  `;

  dom.transcriptSegments.appendChild(el);
  dom.transcriptScroll.scrollTop = dom.transcriptScroll.scrollHeight;
}

function deleteSegment(id) {
  const seg = state.segments.find(s => s.id === id);
  if (seg && seg.audioUrl) URL.revokeObjectURL(seg.audioUrl);
  state.segments = state.segments.filter(s => s.id !== id);
  idbDelete(id).catch(e => console.error('[IDB] Delete failed:', e));
  const el = document.getElementById(id);
  if (el) {
    el.style.transition = 'opacity 0.25s, transform 0.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(30px)';
    setTimeout(() => {
      el.remove();
      if (dom.transcriptSegments.querySelectorAll('.segment').length === 0) {
        dom.transcriptPlaceholder.style.display = '';
      }
    }, 260);
  }
  updateStats();
  showToast('بەش سڕایەوە', 'info', 1800);
}


function showProcessingSegment(id) {
  dom.transcriptPlaceholder.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'processing-segment';
  el.id = id;
  el.innerHTML = `
    <div class="processing-dots"><span></span><span></span><span></span></div>
    <span>وەرگێڕان دەکات...</span>
  `;
  dom.transcriptSegments.appendChild(el);
  dom.transcriptScroll.scrollTop = dom.transcriptScroll.scrollHeight;
}

function removeProcessingSegment(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  if (dom.transcriptSegments.children.length === 0) {
    dom.transcriptPlaceholder.style.display = '';
  }
}

function updateStats() {
  dom.statSegments.textContent = state.segments.length;
  const totalWords = state.segments.reduce((acc, s) => acc + s.wordCount, 0);
  dom.statWords.textContent = totalWords;
}

function clearTranscript() {
  // Revoke all object URLs
  state.segments.forEach(s => { if (s.audioUrl) URL.revokeObjectURL(s.audioUrl); });
  state.segments = [];
  dom.transcriptSegments.innerHTML = '';
  dom.transcriptPlaceholder.style.display = '';
  dom.statSegments.textContent = '0';
  dom.statWords.textContent = '0';
  dom.statTime.textContent = '00:00';
  setBadge('ready', 'ئامادە');
  idbClear().catch(e => console.error('[IDB] Clear failed:', e));
}

// ═══════════ WAVEFORM ═══════════
function drawWaveform() {
  if (!state.analyser) return;
  const canvas = dom.waveCanvas;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  state.analyser.getByteTimeDomainData(state.waveDataArray);

  ctx.clearRect(0, 0, W, H);

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, 'rgba(124, 58, 237, 0.8)');
  gradient.addColorStop(0.5, 'rgba(37, 99, 235, 0.9)');
  gradient.addColorStop(1, 'rgba(6, 182, 212, 0.8)');

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = gradient;
  ctx.shadowColor = 'rgba(124, 58, 237, 0.4)';
  ctx.shadowBlur = 10;

  ctx.beginPath();
  const sliceWidth = W / state.waveDataArray.length;
  let x = 0;
  for (let i = 0; i < state.waveDataArray.length; i++) {
    const v = state.waveDataArray[i] / 128.0;
    const y = (v * H) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  state.animFrame = requestAnimationFrame(drawWaveform);
}

function clearWaveform() {
  const canvas = dom.waveCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw flat line
  const W = canvas.width; const H = canvas.height;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
}

// ═══════════ TIMER ═══════════
function updateTimer() {
  if (!state.sessionStartTime) return;
  const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  dom.statTime.textContent = `${m}:${s}`;
}

// ═══════════ STATUS HELPERS ═══════════
function setStatus(type, text) {
  const indicator = dom.statusIndicator;
  indicator.className = `status-indicator ${type}`;
  dom.statusText.textContent = text;
}

function setApiStatus(type, text) {
  const dot = dom.apiStatusDot;
  const span = dom.apiStatusText;
  dot.className = 'status-dot';
  if (type === 'error') dot.classList.add('error');
  else if (type === 'loading') dot.classList.add('loading');
  span.textContent = text;
}

function setBadge(type, text) {
  dom.transcriptBadge.className = `transcript-badge ${type === 'ready' ? '' : type}`;
  dom.transcriptBadge.textContent = text;
}

// ═══════════ TOAST NOTIFICATIONS ═══════════
function showToast(message, type = 'info', duration = 3500) {
  const icons = {
    success: `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`,
    error: `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>`,
    info: `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>`,
    warning: `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ═══════════ HISTORY ═══════════
function saveToHistory(segments) {
  if (segments.length === 0) return;
  const entry = {
    id: `hist-${Date.now()}`,
    date: new Date().toLocaleString('ku'),
    segments: [...segments],
    totalText: segments.map(s => s.text).join('\n'),
    wordCount: segments.reduce((acc, s) => acc + s.wordCount, 0),
  };
  state.history.unshift(entry);
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state.history));
  renderHistory();
}

function loadHistory() {
  try {
    const stored = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (stored) state.history = JSON.parse(stored);
  } catch (e) {}
  renderHistory();
}

function renderHistory() {
  const list = dom.historyList;
  dom.historyEmpty.style.display = state.history.length === 0 ? '' : 'none';

  // Remove old items
  list.querySelectorAll('.history-item').forEach(el => el.remove());

  state.history.forEach(entry => {
    const el = document.createElement('div');
    el.className = 'history-item glass-card';
    el.innerHTML = `
      <div class="history-item-header">
        <span class="history-date">${entry.date}</span>
        <div class="history-item-actions">
          <button class="history-action-btn" data-action="editor" data-id="${entry.id}">ناردن بۆ وێرایەر</button>
          <button class="history-action-btn" data-action="copy" data-id="${entry.id}">کۆپی</button>
          <button class="history-action-btn" data-action="delete" data-id="${entry.id}">سڕینەوە</button>
        </div>
      </div>
      <div class="history-item-text">${escapeHtml(entry.totalText)}</div>
      <div class="history-item-meta">
        <span>${entry.segments.length} بەش</span>
        <span>·</span>
        <span>${entry.wordCount} وشە</span>
      </div>
    `;

    el.querySelectorAll('.history-action-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        handleHistoryAction(btn.dataset.action, btn.dataset.id);
      });
    });

    list.appendChild(el);
  });
}

function handleHistoryAction(action, id) {
  const entry = state.history.find(h => h.id === id);
  if (!entry) return;

  if (action === 'copy') {
    navigator.clipboard.writeText(entry.totalText).then(() => {
      showToast('دەق کۆپیکرا', 'success');
    });
  } else if (action === 'editor') {
    appendToEditor(entry.totalText);
    $('tab-editor').click();
    showToast('دەق نێردرا بۆ وێرایەر', 'success');
  } else if (action === 'delete') {
    state.history = state.history.filter(h => h.id !== id);
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state.history));
    renderHistory();
    showToast('تۆمار سڕایەوە', 'info');
  }
}

// ═══════════ EDITOR HELPERS ═══════════
function appendToEditor(text) {
  if (!quill) return;
  const len = quill.getLength();
  if (len > 1) {
    quill.insertText(len - 1, '\n');
  }
  quill.insertText(quill.getLength() - 1, text);
}

// ═══════════ EXPORT FUNCTIONS ═══════════
function exportTxt() {
  if (!quill) return;
  const text = quill.getText();
  if (!text.trim()) { showToast('وێرایەر بەتاڵە', 'warning'); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  saveAs(blob, `dadga_${formatDate()}.txt`);
  showToast('فایلی TXT هەناردەکرا', 'success');
}

async function exportDocx() {
  if (!quill) return;
  const text = quill.getText();
  if (!text.trim()) { showToast('وێرایەر بەتاڵە', 'warning'); return; }

  try {
    const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer } = docx;

    const paragraphs = text.split('\n').filter(line => line.trim()).map(line =>
      new Paragraph({
        children: [new TextRun({
          text: line,
          font: 'Calibri',
          size: 24,
          rightToLeft: true,
        })],
        alignment: AlignmentType.RIGHT,
        bidirectional: true,
        spacing: { after: 200 },
      })
    );

    const doc = new Document({
      sections: [{
        properties: {
          rightToLeft: true,
        },
        children: [
          new Paragraph({
            children: [new TextRun({
              text: 'داگا — وەرگێڕانی دەنگ',
              bold: true,
              size: 32,
              font: 'Calibri',
              rightToLeft: true,
            })],
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          }),
          new Paragraph({
            children: [new TextRun({
              text: `بەروار: ${new Date().toLocaleDateString('ku')}`,
              size: 20,
              color: '666666',
              rightToLeft: true,
            })],
            alignment: AlignmentType.RIGHT,
            spacing: { after: 400 },
          }),
          ...paragraphs,
        ],
      }],
    });

    const buffer = await Packer.toBlob(doc);
    saveAs(buffer, `dadga_${formatDate()}.docx`);
    showToast('فایلی Word هەناردەکرا', 'success');
  } catch (err) {
    console.error('DOCX error:', err);
    showToast('هەڵە لە دروستکردنی فایلی Word', 'error');
  }
}

function exportAllHistory() {
  if (state.history.length === 0) { showToast('مێژوو بەتاڵە', 'warning'); return; }
  const text = state.history.map(entry =>
    `=== ${entry.date} ===\n${entry.totalText}\n`
  ).join('\n\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  saveAs(blob, `dadga_history_${formatDate()}.txt`);
  showToast('مێژوو هەناردەکرا', 'success');
}

function formatDate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
}

// ═══════════ UTILITY ═══════════
function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ═══════════ THEME TOGGLE ═══════════
function initTheme() {
  const btn = $('themeToggle');
  const saved = localStorage.getItem('dadga_theme');
  if (saved === 'light') document.body.classList.add('light-mode');

  btn.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('dadga_theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
    showToast(document.body.classList.contains('light-mode') ? 'ڕووکەڵی ڕووناک' : 'ڕووکەڵی تاریک', 'info');
  });
}

// ═══════════ MAIN MIC BUTTON ═══════════
async function handleMicClick() {
  if (!state.isRecording) {
    if (!state.audioCtx) {
      const ok = await initAudio();
      if (!ok) return;
    }
    startRecording();
  } else {
    stopRecording();
  }
}

// ═══════════ INIT ═══════════
function init() {
  clearWaveform();
  updateThresholdMarker();
  initTabs();
  initSettings();
  initTheme();
  initQuill();
  loadHistory();
  restoreSegments();   // ← restore persisted segments from IndexedDB

  // MIC button
  dom.micBtn.addEventListener('click', handleMicClick);

  // Quick actions
  $('clearTranscriptBtn').addEventListener('click', () => {
    if (state.segments.length > 0) {
      clearTranscript();
      showToast('دەق پاکرایەوە', 'info');
    }
  });

  $('copyTranscriptBtn').addEventListener('click', () => {
    const text = state.segments.map(s => s.text).join('\n');
    if (!text) { showToast('دەقی بۆ کۆپیکردن نییە', 'warning'); return; }
    navigator.clipboard.writeText(text).then(() => showToast('دەق کۆپیکرا', 'success'));
  });

  $('sendToEditorBtn').addEventListener('click', () => {
    const text = state.segments.map(s => s.text).join('\n');
    if (!text) { showToast('دەقی بۆ ناردن نییە', 'warning'); return; }
    appendToEditor(text);
    $('tab-editor').click();
    showToast('دەق نێردرا بۆ وێرایەر', 'success');
  });

  // Editor actions
  $('exportTxt').addEventListener('click', exportTxt);
  $('exportDocx').addEventListener('click', exportDocx);
  $('clearEditorBtn').addEventListener('click', () => {
    quill.setText('');
    showToast('وێرایەر پاکرایەوە', 'info');
  });
  $('printEditorBtn').addEventListener('click', () => window.print());

  // History
  $('clearHistoryBtn').addEventListener('click', () => {
    state.history = [];
    localStorage.removeItem(CONFIG.STORAGE_KEY);
    renderHistory();
    showToast('مێژوو پاکرایەوە', 'info');
  });
  $('exportHistoryBtn').addEventListener('click', exportAllHistory);

  // Reload waveform canvas size on resize
  window.addEventListener('resize', () => {
    const canvas = dom.waveCanvas;
    canvas.width = canvas.offsetWidth;
  });
  dom.waveCanvas.width = dom.waveCanvas.offsetWidth;

  // Logout
  $('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('dadga_auth');
    sessionStorage.removeItem('dadga_auth_user');
    location.replace('login.html');
  });

  // Initial status
  setStatus('ready', 'بۆ دەستپێکردن کلیک بکە');
}

// Wait for everything to load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
