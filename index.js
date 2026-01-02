const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===========================
// CONFIGURATION
// ===========================
const STATE_FILE = path.join(__dirname, 'server-state.json');
const BROWSER_TIMEOUT = 15000;      // 15s - browser considered disconnected
const MASTER_TIMEOUT = 15000;       // 15s - master considered gone, auto-transfer
const CSV_FETCH_INTERVAL = 120000;  // 120s default
const SIGNAL_TTL = 30000;           // 30s signal expiration

// Google Sheet CSV URL (can be updated by master)
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
  
  // Master-synced settings
  navigationMode: 'url',  // 'url' or 'typing'
  historyAutoClear: 7,    // days
  
  // Rating filters (synced from master)
  selectedFilters: ['Comfortable'],
  
  // Thresholds and Cooldowns (synced from master)
  alertSettings: {
    threshold_1c: 2, threshold_2c: 2,
    threshold_1_minus: 20, threshold_2_minus: 20,
    cooldown_1x: 15, cooldown_1c: 15, cooldown_1_plus: 15, cooldown_1_minus: 15,
    cooldown_2x: 15, cooldown_2c: 15, cooldown_2_plus: 15, cooldown_2_minus: 15
  },
  
  // These are NOT synced (independent per browser)
  // alertConditionSettings, alertTimeframeSettings, screenshotSettings
  
  // Symbol data (from CSV)
  allSymbols: [],         // Raw CSV data
  filteredData: [],       // After applying filters
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
let intervalAlerts = {};
let rotationAlerts = {};
let currentIntervalId = null;
let currentRotationId = null;
let intervalSignalTime = 0;
let rotationSignalTime = 0;

// Rotation timer reference
let rotationTimer = null;
let csvFetchTimer = null;

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
    console.log(`💾 State saved (index: ${state.currentIndex})`);
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
      state.navigationMode = data.navigationMode || 'url';
      state.historyAutoClear = data.historyAutoClear || 7;
      if (data.selectedFilters) state.selectedFilters = data.selectedFilters;
      if (data.alertSettings) state.alertSettings = data.alertSettings;
      state.allSymbols = data.allSymbols || [];
      state.lastCsvFetch = data.lastCsvFetch || 0;
      if (data.csvUrl) csvUrl = data.csvUrl;
      
      console.log(`📂 State loaded (index: ${state.currentIndex}, symbols: ${state.allSymbols.length})`);
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
    
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',');
    
    const data = lines.slice(1).map(line => {
      const values = line.split(',');
      const obj = {};
      headers.forEach((h, i) => {
        obj[h.trim()] = values[i]?.trim() || '';
      });
      return obj;
    });
    
    state.allSymbols = data;
    state.lastCsvFetch = Date.now();
    
    // Get unique ratings for reference
    const ratings = [...new Set(data.map(item => item['Rating']))];
    console.log(`✅ CSV: ${data.length} symbols, ratings: ${ratings.join(', ')}`);
    
    // Preserve position if possible
    if (state.currentIndex >= data.length) {
      state.currentIndex = 0;
    }
    
    saveState();
    return true;
  } catch (e) {
    console.error('❌ CSV fetch failed:', e.message);
    return false;
  }
}

function startCsvFetchTimer() {
  if (csvFetchTimer) clearInterval(csvFetchTimer);
  
  csvFetchTimer = setInterval(() => {
    fetchCSV();
  }, state.fetchInterval * 1000);
  
  console.log(`📊 CSV fetch timer: every ${state.fetchInterval}s`);
}

// ===========================
// ROTATION
// ===========================
function rotate() {
  if (state.isPaused || state.allSymbols.length === 0) return;
  if (browsers.size === 0) {
    console.log('⏸️ No browsers connected, skipping rotation');
    return;
  }
  
  const previousIndex = state.currentIndex;
  state.currentIndex = (state.currentIndex + 1) % state.allSymbols.length;
  state.rotationsCount++;
  state.lastRotationTime = Date.now();
  
  const symbol = state.allSymbols[state.currentIndex];
  console.log(`🔄 Rotated to ${symbol?.Symbol} (${state.currentIndex + 1}/${state.allSymbols.length})`);
  
  // Rotation cycle complete
  if (state.currentIndex === 0 && previousIndex > 0) {
    console.log('🔄 Rotation cycle complete');
    state.rotationStartTime = Date.now();
  }
  
  // Save state periodically (every 10 rotations)
  if (state.rotationsCount % 10 === 0) {
    saveState();
  }
}

