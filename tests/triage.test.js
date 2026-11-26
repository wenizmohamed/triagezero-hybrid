import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_THRESHOLDS,
  PROTOCOL_VERSION,
  PRELOADED_CASES,
  EXTRA_BATCH_CASE,
  REGIONAL_HOSPITALS,
  GENESIS_HASH,
  evaluateSTART,
  sha256Hex,
  appendToHashChain,
  verifyHashChain,
  HybridConnectivityRouter,
  allocateHospitalSurge,
  buildFHIRBundle,
  buildSOAPMarkdown,
  buildDispatchReceipt,
  evaluateTriageFirestoreRule,
  runFirestoreSecuritySuite,
} from "../src/triage-core.js";

describe("1. START Clinical Triage Protocol Decision Boundaries", () => {
  it("classifies ambulatory patients as MINOR GREEN immediately", () => {
    const res = evaluateSTART({
      canWalk: true,
      breathing: true,
      airwayOpenedBreathing: true,
      respRate: 18,
      capRefillSec: 1.0,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("GREEN");
    expect(res.label).toBe("MINOR");
    expect(res.priority).toBe(3);
    expect(res.decisionPath).toContain("node_green");
  });

  it("classifies walking wounded as GREEN even if vitals are elevated (START step 1 short-circuit)", () => {
    const res = evaluateSTART({
      canWalk: true,
      breathing: true,
      respRate: 32,
      capRefillSec: 2.5,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("GREEN");
  });

  it("classifies apneic patients who remain apneic after airway opening as EXPECTANT BLACK", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: false,
      airwayOpenedBreathing: false,
      respRate: 0,
      capRefillSec: 5.0,
      radialPulse: false,
      obeysCommands: false,
    });
    expect(res.category).toBe("BLACK");
    expect(res.label).toBe("EXPECTANT");
    expect(res.priority).toBe(4);
    expect(res.decisionPath).toEqual([
      "node_walk", "edge_walk_no", "node_breath", "edge_breath_no", "node_airway", "edge_airway_no", "node_black",
    ]);
  });

  it("classifies initially apneic patients who resume breathing after jaw-thrust as IMMEDIATE RED", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: false,
      airwayOpenedBreathing: true,
      respRate: 14,
      capRefillSec: 1.5,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("RED");
    expect(res.decisionPath).toContain("edge_airway_yes");
  });

  it("classifies RR = 31 (> 30 threshold) as IMMEDIATE RED", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: true,
      respRate: 31,
      capRefillSec: 1.5,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("RED");
    expect(res.decisionPath).toContain("edge_rr_high");
  });

  it("accepts boundary RR = 30 (<= 30) as passing respiration check -> YELLOW if perfusion & mental OK", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: true,
      respRate: 30,
      capRefillSec: 2.0,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("YELLOW");
    expect(res.decisionPath).toContain("node_yellow");
  });

  it("classifies capillary refill 2.5s (> 2.0s threshold) as IMMEDIATE RED", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: true,
      respRate: 22,
      capRefillSec: 2.5,
      radialPulse: true,
      obeysCommands: true,
    });
    expect(res.category).toBe("RED");
    expect(res.decisionPath).toContain("edge_perf_fail");
  });

  it("classifies absent radial pulse (even with cap refill <= 2.0s) as IMMEDIATE RED", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: true,
      respRate: 20,
      capRefillSec: 1.5,
      radialPulse: false,
      obeysCommands: true,
    });
    expect(res.category).toBe("RED");
    expect(res.reason).toMatch(/absent radial pulse/i);
  });

  it("classifies inability to obey simple commands (stable R & P) as IMMEDIATE RED", () => {
    const res = evaluateSTART({
      canWalk: false,
      breathing: true,
      respRate: 24,
      capRefillSec: 1.5,
      radialPulse: true,
      obeysCommands: false,
    });
    expect(res.category).toBe("RED");
    expect(res.decisionPath).toContain("edge_mental_no");
  });

  it("honors dynamic Firebase Remote Config custom thresholds (e.g. pediatric RR max = 40)", () => {
    const res = evaluateSTART(
      {
        canWalk: false,
        breathing: true,
        respRate: 35,
        capRefillSec: 1.5,
        radialPulse: true,
        obeysCommands: true,
      },
      { respRateMax: 40, capRefillMaxSec: 2.0 }
    );
    expect(res.category).toBe("YELLOW");
    expect(res.thresholdsUsed.respRateMax).toBe(40);
  });

  it("computes Shock Index accurately when HR and SBP are supplied", () => {
    const res = evaluateSTART(PRELOADED_CASES[0].vitals);
    expect(res.shockIndex).toBeCloseTo(132 / 82, 2);
  });

  it("evaluates all 5 preloaded EMS cases + 6th mass-incident case to expected START categories", () => {
    const allSix = [...PRELOADED_CASES, EXTRA_BATCH_CASE];
    const cats = allSix.map((c) => evaluateSTART(c.vitals).category);
    expect(cats).toEqual(["RED", "RED", "YELLOW", "GREEN", "BLACK", "RED"]);
  });
});

