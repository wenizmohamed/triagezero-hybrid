// Firebase AI Logic Hybrid Inference, Remote Config, Lazy App Check, and Zero-PHI Firestore Receipts
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
} from "firebase/ai";
import { getRemoteConfig, fetchAndActivate, getValue } from "firebase/remote-config";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
} from "firebase/firestore";
import { firebaseConfig, recaptchaSiteKey } from "./firebase-config.js";
import { TRIAGE_NANO_SCHEMA, CLOUD_SURGE_SYSTEM, DEFAULT_THRESHOLDS } from "./triage-core.js";

export { InferenceMode, InferenceSource };

const app = initializeApp(firebaseConfig);
const ai = getAI(app, { backend: new GoogleAIBackend() });
const db = getFirestore(app);
const rc = getRemoteConfig(app);

rc.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
rc.defaultConfig = {
  triage_cloud_model: "gemini-4-hydrogen",
  start_resp_rate_max: DEFAULT_THRESHOLDS.respRateMax,
  start_cap_refill_max_sec: DEFAULT_THRESHOLDS.capRefillMaxSec,
  max_offline_queue: 200,
  prefer_on_device_intake: true,
};

// Lazy App Check: NEVER initializes during boot or offline dead-zone triage,
// guaranteeing 0 third-party network beacons and 0 boot-time 403 console errors.
let appCheckInitialized = false;
export function ensureAppCheck() {
  if (appCheckInitialized) return;
  appCheckInitialized = true;
  if (typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn("App Check lazy init skipped:", err?.message || err);
  }
}

