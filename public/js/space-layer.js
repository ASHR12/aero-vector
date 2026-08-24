// High-Performance Rocket & Orbital Spacecraft Engine for AeroVector
class SpaceLayer {
  constructor(mapInstance) {
    this.map = mapInstance;
    this.ctx = mapInstance.ctx;

    this.spaceports = [];
    this.launches = [];
    this.iss = null;
    this.visibleObjects = [];
    this.selectedObject = null;
    this.hoveredObject = null;

    this.mode = 'flights'; // 'flights', 'space', 'all'
    this.agencyFilter = 'all';

    this.pulsePhase = 0;
    this.lastFrameTime = 0;
    this.tooltip = document.getElementById('radar-tooltip');

    this.setupEvents();
  }

  setData({ spaceports, launches, iss }) {
    if (spaceports) this.spaceports = spaceports;
    if (launches) this.launches = launches;
    if (iss) this.iss = iss;
  }

  setMode(mode) {
    this.mode = mode; // 'flights' | 'space' | 'all'
  }

  setAgencyFilter(agency) {
    this.agencyFilter = agency || 'all';
  }

  setSelectedObject(obj) {
    this.selectedObject = obj;
    if (window.aviationAudio && obj) {
      window.aviationAudio.playChirp(900, 0.05, 0.08);
    }
  }

  setupEvents() {
    let mousePos = [0, 0];

    this.map.canvas.addEventListener('mousemove', (e) => {
      if (this.mode === 'flights') return;
      const rect = this.map.canvas.getBoundingClientRect();
      mousePos = [e.clientX - rect.left, e.clientY - rect.top];

      if (this.map.isDragging || (this.map.dragDistance && this.map.dragDistance > 6)) {
        this.hoveredObject = null;
        return;
      }

      let closest = null;
      let minDist = 18;

      for (let i = 0; i < this.visibleObjects.length; i++) {
        const item = this.visibleObjects[i];
        const dx = item.screenX - mousePos[0];
        const dy = item.screenY - mousePos[1];
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) {
          minDist = dist;
          closest = item.object;
        }
      }

      this.hoveredObject = closest;
      if (closest) {
        this.map.canvas.style.cursor = 'pointer';
        this.showSpaceTooltip(closest, mousePos[0], mousePos[1]);
      } else if (!this.hoveredFlight) {
        // Only reset if flight layer is not hovering
      }
    });

