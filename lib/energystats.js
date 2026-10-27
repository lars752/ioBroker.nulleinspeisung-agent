'use strict';

/**
 * Energiestatistik: integriert Leistungswerte (W) zu Tagesenergien (kWh).
 * Reine Logik ohne ioBroker-Abhängigkeit (testbar).
 *
 * Kanäle:
 *   pv        – Summe der PV-Gruppen
 *   charge    – Ladeleistung in den Akku (Ladegeräte)
 *   discharge – Entladeleistung aus dem Akku (Akku-Wechselrichter)
 *
 * Je Tag wird zusätzlich der höchste und niedrigste SoC sowie die
 * PV-Prognose (Rohwert, ohne Kalibrierfaktor) für diesen Tag festgehalten.
 */

const CHANNELS = ['pv', 'charge', 'discharge'];
const MAX_GAP_MS = 5 * 60_000;   // längere Lücken (Neustart, Ausfall) werden nicht überbrückt
const HISTORY_DAYS = 60;

/** Lokales Datum als 'YYYY-MM-DD'. */
function dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay(key) {
    return { date: key, pv: 0, charge: 0, discharge: 0, socMin: null, socMax: null, forecastPvRaw: null, coverage: 0 };
}

class EnergyStats {
    constructor() {
        this.history = [];      // abgeschlossene Tage, älteste zuerst
        this.today = null;      // laufender Tag
        this._last = null;      // { ts, values }
    }

    /**
     * Neuen Messpunkt einbuchen.
     * @param {number} ts
     * @param {{pv?:number, charge?:number, discharge?:number}} values  Leistungen in W (fehlend = unbekannt)
     * @param {number|null} soc
     * @returns {object|null} abgeschlossener Tag, falls ein Tageswechsel stattfand
     */
    sample(ts, values, soc = null) {
        const key = dayKey(ts);
        let closed = null;
        if (!this.today) this.today = emptyDay(key);

        if (this._last && ts > this._last.ts) {
            const dt = ts - this._last.ts;
            if (dt <= MAX_GAP_MS) {
                // Rechteckregel mit dem vorherigen Wert; bei Tageswechsel anteilig aufteilen
                const lastKey = dayKey(this._last.ts);
                if (lastKey !== key) {
                    const midnight = new Date(ts); midnight.setHours(0, 0, 0, 0);
                    this._accumulate(this.today, this._last.values, midnight.getTime() - this._last.ts);
                    closed = this._closeDay(key);
                    this._accumulate(this.today, this._last.values, ts - midnight.getTime());
                } else {
                    this._accumulate(this.today, this._last.values, dt);
                }
            } else if (dayKey(this._last.ts) !== key) {
                closed = this._closeDay(key);
            }
        } else if (this.today.date !== key) {
            closed = this._closeDay(key);
        }

        if (typeof soc === 'number' && Number.isFinite(soc)) {
            const t = this.today;
            t.socMin = t.socMin === null ? soc : Math.min(t.socMin, soc);
            t.socMax = t.socMax === null ? soc : Math.max(t.socMax, soc);
        }
        this._last = { ts, values: { ...values } };
        return closed;
    }

    /** PV-Prognose (Rohwert in kWh) für den laufenden Tag merken. */
    setTodayForecast(kwhRaw) {
        if (this.today && Number.isFinite(kwhRaw)) this.today.forecastPvRaw = kwhRaw;
    }

    /** Letzte n abgeschlossene Tage. */
    recent(n) { return this.history.slice(-n); }

    toJSON() {
        return { version: 1, history: this.history, today: this.today };
    }

    /** Zustand aus gespeichertem JSON wiederherstellen (fehlerhafte Daten werden verworfen). */
    restore(json, now = Date.now()) {
        let data;
        try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return false; }
        if (!data || !Array.isArray(data.history)) return false;
        const valid = (d) => d && typeof d.date === 'string' && CHANNELS.every((c) => Number.isFinite(d[c]));
        this.history = data.history.filter(valid).slice(-HISTORY_DAYS);
        const key = dayKey(now);
        if (valid(data.today)) {
            if (data.today.date === key) this.today = { ...emptyDay(key), ...data.today };
            else if (!this.history.some((d) => d.date === data.today.date)) {
                this.history.push(data.today);
                this.history = this.history.slice(-HISTORY_DAYS);
            }
        }
        this._last = null;
        return true;
    }

    // ------------------------------------------------------------------ //

    _accumulate(day, values, dtMs) {
        if (dtMs <= 0) return;
        const h = dtMs / 3_600_000;
        for (const c of CHANNELS) {
            const w = values[c];
            if (typeof w === 'number' && Number.isFinite(w) && w > 0) day[c] += (w * h) / 1000;
        }
        day.coverage += dtMs / 86_400_000;
    }

    _closeDay(newKey) {
        const done = this.today;
        const round = (v) => Math.round(v * 1000) / 1000;
        for (const c of CHANNELS) done[c] = round(done[c]);
        done.coverage = Math.round(Math.min(1, done.coverage) * 100) / 100;
        this.history.push(done);
        if (this.history.length > HISTORY_DAYS) this.history.shift();
        this.today = emptyDay(newKey);
        return done;
    }
}

module.exports = { EnergyStats, dayKey, MAX_GAP_MS };