export function getEmsSessionId() {
  const key = "triagezero_ems_session_id";
  try {
    let id = localStorage.getItem(key);
    if (!id || !/^ems_[0-9a-f-]{36}$/.test(id)) {
      const uuid = (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "00000000-0000-4000-8000-000000000000"
      ).toLowerCase();
      id = `ems_${uuid}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "ems_00000000-0000-4000-8000-000000000000";
  }
}

/**
 * Loads clinical START thresholds and cloud model routing from Firebase Remote Config.
 * When offline (dead zone), resolves immediately from local defaultConfig with 0 network bytes.
 */
export async function loadClinicalPolicy({ online = false } = {}) {
  if (online) {
    try {
      await fetchAndActivate(rc);
    } catch (err) {
      console.warn("Remote Config fetch skipped; using embedded clinical thresholds:", err?.message || err);
    }
  }
  const respRateMax = Number(getValue(rc, "start_resp_rate_max").asNumber()) || DEFAULT_THRESHOLDS.respRateMax;
  const capRefillMaxSec = Number(getValue(rc, "start_cap_refill_max_sec").asNumber()) || DEFAULT_THRESHOLDS.capRefillMaxSec;
  return {
    cloudModel: getValue(rc, "triage_cloud_model").asString() || "gemini-4-hydrogen",
    thresholds: {
      respRateMax,
      capRefillMaxSec,
    },
    maxOfflineQueue: Number(getValue(rc, "max_offline_queue").asNumber()) || 200,
    preferOnDeviceIntake: getValue(rc, "prefer_on_device_intake").asBoolean(),
    source: online ? getValue(rc, "triage_cloud_model").getSource() : "default_offline",
  };
}

export const CLOUD_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/**
 * Strictly on-device Chrome Built-in AI (Gemini Nano) triage extractor.
 * Never transmits casualty data to the cloud; zero internet required in dead zones.
 */
export function onDeviceTriageModel() {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        temperature: 0.1,
        topK: 1,
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
      promptOptions: {
        responseConstraint: TRIAGE_NANO_SCHEMA,
      },
    },
  });
}

/**
 * Strictly in-cloud Firebase AI Logic model (gemini-4-hydrogen) invoked ONLY when
 * cellular/Starlink connectivity returns to synthesize Multi-Casualty Hospital Surge Allocation
 * and Clinical SOAP handoff narratives. Uses 4096 maxOutputTokens so Gemini 4 thinking never truncates output.
 */
export function cloudSurgeModel(policy, { withAppCheck = true, modelOverride = null } = {}) {
  if (withAppCheck) ensureAppCheck();
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: modelOverride || policy?.cloudModel || "gemini-4-hydrogen",
      systemInstruction: CLOUD_SURGE_SYSTEM,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    },
  });
}

function isTransientSurgeError(err) {
  const msg = String(err?.message || err || "");
  return /\b(500|502|503|429)\b|high demand|temporarily|unavailable|INTERNAL|fetch-error|cloud_timeout|empty_response|network/i.test(msg);
}

async function runTimedSurgeAttempt(policy, prompt, modelName, timeoutMs) {
  const model = cloudSurgeModel(policy, { modelOverride: modelName });
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("cloud_timeout")), timeoutMs));
  const res = await Promise.race([model.generateContent(prompt), timeoutPromise]);
  const text = (res?.response?.text?.() || "").trim();
  if (text.length <= 40) {
    throw new Error("empty_response");
  }
  return { text, modelUsed: modelName };
}

/**
 * Invokes Firebase AI Logic ONLY_IN_CLOUD surge synthesis with automatic retry and
 * seamless Spark-safe failover to Flash-Lite if primary Gemini 4 Hydrogen sees transient high demand.
 */
export async function generateSurgeBriefWithResilience(policy, prompt, { timeoutMs = 22000 } = {}) {
  const primary = policy?.cloudModel || "gemini-4-hydrogen";
  try {
    const out = await runTimedSurgeAttempt(policy, prompt, primary, timeoutMs);
    return { ...out, failedOver: false };
  } catch (firstErr) {
    if (!isTransientSurgeError(firstErr)) throw firstErr;
    await new Promise((r) => setTimeout(r, 550));
    try {
      const out = await runTimedSurgeAttempt(policy, prompt, primary, timeoutMs);
      return { ...out, failedOver: false };
    } catch (secondErr) {
      if (!isTransientSurgeError(secondErr) || primary === CLOUD_FALLBACK_MODEL) {
        throw secondErr;
      }
      const out = await runTimedSurgeAttempt(policy, prompt, CLOUD_FALLBACK_MODEL, timeoutMs);
      return { ...out, failedOver: true };
    }
  }
}

/**
 * Automatic hybrid failover model (PREFER_ON_DEVICE) for adaptive diagnostics.
 */
export function adaptiveHybridModel(policy) {
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: policy?.cloudModel || "gemini-4-hydrogen",
      systemInstruction: CLOUD_SURGE_SYSTEM,
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    },
    onDeviceParams: {
      createOptions: {
        temperature: 0.1,
        topK: 1,
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });
}

function receiptCollection(sessionId) {
  return collection(db, "sessions", sessionId, "dispatch_receipts");
}

/**
 * Persists a strictly zero-PHI dispatch receipt to Cloud Firestore.
 * Enforced server-side by firestore.rules (no names, no notes, only counts + SHA-256 chain root).
 */
export async function saveDispatchReceipt(sessionId, receipt) {
  return addDoc(receiptCollection(sessionId), {
    ...receipt,
    at: serverTimestamp(),
  });
}

export async function loadDispatchReceipts(sessionId) {
  const snap = await getDocs(
    query(receiptCollection(sessionId), orderBy("at", "desc"), limit(10))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Publishes a strictly zero-PHI START triage tag to the shared Cross-Platform Incident Relay
 * so Android Field responders and Chrome ER Web dispatchers stay synchronized in real time.
 */
export async function publishFieldTag(incidentId, casualty) {
  if (!incidentId || !casualty?.id) return;
  const tagRef = doc(db, "incidents", incidentId, "casualties", casualty.id);
  const v = casualty.vitals || {};
  return setDoc(tagRef, {
    id: casualty.id,
    ageSex: String(casualty.ageSex || "Adult").slice(0, 16),
    pediatric: Boolean(casualty.pediatric),
    specialtyNeed: String(casualty.specialtyNeed || "general_trauma").slice(0, 32),
    category: casualty.triage?.category || "YELLOW",
    priority: Number(casualty.triage?.priority || 2),
    respRate: Number(v.respRate ?? 18),
    capRefillSec: Number(v.capRefillSec ?? 1.5),
    radialPulse: Boolean(v.radialPulse),
    obeysCommands: Boolean(v.obeysCommands),
    canWalk: Boolean(v.canWalk),
    breathing: Boolean(v.breathing),
    airwayOpenedBreathing: Boolean(v.airwayOpenedBreathing),
    inferenceSource: casualty.inferenceSource === "in-cloud" ? "in_cloud" : "on_device",
    entryHash: casualty.entryHash,
    platform: casualty.platform === "android" ? "android" : "web",
    at: serverTimestamp(),
  });
}

/**
 * Subscribes live to zero-PHI field tags arriving from mobile Android responders or web units.
 */
export function subscribeIncidentCasualties(incidentId, onUpdate) {
  const q = query(collection(db, "incidents", incidentId, "casualties"), orderBy("at", "desc"), limit(30));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => d.data());
      onUpdate(rows);
    },
    (err) => {
      console.warn("Incident relay subscription standby:", err?.message || err);
    }
  );
}
