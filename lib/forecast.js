'use strict';

/**
 * Wetterprognose über Open-Meteo (kostenlos, ohne API-Key).
 *
 * Abgefragt wird die Globalstrahlung auf die geneigte Modulfläche
 * (global_tilted_irradiance, W/m², Mittel der vorangegangenen Stunde)
 * sowie Sonnenauf- und -untergang je Tag.
 * Azimut-Konvention von Open-Meteo: 0° = Süd, -90° = Ost, 90° = West.
 */

const { dayKey } = require('./energystats');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OM_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'ioBroker.nulleinspeisung-agent (https://github.com/lars752/ioBroker.nulleinspeisung-agent)';

async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Postleitzahl in Koordinaten umrechnen.
 * Erst OpenStreetMap/Nominatim (kennt deutsche PLZ zuverlässig), dann Open-Meteo-Geocoding.
 * @returns {Promise<{lat:number, lon:number, name:string}>}
 */
async function geocodePostalCode(plz, country = 'DE') {
    const code = String(plz || '').trim();
    if (!/^[A-Za-z0-9 -]{3,10}$/.test(code)) throw new Error(`PLZ "${code}" ungültig`);
    const cc = String(country || 'DE').trim().toLowerCase();
    const errors = [];
    try {
        const r = await getJson(`${NOMINATIM_URL}?postalcode=${encodeURIComponent(code)}&countrycodes=${encodeURIComponent(cc)}&format=json&limit=1`);
        if (Array.isArray(r) && r.length) {
            const lat = Number(r[0].lat);
            const lon = Number(r[0].lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, name: r[0].display_name || code };
        }
        errors.push('Nominatim: kein Treffer');
    } catch (e) { errors.push(`Nominatim: ${e.message}`); }
    try {
        const r = await getJson(`${OM_GEOCODE_URL}?name=${encodeURIComponent(code)}&countryCode=${encodeURIComponent(cc.toUpperCase())}&count=1&language=de`);
        const hit = r && Array.isArray(r.results) && r.results[0];
        if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) return { lat: hit.latitude, lon: hit.longitude, name: hit.name || code };
        errors.push('Open-Meteo: kein Treffer');
    } catch (e) { errors.push(`Open-Meteo: ${e.message}`); }
    throw new Error(`PLZ ${code} nicht gefunden (${errors.join('; ')})`);
}

/** Prognose abrufen und aufbereiten. */
async function fetchForecast({ lat, lon, tilt, azimuth, days = 4 }) {
    const q = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        hourly: 'global_tilted_irradiance',
        daily: 'sunrise,sunset',
        tilt: String(tilt),
        azimuth: String(azimuth),
        forecast_days: String(days),
        timezone: 'auto',
        timeformat: 'unixtime',
    });
    const raw = await getJson(`${FORECAST_URL}?${q}`);
    return parseForecast(raw);
}

/**
 * Antwort von Open-Meteo in ein kompaktes Format bringen.
 * Stundenwerte sind Mittel der vorangegangenen Stunde: Wert mit Zeitstempel t gilt für [t-1h, t).
 * Für die Tageszuordnung wird daher der Beginn des Intervalls verwendet.
 * @returns {{ fetchedAt:number, hours:{ts:number, day:string, kwhM2:number}[], days:{date:string, kwhM2:number, sunrise:number|null, sunset:number|null}[] }}
 */
function parseForecast(raw, now = Date.now()) {
    if (!raw || !raw.hourly || !Array.isArray(raw.hourly.time) || !Array.isArray(raw.hourly.global_tilted_irradiance)) {
        throw new Error('Prognose ohne Stundenwerte');
    }
    const hours = [];
    const byDay = new Map();
    raw.hourly.time.forEach((t, i) => {
        const w = Number(raw.hourly.global_tilted_irradiance[i]);
        const startTs = t * 1000 - 3_600_000;
        const kwhM2 = Number.isFinite(w) && w > 0 ? w / 1000 : 0;
        const day = dayKey(startTs);
        hours.push({ ts: startTs, day, kwhM2 });
        byDay.set(day, (byDay.get(day) || 0) + kwhM2);
    });
    const sun = new Map();
    if (raw.daily && Array.isArray(raw.daily.time)) {
        raw.daily.time.forEach((t, i) => {
            const rise = raw.daily.sunrise && raw.daily.sunrise[i];
            const set = raw.daily.sunset && raw.daily.sunset[i];
            sun.set(dayKey(t * 1000), { sunrise: Number.isFinite(rise) ? rise * 1000 : null, sunset: Number.isFinite(set) ? set * 1000 : null });
        });
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, kwhM2]) => ({
        date,
        kwhM2: Math.round(kwhM2 * 1000) / 1000,
        sunrise: (sun.get(date) || {}).sunrise || null,
        sunset: (sun.get(date) || {}).sunset || null,
    }));
    if (!hours.length) throw new Error('Prognose leer');
    return { fetchedAt: now, hours, days };
}

module.exports = { geocodePostalCode, fetchForecast, parseForecast };