describe("2. SHA-256 Cryptographic Offline Hash Chain", () => {
  it("matches NIST FIPS 180-4 SHA-256 test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches SHA-256 test vector for empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("links sequential offline casualties cleanly from GENESIS_HASH and verifies true", () => {
    let chain = [];
    for (const c of PRELOADED_CASES) {
      const rec = appendToHashChain(chain, {
        ...c,
        triage: evaluateSTART(c.vitals),
        taggedAt: "2026-11-21T12:00:00.000Z",
        inferenceSource: "on-device",
      });
      chain.push(rec);
    }
    expect(chain[0].prevHash).toBe(GENESIS_HASH);
    expect(chain[1].prevHash).toBe(chain[0].entryHash);
    const v = verifyHashChain(chain);
    expect(v.valid).toBe(true);
    expect(v.length).toBe(5);
    expect(v.rootHash).toBe(chain[4].entryHash);
  });

  it("detects silent tampering on a single casualty START category in the offline queue", () => {
    let chain = [];
    for (const c of PRELOADED_CASES.slice(0, 3)) {
      chain.push(
        appendToHashChain(chain, {
          ...c,
          triage: evaluateSTART(c.vitals),
          taggedAt: "2026-11-21T12:00:00.000Z",
          inferenceSource: "on-device",
        })
      );
    }
    // Mutate item 1 category without recomputing chain
    const tampered = chain.map((item, idx) =>
      idx === 1 ? { ...item, triage: { ...item.triage, category: "GREEN" } } : item
    );
    const v = verifyHashChain(tampered);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it("detects broken prevHash pointer tampering", () => {
    const c = PRELOADED_CASES[0];
    const first = appendToHashChain([], {
      ...c,
      triage: evaluateSTART(c.vitals),
      taggedAt: "2026-11-21T12:00:00.000Z",
      inferenceSource: "on-device",
    });
    const broken = [{ ...first, prevHash: "f".repeat(64) }];
    expect(verifyHashChain(broken).valid).toBe(false);
  });
});

describe("3. Offline-to-Online Hybrid Connectivity State Machine", () => {
  it("starts in OFFLINE_DEAD_ZONE enforcing ONLY_ON_DEVICE and cloudAllowed=false", () => {
    const r = new HybridConnectivityRouter(false);
    const desc = r.getRouteDescriptor();
    expect(desc.state).toBe("OFFLINE_DEAD_ZONE");
    expect(desc.firebaseMode).toBe("ONLY_ON_DEVICE");
    expect(desc.inferenceSource).toBe("on-device");
    expect(desc.cloudAllowed).toBe(false);
  });

  it("throws HYBRID_BOUNDARY_VIOLATION if any cloudBytes > 0 are logged while offline", () => {
    const r = new HybridConnectivityRouter(false);
    expect(() =>
      r.recordEvent({
        step: "Illegal leak attempt",
        firebaseMode: "ONLY_IN_CLOUD",
        inferenceSource: "in-cloud",
        cloudBytes: 128,
      })
    ).toThrow(/HYBRID_BOUNDARY_VIOLATION/);
  });

  it("transitions cleanly to ONLINE_RESTORED (ONLY_IN_CLOUD) and logs transition event", () => {
    const r = new HybridConnectivityRouter(false);
    const next = r.setConnectivity(true);
    expect(next.state).toBe("ONLINE_RESTORED");
    expect(next.firebaseMode).toBe("ONLY_IN_CLOUD");
    expect(next.cloudAllowed).toBe(true);
    expect(r.auditLog.length).toBe(1);
    expect(r.auditLog[0].step).toMatch(/Connectivity Restored/i);
  });

  it("accumulates local token savings while offline and cloud bytes only after restore", () => {
    const r = new HybridConnectivityRouter(false);
    r.recordEvent({ step: "Tag 1", firebaseMode: "ONLY_ON_DEVICE", inferenceSource: "on-device", cloudBytes: 0, tokensSaved: 340 });
    r.recordEvent({ step: "Tag 2", firebaseMode: "ONLY_ON_DEVICE", inferenceSource: "on-device", cloudBytes: 0, tokensSaved: 340 });
    expect(r.totalCloudBytes).toBe(0);
    expect(r.totalLocalTokensSaved).toBe(680);

    r.setConnectivity(true);
    r.recordEvent({ step: "Surge Burst", firebaseMode: "ONLY_IN_CLOUD", inferenceSource: "in-cloud", cloudBytes: 1200, cloudTokens: 315 });
    expect(r.totalCloudBytes).toBe(1200);
    expect(r.totalCloudTokens).toBe(315);
  });
});

describe("4. Multi-Casualty Hospital Surge Allocation & Diversion Math", () => {
  const buildSixBatch = () => {
    const chain = [];
    for (const c of [...PRELOADED_CASES, EXTRA_BATCH_CASE]) {
      chain.push(
        appendToHashChain(chain, {
          ...c,
          triage: evaluateSTART(c.vitals),
          taggedAt: "2026-11-21T12:05:00.000Z",
          inferenceSource: "on-device",
        })
      );
    }
    return chain;
  };

  it("allocates all 6 mass-incident casualties in strict acuity order (RED -> YELLOW -> GREEN -> BLACK)", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    expect(alloc.totalCasualties).toBe(6);
    expect(alloc.counts).toEqual({ RED: 3, YELLOW: 1, GREEN: 1, BLACK: 1 });
    expect(alloc.assignments.map((a) => a.category)).toEqual([
      "RED", "RED", "RED", "YELLOW", "GREEN", "BLACK",
    ]);
  });

  it("routes pediatric RED (HWY-02) specifically to St. Jude Pediatric Level-1", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    const ped = alloc.assignments.find((a) => a.casualtyId === "HWY-02");
    expect(ped.hospitalId).toBe("HOSP-STJUDE-PED");
    expect(ped.bedType).toMatch(/Pediatric Level-1/i);
  });

  it("routes crush RED (EQ-01) and airway RED (MVA-06) to Metro Level-1 and triggers 100% trauma-bay diversion alert", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    const metro = alloc.hospitals.find((h) => h.id === "HOSP-METRO-L1");
    expect(metro.traumaBaysUsed).toBe(2);
    expect(metro.traumaUtilizationPct).toBe(100);
    expect(metro.diversionActive).toBe(true);
    expect(alloc.diversionAlerts.some((d) => d.includes("Metro Level-1 Trauma Center"))).toBe(true);
  });

  it("routes smoke inhalation YELLOW (SMK-03) to Harbor Burn & Trauma Level-2", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    const smk = alloc.assignments.find((a) => a.casualtyId === "SMK-03");
    expect(smk.hospitalId).toBe("HOSP-HARBOR-L2");
    expect(smk.bedType).toMatch(/Burn/i);
  });

  it("routes walking wounded GREEN (WLK-04) to Valley Community Level-3 to protect Level-1 bays", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    const wlk = alloc.assignments.find((a) => a.casualtyId === "WLK-04");
    expect(wlk.hospitalId).toBe("HOSP-VALLEY-L3");
  });

  it("keeps EXPECTANT BLACK (APN-05) at On-Scene Staging without consuming any trauma bay", () => {
    const alloc = allocateHospitalSurge(buildSixBatch(), REGIONAL_HOSPITALS);
    const blk = alloc.assignments.find((a) => a.casualtyId === "APN-05");
    expect(blk.hospitalId).toBe("ON-SCENE-STAGING");
    expect(blk.etaMin).toBe(0);
  });

  it("triggers overflow diversion to Level-2 when 5 adult RED casualties exceed Level-1 bays", () => {
    const fiveReds = Array.from({ length: 5 }, (_, i) => ({
      ...PRELOADED_CASES[0],
      id: `RED-0${i + 1}`,
      pediatric: false,
      triage: evaluateSTART(PRELOADED_CASES[0].vitals),
    }));
    const alloc = allocateHospitalSurge(fiveReds, REGIONAL_HOSPITALS);
    expect(alloc.diversionAlerts.some((d) => /TRAUMA DIVERSION/i.test(d))).toBe(true);
    const l2Count = alloc.assignments.filter((a) => a.hospitalId === "HOSP-HARBOR-L2").length;
    expect(l2Count).toBeGreaterThanOrEqual(1);
  });
});

