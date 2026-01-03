// ===========================
// TV SYNC SERVER v3.0.0 (v20260102_1115PST)
// Fixed: rotation-signal endpoint, interval/rotation alert combining
// ===========================

const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const STATE_FILE = './server-state.json';

// Default CSV URL
let csvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT1jm8cmzAnIk8kkO_d3mIZXmD6xaXPRd4Z7ww3EboYujHHHqbwkSqlevXA1ahvUv1Y0CUzQgtHl1FU/pub?gid=0&single=true&output=csv';

// ===========================
// STATE
// ===========================
let state = {
  // Rotation state
  currentIndex: 0,
  rotationsCount: 0,
  lastRotationTime: Date.now(),
  rotationStartTime: Date.now(),
  
  // Timing (controlled by master)
  rotateInterval: 7,      // seconds
  fetchInterval: 120,     // seconds
  colLInterval: 10,       // seconds
  intervalSummarySeconds: 60, // interval summary timing
  
  // Master-synced settings
  navigationMode: 'url',  // 'url' or 'typing'
  historyAutoClear: 7,    // days
  
  // Rating filters (synced from master) - APPLIED SERVER-SIDE
  selectedFilters: ['Comfortable'],
  
  // Thresholds and Cooldowns (synced from master)
  alertSettings: {
    threshold_1c: 2, threshold_2c: 2,
    threshold_1_minus: 20, threshold_2_minus: 20,
    cooldown_1x: 15, cooldown_1c: 15, cooldown_1_plus: 15, cooldown_1_minus: 15,
    cooldown_2x: 15, cooldown_2c: 15, cooldown_2_plus: 15, cooldown_2_minus: 15
  },
  
  // Symbol data (from CSV)
  allSymbols: [],         // Raw CSV data (ALL symbols)
  filteredData: [],       // FILTERED by selectedFilters - THIS IS WHAT WE ROTATE
  lastCsvFetch: 0,
  
  // Master tracking
  settingsMasterId: null,
  settingsMasterLastSeen: 0,
  
  // Server status
  isRotating: false,
  isPaused: false
};

// Browser tracking
let browsers = new Map();

// Alert collection
let intervalAlerts = new Map();
let rotationAlerts = new Map();

// Timers
let rotationTimer = null;
let csvFetchTimer = null;

// ===========================
// APPLY FILTERS - KEY FIX!
// ===========================
function applyFilters() {
  if (state.allSymbols.length > 0 && state.selectedFilters.length > 0) {
    state.filteredData = state.allSymbols.filter(item => 
      state.selectedFilters.includes(item['Rating'])
    );
  } else {
    state.filteredData = state.allSymbols;
  }
  
  // Reset index if it exceeds filtered data length
  if (state.currentIndex >= state.filteredData.length) {
    state.currentIndex = 0;
    state.rotationsCount++;
  }
  
  console.log(`🏷️ Filters applied: ${state.filteredData.length}/${state.allSymbols.length} symbols (${state.selectedFilters.join(', ')})`);
}

// ===========================
// STATE PERSISTENCE
// ===========================
function saveState() {
  try {
    const saveData = {
      currentIndex: state.currentIndex,
      rotationsCount: state.rotationsCount,
      rotateInterval: state.rotateInterval,
      fetchInterval: state.fetchInterval,
      colLInterval: state.colLInterval,
      intervalSummarySeconds: state.intervalSummarySeconds,
      navigationMode: state.navigationMode,
      historyAutoClear: state.historyAutoClear,
      selectedFilters: state.selectedFilters,
      alertSettings: state.alertSettings,
      allSymbols: state.allSymbols,
      lastCsvFetch: state.lastCsvFetch,
      csvUrl: csvUrl,
      savedAt: Date.now()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(saveData, null, 2));
    console.log(`💾 State saved (index: ${state.currentIndex}/${state.filteredData.length})`);
  } catch (e) {
    console.error('❌ Failed to save state:', e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.currentIndex = data.currentIndex || 0;
      state.rotationsCount = data.rotationsCount || 0;
      state.rotateInterval = data.rotateInterval || 7;
      state.fetchInterval = data.fetchInterval || 120;
      state.colLInterval = data.colLInterval || 10;
      state.intervalSummarySeconds = data.intervalSummarySeconds || 60;
      state.navigationMode = data.navigationMode || 'url';
      state.historyAutoClear = data.historyAutoClear || 7;
      if (data.selectedFilters) state.selectedFilters = data.selectedFilters;
      if (data.alertSettings) state.alertSettings = data.alertSettings;
      state.allSymbols = data.allSymbols || [];
      state.lastCsvFetch = data.lastCsvFetch || 0;
      if (data.csvUrl) csvUrl = data.csvUrl;
      
      // Apply filters after loading
      applyFilters();
      
      console.log(`📂 State loaded (index: ${state.currentIndex}, filtered: ${state.filteredData.length}/${state.allSymbols.length})`);
      return true;
    }
  } catch (e) {
    console.error('❌ Failed to load state:', e.message);
  }
  return false;
}