function startRotationTimer() {
  if (rotationTimer) clearInterval(rotationTimer);
  
  state.isRotating = true;
  state.lastRotationTime = Date.now();
  
  rotationTimer = setInterval(() => {
    rotate();
  }, state.rotateInterval * 1000);
  
  console.log(`⏱️ Rotation timer: every ${state.rotateInterval}s`);
}

function stopRotationTimer() {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  state.isRotating = false;
  console.log('⏱️ Rotation timer stopped');
}

function restartRotationTimer() {
  stopRotationTimer();
  startRotationTimer();
}

// ===========================
// BROWSER TRACKING
// ===========================
function cleanupBrowsers() {
  const now = Date.now();
  const expired = [];
  
  browsers.forEach((browser, id) => {
    if (now - browser.lastSeen > BROWSER_TIMEOUT) {
      expired.push(id);
    }
  });
  
  expired.forEach(id => {
    console.log(`🧹 Browser disconnected: ${id.slice(-8)}`);
    browsers.delete(id);
  });
  
  // Check if master timed out
  if (state.settingsMasterId) {
    const masterBrowser = browsers.get(state.settingsMasterId);
    if (!masterBrowser || now - state.settingsMasterLastSeen > MASTER_TIMEOUT) {
      console.log(`👑 Master timed out: ${state.settingsMasterId?.slice(-8)}`);
      state.settingsMasterId = null;
      state.settingsMasterLastSeen = 0;
      
      // Auto-transfer to first available browser
      if (browsers.size > 0) {
        const firstBrowser = browsers.keys().next().value;
        state.settingsMasterId = firstBrowser;
        state.settingsMasterLastSeen = now;
        
        // Set justBecameMaster flag for toast notification
        const browser = browsers.get(firstBrowser);
        if (browser) browser.justBecameMaster = true;
        
        console.log(`👑 Auto-transferred master to: ${firstBrowser.slice(-8)}`);
      }
    }
  }
  
  return expired.length;
}

function getBrowsersList() {
  const now = Date.now();
  const list = [];
  
  browsers.forEach((browser, id) => {
    const age = now - browser.lastSeen;
    list.push({
      browserId: id,
      shortId: id.slice(-8),
      tf: browser.tf || '?',
      isMaster: id === state.settingsMasterId,
      status: age < 5000 ? 'online' : age < BROWSER_TIMEOUT ? 'stale' : 'offline',
      lastSeen: age < 3000 ? 'now' : `${Math.floor(age / 1000)}s ago`
    });
  });
  
  // Sort: master first
  list.sort((a, b) => {
    if (a.isMaster) return -1;
    if (b.isMaster) return 1;
    return 0;
  });
  
  return list;
}

// ===========================
// HELPERS
// ===========================
function generateSignalId() {
  return `${Date.now() % 10}_${Math.random().toString(36).substr(2, 6)}`;
}

function getCurrentSymbol() {
  if (state.allSymbols.length === 0) return null;
  return state.allSymbols[state.currentIndex] || null;
}

function getTimeToNextRotation() {
  if (!state.isRotating || state.isPaused) return 0;
  const elapsed = Date.now() - state.lastRotationTime;
  const remaining = (state.rotateInterval * 1000) - elapsed;
  return Math.max(0, remaining);
}

// ===========================
// ROUTES
// ===========================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '3.0.0',
    browsers: browsers.size,
    isRotating: state.isRotating,
    currentIndex: state.currentIndex,
    totalSymbols: state.allSymbols.length
  });
});

