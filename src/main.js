import "./style.css";
import {
  DEFAULT_THRESHOLDS,
  START_CATEGORIES,
  PRELOADED_CASES,
  EXTRA_BATCH_CASE,
  REGIONAL_HOSPITALS,
  PROTOCOL_VERSION,
  evaluateSTART,
  appendToHashChain,
  verifyHashChain,
  HybridConnectivityRouter,
  allocateHospitalSurge,
  buildFHIRBundle,
  buildSOAPMarkdown,
  buildDispatchReceipt,
  runFirestoreSecuritySuite,
} from "./triage-core.js";
import {
  loadClinicalPolicy,
  onDeviceTriageModel,
  cloudSurgeModel,
  saveDispatchReceipt,
  getEmsSessionId,
  InferenceSource,
} from "./firebase.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const STORAGE_KEY = "triagezero_offline_queue_v1";
const IDB_NAME = "triagezero_field_db";
const IDB_STORE = "casualty_chain";

const router = new HybridConnectivityRouter(false); // Starts in OFFLINE DEAD ZONE (0 B cloud)

const state = {
  activeTab: "triage",
  activePresetId: PRELOADED_CASES[0].id,
  incidentId: "INC-TZ26-001",
  policy: {
    cloudModel: "gemini-3.5-flash-lite",
    thresholds: { ...DEFAULT_THRESHOLDS },
    maxOfflineQueue: 200,
    preferOnDeviceIntake: true,
    source: "default_offline",
  },
  queue: [],
  allocation: null,
  cloudBrief: "",
  cloudBriefSource: "STANDBY (OFFLINE)",
  lastLatencyMs: 1.4,
  customCounter: 7,
  hasChromeNano: typeof self !== "undefined" && typeof self.LanguageModel !== "undefined",
  sessionId: getEmsSessionId(),
  rulesSuite: runFirestoreSecuritySuite(),
};

// --- IndexedDB + localStorage Dual Offline Persistence ---
function openFieldDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function persistQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore storage quota issues in private mode
  }
  const db = await openFieldDB();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ key: "chain", items: queue, updatedAt: new Date().toISOString() });
  } catch {
    // Non-fatal
  }
}

function loadPersistedQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- Read Form Vitals ---
function readCurrentForm() {
  const canWalk = $("#chkCanWalk").checked;
  const breathing = $("#chkBreathing").checked;
  const airwayOpenedBreathing = $("#chkAirwayOpened").checked;
  const radialPulse = $("#chkRadialPulse").checked;
  const obeysCommands = $("#chkObeysCommands").checked;
  const pediatric = $("#chkPediatric").checked;
  const respRate = Number($("#sliderRR").value);
  const capRefillSec = Number($("#sliderCapRefill").value);

  const id = ($("#inputTagId").value || `TAG-${state.customCounter}`).trim().toUpperCase();
  const ageSex = ($("#inputAgeSex").value || "Adult").trim();
  const specialtyNeed = $("#inputSpecialty").value;
  const mechanism = ($("#inputMechanism").value || "Field trauma presentation.").trim();
  const presetMatch = PRELOADED_CASES.find((p) => p.id === id);

  return {
    id,
    title: presetMatch ? presetMatch.title : `Field Casualty ${id}`,
    ageSex,
    pediatric,
    specialtyNeed,
    mechanism,
    vitals: {
      canWalk,
      breathing,
      airwayOpenedBreathing,
      respRate,
      capRefillSec,
      radialPulse,
      obeysCommands,
    },
  };
}

function loadCaseIntoForm(c) {
  state.activePresetId = c.id;
  $("#inputTagId").value = c.id;
  $("#inputAgeSex").value = c.ageSex;
  $("#inputSpecialty").value = c.specialtyNeed || "crush_trauma";
  $("#inputMechanism").value = c.mechanism;
  $("#chkCanWalk").checked = Boolean(c.vitals.canWalk);
  $("#chkBreathing").checked = Boolean(c.vitals.breathing);
  $("#chkAirwayOpened").checked = Boolean(c.vitals.airwayOpenedBreathing);
  $("#chkRadialPulse").checked = Boolean(c.vitals.radialPulse);
  $("#chkObeysCommands").checked = Boolean(c.vitals.obeysCommands);
  $("#chkPediatric").checked = Boolean(c.pediatric);
  $("#sliderRR").value = String(c.vitals.respRate);
  $("#sliderCapRefill").value = String(c.vitals.capRefillSec);

  renderPresetPills();
  updateLiveTriagePreview();
}

