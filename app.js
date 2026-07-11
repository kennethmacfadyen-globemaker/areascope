/* AreaScope — client-side report engine. No server, no keys, no tracking. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var UNLOCK_KEY = "areascope_unlocked";

  /* ---------------- Fetch helpers ---------------- */

  function getJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + url.split("/")[2]);
      return r.json();
    });
  }

  /* ---------------- Data sources ---------------- */

  function lookupPostcode(pc) {
    return getJSON("https://api.postcodes.io/postcodes/" + encodeURIComponent(pc))
      .then(function (d) { return d.result; });
  }

  // Latest available month, then that month + previous 5.
  function fetchCrime(lat, lng) {
    return getJSON("https://data.police.uk/api/crime-last-updated")
      .then(function (d) {
        var latest = d.date.slice(0, 7); // YYYY-MM
        var months = [];
        var y = +latest.slice(0, 4), m = +latest.slice(5, 7);
        for (var i = 0; i < 6; i++) {
          months.unshift(y + "-" + String(m).padStart(2, "0"));
          m--; if (m === 0) { m = 12; y--; }
        }
        return Promise.all(months.map(function (month) {
          return getJSON("https://data.police.uk/api/crimes-street/all-crime?lat=" +
            lat + "&lng=" + lng + "&date=" + month)
            .then(function (crimes) { return { month: month, crimes: crimes }; })
            .catch(function () { return { month: month, crimes: null }; }); // month may 404/503
        }));
      })
      .catch(function () { return null; }); // whole source down → degrade gracefully
  }

  var OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  function fetchAmenities(lat, lng) {
    var q = "[out:json][timeout:25];(" +
      'nwr["shop"~"^(supermarket|convenience)$"](around:1000,' + lat + "," + lng + ");" +
      'nwr["amenity"~"^(pharmacy|doctors|clinic|dentist|school|kindergarten|cafe|pub|restaurant)$"](around:1000,' + lat + "," + lng + ");" +
      'nwr["leisure"~"^(park|playground|fitness_centre)$"](around:1000,' + lat + "," + lng + ");" +
      'nwr["railway"="station"](around:2000,' + lat + "," + lng + ");" +
      'node["highway"="bus_stop"](around:500,' + lat + "," + lng + ");" +
      ");out center 400;";
    function attempt(i) {
      if (i >= OVERPASS_ENDPOINTS.length) return Promise.resolve(null);
      return fetch(OVERPASS_ENDPOINTS[i], {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }).then(function (r) {
        if (!r.ok) throw new Error("overpass " + r.status);
        return r.json();
      }).catch(function () { return attempt(i + 1); });
    }
    return attempt(0);
  }

  function fetchFloods(lat, lng) {
    return getJSON("https://environment.data.gov.uk/flood-monitoring/id/floods?lat=" +
      lat + "&long=" + lng + "&dist=15")
      .then(function (d) { return d.items || []; })
      .catch(function () { return null; });
  }

  /* ---------------- Analysis ---------------- */

  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  function elementPos(el) {
    if (el.lat != null) return { lat: el.lat, lon: el.lon };
    if (el.center) return { lat: el.center.lat, lon: el.center.lon };
    return null;
  }

  var CATEGORY_LABELS = {
    "anti-social-behaviour": "Anti-social behaviour", "bicycle-theft": "Bicycle theft",
    "burglary": "Burglary", "criminal-damage-arson": "Criminal damage & arson",
    "drugs": "Drugs", "other-theft": "Other theft", "possession-of-weapons": "Weapons possession",
    "public-order": "Public order", "robbery": "Robbery", "shoplifting": "Shoplifting",
    "theft-from-the-person": "Theft from the person", "vehicle-crime": "Vehicle crime",
    "violent-crime": "Violence & sexual offences", "other-crime": "Other crime"
  };

  // Forces with known publishing gaps on data.police.uk — near-zero counts there
  // would read as "extremely safe", which is worse than saying "no data".
  function crimeGapMessage(place) {
    if (place.country === "Scotland")
      return "Police Scotland doesn't publish street-level crime to the open API, so the overall score is calculated without it.";
    if (place.pfa === "Greater Manchester")
      return "Greater Manchester Police doesn't currently publish street-level crime to the open API, so the overall score is calculated without it.";
    return null;
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function analyseCrime(crimeMonths) {
    if (!crimeMonths) return null;
    var valid = crimeMonths.filter(function (m) { return m.crimes !== null; });
    if (!valid.length) return null;
    var latest = valid[valid.length - 1];
    var counts = {};
    latest.crimes.forEach(function (c) { counts[c.category] = (counts[c.category] || 0) + 1; });
    var byCat = Object.keys(counts).map(function (k) {
      return { category: CATEGORY_LABELS[k] || k, count: counts[k] };
    }).sort(function (a, b) { return b.count - a.count; });
    var series = valid.map(function (m) { return { month: m.month, total: m.crimes.length }; });
    // Trend: average of last 3 months vs first 3 (single months are noisy)
    var trendPct = 0;
    if (series.length >= 4) {
      var half = Math.min(3, Math.floor(series.length / 2));
      var firstAvg = series.slice(0, half).reduce(function (a, p) { return a + p.total; }, 0) / half;
      var lastAvg = series.slice(-half).reduce(function (a, p) { return a + p.total; }, 0) / half;
      if (firstAvg > 0) trendPct = Math.round(((lastAvg - firstAvg) / firstAvg) * 100);
    }
    // Score from the median month (robust to partial months).
    // Log scale: quiet village ≈ 90s, quiet suburb ≈ 70s-80s, busy city centre ≈ teens.
    var rate = median(series.map(function (p) { return p.total; }));
    var score = Math.max(5, Math.min(98, Math.round(100 - 18 * Math.log(Math.max(rate, 1) / 15))));
    return { total: latest.crimes.length, month: latest.month, byCat: byCat, series: series, trendPct: trendPct, score: score };
  }

  var AMENITY_GROUPS = [
    { key: "supermarket", label: "Supermarkets & food shops", test: function (t) { return t.shop === "supermarket" || t.shop === "convenience"; }, weight: 22, emoji: "🛒" },
    { key: "health", label: "GPs, pharmacies & health", test: function (t) { return ["pharmacy", "doctors", "clinic", "dentist"].indexOf(t.amenity) > -1; }, weight: 20, emoji: "⚕️" },
    { key: "school", label: "Schools & nurseries", test: function (t) { return t.amenity === "school" || t.amenity === "kindergarten"; }, weight: 18, emoji: "🏫" },
    { key: "park", label: "Parks & playgrounds", test: function (t) { return t.leisure === "park" || t.leisure === "playground"; }, weight: 14, emoji: "🌳" },
    { key: "social", label: "Cafés, pubs & restaurants", test: function (t) { return ["cafe", "pub", "restaurant"].indexOf(t.amenity) > -1; }, weight: 18, emoji: "☕" },
    { key: "gym", label: "Gyms & fitness", test: function (t) { return t.leisure === "fitness_centre"; }, weight: 8, emoji: "🏋️" }
  ];

  function analyseAmenities(osm, lat, lng) {
    if (!osm || !osm.elements) return null;
    var items = osm.elements.map(function (el) {
      var pos = elementPos(el);
      if (!pos) return null;
      return { tags: el.tags || {}, dist: haversineM(lat, lng, pos.lat, pos.lon) };
    }).filter(Boolean);

    var groups = AMENITY_GROUPS.map(function (g) {
      var matches = items.filter(function (i) { return g.test(i.tags); })
        .sort(function (a, b) { return a.dist - b.dist; });
      return { key: g.key, label: g.label, emoji: g.emoji, weight: g.weight, matches: matches };
    });
    var score = 0;
    groups.forEach(function (g) {
      if (g.matches.length >= 2) score += g.weight;
      else if (g.matches.length === 1) score += Math.round(g.weight * 0.7);
    });
    var stations = items.filter(function (i) { return i.tags.railway === "station"; })
      .sort(function (a, b) { return a.dist - b.dist; });
    var busStops = items.filter(function (i) { return i.tags.highway === "bus_stop"; });
    var tScore = 20;
    if (stations.length) {
      var d = stations[0].dist;
      tScore = d <= 800 ? 90 : d <= 1200 ? 75 : 55;
    }
    tScore += Math.min(10, busStops.length * 2);
    return {
      groups: groups, score: Math.min(100, score),
      station: stations[0] || null, busStops: busStops.length,
      transportScore: Math.min(100, tScore)
    };
  }

  // IMD rank → percentile within the postcode's nation (higher = less deprived)
  var IMD_MAX = { England: 32844, Wales: 1909, Scotland: 6976 };
  function imdPercentile(place) {
    var max = IMD_MAX[place.country];
    if (!max || !place.index_of_multiple_deprivation) return null;
    return Math.round((place.index_of_multiple_deprivation / max) * 100);
  }

  function overallScore(parts) {
    var weights = { safety: 0.4, amenity: 0.3, transport: 0.15, imd: 0.15 };
    var sum = 0, wsum = 0;
    Object.keys(weights).forEach(function (k) {
      if (parts[k] != null) { sum += parts[k] * weights[k]; wsum += weights[k]; }
    });
    return wsum ? Math.round(sum / wsum) : null;
  }

  /* ---------------- Rendering ---------------- */

  function scoreClass(s) { return s >= 65 ? "good" : s >= 40 ? "ok" : "bad"; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtDist(m) { return m < 950 ? m + " m" : (m / 1000).toFixed(1) + " km"; }
  function fmtMonth(ym) {
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return names[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);
  }

  function dialSVG(score) {
    var pct = score / 100, r = 44, c = 2 * Math.PI * r;
    var col = score >= 65 ? "#0b6e4f" : score >= 40 ? "#b58a00" : "#b3372e";
    return '<svg viewBox="0 0 110 110" role="img" aria-label="AreaScope score ' + score + ' out of 100">' +
      '<circle cx="55" cy="55" r="' + r + '" fill="none" stroke="#edf1f5" stroke-width="10"/>' +
      '<circle cx="55" cy="55" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="10" stroke-linecap="round" ' +
      'stroke-dasharray="' + (c * pct).toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 55 55)"/>' +
      '<text x="55" y="52" text-anchor="middle" font-size="26" font-weight="800" fill="' + col + '">' + score + "</text>" +
      '<text x="55" y="72" text-anchor="middle" font-size="10" fill="#4a5a68">AreaScope</text></svg>';
  }

  function sparklineSVG(series) {
    var w = 300, h = 60, pad = 4;
    var max = Math.max.apply(null, series.map(function (s) { return s.total; })) || 1;
    var pts = series.map(function (s, i) {
      var x = pad + (i / (series.length - 1)) * (w - 2 * pad);
      var y = h - pad - (s.total / max) * (h - 2 * pad);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return '<svg class="sparkline" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="6-month crime trend">' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#0b6e4f" stroke-width="2.5" stroke-linejoin="round"/>' +
      pts.map(function (p) { return '<circle cx="' + p.split(",")[0] + '" cy="' + p.split(",")[1] + '" r="3" fill="#0b6e4f"/>'; }).join("") +
      "</svg>";
  }

  function catCard(title, score, headline) {
    var cls = score == null ? "ok" : scoreClass(score);
    var pct = score == null ? 0 : score;
    return '<div class="cat-card"><h3>' + title +
      (score != null ? '<span class="cat-score s-' + cls + '">' + score + "</span>" : "") + "</h3>" +
      '<div class="cat-bar"><i class="b-' + cls + '" style="width:' + pct + '%"></i></div>' +
      "<p>" + headline + "</p></div>";
  }

  function renderReport(place, crime, amen, floods) {
    var imd = imdPercentile(place);
    var scores = {
      safety: crime ? crime.score : null,
      amenity: amen ? amen.score : null,
      transport: amen ? amen.transportScore : null,
      imd: imd
    };
    var overall = overallScore(scores);

    $("report-title").textContent = place.postcode + " — " +
      (place.admin_ward ? place.admin_ward + ", " : "") + place.admin_district;
    $("report-subtitle").textContent = place.region || place.country;
    $("score-dial").innerHTML = overall != null ? dialSVG(overall) : "";

    // Flood banner
    var fb = $("flood-banner");
    if (floods === null) { fb.hidden = true; }
    else if (floods.length) {
      fb.className = "flood-banner";
      fb.innerHTML = "🌊 <strong>" + floods.length + " active Environment Agency flood " +
        (floods.length === 1 ? "alert" : "alerts") + "</strong> within 15 km right now.";
      fb.hidden = false;
    } else {
      fb.className = "flood-banner ok";
      fb.innerHTML = "🌊 No active Environment Agency flood alerts within 15 km right now.";
      fb.hidden = false;
    }

    // Category cards
    var cards = "";
    cards += catCard("🚓 Safety", scores.safety, crime
      ? crime.total + " reported crimes within ~1 mile in " + fmtMonth(crime.month) +
        (crime.trendPct !== 0 ? " — " + (crime.trendPct > 0 ? "up" : "down") + " " + Math.abs(crime.trendPct) + "% over 6 months" : " — flat over 6 months")
      : (crimeGapMessage(place) || "Crime data temporarily unavailable — try again shortly."));
    cards += catCard("🛒 Amenities", scores.amenity, amen
      ? amen.groups.reduce(function (n, g) { return n + g.matches.length; }, 0) + " amenities mapped within a 1 km walk"
      : "Amenity data temporarily unavailable.");
    cards += catCard("🚉 Transport", scores.transport, amen
      ? (amen.station
        ? "Nearest station " + fmtDist(amen.station.dist) + " away · " + amen.busStops + " bus stops within 500 m"
        : "No railway station within 2 km · " + amen.busStops + " bus stops within 500 m")
      : "Transport data temporarily unavailable.");
    cards += catCard("📊 Deprivation", imd, imd != null
      ? "Less deprived than " + imd + "% of " + place.country + " (official IMD)"
      : "Deprivation ranking not published for this area.");
    $("cat-grid").innerHTML = cards;

    // Full detail sections
    renderDetail(place, crime, amen, floods, imd);
    applyLockState();

    $("report-body").hidden = false;
    $("report-status").hidden = true;
    $("report").hidden = false;
    $("report").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderDetail(place, crime, amen, floods, imd) {
    var s;

    s = "<h3>🚓 Crime — the detail</h3>";
    if (crime) {
      s += "<p class='muted'>Reported crimes within ~1 mile, " + fmtMonth(crime.series[0].month) +
        " to " + fmtMonth(crime.month) + ":</p>" + sparklineSVG(crime.series) +
        "<p class='muted small'>" + crime.series.map(function (p) { return fmtMonth(p.month).split(" ")[0] + ": " + p.total; }).join(" · ") + "</p>" +
        "<table><tr><th>Offence type (" + fmtMonth(crime.month) + ")</th><th>Reports</th></tr>" +
        crime.byCat.map(function (c) { return "<tr><td>" + esc(c.category) + "</td><td>" + c.count + "</td></tr>"; }).join("") +
        "</table>";
    } else {
      s += "<p class='muted'>" + (crimeGapMessage(place) ||
        "The police open-data API didn't respond — try again in a minute.") + "</p>";
    }
    $("sec-crime").innerHTML = s;

    s = "<h3>🛒 Amenities within walking distance</h3>";
    if (amen) {
      s += "<table><tr><th>Type</th><th>Nearest (name · distance)</th><th>Count ≤1 km</th></tr>" +
        amen.groups.map(function (g) {
          var nearest = g.matches[0];
          return "<tr><td>" + g.emoji + " " + g.label + "</td><td>" +
            (nearest ? esc(nearest.tags.name || "(unnamed)") + " · " + fmtDist(nearest.dist) : "—") +
            "</td><td>" + g.matches.length + "</td></tr>";
        }).join("") + "</table>" +
        "<p class='muted small'>Source: OpenStreetMap, fetched live. Coverage depends on volunteer mapping — a missing entry usually means unmapped, not absent.</p>";
    } else {
      s += "<p class='muted'>The OpenStreetMap API didn't respond — try again in a minute.</p>";
    }
    $("sec-amenities").innerHTML = s;

    s = "<h3>🚉 Transport</h3>";
    if (amen) {
      s += "<table>";
      s += "<tr><td>🚆 Nearest railway station</td><td>" +
        (amen.station ? esc(amen.station.tags.name || "(unnamed)") + " · " + fmtDist(amen.station.dist) : "None within 2 km") + "</td></tr>";
      s += "<tr><td>🚌 Bus stops within 500 m</td><td>" + amen.busStops + "</td></tr>";
      s += "</table>";
    } else {
      s += "<p class='muted'>Transport data temporarily unavailable.</p>";
    }
    $("sec-transport").innerHTML = s;

    s = "<h3>🌊 Environment</h3>";
    if (floods === null) {
      s += "<p class='muted'>Flood alert service unavailable (Environment Agency covers England only).</p>";
    } else if (floods.length) {
      s += "<p><strong>" + floods.length + " active flood " + (floods.length === 1 ? "alert" : "alerts") + " within 15 km:</strong></p><table>" +
        floods.slice(0, 8).map(function (f) {
          return "<tr><td>" + esc(f.description || (f.floodArea && f.floodArea.riverOrSea) || "Flood area") +
            "</td><td>" + esc(f.severity || "") + "</td></tr>";
        }).join("") + "</table>";
    } else {
      s += "<p class='muted'>No active Environment Agency flood alerts within 15 km at the time of this report. (This reflects live warnings, not long-term flood risk — for that, check the GOV.UK long-term flood risk service.)</p>";
    }
    $("sec-environment").innerHTML = s;

    s = "<h3>📋 Area profile</h3><table>";
    var rows = [
      ["Postcode", place.postcode], ["Ward", place.admin_ward],
      ["District", place.admin_district], ["Region", place.region || place.country],
      ["Constituency", place.parliamentary_constituency],
      ["Deprivation", imd != null ? "Less deprived than " + imd + "% of " + place.country : null],
      ["Police force", place.pfa]
    ];
    rows.forEach(function (r) { if (r[1]) s += "<tr><td>" + r[0] + "</td><td>" + esc(r[1]) + "</td></tr>"; });
    s += "</table><p class='muted small'>Generated by AreaScope from live open data. Guidance only — not professional advice.</p>";
    $("sec-profile").innerHTML = s;
  }

  /* ---------------- Lock / unlock ---------------- */

  function isUnlocked() {
    try { return localStorage.getItem(UNLOCK_KEY) === "yes"; } catch (e) { return false; }
  }
  function applyLockState() {
    var unlocked = isUnlocked();
    $("detail-lock").hidden = unlocked;
    $("detail-full").hidden = !unlocked;
    var pb = $("pricing-unlock-btn");
    if (pb && unlocked) { pb.textContent = "✓ Unlocked on this device"; pb.disabled = true; }
  }
  function openModal() { $("unlock-modal").hidden = false; }
  function closeModal() { $("unlock-modal").hidden = true; }

  /* ---------------- Search flow ---------------- */

  function setStatus(html, isError) {
    var el = $("report-status");
    el.innerHTML = html;
    el.className = "report-status" + (isError ? " error" : "");
    el.hidden = false;
    $("report").hidden = false;
    $("report-body").hidden = true;
  }

  var searching = false;
  function runSearch(pc) {
    if (searching) return;
    searching = true;
    $("search-btn").disabled = true;
    $("autocomplete").hidden = true;
    setStatus('<span class="spinner"></span>Checking the postcode…');
    $("report").scrollIntoView({ behavior: "smooth", block: "start" });

    lookupPostcode(pc).then(function (place) {
      setStatus('<span class="spinner"></span>Pulling live data for <strong>' + esc(place.postcode) +
        "</strong> — police records, amenities, flood alerts…");
      return Promise.all([
        crimeGapMessage(place) ? Promise.resolve(null) : fetchCrime(place.latitude, place.longitude),
        fetchAmenities(place.latitude, place.longitude),
        fetchFloods(place.latitude, place.longitude)
      ]).then(function (res) {
        var crime = analyseCrime(res[0]);
        var amen = analyseAmenities(res[1], place.latitude, place.longitude);
        renderReport(place, crime, amen, res[2]);
        try { history.replaceState(null, "", "?pc=" + encodeURIComponent(place.postcode)); } catch (e) {}
      });
    }).catch(function (err) {
      setStatus("Hmm — that doesn't look like a valid UK postcode (" + esc(err.message) +
        "). Try the full postcode, e.g. <strong>M4 5BD</strong>.", true);
    }).finally(function () {
      searching = false;
      $("search-btn").disabled = false;
    });
  }

  /* ---------------- Autocomplete ---------------- */

  var acTimer = null;
  function onInput() {
    var v = $("postcode-input").value.trim();
    clearTimeout(acTimer);
    if (v.length < 2) { $("autocomplete").hidden = true; return; }
    acTimer = setTimeout(function () {
      getJSON("https://api.postcodes.io/postcodes/" + encodeURIComponent(v) + "/autocomplete")
        .then(function (d) {
          var list = d.result || [];
          var ul = $("autocomplete");
          if (!list.length) { ul.hidden = true; return; }
          ul.innerHTML = list.slice(0, 8).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("");
          ul.hidden = false;
        }).catch(function () {});
    }, 220);
  }

  /* ---------------- Wire up ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    $("search-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("postcode-input").value.trim();
      if (v) runSearch(v);
    });
    $("postcode-input").addEventListener("input", onInput);
    $("autocomplete").addEventListener("click", function (e) {
      if (e.target.tagName === "LI") {
        $("postcode-input").value = e.target.textContent;
        $("autocomplete").hidden = true;
        runSearch(e.target.textContent);
      }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search")) $("autocomplete").hidden = true;
    });

    $("unlock-btn").addEventListener("click", openModal);
    $("pricing-unlock-btn").addEventListener("click", openModal);
    $("modal-close").addEventListener("click", closeModal);
    $("unlock-modal").addEventListener("click", function (e) {
      if (e.target === $("unlock-modal")) closeModal();
    });
    $("confirm-unlock").addEventListener("click", function () {
      try { localStorage.setItem(UNLOCK_KEY, "yes"); } catch (e) {}
      closeModal();
      applyLockState();
    });

    $("print-btn") && $("print-btn").addEventListener("click", function () { window.print(); });
    $("new-search-btn") && $("new-search-btn").addEventListener("click", function () {
      $("postcode-input").focus();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    applyLockState();

    // Deep link: ?pc=SW1A1AA
    var params = new URLSearchParams(location.search);
    var pc = params.get("pc");
    if (pc) { $("postcode-input").value = pc; runSearch(pc); }
  });
})();
