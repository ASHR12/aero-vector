// High-Performance Dynamic Aircraft Engine with Real-Time Motion & Multi-Photon Route Pulsing
class FlightLayer {
  constructor(mapInstance) {
    this.map = mapInstance;
    this.ctx = mapInstance.ctx;

    this.flights = [];
    this.visibleFlights = [];
    this.selectedFlight = null;
    this.selectedFlightDetails = null;
    this.hoveredFlight = null;
    this.isTrackingSelected = false;
    this.showHeatmap = false;

    // Animation timing
    this.pulsePhase = 0;
    this.lastFrameTime = 0;

    // High-Contrast Altitude Spectrum (Green, Cyan, Yellow, Crimson Red, Electric Violet)
    this.altColors = [
      { max: 10000, color: '#10b981', label: '< 10k ft', name: 'Approach / Low' },
      { max: 25000, color: '#00f0ff', label: '10k - 25k ft', name: 'Mid Airway' },
      { max: 35000, color: '#facc15', label: '25k - 35k ft', name: 'Cruise' },
      { max: 40000, color: '#ef4444', label: '35k - 40k ft', name: 'High Cruise' },
      { max: 999999, color: '#a855f7', label: '> 40k ft', name: 'Stratosphere' }
    ];

    this.tooltip = document.getElementById('radar-tooltip');
    this.setupEvents();
  }

  getAltitudeColor(altFt) {
    if (!altFt || altFt < 10000) return '#10b981'; // Green (<10k)
    if (altFt < 25000) return '#00f0ff';           // Cyan (10k-25k)
    if (altFt < 35000) return '#facc15';           // Yellow (25k-35k)
    if (altFt <= 40000) return '#ef4444';          // Crimson Red (35k-40k)
    return '#a855f7';                              // Electric Violet (>40k)
  }

  setFlights(flights) {
    this.flights = flights || [];
    if (this.selectedFlight) {
      const updated = this.flights.find(f => f.hex === this.selectedFlight.hex);
      if (updated) {
        // If callsign changed (e.g. turnaround/new leg), invalidate previous route details (H5 finding)
        if (this.selectedFlight.callsign && updated.callsign && this.selectedFlight.callsign !== updated.callsign) {
          this.selectedFlightDetails = null;
        }
        this.selectedFlight = updated;
      }
    }
  }

  setSelectedFlight(flight, details = null) {
    this.selectedFlight = flight;
    this.selectedFlightDetails = details;
    if (window.aviationAudio && flight) {
      window.aviationAudio.playFlightSelect();
    }
  }

  setupEvents() {
    let mousePos = [0, 0];

    this.map.canvas.addEventListener('mousemove', (e) => {
      const rect = this.map.canvas.getBoundingClientRect();
      mousePos = [e.clientX - rect.left, e.clientY - rect.top];

      if (this.map.isDragging || (this.map.dragDistance && this.map.dragDistance > 6)) {
        this.hoveredFlight = null;
        this.hideTooltip();
        return;
      }

      let closest = null;
      const zoomRatio = this.map.scale / (this.map.baseScale || 500);
      let minDist = zoomRatio > 1.8 ? 22 : 12;

      for (let i = 0; i < this.visibleFlights.length; i++) {
        const item = this.visibleFlights[i];
        const dx = item.screenX - mousePos[0];
        const dy = item.screenY - mousePos[1];
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) {
          minDist = dist;
          closest = item.flight;
        }
      }

      this.hoveredFlight = closest;
      if (closest) {
        this.map.canvas.style.cursor = 'pointer';
        this.showTooltip(closest, mousePos[0], mousePos[1]);
      } else {
        this.map.canvas.style.cursor = 'default';
        this.hideTooltip();
      }
    });

    this.map.canvas.addEventListener('mouseleave', () => {
      this.hoveredFlight = null;
      this.hideTooltip();
    });

