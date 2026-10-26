'use strict';

/**
 * Deterministischer Optimierungsloop für den Nulleinspeisung-Agent.
 *
 * Beobachtet Metriken (Netzbezug, Einspeisung, Regelabweichung) und passt
 * Parameter des Nulleinspeisung-Adapters autonom an.
 *
 * Architektur:
 *   1. observe(meter, soll) – wird bei jedem Zählerwert aufgerufen
 *   2. tune(currentParams) – läuft im Tune-Intervall, gibt Anpassung zurück
 *   3. reset()             – setzt Metriken zurück (nach erfolgreichem Tune)
 *
 * Rückgabe von tune():
 *   null                          → keine Anpassung nötig
 *   { params, reason, confident } → Anpassung + Begründung
 *     confident=false → LLM-Hook sollte einspringen
 */

const WINDOW_MAX = 500; // Anzahl Messpunkte im Sliding Window

class Optimizer {
    /**
     * @param {object} opts
     * @param {string[]} opts.allowedParams   – erlaubte Parameternamen
     * @param {number}   opts.importThresholdWh – ab wann Netzbezug als Problem gilt
     * @param {object}   opts.log              – ioBroker log-Objekt
     */
    constructor({ allowedParams, importThresholdWh, log }) {
        this.allowedParams = new Set(allowedParams || []);
        this.importThresholdWh = importThresholdWh || 5;
        this.log = log;

        // Metriken-Akkumulator (zwischen zwei tune()-Aufrufen)
        this.reset();

        // Verlauf der letzten Messpunkte für Mustererkennung
        this._window = []; // { ts, meter, soll }

        // Tuning-Verlauf (für LLM-Kontext)
        this._history = []; // { ts, params, reason, outcome }
        this._consecutiveFailures = 0;
    }

    // ------------------------------------------------------------------ //
    // Öffentliche API
    // ------------------------------------------------------------------ //

    /** Neuen Messwert einbuchen. meter in W (Bezug +, Einspeisung −), soll in W. */
    observe(meter, soll, ts = Date.now()) {
        // Zeitdelta zum letzten Messpunkt für Wh-Integration
        const last = this._window[this._window.length - 1];
        if (last) {
            const dtH = (ts - last.ts) / 3_600_000;
            if (meter > 0) this.importWh  += meter * dtH;
            else           this.exportWh  += (-meter) * dtH;
            this.errorWs += meter * (ts - last.ts) / 1000;
        }

        this._window.push({ ts, meter, soll });
        if (this._window.length > WINDOW_MAX) this._window.shift();
    }

    /** Gibt Parameteranpassung zurück oder null. currentParams: aktuelles cfg-Objekt. */
    tune(currentParams) {
        const w = this._window;
        if (w.length < 5) return null; // zu wenig Daten

        // Muster 1: anhaltender Netzbezug → deadBandWatts zu groß oder Intervall zu langsam
        if (this.importWh >= this.importThresholdWh) {
            return this._tuneImport(currentParams);
        }

        // Muster 2: Regelung schwingt (Zähler wechselt häufig Vorzeichen)
        if (this._detectOscillation()) {
            return this._tuneOscillation(currentParams);
        }

        // Muster 3: Einspeisung deutlich über Null obwohl Akku nicht voll
        // (wird vom Aufrufer mit SoC ergänzt – hier nur erkannt wenn Muster klar ist)
        if (this._detectPersistentExport()) {
            return this._tuneExport(currentParams);
        }

        return null;
    }

    /** Metriken zurücksetzen (nach Tune oder periodisch). */
    reset() {
        this.importWh = 0;
        this.exportWh = 0;
        this.errorWs  = 0;
    }

    /** Zustand des letzten Tuning-Ergebnisses als gut/schlecht markieren (für LLM-Kontext). */
    markOutcome(good) {
        const last = this._history[this._history.length - 1];
        if (last) last.outcome = good ? 'besser' : 'schlechter';
        if (!good) this._consecutiveFailures++;
        else       this._consecutiveFailures = 0;
    }

    /** Gibt true zurück wenn das LLM einspringen soll. */
    shouldCallLlm(llmTriggerAfter) {
        return this._consecutiveFailures >= llmTriggerAfter;
    }

    /** Kontext für den LLM-Aufruf (kompaktes JSON). */
    buildLlmContext(currentParams, recentWindowSize = 60) {
        const now = Date.now();
        const recent = this._window.filter((p) => now - p.ts <= recentWindowSize * 60_000);
        const meanMeter = recent.length
            ? recent.reduce((a, p) => a + p.meter, 0) / recent.length
            : null;

        return {
            metriken: {
                netzbezugWh: Math.round(this.importWh * 100) / 100,
                einspeisungWh: Math.round(this.exportWh * 100) / 100,
                mittlererZaehlerW: meanMeter !== null ? Math.round(meanMeter) : null,
            },
            aktuelleParameter: currentParams,
            erlaubteParameter: [...this.allowedParams],
            tuningVerlauf: this._history.slice(-5).map((h) => ({
                zeit: new Date(h.ts).toISOString(),
                parameter: h.params,
                grund: h.reason,
                ergebnis: h.outcome || 'unbekannt',
            })),
            aufeinanderfolgendeFehlversuche: this._consecutiveFailures,
        };
    }