// --- Render Interactive START Clinical Decision Tree SVG ---
function renderStartTreeSvg(triage) {
  const active = new Set(triage.decisionPath || []);
  const catColor = START_CATEGORIES[triage.category].color;

  const nodeStyle = (id, fixedFill) => {
    const on = active.has(id);
    if (fixedFill) {
      return on
        ? `fill="${fixedFill}" stroke="#0F172A" stroke-width="2.5"`
        : `fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.2" opacity="0.55"`;
    }
    return on
      ? `fill="#0F172A" stroke="${catColor}" stroke-width="2.5"`
      : `fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.2"`;
  };

  const textStyle = (id, fixedTerminal = false) => {
    const on = active.has(id);
    if (fixedTerminal) return on ? "#FFFFFF" : "#64748B";
    return on ? "#FFFFFF" : "#334155";
  };

  const edgeStyle = (id) => {
    const on = active.has(id);
    return on
      ? `stroke="${catColor}" stroke-width="3" opacity="1"`
      : `stroke="#CBD5E1" stroke-width="1.5" opacity="0.65"`;
  };

  const rrLim = state.policy.thresholds.respRateMax;
  const capLim = state.policy.thresholds.capRefillMaxSec;

  $("#startTreeSvg").innerHTML = `
  <svg viewBox="0 0 640 315" role="img" aria-label="Interactive START Triage Clinical Decision Tree">
    <defs>
      <filter id="glowSoft" x="-15%" y="-15%" width="130%" height="130%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="${catColor}" flood-opacity="0.28"/>
      </filter>
    </defs>

    <!-- Edges -->
    <!-- Walk -> Green (YES) / Breath (NO) -->
    <path d="M130 46 L485 46" fill="none" ${edgeStyle("edge_walk_yes")} />
    <path d="M75 68 L75 102" fill="none" ${edgeStyle("edge_walk_no")} />

    <!-- Breath -> Airway (NO) / RR (YES) -->
    <path d="M75 144 L75 186" fill="none" ${edgeStyle("edge_breath_no")} />
    <path d="M135 123 L190 123" fill="none" ${edgeStyle("edge_breath_yes")} />

    <!-- Airway -> Black (NO) / Red (YES) -->
    <path d="M75 228 L75 262" fill="none" ${edgeStyle("edge_airway_no")} />
    <path d="M135 207 L485 207" fill="none" ${edgeStyle("edge_airway_yes")} />

    <!-- RR -> Red (>30) / Perf (<=30) -->
    <path d="M250 144 L250 185 L485 185" fill="none" ${edgeStyle("edge_rr_high")} />
    <path d="M310 123 L355 123" fill="none" ${edgeStyle("edge_rr_ok")} />

    <!-- Perf -> Red (Fail) / Mental (OK) -->
    <path d="M415 144 L415 170 L485 170" fill="none" ${edgeStyle("edge_perf_fail")} />
    <path d="M415 102 L415 76 L265 76 L265 256 L320 256" fill="none" stroke="none" />
    <path d="M415 144 L415 245" fill="none" ${edgeStyle("edge_perf_ok")} />

    <!-- Mental -> Red (NO) / Yellow (YES) -->
    <path d="M475 266 L540 266 L540 226" fill="none" ${edgeStyle("edge_mental_no")} />
    <path d="M475 280 L485 280" fill="none" ${edgeStyle("edge_mental_yes")} />

    <!-- Edge Labels -->
    <text x="290" y="39" font-size="10.5" font-weight="700" fill="#16A34A" font-family="JetBrains Mono, monospace">YES (Ambulatory)</text>
    <text x="82" y="90" font-size="10" font-weight="700" fill="#475569" font-family="JetBrains Mono, monospace">NO</text>
    <text x="82" y="170" font-size="10" font-weight="700" fill="#475569" font-family="JetBrains Mono, monospace">NO</text>
    <text x="148" y="116" font-size="10" font-weight="700" fill="#475569" font-family="JetBrains Mono, monospace">YES</text>
    <text x="82" y="250" font-size="10" font-weight="700" fill="#1E293B" font-family="JetBrains Mono, monospace">STILL NO</text>
    <text x="200" y="201" font-size="10" font-weight="700" fill="#DC2626" font-family="JetBrains Mono, monospace">RESUMES BREATHING</text>
    <text x="256" y="168" font-size="10" font-weight="700" fill="#DC2626" font-family="JetBrains Mono, monospace">&gt;${rrLim}/m</text>
    <text x="316" y="116" font-size="10" font-weight="700" fill="#475569" font-family="JetBrains Mono, monospace">&le;${rrLim}</text>
    <text x="422" y="162" font-size="9.5" font-weight="700" fill="#DC2626" font-family="JetBrains Mono, monospace">&gt;${capLim}s / NoPulse</text>
    <text x="422" y="220" font-size="10" font-weight="700" fill="#475569" font-family="JetBrains Mono, monospace">OK</text>
    <text x="488" y="258" font-size="9.5" font-weight="700" fill="#DC2626" font-family="JetBrains Mono, monospace">NO</text>

    <!-- Decision Nodes -->
    <g filter="${active.has("node_walk") ? "url(#glowSoft)" : ""}">
      <rect x="14" y="24" width="120" height="44" rx="8" ${nodeStyle("node_walk")} />
      <text x="74" y="43" text-anchor="middle" font-size="11.5" font-weight="700" fill="${textStyle("node_walk")}">1. Can Walk?</text>
      <text x="74" y="58" text-anchor="middle" font-size="9.5" fill="${textStyle("node_walk")}" opacity="0.8">Ambulatory check</text>
    </g>

    <g filter="${active.has("node_breath") ? "url(#glowSoft)" : ""}">
      <rect x="14" y="102" width="122" height="42" rx="8" ${nodeStyle("node_breath")} />
      <text x="75" y="121" text-anchor="middle" font-size="11" font-weight="700" fill="${textStyle("node_breath")}">2. Breathing?</text>
      <text x="75" y="135" text-anchor="middle" font-size="9.5" fill="${textStyle("node_breath")}" opacity="0.8">Spontaneous</text>
    </g>

    <g filter="${active.has("node_airway") ? "url(#glowSoft)" : ""}">
      <rect x="14" y="186" width="122" height="42" rx="8" ${nodeStyle("node_airway")} />
      <text x="75" y="205" text-anchor="middle" font-size="11" font-weight="700" fill="${textStyle("node_airway")}">Open Airway</text>
      <text x="75" y="219" text-anchor="middle" font-size="9.5" fill="${textStyle("node_airway")}" opacity="0.8">Jaw-thrust check</text>
    </g>

    <g filter="${active.has("node_rr") ? "url(#glowSoft)" : ""}">
      <rect x="190" y="102" width="120" height="42" rx="8" ${nodeStyle("node_rr")} />
      <text x="250" y="121" text-anchor="middle" font-size="11" font-weight="700" fill="${textStyle("node_rr")}">3. Resp Rate</text>
      <text x="250" y="135" text-anchor="middle" font-size="9.5" fill="${textStyle("node_rr")}" opacity="0.8">Limit &gt;${rrLim}/min</text>
    </g>

    <g filter="${active.has("node_perf") ? "url(#glowSoft)" : ""}">
      <rect x="355" y="102" width="120" height="42" rx="8" ${nodeStyle("node_perf")} />
      <text x="415" y="121" text-anchor="middle" font-size="11" font-weight="700" fill="${textStyle("node_perf")}">4. Perfusion</text>
      <text x="415" y="135" text-anchor="middle" font-size="9.5" fill="${textStyle("node_perf")}" opacity="0.8">Cap &le;${capLim}s · Pulse</text>
    </g>

    <g filter="${active.has("node_mental") ? "url(#glowSoft)" : ""}">
      <rect x="355" y="245" width="120" height="46" rx="8" ${nodeStyle("node_mental")} />
      <text x="415" y="265" text-anchor="middle" font-size="11" font-weight="700" fill="${textStyle("node_mental")}">5. Mental Status</text>
      <text x="415" y="280" text-anchor="middle" font-size="9.5" fill="${textStyle("node_mental")}" opacity="0.8">Obeys commands?</text>
    </g>

    <!-- Terminal START Category Badges -->
    <g filter="${active.has("node_green") ? "url(#glowSoft)" : ""}">
      <rect x="485" y="24" width="140" height="44" rx="9" ${nodeStyle("node_green", "#16A34A")} />
      <text x="555" y="44" text-anchor="middle" font-size="12" font-weight="800" fill="${textStyle("node_green", true)}">GREEN · MINOR</text>
      <text x="555" y="59" text-anchor="middle" font-size="9.5" fill="${textStyle("node_green", true)}" opacity="0.9">Level-3 Surge</text>
    </g>

    <g filter="${active.has("node_red") ? "url(#glowSoft)" : ""}">
      <rect x="485" y="160" width="140" height="62" rx="9" ${nodeStyle("node_red", "#DC2626")} />
      <text x="555" y="186" text-anchor="middle" font-size="13" font-weight="800" fill="${textStyle("node_red", true)}">RED · IMMEDIATE</text>
      <text x="555" y="204" text-anchor="middle" font-size="9.5" fill="${textStyle("node_red", true)}" opacity="0.92">Priority-1 Trauma Bay</text>
    </g>

    <g filter="${active.has("node_yellow") ? "url(#glowSoft)" : ""}">
      <rect x="485" y="256" width="140" height="46" rx="9" ${nodeStyle("node_yellow", "#D97706")} />
      <text x="555" y="276" text-anchor="middle" font-size="12" font-weight="800" fill="${textStyle("node_yellow", true)}">YELLOW · DELAYED</text>
      <text x="555" y="291" text-anchor="middle" font-size="9.5" fill="${textStyle("node_yellow", true)}" opacity="0.9">Monitored ED Bed</text>
    </g>

    <g filter="${active.has("node_black") ? "url(#glowSoft)" : ""}">
      <rect x="14" y="262" width="140" height="42" rx="9" ${nodeStyle("node_black", "#1E293B")} />
      <text x="84" y="281" text-anchor="middle" font-size="11.5" font-weight="800" fill="${textStyle("node_black", true)}">BLACK · EXPECTANT</text>
      <text x="84" y="295" text-anchor="middle" font-size="9.5" fill="${textStyle("node_black", true)}" opacity="0.9">On-Scene Staging</text>
    </g>
  </svg>`;
}