describe("5. HL7 FHIR R4 Bundle & Clinical SOAP Handoff", () => {
  const sampleQueue = (() => {
    const q = [];
    for (const c of PRELOADED_CASES.slice(0, 3)) {
      q.push(
        appendToHashChain(q, {
          ...c,
          triage: evaluateSTART(c.vitals),
          taggedAt: "2026-11-21T12:10:00.000Z",
          inferenceSource: "on-device",
          synced: true,
        })
      );
    }
    return q;
  })();

  it("generates a valid HL7 FHIR R4 Bundle with Patient, LOINC Observation, and Communication resources", () => {
    const alloc = allocateHospitalSurge(sampleQueue, REGIONAL_HOSPITALS);
    const bundle = buildFHIRBundle(sampleQueue, alloc, {
      incidentId: "INC-TEST-01",
      generatedAt: "2026-11-21T12:15:00.000Z",
    });

    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
    expect(bundle.id).toBe("INC-TEST-01");
    expect(bundle.total).toBe(9); // 3 casualties x (Patient + Observation + Communication)
    expect(bundle.entry.filter((e) => e.resource.resourceType === "Patient").length).toBe(3);
    expect(bundle.entry.filter((e) => e.resource.resourceType === "Observation").length).toBe(3);
    expect(bundle.entry.filter((e) => e.resource.resourceType === "Communication").length).toBe(3);
  });

  it("encodes canonical LOINC codes (75636-1 START, 9279-1 RR, 44963-7 Cap Refill) and 64-hex SHA-256 signature", () => {
    const alloc = allocateHospitalSurge(sampleQueue, REGIONAL_HOSPITALS);
    const bundle = buildFHIRBundle(sampleQueue, alloc, { incidentId: "INC-LOINC-01" });
    const obs = bundle.entry.find((e) => e.resource.resourceType === "Observation").resource;
    expect(obs.code.coding[0].code).toBe("75636-1");
    const compCodes = obs.component.map((c) => c.code.coding[0].code);
    expect(compCodes).toContain("9279-1");
    expect(compCodes).toContain("44963-7");
    expect(bundle.signature.data).toMatch(/^[a-f0-9]{64}$/);
  });

  it("renders complete Clinical SOAP Markdown including S/O/A/P sections and SHA-256 chain root", () => {
    const alloc = allocateHospitalSurge(sampleQueue, REGIONAL_HOSPITALS);
    const md = buildSOAPMarkdown(sampleQueue, alloc, { incidentId: "INC-SOAP-01", online: true });
    expect(md).toContain("# TriageZero Clinical SOAP & Hospital Surge Handoff");
    expect(md).toContain("INC-SOAP-01");
    expect(md).toContain("**S (Subjective / Mechanism):**");
    expect(md).toContain("**O (Objective Vitals):**");
    expect(md).toContain("**A (Assessment):**");
    expect(md).toContain("**P (Plan & Dispatch):**");
    expect(md).toContain("VERIFIED");
  });
});