// ===========================
// CSV FETCHING
// ===========================
async function fetchCSV() {
  console.log('🔥 Fetching CSV...');
  
  try {
    const response = await fetch(csvUrl + '&t=' + Date.now());
    const text = await response.text();
    
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      console.log('⚠️ CSV empty or invalid');
      return false;
    }
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    
    const newSymbols = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length >= headers.length) {
        const row = {};
        headers.forEach((h, idx) => row[h] = values[idx]);
        if (row.Symbol && row.Exchange) {
          newSymbols.push(row);
        }
      }
    }
    
    if (newSymbols.length > 0) {
      state.allSymbols = newSymbols;
      state.lastCsvFetch = Date.now();
      
      // Apply filters after fetching
      applyFilters();
      
      console.log(`✅ CSV loaded: ${state.filteredData.length}/${state.allSymbols.length} symbols`);
      saveState();
      return true;
    }
  } catch (e) {
    console.error('❌ CSV fetch failed:', e.message);
  }
  return false;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

function startCsvFetchTimer() {
  if (csvFetchTimer) clearInterval(csvFetchTimer);
  csvFetchTimer = setInterval(fetchCSV, state.fetchInterval * 1000);
  console.log(`📊 CSV fetch timer: ${state.fetchInterval}s`);
}

// ===========================
// ROTATION - NOW USES FILTERED DATA
// ===========================
function rotate() {
  if (state.isPaused || state.filteredData.length === 0) return;
  
  state.currentIndex++;
  
  // Use FILTERED data length, not allSymbols
  if (state.currentIndex >= state.filteredData.length) {
    state.currentIndex = 0;
    state.rotationsCount++;
    
    // Signal rotation complete
    const rotationId = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    rotationAlerts.set(rotationId, {
      createdAt: Date.now(),
      respondedBrowsers: new Set()
    });
    
    console.log(`🔄 Rotation cycle complete! Starting #${state.rotationsCount + 1}`);
  }
  
  state.lastRotationTime = Date.now();
  
  // Get current symbol from FILTERED data
  const current = state.filteredData[state.currentIndex];
  if (current) {
    console.log(`📍 ${state.currentIndex + 1}/${state.filteredData.length}: ${current.Exchange}:${current.Symbol}`);
  }
}

function restartRotationTimer() {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = setInterval(rotate, state.rotateInterval * 1000);
  console.log(`⏱️ Rotation timer: ${state.rotateInterval}s`);
}

function getTimeToNextRotation() {
  const elapsed = Date.now() - state.lastRotationTime;
  const remaining = Math.max(0, (state.rotateInterval * 1000) - elapsed);
  return Math.ceil(remaining / 1000);
}

// ===========================
// INTERVAL SUMMARY SIGNALS
// ===========================
function createIntervalSignal() {
  const intervalId = `${state.currentIndex}_${Math.random().toString(36).substr(2, 6)}`;
  intervalAlerts.set(intervalId, {
    createdAt: Date.now(),
    alerts: [],
    respondedBrowsers: new Set()
  });
  return intervalId;
}

// Cleanup old signals
setInterval(() => {
  const now = Date.now();
  const maxAge = 120000; // 2 minutes
  
  for (const [id, data] of intervalAlerts) {
    if (now - data.createdAt > maxAge) intervalAlerts.delete(id);
  }
  for (const [id, data] of rotationAlerts) {
    if (now - data.createdAt > maxAge) rotationAlerts.delete(id);
  }
}, 30000);

// ===========================
// API ENDPOINTS
// ===========================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'TV Sync Server v3.0.0',
    symbols: state.filteredData.length,
    allSymbols: state.allSymbols.length,
    filters: state.selectedFilters,
    index: state.currentIndex,
    rotations: state.rotationsCount,
    browsers: browsers.size,
    uptime: Math.floor(process.uptime())
  });
});