// Main sync endpoint - browsers poll this
app.get('/sync', (req, res) => {
  const { browserId, tf } = req.query;
  const now = Date.now();
  
  // Register/update browser
  if (browserId) {
    const isNew = !browsers.has(browserId);
    browsers.set(browserId, { lastSeen: now, tf: tf || '?' });
    
    if (isNew) {
      console.log(`🌐 Browser connected: ${browserId.slice(-8)} (${tf || '?'})`);
      
      // First browser becomes master
      if (!state.settingsMasterId) {
        state.settingsMasterId = browserId;
        state.settingsMasterLastSeen = now;
        
        // Set justBecameMaster flag
        browsers.get(browserId).justBecameMaster = true;
        
        console.log(`👑 First browser is master: ${browserId.slice(-8)}`);
      }
    }
    
    // Update master last seen
    if (browserId === state.settingsMasterId) {
      state.settingsMasterLastSeen = now;
    }
  }
  
  cleanupBrowsers();
  
  const currentSymbol = getCurrentSymbol();
  const browsersList = getBrowsersList();
  const isMaster = browserId === state.settingsMasterId;
  
  // Check if this browser just became master (for toast notification)
  const justBecameMaster = isMaster && browsers.get(browserId)?.justBecameMaster;
  if (justBecameMaster) {
    browsers.get(browserId).justBecameMaster = false;
  }
  
  res.json({
    // Current rotation state
    currentIndex: state.currentIndex,
    currentSymbol: currentSymbol,
    totalSymbols: state.allSymbols.length,
    allSymbols: state.allSymbols,
    rotationsCount: state.rotationsCount,
    
    // Timing (master-controlled)
    rotateInterval: state.rotateInterval,
    fetchInterval: state.fetchInterval,
    colLInterval: state.colLInterval,
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
    return res.json({ success: false, reason: 'no browserId' });
  }
  
  // Register browser if not exists
  if (!browsers.has(browserId)) {
    browsers.set(browserId, { lastSeen: now, tf: '?' });
  }
  
  const currentMaster = state.settingsMasterId;
  const currentMasterExists = currentMaster && browsers.has(currentMaster);
  
  let allowed = false;
  let reason = '';
  
  if (force) {
    allowed = true;
    reason = 'force claim';
  } else if (!currentMaster) {
    allowed = true;
    reason = 'no current master';
  } else if (!currentMasterExists) {
    allowed = true;
    reason = 'master disconnected';
  }
  
  if (allowed) {
    const previousMaster = state.settingsMasterId;
    state.settingsMasterId = browserId;
    state.settingsMasterLastSeen = now;
    
    // Mark for toast notification
    const browser = browsers.get(browserId);
    if (browser) browser.justBecameMaster = true;
    
    console.log(`👑 Master claimed: ${browserId.slice(-8)} (${reason})`);
    if (previousMaster && previousMaster !== browserId) {
      console.log(`   Previous: ${previousMaster.slice(-8)}`);
    }
    
    res.json({ 
      success: true, 
      isMaster: true,
      reason: reason
    });
  } else {
    res.json({ 
      success: false, 
      isMaster: false,
      reason: 'master still active',
      currentMaster: currentMaster?.slice(-8)
    });
  }
});

// Update settings (master only)
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
  
  if (selectedFilters) {
    state.selectedFilters = selectedFilters;
    changed = true;
    console.log(`🏷️ Rating filters updated: ${selectedFilters.join(', ')}`);
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
  
  res.json({ success: true, changed });
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

// Manual navigation (master only)
app.post('/navigate', (req, res) => {
  const { browserId, direction } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  if (state.allSymbols.length === 0) {
    return res.json({ success: false, reason: 'no symbols' });
  }
  
  if (direction === 'next') {
    state.currentIndex = (state.currentIndex + 1) % state.allSymbols.length;
  } else if (direction === 'prev') {
    state.currentIndex = state.currentIndex > 0 ? state.currentIndex - 1 : state.allSymbols.length - 1;
  }
  
  state.lastRotationTime = Date.now();
  
  const symbol = getCurrentSymbol();
  console.log(`🔀 Manual: ${symbol?.Symbol} (${state.currentIndex + 1}/${state.allSymbols.length})`);
  
  res.json({ 
    success: true, 
    currentIndex: state.currentIndex,
    currentSymbol: symbol
  });
});

// Trigger CSV refresh (master only)
app.post('/refresh-csv', (req, res) => {
  const { browserId } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  fetchCSV().then(success => {
    res.json({ success, totalSymbols: state.allSymbols.length });
  });
});

// ===========================
// SIGNAL ENDPOINTS (for alert collection)
// ===========================

app.post('/signal-interval', (req, res) => {
  const { browserId } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  currentIntervalId = generateSignalId();
  intervalSignalTime = Date.now();
  intervalAlerts = {};
  
  console.log(`📢 Interval signal: ${currentIntervalId}`);
  res.json({ success: true, intervalId: currentIntervalId });
});

app.get('/signal-interval', (req, res) => {
  if (Date.now() - intervalSignalTime > SIGNAL_TTL) {
    return res.json({ intervalId: null, expired: true });
  }
  res.json({ intervalId: currentIntervalId, age: Date.now() - intervalSignalTime });
});

app.post('/signal-rotation', (req, res) => {
  const { browserId } = req.body;
  
  if (browserId !== state.settingsMasterId) {
    return res.json({ success: false, reason: 'not master' });
  }
  
  currentRotationId = generateSignalId();
  rotationSignalTime = Date.now();
  rotationAlerts = {};
  
  console.log(`📢 Rotation signal: ${currentRotationId}`);
  res.json({ success: true, rotationId: currentRotationId });
});

app.get('/signal-rotation', (req, res) => {
  if (Date.now() - rotationSignalTime > SIGNAL_TTL) {
    return res.json({ rotationId: null, expired: true });
  }
  res.json({ rotationId: currentRotationId, age: Date.now() - rotationSignalTime });
});

// ===========================
// ALERT COLLECTION
// ===========================

app.post('/interval-alerts', (req, res) => {
  const { browserId, alerts, tf, intervalId } = req.body;
  
  if (intervalId !== currentIntervalId) {
    return res.json({ success: false, reason: 'stale signal' });
  }
  
  intervalAlerts[browserId] = { alerts, tf, timestamp: Date.now() };
  console.log(`📥 Interval from ${browserId.slice(-8)} (${tf}): ${countAlerts(alerts)}`);
  res.json({ success: true });
});

app.get('/interval-alerts', (req, res) => {
  const { clear } = req.query;
  const combined = combineAlerts(intervalAlerts);
  if (clear === 'true') intervalAlerts = {};
  res.json(combined);
});

app.post('/rotation-alerts', (req, res) => {
  const { browserId, alerts, tf, rotationId, totalSymbols, duration } = req.body;
  
  if (rotationId !== currentRotationId) {
    return res.json({ success: false, reason: 'stale signal' });
  }
  
  rotationAlerts[browserId] = { alerts, tf, totalSymbols, duration, timestamp: Date.now() };
  console.log(`📥 Rotation from ${browserId.slice(-8)} (${tf}): ${countAlerts(alerts)}`);
  res.json({ success: true });
});

app.get('/rotation-alerts', (req, res) => {
  const { clear } = req.query;
  const combined = combineAlerts(rotationAlerts, true);
  if (clear === 'true') rotationAlerts = {};
  res.json(combined);
});

function combineAlerts(alertsMap, includeMetadata = false) {
  const conditions = ['1x', '1c', '1-+', '1-', '2x', '2c', '2-+', '2-'];
  const combined = {};
  conditions.forEach(c => combined[c] = []);
  
  let totalAlerts = 0;
  let sources = 0;
  let totalSymbols = 0;
  let duration = '0m 0s';
  
  Object.entries(alertsMap).forEach(([bid, data]) => {
    sources++;
    if (data.totalSymbols) totalSymbols = Math.max(totalSymbols, data.totalSymbols);
    if (data.duration) duration = data.duration;
    
    conditions.forEach(c => {
      if (data.alerts?.[c]?.length > 0) {
        combined[c].push(...data.alerts[c]);
        totalAlerts += data.alerts[c].length;
      }
    });
  });
  
  const result = { success: true, alerts: combined, totalAlerts, sources };
  if (includeMetadata) {
    result.totalSymbols = totalSymbols;
    result.duration = duration;
  }
  return result;
}

function countAlerts(alerts) {
  if (!alerts) return 0;
  return Object.values(alerts).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
}

// Reset server (for debugging)
app.post('/reset', (req, res) => {
  state.currentIndex = 0;
  state.rotationsCount = 0;
  state.settingsMasterId = null;
  state.settingsMasterLastSeen = 0;
  browsers.clear();
  intervalAlerts = {};
  rotationAlerts = {};
  saveState();
  console.log('🔄 Server reset');
  res.json({ success: true });
});

// ===========================
// START SERVER
// ===========================
const PORT = process.env.PORT || 3000;

// Load saved state
loadState();

// Initial CSV fetch if needed
if (state.allSymbols.length === 0 || Date.now() - state.lastCsvFetch > 300000) {
  fetchCSV();
}

// Start timers
startRotationTimer();
startCsvFetchTimer();

app.listen(PORT, () => {
  console.log(`🚀 TV Sync Server v3.0.0 on port ${PORT}`);
  console.log(`   Rotation: ${state.rotateInterval}s | Fetch: ${state.fetchInterval}s`);
  console.log(`   Symbols: ${state.allSymbols.length} | Index: ${state.currentIndex}`);
});
