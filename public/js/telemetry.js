// Flight Details HUD Sidebar Controller & Live Telemetry Panel
class TelemetryHUD {
  constructor(flightLayer, mapInstance) {
    this.flightLayer = flightLayer;
    this.map = mapInstance;
    this.panel = document.getElementById('telemetry-drawer');
    this.currentFlight = null;
    this.currentDetails = null;

    this.initElements();
    this.setupListeners();
  }

  initElements() {
    this.btnClose = document.getElementById('btn-close-telemetry');
    this.btnTrack = document.getElementById('btn-track-flight');
    this.btnFitRoute = document.getElementById('btn-fit-route');
    this.btnCopy = document.getElementById('btn-copy-telemetry');

    // UI Field elements
    this.elCallsign = document.getElementById('tel-callsign');
    this.elFlightIata = document.getElementById('tel-iata');
    this.elAirline = document.getElementById('tel-airline');
    this.elStatusBadge = document.getElementById('tel-status-badge');
    this.elCacheTag = document.getElementById('tel-cache-tag');
    this.elCacheStatus = document.getElementById('tel-cache-status');
    this.elOriginCode = document.getElementById('tel-org-code');
    this.elOriginCity = document.getElementById('tel-org-city');
    this.elOriginName = document.getElementById('tel-org-name');
    this.elOrgTime = document.getElementById('tel-org-time');
    this.elDestCode = document.getElementById('tel-dst-code');
    this.elDestCity = document.getElementById('tel-dst-city');
    this.elDestName = document.getElementById('tel-dst-name');
    this.elDstTime = document.getElementById('tel-dst-time');
    this.elFlightDuration = document.getElementById('tel-flight-duration');
    this.elProgressBar = document.getElementById('tel-progress-fill');
    this.elProgressPercent = document.getElementById('tel-progress-val');
    this.elDistanceVal = document.getElementById('tel-dist-val');

    // Gauge fields
    this.elAltitudeFt = document.getElementById('tel-alt-ft');
    this.elAltitudeM = document.getElementById('tel-alt-m');
    this.elVertRate = document.getElementById('tel-vert-rate');
    this.elSpeedKts = document.getElementById('tel-spd-kts');
    this.elSpeedKmh = document.getElementById('tel-spd-kmh');
    this.elSpeedMach = document.getElementById('tel-spd-mach');
    this.elHeadingDeg = document.getElementById('tel-hdg-deg');
    this.elHeadingCard = document.getElementById('tel-hdg-card');
    this.elCompassNeedle = document.getElementById('tel-compass-needle');
    this.elSquawk = document.getElementById('tel-squawk');
    this.elSquawkDesc = document.getElementById('tel-squawk-desc');
    this.elCoords = document.getElementById('tel-coords');

    // Aircraft specs
    this.elAcModel = document.getElementById('tel-ac-model');
    this.elAcType = document.getElementById('tel-ac-type');
    this.elAcManufacturer = document.getElementById('tel-ac-mfr');
    this.elAcReg = document.getElementById('tel-ac-reg');
    this.elAcOwner = document.getElementById('tel-ac-owner');
    this.elAcPax = document.getElementById('tel-ac-pax');
    this.elAcCeiling = document.getElementById('tel-ac-ceiling');
    this.elAcPhoto = document.getElementById('tel-ac-photo');
    this.elAcPhotoContainer = document.getElementById('tel-ac-photo-container');
  }