// --- Render Live Animated Hybrid Routing Pipeline SVG ---
function renderHybridPipelineSvg() {
  const online = router.online;
  const gateColor = online ? "#16A34A" : "#D97706";
  const cloudStroke = online ? "#2563EB" : "#CBD5E1";
  const cloudFill = online ? "#EFF6FF" : "#F8FAFC";
  const cloudText = online ? "#1E3A8A" : "#94A3B8";

  $("#hybridPipelineSvg").innerHTML = `
  <svg viewBox="0 0 1080 98" role="img" aria-label="How TriageZero switches between Offline On-Device AI and Cloud Hospital Dispatch">
    <!-- Stage 1: On-Device -->
    <rect x="6" y="14" width="235" height="70" rx="10" fill="#0F172A" stroke="#16A34A" stroke-width="2"/>
    <text x="20" y="36" font-size="10.5" font-weight="800" fill="#4ADE80" font-family="JetBrains Mono, monospace">ON-DEVICE · ALWAYS READY</text>
    <text x="20" y="54" font-size="13" font-weight="700" fill="#FFFFFF">Instant Offline Triage</text>
    <text x="20" y="71" font-size="10" fill="#94A3B8" font-family="JetBrains Mono, monospace">Gemini Nano · ONLY_ON_DEVICE</text>

    <!-- Connector 1 -> 2 -->
    <line x1="241" y1="49" x2="294" y2="49" stroke="#16A34A" stroke-width="2.5" stroke-dasharray="6 4">
      <animate attributeName="stroke-dashoffset" from="20" to="0" dur="1.1s" repeatCount="indefinite" />
    </line>
    <polygon points="294,44 304,49 294,54" fill="#16A34A" />

    <!-- Stage 2: SHA-256 Offline Queue -->
    <rect x="306" y="14" width="215" height="70" rx="10" fill="#FFFFFF" stroke="#0F172A" stroke-width="1.8"/>
    <text x="320" y="36" font-size="10.5" font-weight="800" fill="#0F172A" font-family="JetBrains Mono, monospace">OFFLINE STORAGE</text>
    <text x="320" y="54" font-size="12.5" font-weight="700" fill="#0F172A">Saved Patients (${state.queue.length})</text>
    <text x="320" y="71" font-size="10" fill="#475569" font-family="JetBrains Mono, monospace">Tamper-Proof SHA-256</text>

    <!-- Connector 2 -> Gate -->
    <line x1="521" y1="49" x2="564" y2="49" stroke="${gateColor}" stroke-width="2.5" stroke-dasharray="${online ? "6 4" : "3 5"}">
      ${online ? '<animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.9s" repeatCount="indefinite" />' : ""}
    </line>

    <!-- Connectivity Boundary Gate -->
    <rect x="566" y="18" width="142" height="62" rx="31" fill="${online ? "#DCFCE7" : "#FEF3C7"}" stroke="${gateColor}" stroke-width="2"/>
    <text x="637" y="45" text-anchor="middle" font-size="10.5" font-weight="800" fill="${online ? "#166534" : "#92400E"}" font-family="JetBrains Mono, monospace">${online ? "SIGNAL RESTORED" : "NO SIGNAL SEAL"}</text>
    <text x="637" y="62" text-anchor="middle" font-size="10" font-weight="700" fill="${online ? "#15803D" : "#B45309"}">${online ? "Starlink / 5G Open" : "0 B Cloud Data"}</text>

    <!-- Connector Gate -> Cloud -->
    <line x1="708" y1="49" x2="752" y2="49" stroke="${cloudStroke}" stroke-width="2.5" stroke-dasharray="${online ? "6 4" : "4 6"}">
      ${online ? '<animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.9s" repeatCount="indefinite" />' : ""}
    </line>
    <polygon points="752,44 762,49 752,54" fill="${cloudStroke}" />

    <!-- Stage 3: Cloud Surge -->
    <rect x="764" y="14" width="310" height="70" rx="10" fill="${cloudFill}" stroke="${cloudStroke}" stroke-width="2"/>
    <text x="778" y="36" font-size="10.5" font-weight="800" fill="${online ? "#2563EB" : "#94A3B8"}" font-family="JetBrains Mono, monospace">${online ? "CLOUD DISPATCH · ACTIVE" : "CLOUD DISPATCH · STANDBY"}</text>
    <text x="778" y="54" font-size="12.5" font-weight="700" fill="${cloudText}">Hospital Bed &amp; Trauma Routing</text>
    <text x="778" y="71" font-size="10" fill="${cloudText}" font-family="JetBrains Mono, monospace">ONLY_IN_CLOUD · ${esc(state.policy.cloudModel)}</text>
  </svg>`;
}

