# 🌍 AreaScope

**Instant UK area-intelligence reports.** Type a postcode, get a live report: crime levels & 6-month trend, walkable amenities, transport, flood alerts and deprivation stats — built entirely from official open data, in the browser.

**Live site:** https://kennethmacfadyen-globemaker.github.io/areascope/

## How it works

- **No server, no keys, no tracking.** The browser talks directly to four public APIs:
  - [postcodes.io](https://postcodes.io) — geocoding, area profile, deprivation rank (ONS)
  - [data.police.uk](https://data.police.uk) — street-level crime, 6 months
  - [Overpass / OpenStreetMap](https://overpass-api.de) — amenities & transport
  - [Environment Agency flood monitoring](https://environment.data.gov.uk/flood-monitoring/doc/reference) — live flood alerts
- **Business model:** free preview report; £5 one-time honour-system unlock (via [Buy Me a Coffee](https://www.buymeacoffee.com/globemaker)) for full reports + printable PDF.
- **Automation:** `scripts/build-cities.mjs` regenerates the 12 city guide pages and `sitemap.xml` from live data. A GitHub Action (`.github/workflows/refresh-data.yml`) runs it on the 3rd of every month — zero-maintenance fresh content.

## Data honesty

Police Scotland and Greater Manchester Police don't publish street-level crime to the open API. Reports in those areas say so explicitly and exclude the crime component from the score rather than showing a misleading number.

## Licences

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Amenity data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Reports are guidance, not professional advice.
