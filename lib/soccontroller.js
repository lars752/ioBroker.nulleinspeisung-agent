'use strict';

/**
 * SoC-Steuerung per Wetterprognose – ioBroker-Anbindung.
 *
 *   Statistik-Takt (30 s)  → Gruppenleistungen + SoC einlesen, zu Tages-kWh integrieren
 *   Planungs-Takt (10 min) → Prognose (stündlich erneuert), Modell lernen, Mindest-SoC planen,
 *                            zu den Entscheidungszeitpunkten (Abend/Morgen) an den
 *                            Nulleinspeisung-Adapter übergeben
 *
 * Statistik und Empfehlung laufen immer (auch wenn die Steuerung aus ist), damit das
 * Modell schon lernt, bevor der Agent eingreifen darf.
 */

const { EnergyStats } = require('./energystats');
const { geocodePostalCode, fetchForecast } = require('./forecast');
const { SocPlanner, decisionSlot } = require('./socplanner');

const SAMPLE_MS = 30_000;
const PLAN_MS = 10 * 60_000;
const FORECAST_MAX_AGE_MS = 60 * 60_000;
const FORECAST_STALE_MS = 48 * 3_600_000;
const PERSIST_MS = 60 * 60_000;      // Verlauf (JSON) sichern: stündlich, beim Tageswechsel und beim Stoppen
const PUBLISH_MS = 5 * 60_000;       // Statistik.Heute.* veröffentlichen (intern wird alle 30 s integriert)
const ROLES = ['pv', 'akku', 'lader'];

const num = (v, def) => {
    const n = Number(v);
    return v === '' || v === null || v === undefined || !Number.isFinite(n) ? def : n;
};

/** Konfiguration der SoC-Steuerung aus adapter.config lesen und prüfen. */
function normalizeSocConfig(c) {
    const groups = (Array.isArray(c.energyGroups) ? c.energyGroups : [])
        .filter((g) => g && (g.active === true || g.active === 'true') && ROLES.includes(g.role) && String(g.powerId || '').trim())
        .map((g) => ({
            role: g.role,
            powerId: String(g.powerId).trim(),
            // Leistung in W (PV: Wp, Lader: max. Ladeleistung); 'kwp' aus v1.1.0 wird weiter verstanden
            watt: Math.max(0, g.watt !== undefined && g.watt !== '' ? num(g.watt, 0) : num(g.kwp, 0) * 1000),
            name: String(g.name || g.powerId),
        }));
    const socMin = Math.min(100, Math.max(0, num(c.socMinPercent, 20)));
    return {
        enabled: c.socEnabled === true || c.socEnabled === 'true',
        socId: String(c.socId || 'growatt-bms.0.bms.SoC').trim(),
        groups,
        kwpTotal: groups.filter((g) => g.role === 'pv').reduce((s, g) => s + g.watt, 0) / 1000,
        chargerMaxW: groups.filter((g) => g.role === 'lader').reduce((s, g) => s + g.watt, 0),
        plz: String(c.plz || '').trim(),
        country: String(c.country || 'DE').trim() || 'DE',
        latitude: num(c.latitude, 0),
        longitude: num(c.longitude, 0),
        tilt: Math.min(90, Math.max(0, num(c.tilt, 32))),
        azimuth: Math.min(180, Math.max(-180, num(c.azimuth, 0))),
        hysteresisPercent: Math.max(0, num(c.hysteresisPercent, 5)),
        planner: {
            capacityKWh: Math.max(0.1, num(c.capacityKWh, 5.12)),
            socMinPercent: socMin,
            parkSummerPercent: Math.min(100, Math.max(socMin, num(c.parkSummerPercent, 20))),
            parkWinterPercent: Math.min(100, Math.max(socMin, num(c.parkWinterPercent, 70))),
            refillPercent: Math.min(100, Math.max(socMin + 1, num(c.refillPercent, 80))),
            performanceRatio: Math.min(1.2, Math.max(0.3, num(c.performanceRatio, 0.85))),
            chargeEfficiency: Math.min(1, Math.max(0.5, num(c.chargeEfficiency, 0.92))),
            dischargeEfficiency: Math.min(1, Math.max(0.5, num(c.dischargeEfficiency, 0.92))),
            defaultChargeFactor: Math.min(1.2, Math.max(0.05, num(c.defaultChargeFactor, 0.8))),
            defaultBaseLoadKWh: Math.max(0, num(c.defaultBaseLoadKWh, 3)),
            defaultDischargeKWh: Math.max(0, num(c.defaultDischargeKWh, 3)),
            minLearningDays: Math.max(0, Math.round(num(c.minLearningDays, 7))),
        },
    };
}