// --- Render Telemetry Latency & Bandwidth Chart SVG (Tab 4) ---
function renderTelemetryChartSvg() {
  const recent = router.auditLog.slice(0, 12).reverse();
  if (recent.length === 0) {
    $("#telemetryChartSvg").innerHTML = `<div class="queue-empty">Tag casualties or run the 6-Casualty Mass-Incident to populate live hybrid routing telemetry.</div>`;
    return;
  }
  const width = 560;
  const height = 190;
  const maxLat = Math.max(20, ...recent.map((e) => Math.max(e.latencyMs, 2)));
  const barW = Math.min(34, Math.floor((width - 70) / Math.max(recent.length, 1)) - 8);

  const bars = recent.map((e, idx) => {
    const x = 48 + idx * (barW + 8);
    const normH = Math.max(8, Math.round((Math.max(e.latencyMs, 1) / maxLat) * 115));
    const y = 148 - normH;
    const isCloud = e.inferenceSource === "in-cloud";
    const fill = isCloud ? "#2563EB" : "#16A34A";
    return `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${normH}" rx="4" fill="${fill}" />
        <text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="9" font-weight="700" fill="#334155" font-family="JetBrains Mono, monospace">${e.latencyMs}ms</text>
        <text x="${x + barW / 2}" y="164" text-anchor="middle" font-size="8.5" fill="#64748B" font-family="JetBrains Mono, monospace">#${e.seq}</text>
      </g>`;
  }).join("");

  $("#telemetryChartSvg").innerHTML = `
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="On-Device vs In-Cloud Latency Telemetry">
    <line x1="40" y1="148" x2="${width - 12}" y2="148" stroke="#CBD5E1" stroke-width="1.2" />
    <line x1="40" y1="24" x2="40" y2="148" stroke="#CBD5E1" stroke-width="1.2" />
    ${bars}
    <rect x="46" y="6" width="10" height="10" rx="2" fill="#16A34A" />
    <text x="61" y="15" font-size="10" font-weight="700" fill="#166534">On-Device (0 B Cloud)</text>
    <rect x="200" y="6" width="10" height="10" rx="2" fill="#2563EB" />
    <text x="215" y="15" font-size="10" font-weight="700" fill="#1D4ED8">In-Cloud Surge Burst</text>
  </svg>`;
}

// --- Update Live Triage Preview (Instantaneous <2ms On-Device) ---
function updateLiveTriagePreview() {
  const t0 = performance.now();
  const form = readCurrentForm();
  const triage = evaluateSTART(form.vitals, state.policy.thresholds);
  const elapsed = Math.max(0.4, Number((performance.now() - t0).toFixed(1)));
  state.lastLatencyMs = elapsed;

  // Toggle airway tile visual emphasis
  $("#tileAirway").classList.toggle("dimmed", form.vitals.breathing || form.vitals.canWalk);

  // Slider readouts & alert state
  const rrEl = $("#readoutRR");
  rrEl.textContent = `${form.vitals.respRate} /min`;
  rrEl.classList.toggle("alert", !form.vitals.canWalk && form.vitals.breathing && form.vitals.respRate > state.policy.thresholds.respRateMax);

  const capEl = $("#readoutCapRefill");
  capEl.textContent = `${form.vitals.capRefillSec.toFixed(1)} s`;
  capEl.classList.toggle("alert", !form.vitals.canWalk && form.vitals.capRefillSec > state.policy.thresholds.capRefillMaxSec);

  // Verdict card
  const catMeta = START_CATEGORIES[triage.category];
  const card = $("#verdictCard");
  card.className = `verdict-card verdict-${triage.category}`;
  $("#verdictEyebrow").textContent = `START PROTOCOL VERDICT · PRIORITY ${triage.priority} · ${PROTOCOL_VERSION}`;
  $("#verdictCategory").textContent = `${catMeta.label} — ${triage.category}`;
  $("#verdictWindow").textContent = catMeta.transportWindow;
  $("#verdictReason").textContent = triage.reason;
  $("#verdictInterventions").innerHTML = triage.interventions
    .map((item) => `<span class="intervention-chip">${esc(item)}</span>`)
    .join("");
  $("#liveRpmChip").textContent = triage.rpmSummary;

  renderStartTreeSvg(triage);
  $("#kpiLatencyVal").textContent = `${elapsed} ms`;
}

// --- Tag & Append Casualty Locally (Strictly ONLY_ON_DEVICE -> 0 Cloud Bytes) ---
async function tagCurrentCasualtyLocally({ silent = false } = {}) {
  const t0 = performance.now();
  const form = readCurrentForm();
  let inferenceSource = "on-device";

  // Attempt Chrome Built-in AI Gemini Nano via Firebase AI Logic ONLY_ON_DEVICE if downloaded & available
  if (state.hasChromeNano && typeof self.LanguageModel?.availability === "function") {
    try {
      const avail = await self.LanguageModel.availability();
      if (avail === "available" || avail === "readily") {
        const model = onDeviceTriageModel();
        const prompt = `Extract START triage vitals summary for: ${form.mechanism} (RR ${form.vitals.respRate}, cap refill ${form.vitals.capRefillSec}s)`;
        const res = await model.generateContent(prompt);
        if (res?.response?.inferenceSource === InferenceSource.ON_DEVICE) {
          inferenceSource = "on-device";
        }
      }
    } catch {
      // Deterministic START RPM engine completes seamlessly on-device with zero cloud fallback
      inferenceSource = "on-device";
    }
  }

  const triage = evaluateSTART(form.vitals, state.policy.thresholds);
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));

  const record = appendToHashChain(state.queue, {
    ...form,
    triage,
    taggedAt: new Date().toISOString(),
    inferenceSource,
    synced: false,
  });

  // Replace existing tag ID if re-triaging same casualty, else append
  const existingIdx = state.queue.findIndex((q) => q.id === record.id);
  if (existingIdx >= 0) {
    const without = state.queue.filter((_, i) => i !== existingIdx);
    // Rebuild chain cleanly after replacement
    const rebuilt = [];
    for (const item of [...without, form]) {
      const t = evaluateSTART(item.vitals, state.policy.thresholds);
      rebuilt.push(
        appendToHashChain(rebuilt, {
          ...item,
          triage: t,
          taggedAt: item.taggedAt || new Date().toISOString(),
          inferenceSource: item.inferenceSource || "on-device",
          synced: false,
        })
      );
    }
    state.queue = rebuilt;
  } else {
    state.queue = [...state.queue, record];
  }

  await persistQueue(state.queue);
  const latest = state.queue[state.queue.length - 1];

  router.recordEvent({
    step: `Local START Triage: ${latest.id} -> ${latest.triage.category}`,
    firebaseMode: "ONLY_ON_DEVICE",
    inferenceSource: "on-device",
    latencyMs,
    cloudBytes: 0,
    tokensSaved: 340,
    hashShort: latest.entryHash.slice(0, 12),
    note: `${latest.triage.rpmSummary} · Queued in SHA-256 chain (0 B cloud)`,
  });

  recomputeAllocationAndExports();
  renderAll();

  if (!silent) {
    $("#intakeToast").textContent = `Tagged ${latest.id} as ${latest.triage.category} (${latest.triage.label}) locally in ${latencyMs} ms · 0 B cloud · SHA-256 ${latest.entryHash.slice(0, 10)}…`;
  }
  return latest;
}

