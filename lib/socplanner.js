'use strict';

/**
 * SoC-Planer: bestimmt den Mindest-SoC (Abschaltschwelle des Nulleinspeisung-Adapters)
 * aus Wetterprognose, gelerntem Lade-/Entladeverhalten und Jahreszeit.
 * Reine Logik ohne ioBroker-Abhängigkeit (testbar).
 *
 * Grundidee: Der Akku darf nur dann bis zum Minimum entladen werden, wenn absehbar ist,
 * dass er bald wieder aufgeladen wird. Sonst wird er auf einem saisonalen Park-SoC gehalten.
 *
 * Topologie: PV speist ins Hausnetz, Ladegeräte laden den Akku aus dem Überschuss,
 * Akku-Wechselrichter entladen ihn. Deshalb wird gelernt:
 *   Ladung_Tag ≈ a · (PV_Tag − b)    a = Anteil des Überschusses, der im Akku landet
 *                                    b = Tageslast, die vor dem Laden gedeckt wird
 *   Entladung_Tag ≈ Median der letzten 14 Tage
 */

const { dayKey } = require('./energystats');

const DAY_MS = 86_400_000;

const DEFAULTS = {
    capacityKWh: 5.12,
    socMinPercent: 20,
    parkSummerPercent: 20,
    parkWinterPercent: 70,
    refillPercent: 80,
    kwpTotal: 0,
    performanceRatio: 0.85,
    chargeEfficiency: 0.92,     // Ladegerät AC → Akku DC
    dischargeEfficiency: 0.92,  // Akku DC → Wechselrichter AC
    defaultChargeFactor: 0.8,
    defaultBaseLoadKWh: 3,
    defaultDischargeKWh: 3,
    minLearningDays: 7,
    confidence: [1, 1, 0.7, 0.5], // heute, morgen, übermorgen, Tag 3
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Tag im Jahr (1–366), lokal. */
function dayOfYear(ts) {
    const d = new Date(ts);
    return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / DAY_MS);
}

/** Park-SoC als Kosinuskurve: Winterwert am 21.12., Sommerwert am 21.6. */
function seasonalPark(ts, summer, winter) {
    const phase = (2 * Math.PI * (dayOfYear(ts) - 355)) / 365.25;
    return summer + (winter - summer) * (1 + Math.cos(phase)) / 2;
}

class SocPlanner {
    constructor(cfg = {}) {
        this.cfg = { ...DEFAULTS, ...cfg };
        const c = this.cfg;
        c.parkWinterPercent = Math.max(c.parkWinterPercent, c.socMinPercent);
        c.parkSummerPercent = Math.max(c.parkSummerPercent, c.socMinPercent);
    }

    /** Lernt Kalibrierfaktor, Lademodell und Entladung aus dem Verlauf (abgeschlossene Tage). */
    learn(history) {
        const c = this.cfg;
        const full = (history || []).filter((d) => d && d.coverage >= 0.9);

        // Kalibrierfaktor Prognose → gemessener PV-Ertrag
        const cal = full.slice(-21).filter((d) => d.forecastPvRaw > 0.5 && d.pv > 0);
        let calibration = 1;
        if (cal.length >= 3) {
            const sp = cal.reduce((s, d) => s + d.pv, 0);
            const sf = cal.reduce((s, d) => s + d.forecastPvRaw, 0);
            calibration = clamp(sp / sf, 0.3, 2);
        }

        // Lademodell: nur Tage, an denen der Akku nicht voll war (sonst ist die Ladung gekappt)
        const pts = full.slice(-30).filter((d) => d.pv > 0.2 && (d.socMax === null || d.socMax < 97));
        let a = c.defaultChargeFactor;
        let b = c.defaultBaseLoadKWh;
        let chargeLearned = false;
        if (pts.length >= 5) {
            const n = pts.length;
            const mx = pts.reduce((s, d) => s + d.pv, 0) / n;
            const my = pts.reduce((s, d) => s + d.charge, 0) / n;
            const sxx = pts.reduce((s, d) => s + (d.pv - mx) ** 2, 0);
            const sxy = pts.reduce((s, d) => s + (d.pv - mx) * (d.charge - my), 0);
            if (sxx > 1e-6) {
                const alpha = sxy / sxx;
                const beta = my - alpha * mx;
                const bb = alpha > 0 ? -beta / alpha : NaN;
                if (alpha >= 0.05 && alpha <= 1.2 && bb >= 0 && bb <= 50) { a = alpha; b = bb; chargeLearned = true; }
            }
        }

        // Entladung je Tag
        const dis = full.slice(-14).map((d) => d.discharge).filter((v) => v > 0);
        const dischargeKWh = dis.length >= 3 ? median(dis) : c.defaultDischargeKWh;

        this.model = { calibration, a, b, chargeLearned, dischargeKWh, learnedDays: full.length };
        return this.model;
    }