// Datenpunkte: [id, name, type, role, unit]
const STATES = [
    ['SoC.Empfehlung_Prozent', 'Empfohlener Mindest-SoC', 'number', 'value', '%'],
    ['SoC.Gesetzt_Prozent', 'Vom Agenten gesetzter Mindest-SoC (leer = keine Vorgabe)', 'number', 'value', '%'],
    ['SoC.Park_Prozent', 'Saisonaler Park-SoC', 'number', 'value', '%'],
    ['SoC.Grund', 'Begründung der Empfehlung', 'string', 'text', ''],
    ['SoC.Modus', 'Planungsmodus (forecast, learning, fallback, noforecast)', 'string', 'text', ''],
    ['SoC.LetzterSlot', 'Letzter Entscheidungszeitpunkt', 'string', 'text', ''],
    ['SoC.Plan', 'Simulation je Tag (JSON)', 'string', 'json', ''],
    ['Prognose.Stand', 'Zeitpunkt der letzten Prognose', 'number', 'date', ''],
    ['Prognose.Standort', 'Standort der Prognose (JSON)', 'string', 'json', ''],
    ['Prognose.PV_kWh_Heute', 'PV-Prognose heute (kalibriert)', 'number', 'value.energy', 'kWh'],
    ['Prognose.PV_kWh_Tag1', 'PV-Prognose morgen (kalibriert)', 'number', 'value.energy', 'kWh'],
    ['Prognose.PV_kWh_Tag2', 'PV-Prognose übermorgen (kalibriert)', 'number', 'value.energy', 'kWh'],
    ['Prognose.PV_kWh_Tag3', 'PV-Prognose in 3 Tagen (kalibriert)', 'number', 'value.energy', 'kWh'],
    ['Prognose.SoC_Min_Prozent', 'Niedrigster SoC im Prognosezeitraum', 'number', 'value', '%'],
    ['Modell.Kalibrierfaktor', 'Gemessener / prognostizierter PV-Ertrag', 'number', 'value', ''],
    ['Modell.Ladefaktor', 'Anteil des PV-Überschusses, der im Akku landet (a)', 'number', 'value', ''],
    ['Modell.Grundlast_kWh', 'Tageslast, die vor dem Laden gedeckt wird (b)', 'number', 'value.energy', 'kWh'],
    ['Modell.Entladung_kWh_Tag', 'Typische Entladung je Tag (Median 14 Tage)', 'number', 'value.energy', 'kWh'],
    ['Modell.Lerntage', 'Vollständig erfasste Tage im Verlauf', 'number', 'value', ''],
    ['Statistik.Heute.PV_kWh', 'PV-Ertrag heute', 'number', 'value.energy', 'kWh'],
    ['Statistik.Heute.Ladung_kWh', 'Akkuladung heute', 'number', 'value.energy', 'kWh'],
    ['Statistik.Heute.Entladung_kWh', 'Akkuentladung heute', 'number', 'value.energy', 'kWh'],
    ['Statistik.Gestern.PV_kWh', 'PV-Ertrag gestern', 'number', 'value.energy', 'kWh'],
    ['Statistik.Gestern.Ladung_kWh', 'Akkuladung gestern', 'number', 'value.energy', 'kWh'],
    ['Statistik.Gestern.Entladung_kWh', 'Akkuentladung gestern', 'number', 'value.energy', 'kWh'],
    ['Statistik.Verlauf', 'Tagesverlauf (JSON, 60 Tage)', 'string', 'json', ''],
];