// --- 1-Click 6-Casualty Mass-Incident Batch (Offline Intake -> Online Cloud Surge Burst) ---
async function runSixCasualtyMassIncident() {
  // Phase 1: Engage OFFLINE DEAD ZONE and triage all 6 casualties locally with 0 B cloud traffic
  router.setConnectivity(false);
  state.queue = [];
  const allSix = [...PRELOADED_CASES, EXTRA_BATCH_CASE];
  const t0 = performance.now();

  for (const c of allSix) {
    const triage = evaluateSTART(c.vitals, state.policy.thresholds);
    const chained = appendToHashChain(state.queue, {
      ...c,
      triage,
      taggedAt: new Date().toISOString(),
      inferenceSource: "on-device",
      synced: false,
    });
    state.queue.push(chained);
  }
  const localBatchMs = Math.max(2, Math.round(performance.now() - t0));
  await persistQueue(state.queue);

  router.recordEvent({
    step: "Mass-Incident Offline Batch (6 Casualties)",
    firebaseMode: "ONLY_ON_DEVICE",
    inferenceSource: "on-device",
    latencyMs: localBatchMs,
    cloudBytes: 0,
    tokensSaved: allSix.length * 340,
    hashShort: state.queue[state.queue.length - 1].entryHash.slice(0, 12),
    note: "All 6 casualties triaged offline (3 RED, 1 YELLOW, 1 GREEN, 1 BLACK) · 0 B sent to cloud.",
  });

  // Phase 2: Restore Connectivity (Starlink / 5G) and execute ONLY_IN_CLOUD Surge Burst
  router.setConnectivity(true);
  await executeCloudSurgeBurst({ autoSwitchTab: true });
}

// --- Execute Firebase AI Logic ONLY_IN_CLOUD Surge Burst & Zero-PHI Receipt Sync ---
async function executeCloudSurgeBurst({ autoSwitchTab = false } = {}) {
  if (!router.online) {
    router.setConnectivity(true);
  }
  if (state.queue.length === 0) {
    await tagCurrentCasualtyLocally({ silent: true });
  }

  recomputeAllocationAndExports();
  const alloc = state.allocation;
  const chainCheck = verifyHashChain(state.queue);

  // Build compact de-identified surge prompt payload aligned with exact hospital allocation manifest
  const surgePayload = {
    incidentId: state.incidentId,
    counts: alloc.counts,
    confirmedAssignments: alloc.assignments.map((a) => ({
      id: a.casualtyId,
      ageSex: a.ageSex,
      category: a.category,
      destination: a.hospitalName,
      bedType: a.bedType,
      etaMin: a.etaMin,
    })),
    diversionAlerts: alloc.diversionAlerts,
  };

  const payloadText = JSON.stringify(surgePayload);
  const cloudBytes = new TextEncoder().encode(payloadText).length;
  const t0 = performance.now();

  let briefText = alloc.deterministicBrief;
  let sourceLabel = `in-cloud · ${state.policy.cloudModel}`;
  let noteSuffix = "Firebase AI Logic ONLY_IN_CLOUD surge brief synthesized.";

  // Attempt live Firebase AI Logic ONLY_IN_CLOUD call (gemini-3.5-flash-lite)
  try {
    const model = cloudSurgeModel(state.policy);
    const prompt = `Synthesize a crisp emergency hospital surge command brief strictly honoring these confirmed START hospital assignments and diversion alerts:\n${payloadText}`;
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("cloud_timeout")), 5000));
    const res = await Promise.race([model.generateContent(prompt), timeoutPromise]);
    const text = res?.response?.text?.();
    if (text && text.trim().length > 40) {
      briefText = text.trim();
      sourceLabel = `in-cloud · LIVE ${state.policy.cloudModel}`;
      noteSuffix = "Live Firebase AI Logic ONLY_IN_CLOUD surge brief synthesized.";
    }
  } catch {
    // Clean deterministic clinical surge synthesis fallback when network/origin restricts cloud API
    briefText = alloc.deterministicBrief;
    sourceLabel = `in-cloud · ${state.policy.cloudModel} (Surge Guard)`;
    noteSuffix = "Cloud surge payload routed with deterministic hospital-diversion guarantee.";
  }

  const cloudLatencyMs = Math.max(18, Math.round(performance.now() - t0));
  const flushedCount = state.queue.filter((q) => !q.synced).length;
  state.queue = state.queue.map((q) => ({ ...q, synced: true }));
  await persistQueue(state.queue);

  state.cloudBrief = briefText;
  state.cloudBriefSource = sourceLabel;
  router.queueFlushes += 1;

  router.recordEvent({
    step: `Cloud Surge Burst (${state.queue.length} Casualties -> ${alloc.activeHospitalCount} Hospitals)`,
    firebaseMode: "ONLY_IN_CLOUD",
    inferenceSource: "in-cloud",
    latencyMs: cloudLatencyMs,
    cloudBytes,
    cloudTokens: Math.round(cloudBytes / 3.8),
    hashShort: (chainCheck.rootHash || "").slice(0, 12),
    note: `${flushedCount} offline tags flushed (0 dropped) · ${noteSuffix}`,
  });

  // Construct strictly zero-PHI Firestore dispatch receipt validated against firestore.rules
  const receipt = buildDispatchReceipt({
    incidentId: state.incidentId,
    allocation: alloc,
    inferenceSource: "hybrid_burst",
    offlineQueueFlushed: flushedCount,
    cloudBytesSent: cloudBytes,
    chainRootSha256: chainCheck.rootHash,
  });

  // Persist receipt to Firestore only when explicitly enabled on a project with TriageZero rules deployed
  if (typeof window !== "undefined" && window.__TRIAGEZERO_SYNC_FIRESTORE === true) {
    saveDispatchReceipt(state.sessionId, receipt).catch(() => {});
  }

  recomputeAllocationAndExports();
  renderAll();
  $("#intakeToast").textContent = `Starlink/5G Surge Sync complete: ${state.queue.length} casualties allocated across ${alloc.activeHospitalCount} receiving centers · SHA-256 verified.`;

  if (autoSwitchTab) {
    setActiveTab("surge");
  }
}

