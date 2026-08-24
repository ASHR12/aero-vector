require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Global Exception & Rejection Handlers (Never allow crash)
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load static databases
const dataDir = path.join(__dirname, 'data');
let airports = {};
let airportsList = [];
let airlines = { icao: {}, iata: {} };
let routes = {};
let aircraftTypes = {};
let flightSchedules = {};

// In-memory live state
let liveFlights = [];
let flightsByHex = new Map();
let lastFetchTime = 0;
let lastFetchSourceTime = 0;
let isSnapshotFallback = true;
let feedStatus = 'INITIALIZING';
let isFetching = false;
let totalMessagesReceived = 0;
let positionHistory = new Map(); // hex -> Array of { lat, lon, alt, ts }

// Route and aircraft detail caches with short TTL
const routeDetailCache = new Map(); // key -> { data, expiresAt }
const aircraftDetailCache = new Map();

// Known Cargo Airlines ICAO codes
const CARGO_AIRLINES = new Set([
  'FDX', 'UPS', 'GTI', 'CLX', 'ABX', 'BOX', 'CKS', 'ATN', 'CJT', 'PAC', 'SQC',
  'MPH', 'ETH', 'TAY', 'BCS', 'AZG', 'GEC', 'ABD', 'ICV', 'NCR', 'KFS'
]);

let airportsByIcao = new Map();
let spaceports = [];

// AirLabs API Key for 100% verified on-demand flight schedule & route details
const AIRLABS_API_KEY = process.env.AIRLABS_API_KEY || '';
const { 
  getCachedFlight, 
  setCachedFlight, 
  getAllCachedFlights, 
  clearCache: clearDbCache, 
  getDailyApiUsage, 
  incrementDailyApiUsage,
  getCachedSpaceLaunches,
  setCachedSpaceLaunches,
  isSpaceLaunchCacheFresh
} = require('./data/db.js');
let airlabsQueryCount = 0;

try {
  if (fs.existsSync(path.join(dataDir, 'airports.json'))) {
    airports = JSON.parse(fs.readFileSync(path.join(dataDir, 'airports.json'), 'utf8'));
  }
  if (fs.existsSync(path.join(dataDir, 'airports-list.json'))) {
    airportsList = JSON.parse(fs.readFileSync(path.join(dataDir, 'airports-list.json'), 'utf8'));
    for (const a of airportsList) {
      if (a.icao) airportsByIcao.set(a.icao.toUpperCase(), a);
      if (a.iata) airportsByIcao.set(a.iata.toUpperCase(), a);
    }
  }
  if (fs.existsSync(path.join(dataDir, 'airlines.json'))) {
    airlines = JSON.parse(fs.readFileSync(path.join(dataDir, 'airlines.json'), 'utf8'));
  }
  if (fs.existsSync(path.join(dataDir, 'routes.json'))) {
    routes = JSON.parse(fs.readFileSync(path.join(dataDir, 'routes.json'), 'utf8'));
  }
  if (fs.existsSync(path.join(dataDir, 'aircraft-types.json'))) {
    aircraftTypes = JSON.parse(fs.readFileSync(path.join(dataDir, 'aircraft-types.json'), 'utf8'));
  }
  if (fs.existsSync(path.join(dataDir, 'spaceports.json'))) {
    spaceports = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaceports.json'), 'utf8'));
  }
  console.log(`[DB] Loaded ${Object.keys(airports).length} airports, ${airportsByIcao.size} ICAO airport lookups, ${Object.keys(airlines.icao || {}).length} airlines, ${spaceports.length} global spaceports`);

  // Load baseline flight snapshot for graceful fallback when OpenSky is 429 rate limited
  const snapshotPath = path.join(dataDir, 'flights-snapshot.json');
  if (fs.existsSync(snapshotPath)) {
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (Array.isArray(snap) && snap.length > 0) {
      liveFlights = snap;
      for (const f of snap) {
        flightsByHex.set(f.hex, f);
      }
      isSnapshotFallback = true;
      feedStatus = 'SNAPSHOT_FALLBACK';
      totalMessagesReceived = snap.length;
      console.log(`[RADAR] Loaded ${snap.length} baseline snapshot flights for fallback.`);
    }
  }
} catch (e) {
  console.error('[DB] Error loading static data:', e.message);
}

// Helper: Calculate distance in NM between two coordinates
function getDistanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // NM
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Global Airport Resolver with Fallback for New/Regional Airports and Fuzzy City Names
function resolveAirportWithFallback(iata, icao, name, city, country, explicitLat, explicitLon) {
  const cleanIata = (iata || '').trim().toUpperCase();
  const cleanIcao = (icao || '').trim().toUpperCase();

  // Known recent / regional airports
  const customAirports = {
    'NMI': { iata: 'NMI', icao: 'VANM', name: 'Navi Mumbai International Airport', city: 'Navi Mumbai', country: 'India', lat: 18.9902, lon: 73.0722, alt: 19 },
    'VANM': { iata: 'NMI', icao: 'VANM', name: 'Navi Mumbai International Airport', city: 'Navi Mumbai', country: 'India', lat: 18.9902, lon: 73.0722, alt: 19 },
    'DXN': { iata: 'DXN', icao: 'VIND', name: 'Noida International Airport', city: 'Jewar / Noida', country: 'India', lat: 28.1883, lon: 77.5683, alt: 660 },
    'VIND': { iata: 'DXN', icao: 'VIND', name: 'Noida International Airport', city: 'Jewar / Noida', country: 'India', lat: 28.1883, lon: 77.5683, alt: 660 },
    'GOX': { iata: 'GOX', icao: 'VOGA', name: 'Manohar International Airport', city: 'Mopa / Goa', country: 'India', lat: 15.7333, lon: 73.8667, alt: 550 },
    'VOGA': { iata: 'GOX', icao: 'VOGA', name: 'Manohar International Airport', city: 'Mopa / Goa', country: 'India', lat: 15.7333, lon: 73.8667, alt: 550 },
    'HDO': { iata: 'HDO', icao: 'VIDX', name: 'Hindon Airport', city: 'Ghaziabad / Delhi', country: 'India', lat: 28.7058, lon: 77.3592, alt: 700 },
    'VIDX': { iata: 'HDO', icao: 'VIDX', name: 'Hindon Airport', city: 'Ghaziabad / Delhi', country: 'India', lat: 28.7058, lon: 77.3592, alt: 700 }
  };
  if (cleanIata && customAirports[cleanIata]) return customAirports[cleanIata];
  if (cleanIcao && customAirports[cleanIcao]) return customAirports[cleanIcao];

  // Direct IATA lookup
  if (cleanIata && airports[cleanIata] && airports[cleanIata].lat !== undefined) {
    return airports[cleanIata];
  }
  // Direct ICAO lookup
  if (cleanIcao && airportsByIcao.has(cleanIcao) && airportsByIcao.get(cleanIcao).lat !== undefined) {
    return airportsByIcao.get(cleanIcao);
  }

  // Explicit valid coordinates
  if (explicitLat !== undefined && explicitLat !== null && !isNaN(Number(explicitLat)) &&
      explicitLon !== undefined && explicitLon !== null && !isNaN(Number(explicitLon))) {
    return {
      iata: cleanIata,
      icao: cleanIcao,
      name: name || city || cleanIata || cleanIcao,
      city: city || name || '',
      country: country || '',
      lat: Number(explicitLat),
      lon: Number(explicitLon)
    };
  }

  // Fuzzy match by city name
  if (city) {
    const cleanCity = city.toLowerCase().trim();
    const match = airportsList.find(a => a.lat && a.city && (a.city.toLowerCase() === cleanCity || cleanCity.includes(a.city.toLowerCase()) || a.city.toLowerCase().includes(cleanCity)));
    if (match) {
      return {
        iata: cleanIata || match.iata,
        icao: cleanIcao || match.icao,
        name: name || match.name,
        city: city || match.city,
        country: country || match.country,
        lat: match.lat,
        lon: match.lon,
        alt: match.alt
      };
    }
  }

  // If city is Navi Mumbai or Mumbai area
  if (city && city.toLowerCase().includes('mumbai')) {
    return {
      iata: cleanIata || 'NMI',
      icao: cleanIcao || 'VANM',
      name: name || 'Navi Mumbai International Airport',
      city: 'Navi Mumbai',
      country: 'India',
      lat: 18.9902,
      lon: 73.0722,
      alt: 19
    };
  }

  return {
    iata: cleanIata,
    icao: cleanIcao,
    name: name || city || cleanIata || cleanIcao,
    city: city || name || '',
    country: country || '',
    lat: null,
    lon: null
  };
}

