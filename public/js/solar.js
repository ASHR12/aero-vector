// Solar subpoint and Day/Night terminator calculation
class SolarCalculator {
  static getSolarPosition(date = new Date()) {
    const rad = Math.PI / 180;
    const deg = 180 / Math.PI;

    // Julian Date
    const time = date.getTime();
    const jd = time / 86400000 + 2440587.5;
    const n = jd - 2451545.0; // days since J2000.0

    // Mean longitude of the Sun
    let L = (280.460 + 0.9856474 * n) % 360;
    if (L < 0) L += 360;

    // Mean anomaly
    let g = (357.528 + 0.9856003 * n) % 360;
    if (g < 0) g += 360;

    // Ecliptic longitude
    const lambda = (L + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) * rad;

    // Obliquity of the ecliptic
    const epsilon = (23.439 - 0.0000004 * n) * rad;

    // Right ascension and declination
    const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
    const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambda));

    // Greenwich Mean Sidereal Time in degrees
    const gmst = ((18.697374558 + 24.06570982441908 * n) % 24) * 15;

    // Subsolar coordinates
    let sunLon = (alpha * deg - gmst) % 360;
    if (sunLon > 180) sunLon -= 360;
    if (sunLon < -180) sunLon += 360;
    const sunLat = delta * deg;

    return {
      sun: [sunLon, sunLat],
      // Antipodal point (center of the night hemisphere)
      night: [sunLon > 0 ? sunLon - 180 : sunLon + 180, -sunLat]
    };
  }

  static getNightPolygon(date = new Date()) {
    if (typeof d3 === 'undefined' || !d3.geoCircle) return null;
    const pos = SolarCalculator.getSolarPosition(date);
    // D3 geoCircle centered at the antipodal night point with 90° radius
    return d3.geoCircle().center(pos.night).radius(90)();
  }
}

window.SolarCalculator = SolarCalculator;
