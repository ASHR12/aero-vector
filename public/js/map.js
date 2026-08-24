// D3 Geo Projection & Cyber-Aviation Map Engine (3D Globe & 2D World Map)
class AviationMap {
  constructor(canvasContainerId) {
    this.container = document.getElementById(canvasContainerId);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    // Dimensions & DPI
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = window.devicePixelRatio || 1;

    // Map Modes: 'globe' (3D Orthographic) | '2d' (Natural Earth 2D)
    this.mode = 'globe';
    this.showNight = true;
    this.showGraticule = true;
    this.showAirports = true;
    this.showCityLights = true;
    this.autoRotate = false;
    this.autoRotateSpeed = 0.08;

    // View state
    this.rotation = [-20, -25, 0];
    this.panY = 0;
    
    // Scale settings (fits both 3D Globe and 2D Map comfortably within headers & footers)
    this.baseScaleGlobe = Math.min(this.width, this.height) * 0.34;
    this.baseScale2D = Math.min(this.width / 6.4, this.height / 3.2) * 0.76;
    this.scale = this.baseScaleGlobe;
    this.minScale = this.baseScaleGlobe * 0.45;
    this.maxScale = this.baseScaleGlobe * 8.0;

    // Inertia & drag physics
    this.isDragging = false;
    this.dragStartPos = null;
    this.dragStartRotation = null;
    this.dragStartPanY = 0;
    this.velocity = [0, 0];
    this.lastDragTime = 0;
    this.lastDragPos = null;

    // Geo datasets
    this.worldData = null;
    this.landGeoJSON = null;
    this.countriesGeoJSON = null;
    this.airports = [];
    this.cityLights = [];

    // Animation / Transitions
    this.targetRotation = null;
    this.targetScale = null;
    this.targetPanY = null;
    this.transitionProgress = 1;

    // Major Equator / Prime Meridian lines
    this.majorLines = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'LineString', coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]] },
        { type: 'LineString', coordinates: [[0, -85], [0, 0], [0, 85]] }
      ]
    };

    // Setup projections
    this.initProjections();
    this.setupEvents();
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  get baseScale() {
    return this.mode === 'globe' ? this.baseScaleGlobe : this.baseScale2D;
  }

  set baseScale(val) {
    if (this.mode === 'globe') this.baseScaleGlobe = val;
    else this.baseScale2D = val;
  }

  initProjections() {
    // 3D Orthographic Globe
    this.projGlobe = d3.geoOrthographic()
      .precision(0.3)
      .clipAngle(90);

    // 2D Natural Earth Projection
    this.proj2D = d3.geoNaturalEarth1()
      .precision(0.3);

    this.activeProj = this.projGlobe;
    this.path = d3.geoPath(this.activeProj, this.ctx);
    this.graticule = d3.geoGraticule10();
  }

  async loadGeoData() {
    try {
      let res = await fetch('/assets/countries-50m.json');
      if (!res.ok) {
        res = await fetch('/assets/countries-110m.json');
      }
      if (res.ok) {
        this.worldData = await res.json();
        if (typeof topojson !== 'undefined') {
          this.landGeoJSON = topojson.feature(this.worldData, this.worldData.objects.land || this.worldData.objects.countries);
          if (this.worldData.objects.countries) {
            this.countriesGeoJSON = topojson.mesh(this.worldData, this.worldData.objects.countries, (a, b) => a !== b);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load world topojson:', e);
    }

    try {
      const cityRes = await fetch('/assets/city-lights.json');
      if (cityRes.ok) {
        this.cityLights = await cityRes.json();
      }
    } catch (e) {}
  }

  setAirports(airportsList) {
    this.airports = airportsList || [];
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;

    if (mode === 'globe') {
      this.activeProj = this.projGlobe;
      this.scale = this.baseScaleGlobe;
      this.minScale = this.baseScaleGlobe * 0.45;
      this.maxScale = this.baseScaleGlobe * 8.0;
      this.panY = 0;
      this.rotation = [-20, -25, 0];
    } else {
      this.activeProj = this.proj2D;
      this.scale = this.baseScale2D;
      this.minScale = this.baseScale2D * 0.45;
      this.maxScale = this.baseScale2D * 8.0;
      this.panY = 0;
      this.rotation = [0, 0, 0];
    }

    this.path = d3.geoPath(this.activeProj, this.ctx);
    this.updateProjection();
  }

  resize() {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.resetTransform();
    this.ctx.scale(this.dpr, this.dpr);

    this.baseScaleGlobe = Math.min(this.width, this.height) * 0.34;
    this.baseScale2D = Math.min(this.width / 6.4, this.height / 3.2) * 0.76;

    if (this.mode === 'globe') {
      this.minScale = this.baseScaleGlobe * 0.45;
      this.maxScale = this.baseScaleGlobe * 8.0;
      if (this.scale < this.minScale) this.scale = this.baseScaleGlobe;
    } else {
      this.minScale = this.baseScale2D * 0.45;
      this.maxScale = this.baseScale2D * 8.0;
      if (this.scale < this.minScale) this.scale = this.baseScale2D;
    }

    this.updateProjection();
  }

  updateProjection() {
    const cx = this.width / 2;
    const cy = this.height / 2;

    if (this.mode === 'globe') {
      this.projGlobe
        .scale(this.scale)
        .translate([cx, cy])
        .rotate(this.rotation);
    } else {
      this.proj2D
        .scale(this.scale)
        .translate([cx, cy + this.panY])
        .rotate([this.rotation[0], 0, 0]);
    }
  }

  // Smooth camera fly-to with easing
  flyTo(lon, lat, targetScale = null) {
    if (this.mode === 'globe') {
      this.targetRotation = [-lon, -lat, 0];
      this.targetPanY = 0;
    } else {
      this.targetRotation = [-lon, 0, 0];
      const latFraction = lat / 90;
      this.targetPanY = latFraction * (this.height * 0.35) * (this.scale / this.baseScale2D);
    }

    if (targetScale) {
      this.targetScale = Math.max(this.minScale, Math.min(this.maxScale, targetScale));
    }
    this.transitionProgress = 0;
  }

  project(coords) {
    if (!this.activeProj || !coords) return null;
    const p = this.activeProj(coords);
    if (!p || isNaN(p[0]) || isNaN(p[1])) return null;

    if (this.mode === 'globe') {
      const r = this.projGlobe.rotate();
      const center = [-r[0], -r[1]];
      const dist = d3.geoDistance(coords, center);
      if (dist > Math.PI / 2 + 0.05) {
        return null;
      }
    }
    return p;
  }

  invert(screenCoords) {
    if (!this.activeProj) return null;
    return this.activeProj.invert(screenCoords);
  }

  setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragDistance = 0;
      this.dragStartPos = [e.clientX, e.clientY];
      this.dragStartRotation = [...this.rotation];
      this.dragStartPanY = this.panY;
      this.velocity = [0, 0];
      this.lastDragPos = [e.clientX, e.clientY];
      this.lastDragTime = performance.now();
      this.targetRotation = null;
      this.targetPanY = null;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;

      const dx = e.clientX - this.dragStartPos[0];
      const dy = e.clientY - this.dragStartPos[1];
      this.dragDistance = Math.hypot(dx, dy);
      const now = performance.now();
      const dt = Math.max(1, now - this.lastDragTime);

      const k = 180 / (this.scale * Math.PI);

      if (this.mode === 'globe') {
        const newLon = this.dragStartRotation[0] + dx * k;
        const newLat = Math.max(-85, Math.min(85, this.dragStartRotation[1] - dy * k));
        this.rotation = [newLon, newLat, 0];
      } else {
        const newLon = this.dragStartRotation[0] + dx * k;
        this.rotation = [newLon, 0, 0];
        const maxPanY = this.height * 1.5 * (this.scale / this.baseScale2D);
        this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.dragStartPanY + dy));
      }

      const vx = (e.clientX - this.lastDragPos[0]) / dt;
      const vy = (e.clientY - this.lastDragPos[1]) / dt;
      this.velocity = [vx * 4, vy * 4];

      this.lastDragPos = [e.clientX, e.clientY];
      this.lastDragTime = now;
      this.updateProjection();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Zoom via mouse wheel
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * zoomFactor));
      this.scale = newScale;
      this.updateProjection();
    }, { passive: false });

    // Touch support with drag suppression
    let touchStartDist = 0;
    this.canvas.addEventListener('touchstart', (e) => {
      this.dragDistance = 0;
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.dragStartPos = [e.touches[0].clientX, e.touches[0].clientY];
        this.dragStartRotation = [...this.rotation];
        this.dragStartPanY = this.panY;
        this.velocity = [0, 0];
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        this.dragDistance = 100; // Pinch gesture is always a drag
        touchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.dragStartPos[0];
        const dy = e.touches[0].clientY - this.dragStartPos[1];
        this.dragDistance = Math.hypot(dx, dy);
        const k = 180 / (this.scale * Math.PI);
        if (this.mode === 'globe') {
          this.rotation = [
            this.dragStartRotation[0] + dx * k,
            Math.max(-85, Math.min(85, this.dragStartRotation[1] - dy * k)),
            0
          ];
        } else {
          this.rotation = [this.dragStartRotation[0] + dx * k, 0, 0];
          const maxPanY = this.height * 1.5 * (this.scale / this.baseScale2D);
          this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.dragStartPanY + dy));
        }
        this.updateProjection();
      } else if (e.touches.length === 2) {
        this.dragDistance = 100;
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = dist / touchStartDist;
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
        touchStartDist = dist;
        this.updateProjection();
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', () => {
      this.isDragging = false;
    });
  }

  updateAndRenderBackground(time) {
    // 1. Auto-rotation (Globe mode)
    if (this.autoRotate && !this.isDragging && !this.targetRotation) {
      this.rotation[0] += this.autoRotateSpeed;
      this.updateProjection();
    }

    // 2. Inertia physics
    if (!this.isDragging && (Math.abs(this.velocity[0]) > 0.05 || Math.abs(this.velocity[1]) > 0.05)) {
      const k = 180 / (this.scale * Math.PI);
      this.rotation[0] += this.velocity[0] * k * 0.1;
      if (this.mode === 'globe') {
        this.rotation[1] = Math.max(-85, Math.min(85, this.rotation[1] - this.velocity[1] * k * 0.1));
      } else {
        const maxPanY = this.height * 1.5 * (this.scale / this.baseScale2D);
        this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY + this.velocity[1] * 0.2));
      }
      this.velocity[0] *= 0.92;
      this.velocity[1] *= 0.92;
      this.updateProjection();
    }

    // 3. Smooth FlyTo Transition
    if (this.targetRotation && this.transitionProgress < 1) {
      this.transitionProgress += 0.04;

      let dLon = this.targetRotation[0] - this.rotation[0];
      while (dLon > 180) dLon -= 360;
      while (dLon < -180) dLon += 360;

      this.rotation[0] += dLon * 0.08;
      if (this.mode === 'globe') {
        this.rotation[1] += (this.targetRotation[1] - this.rotation[1]) * 0.08;
      }

      if (this.targetPanY !== null) {
        this.panY += (this.targetPanY - this.panY) * 0.08;
      }

      if (this.targetScale) {
        this.scale += (this.targetScale - this.scale) * 0.08;
      }

      if (this.transitionProgress >= 1) {
        this.targetRotation = null;
        this.targetScale = null;
        this.targetPanY = null;
      }
      this.updateProjection();
    }

    // Clean background fill
    this.ctx.fillStyle = '#020611';
    this.ctx.fillRect(0, 0, this.width, this.height);

    const cx = this.width / 2;
    const cy = this.height / 2;

    // Render Globe Atmosphere / Oceans
    if (this.mode === 'globe') {
      const radius = this.scale;

      // Outer atmospheric Rayleigh rim glow
      const glowGrad = this.ctx.createRadialGradient(cx, cy, radius * 0.96, cx, cy, radius * 1.28);
      glowGrad.addColorStop(0, 'rgba(56, 189, 248, 0.32)');
      glowGrad.addColorStop(0.3, 'rgba(14, 165, 233, 0.15)');
      glowGrad.addColorStop(0.65, 'rgba(3, 105, 161, 0.04)');
      glowGrad.addColorStop(1, 'rgba(3, 105, 161, 0)');

      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius * 1.28, 0, 2 * Math.PI);
      this.ctx.fillStyle = glowGrad;
      this.ctx.fill();

      // Deep vibrant obsidian ocean sphere
      const oceanGrad = this.ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.35, radius * 0.08, cx, cy, radius);
      oceanGrad.addColorStop(0, '#0a1628');
      oceanGrad.addColorStop(0.65, '#060e1c');
      oceanGrad.addColorStop(1, '#020612');

      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      this.ctx.fillStyle = oceanGrad;
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
    } else {
      // 2D Map outline and background
      this.ctx.beginPath();
      this.path({ type: 'Sphere' });
      this.ctx.fillStyle = '#060e1e';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      this.ctx.lineWidth = 1.2;
      this.ctx.stroke();
    }

    // Render Graticule (Lat/Lon Grid)
    if (this.showGraticule) {
      this.ctx.beginPath();
      this.path(this.graticule);
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      this.ctx.lineWidth = 0.7;
      this.ctx.stroke();

      this.ctx.beginPath();
      this.path(this.majorLines);
      this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
      this.ctx.lineWidth = 1.1;
      this.ctx.stroke();
    }

    // Render Landmasses
    if (this.landGeoJSON) {
      this.ctx.beginPath();
      this.path(this.landGeoJSON);
      this.ctx.fillStyle = '#111d30';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      this.ctx.lineWidth = 0.9;
      this.ctx.stroke();
    }

    // Render Country Boundaries
    if (this.countriesGeoJSON) {
      this.ctx.beginPath();
      this.path(this.countriesGeoJSON);
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      this.ctx.lineWidth = 0.5;
      this.ctx.stroke();
    }

    // Render City Night Lights
    if (this.showCityLights && this.cityLights.length > 0) {
      this.renderCityLights();
    }

    // Render Day / Night Terminator Shadow
    if (this.showNight && window.SolarCalculator) {
      const nightGeo = SolarCalculator.getNightPolygon(new Date());
      if (nightGeo) {
        this.ctx.beginPath();
        this.path(nightGeo);
        this.ctx.fillStyle = 'rgba(2, 6, 20, 0.52)';
        this.ctx.fill();
        this.ctx.strokeStyle = 'rgba(251, 146, 60, 0.3)';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      }
    }

    // Render Major World Airport Hubs
    if (this.showAirports && this.airports.length > 0 && this.scale > 350) {
      this.renderAirports();
    }
  }

  renderCityLights() {
    this.ctx.save();
    const baseScale = this.baseScale;

    for (const [lon, lat, intensity] of this.cityLights) {
      const pt = this.project([lon, lat]);
      if (!pt) continue;

      const [x, y] = pt;
      const rad = Math.max(1.5, Math.min(3.5, 2.0 * (this.scale / baseScale)));

      this.ctx.beginPath();
      this.ctx.arc(x, y, rad, 0, 2 * Math.PI);
      this.ctx.fillStyle = `rgba(251, 191, 36, ${0.55 * intensity})`;
      this.ctx.shadowColor = '#fbbf24';
      this.ctx.shadowBlur = 5;
      this.ctx.fill();
    }
    this.ctx.shadowBlur = 0;
    this.ctx.restore();
  }

  renderAirports() {
    for (const apt of this.airports) {
      const pt = this.project([apt.lon, apt.lat]);
      if (!pt) continue;

      const [x, y] = pt;
      this.ctx.beginPath();
      this.ctx.arc(x, y, 2.2, 0, 2 * Math.PI);
      this.ctx.fillStyle = 'rgba(147, 197, 253, 0.75)';
      this.ctx.fill();

      if (this.scale > 800) {
        this.ctx.font = '9px "JetBrains Mono", monospace';
        this.ctx.fillStyle = 'rgba(147, 197, 253, 0.9)';
        this.ctx.fillText(apt.iata, x + 5, y - 3);
      }
    }
  }
}

window.AviationMap = AviationMap;