// Wake endpoint
app.get('/wake', (req, res) => {
  res.json({ 
    status: 'awake', 
    version: 'v3.0.0 (v20260102_1115PST)',
    symbols: state.filteredData.length,
    allSymbols: state.allSymbols.length
  });
});

// Main sync endpoint - RETURNS FILTERED DATA
app.get('/sync', (req, res) => {
  const { browserId, tf } = req.query;
  const now = Date.now();
  
  if (!browserId) {
    return res.status(400).json({ error: 'Missing browserId' });
  }
  
  // Update browser tracking
  browsers.set(browserId, { 
    lastSeen: now, 
    tf: tf || '5',
    isActive: true 
  });
  
  // Cleanup stale browsers
  for (const [id, data] of browsers) {
    if (now - data.lastSeen > 30000) browsers.delete(id);
  }
  
  // Check master status
  let isMaster = false;
  let justBecameMaster = false;
  
  if (!state.settingsMasterId || now - state.settingsMasterLastSeen > 15000) {
    if (state.settingsMasterId !== browserId) {
      state.settingsMasterId = browserId;
      justBecameMaster = true;
      console.log(`👑 New master: ${browserId.slice(-8)}`);
    }
    state.settingsMasterLastSeen = now;
    isMaster = true;
  } else if (browserId === state.settingsMasterId) {
    state.settingsMasterLastSeen = now;
    isMaster = true;
  }
  
  // Get current symbol from FILTERED data (not allSymbols!)
  const currentSymbol = state.filteredData[state.currentIndex] || null;
  
  // Browser list with TFs
  const browsersList = Array.from(browsers.entries()).map(([id, data]) => ({
    id: id.slice(-8),
    tf: data.tf,
    isMaster: id === state.settingsMasterId
  }));
  
  res.json({
    // Current rotation state - USE FILTERED DATA
    currentIndex: state.currentIndex,
    currentSymbol: currentSymbol,
    totalSymbols: state.filteredData.length,  // FILTERED count!
    allSymbols: state.filteredData,           // Send FILTERED, not all
    allSymbolsRaw: state.allSymbols.length,   // Raw count for info
    rotationsCount: state.rotationsCount,
    
    // Timing (master-controlled)
    rotateInterval: state.rotateInterval,
    fetchInterval: state.fetchInterval,
    colLInterval: state.colLInterval,
    intervalSummarySeconds: state.intervalSummarySeconds,
    timeToNextRotation: getTimeToNextRotation(),
    lastRotationTime: state.lastRotationTime,
    
    // Master-synced settings
    navigationMode: state.navigationMode,
    historyAutoClear: state.historyAutoClear,
    selectedFilters: state.selectedFilters,
    alertSettings: state.alertSettings,
    
    // Status
    isRotating: state.isRotating,
    isPaused: state.isPaused,
    
    // Browser info
    isMaster: isMaster,
    justBecameMaster: justBecameMaster,
    settingsMasterId: state.settingsMasterId?.slice(-8),
    browsersOnline: browsersList.length,
    browsersList: browsersList
  });
});

// Master claims / force claim
app.post('/claim-master', (req, res) => {
  const { browserId, force } = req.body;
  const now = Date.now();
  
  if (!browserId) {
    return res.status(400).json({ error: 'Missing browserId' });
  }
  
  if (force || !state.settingsMasterId || now - state.settingsMasterLastSeen > 15000) {
    state.settingsMasterId = browserId;
    state.settingsMasterLastSeen = now;
    console.log(`👑 Master ${force ? 'forced' : 'claimed'}: ${browserId.slice(-8)}`);
    res.json({ success: true, isMaster: true });
  } else if (browserId === state.settingsMasterId) {
    state.settingsMasterLastSeen = now;
    res.json({ success: true, isMaster: true });
  } else {
    res.json({ success: false, isMaster: false, currentMaster: state.settingsMasterId?.slice(-8) });
  }
});

