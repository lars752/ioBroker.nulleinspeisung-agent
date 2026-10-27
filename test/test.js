'use strict';
const assert = require('assert');
const { EnergyStats, dayKey } = require('../lib/energystats');
const { parseForecast } = require('../lib/forecast');
const { SocPlanner, seasonalPark, decisionSlot } = require('../lib/socplanner');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const H = 3_600_000;

/** Lokaler Zeitstempel. */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/**
 * Baut eine Open-Meteo-Antwort: dailyKwhM2[i] = Tagesstrahlung (kWh/m²) für Tag i ab startDay,
 * verteilt als Sinusbogen von 8 bis 17 Uhr.
 */
function fakeRaw(startDay, dailyKwhM2) {
    const time = [];
    const gti = [];
    const dtime = [];
    const rise = [];
    const set = [];
    dailyKwhM2.forEach((kwh, i) => {
        const day0 = startDay + i * 24 * H;
        dtime.push(day0 / 1000);
        rise.push((day0 + 8 * H) / 1000);
        set.push((day0 + 17 * H) / 1000);
        const w = [];
        for (let h = 0; h < 24; h++) w.push(h >= 8 && h < 17 ? Math.sin(((h - 8 + 0.5) / 9) * Math.PI) : 0);
        const sum = w.reduce((a, b) => a + b, 0);
        for (let h = 0; h < 24; h++) {
            time.push((day0 + (h + 1) * H) / 1000); // Wert gilt für die vorangegangene Stunde
            gti.push((w[h] / sum) * kwh * 1000);
        }
    });
    return { hourly: { time, global_tilted_irradiance: gti }, daily: { time: dtime, sunrise: rise, sunset: set } };
}

/** Verlauf mit n gelernten Tagen: Ladung = 0.8 · (PV − 2), Entladung 4 kWh. */
function fakeHistory(n, endDay) {
    const out = [];
    for (let i = n; i >= 1; i--) {
        const pv = 2 + (i % 6) * 1.5;
        out.push({
            date: dayKey(endDay - i * 24 * H), pv, charge: Math.max(0, 0.8 * (pv - 2)), discharge: 4,
            socMin: 20, socMax: 80, forecastPvRaw: pv / 0.9, coverage: 1,
        });
    }
    return out;
}

const KWP = 4;          // 4 kWp, PR 0.85 → 1 kWh/m² ≈ 3,4 kWh PV
const cfgBase = { kwpTotal: KWP, capacityKWh: 5.12, socMinPercent: 20, parkSummerPercent: 20, parkWinterPercent: 70, minLearningDays: 7 };

// ---------------------------------------------------------------- //

test('Energiestatistik integriert W zu kWh und schließt Tage ab', () => {
    const st = new EnergyStats();
    const t0 = at(2026, 10, 27, 22, 0);
    let closed = null;
    for (let t = t0; t <= t0 + 4 * H; t += 60_000) {
        const c = st.sample(t, { pv: 0, charge: 0, discharge: 600 }, 50);
        if (c) closed = c;
    }
    assert.ok(closed, 'Tageswechsel erkannt');
    assert.strictEqual(closed.date, '2026-10-27');
    assert.ok(Math.abs(closed.discharge - 1.2) < 0.02, `27.10.: 2 h · 600 W = 1,2 kWh (ist ${closed.discharge})`);
    assert.ok(Math.abs(st.today.discharge - 1.2) < 0.02);
});

test('Energiestatistik überbrückt keine langen Lücken und stellt Zustand wieder her', () => {
    const st = new EnergyStats();
    const t0 = at(2026, 10, 27, 10, 0);
    st.sample(t0, { pv: 1000 });
    st.sample(t0 + 60 * 60_000, { pv: 1000 }); // 1 h Lücke → verworfen
    assert.strictEqual(st.today.pv, 0);
    st.sample(t0 + 61 * 60_000, { pv: 1000 });
    assert.ok(st.today.pv > 0.016 && st.today.pv < 0.017);
    const json = JSON.stringify(st.toJSON());
    const st2 = new EnergyStats();
    assert.ok(st2.restore(json, t0 + 2 * H));
    assert.strictEqual(st2.today.pv, st.today.pv);
    const st3 = new EnergyStats();
    st3.restore(json, at(2026, 10, 29, 8));
    assert.strictEqual(st3.history.length, 1, 'alter Tag wandert in den Verlauf');
    assert.ok(!new EnergyStats().restore('{kaputt'));
});

test('Prognose: Stundenwerte werden dem Intervallbeginn zugeordnet', () => {
    const day = at(2026, 10, 28);
    const f = parseForecast(fakeRaw(day, [2, 0.5]));
    assert.strictEqual(f.days.length, 2);
    assert.ok(Math.abs(f.days[0].kwhM2 - 2) < 0.01 && Math.abs(f.days[1].kwhM2 - 0.5) < 0.01);
    assert.strictEqual(f.days[0].sunset, day + 17 * H);
    assert.throws(() => parseForecast({}));
});