class SocController {
    /**
     * @param {object} adapter  ioBroker-Adapterinstanz
     * @param {string} target   Nulleinspeisung-Instanz, z. B. 'nulleinspeisung.0'
     * @param {boolean} dryRun  globaler Trockenlauf des Agenten
     */
    constructor(adapter, target, dryRun) {
        this.a = adapter;
        this.log = adapter.log;
        this.target = target;
        this.dryRun = !!dryRun;
        this.cfg = normalizeSocConfig(adapter.config);
        this.stats = new EnergyStats();
        this.planner = new SocPlanner({ ...this.cfg.planner, kwpTotal: this.cfg.kwpTotal, chargerMaxW: this.cfg.chargerMaxW });
        this.forecast = null;
        this.location = null;
        this.applied = null;     // vom Agenten gesetzter Cutoff
        this.lastSlot = '';
        this.timers = [];
        this._lastPersist = Date.now();   // nach dem Start erst in einer Stunde sichern
        this._lastPublish = 0;
        this._lastForecastTry = 0;
        this._busy = false;
    }

    async start() {
        const c = this.cfg;
        await this._createStates();
        const verlauf = await this.a.getStateAsync('Statistik.Verlauf');
        if (verlauf && verlauf.val) this.stats.restore(verlauf.val);
        const gesetzt = await this.a.getStateAsync('SoC.Gesetzt_Prozent');
        if (gesetzt && typeof gesetzt.val === 'number') this.applied = gesetzt.val;
        const slot = await this.a.getStateAsync('SoC.LetzterSlot');
        if (slot && slot.val) this.lastSlot = String(slot.val);

        const roles = ROLES.map((r) => `${r}: ${c.groups.filter((g) => g.role === r).length}`).join(', ');
        this.log.info(`[SoC] Steuerung ${c.enabled ? (this.dryRun ? 'aktiv (Trockenlauf)' : 'aktiv') : 'aus – nur Statistik und Empfehlung'}; Gruppen ${roles}; PV ${c.kwpTotal} kWp; Lader max. ${c.chargerMaxW || 'unbegrenzt'} W`);
        if (!c.groups.some((g) => g.role === 'pv')) this.log.warn('[SoC] Keine PV-Gruppe konfiguriert – bitte im Tab "SoC-Prognose" Gruppen scannen und Rollen/kWp eintragen');

        if (!c.enabled && this.applied !== null) await this._restoreBaseCutoff();

        this._safe(() => this._sample());
        this.timers.push(setInterval(() => this._safe(() => this._sample()), SAMPLE_MS));
        this.timers.push(setTimeout(() => this._safe(() => this._planTick()), 20_000));
        this.timers.push(setInterval(() => this._safe(() => this._planTick()), PLAN_MS));
    }

    async stop() {
        for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
        this.timers = [];
        try { await this._publishToday(); await this._persist(); } catch { /* ignore */ }
    }

    /** Gruppen für die Admin-Oberfläche vorschlagen (alle *.info.Total_Power). */
    static async scanGroups(adapter, existing) {
        const known = new Map((Array.isArray(existing) ? existing : []).map((g) => [g.powerId, g]));
        const objs = (await adapter.getForeignObjectsAsync('*.info.Total_Power', 'state')) || {};
        const rows = [];
        for (const id of Object.keys(objs).sort()) {
            if (id.startsWith(`${adapter.namespace}.`)) continue;
            const parts = id.split('.');
            const group = parts[parts.length - 3] || id;
            const adapterName = parts[0];
            let role = 'ignorieren';
            if (/^pv/i.test(group)) role = 'pv';
            else if (/^akku/i.test(group)) role = 'akku';
            else if (/t2mg|trucki|lader|charger/i.test(adapterName)) role = 'lader';
            const old = known.get(id);
            rows.push(old ? { ...old } : { active: role !== 'ignorieren', name: `${adapterName}/${group}`, role, powerId: id, watt: 0 });
        }
        // Manuell eingetragene Zeilen ohne Treffer behalten
        for (const g of known.values()) if (!rows.some((r) => r.powerId === g.powerId)) rows.push(g);
        return rows;
    }