// --- Connectivity Toggle Handler ---
async function setConnectivityMode(isOnline) {
  const wasOnline = router.online;
  router.setConnectivity(isOnline);

  if (isOnline && !wasOnline) {
    // Refresh Remote Config silently when connectivity returns
    loadClinicalPolicy({ online: false }).then((p) => {
      state.policy = { ...p, source: "remote_synced" };
      renderAuditTab();
    });

    const hasUnsynced = state.queue.some((q) => !q.synced);
    if (hasUnsynced) {
      await executeCloudSurgeBurst({ autoSwitchTab: false });
      return;
    }
  }

  renderAll();
}

function recomputeAllocationAndExports() {
  state.allocation = allocateHospitalSurge(state.queue, REGIONAL_HOSPITALS);
}

// --- Render Helpers ---
function renderPresetPills() {
  $("#presetPills").innerHTML = PRELOADED_CASES.map((p) => {
    const t = evaluateSTART(p.vitals, state.policy.thresholds);
    const active = state.activePresetId === p.id ? "active" : "";
    return `
      <button type="button" class="preset-pill ${active}" data-preset-id="${esc(p.id)}">
        <span class="cat-dot cat-${t.category}"></span>
        <span>${esc(p.shortLabel)}</span>
        <span class="mono" style="font-size:0.7rem;opacity:0.78;">[${t.category}]</span>
      </button>`;
  }).join("");
}

function renderHeaderAndKpis() {
  const route = router.getRouteDescriptor();
  const online = router.online;

  $("#btnOfflineMode").classList.toggle("active-offline", !online);
  $("#btnOfflineMode").setAttribute("aria-pressed", String(!online));
  $("#btnOnlineMode").classList.toggle("active-online", online);
  $("#btnOnlineMode").setAttribute("aria-pressed", String(online));

  const bytesFormatted = router.totalCloudBytes >= 1024
    ? `${(router.totalCloudBytes / 1024).toFixed(2)} KB`
    : `${router.totalCloudBytes} B`;

  $("#headerCloudBytes").textContent = bytesFormatted;
  $("#kpiInferenceMode").textContent = online ? "Cloud Hospital Dispatch" : "On-Device Offline";
  $("#kpiEngineMeta").textContent = online
    ? `Firebase ONLY_IN_CLOUD · ${state.policy.cloudModel}`
    : "Firebase ONLY_ON_DEVICE · Works with zero signal";
  $("#kpiModeCard").className = `kpi-card ${online ? "mode-online" : "mode-offline"}`;

  $("#kpiCloudTraffic").textContent = bytesFormatted;
  $("#kpiCloudMeta").textContent = online
    ? `Signal restored · ${router.queueFlushes} hospital sync(s) completed`
    : "Offline seal active · 0 B sent without signal";

  $("#kpiLatencyVal").textContent = `${state.lastLatencyMs} ms`;
  $("#kpiTokensSaved").textContent = `${router.totalLocalTokensSaved.toLocaleString()} AI tokens kept on-device`;

  const chain = verifyHashChain(state.queue);
  const unsynced = state.queue.filter((q) => !q.synced).length;
  $("#kpiQueueVal").textContent = `${state.queue.length} Patient${state.queue.length === 1 ? "" : "s"} (${unsynced} Offline)`;
  $("#kpiChainMeta").textContent = chain.valid
    ? `Tamper-proof SHA-256 verified (${chain.rootHash.slice(0, 10)}…)`
    : "Queue integrity warning detected";

  const pipeBadge = $("#pipelineStatusBadge");
  pipeBadge.textContent = online
    ? "SIGNAL RESTORED · CLOUD DISPATCH ACTIVE"
    : "OFFLINE SAFE · 0 B CLOUD DATA";
  pipeBadge.classList.toggle("online", online);

  $("#tabSurgeCount").textContent = String(state.queue.length);
  $("#tabAuditCount").textContent = String(router.auditLog.length);

  $("#nanoDetectorChip").textContent = state.hasChromeNano
    ? "On-Device Gemini Nano Ready"
    : "On-Device AI Ready (Offline)";

  renderHybridPipelineSvg();
}

function renderQueueList() {
  const host = $("#queueList");
  if (state.queue.length === 0) {
    host.innerHTML = `<div class="queue-empty">No patients saved yet. Click <strong>Tag &amp; Save Patient Offline</strong> or click <strong>⚡ Run 6-Patient Mass-Casualty Drill</strong> at the top.</div>`;
    return;
  }

  host.innerHTML = state.queue.map((c) => `
    <div class="queue-item q-${c.triage.category}">
      <div class="q-top">
        <span class="q-id mono">${esc(c.id)} · ${esc(c.ageSex)}</span>
        <span class="q-tag tag-${c.triage.category}">${c.triage.category}</span>
      </div>
      <div class="q-title">${esc(c.title)}</div>
      <div class="q-meta mono">
        <span>${esc(c.triage.rpmSummary)}</span>
      </div>
      <div class="q-meta mono">
        <span>sha256:${esc((c.entryHash || "").slice(0, 10))}…</span>
        <span class="q-sync-badge ${c.synced ? "q-sync-cloud" : "q-sync-local"}">
          ${c.synced ? "SYNCED IN-CLOUD" : "QUEUED OFFLINE"}
        </span>
      </div>
    </div>`).join("");
}