  setupListeners() {
    if (this.btnClose) {
      this.btnClose.addEventListener('click', () => this.close());
    }

    if (this.btnTrack) {
      this.btnTrack.addEventListener('click', () => {
        this.flightLayer.isTrackingSelected = !this.flightLayer.isTrackingSelected;
        this.updateTrackButtonState();
      });
    }

    if (this.btnFitRoute) {
      this.btnFitRoute.addEventListener('click', () => {
        if (this.currentDetails && this.currentDetails.origin && this.currentDetails.destination) {
          const org = this.currentDetails.origin;
          const dst = this.currentDetails.destination;
          const midLon = (org.lon + dst.lon) / 2;
          const midLat = (org.lat + dst.lat) / 2;
          this.map.flyTo(midLon, midLat, Math.min(this.map.width, this.map.height) * 0.45);
        }
      });
    }

    if (this.btnCopy) {
      this.btnCopy.addEventListener('click', () => {
        if (this.currentFlight) {
          const payload = {
            callsign: this.currentFlight.callsign,
            hex: this.currentFlight.hex,
            airline: this.currentFlight.alName,
            altitude: `${this.currentFlight.alt} ft`,
            speed: `${this.currentFlight.spd} kts`,
            heading: `${this.currentFlight.hdg}°`,
            coordinates: [this.currentFlight.lat, this.currentFlight.lon],
            squawk: this.currentFlight.sqk
          };
          navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
            this.btnCopy.innerHTML = '<span>✓ Copied</span>';
            setTimeout(() => {
              this.btnCopy.innerHTML = '<span>📋 Copy Telemetry</span>';
            }, 2000);
          });
        }
      });
    }

    window.addEventListener('flight-selected', async (e) => {
      const flight = e.detail;
      await this.showFlight(flight);
    });

    window.addEventListener('flight-deselected', () => {
      this.close();
    });

    // Real-Time HUD Refresh: Keep live gauges updated on every background poll (H9 finding)
    window.flightAPI.on('flights', (data) => {
      if (this.currentFlight && this.panel && this.panel.classList.contains('open')) {
        const updated = (data.flights || []).find(f => f.hex && f.hex.toLowerCase() === (this.currentFlight.hex || '').toLowerCase());
        if (updated) {
          this.currentFlight = { ...this.currentFlight, ...updated };
          this.renderLiveTelemetry(this.currentFlight);
        }
      }
    });
  }

  updateTrackButtonState() {
    if (!this.btnTrack) return;
    if (this.flightLayer.isTrackingSelected) {
      this.btnTrack.classList.add('active');
      this.btnTrack.innerHTML = '<span>🎯 Tracking Active</span>';
    } else {
      this.btnTrack.classList.remove('active');
      this.btnTrack.innerHTML = '<span>🎯 Follow Flight</span>';
    }
  }

  getCardinalDirection(deg) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const idx = Math.round(((deg % 360) / 22.5)) % 16;
    return directions[idx];
  }

  async showFlight(flight) {
    if (!this.requestIdCounter) this.requestIdCounter = 0;
    const currentReqId = ++this.requestIdCounter;

    // Smart Match: Check if this flight is currently tracked live on the radar
    const hex = (flight.hex || '').toLowerCase().trim();
    const callsign = (flight.callsign || flight.flight_iata || flight.flight_icao || '').toUpperCase().trim();
    const digits = callsign.match(/\d+/);
    const num = digits ? digits[0] : null;

    let targetFlight = null;
    if (flight.lat != null && flight.lon != null && !(flight.lat === 0 && flight.lon === 0)) {
      targetFlight = flight;
    } else if (this.flightLayer && this.flightLayer.flights) {
      // Priority 1: Exact Hex Match
      if (hex) {
        targetFlight = this.flightLayer.flights.find(f => f.hex && f.hex.toLowerCase() === hex);
      }
      // Priority 2: Exact Callsign or Flight IATA Match
      if (!targetFlight && callsign) {
        targetFlight = this.flightLayer.flights.find(f => (f.callsign && f.callsign.toUpperCase() === callsign) || (f.flightIata && f.flightIata.toUpperCase() === callsign));
      }
      // Priority 3: Commercial Flight Number Suffix Match (e.g., 850 in IGO850 / 6E850)
      if (!targetFlight && num && num.length >= 2) {
        targetFlight = this.flightLayer.flights.find(f => {
          const fCall = (f.callsign || '').toUpperCase();
          const fIata = (f.flightIata || '').toUpperCase();
          return fCall.endsWith(num) || fIata.endsWith(num);
        });
      }
    }

    if (!targetFlight) {
      targetFlight = {
        hex: hex || '',
        callsign: callsign || 'FLIGHT',
        flightIata: callsign,
        isScheduledRoute: true
      };
    }

    this.currentFlight = targetFlight;
    this.panel.classList.add('open');
    document.body.classList.add('drawer-open');

    // Pan camera to flight smoothly if real coordinates exist
    const lon = targetFlight.renderLon || targetFlight.lon;
    const lat = targetFlight.renderLat || targetFlight.lat;
    if (lon && lat && !(lat === 0 && lon === 0)) {
      this.map.flyTo(lon, lat);
    }

    // Set initial quick telemetry and reset route HUD for new flight
    this.resetRouteHUD(targetFlight);
    this.renderLiveTelemetry(targetFlight);

    // Set immediate selected flight so aircraft is highlighted
    this.flightLayer.setSelectedFlight(targetFlight, null);

    try {
      const details = await window.flightAPI.getFlightDetails(targetFlight.callsign, targetFlight.hex);
      
      // Guard against race conditions: only apply if this is still the most recent request
      if (this.requestIdCounter === currentReqId && this.currentFlight) {
        this.currentDetails = details;
        this.flightLayer.setSelectedFlight(targetFlight, details);
        if (details) {
          this.renderEnrichedDetails(details);

          // If flight was not live on radar, fly camera to center of route
          if ((!lat || (lat === 0 && lon === 0)) && details.origin && details.destination && details.origin.lat && details.destination.lat) {
            const midLon = (details.origin.lon + details.destination.lon) / 2;
            const midLat = (details.origin.lat + details.destination.lat) / 2;
            const dist = Math.hypot(details.origin.lon - details.destination.lon, details.origin.lat - details.destination.lat);
            const targetScale = Math.max(300, Math.min(1800, (360 / Math.max(15, dist)) * 25));
            this.map.flyTo(midLon, midLat, targetScale);
          }

          // Notify UI to refresh cache badge count
          window.dispatchEvent(new CustomEvent('cache-updated'));
        }
      }
    } catch (e) {
      console.warn('[TELEMETRY] Error fetching details:', e);
    }
  }

  resetRouteHUD(flight) {
    this.currentDetails = null;

    if (this.elOriginCode) this.elOriginCode.textContent = 'DEP';
    if (this.elOriginCity) this.elOriginCity.textContent = 'En Route';
    if (this.elOriginName) this.elOriginName.textContent = 'Live Radar Telemetry';
    if (this.elOrgTime) this.elOrgTime.textContent = '';

    if (this.elDestCode) this.elDestCode.textContent = 'ARR';
    if (this.elDestCity) this.elDestCity.textContent = 'En Route';
    if (this.elDestName) this.elDestName.textContent = 'Destination Pending';
    if (this.elDstTime) this.elDstTime.textContent = '';
    if (this.elFlightDuration) this.elFlightDuration.textContent = '';

    if (this.elProgressBar) this.elProgressBar.style.width = '0%';
    if (this.elProgressPercent) this.elProgressPercent.textContent = '--';
    if (this.elDistanceVal) this.elDistanceVal.textContent = '-- NM';

    if (this.elAcModel) this.elAcModel.textContent = 'Commercial Aircraft';
    if (this.elAcType) this.elAcType.textContent = (flight && flight.type) || '--';
    if (this.elAcManufacturer) this.elAcManufacturer.textContent = '--';
    if (this.elAcReg) this.elAcReg.textContent = (flight && flight.reg) || '--';
    if (this.elAcOwner) this.elAcOwner.textContent = (flight && flight.alName) || 'Commercial Operator';
    if (this.elAcPax) this.elAcPax.textContent = '--';
    if (this.elAcCeiling) this.elAcCeiling.textContent = '--';

    if (this.elAcPhotoContainer) this.elAcPhotoContainer.style.display = 'none';
    if (this.elAcPhoto) this.elAcPhoto.src = '';

    if (this.elCacheTag) {
      this.elCacheTag.className = 'cache-source-tag';
      this.elCacheTag.innerHTML = '<span class="cache-icon">📡</span> <span>OpenSky Live Radar</span>';
      this.elCacheTag.title = 'Live OpenSky transponder detection';
    }
  }

  renderLiveTelemetry(flight) {
    const callsign = flight.callsign || flight.hex.toUpperCase();
    if (this.elCallsign) this.elCallsign.textContent = callsign;
    if (this.elFlightIata) this.elFlightIata.textContent = flight.flightIata || flight.callsign || '--';
    if (this.elAirline) this.elAirline.textContent = flight.alName || 'Commercial Flight';

    // Status Badge
    let statusText = 'EN ROUTE';
    let statusClass = 'badge-cruise';
    if (flight.isScheduledRoute) {
      statusText = 'SCHEDULED / CACHE';
      statusClass = 'badge-cruise';
    } else if (flight.gnd) {
      statusText = 'ON GROUND';
      statusClass = 'badge-ground';
    } else if (flight.vr > 500) {
      statusText = 'CLIMBING';
      statusClass = 'badge-climb';
    } else if (flight.vr < -500) {
      statusText = 'DESCENDING';
      statusClass = 'badge-descend';
    }
    if (this.elStatusBadge) {
      this.elStatusBadge.textContent = statusText;
      this.elStatusBadge.className = `status-badge ${statusClass}`;
    }

    // Altitude
    const altFt = flight.alt || 0;
    const altM = Math.round(altFt * 0.3048);
    if (this.elAltitudeFt) this.elAltitudeFt.textContent = altFt > 0 ? `${altFt.toLocaleString()} FT` : (flight.isScheduledRoute ? 'CRUISE FLIGHT' : 'GROUND');
    if (this.elAltitudeM) this.elAltitudeM.textContent = altFt > 0 ? `${altM.toLocaleString()} M` : (flight.isScheduledRoute ? 'OPTIMAL ALT' : '0 M');

    // Vertical Rate
    const vr = flight.vr || 0;
    let vrSymbol = '—';
    if (flight.isScheduledRoute) vrSymbol = 'SCHEDULED FLIGHT';
    else if (vr > 100) vrSymbol = `▲ +${vr.toLocaleString()} FPM`;
    else if (vr < -100) vrSymbol = `▼ ${vr.toLocaleString()} FPM`;
    else vrSymbol = '▶ LEVEL (0 FPM)';
    if (this.elVertRate) this.elVertRate.textContent = vrSymbol;

    // Speed
    const spdKts = flight.spd || 0;
    const spdKmh = Math.round(spdKts * 1.852);
    const mach = (spdKts / 661.47).toFixed(2);
    if (this.elSpeedKts) this.elSpeedKts.textContent = spdKts > 0 ? `${spdKts} KTS` : (flight.isScheduledRoute ? 'PLANNED' : '0 KTS');
    if (this.elSpeedKmh) this.elSpeedKmh.textContent = spdKts > 0 ? `${spdKmh} KM/H` : (flight.isScheduledRoute ? '--' : '0 KM/H');
    if (this.elSpeedMach) this.elSpeedMach.textContent = spdKts > 0 ? `Mach ${mach}` : (flight.isScheduledRoute ? 'Mach ~0.78' : 'Mach 0.00');

    // Heading
    const hdg = Math.round(flight.hdg || 0);
    const cardinal = this.getCardinalDirection(hdg);
    if (this.elHeadingDeg) this.elHeadingDeg.textContent = flight.isScheduledRoute ? 'GREAT CIRCLE' : `${hdg}°`;
    if (this.elHeadingCard) this.elHeadingCard.textContent = flight.isScheduledRoute ? 'AIRWAY' : cardinal;
    if (this.elCompassNeedle) this.elCompassNeedle.style.transform = `rotate(${hdg}deg)`;

    // Coordinates
    const curLat = flight.renderLat !== undefined ? flight.renderLat : flight.lat;
    const curLon = flight.renderLon !== undefined ? flight.renderLon : flight.lon;
    if (curLat !== undefined && curLat !== null && !(curLat === 0 && curLon === 0)) {
      const latStr = `${Math.abs(curLat).toFixed(4)}° ${curLat >= 0 ? 'N' : 'S'}`;
      const lonStr = `${Math.abs(curLon).toFixed(4)}° ${curLon >= 0 ? 'E' : 'W'}`;
      if (this.elCoords) this.elCoords.textContent = `${latStr}, ${lonStr}`;
    } else {
      if (this.elCoords) this.elCoords.textContent = 'AIRWAY FLIGHT PATH';
    }

    // Squawk
    const sqk = flight.sqk || '----';
    if (this.elSquawk) this.elSquawk.textContent = sqk;
    if (this.elSquawkDesc) {
      if (sqk === '7700') this.elSquawkDesc.textContent = '🚨 EMERGENCY SQUAWK';
      else if (sqk === '7600') this.elSquawkDesc.textContent = '⚠️ RADIO COMM FAILURE';
      else if (sqk === '7500') this.elSquawkDesc.textContent = '🚨 HIJACK / UNLAWFUL';
      else this.elSquawkDesc.textContent = 'MODE-S TRANSPONDER';
    }
  }

  renderEnrichedDetails(details) {
    if (details.flightIata && this.elFlightIata) {
      this.elFlightIata.textContent = details.flightIata;
    }
    if (details.airline && details.airline.name && this.elAirline) {
      this.elAirline.textContent = `${details.airline.name} ${details.airline.country ? `(${details.airline.country})` : ''}`;
    }

    // Cache & Verification Source Pill with Strict Confidence Levels
    if (this.elCacheTag) {
      const meta = details.cacheMeta || {};
      const conf = meta.confidence || (meta.source === 'AIRLABS_LIVE' ? 'HIGH_VERIFIED' : (meta.source === 'ADSB_DB' ? 'MEDIUM_VERIFIED' : (meta.source === 'INFERRED_CORRIDOR' ? 'LOW_INFERRED' : 'UNAVAILABLE')));

      if (conf === 'HIGH_VERIFIED') {
        this.elCacheTag.className = 'cache-source-tag cached';
        this.elCacheTag.innerHTML = '<span class="cache-icon">⚡</span> <span>VERIFIED SCHEDULE (GDS)</span>';
        this.elCacheTag.title = 'Confirmed commercial flight schedule';
      } else if (conf === 'MEDIUM_VERIFIED') {
        this.elCacheTag.className = 'cache-source-tag cached';
        this.elCacheTag.innerHTML = '<span class="cache-icon">✅</span> <span>VERIFIED ROUTE (ADSBdb)</span>';
        this.elCacheTag.title = 'Exact verified flight corridor from ADS-B topology';
      } else if (conf === 'LOW_INFERRED') {
        this.elCacheTag.className = 'cache-source-tag inferred';
        this.elCacheTag.innerHTML = '<span class="cache-icon">🟡</span> <span>INFERRED CORRIDOR (Est.)</span>';
        this.elCacheTag.title = 'Estimated airline corridor based on trajectory and network graph';
      } else {
        this.elCacheTag.className = 'cache-source-tag';
        this.elCacheTag.innerHTML = '<span class="cache-icon">📡</span> <span>OpenSky Live Radar</span>';
        this.elCacheTag.title = 'Active transponder telemetry. Full route unconfirmed.';
      }
    }

    // Origin (Pure Live API Data)
    if (details.origin) {
      if (this.elOriginCode) this.elOriginCode.textContent = details.origin.iata || details.origin.icao || 'ORG';
      if (this.elOriginCity) this.elOriginCity.textContent = details.origin.city || details.origin.name || '--';
      if (this.elOriginName) this.elOriginName.textContent = details.origin.name || '';
      if (this.elOrgTime) {
        this.elOrgTime.textContent = details.cacheMeta?.dep_time ? `DEP: ${details.cacheMeta.dep_time}` : '';
      }
    } else {
      if (this.elOriginCode) this.elOriginCode.textContent = 'DEP';
      if (this.elOriginCity) this.elOriginCity.textContent = 'En Route (Live Radar)';
      if (this.elOriginName) this.elOriginName.textContent = 'Airborne Tracking Active';
      if (this.elOrgTime) this.elOrgTime.textContent = '';
    }

    // Destination (Pure Live API Data)
    if (details.destination) {
      if (this.elDestCode) this.elDestCode.textContent = details.destination.iata || details.destination.icao || 'DST';
      if (this.elDestCity) this.elDestCity.textContent = details.destination.city || details.destination.name || '--';
      if (this.elDestName) this.elDestName.textContent = details.destination.name || '';
      if (this.elDstTime) {
        this.elDstTime.textContent = details.cacheMeta?.arr_time ? `ARR: ${details.cacheMeta.arr_time}` : '';
      }
    } else {
      if (this.elDestCode) this.elDestCode.textContent = 'ARR';
      if (this.elDestCity) this.elDestCity.textContent = 'En Route (Live Radar)';
      if (this.elDestName) this.elDestName.textContent = 'Destination Pending';
      if (this.elDstTime) this.elDstTime.textContent = '';
    }

    if (this.elFlightDuration) {
      this.elFlightDuration.textContent = details.cacheMeta?.duration || '';
    }

    // Route Progress & Distance
    if (details.route) {
      const pct = details.destination ? (details.route.progressPercent !== undefined ? details.route.progressPercent : 0) : 100;
      if (this.elProgressBar) this.elProgressBar.style.width = `${pct}%`;
      if (this.elProgressPercent) this.elProgressPercent.textContent = details.destination ? `${pct}%` : 'RADAR';
      if (this.elDistanceVal && details.route.distanceNm) {
        const km = Math.round(details.route.distanceNm * 1.852);
        this.elDistanceVal.textContent = `${details.route.distanceNm.toLocaleString()} NM (${km.toLocaleString()} KM)`;
      }
    }

    // Aircraft specifications
    if (details.aircraft) {
      const ac = details.aircraft;
      if (this.elAcModel) this.elAcModel.textContent = ac.model || ac.icaoType || 'Commercial Aircraft';
      if (this.elAcType) this.elAcType.textContent = ac.icaoType || '--';
      if (this.elAcManufacturer) this.elAcManufacturer.textContent = ac.manufacturer || 'Aviation OEM';
      if (this.elAcReg) {
        const isHex = ac.registration && ac.registration.toLowerCase() === (details.hex || '').toLowerCase();
        this.elAcReg.textContent = (!ac.registration || isHex) ? '--' : ac.registration;
      }
      if (this.elAcOwner) this.elAcOwner.textContent = ac.registeredOwner || (details.airline && details.airline.name) || 'Commercial Operator';
      if (this.elAcPax) this.elAcPax.textContent = ac.maxPassengers || ac.maxPax ? `${ac.maxPassengers || ac.maxPax} seats` : '--';
      if (this.elAcCeiling) this.elAcCeiling.textContent = ac.maxServiceCeiling ? `${ac.maxServiceCeiling.toLocaleString()} FT` : '--';

      // Aircraft photo
      if (ac.photoUrl && this.elAcPhoto && this.elAcPhotoContainer) {
        this.elAcPhoto.src = ac.photoUrl;
        this.elAcPhotoContainer.style.display = 'block';
      } else if (this.elAcPhotoContainer) {
        this.elAcPhotoContainer.style.display = 'none';
      }
    }
  }

  showSpaceDetails(spaceObj) {
    if (!spaceObj) return;

    if (this.flightLayer) {
      this.flightLayer.setSelectedFlight(null, null);
    }

    this.panel.classList.add('open');
    document.body.classList.add('drawer-open');

    if (spaceObj.type === 'iss') {
      if (this.elCallsign) this.elCallsign.textContent = 'ISS (ZARYA)';
      if (this.elFlightIata) this.elFlightIata.textContent = 'NORAD #25544';
      if (this.elAirline) this.elAirline.textContent = 'International Space Station (NASA / ESA / JAXA)';
      if (this.elStatusBadge) {
        this.elStatusBadge.textContent = 'ORBITING (420 KM)';
        this.elStatusBadge.className = 'status-badge status-en-route';
      }
      if (this.elCacheTag) this.elCacheTag.style.display = 'none';

      // Origin / Destination
      if (this.elOriginCode) this.elOriginCode.textContent = 'LEO';
      if (this.elOriginCity) this.elOriginCity.textContent = 'Orbital Insertion';
      if (this.elOriginName) this.elOriginName.textContent = '51.64° Inclination';
      if (this.elOrgTime) this.elOrgTime.textContent = 'Epoch 1998';

      if (this.elDestCode) this.elDestCode.textContent = 'ORBIT';
      if (this.elDestCity) this.elDestCity.textContent = 'Continuous Trajectory';
      if (this.elDestName) this.elDestName.textContent = 'Period: 92.68 min';
      if (this.elDstTime) this.elDstTime.textContent = '15.54 Orbits/Day';

      if (this.elFlightDuration) this.elFlightDuration.textContent = '92.6 min Period';
      if (this.elProgressBar) this.elProgressBar.style.width = '100%';
      if (this.elProgressPercent) this.elProgressPercent.textContent = 'IN ORBIT';
      if (this.elDistanceVal) this.elDistanceVal.textContent = '400,000+ KM Traversed';

      // Gauges
      if (this.elAltitudeFt) this.elAltitudeFt.textContent = spaceObj.altFt.toLocaleString();
      if (this.elAltitudeM) this.elAltitudeM.textContent = `${spaceObj.altKm} KM`;
      if (this.elVertRate) this.elVertRate.textContent = '0 FPM (Stable)';
      if (this.elSpeedKts) this.elSpeedKts.textContent = spaceObj.speedKts.toLocaleString();
      if (this.elSpeedKmh) this.elSpeedKmh.textContent = `${spaceObj.speedKmh.toLocaleString()} KM/H`;
      if (this.elSpeedMach) this.elSpeedMach.textContent = 'MACH 22.4';
      if (this.elHeadingDeg) this.elHeadingDeg.textContent = '51.6°';
      if (this.elHeadingCard) this.elHeadingCard.textContent = 'ORBIT';
      if (this.elSquawk) this.elSquawk.textContent = '25544';
      if (this.elSquawkDesc) this.elSquawkDesc.textContent = 'Active Space Station';
      if (this.elCoords) this.elCoords.textContent = `${spaceObj.lat.toFixed(4)}°, ${spaceObj.lon.toFixed(4)}°`;

      // Vehicle details
      if (this.elAcModel) this.elAcModel.textContent = 'Modular Space Station Laboratory';
      if (this.elAcType) this.elAcType.textContent = 'SPACE-HAB';
      if (this.elAcManufacturer) this.elAcManufacturer.textContent = 'Boeing / Roscosmos / NASA';
      if (this.elAcReg) this.elAcReg.textContent = '1998-067A';
      if (this.elAcOwner) this.elAcOwner.textContent = 'International Space Station Program';
      if (this.elAcPax) this.elAcPax.textContent = '7 Astronauts';
      if (this.elAcCeiling) this.elAcCeiling.textContent = '420 KM Low Earth Orbit';
      if (this.elAcPhotoContainer) this.elAcPhotoContainer.style.display = 'none';

    } else if (spaceObj.type === 'launch') {
      const diffSec = spaceObj.net_ts ? spaceObj.net_ts - Math.floor(Date.now() / 1000) : 0;
      const isPast = diffSec <= 0;

      if (this.elCallsign) this.elCallsign.textContent = spaceObj.rocket_name || 'Orbital Rocket';
      if (this.elFlightIata) this.elFlightIata.textContent = spaceObj.orbit || 'LEO';
      if (this.elAirline) this.elAirline.textContent = spaceObj.lsp_name || 'Launch Service Provider';
      if (this.elStatusBadge) {
        this.elStatusBadge.textContent = spaceObj.status_name || 'SCHEDULED';
        this.elStatusBadge.className = 'status-badge status-scheduled';
      }
      if (this.elCacheTag) this.elCacheTag.style.display = 'none';

      // Origin / Destination
      if (this.elOriginCode) this.elOriginCode.textContent = 'PAD';
      if (this.elOriginCity) this.elOriginCity.textContent = spaceObj.pad_location || 'Launch Complex';
      if (this.elOriginName) this.elOriginName.textContent = spaceObj.pad_name || 'Launch Site';
      if (this.elOrgTime) this.elOrgTime.textContent = spaceObj.net ? new Date(spaceObj.net).toUTCString().slice(5, 22) : 'TBD';

      if (this.elDestCode) this.elDestCode.textContent = 'ORBIT';
      if (this.elDestCity) this.elDestCity.textContent = spaceObj.orbit || 'Low Earth Orbit';
      if (this.elDestName) this.elDestName.textContent = spaceObj.mission_name || 'Mission Payload';
      if (this.elDstTime) this.elDstTime.textContent = spaceObj.mission_type || 'Payload Delivery';

      if (this.elFlightDuration) this.elFlightDuration.textContent = isPast ? 'MISSION ACTIVE' : 'COUNTDOWN ACTIVE';
      if (this.elProgressBar) this.elProgressBar.style.width = isPast ? '100%' : '15%';
      if (this.elProgressPercent) this.elProgressPercent.textContent = isPast ? 'LIFTOFF' : 'T-MINUS';
      if (this.elDistanceVal) this.elDistanceVal.textContent = spaceObj.mission_name || 'Satellite Deployment';

      // Gauges
      if (this.elAltitudeFt) this.elAltitudeFt.textContent = isPast ? '180,000+' : '0';
      if (this.elAltitudeM) this.elAltitudeM.textContent = isPast ? 'ORBITAL' : 'SURFACE';
      if (this.elVertRate) this.elVertRate.textContent = isPast ? '+8,000 FPM' : '0 FPM';
      if (this.elSpeedKts) this.elSpeedKts.textContent = isPast ? '15,000+' : '0';
      if (this.elSpeedKmh) this.elSpeedKmh.textContent = isPast ? '27,000 KM/H' : '0 KM/H';
      if (this.elSpeedMach) this.elSpeedMach.textContent = isPast ? 'MACH 12+' : 'MACH 0';
      if (this.elHeadingDeg) this.elHeadingDeg.textContent = '60.0°';
      if (this.elHeadingCard) this.elHeadingCard.textContent = 'NE';
      if (this.elSquawk) this.elSquawk.textContent = 'ROCKET';
      if (this.elSquawkDesc) this.elSquawkDesc.textContent = spaceObj.status_desc || 'Orbital Launch';
      if (this.elCoords) this.elCoords.textContent = `${spaceObj.pad_lat?.toFixed(4)}°, ${spaceObj.pad_lon?.toFixed(4)}°`;

      // Vehicle details
      if (this.elAcModel) this.elAcModel.textContent = spaceObj.rocket_name || 'Orbital Launch Vehicle';
      if (this.elAcType) this.elAcType.textContent = spaceObj.rocket_family || 'LV';
      if (this.elAcManufacturer) this.elAcManufacturer.textContent = spaceObj.lsp_name || 'Space Agency';
      if (this.elAcReg) this.elAcReg.textContent = spaceObj.id || '--';
      if (this.elAcOwner) this.elAcOwner.textContent = spaceObj.lsp_name || 'Space Agency';
      if (this.elAcPax) this.elAcPax.textContent = spaceObj.mission_type || 'Satellite / Cargo';
      if (this.elAcCeiling) this.elAcCeiling.textContent = spaceObj.orbit || 'Orbital Space';

      if (spaceObj.image_url && this.elAcPhoto && this.elAcPhotoContainer) {
        this.elAcPhoto.src = spaceObj.image_url;
        this.elAcPhotoContainer.style.display = 'block';
      } else if (this.elAcPhotoContainer) {
        this.elAcPhotoContainer.style.display = 'none';
      }

    } else if (spaceObj.type === 'spaceport') {
      if (this.elCallsign) this.elCallsign.textContent = spaceObj.name;
      if (this.elFlightIata) this.elFlightIata.textContent = spaceObj.country;
      if (this.elAirline) this.elAirline.textContent = spaceObj.agency;
      if (this.elStatusBadge) {
        this.elStatusBadge.textContent = 'OPERATIONAL SPACEPORT';
        this.elStatusBadge.className = 'status-badge status-scheduled';
      }
      if (this.elCacheTag) this.elCacheTag.style.display = 'none';

      if (this.elOriginCode) this.elOriginCode.textContent = 'SITE';
      if (this.elOriginCity) this.elOriginCity.textContent = spaceObj.location;
      if (this.elOriginName) this.elOriginName.textContent = spaceObj.name;
      if (this.elOrgTime) this.elOrgTime.textContent = 'Active Spaceport';

      if (this.elDestCode) this.elDestCode.textContent = 'SPACE';
      if (this.elDestCity) this.elDestCity.textContent = 'Global Launch Corridors';
      if (this.elDestName) this.elDestName.textContent = spaceObj.pads ? spaceObj.pads.join(', ') : 'Launch Complex';
      if (this.elDstTime) this.elDstTime.textContent = spaceObj.agency;

      if (this.elFlightDuration) this.elFlightDuration.textContent = 'Active Space Base';
      if (this.elProgressBar) this.elProgressBar.style.width = '100%';
      if (this.elProgressPercent) this.elProgressPercent.textContent = 'ONLINE';
      if (this.elDistanceVal) this.elDistanceVal.textContent = spaceObj.activeVehicles ? spaceObj.activeVehicles.join(', ') : 'Rockets';

      if (this.elAltitudeFt) this.elAltitudeFt.textContent = '35';
      if (this.elAltitudeM) this.elAltitudeM.textContent = '10 M (MSL)';
      if (this.elVertRate) this.elVertRate.textContent = '0 FPM';
      if (this.elSpeedKts) this.elSpeedKts.textContent = '0';
      if (this.elSpeedKmh) this.elSpeedKmh.textContent = '0 KM/H';
      if (this.elSpeedMach) this.elSpeedMach.textContent = 'MACH 0';
      if (this.elHeadingDeg) this.elHeadingDeg.textContent = '0.0°';
      if (this.elHeadingCard) this.elHeadingCard.textContent = 'PAD';
      if (this.elSquawk) this.elSquawk.textContent = 'SPACE';
      if (this.elSquawkDesc) this.elSquawkDesc.textContent = spaceObj.agency;
      if (this.elCoords) this.elCoords.textContent = `${spaceObj.lat.toFixed(4)}°, ${spaceObj.lon.toFixed(4)}°`;

      if (this.elAcModel) this.elAcModel.textContent = spaceObj.name;
      if (this.elAcType) this.elAcType.textContent = 'SPACEPORT';
      if (this.elAcManufacturer) this.elAcManufacturer.textContent = spaceObj.agency;
      if (this.elAcReg) this.elAcReg.textContent = spaceObj.country;
      if (this.elAcOwner) this.elAcOwner.textContent = spaceObj.agency;
      if (this.elAcPax) this.elAcPax.textContent = spaceObj.historicMissions ? spaceObj.historicMissions.slice(0, 2).join(', ') : '--';
      if (this.elAcCeiling) this.elAcCeiling.textContent = 'Orbital Launch Range';
      if (this.elAcPhotoContainer) this.elAcPhotoContainer.style.display = 'none';
    }
  }

  close() {
    this.requestIdCounter = (this.requestIdCounter || 0) + 1;
    this.currentFlight = null;
    this.currentDetails = null;
    this.panel.classList.remove('open');
    document.body.classList.remove('drawer-open');
    this.flightLayer.setSelectedFlight(null, null);
    this.flightLayer.isTrackingSelected = false;
    this.updateTrackButtonState();
  }
}

window.TelemetryHUD = TelemetryHUD;