    // ------------------------------------------------------------------ //
    // Statistik
    // ------------------------------------------------------------------ //

    async _sample() {
        const c = this.cfg;
        const ids = [...new Set([...c.groups.map((g) => g.powerId), c.socId])];
        const states = ids.length ? await this.a.getForeignStatesAsync(ids) : {};
        const now = Date.now();
        const sum = (role) => {
            const list = c.groups.filter((g) => g.role === role);
            if (!list.length) return undefined;
            let total = 0;
            let any = false;
            for (const g of list) {
                const st = states[g.powerId];
                const v = st ? Number(st.val) : NaN;
                if (Number.isFinite(v) && now - (st.ts || 0) < 10 * 60_000) { total += Math.max(0, v); any = true; }
            }
            return any ? total : undefined;
        };
        const socSt = states[c.socId];
        const soc = socSt && Number.isFinite(Number(socSt.val)) ? Number(socSt.val) : null;
        this._soc = soc;

        const closed = this.stats.sample(now, { pv: sum('pv'), charge: sum('lader'), discharge: sum('akku') }, soc);
        if (closed) {
            this.log.info(`[SoC] Tag ${closed.date}: PV ${closed.pv} kWh, Ladung ${closed.charge} kWh, Entladung ${closed.discharge} kWh, SoC ${closed.socMin}–${closed.socMax} %`);
            await Promise.all([
                this._set('Statistik.Gestern.PV_kWh', closed.pv),
                this._set('Statistik.Gestern.Ladung_kWh', closed.charge),
                this._set('Statistik.Gestern.Entladung_kWh', closed.discharge),
            ]);
            await this._persist();
        }
        if (closed || now - this._lastPublish >= PUBLISH_MS) await this._publishToday(now);
        if (now - this._lastPersist > PERSIST_MS) await this._persist();
    }

    async _publishToday(now = Date.now()) {
        this._lastPublish = now;
        const t = this.stats.today;
        await Promise.all([
            this._set('Statistik.Heute.PV_kWh', Math.round(t.pv * 100) / 100),
            this._set('Statistik.Heute.Ladung_kWh', Math.round(t.charge * 100) / 100),
            this._set('Statistik.Heute.Entladung_kWh', Math.round(t.discharge * 100) / 100),
        ]);
    }

    async _persist() {
        this._lastPersist = Date.now();
        await this._set('Statistik.Verlauf', JSON.stringify(this.stats.toJSON()));
    }

    // ------------------------------------------------------------------ //
    // Prognose und Planung
    // ------------------------------------------------------------------ //

    async _planTick() {
        if (this._busy) return;
        this._busy = true;
        try {
            await this._refreshForecast();
            const now = Date.now();
            const c = this.cfg;

            // PV-Prognose (Rohwert) für heute festhalten – Grundlage der Kalibrierung
            if (this.forecast) {
                const today = this.forecast.days.find((d) => d.date === this.stats.today.date);
                if (today) this.stats.setTodayForecast(today.kwhM2 * c.kwpTotal * c.planner.performanceRatio);
            }

            const model = this.planner.learn(this.stats.history);
            const fresh = this.forecast && now - this.forecast.fetchedAt < FORECAST_STALE_MS ? this.forecast : null;
            const plan = this.planner.plan({ now, soc: this._soc, forecast: fresh });
            if (plan.mode === 'noforecast') {
                if (this.forecast) {
                    plan.cutoff = plan.park;
                    plan.reason = `Prognose älter als 48 h – Park-SoC ${plan.park} %`;
                } else {
                    plan.cutoff = null;
                    plan.reason = 'Noch keine Prognose – keine Änderung';
                }
            }
            await this._publishPlan(plan, model);

            if (!c.enabled) return;
            const current = await this._readTargetCutoff();

            // Nach Neustart der Nulleinspeisung: gesetzten Wert wiederherstellen
            if (this.applied !== null && current !== null && current !== this.applied) {
                this.log.info(`[SoC] Nulleinspeisung meldet ${current} %, Agent hatte ${this.applied} % gesetzt – stelle wieder her`);
                await this._applyCutoff(this.applied, 'Wiederherstellung nach Neustart der Nulleinspeisung');
            }

            const slot = decisionSlot(now, this.forecast);
            if (!slot || slot === this.lastSlot || plan.cutoff === null) return;
            this.lastSlot = slot;
            await this._set('SoC.LetzterSlot', slot);
            const reference = this.applied !== null ? this.applied : current;
            if (reference !== null && Math.abs(plan.cutoff - reference) < c.hysteresisPercent && plan.cutoff !== c.planner.socMinPercent) {
                this.log.debug(`[SoC] ${slot}: Empfehlung ${plan.cutoff} % weicht weniger als ${c.hysteresisPercent} % von ${reference} % ab – keine Änderung`);
                return;
            }
            if (reference === plan.cutoff) return;
            await this._applyCutoff(plan.cutoff, plan.reason);
        } finally {
            this._busy = false;
        }
    }