test('Park-SoC folgt der Jahreszeit', () => {
    assert.strictEqual(Math.round(seasonalPark(at(2026, 12, 21), 20, 70)), 70);
    assert.strictEqual(Math.round(seasonalPark(at(2026, 6, 21), 20, 70)), 20);
    const okt = Math.round(seasonalPark(at(2026, 10, 27), 20, 70));
    assert.ok(okt >= 55 && okt <= 65, `Ende Oktober ${okt} %`);
});

test('Modell lernt Ladefaktor, Grundlast, Entladung und Kalibrierung', () => {
    const p = new SocPlanner(cfgBase);
    const m = p.learn(fakeHistory(20, at(2026, 10, 27)));
    assert.ok(Math.abs(m.a - 0.8) < 0.01 && Math.abs(m.b - 2) < 0.05, JSON.stringify(m));
    assert.strictEqual(m.dischargeKWh, 4);
    assert.ok(Math.abs(m.calibration - 0.9) < 0.01);
    assert.ok(m.chargeLearned);
    const d = new SocPlanner(cfgBase).learn([]);
    assert.ok(!d.chargeLearned && d.dischargeKWh === 3 && d.calibration === 1);
});

test('Sonnige Tage: Entladung bis zum Minimum erlaubt', () => {
    const now = at(2026, 10, 27, 17, 30);
    const p = new SocPlanner(cfgBase);
    p.learn(fakeHistory(20, now));
    const plan = p.plan({ now, soc: 60, forecast: parseForecast(fakeRaw(at(2026, 10, 27), [2, 3, 3, 3]), now) });
    assert.strictEqual(plan.cutoff, 20, plan.reason);
    assert.strictEqual(plan.days[0].date, '2026-10-27');
});

test('Dunkelflaute über 3 Tage: Park-SoC', () => {
    const now = at(2026, 10, 27, 17, 30);
    const p = new SocPlanner(cfgBase);
    p.learn(fakeHistory(20, now));
    const plan = p.plan({ now, soc: 80, forecast: parseForecast(fakeRaw(at(2026, 10, 27), [0.3, 0.2, 0.3, 0.4]), now) });
    assert.strictEqual(plan.cutoff, plan.park, plan.reason);
    assert.ok(plan.park > 50);
    assert.strictEqual(plan.refillDay, -1);
});

test('Erholung erst an Tag 3: Zwischenwert', () => {
    const now = at(2026, 10, 27, 17, 30);
    const p = new SocPlanner(cfgBase);
    p.learn(fakeHistory(20, now));
    const plan = p.plan({ now, soc: 50, forecast: parseForecast(fakeRaw(at(2026, 10, 27), [0.3, 0.2, 0.3, 4]), now) });
    assert.strictEqual(plan.refillDay, 3, plan.reason);
    assert.ok(plan.cutoff > 20 && plan.cutoff < plan.park, `Zwischenwert ${plan.cutoff}`);
});

test('Voller Akku zählt nicht als Wiederaufladung', () => {
    const now = at(2026, 10, 27, 17, 30);
    const p = new SocPlanner(cfgBase);
    p.learn(fakeHistory(20, now));
    const plan = p.plan({ now, soc: 100, forecast: parseForecast(fakeRaw(at(2026, 10, 27), [0.2, 0.2, 0.2, 0.2]), now) });
    assert.strictEqual(plan.cutoff, plan.park, plan.reason);
});

test('Lernphase und fehlende Prognose', () => {
    const now = at(2026, 10, 27, 17, 30);
    const p = new SocPlanner(cfgBase);
    p.learn(fakeHistory(3, now));
    const f = parseForecast(fakeRaw(at(2026, 10, 27), [3, 3, 3, 3]), now);
    assert.strictEqual(p.plan({ now, soc: 60, forecast: f }).mode, 'learning');
    assert.strictEqual(p.plan({ now, soc: 60, forecast: null }).cutoff, null);
    assert.strictEqual(new SocPlanner({ ...cfgBase, kwpTotal: 0 }).plan({ now, soc: 60, forecast: f }).mode, 'fallback');
});

test('Entscheidungszeitpunkte: Abend und Morgen', () => {
    const day = at(2026, 10, 27);
    const f = parseForecast(fakeRaw(day, [1, 1]));
    assert.strictEqual(decisionSlot(day + 17 * H, f), '2026-10-27-abend');
    assert.strictEqual(decisionSlot(day + 10 * H, f), '2026-10-27-morgen');
    assert.strictEqual(decisionSlot(day + 13 * H, f), null);
    assert.strictEqual(decisionSlot(at(2026, 11, 5, 18), f), '2026-11-05-abend', 'Ersatzzeit ohne Prognose für den Tag');
    assert.strictEqual(decisionSlot(at(2026, 11, 5, 9), null), '2026-11-05-morgen');
});

test('io-package.json und Admin-Maske sind gültiges JSON', () => {
    const io = require('../io-package.json');
    assert.strictEqual(require('../package.json').version, io.common.version);
    require('../admin/jsonConfig.json');
});

console.log(`\n${passed} Tests bestanden`);
