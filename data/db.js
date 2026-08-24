const Database = require("better-sqlite3");
const path = require("path");

/**
 * Check if a cached flight record is still active/fresh or stale (12-hour max route TTL)
 */
function evaluateStaleness(record, isAirborne = false) {
  if (!record) return { isStale: true, reason: "Record not found" };
  
  const now = Math.floor(Date.now() / 1000);
  const lastQueriedAgoSec = now - (record.last_queried_ts || 0);

  // 1. Explicit Route Expiry TTL (Max 12 hours)
  if (record.expires_at_ts && now >= record.expires_at_ts) {
    return {
      isStale: true,
      reason: `Route expired (${Math.round((now - record.expires_at_ts) / 60)}m past TTL)`
    };
  }

  // 2. If explicit status is landed, the flight is completed
  if (record.status && record.status.toLowerCase() === 'landed') {
    const timeSinceLanding = record.arr_time_ts ? Math.max(0, Math.round((now - record.arr_time_ts) / 60)) : 0;
    return { 
      isStale: true, 
      reason: timeSinceLanding > 0 
        ? `Flight landed ${timeSinceLanding}m ago (completed leg)` 
        : `Flight marked as landed (completed leg)`
    };
  }

  // 3. If arrival timestamp is known, check against current time with airborne holding buffer
  if (record.arr_time_ts) {
    const delayBufferSec = isAirborne ? 1800 : 0; // 30m buffer if plane is actively airborne
    const timeSinceArrival = now - (record.arr_time_ts + delayBufferSec);
    if (timeSinceArrival >= 0) {
      const minsAgo = Math.round((now - record.arr_time_ts) / 60);
      return { 
        isStale: true, 
        reason: `Flight reached destination ${minsAgo}m ago (completed leg)` 
      };
    }
    const minsRemaining = Math.max(1, Math.round((record.arr_time_ts - now) / 60));
    return { 
      isStale: false, 
      reason: isAirborne && now > record.arr_time_ts 
        ? `Airborne flight holding/delayed (${Math.round((now - record.arr_time_ts) / 60)}m past ETA)`
        : `Active flight in progress (landing in ${minsRemaining}m)` 
    };
  }

  // 4. If duration is known, check if departure + duration window has passed
  if (record.dep_time_ts && record.duration_min) {
    const delayBufferSec = isAirborne ? 1800 : 0;
    const estimatedArrival = record.dep_time_ts + (record.duration_min * 60) + delayBufferSec;
    const timeSinceEstimatedArrival = now - estimatedArrival;
    if (timeSinceEstimatedArrival >= 0) {
      return { 
        isStale: true, 
        reason: `Estimated duration elapsed ${(timeSinceEstimatedArrival / 60).toFixed(0)}m ago (completed leg)` 
      };
    }
    return { 
      isStale: false, 
      reason: `Active flight within scheduled duration window` 
    };
  }

  // 5. If query was made over 12 hours ago, force refresh as schedules rotate
  if (lastQueriedAgoSec > 12 * 3600) {
    return { 
      isStale: true, 
      reason: `Cached ${(lastQueriedAgoSec / 3600).toFixed(1)}h ago (> 12h max TTL)` 
    };
  }

  // 6. Default fresh for up to 12 hours if within valid TTL
  if (lastQueriedAgoSec <= 12 * 3600) {
    return { isStale: false, reason: `Cached route valid (${Math.round(lastQueriedAgoSec / 60)}m ago)` };
  }

  return { isStale: true, reason: "12-hour TTL expired" };
}

