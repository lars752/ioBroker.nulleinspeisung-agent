# ioBroker.nulleinspeisung-agent

Begleit-Adapter für [ioBroker.nulleinspeisung](https://github.com/lars752/ioBroker.nulleinspeisung). Er hat zwei Aufgaben:

1. **Parameter-Tuning:** Beobachtet Netzbezug, Einspeisung und Schwingungen und passt die Regelparameter der Nulleinspeisung zur Laufzeit an (Totband, Regeltakt, Latenz).
2. **SoC-Steuerung per Wetterprognose:** Legt den Mindest-SoC (Abschaltschwelle) der Nulleinspeisung anhand der PV-Prognose für die nächsten Tage fest.

Voraussetzung: Nulleinspeisung **ab v1.0.9** (Laufzeit-API mit `socCutoffPercent`).

## SoC-Steuerung per Wetterprognose

### Ziel

Ein höherer Mindest-SoC bringt keine zusätzliche Energie. Er verhindert aber, dass der Akku bei einer Dunkelflaute tagelang leer steht, wo Standby von BMS und Wechselrichtern ihn Richtung Tiefentladung zieht. Deshalb gilt:

- Wird der Akku laut Prognose **bald wieder geladen**, darf er bis zum Minimum (Standard 20 %) entladen werden.
- Ist **keine Wiederaufladung absehbar**, wird er auf einem **saisonalen Park-SoC** gehalten: Kosinuskurve zwischen Sommerwert (21.6., Standard 20 %) und Winterwert (21.12., Standard 70 %).
- Kommt die Erholung erst übermorgen oder in drei Tagen, wird nach Prognosesicherheit (70 % bzw. 50 %) ein Zwischenwert gewählt.

### Topologie und Modell

PV speist ins Hausnetz, Ladegeräte laden den Akku aus dem Überschuss, Akku-Wechselrichter entladen ihn. Der Agent erfasst dafür selbst eine **Energiestatistik**; ein Statistik-Adapter ist nicht nötig:

| Rolle   | Bedeutung                                    | Beispiel                                    |
|---------|----------------------------------------------|---------------------------------------------|
| `pv`    | PV-Erzeugung, mit kWp je Gruppe              | `ecoflow-gruppen.0.pv_oben.info.Total_Power` |
| `lader` | Ladeleistung in den Akku                     | `t2mg-gruppen.0.wohnung_links.info.Total_Power` |
| `akku`  | Entladeleistung der Akku-Wechselrichter      | `ecoflow-gruppen.0.akku_wohnung_links.info.Total_Power` |

Aus dem Tagesverlauf (60 Tage) lernt der Agent:

- **Kalibrierfaktor**: gemessener / prognostizierter PV-Ertrag. Er gleicht Verschattung, Wirkungsgrad und ungenaue kWp-Angaben aus.
- **Lademodell**: `Ladung ≈ a · (PV − b)` per linearer Regression über Tage, an denen der Akku nicht voll war. `b` ist die Tageslast, die vor dem Laden gedeckt wird.
- **Entladung je Tag**: Median der letzten 14 Tage.

Mit diesen Werten simuliert der Agent den SoC stündlich bis zum Ende des dritten Folgetags. Bis genügend Tage gelernt sind (Standard 7), gilt nur der Park-SoC.

### Prognose

[Open-Meteo](https://open-meteo.com/) liefert die Strahlung auf die geneigte Fläche (`global_tilted_irradiance`, Neigung und Azimut konfigurierbar, 0° = Süd) sowie Sonnenauf- und -untergang. Sie ist kostenlos und braucht keinen API-Key. Der Standort ergibt sich der Reihe nach aus festen Koordinaten, der PLZ (über OpenStreetMap umgerechnet) oder den ioBroker-Systemeinstellungen. Die Prognose wird stündlich erneuert.

### Entscheidungszeitpunkte

Ein höherer Mindest-SoC stoppt nur die Entladung, er lädt nichts nach. Die Entscheidung fällt deshalb, solange der Akku noch voll ist:

- **abends**: Sonnenuntergang −30 min bis +3 h
- **morgens**: Sonnenaufgang +1 h bis +4 h
- ohne aktuelle Prognose: 17:30–21:00 und 08:00–11:00

Je Zeitfenster gibt es höchstens eine Änderung. Abweichungen unter der Hysterese (Standard 5 %) werden ignoriert, die Rückkehr zum Minimum erfolgt immer. Startet die Nulleinspeisung neu, stellt der Agent seinen Wert wieder her. Wird die Steuerung ausgeschaltet, setzt er den in der Nulleinspeisung konfigurierten Wert zurück. Ohne Prognose bleibt der letzte Wert bestehen; ist die Prognose älter als 48 h, gilt der Park-SoC.

### Einrichtung

1. Im Tab **SoC-Prognose** auf **Gruppen scannen** klicken, Rollen prüfen und die kWp je PV-Gruppe eintragen.
2. PLZ, Neigung (z. B. 32°) und Azimut (0 = Süd) eintragen.
3. Zunächst **ohne** Haken bei „SoC-Steuerung aktiv" laufen lassen: Statistik und Empfehlung werden trotzdem berechnet und das Modell lernt.
4. Nach einigen Tagen die Empfehlungen unter `SoC.*` prüfen und die Steuerung aktivieren.

Hinweis: Ein Mindest-SoC von 70 % setzt die Wechselrichter auf 0 W, das BMS bleibt aber eingeschaltet. Für die Überwinterung ist das manuelle Ausschalten über das BMS sparsamer.

### Datenpunkte (`nulleinspeisung-agent.0.*`)

| Datenpunkt | Bedeutung |
|---|---|
| `SoC.Empfehlung_Prozent` | aktuell empfohlener Mindest-SoC |
| `SoC.Gesetzt_Prozent` | vom Agenten an die Nulleinspeisung übergebener Wert |
| `SoC.Park_Prozent` | saisonaler Park-SoC |
| `SoC.Grund`, `SoC.Modus` | Begründung, Modus (`forecast`, `learning`, `fallback`, `noforecast`) |
| `SoC.Plan` | Simulation je Tag (JSON: PV, Ladung, SoC-Spitze/-Minimum) |
| `Prognose.PV_kWh_Heute`, `…_Tag1…3` | kalibrierte PV-Prognose |
| `Prognose.SoC_Min_Prozent` | niedrigster SoC im Prognosezeitraum |
| `Modell.*` | Kalibrierfaktor, Ladefaktor, Grundlast, Entladung, Lerntage |
| `Statistik.Heute.*`, `Statistik.Gestern.*` | PV-Ertrag, Ladung, Entladung in kWh |
| `Statistik.Verlauf` | Tagesverlauf als JSON (60 Tage) |

## Parameter-Tuning

Der Agent liest im Beobachtungsintervall den Zähler- und Sollwert der Nulleinspeisung und prüft im Tuning-Intervall:

- **anhaltender Netzbezug**: Totband verkleinern, sonst Regeltakt beschleunigen
- **Schwingung**: Totband vergrößern
- **anhaltende Einspeisung**: Latenz-Toleranz verkleinern

Nur im Tab **Erlaubte Parameter** freigegebene Werte werden verändert. Im **Trockenlauf** wird nur protokolliert, das gilt auch für die SoC-Steuerung.

## Entwicklung

```
npm test
```

## Lizenz

MIT
