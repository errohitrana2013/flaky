// ISO 3166-1 alpha-2 → continent.
//
// Cloudflare reports a country and a region, never a continent, and nothing in
// D1 stores one. Deriving it here beats adding a column: a new column would be
// blank for every row already written, and `INSERT OR IGNORE` never revisits an
// existing row, so it would stay blank for returning visitors forever.
//
// public/dashboard.js carries a byte-identical copy of CONTINENT_GROUPS — the
// Worker and the browser share no module. tests/dashboard-geography.test.mjs
// fails if the two drift.
export const CONTINENT_GROUPS = {
  Africa: "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
  Asia: "AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
  Europe: "AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
  "North America": "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI",
  "South America": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
  Oceania: "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
  Antarctica: "AQ BV GS HM TF",
};

const BY_CODE = (() => {
  const map = {};
  for (const [name, codes] of Object.entries(CONTINENT_GROUPS)) {
    for (const code of codes.split(" ")) map[code] = name;
  }
  return map;
})();

// "Unknown", never a guess. A code the map does not carry is either XX — what
// Cloudflare sends when it will not say — or a territory added since this list
// was written, and filing it under the wrong continent is worse than admitting
// the gap.
export const continentOf = (code) =>
  (/^[A-Za-z]{2}$/.test(code || "") && BY_CODE[code.toUpperCase()]) || "Unknown";
