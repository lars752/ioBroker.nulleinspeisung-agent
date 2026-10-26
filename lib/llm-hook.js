'use strict';

/**
 * LLM-Hook: Ruft die Claude API auf, wenn der deterministische Optimizer
 * keine Lösung mehr findet.
 *
 * Eingabe: strukturierter Kontext vom Optimizer (buildLlmContext())
 * Ausgabe: { params: {}, reason: string } oder null bei Fehler
 *
 * Das LLM antwortet mit JSON:
 *   {
 *     "parameterAenderungen": { "deadBandWatts": 10, ... },
 *     "begruendung": "..."
 *   }
 */

const https = require('https');

const SYSTEM_PROMPT = `Du bist ein Experte fuer Photovoltaik-Heimspeichersysteme und Regelungstechnik.
Du hilfst dabei, die Parameter eines Nulleinspeisung-Adapters fuer ioBroker autonom zu optimieren.

Deine Aufgabe: Analysiere den gegebenen Kontext (Metriken, aktuelle Parameter, Tuning-Verlauf) und
schlage KONKRETE Parameteraenderungen vor, die das Problem beheben.

Regeln:
- Aendere NUR Parameter aus der erlaubteParameter-Liste
- Aendere nie mehr als 2 Parameter gleichzeitig
- Begruende deine Entscheidung kurz und praezise (1-2 Saetze auf Deutsch)
- Antworte NUR mit validem JSON (kein Markdown, keine Erlaeuterungen ausserhalb von JSON)

Antwortformat (genau so):
{
  "parameterAenderungen": { "<paramName>": <neuerWert> },
  "begruendung": "..."
}

Wenn du keine sinnvolle Aenderung siehst, antworte mit:
{
  "parameterAenderungen": {},
  "begruendung": "Keine weitere Optimierung moeglich mit erlaubten Parametern."
}`;

class LlmHook {
    /**
     * @param {object} opts
     * @param {string} opts.apiKey     – Anthropic API Key
     * @param {string} opts.model      – z.B. "claude-haiku-4-5"
     * @param {object} opts.log        – ioBroker log-Objekt
     * @param {number} [opts.timeoutMs=30000]
     */
    constructor({ apiKey, model, log, timeoutMs = 30_000 }) {
        this.apiKey = apiKey;
        this.model = model || 'claude-haiku-4-5';
        this.log = log;
        this.timeoutMs = timeoutMs;
        this._lastCallTs = 0;
        this._minIntervalMs = 60_000; // max 1 Aufruf pro Minute
    }

    /**
     * Sendet den Optimizer-Kontext an das LLM und gibt die vorgeschlagenen
     * Parameteranpassungen zurück.
     *
     * @param {object} context – Output von optimizer.buildLlmContext()
     * @returns {Promise<{params: object, reason: string}|null>}
     */
    async call(context) {
        if (!this.apiKey) {
            this.log.warn('[LLM-Hook] Kein API-Key konfiguriert — Aufruf übersprungen');
            return null;
        }

        const now = Date.now();
        if (now - this._lastCallTs < this._minIntervalMs) {
            this.log.debug('[LLM-Hook] Rate-Limit: letzter Aufruf vor weniger als 60 s — übersprungen');
            return null;
        }
        this._lastCallTs = now;

        const userMessage = JSON.stringify(context, null, 2);
        this.log.debug(`[LLM-Hook] Sende Kontext an ${this.model} (${userMessage.length} Zeichen)`);

        let rawResponse;
        try {
            rawResponse = await this._post(userMessage);
        } catch (err) {
            this.log.error(`[LLM-Hook] API-Fehler: ${err.message}`);
            return null;
        }

        // JSON aus der Antwort extrahieren
        let parsed;
        try {
            // Manchmal liefert das Modell JSON in Backtick-Blöcken
            const cleaned = rawResponse.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (err) {
            this.log.error(`[LLM-Hook] Antwort ist kein gültiges JSON: ${rawResponse.substring(0, 200)}`);
            return null;
        }

        const params = parsed.parameterAenderungen || {};
        const reason = parsed.begruendung || '(keine Begründung)';

        if (!Object.keys(params).length) {
            this.log.info(`[LLM-Hook] LLM: keine Änderung. Begründung: ${reason}`);
            return null;
        }

        this.log.info(`[LLM-Hook] Vorgeschlagene Änderungen: ${JSON.stringify(params)} — ${reason}`);
        return { params, reason };
    }

    // ------------------------------------------------------------------ //
    // HTTP-Anfrage
    // ------------------------------------------------------------------ //

    _post(userMessage) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: this.model,
                max_tokens: 512,
                system: SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userMessage }],
            });

            const options = {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                timeout: this.timeoutMs,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const text = json.content?.[0]?.text || '';
                        resolve(text);
                    } catch {
                        reject(new Error(`Ungültige API-Antwort: ${data.substring(0, 100)}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Timeout nach ${this.timeoutMs} ms`));
            });

            req.write(body);
            req.end();
        });
    }
}

module.exports = { LlmHook };