// Helper: Great Circle intermediate points
function calculateGreatCirclePoints(lat1, lon1, lat2, lon2, numPoints = 50) {
  const points = [];
  const rad = Math.PI / 180;
  const phi1 = lat1 * rad;
  const lambda1 = lon1 * rad;
  const phi2 = lat2 * rad;
  const lambda2 = lon2 * rad;

  const d = 2 * Math.asin(Math.sqrt(
    Math.pow(Math.sin((phi1 - phi2) / 2), 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.pow(Math.sin((lambda1 - lambda2) / 2), 2)
  ));

  if (d === 0 || isNaN(d)) return [[lon1, lat1], [lon2, lat2]];

  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
    const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    const phi = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lambda = Math.atan2(y, x);
    points.push([lambda / rad, phi / rad]);
  }
  return points;
}

function calculateBearing(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const phi1 = lat1 * rad;
  const phi2 = lat2 * rad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

function resolveFlightRoute(f, estDepIcao, estArrIcao) {
  if (!f) return { origin: null, destination: null };
  const cleanCallsign = (f.callsign || '').trim().toUpperCase();
  const icaoPrefix = cleanCallsign.substring(0, 3);
  const airlineIata = (airlines.icao && airlines.icao[icaoPrefix] && airlines.icao[icaoPrefix].iata) || '';
  const airlineRoutes = (airlineIata && routes[airlineIata]) || (icaoPrefix && routes[icaoPrefix]) || [];

  let origin = null;
  let destination = null;

  if (estDepIcao && airportsByIcao.has(estDepIcao.toUpperCase())) {
    origin = airportsByIcao.get(estDepIcao.toUpperCase());
  }
  if (estArrIcao && airportsByIcao.has(estArrIcao.toUpperCase())) {
    destination = airportsByIcao.get(estArrIcao.toUpperCase());
  }

  const curLat = f.curLat || f.lat;
  const curLon = f.curLon || f.lon;
  const curHdg = f.hdg;

  const megaHubs = new Set(["DEL", "BOM", "BLR", "HYD", "CCU", "MAA", "LHR", "JFK", "DXB", "SIN", "CDG", "FRA", "HND", "ORD", "LAX", "AMS", "IST", "DOH"]);
  const regionalHubs = new Set(["AMD", "COK", "GOI", "GOX", "JAI", "LKO", "PAT", "IXC", "SXR", "GAU", "ATQ", "VNS", "BBI", "PNQ", "IXM", "DED"]);

  // If origin is detected by OpenSky, match destination from airline routes along plane heading vector
  if (origin && !destination && curLat && curLon && curHdg) {
    const candidates = [];
    const orgCode = origin.iata || origin.icao;
    for (const r of airlineRoutes) {
      if (r.src !== orgCode) continue;
      const dstApt = airports[r.dst] || airportsByIcao.get(r.dst);
      if (!dstApt) continue;

      const totalDist = getDistanceNm(origin.lat, origin.lon, dstApt.lat, dstApt.lon);
      const dPlaneToDst = getDistanceNm(curLat, curLon, dstApt.lat, dstApt.lon);

      // Cruising jet at FL280+ without descent rate cannot land within 160 NM
      if (f.alt > 28000 && dPlaneToDst < 160 && (!f.vr || f.vr > -1000)) continue;

      const planeToDstBearing = calculateBearing(curLon, curLat, dstApt.lon, dstApt.lat);
      const hdgDiff = Math.abs((planeToDstBearing - curHdg + 540) % 360 - 180);

      if (hdgDiff < 45) {
        let score = hdgDiff;
        if (megaHubs.has(r.dst)) score -= 15;
        else if (regionalHubs.has(r.dst)) score -= 8;
        candidates.push({ dstApt, score, hdgDiff, totalDist });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.score - b.score);
      destination = candidates[0].dstApt;
    }
  }

  // If either origin or destination still missing, match airline active flight corridor
  if ((!origin || !destination) && curLat && curLon && curHdg) {
    const candidateCorridors = [];
    for (const r of airlineRoutes) {
      const srcApt = airports[r.src] || airportsByIcao.get(r.src);
      const dstApt = airports[r.dst] || airportsByIcao.get(r.dst);
      if (!srcApt || !dstApt) continue;

      const totalDist = getDistanceNm(srcApt.lat, srcApt.lon, dstApt.lat, dstApt.lon);
      if (totalDist < 100) continue;

      const dSrc = getDistanceNm(srcApt.lat, srcApt.lon, curLat, curLon);
      const dDst = getDistanceNm(curLat, curLon, dstApt.lat, dstApt.lon);
      const stretch = (dSrc + dDst) / totalDist;
      if (stretch > 1.35) continue;

      // Cruising jet at FL280+ cannot land within 160 NM
      if (f.alt > 28000 && dDst < 160 && (!f.vr || f.vr > -1000)) continue;

      const planeToDst = calculateBearing(curLon, curLat, dstApt.lon, dstApt.lat);
      const dstHdgDiff = Math.abs((planeToDst - curHdg + 540) % 360 - 180);
      const srcToPlane = calculateBearing(srcApt.lon, srcApt.lat, curLon, curLat);
      const srcHdgDiff = Math.abs((srcToPlane - curHdg + 540) % 360 - 180);

      if (dstHdgDiff < 35 && srcHdgDiff < 35) {
        let score = (dstHdgDiff * 3) + (srcHdgDiff * 3) + ((stretch - 1) * 100);
        if (megaHubs.has(r.dst)) score -= 20;
        else if (regionalHubs.has(r.dst)) score -= 10;
        candidateCorridors.push({ srcApt, dstApt, score, totalDist });
      }
    }

    if (candidateCorridors.length > 0) {
      candidateCorridors.sort((a, b) => a.score - b.score);
      if (!origin) origin = candidateCorridors[0].srcApt;
      if (!destination) destination = candidateCorridors[0].dstApt;
    }
  }

  // Geographic regional major airport matching fallback
  if (!origin && curLat && curLon) {
    let nearest = null;
    let minDist = Infinity;
    for (const a of airportsList) {
      if (!a.lat || !a.lon) continue;
      const d = getDistanceNm(a.lat, a.lon, curLat, curLon);
      if (d < minDist && d > 10) {
        const bearing = calculateBearing(a.lon, a.lat, curLon, curLat);
        const hdgDiff = Math.abs((bearing - curHdg + 540) % 360 - 180);
        if (hdgDiff < 50) {
          minDist = d;
          nearest = a;
        }
      }
    }
    if (nearest) origin = nearest;
  }

  if (!destination && curLat && curLon) {
    let nearest = null;
    let minDist = Infinity;
    for (const a of airportsList) {
      if (!a.lat || !a.lon) continue;
      const d = getDistanceNm(curLat, curLon, a.lat, a.lon);
      if (d < minDist && d > 30) {
        const bearing = calculateBearing(curLon, curLat, a.lon, a.lat);
        const hdgDiff = Math.abs((bearing - curHdg + 540) % 360 - 180);
        if (hdgDiff < 45) {
          minDist = d;
          nearest = a;
        }
      }
    }
    if (nearest) destination = nearest;
  }

  return { origin, destination };
}

const MILITARY_PREFIXES = [
  'RCH', 'SAM', 'PAT', 'ASY', 'RRR', 'CFC', 'IAM', 'FAF', 'GAF', 'BAF',
  'HAF', 'NAF', 'SVF', 'TUR', 'IFC', 'CNV', 'NVY', 'ARMY', 'USAF', 'REACH',
  'VALK', 'VIPER', 'TOPGN', 'COBRA', 'HAWK', 'EVAC', 'MEDEV', 'BMBER', 'GUARD',
  'JASDF', 'ROKAF', 'PLAAF', 'RAAF', 'RNZAF', 'FORTE', 'HOMER', 'LAGR', 'NCHO',
  'SNOOP', 'TITAN', 'BOMBER', 'JAKE', 'DUKE', 'MACHO', 'SWIFT', 'CHAOS', 'REAPER',
  'DOOM', 'DEATH', 'GHOST', 'WARLOCK'
];

// Identify airline from callsign
function extractAirlineInfo(callsign) {
  if (!callsign) return { code: '', name: 'General / Private Aviation', country: '' };
  const clean = callsign.trim().toUpperCase();

  // Check known military aviation prefixes
  for (const p of MILITARY_PREFIXES) {
    if (clean.startsWith(p)) {
      return {
        code: 'MIL',
        name: 'Military / Defense Ops',
        country: 'Military',
        callsign: 'MILITARY'
      };
    }
  }
  
  if (clean.length >= 3) {
    const icaoPrefix = clean.substring(0, 3);
    if (airlines.icao && airlines.icao[icaoPrefix]) {
      return {
        code: icaoPrefix,
        name: airlines.icao[icaoPrefix].name,
        country: airlines.icao[icaoPrefix].country,
        callsign: airlines.icao[icaoPrefix].callsign
      };
    }
  }

  if (clean.length >= 2) {
    const iataPrefix = clean.substring(0, 2);
    if (airlines.iata && airlines.iata[iataPrefix]) {
      return {
        code: iataPrefix,
        name: airlines.iata[iataPrefix].name,
        country: airlines.iata[iataPrefix].country,
        callsign: airlines.iata[iataPrefix].callsign
      };
    }
  }

  return { code: '', name: 'General / Private Aviation', country: '' };
}

// Emergency Squawk decoding
function decodeSquawk(squawk) {
  if (!squawk) return null;
  const s = String(squawk).trim();
  if (s === '7500') return { code: s, level: 'critical', desc: 'HIJACKING / UNLAWFUL INTERFERENCE' };
  if (s === '7600') return { code: s, level: 'warning', desc: 'RADIO FAILURE / LOST COMM' };
  if (s === '7700') return { code: s, level: 'emergency', desc: 'GENERAL EMERGENCY' };
  if (s === '1200') return { code: s, level: 'vfr', desc: 'Standard VFR (USA)' };
  if (s === '7000') return { code: s, level: 'vfr', desc: 'Standard VFR (Europe)' };
  return { code: s, level: 'normal', desc: 'Active Transponder' };
}

let openskyAccessToken = null;
let openskyTokenExpiry = 0;
let openskyCredentials = null;

if (process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET) {
  openskyCredentials = {
    clientId: process.env.OPENSKY_CLIENT_ID,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET
  };
  console.log('[AUTH] Loaded OpenSky API Client credentials from environment variables.');
} else {
  try {
    const credPath = path.join(dataDir, 'opensky-credentials.json');
    if (fs.existsSync(credPath)) {
      openskyCredentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      console.log('[AUTH] Loaded OpenSky API Client credentials from local file.');
    }
  } catch (e) {
    console.warn('[AUTH] Could not load OpenSky credentials:', e.message);
  }
}

async function getOpenSkyAccessToken() {
  if (!openskyCredentials || !openskyCredentials.clientId || !openskyCredentials.clientSecret) {
    return null;
  }
  const now = Date.now();
  if (openskyAccessToken && now < openskyTokenExpiry - 60000) {
    return openskyAccessToken;
  }

  try {
    const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: openskyCredentials.clientId,
        client_secret: openskyCredentials.clientSecret
      })
    });

    if (res.ok) {
      const data = await res.json();
      openskyAccessToken = data.access_token;
      openskyTokenExpiry = now + ((data.expires_in || 1800) * 1000);
      console.log(`[AUTH] Successfully refreshed OpenSky OAuth2 token (valid for ${data.expires_in}s).`);
      return openskyAccessToken;
    } else {
      const errText = await res.text();
      console.warn('[AUTH] OpenSky token error:', errText);
    }
  } catch (err) {
    console.warn('[AUTH] OpenSky token request failed:', err.message);
  }
  return null;
}