// Settings update (master only)
app.post('/settings', (req, res) => {
  const { 
    browserId, 
    rotateInterval, 
    fetchInterval, 
    colLInterval,
    navigationMode,
    historyAutoClear,
    selectedFilters,
    alertSettings,
    intervalSummarySeconds,
    csvUrl: newCsvUrl 
  } = req.body;
  
  // Verify master
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  let changed = false;
  
  if (rotateInterval && rotateInterval !== state.rotateInterval) {
    state.rotateInterval = rotateInterval;
    restartRotationTimer();
    changed = true;
    console.log(`⏱️ Rotation interval: ${rotateInterval}s`);
  }
  
  if (fetchInterval && fetchInterval !== state.fetchInterval) {
    state.fetchInterval = fetchInterval;
    startCsvFetchTimer();
    changed = true;
    console.log(`📊 Fetch interval: ${fetchInterval}s`);
  }
  
  if (colLInterval && colLInterval !== state.colLInterval) {
    state.colLInterval = colLInterval;
    changed = true;
    console.log(`🔄 ColL interval: ${colLInterval}s`);
  }
  
  if (intervalSummarySeconds && intervalSummarySeconds !== state.intervalSummarySeconds) {
    state.intervalSummarySeconds = intervalSummarySeconds;
    changed = true;
    console.log(`⏱️ Interval summary: ${intervalSummarySeconds}s`);
  }
  
  if (navigationMode && navigationMode !== state.navigationMode) {
    state.navigationMode = navigationMode;
    changed = true;
    console.log(`🧭 Navigation mode: ${navigationMode}`);
  }
  
  if (historyAutoClear && historyAutoClear !== state.historyAutoClear) {
    state.historyAutoClear = historyAutoClear;
    changed = true;
    console.log(`📜 History auto-clear: ${historyAutoClear} days`);
  }
  
  // KEY: When filters change, reapply and reset index
  if (selectedFilters && JSON.stringify(selectedFilters) !== JSON.stringify(state.selectedFilters)) {
    state.selectedFilters = selectedFilters;
    applyFilters();  // Reapply filters!
    changed = true;
    console.log(`🏷️ Rating filters: ${selectedFilters.join(', ')} → ${state.filteredData.length} symbols`);
  }
  
  if (alertSettings) {
    state.alertSettings = alertSettings;
    changed = true;
    console.log(`📊 Thresholds/Cooldowns updated`);
  }
  
  if (newCsvUrl && newCsvUrl !== csvUrl) {
    csvUrl = newCsvUrl;
    changed = true;
    console.log(`📊 CSV URL updated`);
  }
  
  if (changed) {
    saveState();
  }
  
  res.json({ success: true, changed, filteredCount: state.filteredData.length });
});

// Pause/resume rotation (master only)
app.post('/pause', (req, res) => {
  const { browserId, paused } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  state.isPaused = paused;
  console.log(`⏸️ Rotation ${paused ? 'paused' : 'resumed'}`);
  res.json({ success: true, isPaused: state.isPaused });
});

// Start rotation (master only)
app.post('/start', (req, res) => {
  const { browserId } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  state.isRotating = true;
  state.isPaused = false;
  state.rotationStartTime = Date.now();
  restartRotationTimer();
  console.log(`🚀 Rotation started`);
  res.json({ success: true });
});

// Stop rotation (master only)
app.post('/stop', (req, res) => {
  const { browserId } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  state.isRotating = false;
  if (rotationTimer) clearInterval(rotationTimer);
  console.log(`⏹️ Rotation stopped`);
  res.json({ success: true });
});

// Navigate (master only)
app.post('/navigate', (req, res) => {
  const { browserId, direction, index } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  if (typeof index === 'number') {
    state.currentIndex = Math.max(0, Math.min(index, state.filteredData.length - 1));
  } else if (direction === 'next') {
    state.currentIndex++;
    if (state.currentIndex >= state.filteredData.length) state.currentIndex = 0;
  } else if (direction === 'prev') {
    state.currentIndex--;
    if (state.currentIndex < 0) state.currentIndex = state.filteredData.length - 1;
  }
  
  state.lastRotationTime = Date.now();
  const current = state.filteredData[state.currentIndex];
  console.log(`📍 Navigate: ${state.currentIndex + 1}/${state.filteredData.length} - ${current?.Symbol}`);
  
  res.json({ 
    success: true, 
    currentIndex: state.currentIndex, 
    currentSymbol: current 
  });
});

// Force CSV refresh
app.post('/refresh-csv', async (req, res) => {
  const result = await fetchCSV();
  res.json({ success: result, count: state.filteredData.length, allCount: state.allSymbols.length });
});

// Set CSV URL
app.post('/set-csv-url', (req, res) => {
  const { browserId, url } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  if (url) {
    csvUrl = url;
    saveState();
    console.log(`📊 CSV URL updated`);
    res.json({ success: true });
  } else {
    res.json({ success: false, reason: 'no url' });
  }
});