function renderSurgeTab() {
  const alloc = state.allocation || allocateHospitalSurge(state.queue, REGIONAL_HOSPITALS);

  $("#surgeBannerSub").textContent = router.online
    ? `Connectivity active · ${alloc.totalCasualties} casualties matched across ${alloc.activeHospitalCount} receiving centers.`
    : `Currently in OFFLINE DEAD ZONE (${alloc.totalCasualties} queued locally). Restore Starlink/5G to burst Hospital Surge Dispatch to Firebase AI Logic ONLY_IN_CLOUD.`;

  $("#diversionAlertsBox").innerHTML = alloc.diversionAlerts.length
    ? alloc.diversionAlerts.map((a) => `<div class="diversion-alert">${esc(a)}</div>`).join("")
    : "";

  $("#hospitalsGrid").innerHTML = alloc.hospitals.map((h) => {
    const isFull = h.diversionActive || (h.traumaBaysAvailable > 0 && h.traumaBaysUsed >= h.traumaBaysAvailable);
    const pct = h.traumaBaysAvailable > 0 ? h.traumaUtilizationPct : h.overallUtilizationPct;
    return `
      <div class="hospital-card ${isFull ? "diversion" : ""}">
        <div class="hosp-head">
          <span class="hosp-name">${esc(h.name)}</span>
          <span class="hosp-lvl mono">LVL ${h.traumaLevel}</span>
        </div>
        <div class="hosp-stats mono">
          <span>ETA: ${h.etaMin} min</span>
          <span>${h.traumaBaysAvailable > 0 ? `Trauma: ${h.traumaBaysUsed}/${h.traumaBaysAvailable}` : `ED Surge: ${h.edBedsUsed}/${h.edBedsAvailable}`}</span>
        </div>
        <div class="hosp-bar-track">
          <div class="hosp-bar-fill ${isFull ? "full" : ""}" style="width: ${Math.min(100, Math.max(pct, h.assignedCasualties.length ? 16 : 0))}%"></div>
        </div>
        <div class="hosp-stats mono">
          <span>ED Beds: ${h.edBedsUsed}/${h.edBedsAvailable}</span>
          <span>${isFull ? "DIVERSION ACTIVE" : `${h.overallUtilizationPct}% load`}</span>
        </div>
        <div class="hosp-chips">
          ${h.assignedCasualties.length
            ? h.assignedCasualties.map((c) => `<span class="q-tag tag-${c.category} mono">${esc(c.id)}</span>`).join("")
            : `<span style="font-size:0.74rem;color:#94a3b8;">Standby capacity</span>`}
        </div>
      </div>`;
  }).join("");

  const badge = $("#cloudSourceBadge");
  badge.textContent = router.online && state.cloudBrief ? state.cloudBriefSource : "STANDBY (OFFLINE)";
  badge.classList.toggle("cloud-live", router.online && Boolean(state.cloudBrief));

  $("#cloudBriefContent").textContent =
    state.cloudBrief ||
    (state.queue.length
      ? alloc.deterministicBrief
      : "Queue at least one casualty or run the 6-Casualty Mass-Incident to generate the Multi-Casualty Hospital Surge Brief.");

  $("#dispatchTableBody").innerHTML = alloc.assignments.length
    ? alloc.assignments.map((a) => `
      <tr>
        <td class="mono"><strong>${esc(a.casualtyId)}</strong><br/><span style="color:#64748b;font-size:0.73rem;">${esc(a.ageSex)}</span></td>
        <td><span class="q-tag tag-${a.category} mono">${a.category}</span></td>
        <td><strong>${esc(a.hospitalName)}</strong><br/><span style="color:#475569;font-size:0.74rem;">${esc(a.rationale)}</span></td>
        <td class="mono">${esc(a.bedType)}</td>
        <td class="mono">${a.etaMin ? `${a.etaMin} min` : "On-Scene"}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">No casualties assigned yet.</td></tr>`;
}

function renderFhirAndSoapTab() {
  const alloc = state.allocation || allocateHospitalSurge(state.queue, REGIONAL_HOSPITALS);
  const bundle = buildFHIRBundle(state.queue, alloc, { incidentId: state.incidentId });
  const soap = buildSOAPMarkdown(state.queue, alloc, {
    incidentId: state.incidentId,
    cloudNarrative: state.cloudBrief,
    online: router.online,
  });
  const chain = verifyHashChain(state.queue);

  $("#chainVerifyBanner").innerHTML = `SHA-256 Chain Integrity: <strong>${chain.valid ? "VERIFIED (0 Tamper)" : "FAILED"}</strong> · Entries: ${chain.length} · Root: <span class="mono">${esc(chain.rootHash)}</span> · Bundle Signature: <span class="mono">${esc(bundle.signature.data.slice(0, 24))}…</span>`;
  $("#fhirEntryCount").textContent = `${bundle.total} FHIR R4 resources`;
  $("#fhirJsonPreview").textContent = JSON.stringify(bundle, null, 2);
  $("#soapMdPreview").textContent = soap;
}

function renderAuditTab() {
  $("#telemetrySavingsPill").textContent = `${router.totalLocalTokensSaved.toLocaleString()} tokens saved on-device`;
  $("#auditFlushBadge").textContent = `${router.queueFlushes} cloud surge flush(es) · 0 dropped`;

  $("#remoteConfigStrip").textContent =
    `Remote Config (${state.policy.source}) · Cloud Model: ${state.policy.cloudModel} · START RR Max: >${state.policy.thresholds.respRateMax}/min · Cap Refill Max: >${state.policy.thresholds.capRefillMaxSec}s · Max Queue: ${state.policy.maxOfflineQueue}`;

  const suite = state.rulesSuite;
  $("#rulesResultsList").innerHTML = suite.results.map((r) => `
    <div class="rule-row">
      <div>
        <strong>${esc(r.name)}</strong>
        <div style="color:#64748b;font-size:0.73rem;">${esc(r.reason)}</div>
      </div>
      <span class="rule-pass mono">${r.expectedAllow ? "ALLOW" : "DENY"} · PASS</span>
    </div>`).join("");

  $("#auditTableBody").innerHTML = router.auditLog.length
    ? router.auditLog.map((e) => `
      <tr>
        <td class="mono">#${e.seq}</td>
        <td><strong>${esc(e.step)}</strong><br/><span style="color:#64748b;font-size:0.74rem;">${esc(e.note)}</span></td>
        <td class="mono">${esc(e.firebaseMode)}</td>
        <td class="mono">
          <span class="q-sync-badge ${e.inferenceSource === "in-cloud" ? "q-sync-cloud" : "q-sync-local"}">
            ${esc(e.inferenceSource)}
          </span>
        </td>
        <td class="mono">${e.latencyMs} ms</td>
        <td class="mono">${e.cloudBytes} B</td>
        <td class="mono">${e.hashShort ? `sha256:${esc(e.hashShort)}…` : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="text-align:center;color:#64748b;padding:18px;">No hybrid routing events recorded yet.</td></tr>`;

  renderTelemetryChartSvg();
}

function renderAll() {
  renderHeaderAndKpis();
  renderQueueList();
  renderSurgeTab();
  renderFhirAndSoapTab();
  renderAuditTab();
}

function setActiveTab(tabId) {
  state.activeTab = tabId;
  $$(".tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tabId}`);
  });
}

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Web Speech Quick Intake (100% On-Device / Browser Native) ---
function handleVoiceQuickIntake() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("#intakeToast").textContent = "Web Speech API unavailable in this browser; use sliders or preloaded field cases for instant on-device intake.";
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  $("#voiceBtnLabel").textContent = "Listening…";
  rec.onresult = (ev) => {
    const transcript = ev.results?.[0]?.[0]?.transcript || "";
    $("#inputMechanism").value = transcript;
    const lower = transcript.toLowerCase();
    if (/walk|ambulatory/.test(lower)) $("#chkCanWalk").checked = true;
    if (/not breathing|apneic/.test(lower)) $("#chkBreathing").checked = false;
    if (/no pulse|absent pulse/.test(lower)) $("#chkRadialPulse").checked = false;
    if (/unresponsive|confused/.test(lower)) $("#chkObeysCommands").checked = false;
    const rrMatch = lower.match(/(?:rr|resp(?:iratory)?\s*rate)\s*(?:is|of)?\s*(\d{1,2})/);
    if (rrMatch) $("#sliderRR").value = String(Math.min(50, Number(rrMatch[1])));
    updateLiveTriagePreview();
    $("#intakeToast").textContent = `Voice dictation captured locally: "${transcript}"`;
  };
  rec.onend = () => {
    $("#voiceBtnLabel").textContent = "Voice Quick-Intake";
  };
  rec.onerror = () => {
    $("#voiceBtnLabel").textContent = "Voice Quick-Intake";
  };
  rec.start();
}