let nextAllowedFetch = 0;
let currentBackoffMs = 120000;
const bootTimeSec = Math.floor(Date.now() / 1000);
const negativeLookups = new Map();

// Fetch global flight data from OpenSky (Authenticated 100% Free Live Stream)
async function fetchGlobalFlights() {
  if (isFetching || Date.now() < nextAllowedFetch) return;
  isFetching = true;
  const start = Date.now();

  try {
    const token = await getOpenSkyAccessToken();
    const headers = {
      'User-Agent': 'AeroVector-LiveAviationTracker/1.0'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const response = await fetch('https://opensky-network.org/api/states/all', {
      signal: controller.signal,
      headers
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      const rawStates = data.states || [];
      const timestamp = data.time || Math.floor(Date.now() / 1000);

      const parsedFlights = [];
      const newHexMap = new Map();

      for (let i = 0; i < rawStates.length; i++) {
        const s = rawStates[i];
        const hex = s[0] ? s[0].toLowerCase() : '';
        const callsign = (s[1] || '').trim();
        const originCountry = s[2] || '';
        const timePos = s[3] || s[4] || timestamp;
        const lastContact = s[4] || s[3] || timestamp;
        const lon = s[5];
        const lat = s[6];
        const baroAlt = s[7]; // meters
        const onGround = !!s[8];
        const velocity = s[9]; // m/s
        const track = s[10]; // degrees
        const vertRate = s[11]; // m/s
        const geoAlt = s[13]; // geometric altitude in meters
        const squawk = s[14] || '';

        if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        if (onGround && (!baroAlt || baroAlt < 30) && (!velocity || velocity < 15)) continue; // Skip parked aircraft at gates

        // Use barometric altitude if available, fallback to geometric altitude before defaulting to 0
        const effectiveAltMeters = baroAlt !== null ? baroAlt : (geoAlt !== null ? geoAlt : 0);
        const altFt = Math.round(effectiveAltMeters * 3.28084);
        const speedKts = velocity !== null ? Math.round(velocity * 1.94384) : 0;
        const vertFpm = vertRate !== null ? Math.round(vertRate * 196.85) : 0;
        const trackDeg = track !== null ? Math.round(track * 10) / 10 : 0;

        const airline = extractAirlineInfo(callsign);
        const iataCode = (airline.code && airlines.icao && airlines.icao[airline.code] && airlines.icao[airline.code].iata) || '';
        const flightIata = (iataCode && callsign.startsWith(airline.code)) ? callsign.replace(airline.code, iataCode) : callsign;

        const flightObj = {
          hex,
          callsign,
          flightIata,
          country: originCountry,
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          alt: altFt,
          spd: speedKts,
          hdg: trackDeg,
          vr: vertFpm,
          sqk: squawk,
          alCode: airline.code,
          alIata: iataCode,
          alName: airline.name,
          gnd: onGround ? 1 : 0,
          ts: timestamp,
          posTime: timePos,
          lastContact: lastContact,
          receivedAt: Math.floor(Date.now() / 1000)
        };

        parsedFlights.push(flightObj);
        newHexMap.set(hex, flightObj);

        let history = positionHistory.get(hex);
        if (!history) {
          history = [];
          positionHistory.set(hex, history);
        }
        if (history.length === 0 || 
            getDistanceNm(lat, lon, history[history.length - 1].lat, history[history.length - 1].lon) > 0.5) {
          history.push({ lat: flightObj.lat, lon: flightObj.lon, alt: altFt, ts: timestamp });
          if (history.length > 50) history.shift();
        }
      }

      if (parsedFlights.length > 0) {
        liveFlights = parsedFlights;
        flightsByHex = newHexMap;
        lastFetchSourceTime = timestamp * 1000;
        lastFetchTime = Date.now();
        isSnapshotFallback = false;
        feedStatus = 'LIVE_AUTHENTICATED';
        totalMessagesReceived += parsedFlights.length;
        currentBackoffMs = 120000; // Reset backoff on success
        nextAllowedFetch = Date.now() + 120000;

        // Atomic snapshot write (write to temp file then rename)
        try {
          const snapshotPath = path.join(dataDir, 'flights-snapshot.json');
          const tmpPath = path.join(dataDir, `flights-snapshot.${Date.now()}.tmp`);
          fs.writeFileSync(tmpPath, JSON.stringify(parsedFlights));
          fs.renameSync(tmpPath, snapshotPath);
        } catch (e) {
          console.warn('[SNAPSHOT WRITE ERROR]', e.message);
        }

        console.log(`[OPENSKY LIVE] Received ${parsedFlights.length} aircraft in ${Date.now() - start}ms`);
      }
    } else if (response.status === 429) {
      feedStatus = 'RATE_LIMITED_FALLBACK';
      currentBackoffMs = Math.min(900000, (currentBackoffMs || 120000) * 2); // Exponential backoff
      nextAllowedFetch = Date.now() + currentBackoffMs;
      console.warn(`[OPENSKY LIVE] OpenSky rate limit (429). Exponential backoff ${currentBackoffMs / 1000}s (preserving active radar state)...`);
    } else {
      nextAllowedFetch = Date.now() + 120000;
      console.warn(`[OPENSKY LIVE] OpenSky status: ${response.status}`);
    }
  } catch (err) {
    nextAllowedFetch = Date.now() + 120000;
    console.warn(`[OPENSKY LIVE] Fetch notice: ${err.message}`);
  } finally {
    isFetching = false;
  }
}

// Dead-reckoning extrapolation (Max 120s) and automatic aircraft purge (300s timeout)
function applyDeadReckoning() {
  if (liveFlights.length === 0) return;
  const nowSec = Date.now() / 1000;
  const fallbackAgeSec = lastFetchTime ? Math.floor(lastFetchTime / 1000) : bootTimeSec;
  const active = [];
  
  for (let i = 0; i < liveFlights.length; i++) {
    const f = liveFlights[i];
    const refTime = f.receivedAt || fallbackAgeSec;
    const dt = isSnapshotFallback ? ((nowSec - bootTimeSec) % 600) : Math.max(0, nowSec - refTime);

    // Strict aircraft purge: In pure live mode, purge contacts after 300s without fresh contact
    if (!isSnapshotFallback && dt > 300) {
      flightsByHex.delete(f.hex);
      continue;
    }

    // Flag fading state for client renderer if contact is older than 120s
    f.isFading = !isSnapshotFallback && dt > 120;

    // Explicitly check for null/undefined so True North (hdg === 0) is not disabled
    if (f.gnd || !f.spd || f.spd <= 0 || f.hdg === undefined || f.hdg === null || isNaN(f.hdg)) {
      f.curLat = f.lat;
      f.curLon = f.lon;
    } else if (dt > 0 && dt <= 120) {
      const distNm = (f.spd / 3600) * dt;
      const radHdg = f.hdg * Math.PI / 180;
      const dLat = (distNm / 60) * Math.cos(radHdg);
      const cosLat = Math.max(0.001, Math.cos((f.lat * Math.PI) / 180));
      const dLon = (distNm / (60 * cosLat)) * Math.sin(radHdg);
      f.curLat = Math.round((f.lat + dLat) * 10000) / 10000;
      f.curLon = Math.round((f.lon + dLon) * 10000) / 10000;
    } else {
      f.curLat = f.curLat || f.lat;
      f.curLon = f.curLon || f.lon;
    }
    active.push(f);
  }
  if (!isSnapshotFallback) {
    liveFlights = active;
  }
}

// Initial fetch and continuous background poller (120s interval = 2,880 credits/day)
fetchGlobalFlights();

setInterval(async () => {
  try {
    await fetchGlobalFlights();
  } catch (e) {
    console.error('[POLL ERROR]', e);
  }
}, 120000);

// API Endpoints

// 1. Get all active flights
app.get('/api/flights', (req, res) => {
  try {
    applyDeadReckoning();

    const { minLat, maxLat, minLon, maxLon, airline, minAlt, maxAlt, search, category } = req.query;

    let filtered = liveFlights;

    if (category && category !== 'all') {
      if (category === 'commercial') {
        filtered = filtered.filter(f => f.alCode && f.alCode !== 'MIL' && !CARGO_AIRLINES.has(f.alCode));
      } else if (category === 'cargo') {
        filtered = filtered.filter(f => CARGO_AIRLINES.has(f.alCode) || (f.alName && (f.alName.includes('Cargo') || f.alName.includes('Express') || f.alName.includes('Freight'))));
      } else if (category === 'mil') {
        filtered = filtered.filter(f => f.alCode === 'MIL' || f.country === 'Military');
      } else if (category === 'ga') {
        filtered = filtered.filter(f => !f.alCode || f.alName === 'General / Private Aviation' || f.alName === 'Unknown / Private');
      }
    }

    if (airline) {
      const alUpper = airline.toUpperCase();
      if (alUpper === 'MIL') {
        filtered = filtered.filter(f => f.alCode === 'MIL' || f.country === 'Military');
      } else {
        // Look up IATA/ICAO aliases
        const altCodes = [alUpper];
        if (airlines.icao && airlines.icao[alUpper] && airlines.icao[alUpper].iata) {
          altCodes.push(airlines.icao[alUpper].iata.toUpperCase());
        }
        if (airlines.iata && airlines.iata[alUpper] && airlines.iata[alUpper].icao) {
          altCodes.push(airlines.iata[alUpper].icao.toUpperCase());
        }

        filtered = filtered.filter(f => {
          const code = (f.alCode || '').toUpperCase();
          const name = (f.alName || '').toUpperCase();
          const cs = (f.callsign || '').toUpperCase();
          return altCodes.some(c => code === c || cs.startsWith(c)) || name.includes(alUpper);
        });
      }
    }

    if (minAlt !== undefined || maxAlt !== undefined) {
      const minA = minAlt !== undefined ? parseInt(minAlt) : 0;
      const maxA = maxAlt !== undefined ? parseInt(maxAlt) : 100000;
      filtered = filtered.filter(f => f.alt >= minA && f.alt <= maxA);
    }

    if (search) {
      const q = search.trim().toUpperCase();
      filtered = filtered.filter(f => 
        (f.callsign && f.callsign.toUpperCase().includes(q)) ||
        (f.flightIata && f.flightIata.toUpperCase().includes(q)) ||
        (f.alName && f.alName.toUpperCase().includes(q)) ||
        (f.alCode && f.alCode.toUpperCase() === q) ||
        (f.alIata && f.alIata.toUpperCase() === q) ||
        (f.country && f.country.toUpperCase().includes(q)) ||
        (q.length >= 4 && f.hex && f.hex.toUpperCase().includes(q))
      );
    }

    if (minLat && maxLat && minLon && maxLon) {
      const nLat = parseFloat(maxLat);
      const sLat = parseFloat(minLat);
      const eLon = parseFloat(maxLon);
      const wLon = parseFloat(minLon);
      filtered = filtered.filter(f => {
        const lat = f.curLat || f.lat;
        const lon = f.curLon || f.lon;
        return lat >= sLat && lat <= nLat && lon >= wLon && lon <= eLon;
      });
    }

    res.json({
      timestamp: Math.floor(Date.now() / 1000),
      sourceTimestamp: lastFetchSourceTime,
      lastUpdate: lastFetchTime,
      feedStatus,
      isDegraded: isSnapshotFallback || (Date.now() - lastFetchTime > 180000),
      totalGlobal: liveFlights.length,
      count: filtered.length,
      flights: filtered
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get enriched flight & route details (100% Pure OpenSky Authenticated APIs)
app.get('/api/flights/details', async (req, res) => {
  try {
    const { callsign, hex } = req.query;
    if (!callsign && !hex) {
      return res.status(400).json({ error: 'Missing callsign or hex query parameter' });
    }

    const cleanCallsign = (callsign || '').trim().toUpperCase();
    const cleanHex = (hex || '').trim().toLowerCase();

    const cacheKey = `${cleanHex}_${cleanCallsign}`;
    const live = flightsByHex.get(cleanHex);
    const nowMs = Date.now();

    // 1. Check in-memory short TTL cache (60s window to avoid permanent stale results)
    if (routeDetailCache.has(cacheKey)) {
      const cached = routeDetailCache.get(cacheKey);
      if (cached && cached.expiresAt > nowMs) {
        if (live) {
          cached.data.liveTelemetry = live;
          cached.data.trail = positionHistory.get(cleanHex) || [];
        }
        return res.json(cached.data);
      } else {
        routeDetailCache.delete(cacheKey);
      }
    }

    const airline = extractAirlineInfo(cleanCallsign);
    const token = await getOpenSkyAccessToken();
    const headers = { 'User-Agent': 'AeroVector-LiveRadar/1.0' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const nowSec = Math.floor(Date.now() / 1000);
    const begin = nowSec - 7200;

    let origin = null;
    let destination = null;
    let trackPoints = [];
    let airlabsFlight = null;

    // 2. Generate Exact Flight Candidates with ATC suffix decomposition (e.g. UAE39L -> EK39L, UAE39, EK39)
    const candidates = [];
    const addCand = (v) => {
      if (!v) return;
      const clean = v.toUpperCase().trim();
      if (clean && !candidates.includes(clean)) candidates.push(clean);
    };

    const alIata = (airline.code && airlines.icao && airlines.icao[airline.code] && airlines.icao[airline.code].iata) || '';
    const alIcao = airline.code || '';
    const rawIata = (live && live.flightIata) || '';
    const activeIataCandidate = rawIata || (alIata && alIcao && cleanCallsign.startsWith(alIcao) ? cleanCallsign.replace(alIcao, alIata) : '') || '';

    if (cleanCallsign) addCand(cleanCallsign);
    if (rawIata) addCand(rawIata);
    if (activeIataCandidate) addCand(activeIataCandidate);

    // Decompose ATC alphanumeric suffixes: UAE39L -> UAE39, EK39; AFR39LA -> AFR39, AF39
    const matchSuffix = cleanCallsign.match(/^([A-Z]{2,3})(\d+)([A-Z]+)$/);
    if (matchSuffix) {
      const pfx = matchSuffix[1];
      const num = matchSuffix[2];
      addCand(`${pfx}${num}`);
      if (alIata) {
        addCand(`${alIata}${num}`);
      }
    }
    const matchNumeric = cleanCallsign.match(/^([A-Z]{2,3})(\d+)$/);
    if (matchNumeric) {
      const num = matchNumeric[2];
      if (alIata) {
        addCand(`${alIata}${num}`);
      }
    }

    if (cleanHex) addCand(cleanHex);

    // Find preferred commercial IATA flight identifier (e.g. 'EK39', 'BA117', '6E139')
    const preferredCommercialIata = candidates.find(c => /^[A-Z0-9]{2}\d+$/.test(c)) || activeIataCandidate || cleanCallsign;

    // 3. Query Local SQLite Cache First with Hex-Binding Verification (Zero API Calls if Active & Fresh)
    let cachedEntry = null;
    const isAirborne = !!(live && !live.gnd && live.spd > 60);

    for (const cand of candidates) {
      const entry = getCachedFlight(cand, cleanHex, isAirborne);
      if (entry && !entry.isStale) {
        if (isAirborne && entry.record && entry.record.status === 'landed') {
          continue;
        }
        cachedEntry = entry;
        break;
      }
    }

    let routeConfidence = 'UNAVAILABLE';
    let routeSource = 'RADAR_TRANSPONDER';

    // 1. Exact Fresh SQLite Cache Hit (0 External API Calls)
    if (cachedEntry && !cachedEntry.isStale && cachedEntry.record && cachedEntry.record.dep_iata && cachedEntry.record.arr_iata) {
      const rec = cachedEntry.record;
      origin = airportsByIcao.get(rec.dep_iata) || airportsByIcao.get(rec.dep_icao) || {
        iata: rec.dep_iata,
        icao: rec.dep_icao,
        name: rec.dep_name || rec.dep_city,
        city: rec.dep_city || rec.dep_name,
        country: rec.dep_country,
        lat: rec.dep_lat,
        lon: rec.dep_lon
      };
      destination = airportsByIcao.get(rec.arr_iata) || airportsByIcao.get(rec.arr_icao) || {
        iata: rec.arr_iata,
        icao: rec.arr_icao,
        name: rec.arr_name || rec.arr_city,
        city: rec.arr_city || rec.arr_name,
        country: rec.arr_country,
        lat: rec.arr_lat,
        lon: rec.arr_lon
      };
      routeConfidence = rec.confidence || 'MEDIUM_VERIFIED';
      routeSource = 'SQLITE_CACHE_HIT';
      console.log(`[SQLITE CACHE HIT] ${cleanCallsign || cleanHex}: ${origin.iata} -> ${destination.iata} (${cachedEntry.reason})`);
    }

    // 2. High-Capacity Primary API: ADSBdb Route Resolution
    if (!origin || !destination) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 5000);
        const fetchPromises = [];
        for (const cand of candidates.slice(0, 4)) {
          if (cand && !cand.toLowerCase().startsWith('0x') && cand.length >= 3) {
            fetchPromises.push(
              fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cand)}`, { headers: { 'User-Agent': 'AeroVector/1.0' }, signal: ctrl.signal })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            );
          }
        }
        const results = await Promise.allSettled(fetchPromises);
        clearTimeout(tid);

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value && r.value.response && r.value.response.flightroute) {
            const fr = r.value.response.flightroute;
            if (fr && fr.origin && fr.destination) {
              const candOrg = airportsByIcao.get(fr.origin.icao_code ? fr.origin.icao_code.toUpperCase() : '') ||
                              airportsByIcao.get(fr.origin.iata_code ? fr.origin.iata_code.toUpperCase() : '') || {
                                iata: fr.origin.iata_code,
                                icao: fr.origin.icao_code,
                                name: fr.origin.name,
                                city: fr.origin.municipality || fr.origin.name,
                                country: fr.origin.country_name,
                                lat: fr.origin.latitude,
                                lon: fr.origin.longitude
                              };

              const candDst = airportsByIcao.get(fr.destination.icao_code ? fr.destination.icao_code.toUpperCase() : '') ||
                              airportsByIcao.get(fr.destination.iata_code ? fr.destination.iata_code.toUpperCase() : '') || {
                                iata: fr.destination.iata_code,
                                icao: fr.destination.icao_code,
                                name: fr.destination.name,
                                city: fr.destination.municipality || fr.destination.name,
                                country: fr.destination.country_name,
                                lat: fr.destination.latitude,
                                lon: fr.destination.longitude
                              };

              let isPlausible = true;
              if (live && live.lat != null && live.lon != null && candOrg.lat != null && candDst.lat != null) {
                const totalDist = getDistanceNm(candOrg.lat, candOrg.lon, candDst.lat, candDst.lon);
                const distFromOrg = getDistanceNm(candOrg.lat, candOrg.lon, live.lat, live.lon);
                const distToDst = getDistanceNm(candDst.lat, candDst.lon, live.lat, live.lon);

                // Corridor distance check
                if (totalDist > 50 && (distFromOrg + distToDst) > totalDist * 1.6 && distFromOrg > 80 && distToDst > 80) {
                  isPlausible = false;
                }

                // Trajectory check: If plane is near destination (< 100 NM), but climbing at high altitude (> 15,000 ft), destination cannot be an arrival
                if (distToDst < 100 && live.alt > 15000 && distFromOrg > 200) {
                  isPlausible = false;
                }
              }

              if (isPlausible) {
                origin = candOrg;
                destination = candDst;
                routeConfidence = 'MEDIUM_VERIFIED';
                routeSource = 'ADSB_DB';

                setCachedFlight({
                  flight_id: cleanCallsign || activeIataCandidate,
                  flight_iata: preferredCommercialIata || activeIataCandidate || cleanCallsign,
                  flight_icao: cleanCallsign,
                  hex: cleanHex,
                  dep_iata: candOrg.iata,
                  dep_icao: candOrg.icao,
                  dep_name: candOrg.name,
                  dep_city: candOrg.city,
                  dep_country: candOrg.country,
                  dep_lat: candOrg.lat != null ? candOrg.lat : null,
                  dep_lon: candOrg.lon != null ? candOrg.lon : null,
                  arr_iata: candDst.iata,
                  arr_icao: candDst.icao,
                  arr_name: candDst.name,
                  arr_city: candDst.city,
                  arr_country: candDst.country,
                  arr_lat: candDst.lat != null ? candDst.lat : null,
                  arr_lon: candDst.lon != null ? candDst.lon : null,
                  status: 'en-route',
                  airline_name: airline ? airline.name : '',
                  confidence: 'MEDIUM_VERIFIED',
                  source: 'ADSB_DB',
                  duration_min: Math.round(getDistanceNm(candOrg.lat, candOrg.lon, candDst.lat, candDst.lon) / 7.5)
                });
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn('[ADSBDB LOOKUP NOTICE]', e.message);
      }
    }

    // 3. AirLabs GDS Schedule Enrichment (Strict Persistent Daily Quota Limit <= 25/day + Negative Caching)
    const nowTs = Date.now();
    if (AIRLABS_API_KEY && (!origin || !destination) && getDailyApiUsage('airlabs') < 25) {
      const lookupKey = preferredCommercialIata || activeIataCandidate || cleanCallsign;
      const isNegCached = negativeLookups.has(lookupKey) && (nowTs - negativeLookups.get(lookupKey) < 3600000);

      if (!isNegCached && lookupKey) {
        try {
          incrementDailyApiUsage('airlabs');
          console.log(`[AIRLABS CALL #${getDailyApiUsage('airlabs')}/25 Today] Querying flight_iata=${lookupKey}`);
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(`https://airlabs.co/api/v9/flight?flight_iata=${encodeURIComponent(lookupKey)}&api_key=${AIRLABS_API_KEY}`, { signal: ctrl.signal })
            .then(r => r.json())
            .catch(() => null);
          clearTimeout(tid);

          if (res && res.response && (res.response.dep_iata || res.response.dep_icao)) {
            const item = res.response;
            const isMatch = !cleanHex || !item.hex || item.hex.toUpperCase() === cleanHex.toUpperCase() ||
                            item.flight_iata === preferredCommercialIata || item.flight_icao === cleanCallsign;

            if (isMatch) {
              airlabsFlight = item;
              const depApt = resolveAirportWithFallback(item.dep_iata, item.dep_icao, item.dep_name, item.dep_city, item.dep_country);
              const arrApt = resolveAirportWithFallback(item.arr_iata, item.arr_icao, item.arr_name, item.arr_city, item.arr_country);
              if (depApt) origin = depApt;
              if (arrApt) destination = arrApt;
              routeConfidence = 'HIGH_VERIFIED';
              routeSource = 'AIRLABS_LIVE';

              setCachedFlight({
                flight_id: cleanCallsign || item.flight_iata || item.flight_icao,
                flight_iata: item.flight_iata || preferredCommercialIata,
                flight_icao: item.flight_icao || cleanCallsign,
                hex: cleanHex || item.hex,
                dep_iata: item.dep_iata,
                dep_icao: item.dep_icao,
                dep_name: item.dep_name || item.dep_city,
                dep_city: item.dep_city || item.dep_name,
                dep_country: item.dep_country,
                dep_lat: depApt && depApt.lat ? depApt.lat : null,
                dep_lon: depApt && depApt.lon ? depApt.lon : null,
                arr_iata: item.arr_iata,
                arr_icao: item.arr_icao,
                arr_name: item.arr_name || item.arr_city,
                arr_city: item.arr_city || item.arr_name,
                arr_country: item.arr_country,
                arr_lat: arrApt && arrApt.lat ? arrApt.lat : null,
                arr_lon: arrApt && arrApt.lon ? arrApt.lon : null,
                dep_time: item.dep_time,
                dep_time_ts: item.dep_time_ts,
                arr_time: item.arr_time,
                arr_time_ts: item.arr_time_ts,
                duration_min: item.duration,
                status: item.status,
                reg_number: item.reg_number,
                aircraft_model: item.model,
                aircraft_icao: item.aircraft_icao,
                airline_name: item.airline_name,
                confidence: 'HIGH_VERIFIED',
                source: 'AIRLABS_LIVE'
              });
            }
          } else {
            negativeLookups.set(lookupKey, nowTs);
          }
        } catch (e) {
          negativeLookups.set(lookupKey, nowTs);
        }
      }
    }

    // 4. Local Route Network Inferred Corridor Fallback (Labeled 'LOW_INFERRED')
    const airlineCode = (airline && (airline.code || airline.icao)) || '';
    if (!origin || !destination) {
      if (airlineCode && routes[airlineCode]) {
        const net = routes[airlineCode];
        if (live && live.lat != null && live.lon != null) {
          let bestPair = null;
          let bestCorridorDist = Infinity;
          for (const [depCode, arrList] of Object.entries(net)) {
            const depA = airportsByIcao.get(depCode.toUpperCase()) || airports[depCode.toUpperCase()];
            if (!depA || !depA.lat) continue;
            for (const arrCode of arrList) {
              const arrA = airportsByIcao.get(arrCode.toUpperCase()) || airports[arrCode.toUpperCase()];
              if (!arrA || !arrA.lat) continue;
              const totalD = getDistanceNm(depA.lat, depA.lon, arrA.lat, arrA.lon);
              const d1 = getDistanceNm(depA.lat, depA.lon, live.lat, live.lon);
              const d2 = getDistanceNm(arrA.lat, arrA.lon, live.lat, live.lon);
              if (totalD > 80 && (d1 + d2) < totalD * 1.25 && (d1 + d2) < bestCorridorDist) {
                bestCorridorDist = d1 + d2;
                bestPair = { dep: depA, arr: arrA };
              }
            }
          }
          if (bestPair) {
            origin = bestPair.dep;
            destination = bestPair.arr;
            routeConfidence = 'LOW_INFERRED';
            routeSource = 'INFERRED_CORRIDOR';
          }
        }
      }
    }

    // 5. Query OpenSky live radar tracks & flight takeoff detection (Ground Truth)
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000); // Robust 5s timeout
      const [trackRes, flightsRes] = await Promise.allSettled([
        fetch(`https://opensky-network.org/api/tracks/all?icao24=${cleanHex}&time=0`, { headers, signal: ctrl.signal })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null),
        fetch(`https://opensky-network.org/api/flights/aircraft?icao24=${cleanHex}&begin=${begin}&end=${nowSec}`, { headers, signal: ctrl.signal })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      ]);
      clearTimeout(tid);

      const trackData = trackRes.status === 'fulfilled' ? trackRes.value : null;
      const flightData = flightsRes.status === 'fulfilled' ? flightsRes.value : null;

      if (trackData && trackData.path && Array.isArray(trackData.path) && trackData.path.length > 0) {
        trackPoints = trackData.path.map(p => [p[2], p[1]]);
        // Identify authentic takeoff airport from the first recorded radar waypoint if origin missing
        if (!origin && trackPoints.length > 0) {
          const takeoffLon = trackPoints[0][0];
          const takeoffLat = trackPoints[0][1];
          let nearestApt = null;
          let minDist = Infinity;
          for (const a of airportsList) {
            if (!a.lat || !a.lon) continue;
            const d = getDistanceNm(takeoffLat, takeoffLon, a.lat, a.lon);
            if (d < minDist) {
              minDist = d;
              nearestApt = a;
            }
          }
          if (nearestApt && minDist < 45) {
            origin = nearestApt;
          }
        }
      }

      if (flightData && Array.isArray(flightData) && flightData.length > 0) {
        const latest = flightData[flightData.length - 1];
        // Ensure OpenSky flight is current leg (not an old completed flight from hours ago)
        const isCurrentLeg = !latest.lastSeen || latest.lastSeen > (nowSec - 3600);
        if (isCurrentLeg) {
          if (!origin && latest.estDepartureAirport) {
            origin = airportsByIcao.get(latest.estDepartureAirport.toUpperCase()) || null;
          }
          if (!destination && latest.estArrivalAirport) {
            destination = airportsByIcao.get(latest.estArrivalAirport.toUpperCase()) || null;
          }
        }
      }
    } catch (e) {
      console.warn('[OPENSKY TRACKS NOTICE]', e.message);
    }

    let greatCircleRoute = [];
    let totalDistanceNm = 0;
    let progressPercent = 0;

    if (origin && destination && origin.lat != null && destination.lat != null) {
      greatCircleRoute = calculateGreatCirclePoints(origin.lat, origin.lon, destination.lat, destination.lon, 60);
      totalDistanceNm = Math.round(getDistanceNm(origin.lat, origin.lon, destination.lat, destination.lon));
      if (live && totalDistanceNm > 0) {
        const curLat = live.curLat || live.lat;
        const curLon = live.curLon || live.lon;
        const flownNm = getDistanceNm(origin.lat, origin.lon, curLat, curLon);
        progressPercent = Math.min(100, Math.max(0, Math.round((flownNm / totalDistanceNm) * 100)));
      }
    } else if (trackPoints.length > 1) {
      greatCircleRoute = trackPoints;
      totalDistanceNm = Math.round(getDistanceNm(trackPoints[0][1], trackPoints[0][0], trackPoints[trackPoints.length - 1][1], trackPoints[trackPoints.length - 1][0]));
      progressPercent = 100;
    } else if (origin && live) {
      const curLat = live.curLat || live.lat;
      const curLon = live.curLon || live.lon;
      greatCircleRoute = calculateGreatCirclePoints(origin.lat, origin.lon, curLat, curLon, 30);
      totalDistanceNm = Math.round(getDistanceNm(origin.lat, origin.lon, curLat, curLon));
      progressPercent = 100;
    }

    const icaoType = (airlabsFlight && airlabsFlight.aircraft_icao) || (live && live.type) || '';
    const spec = aircraftTypes[icaoType] || {
      manufacturer: (airlabsFlight && airlabsFlight.manufacturer) || 'Commercial Aviation',
      name: (airlabsFlight && airlabsFlight.model) || icaoType || 'Passenger Jet',
      category: 'Commercial Jet',
      engines: 'Jet',
      maxPax: '150 - 300',
      cruiseKnots: 460,
      maxAlt: 41000
    };

    const squawkInfo = live ? decodeSquawk(live.sqk) : null;

    const result = {
      hex: cleanHex,
      callsign: cleanCallsign || cleanHex.toUpperCase(),
      flightIata: (airlabsFlight && airlabsFlight.flight_iata) || (live && live.flightIata) || cleanCallsign,
      airline: {
        name: (airlabsFlight && airlabsFlight.airline_name) || airline.name,
        icao: airline.code,
        iata: (airlines.icao && airlines.icao[airline.code] && airlines.icao[airline.code].iata) || '',
        country: airline.country,
        callsign: airline.callsign || ''
      },
      aircraft: {
        model: (airlabsFlight && airlabsFlight.model) || (airlabsFlight && airlabsFlight.aircraft_model) || spec.name,
        icaoType: icaoType || spec.name,
        manufacturer: (airlabsFlight && airlabsFlight.manufacturer) || spec.manufacturer,
        registration: (airlabsFlight && airlabsFlight.reg_number) || (live && live.reg) || '',
        registeredOwner: (airlabsFlight && airlabsFlight.airline_name) || airline.name,
        category: spec.category,
        engines: spec.engines,
        maxPassengers: spec.maxPax,
        cruiseSpeed: spec.cruiseKnots,
        maxServiceCeiling: spec.maxAlt,
        photoUrl: null
      },
      origin,
      destination,
      route: {
        points: greatCircleRoute,
        distanceNm: totalDistanceNm,
        progressPercent
      },
      squawkInfo,
      liveTelemetry: live || null,
      trail: trackPoints.length > 0 ? trackPoints.map(p => ({ lon: p[0], lat: p[1] })) : (positionHistory.get(cleanHex) || []),
      cacheMeta: {
        source: routeSource,
        confidence: routeConfidence,
        isCached: !!(cachedEntry && !cachedEntry.isStale),
        status: cachedEntry ? (cachedEntry.isStale ? 'EXPIRED' : 'ACTIVE') : (routeConfidence === 'HIGH_VERIFIED' || routeConfidence === 'MEDIUM_VERIFIED' ? 'LIVE_VERIFIED' : (routeConfidence === 'LOW_INFERRED' ? 'INFERRED' : 'TRANSPONDER_ONLY')),
        reason: cachedEntry ? cachedEntry.reason : (routeConfidence === 'HIGH_VERIFIED' ? 'AirLabs GDS Timetable' : (routeConfidence === 'MEDIUM_VERIFIED' ? 'ADSBdb Route Topology' : (routeConfidence === 'LOW_INFERRED' ? 'Inferred Airline Corridor' : 'Active Transponder Telemetry'))),
        dep_time: (airlabsFlight && (airlabsFlight.dep_time || airlabsFlight.dep_estimated)) || (cachedEntry && cachedEntry.record && cachedEntry.record.dep_time) || '',
        arr_time: (airlabsFlight && (airlabsFlight.arr_time || airlabsFlight.arr_estimated)) || (cachedEntry && cachedEntry.record && cachedEntry.record.arr_time) || '',
        duration: (airlabsFlight && (airlabsFlight.duration_min || airlabsFlight.duration)) ? `${airlabsFlight.duration_min || airlabsFlight.duration} min` : ((cachedEntry && cachedEntry.record && cachedEntry.record.duration_min) ? `${cachedEntry.record.duration_min} min` : '')
      }
    };

    routeDetailCache.set(cacheKey, { data: result, expiresAt: Date.now() + 60000 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get top airlines with live active counts
app.get('/api/airlines', (req, res) => {
  try {
    const countMap = new Map();
    
    for (const f of liveFlights) {
      if (!f.alName || f.alName === 'Unknown / Private') continue;
      const name = f.alName;
      const code = f.alCode || '';
      const key = `${name}|${code}`;
      countMap.set(key, (countMap.get(key) || 0) + 1);
    }

    const sorted = Array.from(countMap.entries())
      .map(([key, count]) => {
        const [name, code] = key.split('|');
        return { name, code, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    res.json({
      totalAirlines: sorted.length,
      airlines: sorted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get major airports for map hubs / search
app.get('/api/airports', (req, res) => {
  try {
    const { query, limit } = req.query;
    const max = parseInt(limit) || 100;

    if (query) {
      const q = query.trim().toUpperCase();
      const results = airportsList.filter(a => 
        (a.iata && a.iata.toUpperCase().includes(q)) ||
        (a.icao && a.icao.toUpperCase().includes(q)) ||
        (a.name && a.name.toUpperCase().includes(q)) ||
        (a.city && a.city.toUpperCase().includes(q))
      ).slice(0, max);
      return res.json(results);
    }

    const majorIatas = [
      'ATL', 'PEK', 'DXB', 'HND', 'LHR', 'ORD', 'PVG', 'CDG', 'DFW', 'AMS',
      'FRA', 'IST', 'CAN', 'JFK', 'SIN', 'DEN', 'ICN', 'BKK', 'SFO', 'DEL',
      'MAD', 'BCN', 'YYZ', 'SYD', 'MIA', 'CLT', 'SEA', 'PHX', 'MCO', 'EWR',
      'MUC', 'FCO', 'MEX', 'GRU', 'BOM', 'NRT', 'KIX', 'DOH', 'ZRH', 'VIE',
      'MEL', 'AKL', 'JNB', 'CPT', 'CAI', 'BOG', 'SCL', 'EZE', 'CPH', 'OSL',
      'ARN', 'HEL', 'DUB', 'BRU', 'GVA', 'WAW', 'PRG', 'LIS', 'ATH', 'AUH'
    ];

    const majorHubs = majorIatas.map(iata => airports[iata]).filter(Boolean);
    res.json(majorHubs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Global live statistics
app.get('/api/stats', (req, res) => {
  try {
    let airborne = 0;
    let onGround = 0;
    let totalSpeed = 0;
    let speedCount = 0;
    let totalAlt = 0;
    let altCount = 0;
    let emergencySquawks = [];

    const altBrackets = {
      low: 0,
      mid: 0,
      cruise: 0,
      high: 0,
      strat: 0
    };

    for (const f of liveFlights) {
      if (f.gnd) {
        onGround++;
      } else {
        airborne++;
        if (f.alt > 0) {
          totalAlt += f.alt;
          altCount++;
          if (f.alt < 10000) altBrackets.low++;
          else if (f.alt < 25000) altBrackets.mid++;
          else if (f.alt < 35000) altBrackets.cruise++;
          else if (f.alt <= 40000) altBrackets.high++;
          else altBrackets.strat++;
        }
        if (f.spd > 0) {
          totalSpeed += f.spd;
          speedCount++;
        }
      }

      if (f.sqk === '7500' || f.sqk === '7600' || f.sqk === '7700') {
        emergencySquawks.push({
          hex: f.hex,
          callsign: f.callsign,
          squawk: f.sqk,
          alt: f.alt,
          info: decodeSquawk(f.sqk)
        });
      }
    }

    res.json({
      totalTracked: liveFlights.length,
      airborne,
      onGround,
      avgAltitudeFt: altCount > 0 ? Math.round(totalAlt / altCount) : 0,
      avgSpeedKts: speedCount > 0 ? Math.round(totalSpeed / speedCount) : 0,
      altBrackets,
      emergencyCount: emergencySquawks.length,
      emergencySquawks,
      lastUpdate: lastFetchTime,
      messagesCount: totalMessagesReceived
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. SQLite Route Cache Inspection & Management API
app.get('/api/cache/routes', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const search = req.query.search || '';
    const cacheData = getAllCachedFlights(limit, search);
    res.json({
      ...cacheData,
      apiCallsExecuted: airlabsQueryCount,
      quotaEstimatedSaved: Math.max(0, cacheData.totalCached - airlabsQueryCount)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cache/clear', (req, res) => {
  try {
    const result = clearDbCache();
    routeDetailCache.clear();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Space Radar Endpoints (Rocket Launches, Spaceports & Real-time ISS Orbit)
let cachedIss = null;
let lastIssFetch = 0;

async function fetchIssPosition() {
  const now = Date.now();
  if (cachedIss && now - lastIssFetch < 4000) {
    return cachedIss;
  }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('http://api.open-notify.org/iss-now.json', { signal: ctrl.signal });
    clearTimeout(tid);
    if (res.ok) {
      const data = await res.json();
      if (data && data.iss_position) {
        const lat = parseFloat(data.iss_position.latitude);
        const lon = parseFloat(data.iss_position.longitude);

        // Generate high-fidelity 90-min future projected orbital ground track
        const periodMin = 92.6;
        const degPerMin = 360 / periodMin;
        const earthRotPerMin = 360 / 1440; // Earth rotates underneath at 0.25 deg/min

        const orbitPoints = [];
        for (let m = -15; m <= 75; m += 2.0) {
          const rad = ((m * degPerMin) * Math.PI) / 180;
          const pLat = Math.sin(rad) * 51.64; // 51.64 degree orbital inclination
          let pLon = (lon + (m * (degPerMin - earthRotPerMin))) % 360;
          if (pLon > 180) pLon -= 360;
          if (pLon < -180) pLon += 360;
          orbitPoints.push([Math.round(pLon * 1000) / 1000, Math.round(pLat * 1000) / 1000]);
        }

        cachedIss = {
          name: 'International Space Station (ISS)',
          noradId: 25544,
          lat,
          lon,
          altKm: 420,
          altFt: Math.round(420 * 3280.84),
          speedKmh: 27600,
          speedKts: Math.round(27600 / 1.852),
          inclination: '51.64°',
          crew: 7,
          orbitPoints,
          timestamp: data.timestamp || Math.floor(now / 1000)
        };
        lastIssFetch = now;
        return cachedIss;
      }
    }
  } catch (e) {
    // Return last known cached position if network fails
  }
  return cachedIss || {
    name: 'International Space Station (ISS)',
    noradId: 25544,
    lat: 25.0,
    lon: 45.0,
    altKm: 420,
    altFt: 1377953,
    speedKmh: 27600,
    speedKts: 14902,
    inclination: '51.64°',
    crew: 7,
    orbitPoints: [],
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function fetchSpaceLaunches(force = false) {
  try {
    if (!force && isSpaceLaunchCacheFresh(1800)) {
      const cached = getCachedSpaceLaunches();
      if (cached.length > 0) return cached;
    }

    console.log('[SPACE RADAR] Refreshing orbital rocket launches from Launch Library 2...');
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://lldev.thespacedevs.com/2.2.0/launch/upcoming/?limit=15', {
      headers: { 'User-Agent': 'AeroVector-SpaceTracker/1.0' },
      signal: ctrl.signal
    });
    clearTimeout(tid);

    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.results) && data.results.length > 0) {
        setCachedSpaceLaunches(data.results);
        console.log(`[SPACE RADAR] Successfully cached ${data.results.length} upcoming orbital launches.`);
        return getCachedSpaceLaunches();
      }
    }
  } catch (e) {
    console.warn('[SPACE RADAR NOTICE]', e.message);
  }
  return getCachedSpaceLaunches();
}

// Initial space launches fetch & 30-minute background poller (2 calls/hr = 48/day)
fetchSpaceLaunches();
setInterval(() => {
  fetchSpaceLaunches();
}, 1800000);

app.get('/api/space/launches', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const launches = await fetchSpaceLaunches(force);
    res.json({
      total: launches.length,
      timestamp: Math.floor(Date.now() / 1000),
      launches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/space/iss', async (req, res) => {
  try {
    const iss = await fetchIssPosition();
    res.json(iss);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/space/spaceports', (req, res) => {
  try {
    res.json({
      total: spaceports.length,
      spaceports
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/space/overview', async (req, res) => {
  try {
    const [launches, iss] = await Promise.all([
      fetchSpaceLaunches(),
      fetchIssPosition()
    ]);
    res.json({
      timestamp: Math.floor(Date.now() / 1000),
      nextLaunch: launches.length > 0 ? launches[0] : null,
      totalUpcomingLaunches: launches.length,
      spaceportsCount: spaceports.length,
      iss,
      spaceports,
      launches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`✈️  AEROVECTOR RADAR SERVER RUNNING`);
  console.log(`🌐  Local URL: http://localhost:${PORT}`);
  console.log(`📡  Live Data Feed: OpenSky Network (Authenticated OAuth2)`);
  console.log(`🚀  Space Tracker Feed: Launch Library 2 & Live ISS Telemetry`);
  console.log(`🗺️  Navigation Database: OpenFlights (13.7k Airports, 5.8k Airlines)`);
  console.log(`====================================================`);
});