// ===========================
// INTERVAL SUMMARY SYSTEM
// ===========================
app.get('/signal', (req, res) => {
  // Get latest interval signal
  let latestId = null;
  let latestTime = 0;
  
  for (const [id, data] of intervalAlerts) {
    if (data.createdAt > latestTime) {
      latestTime = data.createdAt;
      latestId = id;
    }
  }
  
  // Get latest rotation signal
  let latestRotationId = null;
  let latestRotationTime = 0;
  
  for (const [id, data] of rotationAlerts) {
    if (data.createdAt > latestRotationTime) {
      latestRotationTime = data.createdAt;
      latestRotationId = id;
    }
  }
  
  res.json({
    intervalId: latestId,
    intervalTime: latestTime,
    rotationId: latestRotationId,
    rotationTime: latestRotationTime
  });
});

app.post('/interval-signal', (req, res) => {
  const intervalId = createIntervalSignal();
  console.log(`📢 Interval signal: ${intervalId}`);
  res.json({ success: true, intervalId });
});

// Create rotation signal (for master to trigger)
app.post('/rotation-signal', (req, res) => {
  const rotationId = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  rotationAlerts.set(rotationId, {
    createdAt: Date.now(),
    alerts: [],
    respondedBrowsers: new Set()
  });
  console.log(`📢 Rotation signal: ${rotationId}`);
  res.json({ success: true, rotationId });
});

app.post('/interval-alerts', (req, res) => {
  const { browserId, alerts, intervalId } = req.body;
  
  if (!intervalId || !intervalAlerts.has(intervalId)) {
    return res.json({ success: false, reason: 'invalid intervalId' });
  }
  
  const signal = intervalAlerts.get(intervalId);
  
  if (signal.respondedBrowsers.has(browserId)) {
    return res.json({ success: false, reason: 'already responded' });
  }
  
  signal.respondedBrowsers.add(browserId);
  signal.alerts.push(...(alerts || []));
  
  console.log(`📥 Browser ${browserId.slice(-8)} pushed ${alerts?.length || 0} alerts for interval ${intervalId.slice(0, 8)}`);
  
  res.json({ success: true });
});

app.get('/interval-alerts/:intervalId', (req, res) => {
  const { intervalId } = req.params;
  const signal = intervalAlerts.get(intervalId);
  
  if (!signal) {
    return res.json({ alerts: [], browserCount: 0 });
  }
  
  res.json({
    alerts: signal.alerts,
    browserCount: signal.respondedBrowsers.size
  });
});

// Rotation summary endpoints
app.post('/rotation-alerts', (req, res) => {
  const { browserId, alerts, rotationId } = req.body;
  
  if (!rotationId || !rotationAlerts.has(rotationId)) {
    return res.json({ success: false, reason: 'invalid rotationId' });
  }
  
  const signal = rotationAlerts.get(rotationId);
  
  if (signal.respondedBrowsers.has(browserId)) {
    return res.json({ success: false, reason: 'already responded' });
  }
  
  signal.respondedBrowsers.add(browserId);
  if (!signal.alerts) signal.alerts = [];
  signal.alerts.push(...(alerts || []));
  
  console.log(`📥 Browser ${browserId.slice(-8)} pushed ${alerts?.length || 0} rotation alerts`);
  
  res.json({ success: true });
});

app.get('/rotation-alerts/:rotationId', (req, res) => {
  const { rotationId } = req.params;
  const signal = rotationAlerts.get(rotationId);
  
  if (!signal) {
    return res.json({ alerts: [], browserCount: 0 });
  }
  
  res.json({
    alerts: signal.alerts || [],
    browserCount: signal.respondedBrowsers.size
  });
});

// ===========================
// STARTUP
// ===========================
app.listen(PORT, async () => {
  console.log(`🚀 TV Sync Server v3.0.0 starting on port ${PORT}`);
  
  // Load saved state
  loadState();
  
  // Fetch CSV if needed
  if (state.allSymbols.length === 0 || Date.now() - state.lastCsvFetch > 3600000) {
    await fetchCSV();
  }
  
  // Start timers
  restartRotationTimer();
  startCsvFetchTimer();
  
  console.log(`✅ Server ready - ${state.filteredData.length}/${state.allSymbols.length} symbols (${state.selectedFilters.join(', ')})`);
});