    // ------------------------------------------------------------------ //
    // Interne Tuning-Strategien
    // ------------------------------------------------------------------ //

    _tuneImport(p) {
        const changes = {};
        const reasons = [];

        // deadBandWatts zu groß → Regelung greift zu spät
        if (this._allowed('deadBandWatts') && p.deadBandWatts > 5) {
            const next = Math.max(5, Math.round(p.deadBandWatts * 0.7));
            if (next !== p.deadBandWatts) { changes.deadBandWatts = next; reasons.push(`deadBandWatts ${p.deadBandWatts} → ${next} W (Netzbezug ${Math.round(this.importWh * 10) / 10} Wh)`); }
        }

        // Intervall zu langsam → schneller regeln
        if (!Object.keys(changes).length && this._allowed('regulatorIntervalMs') && p.regulatorIntervalMs > 1000) {
            const next = Math.max(1000, Math.round(p.regulatorIntervalMs * 0.75));
            if (next !== p.regulatorIntervalMs) { changes.regulatorIntervalMs = next; reasons.push(`regulatorIntervalMs ${p.regulatorIntervalMs} → ${next} ms (Regelung beschleunigt)`); }
        }

        if (!Object.keys(changes).length) {
            // Keine erlaubten Parameter mehr — LLM muss ran
            return { params: {}, reason: `Netzbezug ${Math.round(this.importWh * 10) / 10} Wh, keine weiteren deterministischen Schritte`, confident: false };
        }

        this._recordHistory(changes, reasons.join('; '));
        return { params: changes, reason: reasons.join('; '), confident: true };
    }

    _tuneOscillation(p) {
        const changes = {};
        const reasons = [];

        // deadBandWatts zu klein → Totband vergrößern
        if (this._allowed('deadBandWatts') && p.deadBandWatts < 50) {
            const next = Math.min(50, Math.round(p.deadBandWatts * 1.5));
            if (next !== p.deadBandWatts) { changes.deadBandWatts = next; reasons.push(`deadBandWatts ${p.deadBandWatts} → ${next} W (Schwingung gedaempft)`); }
        }

        if (!Object.keys(changes).length) {
            return { params: {}, reason: 'Schwingung erkannt, keine deterministischen Schritte', confident: false };
        }

        this._recordHistory(changes, reasons.join('; '));
        return { params: changes, reason: reasons.join('; '), confident: true };
    }

    _tuneExport(p) {
        const changes = {};
        const reasons = [];

        // Latenz-Toleranz zu groß → schneller konvergieren
        if (this._allowed('latencyToleranceW') && p.latencyToleranceW > 20) {
            const next = Math.max(20, Math.round(p.latencyToleranceW * 0.8));
            if (next !== p.latencyToleranceW) { changes.latencyToleranceW = next; reasons.push(`latencyToleranceW ${p.latencyToleranceW} → ${next} W (persistente Einspeisung)`); }
        }

        if (!Object.keys(changes).length) {
            return { params: {}, reason: 'Persistente Einspeisung, keine deterministischen Schritte', confident: false };
        }

        this._recordHistory(changes, reasons.join('; '));
        return { params: changes, reason: reasons.join('; '), confident: true };
    }

    // ------------------------------------------------------------------ //
    // Mustererkennung
    // ------------------------------------------------------------------ //

    /** Erkennt Schwingen: häufiger Vorzeichenwechsel des Zählerwerts. */
    _detectOscillation() {
        const w = this._window.slice(-20);
        if (w.length < 10) return false;
        let changes = 0;
        for (let i = 1; i < w.length; i++) {
            if (Math.sign(w[i].meter) !== Math.sign(w[i - 1].meter)) changes++;
        }
        return changes >= 6; // >60 % der Punkte wechseln Vorzeichen
    }

    /** Erkennt anhaltende Einspeisung (Zähler dauerhaft negativ). */
    _detectPersistentExport() {
        const w = this._window.slice(-20);
        if (w.length < 10) return false;
        const negative = w.filter((p) => p.meter < -20).length;
        return negative >= w.length * 0.8;
    }

    _allowed(key) { return this.allowedParams.has(key); }

    _recordHistory(params, reason) {
        this._history.push({ ts: Date.now(), params, reason, outcome: null });
        if (this._history.length > 50) this._history.shift();
    }
}

module.exports = { Optimizer };