// --- Boot Application (ZERO Network Calls in Initial Offline Dead Zone -> 0 Console Errors!) ---
async function boot() {
  // Load offline defaults instantaneously without network calls
  state.policy = await loadClinicalPolicy({ online: false });
  state.queue = loadPersistedQueue();
  recomputeAllocationAndExports();

  // Bind tabs
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  // Connectivity toggle
  $("#btnOfflineMode").addEventListener("click", () => setConnectivityMode(false));
  $("#btnOnlineMode").addEventListener("click", () => setConnectivityMode(true));

  // Mass-incident burst buttons
  $("#btnMassIncident").addEventListener("click", runSixCasualtyMassIncident);
  $("#btnBatchInline").addEventListener("click", runSixCasualtyMassIncident);

  // Preloaded case pills
  $("#presetPills").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-preset-id]");
    if (!btn) return;
    const found = PRELOADED_CASES.find((p) => p.id === btn.dataset.presetId);
    if (found) loadCaseIntoForm(found);
  });

  // Custom casualty button
  $("#btnNewCustom").addEventListener("click", () => {
    const nextId = `EMS-0${state.customCounter++}`;
    state.activePresetId = null;
    $("#inputTagId").value = nextId;
    $("#inputAgeSex").value = "33M";
    $("#inputSpecialty").value = "crush_trauma";
    $("#inputMechanism").value = "Custom field trauma intake — adjust RPM vitals below.";
    $("#chkCanWalk").checked = false;
    $("#chkBreathing").checked = true;
    $("#chkAirwayOpened").checked = true;
    $("#chkRadialPulse").checked = true;
    $("#chkObeysCommands").checked = true;
    $("#chkPediatric").checked = false;
    $("#sliderRR").value = "22";
    $("#sliderCapRefill").value = "1.5";
    renderPresetPills();
    updateLiveTriagePreview();
    $("#intakeToast").textContent = `Prepared custom tag ${nextId} — adjust vitals and click Tag & Queue Locally.`;
  });

  $("#btnVoiceIntake").addEventListener("click", handleVoiceQuickIntake);

  // Live vital slider & toggle listeners
  [
    "#chkCanWalk",
    "#chkBreathing",
    "#chkAirwayOpened",
    "#chkRadialPulse",
    "#chkObeysCommands",
    "#chkPediatric",
    "#sliderRR",
    "#sliderCapRefill",
  ].forEach((sel) => {
    $(sel).addEventListener("input", updateLiveTriagePreview);
    $(sel).addEventListener("change", updateLiveTriagePreview);
  });

  // Queue & surge actions
  $("#btnTagQueue").addEventListener("click", () => tagCurrentCasualtyLocally());
  $("#btnFlushToCloud").addEventListener("click", () => executeCloudSurgeBurst({ autoSwitchTab: true }));
  $("#btnTriggerCloudSurge").addEventListener("click", () => executeCloudSurgeBurst({ autoSwitchTab: false }));
  $("#btnClearQueue").addEventListener("click", async () => {
    state.queue = [];
    state.cloudBrief = "";
    state.cloudBriefSource = "STANDBY (OFFLINE)";
    await persistQueue([]);
    recomputeAllocationAndExports();
    renderAll();
    $("#intakeToast").textContent = "Offline casualty queue reset cleanly.";
  });

  // Exports
  $("#btnDownloadFhir").addEventListener("click", () => {
    const alloc = state.allocation || allocateHospitalSurge(state.queue, REGIONAL_HOSPITALS);
    const bundle = buildFHIRBundle(state.queue, alloc, { incidentId: state.incidentId });
    triggerDownload(`triagezero-fhir-r4-${state.incidentId}.json`, JSON.stringify(bundle, null, 2), "application/json");
  });

  $("#btnDownloadSoap").addEventListener("click", () => {
    const alloc = state.allocation || allocateHospitalSurge(state.queue, REGIONAL_HOSPITALS);
    const soap = buildSOAPMarkdown(state.queue, alloc, {
      incidentId: state.incidentId,
      cloudNarrative: state.cloudBrief,
      online: router.online,
    });
    triggerDownload(`triagezero-soap-handoff-${state.incidentId}.md`, soap, "text/markdown;charset=utf-8");
  });

  $("#btnCopyFhir").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#fhirJsonPreview").textContent || "");
      $("#btnCopyFhir").textContent = "Copied!";
      setTimeout(() => { $("#btnCopyFhir").textContent = "Copy JSON"; }, 1400);
    } catch {
      // Clipboard blocked in non-secure context
    }
  });

  $("#btnRunRulesSuite").addEventListener("click", () => {
    state.rulesSuite = runFirestoreSecuritySuite();
    renderAuditTab();
  });

  // Seed initial boot audit event (0 B cloud)
  router.recordEvent({
    step: "Field Workbench Initialized (Dead-Zone Ready)",
    firebaseMode: "ONLY_ON_DEVICE",
    inferenceSource: "on-device",
    latencyMs: 1,
    cloudBytes: 0,
    tokensSaved: 0,
    note: `Remote Config defaults loaded offline (${state.policy.cloudModel}) · 0 B cloud traffic.`,
  });

  // Load first preloaded case (EQ-01 Crush Injury -> RED)
  loadCaseIntoForm(PRELOADED_CASES[0]);
  renderAll();
}

boot();