    /**
     * Plant den Mindest-SoC.
     * @param {object} p
     * @param {number} p.now
     * @param {number} p.soc          aktueller SoC in %
     * @param {object|null} p.forecast  Ergebnis von parseForecast
     * @returns {object} Plan mit cutoff, park, reason, Tageswerten
     */
    plan({ now, soc, forecast }) {
        const c = this.cfg;
        const m = this.model || this.learn([]);
        const park = Math.round(seasonalPark(now, c.parkSummerPercent, c.parkWinterPercent));
        const base = { now, park, model: m, days: [], minSoc: null };

        if (!Number.isFinite(soc)) return { ...base, cutoff: park, mode: 'fallback', reason: `SoC unbekannt – Park-SoC ${park} %` };
        if (!forecast || !forecast.hours || !forecast.hours.length) return { ...base, cutoff: null, mode: 'noforecast', reason: 'Keine Prognose verfügbar' };
        if (!(c.kwpTotal > 0)) return { ...base, cutoff: park, mode: 'fallback', reason: `Keine PV-Leistung (kWp) konfiguriert – Park-SoC ${park} %` };

        const sim = this.simulate({ now, soc, forecast });
        const days = sim.days;
        const learning = m.learnedDays < c.minLearningDays;

        const when = (i) => ['heute', 'morgen', 'übermorgen', 'in 3 Tagen'][i] || `in ${i} Tagen`;
        let cutoff;
        let reason;
        if (learning) {
            cutoff = park;
            reason = `Lernphase (${m.learnedDays}/${c.minLearningDays} Tage) – Park-SoC ${park} %`;
        } else if (sim.floorDay === -1) {
            cutoff = c.socMinPercent;
            reason = `Akku bleibt laut Prognose über ${c.socMinPercent} % (Minimum ${Math.round(sim.minSoc)} %) – Entladung erlaubt`;
        } else if (sim.refillDay === -1) {
            cutoff = park;
            reason = `Akku wäre ${when(sim.floorDay)} leer, Wiederaufladung über ${c.refillPercent} % in den nächsten ${Math.max(1, days.length - 1)} Tagen nicht absehbar – Park-SoC ${park} %`;
        } else {
            const w = c.confidence[Math.min(sim.refillDay, c.confidence.length - 1)];
            cutoff = Math.round(c.socMinPercent + (park - c.socMinPercent) * (1 - w));
            const d = days[sim.refillDay];
            reason = `Akku wäre ${when(sim.floorDay)} leer, wird ${when(sim.refillDay)} wieder auf ${Math.round(d.peakSoc)} % geladen (Prognose ${r1(d.pvKWh)} kWh PV)`
                + (cutoff > c.socMinPercent ? ` – Prognose unsicher, Mindest-SoC ${cutoff} %` : ` – Entladung bis ${cutoff} % erlaubt`);
        }
        cutoff = clamp(cutoff, c.socMinPercent, 100);
        return { ...base, cutoff, mode: learning ? 'learning' : 'forecast', reason, days, minSoc: sim.minSoc, floorDay: sim.floorDay, refillDay: sim.refillDay };
    }

