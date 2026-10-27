'use strict';

/**
 * ioBroker Adapter: nulleinspeisung-agent
 *
 * Beobachtet den Nulleinspeisung-Adapter und passt dessen Parameter autonom an.
 * Deterministische Regellogik + optionaler LLM-Fallback (Claude API).
 *
 * Architektur:
 *   observe-Loop  (observeIntervalS)  → liest Zähler + Sollwert, buchts beim Optimizer ein
 *   tune-Loop     (tuneIntervalS)     → Optimizer.tune() → bei Bedarf sendTo setConfig
 *   SoC-Steuerung (lib/soccontroller.js) → Energiestatistik + Wetterprognose → Mindest-SoC
 *                 der Nulleinspeisung zu den Entscheidungszeitpunkten (Abend/Morgen)
 */

const utils   = require('@iobroker/adapter-core');
const { Optimizer } = require('./lib/optimizer');
const { SocController } = require('./lib/soccontroller');

const SENDTO_TIMEOUT_MS = 10_000;

class NullEinspeisungAgent extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'nulleinspeisung-agent' });

        this._optimizer    = null;
        this._observeTimer = null;
        this._tuneTimer    = null;
        this._currentParams = {};   // letzter bekannter Parametersatz der Ziel-Instanz
        this._tuneCount    = 0;
        this._soc          = null;  // SoC-Steuerung per Wetterprognose

        this.on('ready',       this._onReady.bind(this));
        this.on('stateChange', this._onStateChange.bind(this));
        this.on('unload',      this._onUnload.bind(this));
        this.on('message',     this._onMessage.bind(this));
    }

    // ------------------------------------------------------------------ //
    // Lifecycle
    // ------------------------------------------------------------------ //

    async _onReady() {
        this.log.info('Nulleinspeisung-Agent gestartet');

        const cfg = this.config;
        const target = cfg.targetInstance || 'nulleinspeisung.0';

        // Erlaubte Parameter — in io-package als Array gespeichert
        const allowedParams = Array.isArray(cfg.allowedParams) ? cfg.allowedParams : [
            'deadBandWatts', 'regulatorIntervalMs', 'maxLatencyTimeoutS', 'latencyToleranceW',
        ];

        // Optimizer initialisieren
        this._optimizer = new Optimizer({
            allowedParams,
            importThresholdWh: cfg.gridImportThresholdWh || 5,
            log: this.log,
        });

        // Aktuellen Parametersatz der Zielinstanz laden
        await this._loadCurrentParams(target);

        // States der Zielinstanz abonnieren
        const prefix = target.replace('nulleinspeisung.', 'nulleinspeisung.') + '.';
        await this.subscribeForeignStatesAsync(`${target}.Zaehler_W`);
        await this.subscribeForeignStatesAsync(`${target}.Soll_W`);
        await this.subscribeForeignStatesAsync(`${target}.Gesperrt`);
        await this.subscribeForeignStatesAsync(`${target}.Aktiv`);

        // Verbindungsstatus setzen
        await this.setStateAsync('info.connection', { val: true, ack: true });

        // Loops starten
        this._startObserveLoop(cfg.observeIntervalS || 60, target);
        this._startTuneLoop(cfg.tuneIntervalS || 300, target, cfg);

        // SoC-Steuerung per Wetterprognose
        try {
            this._soc = new SocController(this, target, cfg.dryRun);
            await this._soc.start();
        } catch (err) {
            this.log.error(`[SoC] Start fehlgeschlagen: ${err.message}`);
        }
    }

    /** Nachrichten der Admin-Oberfläche: Gruppen-Scan für die SoC-Steuerung. */
    _onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        if (obj.command === 'scanGroups') {
            const msg = obj.message || {};
            SocController.scanGroups(this, msg.energyGroups)
                .then((rows) => this.sendTo(obj.from, obj.command, { native: { energyGroups: rows } }, obj.callback))
                .catch((e) => this.sendTo(obj.from, obj.command, { error: `Fehler: ${e.message}` }, obj.callback));
        }
    }

    _onStateChange(id, state) {
        if (!state || state.ack === false) return;

        // Zähler-Updates direkt in den Optimizer einspeisen
        if (id.endsWith('.Zaehler_W') && typeof state.val === 'number') {
            // soll wird beim nächsten Observe-Tick geholt
            this._lastMeterW = state.val;
        }
    }

    async _onUnload(callback) {
        try {
            if (this._observeTimer) clearInterval(this._observeTimer);
            if (this._tuneTimer)    clearInterval(this._tuneTimer);
            if (this._soc)          await this._soc.stop();
            await this.setStateAsync('info.connection', { val: false, ack: true });
        } catch { /* ignore */ }
        callback();
    }

    // ------------------------------------------------------------------ //
    // Observe-Loop
    // ------------------------------------------------------------------ //

    _startObserveLoop(intervalS, target) {
        const tick = async () => {
            try {
                const [meterSt, sollSt] = await Promise.all([
                    this.getForeignStateAsync(`${target}.Zaehler_W`),
                    this.getForeignStateAsync(`${target}.Soll_W`),
                ]);

                const meter = (meterSt && typeof meterSt.val === 'number') ? meterSt.val : null;
                const soll  = (sollSt  && typeof sollSt.val  === 'number') ? sollSt.val  : null;

                if (meter !== null) {
                    this._optimizer.observe(meter, soll || 0);
                    this._lastMeterW = meter;
                }

                // Metriken in Datenpunkte schreiben
                await Promise.all([
                    this.setStateAsync('Metrik.NetzbezugWh',    { val: Math.round(this._optimizer.importWh * 100) / 100, ack: true }),
                    this.setStateAsync('Metrik.EinspeisungWh',  { val: Math.round(this._optimizer.exportWh * 100) / 100, ack: true }),
                    this.setStateAsync('Metrik.RegelabweichungWs', { val: Math.round(this._optimizer.errorWs), ack: true }),
                ]);
            } catch (err) {
                this.log.debug(`[Observe] Fehler: ${err.message}`);
            }
        };

        // Sofort + dann periodisch
        tick();
        this._observeTimer = setInterval(tick, intervalS * 1000);
    }

    // ------------------------------------------------------------------ //
    // Tune-Loop
    // ------------------------------------------------------------------ //

    _startTuneLoop(intervalS, target, cfg) {
        const tick = async () => {
            try {
                const result = this._optimizer.tune(this._currentParams);

                if (!result) {
                    // Alles gut oder zu wenig Daten
                    this._optimizer.reset();
                    return;
                }

                if (!result.confident) {
                    this.log.warn(`[Tune] Kein deterministischer Schritt moeglich: ${result.reason}`);
                    this._optimizer.markOutcome(false);
                    this._optimizer.reset();
                    return;
                }

                // Parameteranpassung anwenden
                await this._applyParams(target, result.params, result.reason, cfg.dryRun);
                this._optimizer.markOutcome(true);  // optimistisch — beim nächsten Tick sehen wir's
                this._optimizer.reset();

            } catch (err) {
                this.log.error(`[Tune] Fehler: ${err.message}`);
            }
        };

        this._tuneTimer = setInterval(tick, intervalS * 1000);
    }

    // ------------------------------------------------------------------ //
    // Hilfsmethoden
    // ------------------------------------------------------------------ //

    async _loadCurrentParams(target) {
        try {
            // Parameter über sendTo('nulleinspeisung.0', 'getConfig', ...) laden
            const response = await this._sendToAsync(target, 'getConfig', {});
            if (response && typeof response === 'object') {
                this._currentParams = response;
                this.log.debug(`[Init] Parameter geladen: ${JSON.stringify(response)}`);
            }
        } catch (err) {
            this.log.warn(`[Init] Konnte Parameter nicht laden: ${err.message}`);
        }
    }

    async _applyParams(target, params, reason, dryRun) {
        if (!params || !Object.keys(params).length) return;

        this.log.info(`[Tune] ${dryRun ? '[DryRun] ' : ''}Passe Parameter an: ${JSON.stringify(params)} — ${reason}`);

        if (!dryRun) {
            try {
                await this._sendToAsync(target, 'setConfig', params);
                // Lokalen Cache aktualisieren
                Object.assign(this._currentParams, params);
            } catch (err) {
                this.log.error(`[Tune] sendTo setConfig fehlgeschlagen: ${err.message}`);
                return;
            }
        }

        this._tuneCount++;
        const ts = new Date().toISOString();
        await Promise.all([
            this.setStateAsync('Tuning.LetzteAenderung',  { val: JSON.stringify({ ts, params }), ack: true }),
            this.setStateAsync('Tuning.LetzterGrund',     { val: reason, ack: true }),
            this.setStateAsync('Tuning.AnzahlAenderungen', { val: this._tuneCount, ack: true }),
        ]);
    }

    /** Promise-Wrapper für adapter.sendTo (mit Timeout, falls die Zielinstanz nicht läuft) */
    _sendToAsync(instance, command, data) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${instance} antwortet nicht auf ${command}`)), SENDTO_TIMEOUT_MS);
            this.sendTo(instance, command, data, (result) => {
                clearTimeout(timer);
                if (result && result.error) reject(new Error(result.error));
                else resolve(result);
            });
        });
    }
}

// ioBroker Adapter starten
if (require.main !== module) {
    module.exports = (options) => new NullEinspeisungAgent(options);
} else {
    new NullEinspeisungAgent();
}
