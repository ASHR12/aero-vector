// Main Application Orchestrator for Live ADS-B Aviation Radar
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🛫 Initializing AeroVector Live Flight Radar...');

  // 1. Initialize Map and Layers
  const map = new AviationMap('map-container');
  await map.loadGeoData();

  const flightLayer = new FlightLayer(map);
  const spaceLayer = new SpaceLayer(map);
  const telemetryHUD = new TelemetryHUD(flightLayer, map);
  const filterManager = new FilterManager(map, flightLayer);

  let currentDomainMode = 'flights'; // 'flights' | 'space' | 'all'
  let spaceOverviewData = null;

  async function pollSpaceOverview() {
    try {
      const res = await fetch('/api/space/overview');
      if (res.ok) {
        spaceOverviewData = await res.json();
        spaceLayer.setData(spaceOverviewData);

        if (currentDomainMode === 'space') {
          updateSpaceMetrics();
        }
      }
    } catch (e) {}
  }

  function updateSpaceMetrics() {
    if (!spaceOverviewData) return;
    const launchesCount = spaceOverviewData.totalUpcomingLaunches || 0;
    const spaceportsCount = spaceOverviewData.spaceportsCount || 0;
    const nextL = spaceOverviewData.nextLaunch;

    if (elTotalGlobal) elTotalGlobal.textContent = `${launchesCount} Launches`;
    if (elVisibleCount) elVisibleCount.textContent = `${spaceportsCount} Sites`;
    if (elAirborne) elAirborne.textContent = '1 IN ORBIT (ISS)';

    const labelPrimary = document.getElementById('label-stat-primary');
    const labelSecondary = document.getElementById('label-stat-secondary');
    const labelTertiary = document.getElementById('label-stat-tertiary');

    if (labelPrimary) labelPrimary.textContent = 'LAUNCHES';
    if (labelSecondary) labelSecondary.textContent = 'SPACEPORTS';
    if (labelTertiary) labelTertiary.textContent = 'ORBIT';

    if (nextL && nextL.net_ts) {
      const diff = nextL.net_ts - Math.floor(Date.now() / 1000);
      if (diff > 0 && elCountdown) {
        const hrs = Math.floor(diff / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        elCountdown.textContent = hrs > 48 ? `${Math.round(hrs / 24)}d` : `${hrs}h ${mins}m`;
      }
    }
  }

  // Poll space telemetry every 5s for smooth ISS orbit
  pollSpaceOverview();
  setInterval(pollSpaceOverview, 5000);

  // 2. Setup UTC Zulu Clock & Timers
  const elUtcClock = document.getElementById('utc-clock');
  const elLocalClock = document.getElementById('local-clock');
  const elCountdown = document.getElementById('next-poll-countdown');
  const elCountdownRing = document.getElementById('poll-countdown-ring');
  const elTotalGlobal = document.getElementById('stat-total-global');
  const elVisibleCount = document.getElementById('stat-visible-count');
  const elAirborne = document.getElementById('stat-airborne');
  const elAvgAlt = document.getElementById('stat-avg-alt');
  const elAvgSpd = document.getElementById('stat-avg-spd');
  const elEmergencyBanner = document.getElementById('emergency-banner');

  function updateClocks() {
    const now = new Date();
    
    // UTC Zulu Time
    const utcHours = String(now.getUTCHours()).padStart(2, '0');
    const utcMins = String(now.getUTCMinutes()).padStart(2, '0');
    const utcSecs = String(now.getUTCSeconds()).padStart(2, '0');
    if (elUtcClock) elUtcClock.textContent = `${utcHours}:${utcMins}:${utcSecs} UTC`;

    // Local Time
    const locHours = String(now.getHours()).padStart(2, '0');
    const locMins = String(now.getMinutes()).padStart(2, '0');
    const locSecs = String(now.getSeconds()).padStart(2, '0');
    if (elLocalClock) elLocalClock.textContent = `${locHours}:${locMins}:${locSecs} LOCAL`;
  }
  setInterval(updateClocks, 1000);
  updateClocks();

  // 3. Setup UI Controls
  // Map Mode Toggle (3D Globe vs 2D World Map)
  const btnModeGlobe = document.getElementById('btn-mode-globe');
  const btnMode2D = document.getElementById('btn-mode-2d');

  if (btnModeGlobe && btnMode2D) {
    btnModeGlobe.addEventListener('click', () => {
      map.setMode('globe');
      btnModeGlobe.classList.add('active');
      btnMode2D.classList.remove('active');
      if (window.aviationAudio) window.aviationAudio.playChirp(750, 0.04, 0.05);
    });

    btnMode2D.addEventListener('click', () => {
      map.setMode('2d');
      btnMode2D.classList.add('active');
      btnModeGlobe.classList.remove('active');
      if (window.aviationAudio) window.aviationAudio.playChirp(750, 0.04, 0.05);
    });
  }

  // Heatmap Density Toggle
  const btnToggleHeatmap = document.getElementById('btn-toggle-heatmap');
  if (btnToggleHeatmap) {
    btnToggleHeatmap.addEventListener('click', () => {
      flightLayer.showHeatmap = !flightLayer.showHeatmap;
      btnToggleHeatmap.classList.toggle('active', flightLayer.showHeatmap);
      if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.03, 0.04);
    });
  }

  // Day/Night Terminator Toggle
  const btnToggleNight = document.getElementById('btn-toggle-night');
  if (btnToggleNight) {
    btnToggleNight.addEventListener('click', () => {
      map.showNight = !map.showNight;
      btnToggleNight.classList.toggle('active', map.showNight);
      if (window.aviationAudio) window.aviationAudio.playChirp(650, 0.03, 0.04);
    });
  }

  // Graticule Toggle
  const btnToggleGraticule = document.getElementById('btn-toggle-graticule');
  if (btnToggleGraticule) {
    btnToggleGraticule.addEventListener('click', () => {
      map.showGraticule = !map.showGraticule;
      btnToggleGraticule.classList.toggle('active', map.showGraticule);
    });
  }

  // Auto-Rotate / Radar Orbit Toggle
  const btnAutoRotate = document.getElementById('btn-auto-rotate');
  if (btnAutoRotate) {
    btnAutoRotate.addEventListener('click', () => {
      map.autoRotate = !map.autoRotate;
      btnAutoRotate.classList.toggle('active', map.autoRotate);
      if (window.aviationAudio) window.aviationAudio.playChirp(800, 0.04, 0.05);
    });
  }

  // Audio Toggle
  const btnToggleAudio = document.getElementById('btn-toggle-audio');
  const audioIcon = document.getElementById('audio-icon');
  if (btnToggleAudio) {
    btnToggleAudio.addEventListener('click', () => {
      const enabled = window.aviationAudio.toggle();
      btnToggleAudio.classList.toggle('active', enabled);
      if (audioIcon) {
        audioIcon.textContent = enabled ? '🔊' : '🔇';
      }
    });
  }

  // Info & Legend Modal
  const btnInfo = document.getElementById('btn-info');
  const btnCloseInfo = document.getElementById('btn-close-info');
  const infoModal = document.getElementById('info-modal');

  if (btnInfo && infoModal) {
    btnInfo.addEventListener('click', () => {
      infoModal.classList.add('open');
      if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.04, 0.05);
    });
  }

  if (btnCloseInfo && infoModal) {
    btnCloseInfo.addEventListener('click', () => {
      infoModal.classList.remove('open');
    });
  }

  if (infoModal) {
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) {
        infoModal.classList.remove('open');
      }
    });
  }

  // Reset Camera View
  const btnResetView = document.getElementById('btn-reset-view');
  if (btnResetView) {
    btnResetView.addEventListener('click', () => {
      map.flyTo(0, 20, map.baseScale);
      if (window.aviationAudio) window.aviationAudio.playChirp(600, 0.04, 0.05);
    });
  }

  // Zoom In / Out Buttons
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      map.scale = Math.min(map.maxScale, map.scale * 1.35);
      map.updateProjection();
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      map.scale = Math.max(map.minScale, map.scale * 0.74);
      map.updateProjection();
    });
  }

  // 4. API Event Bindings
  const elFeedBadge = document.getElementById('feed-status-badge') || document.querySelector('.live-badge');
  window.flightAPI.on('flights', (data) => {
    flightLayer.setFlights(data.flights);
    if (elTotalGlobal) {
      elTotalGlobal.textContent = data.totalGlobal ? data.totalGlobal.toLocaleString() : data.count.toLocaleString();
    }

    if (elFeedBadge) {
      if (data.feedStatus === 'LIVE_AUTHENTICATED') {
        elFeedBadge.className = 'live-badge';
        elFeedBadge.innerHTML = '<span class="pulse-dot"></span><span>LIVE</span>';
        elFeedBadge.title = 'Active OpenSky Network Authenticated Live Feed';
      } else if (data.feedStatus === 'RATE_LIMITED_FALLBACK' || data.feedStatus === 'SNAPSHOT_FALLBACK') {
        elFeedBadge.className = 'live-badge degraded-snapshot';
        elFeedBadge.innerHTML = '<span class="pulse-dot warning"></span><span>SNAPSHOT (429 Rate Limit)</span>';
        elFeedBadge.title = 'OpenSky API quota limit reached (429). Displaying radar snapshot until upstream quota resets.';
      } else if (data.feedStatus === 'ACQUIRING_RADAR') {
        elFeedBadge.className = 'live-badge degraded-rate-limit';
        elFeedBadge.innerHTML = '<span class="pulse-dot warning"></span><span>CONNECTING RADAR...</span>';
        elFeedBadge.title = 'Acquiring live OpenSky airspace radar feed...';
      } else {
        elFeedBadge.className = 'live-badge degraded-snapshot';
        elFeedBadge.innerHTML = '<span class="pulse-dot snapshot"></span><span>RADAR HOLD</span>';
        elFeedBadge.title = 'Radar stream holding state';
      }
    }
  });

  window.flightAPI.on('airports', (airports) => {
    map.setAirports(airports);
  });

  window.flightAPI.on('stats', (stats) => {
    if (elAirborne && stats.airborne !== undefined) {
      elAirborne.textContent = `${stats.airborne.toLocaleString()} AIRBORNE`;
    }
    if (elAvgAlt && stats.avgAltitudeFt !== undefined) {
      elAvgAlt.textContent = `${stats.avgAltitudeFt.toLocaleString()} FT`;
    }
    if (elAvgSpd && stats.avgSpeedKts !== undefined) {
      elAvgSpd.textContent = `${stats.avgSpeedKts.toLocaleString()} KTS`;
    }

    // Emergency squawks check (7700 / 7600)
    if (stats.emergencySquawks && stats.emergencySquawks.length > 0 && !window.dismissedEmergency) {
      const em = stats.emergencySquawks[0];
      if (elEmergencyBanner) {
        elEmergencyBanner.innerHTML = `
          <div class="emergency-alert-pill">
            <span class="emergency-beacon"></span>
            <span><strong>SQUAWK ${em.squawk}:</strong> ${em.callsign || em.hex.toUpperCase()} (${em.info.desc})</span>
            <button id="btn-focus-emergency" class="btn-focus-emergency">⚡ Focus</button>
            <button id="btn-dismiss-emergency" class="btn-dismiss-emergency" title="Dismiss">✕</button>
          </div>
        `;
        elEmergencyBanner.style.display = 'block';

        const btnFocus = document.getElementById('btn-focus-emergency');
        if (btnFocus) {
          btnFocus.onclick = () => {
            const f = flightLayer.flights.find(x => x.hex === em.hex);
            if (f) {
              window.dispatchEvent(new CustomEvent('flight-selected', { detail: f }));
            }
          };
        }

        const btnDismiss = document.getElementById('btn-dismiss-emergency');
        if (btnDismiss) {
          btnDismiss.onclick = () => {
            window.dismissedEmergency = true;
            elEmergencyBanner.style.display = 'none';
          };
        }
      }
    } else if (elEmergencyBanner) {
      elEmergencyBanner.style.display = 'none';
    }
  });

  // 5. SQLite Cache Inspector Modal Controller
  const btnCacheModal = document.getElementById('btn-cache-modal');
  const cacheModal = document.getElementById('cache-modal');
  const btnCloseCache = document.getElementById('btn-close-cache');
  const cacheSearchInput = document.getElementById('cache-search-input');
  const btnRefreshCache = document.getElementById('btn-refresh-cache');
  const btnClearCacheDb = document.getElementById('btn-clear-cache-db');
  const cacheBadgeCount = document.getElementById('cache-badge-count');
  const elStatTotal = document.getElementById('cache-stat-total');
  const elStatActive = document.getElementById('cache-stat-active');
  const elStatExpired = document.getElementById('cache-stat-expired');
  const elStatSaved = document.getElementById('cache-stat-saved');
  const elCacheTableBody = document.getElementById('cache-table-body');

  async function loadCacheData(search = '') {
    if (!elCacheTableBody) return;
    try {
      const url = `/api/cache/routes?limit=100&search=${encodeURIComponent(search)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (cacheBadgeCount) cacheBadgeCount.textContent = data.totalCached || 0;
      if (elStatTotal) elStatTotal.textContent = data.totalCached || 0;
      if (elStatActive) elStatActive.textContent = data.activeFresh || 0;
      if (elStatExpired) elStatExpired.textContent = data.expiredStale || 0;
      if (elStatSaved) elStatSaved.textContent = data.quotaEstimatedSaved || 0;

      if (!data.flights || data.flights.length === 0) {
        elCacheTableBody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--text-dim); padding: 32px;">
              ${search ? `No cached flights matching "${search}"` : 'No flights cached yet. Click any aircraft on radar to inspect.'}
            </td>
          </tr>
        `;
        return;
      }

      elCacheTableBody.innerHTML = data.flights.map(f => {
        const isFresh = !f.staleness.isStale;
        const badgeClass = isFresh ? 'fresh' : 'stale';
        const badgeText = isFresh ? '🟢 ACTIVE (Fresh)' : '🟡 EXPIRED (Stale)';
        const scheduleStr = (f.route.dep_time || f.route.arr_time) 
          ? `DEP: ${f.route.dep_time || '--'} | ARR: ${f.route.arr_time || '--'}`
          : 'Airborne Telemetry Tracked';

        return `
          <tr class="cache-row-item">
            <td>
              <div class="cache-flight-badge">${f.flight_iata || f.flight_id}</div>
              <div style="font-size: 0.68rem; color: var(--text-dim); font-family: var(--font-mono);">${f.hex || ''} · ${f.flight_icao || ''}</div>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text-pure);">${f.airline || 'Commercial Operator'}</div>
              <div style="font-size: 0.7rem; color: var(--accent-cyan); font-family: var(--font-mono);">${f.aircraft.model || f.aircraft.icao || 'Aircraft'} ${f.aircraft.registration ? `(${f.aircraft.registration})` : ''}</div>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--accent-emerald);">${f.route.origin}</div>
              <div style="font-size: 0.72rem; color: var(--accent-cyan); margin-top: 2px;">➔ ${f.route.destination}</div>
            </td>
            <td>
              <div style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-pure);">${scheduleStr}</div>
              <div style="font-size: 0.68rem; color: var(--text-dim);">Duration: ${f.route.duration}</div>
            </td>
            <td>
              <span class="cache-status-badge ${badgeClass}" title="${f.staleness.reason}">${badgeText}</span>
              <div style="font-size: 0.65rem; color: var(--text-dim); margin-top: 3px;">${f.staleness.reason}</div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      console.warn('Failed to load cache inspector:', e);
      if (elCacheTableBody) {
        elCacheTableBody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--accent-rose); padding: 24px;">
              Error connecting to SQLite database: ${e.message}
            </td>
          </tr>
        `;
      }
    }
  }

  // Initial badge update
  loadCacheData();

  if (btnCacheModal && cacheModal) {
    btnCacheModal.addEventListener('click', () => {
      cacheModal.classList.add('open');
      loadCacheData(cacheSearchInput ? cacheSearchInput.value : '');
      if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.03, 0.04);
    });
  }

  if (btnCloseCache && cacheModal) {
    btnCloseCache.addEventListener('click', () => {
      cacheModal.classList.remove('open');
    });
  }

  if (btnRefreshCache) {
    btnRefreshCache.addEventListener('click', () => {
      loadCacheData(cacheSearchInput ? cacheSearchInput.value : '');
      if (window.aviationAudio) window.aviationAudio.playChirp(800, 0.03, 0.04);
    });
  }

  if (btnClearCacheDb) {
    btnClearCacheDb.addEventListener('click', async () => {
      if (confirm('Clear all cached flight routes from the local SQLite database?')) {
        try {
          const res = await fetch('/api/cache/clear', { method: 'POST' });
          if (res.ok) {
            await loadCacheData();
            if (window.aviationAudio) window.aviationAudio.playChirp(600, 0.05, 0.06);
          }
        } catch (e) {
          alert('Failed to clear cache: ' + e.message);
        }
      }
    });
  }

  if (cacheSearchInput) {
    let debounceTimer = null;
    cacheSearchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadCacheData(e.target.value);
      }, 250);
    });
  }

  window.flightAPI.on('countdown', (seconds) => {
    if (elCountdown) elCountdown.textContent = `${seconds}s`;
    if (elCountdownRing) {
      const pct = (seconds / 9) * 100;
      elCountdownRing.style.strokeDashoffset = 100 - pct;
    }
  });

  window.addEventListener('visible-count-update', (e) => {
    if (elVisibleCount) {
      elVisibleCount.textContent = e.detail.visible.toLocaleString();
    }
  });

  window.addEventListener('cache-updated', () => {
    loadCacheData(cacheSearchInput ? cacheSearchInput.value : '');
  });

  // 5. Space Mode Tabs & Quick Chips Toolbar Listeners
  const tabFlights = document.getElementById('tab-mode-flights');
  const tabSpace = document.getElementById('tab-mode-space');
  const tabAll = document.getElementById('tab-mode-all');
  const navAirlineChips = document.getElementById('airline-chips');
  const navSpaceChips = document.getElementById('space-chips');

  function setDomainMode(mode) {
    currentDomainMode = mode;
    spaceLayer.setMode(mode);

    if (tabFlights) tabFlights.classList.toggle('active', mode === 'flights');
    if (tabSpace) tabSpace.classList.toggle('active', mode === 'space');
    if (tabAll) tabAll.classList.toggle('active', mode === 'all');

    if (mode === 'space') {
      if (navAirlineChips) navAirlineChips.style.display = 'none';
      if (navSpaceChips) navSpaceChips.style.display = 'flex';
      updateSpaceMetrics();
    } else if (mode === 'flights') {
      if (navAirlineChips) navAirlineChips.style.display = 'flex';
      if (navSpaceChips) navSpaceChips.style.display = 'none';
      
      const labelPrimary = document.getElementById('label-stat-primary');
      const labelSecondary = document.getElementById('label-stat-secondary');
      const labelTertiary = document.getElementById('label-stat-tertiary');
      if (labelPrimary) labelPrimary.textContent = 'TRACKED';
      if (labelSecondary) labelSecondary.textContent = 'IN VIEW';
      if (labelTertiary) labelTertiary.textContent = 'AIRBORNE';
    } else { // 'all'
      if (navAirlineChips) navAirlineChips.style.display = 'flex';
      if (navSpaceChips) navSpaceChips.style.display = 'flex';
    }

    if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.04, 0.05);
  }

  if (tabFlights) tabFlights.addEventListener('click', () => setDomainMode('flights'));
  if (tabSpace) tabSpace.addEventListener('click', () => setDomainMode('space'));
  if (tabAll) tabAll.addEventListener('click', () => setDomainMode('all'));

  // Space Quick Chips Toolbar
  if (navSpaceChips) {
    navSpaceChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.airline-chip');
      if (!chip) return;

      navSpaceChips.querySelectorAll('.airline-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      const agency = chip.dataset.agency || 'all';
      if (agency === 'ISS' && spaceOverviewData && spaceOverviewData.iss) {
        const iss = spaceOverviewData.iss;
        map.flyTo(iss.lon, iss.lat, Math.min(map.width, map.height) * 0.7);
        telemetryHUD.showSpaceDetails({ ...iss, type: 'iss' });
      } else {
        spaceLayer.setAgencyFilter(agency);
      }
      if (window.aviationAudio) window.aviationAudio.playChirp(800, 0.03, 0.04);
    });
  }

  // Handle Space Object Selection (ISS, Rocket Launch, Spaceport)
  window.addEventListener('space-object-selected', (e) => {
    const obj = e.detail;
    spaceLayer.setSelectedObject(obj);
    telemetryHUD.showSpaceDetails(obj);

    if (obj.lon != null && obj.lat != null) {
      map.flyTo(obj.lon, obj.lat, Math.min(map.width, map.height) * 0.7);
    }
  });

  // 6. Main 60 FPS Render Loop
  function animationLoop(timestamp) {
    map.updateAndRenderBackground(timestamp);
    if (currentDomainMode !== 'space') {
      flightLayer.render(timestamp);
    }
    spaceLayer.render(timestamp);
    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);

  // 7. Start Live Data Streaming
  window.flightAPI.startPolling();
  console.log('✅ AeroVector Radar Active: Real-time OpenSky & Space feeds online.');
});