function createCacheStore(customDb) {
  const targetDb = customDb || new Database(path.join(__dirname, "flights_cache.sqlite"));

  // Enable WAL mode for high performance concurrent reads if on disk
  try {
    targetDb.pragma("journal_mode = WAL");
  } catch (e) {}

  // Initialize Cache Table & Quota Tracker
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS flight_routes_cache (
      flight_id TEXT PRIMARY KEY,
      flight_iata TEXT,
      flight_icao TEXT,
      hex TEXT,
      dep_iata TEXT,
      dep_icao TEXT,
      dep_name TEXT,
      dep_city TEXT,
      dep_country TEXT,
      dep_lat REAL,
      dep_lon REAL,
      arr_iata TEXT,
      arr_icao TEXT,
      arr_name TEXT,
      arr_city TEXT,
      arr_country TEXT,
      arr_lat REAL,
      arr_lon REAL,
      dep_time TEXT,
      dep_time_ts INTEGER,
      arr_time TEXT,
      arr_time_ts INTEGER,
      duration_min INTEGER,
      status TEXT,
      reg_number TEXT,
      aircraft_model TEXT,
      aircraft_icao TEXT,
      airline_name TEXT,
      confidence TEXT DEFAULT 'MEDIUM_VERIFIED',
      source TEXT DEFAULT 'ADSB_DB',
      expires_at_ts INTEGER,
      last_queried_ts INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_flight_iata ON flight_routes_cache(flight_iata);
    CREATE INDEX IF NOT EXISTS idx_flight_icao ON flight_routes_cache(flight_icao);
    CREATE INDEX IF NOT EXISTS idx_flight_hex ON flight_routes_cache(hex);

    CREATE TABLE IF NOT EXISTS api_quota_tracker (
      service_name TEXT PRIMARY KEY,
      date_utc TEXT,
      calls_count INTEGER,
      last_call_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS space_launches_cache (
      id TEXT PRIMARY KEY,
      name TEXT,
      net TEXT,
      net_ts INTEGER,
      status_name TEXT,
      status_desc TEXT,
      rocket_name TEXT,
      rocket_family TEXT,
      lsp_name TEXT,
      mission_name TEXT,
      mission_desc TEXT,
      mission_type TEXT,
      orbit TEXT,
      pad_name TEXT,
      pad_location TEXT,
      pad_lat REAL,
      pad_lon REAL,
      webcast_url TEXT,
      image_url TEXT,
      last_fetched_ts INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_launch_net_ts ON space_launches_cache(net_ts);
  `);

  // Migrate any existing columns
  try { targetDb.exec(`ALTER TABLE flight_routes_cache ADD COLUMN confidence TEXT DEFAULT 'MEDIUM_VERIFIED';`); } catch (e) {}
  try { targetDb.exec(`ALTER TABLE flight_routes_cache ADD COLUMN source TEXT DEFAULT 'ADSB_DB';`); } catch (e) {}
  try { targetDb.exec(`ALTER TABLE flight_routes_cache ADD COLUMN expires_at_ts INTEGER;`); } catch (e) {}

  const stmtGet = targetDb.prepare(`
    SELECT * FROM flight_routes_cache 
    WHERE flight_id = ? OR flight_iata = ? OR flight_icao = ? OR hex = ?
    ORDER BY last_queried_ts DESC LIMIT 1
  `);

  const stmtUpsert = targetDb.prepare(`
    INSERT INTO flight_routes_cache (
      flight_id, flight_iata, flight_icao, hex,
      dep_iata, dep_icao, dep_name, dep_city, dep_country, dep_lat, dep_lon,
      arr_iata, arr_icao, arr_name, arr_city, arr_country, arr_lat, arr_lon,
      dep_time, dep_time_ts, arr_time, arr_time_ts, duration_min,
      status, reg_number, aircraft_model, aircraft_icao, airline_name,
      confidence, source, expires_at_ts,
      last_queried_ts
    ) VALUES (
      @flight_id, @flight_iata, @flight_icao, @hex,
      @dep_iata, @dep_icao, @dep_name, @dep_city, @dep_country, @dep_lat, @dep_lon,
      @arr_iata, @arr_icao, @arr_name, @arr_city, @arr_country, @arr_lat, @arr_lon,
      @dep_time, @dep_time_ts, @arr_time, @arr_time_ts, @duration_min,
      @status, @reg_number, @aircraft_model, @aircraft_icao, @airline_name,
      @confidence, @source, @expires_at_ts,
      @last_queried_ts
    )
    ON CONFLICT(flight_id) DO UPDATE SET
      flight_iata = excluded.flight_iata,
      flight_icao = excluded.flight_icao,
      hex = excluded.hex,
      dep_iata = excluded.dep_iata,
      dep_icao = excluded.dep_icao,
      dep_name = excluded.dep_name,
      dep_city = excluded.dep_city,
      dep_country = excluded.dep_country,
      dep_lat = excluded.dep_lat,
      dep_lon = excluded.dep_lon,
      arr_iata = excluded.arr_iata,
      arr_icao = excluded.arr_icao,
      arr_name = excluded.arr_name,
      arr_city = excluded.arr_city,
      arr_country = excluded.arr_country,
      arr_lat = excluded.arr_lat,
      arr_lon = excluded.arr_lon,
      dep_time = excluded.dep_time,
      dep_time_ts = excluded.dep_time_ts,
      arr_time = excluded.arr_time,
      arr_time_ts = excluded.arr_time_ts,
      duration_min = excluded.duration_min,
      status = excluded.status,
      reg_number = excluded.reg_number,
      aircraft_model = excluded.aircraft_model,
      aircraft_icao = excluded.aircraft_icao,
      airline_name = excluded.airline_name,
      confidence = excluded.confidence,
      source = excluded.source,
      expires_at_ts = excluded.expires_at_ts,
      last_queried_ts = excluded.last_queried_ts;
  `);

  const stmtGetAll = targetDb.prepare(`SELECT * FROM flight_routes_cache ORDER BY last_queried_ts DESC LIMIT ?`);
  const stmtSearch = targetDb.prepare(`
    SELECT * FROM flight_routes_cache 
    WHERE flight_id LIKE ? OR flight_iata LIKE ? OR flight_icao LIKE ? OR hex LIKE ? OR dep_iata LIKE ? OR arr_iata LIKE ?
    ORDER BY last_queried_ts DESC LIMIT ?
  `);
  const stmtCount = targetDb.prepare(`SELECT COUNT(*) AS total FROM flight_routes_cache`);
  const stmtClear = targetDb.prepare(`DELETE FROM flight_routes_cache`);

  /**
   * Retrieve cached flight and evaluate freshness with hex-binding check
   */
  function getCachedFlight(queryKey, expectedHex = null, isAirborne = false) {
    if (!queryKey) return null;
    const clean = String(queryKey).trim().toUpperCase();
    const record = stmtGet.get(clean, clean, clean, clean);
    if (!record) return null;

    // Strict Hex-binding validation: Prevent cross-airframe route contamination (H2 finding)
    if (expectedHex && record.hex) {
      const cleanExpected = expectedHex.trim().toUpperCase();
      const cleanRecordHex = record.hex.trim().toUpperCase();
      if (cleanExpected && cleanRecordHex && cleanExpected !== cleanRecordHex) {
        return null;
      }
    }

    const staleness = evaluateStaleness(record, isAirborne);
    return {
      record,
      isStale: staleness.isStale,
      reason: staleness.reason
    };
  }

  /**
   * Save / Update flight route record in SQLite
   */
  function setCachedFlight(data) {
    const flightId = (data.flight_id || data.flight_iata || data.flight_icao || data.hex || "").toUpperCase();
    if (!flightId) return false;

    const now = Math.floor(Date.now() / 1000);
    // 12-hour max route expiration TTL
    const defaultExpiry = now + 12 * 3600;

    stmtUpsert.run({
      flight_id: flightId,
      flight_iata: (data.flight_iata || "").toUpperCase(),
      flight_icao: (data.flight_icao || "").toUpperCase(),
      hex: (data.hex || "").toUpperCase(),
      dep_iata: (data.dep_iata || "").toUpperCase(),
      dep_icao: (data.dep_icao || "").toUpperCase(),
      dep_name: data.dep_name || "",
      dep_city: data.dep_city || "",
      dep_country: data.dep_country || "",
      dep_lat: data.dep_lat || null,
      dep_lon: data.dep_lon || null,
      arr_iata: (data.arr_iata || "").toUpperCase(),
      arr_icao: (data.arr_icao || "").toUpperCase(),
      arr_name: data.arr_name || "",
      arr_city: data.arr_city || "",
      arr_country: data.arr_country || "",
      arr_lat: data.arr_lat || null,
      arr_lon: data.arr_lon || null,
      dep_time: data.dep_time || "",
      dep_time_ts: data.dep_time_ts || null,
      arr_time: data.arr_time || "",
      arr_time_ts: data.arr_time_ts || null,
      duration_min: data.duration_min || null,
      status: data.status || "en-route",
      reg_number: data.reg_number || "",
      aircraft_model: data.aircraft_model || "",
      aircraft_icao: (data.aircraft_icao || "").toUpperCase(),
      airline_name: data.airline_name || "",
      confidence: data.confidence || "MEDIUM_VERIFIED",
      source: data.source || "ADSB_DB",
      expires_at_ts: data.expires_at_ts || defaultExpiry,
      last_queried_ts: now
    });
    return true;
  }

  /**
   * Get all cached entries with staleness assessment for inspection API
   */
  function getAllCachedFlights(limit = 100, search = "") {
    let records = [];
    if (search) {
      const q = `%${search.trim().toUpperCase()}%`;
      records = stmtSearch.all(q, q, q, q, q, q, limit);
    } else {
      records = stmtGetAll.all(limit);
    }

    // Calculate global database active and expired counts
    const allRecords = stmtGetAll.all(2000);
    let totalFresh = 0;
    let totalStale = 0;
    for (const r of allRecords) {
      const st = evaluateStaleness(r);
      if (st.isStale) totalStale++;
      else totalFresh++;
    }

    const enriched = records.map(r => {
      const st = evaluateStaleness(r);

      return {
        flight_id: r.flight_id,
        flight_iata: r.flight_iata,
        flight_icao: r.flight_icao,
        hex: r.hex,
        airline: r.airline_name,
        aircraft: {
          model: r.aircraft_model,
          icao: r.aircraft_icao,
          registration: r.reg_number
        },
        route: {
          origin: `${r.dep_iata || r.dep_icao} (${r.dep_city || r.dep_name})`,
          destination: `${r.arr_iata || r.arr_icao} (${r.arr_city || r.arr_name})`,
          dep_time: r.dep_time,
          arr_time: r.arr_time,
          duration: r.duration_min ? `${r.duration_min} min` : "N/A"
        },
        cached_at: new Date(r.last_queried_ts * 1000).toISOString(),
        confidence: r.confidence || 'MEDIUM_VERIFIED',
        source: r.source || 'ADSB_DB',
        staleness: {
          status: st.isStale ? "EXPIRED (Stale)" : "ACTIVE (Fresh)",
          isStale: st.isStale,
          reason: st.reason
        }
      };
    });

    const total = stmtCount.get().total;

    return {
      totalCached: total,
      returnedCount: enriched.length,
      activeFresh: totalFresh,
      expiredStale: totalStale,
      flights: enriched
    };
  }

  function clearCache() {
    stmtClear.run();
    return { success: true, message: "SQLite flight route cache cleared" };
  }

  const stmtGetQuota = targetDb.prepare(`SELECT * FROM api_quota_tracker WHERE service_name = ?`);
  const stmtSetQuota = targetDb.prepare(`
    INSERT INTO api_quota_tracker (service_name, date_utc, calls_count, last_call_ts)
    VALUES (@service_name, @date_utc, @calls_count, @last_call_ts)
    ON CONFLICT(service_name) DO UPDATE SET
      date_utc = excluded.date_utc,
      calls_count = excluded.calls_count,
      last_call_ts = excluded.last_call_ts
  `);

  function getDailyApiUsage(serviceName) {
    const today = new Date().toISOString().split('T')[0];
    const row = stmtGetQuota.get(serviceName);
    if (!row || row.date_utc !== today) {
      return 0;
    }
    return row.calls_count || 0;
  }

  function incrementDailyApiUsage(serviceName) {
    const today = new Date().toISOString().split('T')[0];
    const now = Math.floor(Date.now() / 1000);
    const row = stmtGetQuota.get(serviceName);
    let count = 1;
    if (row && row.date_utc === today) {
      count = (row.calls_count || 0) + 1;
    }
    stmtSetQuota.run({
      service_name: serviceName,
      date_utc: today,
      calls_count: count,
      last_call_ts: now
    });
    return count;
  }

    const stmtGetLaunches = targetDb.prepare(`SELECT * FROM space_launches_cache ORDER BY net_ts ASC`);
    const stmtClearLaunches = targetDb.prepare(`DELETE FROM space_launches_cache`);
    const stmtUpsertLaunch = targetDb.prepare(`
      INSERT INTO space_launches_cache (
        id, name, net, net_ts, status_name, status_desc,
        rocket_name, rocket_family, lsp_name,
        mission_name, mission_desc, mission_type, orbit,
        pad_name, pad_location, pad_lat, pad_lon,
        webcast_url, image_url, last_fetched_ts
      ) VALUES (
        @id, @name, @net, @net_ts, @status_name, @status_desc,
        @rocket_name, @rocket_family, @lsp_name,
        @mission_name, @mission_desc, @mission_type, @orbit,
        @pad_name, @pad_location, @pad_lat, @pad_lon,
        @webcast_url, @image_url, @last_fetched_ts
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        net = excluded.net,
        net_ts = excluded.net_ts,
        status_name = excluded.status_name,
        status_desc = excluded.status_desc,
        rocket_name = excluded.rocket_name,
        rocket_family = excluded.rocket_family,
        lsp_name = excluded.lsp_name,
        mission_name = excluded.mission_name,
        mission_desc = excluded.mission_desc,
        mission_type = excluded.mission_type,
        orbit = excluded.orbit,
        pad_name = excluded.pad_name,
        pad_location = excluded.pad_location,
        pad_lat = excluded.pad_lat,
        pad_lon = excluded.pad_lon,
        webcast_url = excluded.webcast_url,
        image_url = excluded.image_url,
        last_fetched_ts = excluded.last_fetched_ts
    `);

    const stmtGetLaunchFreshness = targetDb.prepare(`SELECT MAX(last_fetched_ts) as newest FROM space_launches_cache`);

    function getCachedSpaceLaunches() {
      return stmtGetLaunches.all();
    }

    function setCachedSpaceLaunches(launches) {
      const now = Math.floor(Date.now() / 1000);
      const insertMany = targetDb.transaction((items) => {
        for (const item of items) {
          stmtUpsertLaunch.run({
            id: item.id || `launch-${Date.now()}-${Math.random()}`,
            name: item.name || 'Orbital Launch',
            net: item.net || '',
            net_ts: item.net_ts || (item.net ? Math.floor(new Date(item.net).getTime() / 1000) : 0),
            status_name: item.status_name || item.status?.name || 'Scheduled',
            status_desc: item.status_desc || item.status?.description || '',
            rocket_name: item.rocket_name || item.rocket?.configuration?.name || '',
            rocket_family: item.rocket_family || item.rocket?.configuration?.family || '',
            lsp_name: item.lsp_name || item.launch_service_provider?.name || '',
            mission_name: item.mission_name || item.mission?.name || 'Satellite Deployment',
            mission_desc: item.mission_desc || item.mission?.description || '',
            mission_type: item.mission_type || item.mission?.type || 'Orbital Delivery',
            orbit: item.orbit || item.mission?.orbit?.name || 'Low Earth Orbit (LEO)',
            pad_name: item.pad_name || item.pad?.name || '',
            pad_location: item.pad_location || item.pad?.location?.name || '',
            pad_lat: item.pad_lat !== undefined ? item.pad_lat : (item.pad?.latitude ? parseFloat(item.pad.latitude) : null),
            pad_lon: item.pad_lon !== undefined ? item.pad_lon : (item.pad?.longitude ? parseFloat(item.pad.longitude) : null),
            webcast_url: item.webcast_url || (item.webcast_live ? item.vidURLs?.[0]?.url || '' : ''),
            image_url: item.image_url || item.image || '',
            last_fetched_ts: now
          });
        }
      });
      insertMany(launches);
      return true;
    }

    function isSpaceLaunchCacheFresh(ttlSec = 1800) {
      const row = stmtGetLaunchFreshness.get();
      if (!row || !row.newest) return false;
      const now = Math.floor(Date.now() / 1000);
      return (now - row.newest) < ttlSec;
    }

    return {
      db: targetDb,
      getCachedFlight,
      setCachedFlight,
      getAllCachedFlights,
      clearCache,
      getDailyApiUsage,
      incrementDailyApiUsage,
      getCachedSpaceLaunches,
      setCachedSpaceLaunches,
      isSpaceLaunchCacheFresh
    };
  }

  let defaultStoreInstance = null;
  function getDefaultStore() {
    if (!defaultStoreInstance) {
      defaultStoreInstance = createCacheStore();
    }
    return defaultStoreInstance;
  }

  module.exports = {
    getCachedFlight: (...args) => getDefaultStore().getCachedFlight(...args),
    setCachedFlight: (...args) => getDefaultStore().setCachedFlight(...args),
    getAllCachedFlights: (...args) => getDefaultStore().getAllCachedFlights(...args),
    clearCache: (...args) => getDefaultStore().clearCache(...args),
    getDailyApiUsage: (...args) => getDefaultStore().getDailyApiUsage(...args),
    incrementDailyApiUsage: (...args) => getDefaultStore().incrementDailyApiUsage(...args),
    getCachedSpaceLaunches: (...args) => getDefaultStore().getCachedSpaceLaunches(...args),
    setCachedSpaceLaunches: (...args) => getDefaultStore().setCachedSpaceLaunches(...args),
    isSpaceLaunchCacheFresh: (...args) => getDefaultStore().isSpaceLaunchCacheFresh(...args),
    createCacheStore,
    evaluateStaleness
  };