    this.map.canvas.addEventListener('click', (e) => {
      // Suppress click if user was dragging/panning the map (M3 finding)
      if (this.map.isDragging || (this.map.dragDistance && this.map.dragDistance > 6)) return;

      const rect = this.map.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      let clicked = null;
      const zoomRatio = this.map.scale / (this.map.baseScale || 500);
      let minDist = zoomRatio > 1.8 ? 24 : 14;

      for (let i = 0; i < this.visibleFlights.length; i++) {
        const item = this.visibleFlights[i];
        const dx = item.screenX - clickX;
        const dy = item.screenY - clickY;
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) {
          minDist = dist;
          clicked = item.flight;
        }
      }

      if (clicked) {
        window.dispatchEvent(new CustomEvent('flight-selected', { detail: clicked }));
      }
    });
  }

  showTooltip(flight, screenX, screenY) {
    if (!this.tooltip) return;

    const callsign = flight.callsign || flight.hex.toUpperCase();
    const airline = flight.alName || 'Commercial Flight';
    const alt = flight.alt ? `${flight.alt.toLocaleString()} FT` : 'Ground';
    const spd = flight.spd ? `${flight.spd} KTS` : '0 KTS';
    const hdg = flight.hdg ? `${Math.round(flight.hdg)}°` : '0°';
    const color = this.getAltitudeColor(flight.alt);

    this.tooltip.innerHTML = `
      <div class="tooltip-header">
        <span class="tooltip-callsign">${callsign}</span>
        <span class="tooltip-badge" style="background: ${color}25; color: ${color}; border: 1px solid ${color}80;">
          ${alt}
        </span>
      </div>
      <div class="tooltip-airline">${airline}</div>
      <div class="tooltip-meta">
        <span>⚡ ${spd}</span>
        <span>🧭 ${hdg}</span>
        <span>📍 ${flight.country || 'Global'}</span>
      </div>
    `;

    this.tooltip.style.display = 'block';
    
    const pad = 16;
    let left = screenX + pad;
    let top = screenY + pad;

    if (left + 220 > this.map.width) {
      left = screenX - 230;
    }
    if (top + 100 > this.map.height) {
      top = screenY - 110;
    }

    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  hideTooltip() {
    if (this.tooltip) {
      this.tooltip.style.display = 'none';
    }
  }

  // Multi-LOD Dynamic Aircraft Marker Drawing with Forward Scanner Pulse
  drawMarkerLOD(ctx, x, y, angleDeg, zoomRatio, color, isSelected, isHovered, f, now) {
    ctx.save();
    ctx.translate(x, y);

    // Selected Flight Target Halo & Rotating Reticle
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      const r = 20;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r, -r + 6); ctx.lineTo(-r, -r); ctx.lineTo(-r + 6, -r);
      ctx.moveTo(r - 6, -r); ctx.lineTo(r, -r); ctx.lineTo(r, -r + 6);
      ctx.moveTo(r, r - 6); ctx.lineTo(r, r); ctx.lineTo(r - 6, r);
      ctx.moveTo(-r + 6, r); ctx.lineTo(-r, r); ctx.lineTo(-r, r - 6);
      ctx.stroke();
    }

    // Dynamic Focus Dimming: Fade background flights when one is selected
    if (this.selectedFlight && !isSelected && !isHovered) {
      ctx.globalAlpha = 0.20;
    } else if (this.showHeatmap && !isSelected && !isHovered) {
      ctx.globalAlpha = 0.40;
    } else {
      ctx.globalAlpha = 1.0;
    }

    ctx.rotate((angleDeg * Math.PI) / 180);

    const isHighZoom = zoomRatio > 2.0;
    const s = isSelected ? 8.5 : Math.max(2.2, Math.min(10.0, 3.8 * Math.sqrt(zoomRatio)));

    // Active Radar Scanner Pulse Wave when Zoomed In
    if ((isHighZoom || isSelected) && now) {
      const pulseT = (now * 0.0015) % 1.0;
      const ringRad = 4 + pulseT * 14;
      const ringAlpha = (1 - pulseT) * 0.35;

      ctx.beginPath();
      ctx.arc(0, -s * 1.6, ringRad, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(56, 189, 248, ${ringAlpha})`;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }

    // LOD 1: Global View (Zoom < 1.0) - Streamlined Directional Micro-Chevron
    if (zoomRatio < 1.0 && !isSelected && !isHovered) {
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.6);
      ctx.lineTo(s * 0.9, s * 0.8);
      ctx.lineTo(0, s * 0.35);
      ctx.lineTo(-s * 0.9, s * 0.8);
      ctx.closePath();

      ctx.fillStyle = color;
      ctx.fill();
    }
    // LOD 2: Regional View (Zoom 1.0 - 2.0) - Modern Radar Chevron
    else if (!isHighZoom && !isSelected) {
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.5);
      ctx.lineTo(s * 0.35, -s * 0.3);
      ctx.lineTo(s * 1.25, s * 0.35);
      ctx.lineTo(s * 1.05, s * 0.75);
      ctx.lineTo(s * 0.3, s * 0.45);
      ctx.lineTo(s * 0.45, s * 1.2);
      ctx.lineTo(0, s * 0.9);
      ctx.lineTo(-s * 0.45, s * 1.2);
      ctx.lineTo(-s * 0.3, s * 0.45);
      ctx.lineTo(-s * 1.05, s * 0.75);
      ctx.lineTo(-s * 1.25, s * 0.35);
      ctx.lineTo(-s * 0.35, -s * 0.3);
      ctx.closePath();

      ctx.fillStyle = isHovered ? '#ffffff' : color;
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
    // LOD 3: High Zoom or Selected - Clean Aerodynamic Commercial Jet Silhouette
    else {
      if (isSelected || isHovered) {
        ctx.shadowColor = isSelected ? '#38bdf8' : color;
        ctx.shadowBlur = 10;
      }

      ctx.beginPath();
      ctx.moveTo(0, -s * 1.7);
      ctx.bezierCurveTo(s * 0.22, -s * 1.4, s * 0.25, -s * 0.6, s * 0.25, -s * 0.2);
      ctx.lineTo(s * 1.55, s * 0.35);
      ctx.lineTo(s * 1.4, s * 0.75);
      ctx.lineTo(s * 0.25, s * 0.45);
      ctx.lineTo(s * 0.25, s * 1.25);
      ctx.lineTo(s * 0.6, s * 1.55);
      ctx.lineTo(s * 0.45, s * 1.75);
      ctx.lineTo(0, s * 1.45);
      ctx.lineTo(-s * 0.45, s * 1.75);
      ctx.lineTo(-s * 0.6, s * 1.55);
      ctx.lineTo(-s * 0.25, s * 1.25);
      ctx.lineTo(-s * 0.25, s * 0.45);
      ctx.lineTo(-s * 1.4, s * 0.75);
      ctx.lineTo(-s * 1.55, s * 0.35);
      ctx.lineTo(-s * 0.25, -s * 0.2);
      ctx.bezierCurveTo(-s * 0.25, -s * 0.6, -s * 0.22, -s * 1.4, 0, -s * 1.7);
      ctx.closePath();

      ctx.fillStyle = isSelected ? '#ffffff' : color;
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1.0;
      ctx.stroke();

      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  render(timestamp) {
    this.pulsePhase = (timestamp * 0.002) % (2 * Math.PI);
    this.visibleFlights = [];

    const now = performance.now();
    if (!this.lastFrameTime) this.lastFrameTime = now;
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    const base = this.map.baseScale || 500;
    const zoomRatio = (!this.map.scale || isNaN(this.map.scale / base)) ? 1.0 : (this.map.scale / base);
    const isDetailedZoom = zoomRatio > 2.0;

    // Follow camera if tracking
    if (this.isTrackingSelected && this.selectedFlight) {
      const curLat = this.selectedFlight.renderLat || this.selectedFlight.lat;
      const curLon = this.selectedFlight.renderLon || this.selectedFlight.lon;
      if (curLat && curLon) {
        this.map.rotation[0] = -curLon;
        if (this.map.mode === 'globe') {
          this.map.rotation[1] = -curLat;
        }
        this.map.updateProjection();
      }
    }

    // Collect all visible projected flights with Real-Time Motion
    const flightCount = this.flights.length;
    for (let i = 0; i < flightCount; i++) {
      const f = this.flights[i];

      // Smooth real-time continuous movement along heading vector at flight speed (including True North hdg = 0)
      if (f.spd && f.hdg !== undefined && f.hdg !== null && !isNaN(f.hdg) && f.spd > 0) {
        const distDeg = (f.spd / 216000) * dt;
        const radHdg = (f.hdg * Math.PI) / 180;
        const curLat = f.renderLat !== undefined ? f.renderLat : f.lat;
        const curLon = f.renderLon !== undefined ? f.renderLon : f.lon;
        const dLat = distDeg * Math.cos(radHdg);
        const cosLat = Math.cos((curLat * Math.PI) / 180);
        const dLon = distDeg * Math.sin(radHdg) / (cosLat !== 0 ? cosLat : 1);

        f.renderLat = curLat + dLat;
        f.renderLon = curLon + dLon;
      } else {
        f.renderLat = f.lat;
        f.renderLon = f.lon;
      }

      const pt = this.map.project([f.renderLon, f.renderLat]);
      if (!pt) continue;

      const [x, y] = pt;
      if (x < -30 || x > this.map.width + 30 || y < -30 || y > this.map.height + 30) {
        continue;
      }

      this.visibleFlights.push({ flight: f, screenX: x, screenY: y });
    }

    // 1. Render Airspace Density Heatmap (High-Impact Thermal Gradient Layer)
    if (this.showHeatmap) {
      this.renderHeatmap();
    }

    // 2. Render Great Circle Route & Trail for Selected Flight
    if (this.selectedFlight) {
      this.renderSelectedFlightRoute(now);
    }

    // 3. Render Aircraft: Background flights first, then selected flight on top
    let selectedItem = null;
    let hoveredItem = null;

    for (let i = 0; i < this.visibleFlights.length; i++) {
      const item = this.visibleFlights[i];
      const { flight: f, screenX: x, screenY: y } = item;

      const isSelected = this.selectedFlight && this.selectedFlight.hex === f.hex;
      const isHovered = this.hoveredFlight && this.hoveredFlight.hex === f.hex;

      if (isSelected) {
        selectedItem = item;
        continue;
      }
      if (isHovered) {
        hoveredItem = item;
        continue;
      }

      const color = this.getAltitudeColor(f.alt);
      if (f.isFading) this.ctx.globalAlpha = 0.35;
      this.drawMarkerLOD(this.ctx, x, y, f.hdg || 0, zoomRatio, color, false, false, f, now);
      if (f.isFading) this.ctx.globalAlpha = 1.0;

      // Only show badges for background flights if no flight is selected
      if (!this.selectedFlight && isDetailedZoom && f.callsign) {
        this.renderCalloutBadge(x, y, f, color, false, false);
      }
    }

    // Render Hovered Flight on top
    if (hoveredItem && (!selectedItem || hoveredItem.flight.hex !== selectedItem.flight.hex)) {
      const { flight: f, screenX: x, screenY: y } = hoveredItem;
      const color = this.getAltitudeColor(f.alt);
      this.drawMarkerLOD(this.ctx, x, y, f.hdg || 0, zoomRatio, color, false, true, f, now);
      if (f.callsign) this.renderCalloutBadge(x, y, f, color, false, true);
    }

    // Render Selected Flight on absolute top with highest priority
    if (selectedItem) {
      const { flight: f, screenX: x, screenY: y } = selectedItem;
      const color = this.getAltitudeColor(f.alt);
      this.drawMarkerLOD(this.ctx, x, y, f.hdg || 0, zoomRatio, color, true, false, f, now);
      if (f.callsign) this.renderCalloutBadge(x, y, f, color, true, false);
    }

    window.dispatchEvent(new CustomEvent('visible-count-update', {
      detail: { visible: this.visibleFlights.length, total: this.flights.length }
    }));
  }

  // Render Crisp Monospace Callout Badge
  renderCalloutBadge(x, y, flight, color, isSelected, isHovered) {
    const callsign = flight.callsign || flight.hex.toUpperCase();
    const altText = flight.alt > 0 ? `FL${Math.round(flight.alt / 100)}` : 'GND';

    this.ctx.font = isSelected ? 'bold 11px "JetBrains Mono", monospace' : '10px "JetBrains Mono", monospace';
    const textWidth = this.ctx.measureText(callsign).width;
    const badgeW = textWidth + 14;
    const badgeH = 16;
    const bx = x + 14;
    const by = y + 10;

    this.ctx.beginPath();
    this.ctx.roundRect(bx, by, badgeW, badgeH, 4);
    this.ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(8, 15, 30, 0.88)';
    this.ctx.fill();
    this.ctx.strokeStyle = isSelected ? '#38bdf8' : (isHovered ? 'rgba(56, 189, 248, 0.6)' : 'rgba(255, 255, 255, 0.16)');
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    this.ctx.fillStyle = isSelected ? '#ffffff' : (isHovered ? '#38bdf8' : 'rgba(248, 250, 252, 0.9)');
    this.ctx.fillText(callsign, bx + 5, by + 12);

    if (isSelected || isHovered) {
      this.ctx.font = '9px "JetBrains Mono", monospace';
      this.ctx.fillStyle = color;
      this.ctx.fillText(`${altText} • ${flight.spd || 0}kt`, bx + 5, by + 26);
    }
  }

  // Render Geodesic Interpolated Spherical Flight Arcs & Infinite Looping Photon Stream
  renderSelectedFlightRoute(now) {
    try {
      const details = this.selectedFlightDetails;
      const f = this.selectedFlight;
      if (!f) return;

      const curLon = f.renderLon !== undefined ? f.renderLon : f.lon;
      const curLat = f.renderLat !== undefined ? f.renderLat : f.lat;
      const hasLivePos = curLon !== undefined && curLat !== undefined && !(curLat === 0 && curLon === 0) && !isNaN(curLon) && !isNaN(curLat);

      const hasOrigin = details && details.origin && details.origin.lat != null && details.origin.lon != null && !isNaN(Number(details.origin.lat)) && !isNaN(Number(details.origin.lon));
      const hasDest = details && details.destination && details.destination.lat != null && details.destination.lon != null && !isNaN(Number(details.destination.lat)) && !isNaN(Number(details.destination.lon));

      // 1. Render Forward Heading Vector (15 min projection along true flight track)
      if (hasLivePos && f.spd && f.hdg) {
        const p1 = this.map.project([curLon, curLat]);
        if (p1) {
          const distNm = (f.spd / 60) * 12;
          const radHdg = (f.hdg * Math.PI) / 180;
          const dLat = (distNm / 60) * Math.cos(radHdg);
          const cosLat = Math.max(0.001, Math.cos((curLat * Math.PI) / 180));
          const dLon = (distNm / (60 * cosLat)) * Math.sin(radHdg);
          const p2 = this.map.project([curLon + dLon, curLat + dLat]);

          if (p2) {
            this.ctx.beginPath();
            this.ctx.moveTo(p1[0], p1[1]);
            this.ctx.lineTo(p2[0], p2[1]);
            this.ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)';
            this.ctx.lineWidth = 1.6;
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(p2[0], p2[1], 3, 0, 2 * Math.PI);
            this.ctx.fillStyle = '#4ade80';
            this.ctx.fill();
          }
        }
      }

      // 2. Render Full Origin ➔ Aircraft ➔ Destination Route
      if (hasOrigin && hasDest) {
        const orgCoord = [Number(details.origin.lon), Number(details.origin.lat)];
        const dstCoord = [Number(details.destination.lon), Number(details.destination.lat)];
        const numPts = 40;
        let fullRoute = [];

        if (hasLivePos) {
          const curCoord = [curLon, curLat];

          // Flown Geodesic Arc (Origin ➔ Current Aircraft Position)
          const interpFlown = d3.geoInterpolate(orgCoord, curCoord);
          const flownCoords = [];
          for (let i = 0; i <= numPts; i++) {
            flownCoords.push(interpFlown(i / numPts));
          }

          const flownGeo = {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: flownCoords }
          };

          this.ctx.beginPath();
          this.map.path(flownGeo);
          this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
          this.ctx.lineWidth = 2.4;
          this.ctx.stroke();

          // Planned Geodesic Arc (Current Aircraft Position ➔ Destination)
          const interpPlanned = d3.geoInterpolate(curCoord, dstCoord);
          const plannedCoords = [];
          for (let i = 0; i <= numPts; i++) {
            plannedCoords.push(interpPlanned(i / numPts));
          }

          const plannedGeo = {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: plannedCoords }
          };

          this.ctx.beginPath();
          this.map.path(plannedGeo);
          this.ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
          this.ctx.lineWidth = 2.0;
          this.ctx.setLineDash([5, 5]);
          this.ctx.stroke();
          this.ctx.setLineDash([]);

          fullRoute = flownCoords.concat(plannedCoords.slice(1));
        } else {
          // Direct Route Corridor
          const interpDirect = d3.geoInterpolate(orgCoord, dstCoord);
          const directCoords = [];
          for (let i = 0; i <= numPts; i++) {
            directCoords.push(interpDirect(i / numPts));
          }

          const directGeo = {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: directCoords }
          };

          this.ctx.beginPath();
          this.map.path(directGeo);
          this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
          this.ctx.lineWidth = 2.2;
          this.ctx.setLineDash([6, 4]);
          this.ctx.stroke();
          this.ctx.setLineDash([]);

          fullRoute = directCoords;
        }

        // Multi-Photon Pulse Stream
        if (fullRoute.length > 1) {
          const pulseCount = 3;
          const animTime = now || performance.now();

          for (let p = 0; p < pulseCount; p++) {
            const offset = p / pulseCount;
            const pulseT = ((animTime * 0.00028 + offset) % 1.0);
            const ptIdx = Math.min(fullRoute.length - 1, Math.floor(pulseT * fullRoute.length));
            const pulseCoord = fullRoute[ptIdx];
            const pulsePt = this.map.project(pulseCoord);

            if (pulsePt) {
              this.ctx.beginPath();
              this.ctx.arc(pulsePt[0], pulsePt[1], 4.5, 0, 2 * Math.PI);
              this.ctx.fillStyle = '#38bdf8';
              this.ctx.shadowColor = '#38bdf8';
              this.ctx.shadowBlur = 12;
              this.ctx.fill();
              this.ctx.shadowBlur = 0;
            }
          }
        }

        // Origin Airport Pin
        const orgPt = this.map.project(orgCoord);
        if (orgPt) {
          this.ctx.beginPath();
          this.ctx.arc(orgPt[0], orgPt[1], 5.5, 0, 2 * Math.PI);
          this.ctx.fillStyle = '#10b981';
          this.ctx.fill();
          this.ctx.strokeStyle = '#ffffff';
          this.ctx.lineWidth = 1.8;
          this.ctx.stroke();

          this.ctx.font = 'bold 11px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#10b981';
          this.ctx.fillText(`🛫 ${details.origin.iata || details.origin.icao || details.origin.name}`, orgPt[0] + 8, orgPt[1] - 4);
        }

        // Destination Airport Pin
        const dstPt = this.map.project(dstCoord);
        if (dstPt) {
          this.ctx.beginPath();
          this.ctx.arc(dstPt[0], dstPt[1], 5.5, 0, 2 * Math.PI);
          this.ctx.fillStyle = '#f43f5e';
          this.ctx.fill();
          this.ctx.strokeStyle = '#ffffff';
          this.ctx.lineWidth = 1.8;
          this.ctx.stroke();

          this.ctx.font = 'bold 11px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#f43f5e';
          this.ctx.fillText(`🛬 ${details.destination.iata || details.destination.icao || details.destination.name}`, dstPt[0] + 8, dstPt[1] - 4);
        }
      } else if (hasOrigin && hasLivePos) {
        // Flown route from origin only
        const orgCoord = [Number(details.origin.lon), Number(details.origin.lat)];
        const curCoord = [curLon, curLat];
        const interpFlown = d3.geoInterpolate(orgCoord, curCoord);
        const flownCoords = [];
        for (let i = 0; i <= 30; i++) flownCoords.push(interpFlown(i / 30));

        const flownGeo = { type: 'Feature', geometry: { type: 'LineString', coordinates: flownCoords } };
        this.ctx.beginPath();
        this.map.path(flownGeo);
        this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        this.ctx.lineWidth = 2.4;
        this.ctx.stroke();

        const orgPt = this.map.project(orgCoord);
        if (orgPt) {
          this.ctx.beginPath();
          this.ctx.arc(orgPt[0], orgPt[1], 5.5, 0, 2 * Math.PI);
          this.ctx.fillStyle = '#10b981';
          this.ctx.fill();
          this.ctx.strokeStyle = '#ffffff';
          this.ctx.lineWidth = 1.8;
          this.ctx.stroke();
          this.ctx.font = 'bold 11px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#10b981';
          this.ctx.fillText(`🛫 ${details.origin.iata || details.origin.name}`, orgPt[0] + 8, orgPt[1] - 4);
        }
      }
    } catch (err) {
      console.warn('[ROUTE RENDER NOTICE]', err);
    }
  }

  // Global Airspace Density Heatmap (High-Impact Thermal Field)
  renderHeatmap() {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';

    const zoomRatio = this.map.scale / (this.map.baseScale || 500);
    const baseRad = Math.max(22, Math.min(50, 32 * Math.sqrt(zoomRatio)));

    for (let i = 0; i < this.visibleFlights.length; i++) {
      const { screenX, screenY } = this.visibleFlights[i];

      const grad = this.ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, baseRad);
      grad.addColorStop(0, 'rgba(251, 146, 60, 0.45)');
      grad.addColorStop(0.35, 'rgba(56, 189, 248, 0.28)');
      grad.addColorStop(0.7, 'rgba(99, 102, 241, 0.12)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      this.ctx.beginPath();
      this.ctx.arc(screenX, screenY, baseRad, 0, 2 * Math.PI);
      this.ctx.fillStyle = grad;
      this.ctx.fill();
    }

    this.ctx.restore();
  }
}

window.FlightLayer = FlightLayer;
