import React, { useState, useMemo, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";

/* =========================================================================
   CORE MODEL — faithful port of the underlying capacity-expansion & cost
   model. Capacity build-out is driven only by demand + asset lifetimes, so
   it is precomputed once per geography. Costs are recomputed cheaply for
   any combination of technology-cost trajectory, repowering scenario, fuel
   price, and discount rate — which is what makes combined sensitivity
   analysis fast enough to be interactive (every slider drag / click
   recomputes and redraws in real time).
   ========================================================================= */

const startYear = 2026;
const endYear = 2100;
const years = [];
for (let y = startYear; y <= endYear; y++) years.push(y);
const yearsSinceStart = years.map((y) => y - startYear);
const hoursPerYear = 8760;

function interp1d(xs, ys, xq) {
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (xq >= xs[i] && xq <= xs[i + 1]) {
      const f = (xq - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + f * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}
function computeElectricityDemandPath(baseYear, baseDemand, gTo2050, gAfter2050) {
  return years.map((year) => {
    if (year <= 2050) return baseDemand * Math.pow(1 + gTo2050, year - baseYear);
    const d2050 = baseDemand * Math.pow(1 + gTo2050, 2050 - baseYear);
    return d2050 * Math.pow(1 + gAfter2050, year - 2050);
  });
}
function computeLinearCostTrajectory(baseYear, targetYear, baseCost, targetCost) {
  return years.map((year) => {
    const frac = Math.min(1, Math.max(0, (year - baseYear) / (targetYear - baseYear)));
    return baseCost + (targetCost - baseCost) * frac;
  });
}
function computeCapacityExpansionAndRepowering(requiredSeries, lifetime) {
  const builtByYear = {};
  const newBuild = [], repowered = [], totalCapexRelevant = [], operating = [];
  let operatingCapacity = 0;
  for (let i = 0; i < years.length; i++) {
    const year = years[i], required = requiredSeries[i];
    const expireYear = year - lifetime;
    const expired = builtByYear[expireYear] || 0;
    const repoweredGW = expired;
    const stillAvailable = operatingCapacity - expired;
    const afterRepowering = stillAvailable + repoweredGW;
    const newBuildGW = Math.max(required - afterRepowering, 0);
    const totalCapex = repoweredGW + newBuildGW;
    builtByYear[year] = totalCapex;
    operatingCapacity = afterRepowering + newBuildGW;
    newBuild.push(newBuildGW);
    repowered.push(repoweredGW);
    totalCapexRelevant.push(totalCapex);
    operating.push(operatingCapacity);
  }
  return { newBuild, repowered, totalCapexRelevant, operating };
}
function cumsum(arr) {
  let s = 0;
  return arr.map((v) => (s += v));
}

const hydroShare = 165.4 / 5410.7,
  onshoreWindShare = 823.9 / 5410.7,
  offshoreWindShare = 212.1 / 5410.7,
  solarPvShare = 4209.3 / 5410.7;
const utilityPvShareWithinSolar = 2550 / 4209.3,
  distributedPvShareWithinSolar = 1659.3 / 4209.3;
const renewableCapacityFactor =
  (165.4 / 5410.7) * 0.345 + (1036 / 5410.7) * 0.343 + (4209.3 / 5410.7) * 0.234;
const fossilCapacityFactor = 0.48;

/* Asset-lifetime sensitivity — matches the Python model's Figure 21
   assumptions. Renewable (solar/wind) lifetime is held at 30 years across
   all three scenarios; hydro and fossil lifetimes vary. */
const assetLifetimeScenarios = {
  "Original / Short": { renewable: 30, hydro: 30, fossil: 30 },
  Central: { renewable: 30, hydro: 50, fossil: 35 },
  "Long Life": { renewable: 30, hydro: 80, fossil: 40 },
};
function renewableLifetimeFor(techName, scenario) {
  const s = assetLifetimeScenarios[scenario];
  return techName === "hydro" ? s.hydro : s.renewable;
}
function fossilLifetimeFor(scenario) {
  return assetLifetimeScenarios[scenario].fossil;
}

const renewableTechnologyParameters = {
  solarPv: {
    capacityShare: solarPvShare,
    newBuildCost2026: 691,
    newBuildCost2050: { Advanced: 272, Moderate: 330, Conservative: 432 },
    assetLifetimeYears: 30,
    repoweringFactors: { "Low Cost": 0.8, Central: 0.8, "High Cost": 1.2, "No Discount": 1.0 },
  },
  onshoreWind: {
    capacityShare: onshoreWindShare,
    newBuildCost2026: 1041,
    newBuildCost2050: { Advanced: 684, Moderate: 755, Conservative: 919 },
    assetLifetimeYears: 30,
    repoweringFactors: { "Low Cost": 0.8, Central: 0.85, "High Cost": 1.0, "No Discount": 1.0 },
  },
  offshoreWind: {
    capacityShare: offshoreWindShare,
    newBuildCost2026: 2852,
    newBuildCost2050: { Advanced: 1280, Moderate: 1544, Conservative: 1875 },
    assetLifetimeYears: 30,
    repoweringFactors: { "Low Cost": 0.46, Central: 0.5, "High Cost": 1.0, "No Discount": 1.0 },
  },
  hydro: {
    capacityShare: hydroShare,
    newBuildCost2026: 2267,
    newBuildCost2050: { Advanced: 1959, Moderate: 2176, Conservative: 2267 },
    assetLifetimeYears: 50,
    repoweringFactors: { "Low Cost": 0.27, Central: 0.35, "High Cost": 0.59, "No Discount": 1.0 },
  },
};
const techCostBaseYear = 2026,
  techCostTargetYear = 2050;
function techCostPath(name, scenario) {
  const p = renewableTechnologyParameters[name];
  return computeLinearCostTrajectory(
    techCostBaseYear,
    techCostTargetYear,
    p.newBuildCost2026,
    p.newBuildCost2050[scenario]
  );
}
const fossilGenerationCapexPerGW = 868 * 1e6;
const renewableGenerationCapexPerGW2026 = Object.values(renewableTechnologyParameters).reduce(
  (s, p) => s + p.capacityShare * p.newBuildCost2026 * 1e6,
  0
);
const renewableGridCapexAlpha = 0.18,
  fossilGridCapexAlpha = 0.05;
const renewableGridCapexPerGW2026 = renewableGridCapexAlpha * renewableGenerationCapexPerGW2026;

const renewableStorageBeta = 0.2,
  batteryDurationHours = 4,
  batteryLifetimeYears = 15;
const batteryCost2026 = 110,
  batteryCost2050 = { Advanced: 75, Moderate: 95, Conservative: 110 };
function batteryCostPath(scenario) {
  return computeLinearCostTrajectory(techCostBaseYear, techCostTargetYear, batteryCost2026, batteryCost2050[scenario]);
}

const hydroFixedOm = 90.62,
  onshoreWindFixedOm = 28,
  offshoreWindFixedOm = 76;
const utilityPvFixedOm = 16,
  commercialPvFixedOm = 14,
  residentialPvFixedOm = 22;
const distributedPvFixedOm = 0.5 * commercialPvFixedOm + 0.5 * residentialPvFixedOm;
const solarPvFixedOm =
  utilityPvShareWithinSolar * utilityPvFixedOm + distributedPvShareWithinSolar * distributedPvFixedOm;
const renewableFixedOmUsdPerKWYear =
  hydroShare * hydroFixedOm +
  onshoreWindShare * onshoreWindFixedOm +
  offshoreWindShare * offshoreWindFixedOm +
  solarPvShare * solarPvFixedOm;
const fossilFixedOmUsdPerKWYear = 30;
const fossilVariableOmUsdPerMWh = 1.96;
const fossilStorageCapexShare = 0.01;
const fossilHeatRateMMBtuPerMWh = 6.7;

const eiaGasPrice = {
  2026: 3.885, 2027: 3.62, 2028: 3.673, 2029: 3.843, 2030: 4.476, 2031: 4.853, 2032: 5.271,
  2033: 5.235, 2034: 5.045, 2035: 5.049, 2036: 5.172, 2037: 5.276, 2038: 5.296, 2039: 5.31,
  2040: 5.358, 2041: 5.378, 2042: 5.286, 2043: 5.141, 2044: 5.051, 2045: 4.997, 2046: 5.009,
  2047: 4.898, 2048: 4.79, 2049: 4.697, 2050: 4.636,
};
const ngfsGcam = {
  2050: 1.085248, 2055: 1.096874, 2060: 1.096172, 2065: 1.107986, 2070: 1.120919, 2075: 1.125329,
  2080: 1.125693, 2085: 1.136707, 2090: 1.148806, 2095: 1.182506, 2100: 1.20153,
};
const ngfsRemind = {
  2050: 1.562384, 2055: 1.548829, 2060: 1.918215, 2070: 2.209393, 2080: 2.459295, 2090: 2.63032, 2100: 2.631154,
};
function computeNaturalGasPricePath() {
  const fiveYear = [];
  for (let y = 2050; y <= 2100; y += 5) fiveYear.push(y);
  const remindYears = Object.keys(ngfsRemind).map(Number).sort((a, b) => a - b);
  const remindVals = remindYears.map((y) => ngfsRemind[y]);
  const remindFive = fiveYear.map((y) => interp1d(remindYears, remindVals, y));
  const gcamFive = fiveYear.map((y) => ngfsGcam[y]);
  const centralFive = fiveYear.map((y, i) => (gcamFive[i] + remindFive[i]) / 2.0);
  const eia2050 = eiaGasPrice[2050],
    centralIndex2050 = centralFive[0];
  const fiveYearPrice = centralFive.map((v) => (eia2050 * v) / centralIndex2050);
  const post2050Years = [];
  for (let y = 2050; y <= 2100; y++) post2050Years.push(y);
  const post2050Price = post2050Years.map((y) => interp1d(fiveYear, fiveYearPrice, y));
  const dict = {};
  post2050Years.forEach((y, i) => (dict[y] = post2050Price[i]));
  return years.map((y) => (y <= 2050 ? eiaGasPrice[y] : dict[y]));
}
const naturalGasPricePath = computeNaturalGasPricePath();

function findFirstIntersectionYear(y1, y2) {
  const diff = y1.map((v, i) => v - y2[i]);
  for (let i = 0; i < years.length - 1; i++) {
    if (diff[i] === 0) return years[i];
    if (diff[i] * diff[i + 1] < 0) {
      const x1 = years[i], x2 = years[i + 1], d1 = diff[i], d2 = diff[i + 1];
      return x1 - (d1 * (x2 - x1)) / (d2 - d1);
    }
  }
  return null;
}
function computeLevelizedSystemCost(capex, om, fuel, genMWh, discountRate) {
  const df = yearsSinceStart.map((y) => 1 / Math.pow(1 + discountRate, y));
  const sum = (arr) => arr.reduce((s, v, i) => s + v * df[i], 0);
  const pvCapex = sum(capex), pvOm = sum(om), pvFuel = sum(fuel), pvGen = sum(genMWh);
  return { capex: pvCapex / pvGen, om: pvOm / pvGen, fuel: pvFuel / pvGen, total: (pvCapex + pvOm + pvFuel) / pvGen };
}

function precomputeGeography(params, lifetimeScenario) {
  const demand = computeElectricityDemandPath(2026, params.base2026, params.growthTo2050, params.growthAfter2050);
  const reqRenewable = demand.map((d) => (d * 1e6) / (renewableCapacityFactor * hoursPerYear) / 1000);
  const reqFossil = demand.map((d) => (d * 1e6) / (fossilCapacityFactor * hoursPerYear) / 1000);
  const techExpansion = {};
  const aggNewBuild = new Array(years.length).fill(0),
    aggRepowered = new Array(years.length).fill(0),
    aggTotalCapexRelevant = new Array(years.length).fill(0),
    aggOperating = new Array(years.length).fill(0);
  for (const [name, p] of Object.entries(renewableTechnologyParameters)) {
    const reqTech = reqRenewable.map((r) => r * p.capacityShare);
    const exp = computeCapacityExpansionAndRepowering(reqTech, renewableLifetimeFor(name, lifetimeScenario));
    techExpansion[name] = exp;
    for (let i = 0; i < years.length; i++) {
      aggNewBuild[i] += exp.newBuild[i];
      aggRepowered[i] += exp.repowered[i];
      aggTotalCapexRelevant[i] += exp.totalCapexRelevant[i];
      aggOperating[i] += exp.operating[i];
    }
  }
  const fossilExp = computeCapacityExpansionAndRepowering(reqFossil, fossilLifetimeFor(lifetimeScenario));
  const storagePowerGW = aggOperating.map((v) => renewableStorageBeta * v);
  const storageEnergyGWh = storagePowerGW.map((v) => v * batteryDurationHours);
  const storageExp = computeCapacityExpansionAndRepowering(storageEnergyGWh, batteryLifetimeYears);
  const renewableFixedOm = aggOperating.map((v) => v * 1e6 * renewableFixedOmUsdPerKWYear);
  const fossilFixedOm = fossilExp.operating.map((v) => v * 1e6 * fossilFixedOmUsdPerKWYear);
  const fossilVariableOm = demand.map((d) => d * 1e6 * fossilVariableOmUsdPerMWh);
  const fossilTotalOm = fossilFixedOm.map((v, i) => v + fossilVariableOm[i]);
  const fossilGenerationCapex = fossilExp.totalCapexRelevant.map((v) => v * fossilGenerationCapexPerGW);
  const fossilGridCapex = fossilGenerationCapex.map((v) => v * fossilGridCapexAlpha);
  const fossilStorageCapex = fossilGenerationCapex.map((v) => v * fossilStorageCapexShare);
  const fossilTotalCapex = fossilGenerationCapex.map((v, i) => v + fossilGridCapex[i] + fossilStorageCapex[i]);
  const renewableGridCapex = aggTotalCapexRelevant.map((v) => v * renewableGridCapexPerGW2026);
  return {
    demand,
    techExpansion,
    storageExp,
    renewableTotalOm: renewableFixedOm,
    fossilTotalOm,
    fossilTotalCapex,
    renewableGridCapex,
  };
}
const globalParams = (() => {
  const gTo = 0.0355, gAfter = 0.018, base2025 = 28200;
  return { base2026: base2025 * (1 + gTo), growthTo2050: gTo, growthAfter2050: gAfter };
})();
const aseanParams = (() => {
  const gTo = 0.032, gAfter = 0.018, base2023 = 1258;
  return { base2026: base2023 * Math.pow(1 + gTo, 3), growthTo2050: gTo, growthAfter2050: gAfter };
})();
const geographiesByLifetime = {};
for (const scenario of Object.keys(assetLifetimeScenarios)) {
  geographiesByLifetime[scenario] = {
    Global: precomputeGeography(globalParams, scenario),
    ASEAN: precomputeGeography(aseanParams, scenario),
  };
}

function computeScenario(geographyName, techCost, repowering, fuelMult, discountRate, assetLifetime) {
  const lifetimeScenario = assetLifetime || "Central";
  const g = geographiesByLifetime[lifetimeScenario][geographyName];
  const techGenCapex = new Array(years.length).fill(0);
  for (const [name, p] of Object.entries(renewableTechnologyParameters)) {
    const costPath = techCostPath(name, techCost).map((v) => v * 1e6);
    const repFactor = p.repoweringFactors[repowering];
    const exp = g.techExpansion[name];
    for (let i = 0; i < years.length; i++) {
      techGenCapex[i] += exp.newBuild[i] * costPath[i] + exp.repowered[i] * costPath[i] * repFactor;
    }
  }
  const battPath = batteryCostPath(techCost);
  const storageCapex = g.storageExp.totalCapexRelevant.map((v, i) => v * 1e6 * battPath[i]);
  const renewableTotalCapex = techGenCapex.map((v, i) => v + storageCapex[i] + g.renewableGridCapex[i]);
  const renewableAnnual = renewableTotalCapex.map((v, i) => v + g.renewableTotalOm[i]);
  const renewableCumulative = cumsum(renewableAnnual);
  const fossilFuelCost = g.demand.map((d, i) => d * 1e6 * fossilHeatRateMMBtuPerMWh * naturalGasPricePath[i] * fuelMult);
  const fossilAnnual = g.fossilTotalCapex.map((v, i) => v + g.fossilTotalOm[i] + fossilFuelCost[i]);
  const fossilCumulative = cumsum(fossilAnnual);
  const intersectionYear = findFirstIntersectionYear(renewableCumulative, fossilCumulative);
  const dr = discountRate !== undefined ? discountRate : 0.07;
  const levRen = computeLevelizedSystemCost(
    renewableTotalCapex, g.renewableTotalOm, new Array(years.length).fill(0), g.demand.map((d) => d * 1e6), dr
  );
  const levFos = computeLevelizedSystemCost(g.fossilTotalCapex, g.fossilTotalOm, fossilFuelCost, g.demand.map((d) => d * 1e6), dr);
  return {
    years, renewableAnnual, renewableCumulative, fossilAnnual, fossilCumulative, intersectionYear,
    levelizedRenewable: levRen.total, levelizedFossil: levFos.total,
    renCum2100: renewableCumulative[renewableCumulative.length - 1] / 1e12,
    fosCum2100: fossilCumulative[fossilCumulative.length - 1] / 1e12,
  };
}

/* =========================================================================
   UI CONSTANTS
   ========================================================================= */
const COLORS = {
  bg: "#0B1420", panel: "#101D2E", panel2: "#0D1826", line: "#1E3148", lineSoft: "#152437",
  ink: "#E7EEF5", inkDim: "#8FA3B8", inkFaint: "#5C7086",
  teal: "#2FD3B8", tealDim: "#1A8C79", amber: "#F2A93B", red: "#F0654A",
};
const pinColors = ["#2FD3B8", "#F2A93B", "#9B8CF2", "#F0654A", "#5EC8F2", "#D8E24B"];
const fuelPresets = [0.5, 0.75, 1.0, 1.25, 1.5];
const axisLevels = {
  techCost: ["Advanced", "Moderate", "Conservative"],
  repowering: ["Low Cost", "Central", "High Cost", "No Discount"],
  fuelPrice: fuelPresets,
  assetLifetime: Object.keys(assetLifetimeScenarios),
};
const axisLabelFmt = {
  techCost: (v) => v,
  repowering: (v) => v,
  fuelPrice: (v) => v.toFixed(2) + "\u00d7",
  assetLifetime: (v) => v,
};
const axisTitles = {
  techCost: "Tech-cost trajectory",
  repowering: "Repowering scenario",
  fuelPrice: "Fuel price",
  assetLifetime: "Asset lifetime",
};

function colorForValue(v, min, max, invert) {
  if (v === null || v === undefined || isNaN(v)) return "#333";
  let t = max === min ? 0.5 : (v - min) / (max - min);
  if (invert) t = 1 - t;
  const hue = 170 - t * 130;
  const light = 62 - t * 8;
  return `hsl(${hue.toFixed(0)}, 62%, ${light.toFixed(0)}%)`;
}
const fmtT = (v) => v.toFixed(1) + "T";
const fmtUsd = (v) => "$" + v.toFixed(1);
const fmtYear = (v) => (v === null || v === undefined || isNaN(v) ? "never by 2100" : v.toFixed(1));

/* =========================================================================
   SMALL UI PRIMITIVES
   ========================================================================= */
function SegGroup({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            style={{
              flex: "1 1 auto",
              background: active ? "rgba(47,211,184,0.14)" : "#0A1420",
              border: `1px solid ${active ? COLORS.teal : COLORS.line}`,
              color: active ? COLORS.teal : COLORS.inkDim,
              fontWeight: active ? 600 : 400,
              padding: "7px 10px",
              borderRadius: 7,
              fontSize: 12.5,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all .15s ease",
              whiteSpace: "nowrap",
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "block", fontSize: 11.5, color: COLORS.inkFaint, marginBottom: 7,
          textTransform: "uppercase", letterSpacing: ".06em",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
function Card({ children, style }) {
  return (
    <div
      style={{
        background: `linear-gradient(180deg, ${COLORS.panel}, ${COLORS.panel2})`,
        border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "18px 18px 20px", ...style,
      }}
    >
      {children}
    </div>
  );
}
function CardHeading({ n, children }) {
  return (
    <h2 style={{ fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".09em", color: COLORS.inkDim, margin: "0 0 14px", fontWeight: 600 }}>
      <span style={{ color: COLORS.teal, fontFamily: "'JetBrains Mono', monospace", marginRight: 7 }}>{n}</span>
      {children}
    </h2>
  );
}
function chartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "#0A1420", border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
      <div style={{ color: COLORS.inkFaint, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(1) + "T" : p.value}
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   MAIN APP
   ========================================================================= */
export default function App() {
  const [geography, setGeography] = useState("Global");
  const [techCost, setTechCost] = useState("Moderate");
  const [repowering, setRepowering] = useState("Central");
  const [fuelMult, setFuelMult] = useState(1.0);
  const [discountRate, setDiscountRate] = useState(0.07);
  const [assetLifetime, setAssetLifetime] = useState("Central");
  const [chartMode, setChartMode] = useState("cumulative");
  const [pinned, setPinned] = useState([]);
  const [pinCounter, setPinCounter] = useState(0);
  const [matrixRow, setMatrixRow] = useState("repowering");
  const [matrixCol, setMatrixCol] = useState("techCost");
  const [matrixMetric, setMatrixMetric] = useState("renCum");

  const result = useMemo(
    () => computeScenario(geography, techCost, repowering, fuelMult, discountRate, assetLifetime),
    [geography, techCost, repowering, fuelMult, discountRate, assetLifetime]
  );

  const chartData = useMemo(() => {
    const ren = chartMode === "cumulative" ? result.renewableCumulative : result.renewableAnnual;
    const fos = chartMode === "cumulative" ? result.fossilCumulative : result.fossilAnnual;
    return years.map((y, i) => ({ year: y, Renewable: ren[i] / 1e12, "Fossil system cost": fos[i] / 1e12 }));
  }, [result, chartMode]);

  const pinLabel = (g, t, r, life, f, dr) =>
    `${g} \u00b7 ${t} \u00b7 ${r} \u00b7 Life ${life} \u00b7 Fuel ${f.toFixed(2)}\u00d7 \u00b7 DR ${Math.round(dr * 100)}%`;

  const handlePin = useCallback(() => {
    setPinned((prev) => {
      const label = pinLabel(geography, techCost, repowering, assetLifetime, fuelMult, discountRate);
      const entry = { id: pinCounter, label, result };
      const next = [...prev, entry];
      return next.length > 6 ? next.slice(next.length - 6) : next;
    });
    setPinCounter((c) => c + 1);
  }, [geography, techCost, repowering, assetLifetime, fuelMult, discountRate, result, pinCounter]);

  const removePin = (id) => setPinned((prev) => prev.filter((p) => p.id !== id));

  const compareData = useMemo(() => {
    if (pinned.length === 0) return [];
    return years.map((y, i) => {
      const row = { year: y };
      pinned.forEach((p) => {
        row[`pin_${p.id}_ren`] = p.result.renewableCumulative[i] / 1e12;
        row[`pin_${p.id}_fos`] = p.result.fossilCumulative[i] / 1e12;
      });
      return row;
    });
  }, [pinned]);

  const matrix = useMemo(() => {
    if (matrixRow === matrixCol) return null;
    const rows = axisLevels[matrixRow];
    const cols = axisLevels[matrixCol];
    const valueFor = (rowVal, colVal) => {
      const params = { techCost, repowering, fuelPrice: fuelMult, assetLifetime };
      params[matrixRow] = rowVal;
      params[matrixCol] = colVal;
      const r = computeScenario(
        geography, params.techCost, params.repowering, params.fuelPrice, discountRate, params.assetLifetime
      );
      switch (matrixMetric) {
        case "crossover": return r.intersectionYear;
        case "renCum": return r.renCum2100;
        case "fosCum": return r.fosCum2100;
        case "advantage": return r.fosCum2100 - r.renCum2100;
        case "levelizedRen": return r.levelizedRenewable;
        case "levelizedFos": return r.levelizedFossil;
        case "levelizedDiff": return r.levelizedFossil - r.levelizedRenewable;
        default: return null;
      }
    };
    const values = rows.map((rw) => cols.map((cl) => valueFor(rw, cl)));
    const flat = values.flat().filter((v) => v !== null && !isNaN(v));
    const min = Math.min(...flat), max = Math.max(...flat);
    const invert = matrixMetric === "advantage" || matrixMetric === "levelizedDiff";
    const fixedVars = Object.keys(axisLevels).filter((k) => k !== matrixRow && k !== matrixCol);
    const isLevelizedMetric =
      matrixMetric === "levelizedRen" || matrixMetric === "levelizedFos" || matrixMetric === "levelizedDiff";
    const fixedLabelParts = fixedVars.map((k) => {
      if (k === "techCost") return "tech-cost = " + techCost;
      if (k === "repowering") return "repowering = " + repowering;
      if (k === "fuelPrice") return "fuel price = " + fuelMult.toFixed(2) + "\u00d7";
      if (k === "assetLifetime") return "asset lifetime = " + assetLifetime;
      return "";
    });
    if (isLevelizedMetric) {
      fixedLabelParts.push("discount rate = " + Math.round(discountRate * 100) + "%");
    }
    const fixedLabel = fixedLabelParts.join(", ");
    return { rows, cols, values, min, max, invert, fixedLabel, isLevelizedMetric };
  }, [matrixRow, matrixCol, matrixMetric, techCost, repowering, fuelMult, discountRate, assetLifetime, geography]);

  const adv = result.fosCum2100 - result.renCum2100;

  const techLabels = { solarPv: "Solar PV", onshoreWind: "Onshore wind", offshoreWind: "Offshore wind", hydro: "Hydro" };
  const assumptionRows = useMemo(() => {
    const rows = Object.entries(renewableTechnologyParameters).map(([name, p]) => ({
      name: techLabels[name],
      lifetime: renewableLifetimeFor(name, assetLifetime),
      repoweringFactor: p.repoweringFactors[repowering],
      cost2026: p.newBuildCost2026,
      cost2050: p.newBuildCost2050[techCost],
    }));
    rows.push({
      name: "Battery storage",
      lifetime: batteryLifetimeYears,
      repoweringFactor: null,
      cost2026: batteryCost2026,
      cost2050: batteryCost2050[techCost],
    });
    rows.push({
      name: "Fossil (gas)",
      lifetime: fossilLifetimeFor(assetLifetime),
      repoweringFactor: null,
      cost2026: null,
      cost2050: null,
    });
    return rows;
  }, [assetLifetime, repowering, techCost]);

  return (
    <div
      style={{
        background: `radial-gradient(1100px 500px at 85% -10%, #0F2A31 0%, transparent 60%), radial-gradient(900px 500px at -10% 10%, #251A0F 0%, transparent 55%), ${COLORS.bg}`,
        color: COLORS.ink,
        fontFamily: "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        minHeight: "100vh",
        padding: "28px 22px 60px",
      }}
    >
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* HEADER */}
        <header
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24,
            marginBottom: 26, flexWrap: "wrap", borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 18,
          }}
        >
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: COLORS.teal, marginBottom: 8 }}>
              Global &amp; ASEAN Power System Cost Model &middot; 2026&ndash;2100
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 600, margin: "0 0 6px", letterSpacing: "-0.01em" }}>Combined Sensitivity Dashboard</h1>
            <p style={{ margin: 0, color: COLORS.inkDim, fontSize: 13.5, maxWidth: 640, lineHeight: 1.5 }}>
              Move several drivers together &mdash; technology-cost trajectory, repowering discount, fossil fuel price, geography, asset lifetime &mdash; and see how the renewable-vs-fossil cost race changes as a system, not one variable at a time. Most controls update the chart, the crossover year, and cumulative costs live as you move them; the discount rate is the exception &mdash; it affects only the levelized-cost figures, not the chart or crossover year.
            </p>
          </div>
          <div style={{ display: "flex", gap: 18, fontSize: 12.5, color: COLORS.inkDim, fontFamily: "'JetBrains Mono', monospace" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 14, height: 3, borderRadius: 2, display: "inline-block", background: COLORS.teal }} />
              Renewable system cost
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 14, height: 0, borderTop: `2px dashed ${COLORS.amber}`, display: "inline-block" }} />
              Fossil system cost
            </span>
          </div>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" }}>
          {/* CONTROLS */}
          <div>
            <Card>
              <CardHeading n="01">Scenario controls</CardHeading>
              <Field label="Geography">
                <SegGroup options={["Global", "ASEAN"]} value={geography} onChange={setGeography} />
              </Field>
              <Field label="Technology-cost trajectory (2026 \u2192 2050)">
                <SegGroup options={["Advanced", "Moderate", "Conservative"]} value={techCost} onChange={setTechCost} />
                <div style={{ fontSize: 11, color: COLORS.inkFaint, marginTop: 7, lineHeight: 1.45 }}>
                  Sets both the renewable-generation cost curve (solar, onshore/offshore wind, hydro) and the battery-storage cost curve together.
                </div>
              </Field>
              <Field label="Repowering discount scenario">
                <SegGroup options={["Low Cost", "Central", "High Cost", "No Discount"]} value={repowering} onChange={setRepowering} />
              </Field>
              <Field label="Fossil fuel price multiplier">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="range" min={0.5} max={1.5} step={0.01} value={fuelMult}
                    onChange={(e) => setFuelMult(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: COLORS.amber, height: 4 }}
                  />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: COLORS.amber, minWidth: 48, textAlign: "right" }}>
                    {fuelMult.toFixed(2)}&times;
                  </span>
                </div>
              </Field>
              <Field label="LCOE real discount rate (levelized-cost figures only)">
                <SegGroup
                  options={["3%", "7%", "10%"]}
                  value={discountRate === 0.03 ? "3%" : discountRate === 0.1 ? "10%" : "7%"}
                  onChange={(v) => setDiscountRate(v === "3%" ? 0.03 : v === "10%" ? 0.1 : 0.07)}
                />
                <div style={{ fontSize: 11, color: COLORS.inkFaint, marginTop: 7, lineHeight: 1.45 }}>
                  Affects only the levelized system cost card and levelized-metric matrix views. Annual costs, cumulative costs, and the crossover year are undiscounted and do not change with this control.
                </div>
              </Field>
              <Field label="Asset lifetime scenario">
                <SegGroup options={Object.keys(assetLifetimeScenarios)} value={assetLifetime} onChange={setAssetLifetime} />
              </Field>
            </Card>

            <Card style={{ marginTop: 18 }}>
              <CardHeading n="02">Scenario comparison</CardHeading>
              <button
                onClick={handlePin}
                style={{ background: COLORS.teal, color: "#03211C", border: "none", padding: "8px 14px", borderRadius: 7, fontFamily: "inherit", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}
              >
                + Pin current scenario
              </button>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {pinned.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#0A1420", border: `1px solid ${COLORS.line}`, borderRadius: 20, padding: "6px 8px 6px 12px", fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace", color: COLORS.inkDim }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: pinColors[i % pinColors.length] }} />
                    {p.label}
                    <button onClick={() => removePin(p.id)} style={{ background: "none", border: "none", color: COLORS.inkFaint, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}>&times;</button>
                  </div>
                ))}
              </div>
              {pinned.length === 0 && (
                <div style={{ color: COLORS.inkFaint, fontSize: 12.5, fontStyle: "italic", marginTop: 14 }}>
                  Pin up to 6 combinations to compare them side by side, below.
                </div>
              )}
            </Card>
          </div>

          {/* RESULTS */}
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 18 }}>
              <Card style={{ padding: "15px 16px" }}>
                <div style={{ fontSize: 11, color: COLORS.inkFaint, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Cost crossover year</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 600, color: COLORS.teal }}>
                  {fmtYear(result.intersectionYear)}
                </div>
                <div style={{ fontSize: 11.5, color: COLORS.inkFaint, marginTop: 5 }}>Cumulative renewable &le; cumulative fossil</div>
              </Card>
              <Card style={{ padding: "15px 16px" }}>
                <div style={{ fontSize: 11, color: COLORS.inkFaint, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Cumulative cost to 2100</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 600 }}>
                  <span style={{ color: COLORS.teal }}>{fmtT(result.renCum2100)}</span>{" "}
                  <span style={{ color: COLORS.inkFaint, fontSize: 15 }}>/</span>{" "}
                  <span style={{ color: COLORS.amber }}>{fmtT(result.fosCum2100)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: COLORS.inkFaint, marginTop: 5 }}>renewable vs fossil, trillion USD</div>
              </Card>
              <Card style={{ padding: "15px 16px" }}>
                <div style={{ fontSize: 11, color: COLORS.inkFaint, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Levelized system cost</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 600 }}>
                  <span style={{ color: COLORS.teal }}>{fmtUsd(result.levelizedRenewable)}</span>{" "}
                  <span style={{ color: COLORS.inkFaint, fontSize: 15 }}>/</span>{" "}
                  <span style={{ color: COLORS.amber }}>{fmtUsd(result.levelizedFossil)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: COLORS.inkFaint, marginTop: 5 }}>USD/MWh at selected discount rate</div>
              </Card>
              <Card style={{ padding: "15px 16px" }}>
                <div style={{ fontSize: 11, color: COLORS.inkFaint, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Renewable advantage, 2100</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 600, color: adv >= 0 ? COLORS.teal : COLORS.amber }}>
                  {(adv >= 0 ? "+" : "") + adv.toFixed(1)}T
                </div>
                <div style={{ fontSize: 11.5, color: COLORS.inkFaint, marginTop: 5 }}>Fossil minus renewable, cumulative</div>
              </Card>
            </div>

            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".09em", color: COLORS.inkDim, fontWeight: 600 }}>
                  <span style={{ color: COLORS.teal, fontFamily: "'JetBrains Mono', monospace", marginRight: 7 }}>03</span>
                  Cost trajectory, 2026&ndash;2100
                </h2>
                <div style={{ width: "auto" }}>
                  <SegGroup options={["cumulative", "annual"]} value={chartMode} onChange={setChartMode} />
                </div>
              </div>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={COLORS.lineSoft} />
                    <XAxis dataKey="year" tick={{ fill: COLORS.inkFaint, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5 }} tickLine={false} axisLine={{ stroke: COLORS.line }} />
                    <YAxis
                      tick={{ fill: COLORS.inkFaint, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5 }}
                      tickLine={false} axisLine={{ stroke: COLORS.line }}
                      label={{ value: "Trillion USD" + (chartMode === "annual" ? " / year" : ""), angle: -90, position: "insideLeft", fill: COLORS.inkFaint, fontSize: 11 }}
                    />
                    <Tooltip content={chartTooltip} />
                    <Legend wrapperStyle={{ color: COLORS.inkDim, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }} />
                    {result.intersectionYear && (
                      <ReferenceLine x={Math.round(result.intersectionYear)} stroke={COLORS.inkFaint} strokeDasharray="3 3" />
                    )}
                    <Line type="monotone" dataKey="Renewable" stroke={COLORS.teal} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="Fossil system cost" stroke={COLORS.amber} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {pinned.length > 0 && (
              <Card style={{ marginTop: 18 }}>
                <CardHeading n="04">Pinned scenario comparison</CardHeading>
                <div style={{ height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={compareData} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke={COLORS.lineSoft} />
                      <XAxis dataKey="year" tick={{ fill: COLORS.inkFaint, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5 }} tickLine={false} axisLine={{ stroke: COLORS.line }} />
                      <YAxis
                        tick={{ fill: COLORS.inkFaint, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5 }}
                        tickLine={false} axisLine={{ stroke: COLORS.line }}
                        label={{ value: "Cumulative cost, Trillion USD", angle: -90, position: "insideLeft", fill: COLORS.inkFaint, fontSize: 11 }}
                      />
                      <Tooltip content={chartTooltip} />
                      {pinned.flatMap((p, i) => {
                        const color = pinColors[i % pinColors.length];
                        const renewableKey = `pin_${p.id}_ren`;
                        const fossilKey = `pin_${p.id}_fos`;
                        return [
                          <Line key={renewableKey} type="monotone" dataKey={renewableKey} name={`${p.label} \u00b7 renewable`} stroke={color} strokeWidth={2.2} dot={false} isAnimationActive={false} />,
                          <Line key={fossilKey} type="monotone" dataKey={fossilKey} name={`${p.label} \u00b7 fossil`} stroke={color} strokeWidth={1.4} strokeDasharray="4 3" dot={false} isAnimationActive={false} />,
                        ];
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, marginTop: 14 }}>
                  <thead>
                    <tr>
                      {["Scenario", "Crossover", "Renewable 2100 ($T)", "Fossil 2100 ($T)", "Levelized ren. ($/MWh)"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.inkFaint, textTransform: "uppercase", fontSize: 10.5, letterSpacing: ".06em", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pinned.map((p, i) => (
                      <tr key={p.id}>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'Space Grotesk', sans-serif", color: COLORS.inkDim }}>
                          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: pinColors[i % pinColors.length], marginRight: 8 }} />
                          {p.label}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>{p.result.intersectionYear ? p.result.intersectionYear.toFixed(1) : "\u2014"}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>{p.result.renCum2100.toFixed(1)}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>{p.result.fosCum2100.toFixed(1)}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>{p.result.levelizedRenewable.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            <Card style={{ marginTop: 18 }}>
              <CardHeading n="05">Two-variable sensitivity matrix</CardHeading>
              <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 16 }}>
                <div style={{ minWidth: 200, flex: 1 }}>
                  <Field label="Rows">
                    <select value={matrixRow} onChange={(e) => setMatrixRow(e.target.value)} style={selectStyle}>
                      <option value="techCost">Technology-cost trajectory</option>
                      <option value="repowering">Repowering scenario</option>
                      <option value="fuelPrice">Fossil fuel price</option>
                      <option value="assetLifetime">Asset lifetime</option>
                    </select>
                  </Field>
                </div>
                <div style={{ minWidth: 200, flex: 1 }}>
                  <Field label="Columns">
                    <select value={matrixCol} onChange={(e) => setMatrixCol(e.target.value)} style={selectStyle}>
                      <option value="techCost">Technology-cost trajectory</option>
                      <option value="repowering">Repowering scenario</option>
                      <option value="fuelPrice">Fossil fuel price</option>
                      <option value="assetLifetime">Asset lifetime</option>
                    </select>
                  </Field>
                </div>
                <div style={{ minWidth: 200, flex: 1 }}>
                  <Field label="Metric">
                    <select value={matrixMetric} onChange={(e) => setMatrixMetric(e.target.value)} style={selectStyle}>
                      <option value="crossover">Crossover year</option>
                      <option value="renCum">Renewable cumulative cost 2100 ($T)</option>
                      <option value="fosCum">Fossil cumulative cost 2100 ($T)</option>
                      <option value="advantage">Renewable advantage 2100 ($T)</option>
                      <option value="levelizedRen">Renewable LCOE ($/MWh)</option>
                      <option value="levelizedFos">Fossil LCOE ($/MWh)</option>
                      <option value="levelizedDiff">LCOE difference, Fossil \u2212 Renewable ($/MWh)</option>
                    </select>
                  </Field>
                </div>
              </div>

              {!matrix ? (
                <div style={{ color: COLORS.inkFaint, fontSize: 11.5 }}>Choose two different variables for rows and columns.</div>
              ) : (
                <>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, minWidth: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ color: COLORS.inkFaint, padding: "8px 12px", fontWeight: 500, fontSize: 11.5, border: "none" }} />
                          {matrix.cols.map((c) => (
                            <th key={String(c)} style={{ color: COLORS.inkFaint, padding: "8px 12px", fontWeight: 500, fontSize: 11.5, border: "none" }}>
                              {axisLabelFmt[matrixCol](c)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {matrix.rows.map((rw, ri) => (
                          <tr key={String(rw)}>
                            <td style={{ background: "transparent", color: COLORS.inkDim, textAlign: "right", fontWeight: 500, padding: "12px 14px 12px 12px", border: `1px solid ${COLORS.bg}` }}>
                              {axisLabelFmt[matrixRow](rw)}
                            </td>
                            {matrix.cols.map((cl, ci) => {
                              const v = matrix.values[ri][ci];
                              const bg = colorForValue(v, matrix.min, matrix.max, matrix.invert);
                              const text = matrixMetric === "crossover" ? (v === null ? "\u2014" : v.toFixed(1)) : v.toFixed(1);
                              return (
                                <td key={String(cl)} style={{ border: `1px solid ${COLORS.bg}`, padding: "12px", textAlign: "center", color: "#08130F", fontWeight: 600, minWidth: 92, background: bg }}>
                                  {text}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ color: COLORS.inkFaint, fontSize: 11.5, marginTop: 10 }}>
                    {axisTitles[matrixRow]} &times; {axisTitles[matrixCol]}, with {matrix.fixedLabel} and {geography} held from the controls above.
                  </div>
                </>
              )}
            </Card>

            <Card style={{ marginTop: 18 }}>
              <CardHeading n="06">Scenario definitions in effect</CardHeading>
              <div style={{ color: COLORS.inkFaint, fontSize: 11.5, marginBottom: 12, lineHeight: 1.5 }}>
                The actual figures behind the controls above, for the currently selected asset-lifetime ({assetLifetime}), repowering ({repowering}), and technology-cost ({techCost}) scenarios.
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {["Technology", "Lifetime (yrs)", "Repowering factor", "Cost 2026 ($/kW)", "Cost 2050 ($/kW)"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.inkFaint, textTransform: "uppercase", fontSize: 10.5, letterSpacing: ".06em", fontWeight: 600 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assumptionRows.map((r) => (
                      <tr key={r.name}>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.inkDim }}>{r.name}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>{r.lifetime}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>
                          {r.repoweringFactor === null ? "\u2014" : r.repoweringFactor.toFixed(2) + "\u00d7"}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>
                          {r.cost2026 === null ? "\u2014" : "$" + r.cost2026}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontFamily: "'JetBrains Mono', monospace" }}>
                          {r.cost2050 === null ? "\u2014" : "$" + r.cost2050}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: COLORS.inkFaint, fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
                Repowering factor scales the cost of replacing an expired asset relative to a full new build (e.g. 0.35\u00d7 means repowering costs 35% of a new-build). Fossil lifetime under {assetLifetime} is {fossilLifetimeFor(assetLifetime)} years; fossil generation cost is fixed at ${(fossilGenerationCapexPerGW / 1e6).toFixed(0)}/kW and does not vary by technology-cost trajectory.
              </div>
            </Card>
          </div>
        </div>

        <footer style={{ marginTop: 34, textAlign: "center", color: COLORS.inkFaint, fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace" }}>
          Built from the underlying capacity-expansion &amp; cost model &middot; figures are illustrative long-run estimates, not forecasts
        </footer>
      </div>
    </div>
  );
}

const selectStyle = {
  width: "100%", background: "#0A1420", border: `1px solid ${COLORS.line}`, color: COLORS.ink,
  padding: "8px 10px", borderRadius: 7, fontFamily: "inherit", fontSize: 12.5,
};
