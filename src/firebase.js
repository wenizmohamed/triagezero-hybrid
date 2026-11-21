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
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDocs,
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
  triage_cloud_model: "gemini-3.5-flash-lite",
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
    cloudModel: getValue(rc, "triage_cloud_model").asString() || "gemini-3.5-flash-lite",
    thresholds: {
      respRateMax,
      capRefillMaxSec,
    },
    maxOfflineQueue: Number(getValue(rc, "max_offline_queue").asNumber()) || 200,
    preferOnDeviceIntake: getValue(rc, "prefer_on_device_intake").asBoolean(),
    source: online ? getValue(rc, "triage_cloud_model").getSource() : "default_offline",
  };
}

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
      },
      promptOptions: {
        responseConstraint: TRIAGE_NANO_SCHEMA,
      },
    },
  });
}

/**
 * Strictly in-cloud Firebase AI Logic model (gemini-3.5-flash-lite) invoked ONLY when
 * cellular/Starlink connectivity returns to synthesize Multi-Casualty Hospital Surge Allocation
 * and Clinical SOAP handoff narratives.
 */
export function cloudSurgeModel(policy, { withAppCheck = false } = {}) {
  if (withAppCheck) ensureAppCheck();
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: policy?.cloudModel || "gemini-3.5-flash-lite",
      systemInstruction: CLOUD_SURGE_SYSTEM,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
      },
    },
  });
}

/**
 * Automatic hybrid failover model (PREFER_ON_DEVICE) for adaptive diagnostics.
 */
export function adaptiveHybridModel(policy) {
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: policy?.cloudModel || "gemini-3.5-flash-lite",
      systemInstruction: CLOUD_SURGE_SYSTEM,
      generationConfig: { temperature: 0.2 },
    },
    onDeviceParams: {
      createOptions: {
        temperature: 0.1,
        topK: 1,
        expectedInputs: [{ type: "text", languages: ["en"] }],
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
