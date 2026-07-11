#!/usr/bin/env node
/**
 * AreaScope city-page builder.
 * Regenerates cities/<slug>.html + sitemap.xml from live open data.
 * No API keys. Run monthly by .github/workflows/refresh-data.yml.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://kennethmacfadyen-globemaker.github.io/areascope";

// Centre postcodes chosen for each city (forces that publish to data.police.uk)
const CITIES = [
  { slug: "london", name: "London", pc: "EC2R 8AH" },
  { slug: "birmingham", name: "Birmingham", pc: "B1 1BB" },
  { slug: "leeds", name: "Leeds", pc: "LS1 6DT" },
  { slug: "liverpool", name: "Liverpool", pc: "L1 8JQ" },
  { slug: "bristol", name: "Bristol", pc: "BS1 4DJ" },
  { slug: "sheffield", name: "Sheffield", pc: "S1 2HE" },
  { slug: "newcastle", name: "Newcastle upon Tyne", pc: "NE1 7RU" },
  { slug: "nottingham", name: "Nottingham", pc: "NG1 2DP" },
  { slug: "leicester", name: "Leicester", pc: "LE1 6AG" },
  { slug: "southampton", name: "Southampton", pc: "SO14 7DU" },
  { slug: "cardiff", name: "Cardiff", pc: "CF10 1EP" },
  { slug: "brighton", name: "Brighton", pc: "BN1 1UB" }
];

const LABELS = {
  "anti-social-behaviour": "Anti-social behaviour", "bicycle-theft": "Bicycle theft",
  burglary: "Burglary", "criminal-damage-arson": "Criminal damage & arson", drugs: "Drugs",
  "other-theft": "Other theft", "possession-of-weapons": "Weapons possession",
  "public-order": "Public order", robbery: "Robbery", shoplifting: "Shoplifting",
  "theft-from-the-person": "Theft from the person", "vehicle-crime": "Vehicle crime",
  "violent-crime": "Violence & sexual offences", "other-crime": "Other crime"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "AreaScope-builder/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function monthName(ym) {
  const n = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${n[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function cityHTML(city, place, month, total, byCat, allCities) {
  const rows = byCat.slice(0, 8).map((c) =>
    `<tr><td>${esc(c.label)}</td><td>${c.count}</td><td>${((c.count / total) * 100).toFixed(0)}%</td></tr>`).join("\n      ");
  const others = allCities.filter((c) => c.slug !== city.slug)
    .map((c) => `<a href="${c.slug}.html">${esc(c.name)}</a>`).join(" · ");
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Is ${esc(city.name)} safe? Crime &amp; area report — updated monthly | AreaScope</title>
<meta name="description" content="${esc(city.name)} city centre recorded ${total} street-level crimes in ${monthName(month)}. See the breakdown, then run a free AreaScope report on any ${esc(city.name)} postcode: crime, amenities, transport and flood alerts.">
<link rel="canonical" href="${BASE}/cities/${city.slug}.html">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="../">🌍 Area<span>Scope</span></a>
  <nav><a href="../#pricing">Pricing</a><a href="../#faq">FAQ</a><a href="../" class="nav-cta">Check a postcode</a></nav>
</header>
<main>
<section class="hero">
  <h1>How safe is ${esc(city.name)}?</h1>
  <p class="sub">Police recorded <strong>${total} street-level crimes</strong> within a mile of ${esc(city.name)} city centre in ${monthName(month)}. Here's what they were — and how to check the exact street you're considering.</p>
  <p><a class="btn-primary big" href="../?pc=${encodeURIComponent(city.pc)}">Get the free ${esc(city.name)} centre report →</a></p>
</section>
<section class="report" style="display:block">
  <div class="detail-section">
    <h3>🚓 ${esc(city.name)} city centre — reported crime, ${monthName(month)}</h3>
    <p class="muted">Within ~1 mile of ${esc(place.postcode)} (${esc(place.admin_district)}). Source: data.police.uk, Open Government Licence.</p>
    <table>
      <tr><th>Offence type</th><th>Reports</th><th>Share</th></tr>
      ${rows}
    </table>
    <p class="muted small">City centres always show more crime than residential streets — that's where the people are. The number that matters is the one for <em>your</em> postcode.</p>
  </div>
  <div class="detail-lock">
    <h3>Check the street, not the city</h3>
    <p class="muted">AreaScope builds a live report for any UK postcode — crime &amp; 6-month trend, walkable amenities, transport and flood alerts — free, in about ten seconds.</p>
    <a class="btn-primary" href="../">Check any ${esc(city.name)} postcode — free</a>
  </div>
</section>
<section class="faq">
  <h2>More city guides</h2>
  <p style="text-align:center">${others}</p>
</section>
</main>
<footer class="site-footer">
  <p><strong>AreaScope</strong> — instant UK area reports from official open data. <a href="../">Try it free</a>.</p>
  <p class="small muted">Contains public sector information licensed under the Open Government Licence v3.0. Updated automatically every month.</p>
</footer>
</body>
</html>
`;
}

async function main() {
  const { date } = await getJSON("https://data.police.uk/api/crime-last-updated");
  const month = date.slice(0, 7);
  await mkdir(join(ROOT, "cities"), { recursive: true });

  const built = [];
  for (const city of CITIES) {
    try {
      const place = (await getJSON(`https://api.postcodes.io/postcodes/${encodeURIComponent(city.pc)}`)).result;
      const crimes = await getJSON(`https://data.police.uk/api/crimes-street/all-crime?lat=${place.latitude}&lng=${place.longitude}&date=${month}`);
      const counts = {};
      for (const c of crimes) counts[c.category] = (counts[c.category] || 0) + 1;
      const byCat = Object.entries(counts).map(([k, v]) => ({ label: LABELS[k] || k, count: v }))
        .sort((a, b) => b.count - a.count);
      const html = cityHTML(city, place, month, crimes.length, byCat, CITIES);
      await writeFile(join(ROOT, "cities", `${city.slug}.html`), html);
      built.push(city);
      console.log(`✓ ${city.name}: ${crimes.length} crimes in ${month}`);
    } catch (e) {
      console.error(`✗ ${city.name}: ${e.message} (keeping previous page if any)`);
    }
    await sleep(600); // be polite to the APIs
  }

  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${BASE}/`, ...built.map((c) => `${BASE}/cities/${c.slug}.html`)];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`;
  await writeFile(join(ROOT, "sitemap.xml"), sitemap);
  console.log(`✓ sitemap.xml (${urls.length} urls)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
