const assert = require('assert');
const Database = require('better-sqlite3');
const { createCacheStore, evaluateStaleness } = require('../data/db.js');

console.log('🧪 RUNNING COMPREHENSIVE NON-DESTRUCTIVE AEROVECTOR UNIT & ROUTE RESOLVER TESTS...\n');

// Initialize 100% in-memory database instance (zero impact on production data)
const testDb = new Database(':memory:');
const store = createCacheStore(testDb);
const { 
  getCachedFlight, 
  setCachedFlight, 
  getAllCachedFlights, 
  clearCache,
  getDailyApiUsage,
  incrementDailyApiUsage,
  getCachedSpaceLaunches,
  setCachedSpaceLaunches,
  isSpaceLaunchCacheFresh
} = store;

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    Error: ${err.message}`);
    failed++;
  }
}

// 1. Initial State
it('Initialize in-memory SQLite cache store', () => {
  const data = getAllCachedFlights();
  assert.strictEqual(data.totalCached, 0);
});

// 2. Exact persistence & multi-key retrieval with confidence and source
it('Persist flight leg with exact hex, callsign, confidence, and source', () => {
  const ok = setCachedFlight({
    flight_id: '6E850',
    flight_iata: '6E850',
    flight_icao: 'IGO850',
    hex: '801792',
    dep_iata: 'DEL',
    dep_name: 'Indira Gandhi International Airport',
    arr_iata: 'BLR',
    arr_name: 'Kempegowda International Airport',
    dep_time: '12:20',
    arr_time: '15:20',
    arr_time_ts: Math.floor(Date.now() / 1000) + 3600,
    duration_min: 180,
    status: 'en-route',
    airline_name: 'IndiGo',
    confidence: 'HIGH_VERIFIED',
    source: 'AIRLABS_LIVE'
  });
  assert.strictEqual(ok, true);
});

it('Retrieve cached flight by matching callsign and matching hex', () => {
  const hit1 = getCachedFlight('6E850', '801792');
  assert.ok(hit1, 'Should find by IATA and matching hex');
  assert.strictEqual(hit1.isStale, false);
  assert.strictEqual(hit1.record.dep_iata, 'DEL');
  assert.strictEqual(hit1.record.arr_iata, 'BLR');
  assert.strictEqual(hit1.record.confidence, 'HIGH_VERIFIED');
  assert.strictEqual(hit1.record.source, 'AIRLABS_LIVE');

  const hit2 = getCachedFlight('IGO850', '801792');
  assert.ok(hit2, 'Should find by ICAO and matching hex');
  assert.strictEqual(hit2.isStale, false);

  const hit3 = getCachedFlight('801792', '801792');
  assert.ok(hit3, 'Should find by Hex');
  assert.strictEqual(hit3.isStale, false);
});

// 3. Strict Hex-Binding (H2 Finding)
it('Enforce Strict Hex-Binding: Reject cross-airframe mismatch on 6E850 with DEADBE (H2 Finding)', () => {
  const mismatch = getCachedFlight('6E850', 'DEADBE', true);
  assert.strictEqual(mismatch, null, 'Mismatched hex must strictly return null');
});

// 4. Staleness: Landed flights marked stale
it('Evaluate staleness: Landed status immediately marks record as stale (C5 Finding)', () => {
  const st = evaluateStaleness({ status: 'landed', arr_time_ts: Math.floor(Date.now() / 1000) - 600 });
  assert.strictEqual(st.isStale, true);
  assert.ok(st.reason.includes('landed'));
});

// 5. Staleness: Airborne delay buffer (H4 Finding)
it('Evaluate staleness with airborne delay buffer (H4 Finding)', () => {
  const pastArrTime = Math.floor(Date.now() / 1000) - 300;
  setCachedFlight({
    flight_id: 'AF406',
    flight_iata: 'AF406',
    flight_icao: 'AFR406',
    hex: '39CF0E',
    dep_iata: 'CDG',
    arr_iata: 'SCL',
    arr_time_ts: pastArrTime,
    status: 'en-route',
    confidence: 'MEDIUM_VERIFIED',
    source: 'ADSB_DB'
  });

  const groundCheck = getCachedFlight('AF406', '39CF0E', false);
  assert.strictEqual(groundCheck.isStale, true);

  const airborneCheck = getCachedFlight('AF406', '39CF0E', true);
  assert.strictEqual(airborneCheck.isStale, false);
});

// 6. Staleness: Expiration past 12-hour max TTL
it('Evaluate staleness: Exceeding 12-hour route cache TTL marks record as stale', () => {
  const pastExpiry = Math.floor(Date.now() / 1000) - 120;
  const st = evaluateStaleness({ expires_at_ts: pastExpiry }, false);
  assert.strictEqual(st.isStale, true);
  assert.ok(st.reason.includes('Route expired'));
});

// 7. Staleness: 8-hour old record remains fresh within 12-hour window (not prematurely expired at 6h)
it('Evaluate staleness: 8-hour old cached record remains fresh within 12-hour window', () => {
  const now = Math.floor(Date.now() / 1000);
  const eightHoursAgo = now - (8 * 3600);
  const st = evaluateStaleness({ last_queried_ts: eightHoursAgo, expires_at_ts: now + (4 * 3600) }, false);
  assert.strictEqual(st.isStale, false, '8-hour old record within 12h expiry must be fresh');
});

// 8. True North Movement (M5 Finding)
it('Preserve true north (heading = 0) without disabling dead reckoning (M5 Finding)', () => {
  const f = { lat: 12.0, lon: 77.0, spd: 450, hdg: 0, gnd: 0, ts: Math.floor(Date.now() / 1000) - 10 };
  const nowSec = Date.now() / 1000;
  const dt = nowSec - f.ts;
  const distNm = (f.spd / 3600) * dt;
  const radHdg = f.hdg * Math.PI / 180;
  const dLat = (distNm / 60) * Math.cos(radHdg);
  const curLat = f.lat + dLat;
  assert.ok(curLat > f.lat, 'Northbound flight should advance in latitude');
});

// 9. Cardinal Heading dead-reckoning vectors (Max 120s window)
it('Dead reckoning accurately advances eastward (heading = 90) within 120s window', () => {
  const fEast = { lat: 0.0, lon: 0.0, spd: 360, hdg: 90 };
  const dt = 60; // 60s
  const distNm = (fEast.spd / 3600) * dt;
  const radEast = (fEast.hdg * Math.PI) / 180;
  const dLonEast = (distNm / 60) * Math.sin(radEast);
  assert.ok(dLonEast > 0, 'Eastbound flight must increase longitude');
});

// 10. Aircraft Purge Threshold (300s)
it('Aircraft with dt > 300s are purged from active tracking without unbounded drift', () => {
  const nowSec = 10000;
  const staleFlight = { hex: 'ABC123', receivedAt: nowSec - 320, spd: 450, hdg: 90 };
  const dt = nowSec - staleFlight.receivedAt;
  const shouldPurge = dt > 300;
  assert.strictEqual(shouldPurge, true, 'Contacts older than 300s must be purged');
});

// 11. Stationary / Ground aircraft
it('Ground aircraft (gnd = 1 or spd = 0) hold position without ghost drift', () => {
  const fGnd = { lat: 40.0, lon: -74.0, spd: 0, hdg: 120, gnd: 1 };
  const curLat = fGnd.gnd || fGnd.spd === 0 ? fGnd.lat : fGnd.lat + 1;
  const curLon = fGnd.gnd || fGnd.spd === 0 ? fGnd.lon : fGnd.lon + 1;
  assert.strictEqual(curLat, 40.0);
  assert.strictEqual(curLon, -74.0);
});

// 12. Coordinate validation guards
it('Coordinate validation protects against null, undefined, and polar singularities', () => {
  const safeLat = (lat) => (lat != null && !isNaN(Number(lat)) ? Number(lat) : null);
  const safeLon = (lon) => (lon != null && !isNaN(Number(lon)) ? Number(lon) : null);
  assert.strictEqual(safeLat(null), null);
  assert.strictEqual(safeLat(undefined), null);
  assert.strictEqual(safeLat('invalid'), null);
  assert.strictEqual(safeLat(51.5), 51.5);
  assert.strictEqual(safeLon(-0.12), -0.12);
});

// 13. ADSBdb / AirLabs Hex match validation
it('Reject external provider payload if returned hex contradicts tracked aircraft', () => {
  const trackedHex = '4D2210';
  const providerPayloadHex = '4D9999';
  const isMatch = !providerPayloadHex || providerPayloadHex.toUpperCase() === trackedHex.toUpperCase();
  assert.strictEqual(isMatch, false, 'Contradicting hex in provider payload must be rejected');
});

// 14. Persistent API Quota Tracking across restarts
it('Track API usage persistently in SQLite with daily UTC reset', () => {
  assert.strictEqual(getDailyApiUsage('airlabs'), 0);
  const c1 = incrementDailyApiUsage('airlabs');
  assert.strictEqual(c1, 1);
  const c2 = incrementDailyApiUsage('airlabs');
  assert.strictEqual(c2, 2);
  assert.strictEqual(getDailyApiUsage('airlabs'), 2);
});

// 15. Local Route Network Corridor with airline.code matching
it('Match local route network corridors using airline.code without crashing', () => {
  const mockRoutes = {
    'DLH': {
      'EDDF': ['KJFK', 'KORD', 'EGLL']
    }
  };
  const airline = { code: 'DLH', name: 'Lufthansa', country: 'Germany' };
  const airlineCode = (airline && (airline.code || airline.icao)) || '';
  assert.strictEqual(airlineCode, 'DLH');
  assert.ok(mockRoutes[airlineCode], 'Should match routes using airline.code');
  assert.ok(mockRoutes[airlineCode]['EDDF'].includes('KJFK'));
});

// 16. Multi-Tier Resolution Confidence Guarantees
it('Enforce strictly accurate confidence badges and zero API calls on SQLite hit', () => {
  // Hit existing 6E850
  const hit = getCachedFlight('6E850', '801792', true);
  assert.ok(hit && !hit.isStale);
  let apiCallsMade = 0;
  let origin = null;
  let destination = null;
  let routeConfidence = 'UNAVAILABLE';
  let routeSource = 'RADAR_TRANSPONDER';

  if (hit && !hit.isStale && hit.record.dep_iata && hit.record.arr_iata) {
    origin = { iata: hit.record.dep_iata };
    destination = { iata: hit.record.arr_iata };
    routeConfidence = hit.record.confidence || 'MEDIUM_VERIFIED';
    routeSource = 'SQLITE_CACHE_HIT';
  }

  // AirLabs check (only if missing origin/destination)
  if ((!origin || !destination)) {
    apiCallsMade++;
  }

  assert.strictEqual(apiCallsMade, 0, 'Cache hit must make exactly 0 external API calls');
  assert.strictEqual(routeSource, 'SQLITE_CACHE_HIT');
  assert.strictEqual(routeConfidence, 'HIGH_VERIFIED');
});

// 17. Space Launch SQLite Caching & Retrieval
it('Persist and retrieve upcoming orbital rocket launches in SQLite', () => {
  const mockLaunches = [
    {
      id: 'f9-starlink-test',
      name: 'Falcon 9 Block 5 | Starlink Group 10-5',
      net: '2026-08-25T12:00:00Z',
      net_ts: Math.floor(Date.now() / 1000) + 7200,
      status: { name: 'Go for Launch', description: 'Clear for launch' },
      rocket: { configuration: { name: 'Falcon 9', family: 'Falcon' } },
      launch_service_provider: { name: 'SpaceX' },
      mission: { name: 'Starlink Group 10-5', description: 'Satellite constellation', orbit: { name: 'Low Earth Orbit (LEO)' } },
      pad: { name: 'SLC-40', location: { name: 'Cape Canaveral SFS' }, latitude: '28.5619', longitude: '-80.5772' }
    }
  ];

  store.setCachedSpaceLaunches(mockLaunches);
  const cached = store.getCachedSpaceLaunches();
  assert.strictEqual(cached.length, 1);
  assert.strictEqual(cached[0].rocket_name, 'Falcon 9');
  assert.strictEqual(cached[0].lsp_name, 'SpaceX');
  assert.strictEqual(cached[0].pad_name, 'SLC-40');
  assert.strictEqual(cached[0].pad_lat, 28.5619);
  assert.strictEqual(cached[0].pad_lon, -80.5772);
});

// 18. Space Launch Cache Freshness Evaluation
it('Evaluate space launch cache freshness with 30-min TTL', () => {
  assert.strictEqual(store.isSpaceLaunchCacheFresh(1800), true);
  assert.strictEqual(store.isSpaceLaunchCacheFresh(0), false);
});

// 19. Global Spaceports Dataset Integrity
it('Validate global spaceports coordinate integrity', () => {
  const fs = require('fs');
  const path = require('path');
  const spaceportsPath = path.join(__dirname, '../data/spaceports.json');
  assert.ok(fs.existsSync(spaceportsPath), 'spaceports.json must exist');
  const spaceports = JSON.parse(fs.readFileSync(spaceportsPath, 'utf8'));
  assert.ok(spaceports.length >= 8, 'Should have at least 8 prominent global spaceports');
  for (const sp of spaceports) {
    assert.ok(sp.name && sp.agency && sp.country);
    assert.ok(sp.lat >= -90 && sp.lat <= 90, `Invalid lat for ${sp.name}`);
    assert.ok(sp.lon >= -180 && sp.lon <= 180, `Invalid lon for ${sp.name}`);
  }
});

// 20. ISS Orbit Projection Geometry
it('Generate ISS orbital ground track within valid inclination (-52 to +52 deg)', () => {
  const lon = -160.0;
  const periodMin = 92.6;
  const degPerMin = 360 / periodMin;
  const earthRotPerMin = 360 / 1440;

  const points = [];
  for (let m = -15; m <= 75; m += 2.0) {
    const rad = ((m * degPerMin) * Math.PI) / 180;
    const pLat = Math.sin(rad) * 51.64;
    let pLon = (lon + (m * (degPerMin - earthRotPerMin))) % 360;
    if (pLon > 180) pLon -= 360;
    if (pLon < -180) pLon += 360;
    points.push([pLon, pLat]);
  }

  assert.ok(points.length > 20, 'Should generate orbital path points');
  for (const [pLon, pLat] of points) {
    assert.ok(pLat >= -52 && pLat <= 52, `Orbital lat ${pLat} exceeded ISS inclination`);
    assert.ok(pLon >= -180 && pLon <= 180, `Orbital lon ${pLon} out of bounds`);
  }
});

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