    /**
     * Stündliche SoC-Simulation ab jetzt bis zum Ende des letzten Prognosetags.
     * Der Akku wird dabei nie unter socMinPercent entladen (so verhält sich die Regelung).
     */
    simulate({ now, soc, forecast }) {
        const c = this.cfg;
        const m = this.model;
        const pctPerKWh = 100 / c.capacityKWh;
        const pvFactor = c.kwpTotal * c.performanceRatio * m.calibration;

        // Tagesweise PV und Ladung
        const dayMap = new Map();
        for (const h of forecast.hours) {
            if (!dayMap.has(h.day)) dayMap.set(h.day, { date: h.day, pvKWh: 0, hours: [] });
            const d = dayMap.get(h.day);
            const pv = h.kwhM2 * pvFactor;
            d.pvKWh += pv;
            d.hours.push({ ts: h.ts, pv });
        }
        const days = [...dayMap.values()].sort((x, y) => x.date.localeCompare(y.date));
        const todayKey = days.length ? days.find((d) => d.hours.some((h) => h.ts + 3_600_000 > now)) : null;

        let s = clamp(soc, 0, 100);
        let minSoc = s;
        let floorDay = -1;   // Tag (Index), an dem der Akku das Minimum erreicht
        let refillDay = -1;  // erster Tag danach mit SoC >= refillPercent
        const outDays = [];
        const dischargePerHourPct = (m.dischargeKWh / 24 / c.dischargeEfficiency) * pctPerKWh;

        for (const d of days) {
            const future = d.hours.filter((h) => h.ts + 3_600_000 > now);
            if (!future.length) continue;
            if (todayKey && d.date < todayKey.date) continue;
            const chargeKWh = Math.max(0, m.a * (d.pvKWh - m.b)) * c.chargeEfficiency;
            let peak = s;
            let low = s;
            for (const h of future) {
                const share = d.pvKWh > 0 ? h.pv / d.pvKWh : 0;
                // Anteil der laufenden Stunde, der noch in der Zukunft liegt
                const frac = clamp((h.ts + 3_600_000 - Math.max(h.ts, now)) / 3_600_000, 0, 1);
                s += (chargeKWh * share * pctPerKWh - dischargePerHourPct) * frac;
                s = clamp(s, c.socMinPercent, 100);
                const di = outDays.length;
                if (floorDay === -1 && s <= c.socMinPercent + 0.5) floorDay = di;
                else if (floorDay !== -1 && refillDay === -1 && s >= c.refillPercent) refillDay = di;
                peak = Math.max(peak, s);
                low = Math.min(low, s);
            }
            minSoc = Math.min(minSoc, low);
            outDays.push({ date: d.date, pvKWh: r2(d.pvKWh), chargeKWh: r2(chargeKWh), peakSoc: r1(peak), minSoc: r1(low), endSoc: r1(s) });
        }
        return { days: outDays, minSoc: r1(minSoc), floorDay, refillDay };
    }
}

/**
 * Prüft, ob ein Entscheidungszeitpunkt erreicht ist.
 * Abend: von Sonnenuntergang −30 min bis +3 h. Morgen: Sonnenaufgang +1 h bis +4 h.
 * Ohne Sonnenzeiten für heute (keine/alte Prognose): 17:30–21:00 und 08:00–11:00.
 * @returns {string|null} Slot-Schlüssel (z. B. '2026-10-27-abend') oder null
 */
function decisionSlot(now, forecast) {
    const today = dayKey(now);
    const d = forecast && Array.isArray(forecast.days) ? forecast.days.find((x) => x.date === today) : null;
    let evening;
    let morning;
    if (d && d.sunset && d.sunrise) {
        evening = [d.sunset - 30 * 60_000, d.sunset + 3 * 3_600_000];
        morning = [d.sunrise + 3_600_000, d.sunrise + 4 * 3_600_000];
    } else {
        const mid = new Date(now); mid.setHours(0, 0, 0, 0);
        const t0 = mid.getTime();
        evening = [t0 + 17.5 * 3_600_000, t0 + 21 * 3_600_000];
        morning = [t0 + 8 * 3_600_000, t0 + 11 * 3_600_000];
    }
    if (now >= evening[0] && now <= evening[1]) return `${today}-abend`;
    if (now >= morning[0] && now <= morning[1]) return `${today}-morgen`;
    return null;
}

module.exports = { SocPlanner, seasonalPark, decisionSlot, dayOfYear, DEFAULTS };