    async _refreshForecast() {
        const now = Date.now();
        if (this.forecast && now - this.forecast.fetchedAt < FORECAST_MAX_AGE_MS) return;
        if (now - this._lastForecastTry < 5 * 60_000) return;
        this._lastForecastTry = now;
        try {
            const loc = await this._resolveLocation();
            if (!loc) return;
            this.forecast = await fetchForecast({ lat: loc.lat, lon: loc.lon, tilt: this.cfg.tilt, azimuth: this.cfg.azimuth });
            await this._set('Prognose.Stand', this.forecast.fetchedAt);
            this.log.debug(`[SoC] Prognose: ${this.forecast.days.map((d) => `${d.date} ${d.kwhM2} kWh/m²`).join(', ')}`);
        } catch (e) {
            this.log.warn(`[SoC] Prognose nicht abrufbar: ${e.message}`);
        }
    }

    /** Standort: feste Koordinaten → PLZ (zwischengespeichert) → ioBroker-Systemeinstellungen. */
    async _resolveLocation() {
        if (this.location) return this.location;
        const c = this.cfg;
        let loc = null;
        if (c.latitude && c.longitude) loc = { lat: c.latitude, lon: c.longitude, name: 'Koordinaten aus der Konfiguration', source: 'config' };
        if (!loc && c.plz) {
            const cached = await this.a.getStateAsync('Prognose.Standort');
            try {
                const j = cached && cached.val ? JSON.parse(cached.val) : null;
                if (j && j.plz === c.plz && j.country === c.country && Number.isFinite(j.lat)) loc = j;
            } catch { /* neu ermitteln */ }
            if (!loc) {
                try {
                    const g = await geocodePostalCode(c.plz, c.country);
                    loc = { ...g, plz: c.plz, country: c.country, source: 'plz' };
                    this.log.info(`[SoC] PLZ ${c.plz} → ${g.lat.toFixed(3)}, ${g.lon.toFixed(3)} (${g.name})`);
                } catch (e) { this.log.warn(`[SoC] ${e.message}`); }
            }
        }
        if (!loc) {
            const sys = await this.a.getForeignObjectAsync('system.config');
            const lat = sys && sys.common ? Number(sys.common.latitude) : NaN;
            const lon = sys && sys.common ? Number(sys.common.longitude) : NaN;
            if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) loc = { lat, lon, name: 'ioBroker-Systemeinstellungen', source: 'system' };
        }
        if (!loc) { this.log.warn('[SoC] Kein Standort: bitte PLZ oder Koordinaten im Tab "SoC-Prognose" eintragen'); return null; }
        this.location = loc;
        await this._set('Prognose.Standort', JSON.stringify(loc));
        return loc;
    }

    async _publishPlan(plan, model) {
        const day = (i) => (plan.days[i] ? plan.days[i].pvKWh : null);
        const offset = plan.days.length && plan.days[0].date === this.stats.today.date ? 0 : -1;
        await Promise.all([
            this._set('SoC.Empfehlung_Prozent', plan.cutoff),
            this._set('SoC.Park_Prozent', plan.park),
            this._set('SoC.Grund', plan.reason),
            this._set('SoC.Modus', plan.mode),
            this._set('SoC.Plan', JSON.stringify(plan.days)),
            this._set('Prognose.PV_kWh_Heute', offset === 0 ? day(0) : null),
            this._set('Prognose.PV_kWh_Tag1', day(1 + offset)),
            this._set('Prognose.PV_kWh_Tag2', day(2 + offset)),
            this._set('Prognose.PV_kWh_Tag3', day(3 + offset)),
            this._set('Prognose.SoC_Min_Prozent', plan.minSoc),
            this._set('Modell.Kalibrierfaktor', Math.round(model.calibration * 100) / 100),
            this._set('Modell.Ladefaktor', Math.round(model.a * 100) / 100),
            this._set('Modell.Grundlast_kWh', Math.round(model.b * 100) / 100),
            this._set('Modell.Entladung_kWh_Tag', Math.round(model.dischargeKWh * 100) / 100),
            this._set('Modell.Lerntage', model.learnedDays),
        ]);
    }

    // ------------------------------------------------------------------ //
    // Nulleinspeisung ansteuern
    // ------------------------------------------------------------------ //

    async _readTargetCutoff() {
        try {
            const r = await this.a._sendToAsync(this.target, 'getConfig', {});
            return r && Number.isFinite(Number(r.socCutoffPercent)) ? Number(r.socCutoffPercent) : null;
        } catch (e) {
            this.log.debug(`[SoC] getConfig fehlgeschlagen: ${e.message}`);
            return null;
        }
    }

    async _applyCutoff(value, reason) {
        if (this.dryRun) {
            this.log.info(`[SoC] [Trockenlauf] Mindest-SoC → ${value} % – ${reason}`);
            return;
        }
        try {
            const r = await this.a._sendToAsync(this.target, 'setConfig', { socCutoffPercent: value });
            if (r && r.rejected && r.rejected.socCutoffPercent) throw new Error(`abgelehnt: ${r.rejected.socCutoffPercent} (Nulleinspeisung ab v1.0.9 nötig)`);
            if (!r || !r.applied || !('socCutoffPercent' in r.applied)) throw new Error('keine Bestätigung – Nulleinspeisung ab v1.0.9 nötig');
            this.applied = value;
            await this._set('SoC.Gesetzt_Prozent', value);
            this.log.info(`[SoC] Mindest-SoC → ${value} % (Wiederfreigabe ${r.applied.socRestartPercent} %) – ${reason}`);
        } catch (e) {
            this.log.error(`[SoC] Mindest-SoC konnte nicht gesetzt werden: ${e.message}`);
        }
    }

    /** Steuerung ausgeschaltet: konfigurierten Grundwert der Nulleinspeisung wiederherstellen. */
    async _restoreBaseCutoff() {
        let base = this.cfg.planner.socMinPercent;
        try {
            const obj = await this.a.getForeignObjectAsync(`system.adapter.${this.target}`);
            if (obj && obj.native && Number.isFinite(Number(obj.native.socCutoffPercent))) base = Number(obj.native.socCutoffPercent);
        } catch { /* Standardwert */ }
        if (!this.dryRun) {
            try {
                await this.a._sendToAsync(this.target, 'setConfig', { socCutoffPercent: base });
                this.log.info(`[SoC] Steuerung aus – Mindest-SoC auf konfigurierten Wert ${base} % zurückgesetzt`);
            } catch (e) { this.log.warn(`[SoC] Zurücksetzen fehlgeschlagen: ${e.message}`); }
        }
        this.applied = null;
        await this._set('SoC.Gesetzt_Prozent', null);
    }

    // ------------------------------------------------------------------ //

    async _createStates() {
        for (const [id, name, type, role, unit] of STATES) {
            await this.a.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name, type, role, unit: unit || undefined, read: true, write: false },
                native: {},
            });
        }
    }

    /** Schreibt nur, wenn sich der Wert geändert hat (schont Datenbank und history/sql). */
    _set(id, val) {
        return this.a.setStateChangedAsync(id, { val: val === undefined ? null : val, ack: true });
    }

    _safe(fn) {
        Promise.resolve().then(fn).catch((e) => this.log.error(`[SoC] ${e.message}`));
    }
}

module.exports = { SocController, normalizeSocConfig };
