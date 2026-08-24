// Client-side API layer for Live ADS-B Data Streaming
class FlightAPI {
  constructor() {
    this.flights = [];
    this.flightsByHex = new Map();
    this.stats = null;
    this.airlines = [];
    this.airports = [];
    this.lastUpdated = 0;
    this.isPolling = false;
    this.pollIntervalMs = 9000;
    this.pollTimer = null;
    this.countdownSeconds = 9;
    this.countdownTimer = null;
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      for (const cb of list) {
        try { cb(data); } catch (e) { console.error('Event error:', e); }
      }
    }
  }

  async fetchAirlines() {
    try {
      const res = await fetch('/api/airlines');
      if (res.ok) {
        const data = await res.json();
        this.airlines = data.airlines || [];
        this.emit('airlines', this.airlines);
      }
    } catch (e) {
      console.warn('Failed to fetch airlines:', e);
    }
  }

  async fetchAirports() {
    try {
      const res = await fetch('/api/airports');
      if (res.ok) {
        this.airports = await res.json();
        this.emit('airports', this.airports);
      }
    } catch (e) {
      console.warn('Failed to fetch airports:', e);
    }
  }

  async fetchStats() {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) {
        this.stats = await res.json();
        this.emit('stats', this.stats);
      }
    } catch (e) {
      console.warn('Failed to fetch stats:', e);
    }
  }

  async fetchFlights(filters = {}) {
    this.activeFilters = filters;
    this.flightFetchSeq = (this.flightFetchSeq || 0) + 1;
    const currentSeq = this.flightFetchSeq;

    if (this.flightAbortController) {
      try { this.flightAbortController.abort(); } catch (e) {}
    }
    this.flightAbortController = new AbortController();

    try {
      const params = new URLSearchParams();
      if (filters.airline) params.append('airline', filters.airline);
      if (filters.minAlt !== undefined) params.append('minAlt', filters.minAlt);
      if (filters.maxAlt !== undefined) params.append('maxAlt', filters.maxAlt);
      if (filters.search) params.append('search', filters.search);
      if (filters.category && filters.category !== 'all') params.append('category', filters.category);

      const res = await fetch(`/api/flights?${params.toString()}`, { signal: this.flightAbortController.signal });
      if (res.ok) {
        // Guard against out-of-order execution (H6 finding)
        if (currentSeq !== this.flightFetchSeq) return;

        const data = await res.json();
        const incoming = data.flights || [];
        const newMap = new Map();

        // Smooth transition: Preserve previous render coords for interpolation (No snap-back)
        for (const f of incoming) {
          const targetLat = f.curLat !== undefined ? f.curLat : f.lat;
          const targetLon = f.curLon !== undefined ? f.curLon : f.lon;
          const old = this.flightsByHex.get(f.hex);
          if (old) {
            f.prevLat = old.renderLat || old.curLat || old.lat;
            f.prevLon = old.renderLon || old.curLon || old.lon;
            f.renderLat = old.renderLat || targetLat;
            f.renderLon = old.renderLon || targetLon;
            f.animStartTime = performance.now();
          } else {
            f.prevLat = targetLat;
            f.prevLon = targetLon;
            f.renderLat = targetLat;
            f.renderLon = targetLon;
            f.animStartTime = performance.now();
          }
          newMap.set(f.hex, f);
        }

        this.flights = incoming;
        this.flightsByHex = newMap;
        this.lastUpdated = data.lastUpdate || Date.now();

        this.emit('flights', {
          flights: this.flights,
          totalGlobal: data.totalGlobal,
          count: data.count,
          timestamp: data.timestamp,
          sourceTimestamp: data.sourceTimestamp,
          feedStatus: data.feedStatus,
          isDegraded: data.isDegraded
        });

        // Trigger stats refresh in tandem
        this.fetchStats();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Flight fetch failed:', err);
      }
    }
  }

  async getFlightDetails(callsign, hex) {
    try {
      const params = new URLSearchParams();
      if (callsign) params.append('callsign', callsign);
      if (hex) params.append('hex', hex);

      const res = await fetch(`/api/flights/details?${params.toString()}`);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error('Failed to get flight details:', e);
    }
    return null;
  }

  startPolling(filters = {}) {
    if (this.isPolling) return;
    this.isPolling = true;
    this.activeFilters = filters;

    // Immediate first fetch
    this.fetchFlights(this.activeFilters);
    this.fetchAirlines();
    this.fetchAirports();
    this.fetchStats();

    // Reset countdown
    this.countdownSeconds = Math.round(this.pollIntervalMs / 1000);
    this.countdownTimer = setInterval(() => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0) {
        this.countdownSeconds = Math.round(this.pollIntervalMs / 1000);
      }
      this.emit('countdown', this.countdownSeconds);
    }, 1000);

    // Regular polling using active filters
    this.pollTimer = setInterval(() => {
      this.fetchFlights(this.activeFilters);
    }, this.pollIntervalMs);
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  }
}

window.flightAPI = new FlightAPI();