    this.map.canvas.addEventListener('click', (e) => {
      if (this.mode === 'flights') return;
      if (this.map.isDragging || (this.map.dragDistance && this.map.dragDistance > 6)) return;

      const rect = this.map.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      let clicked = null;
      let minDist = 22;

      for (let i = 0; i < this.visibleObjects.length; i++) {
        const item = this.visibleObjects[i];
        const dx = item.screenX - clickX;
        const dy = item.screenY - clickY;
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) {
          minDist = dist;
          clicked = item.object;
        }
      }

      if (clicked) {
        window.dispatchEvent(new CustomEvent('space-object-selected', { detail: clicked }));
      }
    });
  }

  showSpaceTooltip(obj, screenX, screenY) {
    if (!this.tooltip) return;

    if (obj.type === 'iss') {
      this.tooltip.innerHTML = `
        <div class="tooltip-header">
          <span class="tooltip-callsign" style="color: #38bdf8;">🛰️ ${obj.name}</span>
          <span class="tooltip-badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid #38bdf880;">
            ${obj.altKm} KM ALT
          </span>
        </div>
        <div class="tooltip-airline" style="color: #cbd5e1;">Orbital Speed: ${obj.speedKmh.toLocaleString()} km/h (${obj.speedKts.toLocaleString()} kts)</div>
        <div class="tooltip-grid">
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">NORAD ID</span><span class="tooltip-grid-val">${obj.noradId}</span></div>
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">INCLINATION</span><span class="tooltip-grid-val">${obj.inclination}</span></div>
        </div>
      `;
    } else if (obj.type === 'launch') {
      const countdown = this.getCountdownString(obj.net_ts);
      this.tooltip.innerHTML = `
        <div class="tooltip-header">
          <span class="tooltip-callsign" style="color: #f97316;">🚀 ${obj.rocket_name || obj.name}</span>
          <span class="tooltip-badge" style="background: rgba(249, 115, 22, 0.2); color: #f97316; border: 1px solid #f9731680;">
            ${countdown}
          </span>
        </div>
        <div class="tooltip-airline" style="color: #fde047;">${obj.lsp_name} • ${obj.mission_name || 'Satellite Deployment'}</div>
        <div class="tooltip-grid">
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">PAD</span><span class="tooltip-grid-val">${obj.pad_name}</span></div>
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">ORBIT</span><span class="tooltip-grid-val">${obj.orbit || 'LEO'}</span></div>
        </div>
      `;
    } else if (obj.type === 'spaceport') {
      this.tooltip.innerHTML = `
        <div class="tooltip-header">
          <span class="tooltip-callsign" style="color: #a855f7;">🌐 ${obj.name}</span>
          <span class="tooltip-badge" style="background: rgba(168, 85, 247, 0.2); color: #a855f7; border: 1px solid #a855f780;">
            ${obj.country}
          </span>
        </div>
        <div class="tooltip-airline" style="color: #e2e8f0;">Agency: ${obj.agency}</div>
        <div class="tooltip-grid">
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">ACTIVE VEHICLES</span><span class="tooltip-grid-val">${obj.activeVehicles ? obj.activeVehicles.slice(0, 2).join(', ') : 'Rockets'}</span></div>
          <div class="tooltip-grid-item"><span class="tooltip-grid-label">LOCATION</span><span class="tooltip-grid-val">${obj.location}</span></div>
        </div>
      `;
    }

    this.tooltip.style.left = `${screenX + 16}px`;
    this.tooltip.style.top = `${screenY + 16}px`;
    this.tooltip.style.display = 'block';
  }

  getCountdownString(netTs) {
    if (!netTs) return 'T- 00:00:00';
    const diff = netTs - Math.floor(Date.now() / 1000);
    if (diff <= 0) return '🚀 IN FLIGHT / LIFTOFF';
    const hrs = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    const secs = diff % 60;
    if (hrs > 48) return `T- ${Math.round(hrs / 24)} Days`;
    return `T- ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  render(timestamp) {
    if (this.mode === 'flights') return;
    this.pulsePhase = (timestamp * 0.003) % (2 * Math.PI);
    this.visibleObjects = [];

    // 1. Render ISS Orbital Trajectory Line & Real-time Space Station
    if (this.iss) {
      this.renderIssOrbit(timestamp);
    }

    // 2. Render Global Spaceports & Active Launch Complexes
    this.renderSpaceports(timestamp);

    // 3. Render Upcoming & Active Rocket Launches
    this.renderRocketLaunches(timestamp);
  }

  renderIssOrbit(timestamp) {
    const iss = this.iss;
    if (!iss) return;

    // Render projected 90-minute orbital ground track path
    if (iss.orbitPoints && iss.orbitPoints.length > 1) {
      try {
        const geoLine = {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: iss.orbitPoints
          }
        };

        this.ctx.save();
        this.ctx.beginPath();
        this.map.path(geoLine);
        this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        this.ctx.lineWidth = 2.0;
        this.ctx.setLineDash([6, 4]);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        this.ctx.restore();
      } catch (e) {}
    }

    // Project live ISS position
    const pt = this.map.project([iss.lon, iss.lat]);
    if (!pt) return;

    const x = pt[0];
    const y = pt[1];
    const isHovered = this.hoveredObject && this.hoveredObject.type === 'iss';
    const isSelected = this.selectedObject && this.selectedObject.type === 'iss';

    const issObj = { ...iss, type: 'iss' };
    this.visibleObjects.push({ object: issObj, screenX: x, screenY: y });

    // Orbital Radar Pulsing Ring
    const pulseRad = 14 + Math.sin(this.pulsePhase) * 6;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(x, y, pulseRad, 0, 2 * Math.PI);
    this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    this.ctx.lineWidth = 1.4;
    this.ctx.stroke();

    // ISS Solar Array Icon
    this.ctx.translate(x, y);
    this.ctx.shadowColor = '#38bdf8';
    this.ctx.shadowBlur = isSelected ? 16 : (isHovered ? 10 : 6);

    // Central module
    this.ctx.fillStyle = '#ffffff';
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 4, 0, 2 * Math.PI);
    this.ctx.fill();

    // Solar panels (Golden / Cyan Wings)
    this.ctx.fillStyle = '#facc15';
    this.ctx.fillRect(-14, -3, 8, 6);
    this.ctx.fillRect(6, -3, 8, 6);
    this.ctx.strokeStyle = '#38bdf8';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(-14, -3, 8, 6);
    this.ctx.strokeRect(6, -3, 8, 6);

    this.ctx.restore();

    // Callout Badge
    this.renderSpaceBadge(x, y, '🛰️ ISS', `${iss.speedKmh.toLocaleString()} km/h • ${iss.altKm}km`, '#38bdf8', isSelected, isHovered);
  }

  renderSpaceports(timestamp) {
    for (let i = 0; i < this.spaceports.length; i++) {
      const port = this.spaceports[i];
      if (this.agencyFilter !== 'all') {
        const ag = (port.agency || '').toUpperCase();
        if (!ag.includes(this.agencyFilter.toUpperCase())) continue;
      }

      const pt = this.map.project([port.lon, port.lat]);
      if (!pt) continue;

      const x = pt[0];
      const y = pt[1];
      const isHovered = this.hoveredObject && this.hoveredObject.id === port.id;
      const isSelected = this.selectedObject && this.selectedObject.id === port.id;

      const portObj = { ...port, type: 'spaceport' };
      this.visibleObjects.push({ object: portObj, screenX: x, screenY: y });

      this.ctx.save();
      // Hexagonal / Pulsing launch pad marker
      const rad = isSelected ? 8 : (isHovered ? 6.5 : 5);
      this.ctx.beginPath();
      this.ctx.arc(x, y, rad, 0, 2 * Math.PI);
      this.ctx.fillStyle = isSelected ? '#a855f7' : (isHovered ? '#c084fc' : 'rgba(168, 85, 247, 0.7)');
      this.ctx.fill();
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1.4;
      this.ctx.stroke();

      this.ctx.restore();

      if (isHovered || isSelected || this.map.scale > 800) {
        this.renderSpaceBadge(x, y, `🌐 ${port.name.split('&')[0].trim()}`, port.agency, '#a855f7', isSelected, isHovered);
      }
    }
  }

  renderRocketLaunches(timestamp) {
    for (let i = 0; i < this.launches.length; i++) {
      const launch = this.launches[i];
      if (launch.pad_lat == null || launch.pad_lon == null) continue;

      if (this.agencyFilter !== 'all') {
        const lsp = (launch.lsp_name || '').toUpperCase();
        const rk = (launch.rocket_name || '').toUpperCase();
        if (!lsp.includes(this.agencyFilter.toUpperCase()) && !rk.includes(this.agencyFilter.toUpperCase())) {
          continue;
        }
      }

      const pt = this.map.project([launch.pad_lon, launch.pad_lat]);
      if (!pt) continue;

      const x = pt[0];
      const y = pt[1];
      const isHovered = this.hoveredObject && this.hoveredObject.id === launch.id;
      const isSelected = this.selectedObject && this.selectedObject.id === launch.id;

      const launchObj = { ...launch, type: 'launch' };
      this.visibleObjects.push({ object: launchObj, screenX: x, screenY: y });

      // Rocket Launchpad Ascent Trajectory Projection
      const countdown = this.getCountdownString(launch.net_ts);
      const isLiveSoon = launch.net_ts && (launch.net_ts - Math.floor(Date.now() / 1000) < 86400);

      // Trajectory vector into orbit
      const trajLen = isSelected ? 48 : (isLiveSoon ? 36 : 24);
      const angleRad = -Math.PI / 3; // 60 deg Northeast launch corridor
      const tx = x + trajLen * Math.cos(angleRad);
      const ty = y + trajLen * Math.sin(angleRad);

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(tx, ty);
      this.ctx.strokeStyle = isLiveSoon ? 'rgba(249, 115, 22, 0.85)' : 'rgba(234, 179, 8, 0.6)';
      this.ctx.lineWidth = 2.0;
      this.ctx.stroke();

      // Rocket Silo Beacon & Glowing Rocket Marker
      const pulse = Math.sin(this.pulsePhase * 2) * 3;
      this.ctx.beginPath();
      this.ctx.arc(tx, ty, 4.5 + (isLiveSoon ? pulse : 0), 0, 2 * Math.PI);
      this.ctx.fillStyle = '#f97316';
      this.ctx.shadowColor = '#f97316';
      this.ctx.shadowBlur = isLiveSoon ? 14 : 6;
      this.ctx.fill();
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1.2;
      this.ctx.stroke();

      this.ctx.restore();

      // Countdown Callout Badge
      const title = `🚀 ${launch.rocket_name || launch.name.split('|')[0].trim()}`;
      const subtitle = `${launch.lsp_name} • ${countdown}`;
      this.renderSpaceBadge(tx, ty, title, subtitle, '#f97316', isSelected, isHovered);
    }
  }

  renderSpaceBadge(x, y, title, subtitle, color, isSelected, isHovered) {
    this.ctx.font = 'bold 10px "JetBrains Mono", monospace';
    const textWidth = Math.max(this.ctx.measureText(title).width, this.ctx.measureText(subtitle || '').width);
    const badgeW = textWidth + 14;
    const badgeH = subtitle ? 28 : 16;
    const bx = x + 12;
    const by = y - badgeH / 2;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.roundRect(bx, by, badgeW, badgeH, 4);
    this.ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(8, 15, 30, 0.88)';
    this.ctx.fill();
    this.ctx.strokeStyle = isSelected ? color : (isHovered ? color : 'rgba(255, 255, 255, 0.18)');
    this.ctx.lineWidth = 1.2;
    this.ctx.stroke();

    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillText(title, bx + 6, by + 12);

    if (subtitle) {
      this.ctx.font = '9px "JetBrains Mono", monospace';
      this.ctx.fillStyle = color;
      this.ctx.fillText(subtitle, bx + 6, by + 23);
    }
    this.ctx.restore();
  }
}

window.SpaceLayer = SpaceLayer;