describe("6. Hardened firestore.rules Zero-PHI Enforcement & Repo Hygiene", () => {
  it("passes all 6 built-in Firestore security vectors", () => {
    const suite = runFirestoreSecuritySuite();
    expect(suite.total).toBe(6);
    expect(suite.passed).toBe(6);
    expect(suite.allPassed).toBe(true);
  });

  it("allows a validly constructed buildDispatchReceipt payload", () => {
    const q = [
      appendToHashChain([], {
        ...PRELOADED_CASES[0],
        triage: evaluateSTART(PRELOADED_CASES[0].vitals),
        taggedAt: "2026-11-21T12:00:00.000Z",
        inferenceSource: "on-device",
      }),
    ];
    const alloc = allocateHospitalSurge(q, REGIONAL_HOSPITALS);
    const receipt = buildDispatchReceipt({
      incidentId: "INC-TZ26-001",
      allocation: alloc,
      inferenceSource: "hybrid_burst",
      offlineQueueFlushed: 1,
      cloudBytesSent: 420,
      chainRootSha256: q[0].entryHash,
    });
    const res = evaluateTriageFirestoreRule({
      operation: "create",
      data: { ...receipt, at: "__serverTimestamp__" },
      hasServerTime: true,
    });
    expect(res.allowed).toBe(true);
  });

  it("rejects unauthorized session path prefixes", () => {
    const res = evaluateTriageFirestoreRule({
      operation: "create",
      sessionId: "evil_user_123",
      data: {},
    });
    expect(res.allowed).toBe(false);
  });

  it("rejects mismatched protocolVersion", () => {
    const res = evaluateTriageFirestoreRule({
      operation: "create",
      data: {
        at: "__serverTimestamp__",
        incidentId: "INC-TZ26-001",
        protocolVersion: "FORGED-v1",
        counts: { RED: 1, YELLOW: 0, GREEN: 0, BLACK: 0 },
        totalCasualties: 1,
        inferenceSource: "on_device",
        offlineQueueFlushed: 1,
        cloudBytesSent: 0,
        hospitalTargetsCount: 1,
        chainRootSha256: "a".repeat(64),
      },
    });
    expect(res.allowed).toBe(false);
  });

  it("rejects receipt updates (append-only immutability)", () => {
    const res = evaluateTriageFirestoreRule({ operation: "update", data: {} });
    expect(res.allowed).toBe(false);
  });

  it("rejects missing server timestamp (data.at == request.time)", () => {
    const res = evaluateTriageFirestoreRule({
      operation: "create",
      hasServerTime: false,
      data: {
        at: "2026-01-01",
        incidentId: "INC-TZ26-001",
        protocolVersion: PROTOCOL_VERSION,
        counts: { RED: 1, YELLOW: 0, GREEN: 0, BLACK: 0 },
        totalCasualties: 1,
        inferenceSource: "on_device",
        offlineQueueFlushed: 1,
        cloudBytesSent: 0,
        hospitalTargetsCount: 1,
        chainRootSha256: "a".repeat(64),
      },
    });
    expect(res.allowed).toBe(false);
  });

  it("verifies firestore.rules file on disk contains strict schema keys and catch-all deny", () => {
    const rulesPath = path.resolve(process.cwd(), "firestore.rules");
    const content = fs.readFileSync(rulesPath, "utf-8");
    expect(content).toContain("rules_version = '2';");
    expect(content).toContain("validDispatchReceipt(data)");
    expect(content).toContain("allow update, delete: if false;");
    expect(content).toContain("match /{document=**}");
    expect(content).toContain("allow read, write: if false;");
  });

  it("verifies remoteconfig.template.json declares gemini-3.5-flash-lite and START clinical thresholds", () => {
    const rcPath = path.resolve(process.cwd(), "remoteconfig.template.json");
    const json = JSON.parse(fs.readFileSync(rcPath, "utf8"));
    expect(json.parameters.triage_cloud_model.defaultValue.value).toBe("gemini-3.5-flash-lite");
    expect(Number(json.parameters.start_resp_rate_max.defaultValue.value)).toBe(DEFAULT_THRESHOLDS.respRateMax);
    expect(Number(json.parameters.start_cap_refill_max_sec.defaultValue.value)).toBe(DEFAULT_THRESHOLDS.capRefillMaxSec);
  });

  it("verifies firestore.rules defines zero-PHI cross-platform incident relay and README points to #BuildHybridAI", () => {
    const rulesContent = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf-8");
    expect(rulesContent).toContain("validFieldTag(data)");
    expect(rulesContent).toContain("/incidents/{incidentId}/casualties/{tagId}");
    const readme = fs.readFileSync(path.resolve(process.cwd(), "README.md"), "utf-8");
    expect(readme).toContain("https://firebasehybridaihackathon.devpost.com/");
    expect(readme).not.toContain("https://buildhybridai.devpost.com/");
  });
});
