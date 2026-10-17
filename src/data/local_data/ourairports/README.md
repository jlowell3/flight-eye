# OurAirports

Airports, runways and radio frequencies from
[OurAirports](https://ourairports.com/data/), rebuilt from the daily export at
<https://davidmegginson.github.io/ourairports-data/> (`airports.csv`,
`runways.csv`, `airport-frequencies.csv`) by `scripts/build-airports.mjs`.

Kept: large and medium airports, and small airports with scheduled service;
their open runways (longest first, up to 12) and the frequencies a controller
reads (TWR, GND, APP, DEP, ATIS, AWOS, ASOS, CTAF, UNICOM, clearance
delivery; up to 8). Coordinates are rounded to five decimals.

Runtime output: `airports.json` (`{ source, built, count, airports[] }`), read
by the server for `/api/airports/nearby` (server/providers/aviation.js) and
through it by the `get_nearby_airports` tool and Flight Eye's ATC persona.
It is not part of the browser bundle.

License: OurAirports releases its data into the public domain
("no restrictions"); the attribution in `src/data/dataCredits.js` is a
courtesy, not a condition.

To refresh:

```sh
curl -sSLO https://davidmegginson.github.io/ourairports-data/airports.csv
curl -sSLO https://davidmegginson.github.io/ourairports-data/runways.csv
curl -sSLO https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
node scripts/build-airports.mjs airports.csv runways.csv airport-frequencies.csv
```
