let ws = null;
let connectPromise = null;
let connectionGeneration = 0;
let reconnectTimeout = null;
let heartbeatInterval = null;
let routeEnabled = true;
const ignoredFlowAuthorizationTabIds = new Set();
const activeFlowSubmitBridges = new Map();
const cancelledFlowSubmitRequestIds = new Set();
const queuedFlowSubmitMonitors = new Map();

const RECONNECT_ALARM_NAME = "flow2api-reconnect";
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;
const FLOW_ROOT_URL = "https://flow.google.com";
const FLOW_TAB_PATTERNS = [
    "https://flow.google.com/*",
    "https://labs.google/fx/*"
];
const FLOW_ACCESS_TOKEN_STORAGE_KEY = "flowAccessTokenSession";
const FLOW_REQUEST_AUTH_STORAGE_KEY = "flowRequestAuthObservation";
const FLOW_ACCESS_TOKEN_MAX_AGE_MS = 2 * 60 * 1000;
const FLOW_REQUEST_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const FLOW_API_ROOT_URL = "https://aisandbox-pa.googleapis.com/v1";
const FLOW_PROGRESS_POLL_INTERVAL_MS = 5000;
const FLOW_SUBMIT_HARD_TIMEOUT_PADDING_MS = 30000;

const DEFAULT_SETTINGS = {
    serverUrl: "ws://127.0.0.1:8000/captcha_ws",
    apiKey: "",
    routeKey: "",
    clientLabel: ""
};

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
            resolve({
                serverUrl: (stored.serverUrl || DEFAULT_SETTINGS.serverUrl).trim(),
                apiKey: (stored.apiKey || "").trim(),
                routeKey: (stored.routeKey || "").trim(),
                clientLabel: (stored.clientLabel || "").trim()
            });
        });
    });
}

function closeSocket() {
    connectionGeneration += 1;
    connectPromise = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    const socket = ws;
    ws = null;
    if (socket) {
        try {
            socket.close();
        } catch (e) {
            console.log("[Flow2API] Close socket error", e);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readSessionStorage(key) {
    return new Promise((resolve) => {
        chrome.storage.session.get(key, (stored) => {
            if (chrome.runtime.lastError) {
                resolve(undefined);
                return;
            }
            resolve(stored ? stored[key] : undefined);
        });
    });
}

function writeSessionStorage(value) {
    return new Promise((resolve) => {
        chrome.storage.session.set(value, () => resolve());
    });
}

function normalizeCapturedAccessToken(value) {
    const token = String(value || "").trim();
    // OAuth bearer tokens are opaque. RFC 6750 defines their transport
    // alphabet, but does not guarantee Google's historical "ya29." prefix.
    if (!token || token.length > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
        return "";
    }
    return token;
}

function accessTokenFromAuthorization(value) {
    const match = String(value || "").trim().match(/^Bearer\s+([^\s]+)$/i);
    return normalizeCapturedAccessToken(match && match[1]);
}

function normalizeFlowRequestAuthorization(value) {
    const authorization = String(value || "").trim();
    if (!authorization || authorization.length > 8192 || /[\r\n]/.test(authorization)) {
        return "";
    }
    if (accessTokenFromAuthorization(authorization)) {
        return authorization;
    }
    if (!/^(?:SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)\s+\S+/i.test(authorization)) {
        return "";
    }
    return authorization;
}

async function rememberFlowRequestAuthorization(
    authorization,
    capturedAt,
    authUser = "",
    apiKey = ""
) {
    const normalizedAuthorization = normalizeFlowRequestAuthorization(authorization);
    if (!normalizedAuthorization) return;
    const observedAuthUser = /^\d{1,3}$/.test(String(authUser || "").trim())
        ? String(authUser).trim()
        : "0";
    const observedApiKey = /^[A-Za-z0-9_-]{20,256}$/.test(String(apiKey || "").trim())
        ? String(apiKey).trim()
        : "";
    await writeSessionStorage({
        [FLOW_REQUEST_AUTH_STORAGE_KEY]: {
            authorization: normalizedAuthorization,
            auth_scheme: normalizedAuthorization.split(/\s+/, 1)[0].slice(0, 32),
            auth_user: observedAuthUser,
            api_key: observedApiKey,
            seen_at: Number(capturedAt || Date.now()),
        },
    });
}

async function getRecentFlowRequestAuthorization(notBefore = 0) {
    const captured = await readSessionStorage(FLOW_REQUEST_AUTH_STORAGE_KEY);
    const authorization = normalizeFlowRequestAuthorization(captured && captured.authorization);
    const capturedAt = Number(captured && captured.seen_at || 0);
    if (
        !authorization ||
        !capturedAt ||
        capturedAt < Number(notBefore || 0) ||
        Date.now() - capturedAt > FLOW_REQUEST_AUTH_MAX_AGE_MS
    ) {
        return null;
    }
    return {
        authorization,
        auth_scheme: authorization.split(/\s+/, 1)[0].slice(0, 32),
        auth_user: /^\d{1,3}$/.test(String(captured && captured.auth_user || ""))
            ? String(captured.auth_user)
            : "0",
        api_key: /^[A-Za-z0-9_-]{20,256}$/.test(String(captured && captured.api_key || ""))
            ? String(captured.api_key)
            : "",
        seen_at: capturedAt,
    };
}

async function waitForRecentFlowRequestAuthorization(notBefore, timeoutMs = 3000) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    do {
        const captured = await getRecentFlowRequestAuthorization(notBefore);
        if (captured) return captured;
        await sleep(200);
    } while (Date.now() < deadline);
    return null;
}

async function rememberFlowAccessToken(accessToken, capturedAt) {
    const normalizedToken = normalizeCapturedAccessToken(accessToken);
    if (!normalizedToken) return;
    await writeSessionStorage({
        [FLOW_ACCESS_TOKEN_STORAGE_KEY]: {
            access_token: normalizedToken,
            captured_at: Number(capturedAt || Date.now()),
        },
    });
}

async function getRecentFlowAccessToken() {
    const captured = await readSessionStorage(FLOW_ACCESS_TOKEN_STORAGE_KEY);
    const accessToken = normalizeCapturedAccessToken(captured && captured.access_token);
    const capturedAt = Number(captured && captured.captured_at || 0);
    if (!accessToken || !capturedAt || Date.now() - capturedAt > FLOW_ACCESS_TOKEN_MAX_AGE_MS) {
        return null;
    }
    return { access_token: accessToken, captured_at: capturedAt };
}

async function waitForRecentFlowAccessToken(timeoutMs = 5000) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    do {
        const captured = await getRecentFlowAccessToken();
        if (captured) return captured;
        await sleep(200);
    } while (Date.now() < deadline);
    return null;
}

async function sha1Hex(value) {
    const digest = await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(String(value || ""))
    );
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function buildGoogleCookieAuthorization(origin = FLOW_ROOT_URL) {
    const cookieNames = [
        "SAPISID",
        "APISID",
        "__Secure-1PAPISID",
        "__Secure-3PAPISID",
    ];
    const cookieEntries = await Promise.all(cookieNames.map(async (name) => {
        const cookie = await chrome.cookies.get({ url: `${FLOW_ROOT_URL}/`, name });
        return [name, cookie && cookie.value ? cookie.value : ""];
    }));
    const cookies = Object.fromEntries(cookieEntries);
    const parts = [];
    const appendHash = async (scheme, value) => {
        if (!value) return;
        // The current Flow frontend's Google auth transport calls its SID
        // signer without timestamp metadata. Its deployed implementation
        // hashes "<cookie> <origin>" and sends the digest directly.
        const digest = await sha1Hex(`${value} ${origin}`);
        parts.push(`${scheme} ${digest}`);
    };

    await appendHash(
        "SAPISIDHASH",
        cookies.SAPISID || cookies.APISID || cookies["__Secure-3PAPISID"]
    );
    await appendHash("SAPISID1PHASH", cookies["__Secure-1PAPISID"]);
    await appendHash("SAPISID3PHASH", cookies["__Secure-3PAPISID"]);
    return parts.join(" ");
}

async function readFlowPageAuthContext(tabId) {
    if (!tabId) return { auth_user: "0", api_key: "" };
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => {
                const globals = window.WIZ_global_data || {};
                const apiKey = String(globals.K21R3e || "").trim();
                let authUser = String(globals.QrtxK || "").trim();
                if (!/^\d{1,3}$/.test(authUser)) {
                    const pathMatch = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
                    const queryValue = new URLSearchParams(location.search).get("authuser") || "";
                    authUser = pathMatch && pathMatch[1] || queryValue;
                }
                return {
                    auth_user: /^\d{1,3}$/.test(authUser) ? authUser : "0",
                    api_key: /^[A-Za-z0-9_-]{20,256}$/.test(apiKey) ? apiKey : "",
                };
            },
        });
        const context = results && results[0] && results[0].result || {};
        return {
            auth_user: /^\d{1,3}$/.test(String(context.auth_user || ""))
                ? String(context.auth_user)
                : "0",
            api_key: /^[A-Za-z0-9_-]{20,256}$/.test(String(context.api_key || ""))
                ? String(context.api_key)
                : "",
        };
    } catch (_) {
        return { auth_user: "0", api_key: "" };
    }
}

async function probeBrowserFlowAuthentication(
    tabId,
    authorization,
    authUser = "0",
    apiKey = ""
) {
    if (!tabId || !authorization) return null;
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (requestUrl, cookieAuthorization, googleAuthUser, googleApiKey) => {
                window.__FLOW2API_BROWSER_AUTH_PROBE_ACTIVE__ = true;
                try {
                    const headers = {
                        "authorization": cookieAuthorization,
                        "x-goog-authuser": googleAuthUser,
                    };
                    if (googleApiKey) {
                        headers["x-goog-api-key"] = googleApiKey;
                    }
                    const response = await fetch(requestUrl, {
                        method: "GET",
                        headers,
                        credentials: "include",
                    });
                    let payload = null;
                    try {
                        payload = await response.json();
                    } catch (_) {
                        payload = null;
                    }
                    return {
                        http_status: response.status,
                        credits: Number.isFinite(Number(payload && payload.credits))
                            ? Number(payload.credits)
                            : null,
                        user_paygate_tier: typeof (payload && payload.userPaygateTier) === "string"
                            ? payload.userPaygateTier
                            : "",
                    };
                } catch (error) {
                    return {
                        http_status: 0,
                        error: error && error.message ? error.message : "Browser authentication probe failed",
                    };
                } finally {
                    window.__FLOW2API_BROWSER_AUTH_PROBE_ACTIVE__ = false;
                }
            },
            args: [`${FLOW_API_ROOT_URL}/credits`, authorization, authUser, apiKey],
        });
        const result = results && results[0] && results[0].result;
        return result && Number.isInteger(result.http_status) ? result : null;
    } catch (error) {
        console.log("[Flow2API] Current Flow browser authentication probe failed:", error);
        return null;
    }
}

function buildFlowPageUrl(projectId = "") {
    const normalizedProjectId = String(projectId || "").trim();
    return normalizedProjectId
        ? `${FLOW_ROOT_URL}/project/${encodeURIComponent(normalizedProjectId)}`
        : FLOW_ROOT_URL;
}

function flowProjectIdFromUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || ""));
        if (parsed.origin !== FLOW_ROOT_URL) return "";
        const match = parsed.pathname.match(/(?:^|\/)project\/([^/?#]+)/);
        const projectId = match ? decodeURIComponent(match[1]) : "";
        return /^[A-Za-z0-9_-]{8,128}$/.test(projectId) ? projectId : "";
    } catch (_) {
        return "";
    }
}

function findOpenFlowProjectTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: `${FLOW_ROOT_URL}/*` }, (tabs) => {
            if (chrome.runtime.lastError || !Array.isArray(tabs)) {
                resolve(null);
                return;
            }
            const projectTabs = tabs
                .filter(tab => Number.isInteger(tab.id) && flowProjectIdFromUrl(tab.url))
                .sort((left, right) => {
                    if (Boolean(left.active) !== Boolean(right.active)) {
                        return left.active ? -1 : 1;
                    }
                    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
                });
            resolve(projectTabs[0] || null);
        });
    });
}

function ensureReconnectAlarm() {
    chrome.alarms.create(RECONNECT_ALARM_NAME, {
        periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES
    });
}

function sendSocketMessage(payload, socket = ws) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Flow2API WebSocket is not connected");
    }
    socket.send(JSON.stringify(payload));
}

function buildBrowserFingerprint(browserNavigator = navigator) {
    const languages = Array.from(
        new Set(
            (Array.isArray(browserNavigator.languages) ? browserNavigator.languages : [browserNavigator.language])
                .map(value => String(value || "").trim())
                .filter(Boolean)
        )
    );
    const acceptLanguage = languages
        .map((language, index) => {
            if (index === 0) return language;
            const quality = Math.max(0.1, 1 - (index * 0.1)).toFixed(1);
            return `${language};q=${quality}`;
        })
        .join(",");

    const userAgentData = browserNavigator.userAgentData;
    const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : [];
    const secChUa = brands
        .map(item => {
            const brand = String(item?.brand || "").replace(/["\\]/g, "");
            const version = String(item?.version || "").replace(/[^0-9.]/g, "");
            return brand && version ? `"${brand}";v="${version}"` : "";
        })
        .filter(Boolean)
        .join(", ");

    return {
        user_agent: String(browserNavigator.userAgent || "").trim(),
        language: String(browserNavigator.language || languages[0] || "").trim(),
        accept_language: acceptLanguage,
        sec_ch_ua: secChUa,
        sec_ch_ua_mobile: userAgentData?.mobile ? "?1" : "?0",
        sec_ch_ua_platform: userAgentData?.platform
            ? JSON.stringify(String(userAgentData.platform))
            : ""
    };
}

function waitForTabReady(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve();
        };
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                finish();
            }
        };
        const timer = setTimeout(finish, timeoutMs);

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                finish();
                return;
            }
            if (tab && tab.status === "complete") {
                finish();
            }
        });
    });
}

function closeFlowTabs() {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: FLOW_TAB_PATTERNS }, (tabs) => {
            if (chrome.runtime.lastError || !Array.isArray(tabs) || tabs.length === 0) {
                resolve();
                return;
            }
            const tabIds = tabs.map(tab => tab.id).filter(id => Number.isInteger(id));
            if (tabIds.length === 0) {
                resolve();
                return;
            }
            chrome.tabs.remove(tabIds, () => resolve());
        });
    });
}

async function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (connectPromise) return connectPromise;

    const generation = connectionGeneration;
    const attempt = (async () => {
        const settings = await getSettings();
        if (generation !== connectionGeneration) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        const url = new URL(settings.serverUrl || DEFAULT_SETTINGS.serverUrl);
        if (settings.apiKey) {
            url.searchParams.set("key", settings.apiKey);
        }
        if (settings.routeKey) {
            url.searchParams.set("route_key", settings.routeKey);
        }
        if (settings.clientLabel) {
            url.searchParams.set("client_label", settings.clientLabel);
        }

        const socket = new WebSocket(url.toString());
        ws = socket;

        socket.onopen = () => {
            if (ws !== socket) {
                socket.close(4002, "superseded connection");
                return;
            }
            console.log("[Flow2API] Background connected to WebSocket", url.toString());
            sendSocketMessage({
                type: "register",
                route_key: settings.routeKey,
                client_label: settings.clientLabel,
                extension_version: chrome.runtime.getManifest().version,
                fingerprint: buildBrowserFingerprint()
            }, socket);
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws === socket && socket.readyState === WebSocket.OPEN) {
                    sendSocketMessage({ type: "ping" }, socket);
                }
            }, 20000);
        };

        // Generation can occupy a Flow tab for several minutes. Credential
        // refresh uses a separate temporary tab and must not wait behind that
        // work, otherwise an expiring session can disconnect while queued.
        let generationRequestQueue = Promise.resolve();
        let credentialRequestQueue = Promise.resolve();

        socket.onmessage = async (event) => {
            if (ws !== socket) return;
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                return;
            }

            if (data.type === "register_ack") {
                console.log("[Flow2API] Registered route key:", data.route_key || "(empty)");
                return;
            }

            if (data.type === "connection_state") {
                routeEnabled = data.enabled !== false;
                if (!routeEnabled) {
                    console.log("[Flow2API] Browser route paused by dashboard; closing Flow tabs.");
                    await closeFlowTabs();
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.close(4001, "browser route paused");
                    }
                } else {
                    console.log("[Flow2API] Browser route enabled by dashboard.");
                }
                return;
            }

            if (data.type === "get_token") {
                generationRequestQueue = generationRequestQueue.then(() => handleGetToken(data, socket)).catch(err => {
                    console.error("[Flow2API] Queue Error:", err);
                });
            }

            if (data.type === "get_session_cookie") {
                credentialRequestQueue = credentialRequestQueue.then(() => handleGetSessionCookie(data, socket)).catch(err => {
                    console.error("[Flow2API] Session cookie queue error:", err);
                });
            }

            if (data.type === "submit_flow_request") {
                // A request can wait behind another generation in this profile.
                // Keep the server-side watchdog alive until this request owns the
                // extension queue; otherwise it is falsely failed as "dispatched".
                sendFlowSubmitProgress(data, socket, "extension_queued");
                const queuedProgressMonitor = setInterval(() => {
                    sendFlowSubmitProgress(data, socket, "extension_queued");
                }, FLOW_PROGRESS_POLL_INTERVAL_MS);
                queuedFlowSubmitMonitors.set(String(data.req_id || ""), queuedProgressMonitor);
                generationRequestQueue = generationRequestQueue
                    .then(() => {
                        clearInterval(queuedProgressMonitor);
                        queuedFlowSubmitMonitors.delete(String(data.req_id || ""));
                        if (cancelledFlowSubmitRequestIds.delete(String(data.req_id || ""))) {
                            return undefined;
                        }
                        sendFlowSubmitProgress(data, socket, "extension_starting");
                        return handleSubmitFlowRequest(data, socket);
                    })
                    .catch(err => {
                        clearInterval(queuedProgressMonitor);
                        queuedFlowSubmitMonitors.delete(String(data.req_id || ""));
                        console.error("[Flow2API] Flow submit queue error:", err);
                    });
            }

            if (data.type === "cancel_flow_request") {
                await cancelFlowSubmitRequest(data);
            }
        };

        socket.onclose = (event) => {
            if (ws !== socket) return;
            if (event && event.code === 4001) {
                routeEnabled = false;
            }
            ws = null;
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = null;

            if (routeEnabled) {
                console.log("[Flow2API] WebSocket Closed. Reconnecting in 2s...");
                reconnectTimeout = setTimeout(connectWS, 2000);
            } else {
                console.log("[Flow2API] Browser route paused. Waiting for the reconnect alarm...");
            }
        };

        socket.onerror = (e) => {
            if (ws === socket) {
                console.log("[Flow2API] WebSocket Error", e);
            }
        };
    })();

    connectPromise = attempt;
    try {
        await attempt;
    } finally {
        if (connectPromise === attempt) {
            connectPromise = null;
        }
    }
}

function isCurrentFlowImageUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || ""));
        const mediaId = String(parsed.searchParams.get("name") || "").trim();
        const hasMediaId = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(mediaId);
        const isGoogleImageHost = (
            parsed.hostname === "flow.google.com"
            || parsed.hostname === "flow-content.google"
            || parsed.hostname === "lh3.google.com"
            || /(^|\.)googleusercontent\.com$/.test(parsed.hostname)
        );
        return (
            parsed.hostname === "flow.google.com"
            && parsed.pathname.startsWith("/asb/")
        ) || (
            /(^|\.)googleusercontent\.com$/.test(parsed.hostname)
            && parsed.pathname.includes("/asb/")
        ) || (
            parsed.hostname === "lh3.google.com"
            && parsed.pathname.startsWith("/rd-asb/")
        ) || (
            parsed.hostname === "flow-content.google"
            && /^\/image\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(parsed.pathname)
        ) || (
            isGoogleImageHost && hasMediaId
        );
    } catch (error) {
        return false;
    }
}

async function fetchCurrentFlowImage(rawUrl) {
    const sourceUrl = String(rawUrl || "").trim();
    if (!isCurrentFlowImageUrl(sourceUrl)) {
        throw new Error("Flow UI returned an unsupported image URL");
    }
    const candidates = [];
    if (/=s\d+(?:-[a-z0-9-]+)?(?=$|[?#])/i.test(sourceUrl)) {
        candidates.push(sourceUrl.replace(
            /=s\d+(?:-[a-z0-9-]+)?(?=$|[?#])/i,
            "=s2048-rw",
        ));
    }
    candidates.push(sourceUrl);
    let lastStatus = 0;
    for (const candidate of [...new Set(candidates)]) {
        try {
            const response = await fetch(candidate, { credentials: "include", signal: AbortSignal.timeout(10000) });
            lastStatus = response.status;
            const mimeType = String(response.headers.get("content-type") || "")
                .split(";", 1)[0]
                .trim();
            if (!response.ok || !mimeType.startsWith("image/")) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.length || bytes.length > 20_000_000) continue;
            let binary = "";
            const chunkSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
            }
            return {
                encodedImage: btoa(binary),
                mimeType,
                url: candidate,
            };
        } catch (error) {
            console.warn("[Flow2API] Flow image download candidate failed:", error);
        }
    }
    throw new Error(
        `Flow UI generated image download failed (HTTP ${lastStatus || "unknown"})`
    );
}

// Google recompresses uploads, so byte hashes cannot distinguish a reference
// thumbnail from a newly generated image. Decode in the extension worker,
// whose existing host permissions allow reading Flow's image pixels.
async function flowImageFingerprint(encoded, mimeType) {
    if (!encoded || encoded.length > 28_000_000) throw new Error("Invalid Flow image for result validation");
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || "image/jpeg" }));
    try {
        const canvas = new OffscreenCanvas(64, 64);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Flow result validation is unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, 64, 64);
        context.drawImage(bitmap, 0, 0, 64, 64);
        return { aspect: bitmap.width / bitmap.height, pixels: context.getImageData(0, 0, 64, 64).data };
    } finally {
        bitmap.close();
    }
}

function sameFlowImage(left, right) {
    if (Math.abs(left.aspect - right.aspect) > 0.02 || left.pixels.length !== right.pixels.length) return false;
    let difference = 0;
    let changed = 0;
    for (let index = 0; index < left.pixels.length; index += 4) {
        let pixelDifference = 0;
        for (let channel = 0; channel < 3; channel++) pixelDifference += Math.abs(left.pixels[index + channel] - right.pixels[index + channel]);
        difference += pixelDifference;
        if (pixelDifference / 3 > 15) changed++;
    }
    const count = left.pixels.length / 4;
    return count > 0 && difference / (count * 3) <= 2 && changed / count <= 0.03;
}

function createFlowResultValidator(uploads, download = fetchCurrentFlowImage, fingerprint = flowImageFingerprint) {
    let references;
    const checked = new Map();
    const accepted = new Map();
    return {
        accepted,
        async check(asset) {
            // Validate before fetching; page-visible candidates cannot change destinations.
            if (!asset || !asset.identity || !isCurrentFlowImageUrl(asset.url)) return { status: "error" };
            const cacheKey = `${asset.identity}|${asset.url}`;
            if (checked.has(cacheKey)) return checked.get(cacheKey);
            if (checked.size >= 32) return { status: "error" };
            try {
                references ||= Promise.all(uploads.map(upload => fingerprint(upload.imageBytes, upload.mimeType)));
                const referenceImages = await references;
                const payload = await download(asset.url);
                const candidate = await fingerprint(payload.encodedImage, payload.mimeType);
                const status = referenceImages.some(reference => sameFlowImage(reference, candidate)) ? "reference" : "accepted";
                if (status === "accepted") accepted.set(asset.url, payload);
                const result = { identity: asset.identity, url: asset.url, status };
                checked.set(cacheKey, result);
                return result;
            } catch (_) {
                // Never accept an image whose pixels could not be checked.
                return { identity: asset.identity, url: asset.url, status: "error" };
            }
        },
    };
}

async function embedCurrentFlowImages(responseText, acceptedImages = new Map()) {
    let payload;
    try {
        payload = JSON.parse(String(responseText || ""));
    } catch (error) {
        return String(responseText || "");
    }
    if (payload.flow2apiTransport !== "flow_google_ui" || !Array.isArray(payload.media)) {
        return String(responseText || "");
    }
    for (const media of payload.media) {
        const generatedImage = media && media.image && media.image.generatedImage;
        if (!generatedImage || generatedImage.encodedImage) continue;
        const imagePayload = acceptedImages.get(generatedImage.fifeUrl) || await fetchCurrentFlowImage(generatedImage.fifeUrl);
        generatedImage.fifeUrl = imagePayload.url;
        generatedImage.encodedImage = imagePayload.encodedImage;
        generatedImage.mimeType = imagePayload.mimeType;
    }
    return JSON.stringify(payload);
}

async function handleGetSessionCookie(data, socket) {
    let authTabId = null;
    let closeAuthTab = false;
    try {
        const projectId = String(data.project_id || "").trim();
        let observedProjectId = projectId;
        const authCaptureStartedAt = Date.now();
        let pageAuthContext = { auth_user: "0", api_key: "" };

        if (!projectId) {
            const openProjectTab = await findOpenFlowProjectTab();
            if (openProjectTab) {
                authTabId = openProjectTab.id;
                observedProjectId = flowProjectIdFromUrl(openProjectTab.url);
            }
        }

        if (!authTabId) {
            const newTab = await chrome.tabs.create({
                url: buildFlowPageUrl(projectId),
                active: false,
            });
            authTabId = newTab.id;
            closeAuthTab = true;
        }
        await waitForTabReady(authTabId);
        pageAuthContext = await readFlowPageAuthContext(authTabId);

        let requestAuthorization = await waitForRecentFlowRequestAuthorization(
            authCaptureStartedAt,
            3000
        );
        if (!requestAuthorization) {
            requestAuthorization = await getRecentFlowRequestAuthorization();
        }
        const observedBearer = accessTokenFromAuthorization(
            requestAuthorization && requestAuthorization.authorization
        );
        let capturedAuth = observedBearer
            ? { access_token: observedBearer, captured_at: requestAuthorization.seen_at }
            : (!requestAuthorization ? await getRecentFlowAccessToken() : null);
        if (!capturedAuth && !requestAuthorization && authTabId) {
            capturedAuth = await waitForRecentFlowAccessToken(1000);
        }
        const cookieAuthorization = !capturedAuth && authTabId
            ? (
                requestAuthorization && requestAuthorization.authorization ||
                await buildGoogleCookieAuthorization(FLOW_ROOT_URL)
            )
            : "";
        const browserAuth = !capturedAuth && authTabId
            ? await (async () => {
                ignoredFlowAuthorizationTabIds.add(authTabId);
                try {
                    return await probeBrowserFlowAuthentication(
                        authTabId,
                        cookieAuthorization,
                        requestAuthorization && requestAuthorization.auth_user
                            || pageAuthContext.auth_user,
                        requestAuthorization && requestAuthorization.api_key
                            || pageAuthContext.api_key
                    );
                } finally {
                    ignoredFlowAuthorizationTabIds.delete(authTabId);
                }
            })()
            : null;
        const authObservation = await readSessionStorage(FLOW_REQUEST_AUTH_STORAGE_KEY) || {};

        const cookie = await chrome.cookies.get({
            url: "https://labs.google/fx/tools/flow",
            name: "__Secure-next-auth.session-token"
        });

        const browserAuthValid = Boolean(browserAuth && browserAuth.http_status === 200);
        if ((cookie && cookie.value) || capturedAuth || browserAuthValid) {
            sendSocketMessage({
                req_id: data.req_id,
                status: "success",
                session_token: cookie && cookie.value ? cookie.value : "",
                access_token: capturedAuth ? capturedAuth.access_token : "",
                access_token_captured_at: capturedAuth ? capturedAuth.captured_at : null,
                browser_auth_valid: browserAuthValid,
                browser_auth_status: browserAuth ? browserAuth.http_status : 0,
                observed_auth_scheme: String(authObservation.auth_scheme || "none").slice(0, 32),
                observed_auth_at: Number(authObservation.seen_at || 0) || null,
                observed_api_key: Boolean(authObservation.api_key || pageAuthContext.api_key),
                project_id: observedProjectId,
                credits: browserAuthValid ? browserAuth.credits : null,
                user_paygate_tier: browserAuthValid ? browserAuth.user_paygate_tier : "",
            }, socket);
        } else {
            sendSocketMessage({
                req_id: data.req_id,
                status: "error",
                error: "현재 Flow 인증 또는 기존 Labs 세션을 찾을 수 없습니다. 이 Chrome 프로필에서 Flow에 로그인되어 있는지 확인하세요.",
                browser_auth_status: browserAuth ? browserAuth.http_status : 0,
                observed_auth_scheme: String(authObservation.auth_scheme || "none").slice(0, 32),
                observed_auth_at: Number(authObservation.seen_at || 0) || null,
                observed_api_key: Boolean(authObservation.api_key || pageAuthContext.api_key),
                project_id: observedProjectId,
            }, socket);
        }
    } catch (err) {
        sendSocketMessage({
            req_id: data.req_id,
            status: "error",
            error: err.message || "세션 쿠키 읽기 실패"
        }, socket);
    } finally {
        if (authTabId && closeAuthTab) {
            try {
                await chrome.tabs.remove(authTabId);
            } catch (e) {
                console.log("[Flow2API] Error closing auth refresh tab:", e);
            }
        }
    }
}

function sendFlowSubmitProgress(data, socket, phase) {
    sendSocketMessage({
        type: "flow_submit_progress",
        req_id: data.req_id,
        phase: String(phase || "active").slice(0, 64),
    }, socket);
}

function forwardFlowSubmitProgress(message, sender) {
    const tabId = Number(sender && sender.tab && sender.tab.id);
    const active = activeFlowSubmitBridges.get(tabId);
    if (!active) return;

    const requestId = String(message && message.request_id || "").trim();
    const phase = String(message && message.phase || "").trim();
    const updatedAt = Number(message && message.updated_at || 0);
    if (
        requestId !== active.requestId ||
        !/^[^\x00-\x1F\x7F]{1,64}$/.test(phase) ||
        !Number.isFinite(updatedAt) ||
        updatedAt <= active.lastUpdatedAt
    ) {
        return;
    }

    active.lastUpdatedAt = updatedAt;
    active.lastPhase = phase;
    sendFlowSubmitProgress(active.data, active.socket, phase);
}

function sendActiveFlowSubmitHeartbeat(tabId) {
    const active = activeFlowSubmitBridges.get(Number(tabId));
    if (!active) return;
    sendFlowSubmitProgress(
        active.data,
        active.socket,
        active.lastPhase || "extension_active"
    );
}

async function cancelFlowSubmitRequest(data) {
    const requestId = String(data && data.req_id || "").trim();
    if (!requestId) return;

    cancelledFlowSubmitRequestIds.add(requestId);
    const queuedMonitor = queuedFlowSubmitMonitors.get(requestId);
    if (queuedMonitor) clearInterval(queuedMonitor);
    queuedFlowSubmitMonitors.delete(requestId);

    const tabIds = [];
    for (const [tabId, active] of activeFlowSubmitBridges.entries()) {
        if (active.requestId === requestId) tabIds.push(Number(tabId));
    }
    if (!tabIds.length) return;

    try {
        await chrome.tabs.remove(tabIds);
        console.log("[Flow2API] Cancelled timed-out Flow submit tab.");
    } catch (error) {
        console.log("[Flow2API] Could not close cancelled Flow submit tab:", error);
    }
}

function flowUiNeedsUserAction(responseText) {
    try {
        const payload = JSON.parse(String(responseText || ""));
        const message = String(payload && payload.error && payload.error.message || "");
        const diagnostics = JSON.parse(message.split("; UI: ").pop());
        const buttons = new Set((diagnostics.buttons || []).map(value => String(value || "").trim()));
        const dialogs = (diagnostics.dialogs || []).map(value => String(value || "")).join(" ");
        return (
            (buttons.has("동의함") && buttons.has("나중에"))
            || (buttons.has("I agree") && buttons.has("Not now"))
            || /이 이미지를 사용할 권리|rights to use this image/i.test(dialogs)
        );
    } catch (error) {
        return false;
    }
}

async function handleSubmitFlowRequest(data, socket) {
    let newTabId = null;
    let preserveTabForUserAction = false;
    let progressMonitor = null;
    let hardTimeoutHandle = null;
    let progressPollRunning = false;
    let lastProgressUpdatedAt = 0;
    let imageValidator = null;
    let imageValidationRunning = false;
    let imageValidationClosed = false;
    try {
        const targetUrl = new URL(String(data.url || ""));
        if (
            targetUrl.protocol !== "https:" ||
            targetUrl.host !== "aisandbox-pa.googleapis.com" ||
            !targetUrl.pathname.startsWith("/v1/")
        ) {
            throw new Error("Blocked non-Flow browser submit URL");
        }

        const projectId = String(data.project_id || "").trim();
        if (!projectId) {
            throw new Error("Missing Flow project ID");
        }
        const flowPageUrl = buildFlowPageUrl(projectId);
        const authCaptureStartedAt = Date.now();
        console.log("[Flow2API] Opening mapped Flow project for browser-side submit...");
        sendFlowSubmitProgress(data, socket, "opening_tab");
        const newTab = await chrome.tabs.create({ url: flowPageUrl, active: String(data.action || "").toUpperCase() === "VIDEO_GENERATION" });
        newTabId = newTab.id;
        activeFlowSubmitBridges.set(newTabId, {
            requestId: String(data.req_id || ""),
            data,
            socket,
            lastUpdatedAt: 0,
            lastPhase: "opening_tab",
        });

        await waitForTabReady(newTabId);
        await sleep(1200);
        activeFlowSubmitBridges.get(newTabId).lastPhase = "tab_ready";
        sendFlowSubmitProgress(data, socket, "tab_ready");

        const pageAuthContext = await readFlowPageAuthContext(newTabId);
        let requestAuthorization = await getRecentFlowRequestAuthorization(authCaptureStartedAt);
        if (!requestAuthorization) {
            requestAuthorization = await getRecentFlowRequestAuthorization();
        }
        const cookieAuthorization = requestAuthorization && requestAuthorization.authorization
            || await buildGoogleCookieAuthorization(FLOW_ROOT_URL);
        const googleAuthUser = requestAuthorization && requestAuthorization.auth_user
            || pageAuthContext.auth_user;
        const googleApiKey = requestAuthorization && requestAuthorization.api_key
            || pageAuthContext.api_key;

        let results;
        const usesCurrentFlowUi = (
            (String(data.action || "").trim().toUpperCase() === "IMAGE_GENERATION"
            && /\/flowMedia:batchGenerateImages$/.test(targetUrl.pathname))
            || (String(data.action || "").trim().toUpperCase() === "VIDEO_GENERATION"
            && /\/video:batchAsyncGenerateVideo(?:StartImage|Text)$/.test(targetUrl.pathname))
        );
        if (usesCurrentFlowUi && String(data.action || "").toUpperCase() === "IMAGE_GENERATION") {
            const uploads = data.body?.__flow2apiUiContext?.inputUploads || [];
            const inputs = data.body?.requests?.[0]?.imageInputs || [];
            if (uploads.length !== inputs.length) throw new Error("Flow reference result validation requires the original reference bytes");
            imageValidator = createFlowResultValidator(uploads);
        }
        if (!usesCurrentFlowUi) {
            ignoredFlowAuthorizationTabIds.add(newTabId);
        }
        try {
            activeFlowSubmitBridges.get(newTabId).lastPhase = "script_dispatched";
            const executionPromise = chrome.scripting.executeScript({
                target: { tabId: newTabId },
                world: "MAIN",
                func: async (
                action,
                requestUrl,
                accessToken,
                cookieAuthorization,
                googleAuthUser,
                googleApiKey,
                requestBody,
                timeoutMs,
                requestId
            ) => {
                const websiteKey = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
                let lastProgressSignalAt = 0;
                let lastProgressSignalPhase = "";
                const reportProgress = phase => {
                    const normalizedPhase = String(phase || "active").slice(0, 64);
                    const updatedAt = Date.now();
                    window.__FLOW2API_BROWSER_SUBMIT_PROGRESS__ = {
                        request_id: requestId,
                        phase: normalizedPhase,
                        updated_at: updatedAt,
                    };
                    if (
                        normalizedPhase !== lastProgressSignalPhase ||
                        updatedAt - lastProgressSignalAt >= 2000
                    ) {
                        lastProgressSignalAt = updatedAt;
                        lastProgressSignalPhase = normalizedPhase;
                        window.postMessage({
                            source: "flow2api-submit-progress",
                            type: "flow_submit_progress",
                            request_id: requestId,
                            phase: normalizedPhase,
                            updated_at: updatedAt,
                        }, location.origin);
                    }
                };
                reportProgress("script_started");
                const browserFingerprint = () => {
                    const languages = Array.from(
                        new Set(
                            (Array.isArray(navigator.languages) ? navigator.languages : [navigator.language])
                                .map(value => String(value || "").trim())
                                .filter(Boolean)
                        )
                    );
                    const acceptLanguage = languages
                        .map((language, index) => index === 0
                            ? language
                            : `${language};q=${Math.max(0.1, 1 - (index * 0.1)).toFixed(1)}`)
                        .join(",");
                    const userAgentData = navigator.userAgentData;
                    const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : [];
                    const secChUa = brands
                        .map(item => {
                            const brand = String(item?.brand || "").replace(/["\\]/g, "");
                            const version = String(item?.version || "").replace(/[^0-9.]/g, "");
                            return brand && version ? `"${brand}";v="${version}"` : "";
                        })
                        .filter(Boolean)
                        .join(", ");
                    return {
                        user_agent: String(navigator.userAgent || "").trim(),
                        language: String(navigator.language || languages[0] || "").trim(),
                        accept_language: acceptLanguage,
                        sec_ch_ua: secChUa,
                        sec_ch_ua_mobile: userAgentData?.mobile ? "?1" : "?0",
                        sec_ch_ua_platform: userAgentData?.platform
                            ? JSON.stringify(String(userAgentData.platform))
                            : ""
                    };
                };

                const ensureRecaptcha = () => new Promise((resolve, reject) => {
                    const finishWhenReady = () => {
                        try {
                            grecaptcha.enterprise.ready(resolve);
                        } catch (error) {
                            reject(error);
                        }
                    };
                    if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
                        finishWhenReady();
                        return;
                    }
                    const script = document.createElement("script");
                    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${websiteKey}`;
                    script.onload = finishWhenReady;
                    script.onerror = () => reject(new Error("Failed to load reCAPTCHA Enterprise"));
                    document.head.appendChild(script);
                });

                const patchToken = (value, token) => {
                    if (!value) return;
                    if (Array.isArray(value)) {
                        value.forEach(item => patchToken(item, token));
                        return;
                    }
                    if (typeof value !== "object") return;
                    if (value.recaptchaContext && typeof value.recaptchaContext === "object") {
                        value.recaptchaContext.token = token;
                        value.recaptchaContext.applicationType = "RECAPTCHA_APPLICATION_TYPE_WEB";
                    }
                    Object.values(value).forEach(item => patchToken(item, token));
                };

                const submitImageThroughCurrentFlowUi = async (rawBody) => {
                    const isVideo = action === "VIDEO_GENERATION";
                    reportProgress("ui_preparing");
                    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
                    const isVisible = element => {
                        if (!(element instanceof Element)) return false;
                        const rect = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        return rect.width > 0 && rect.height > 0
                            && style.visibility !== "hidden" && style.display !== "none";
                    };
                    const clickElement = element => {
                        if (!(element instanceof HTMLElement)) {
                            throw new Error("Flow UI target is not clickable");
                        }
                        HTMLElement.prototype.click.call(element);
                    };
                    const waitFor = async (probe, budgetMs, label) => {
                        const deadline = Date.now() + budgetMs;
                        while (Date.now() < deadline) {
                            const value = probe();
                            if (value) return value;
                            reportProgress(`waiting:${label}`);
                            await pause(200);
                        }
                        throw new Error(`Timed out waiting for ${label}`);
                    };
                    const normalizedText = value => String(value || "").replace(/\s+/g, " ").trim();
                    const findButtonByIcon = iconName => Array.from(document.querySelectorAll("button"))
                        .find(button => isVisible(button) && Array.from(button.querySelectorAll("mat-icon, i"))
                            .some(icon => normalizedText(icon.textContent) === iconName));
                    const setInputValue = (input, value) => {
                        const descriptor = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype,
                            "value"
                        );
                        if (descriptor && descriptor.set) {
                            descriptor.set.call(input, value);
                        } else {
                            input.value = value;
                        }
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                        input.dispatchEvent(new Event("change", { bubbles: true }));
                    };
                    const mediaAssetFromUrl = rawUrl => {
                        try {
                            const parsed = new URL(String(rawUrl || ""), location.href);
                            let mediaId = "";
                            const isGoogleImageHost = (
                                parsed.hostname === "flow.google.com"
                                || parsed.hostname === "flow-content.google"
                                || parsed.hostname === "lh3.google.com"
                                || /(^|\.)googleusercontent\.com$/.test(parsed.hostname)
                            );
                            if (parsed.hostname === "flow-content.google") {
                                const match = parsed.pathname.match(
                                    /^\/(?:image|video)\/([0-9a-f]{8}-[0-9a-f-]{27,})/i
                                );
                                mediaId = match ? match[1] : "";
                            }
                            if (!mediaId && isGoogleImageHost) {
                                const candidate = parsed.searchParams.get("name") || "";
                                if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(candidate)) {
                                    mediaId = candidate;
                                }
                            }
                            const isCurrentFlowAsset = (
                                parsed.hostname === "flow.google.com"
                                && parsed.pathname.startsWith("/asb/")
                            ) || (
                                /(^|\.)googleusercontent\.com$/.test(parsed.hostname)
                                && parsed.pathname.includes("/asb/")
                            ) || (
                                parsed.hostname === "lh3.google.com"
                                && parsed.pathname.startsWith("/rd-asb/")
                            );
                            const isLocalVideoBlob = isVideo && parsed.protocol === "blob:" && parsed.origin === location.origin;
                            if (!mediaId && !isCurrentFlowAsset && !isLocalVideoBlob) return null;

                            const canonicalUrl = parsed.toString().replace(
                                /=s\d+(?:-[a-z0-9-]+)?(?=$|[?#])/i,
                                "",
                            );
                            return {
                                identity: mediaId ? `media:${mediaId}` : `url:${canonicalUrl}`,
                                mediaId,
                                url: parsed.toString(),
                            };
                        } catch (error) {
                            return null;
                        }
                    };
                    const currentMediaAssets = () => {
                        const assets = new Map();
                        document.querySelectorAll(isVideo ? "video" : "img").forEach(image => {
                            if (!isVideo && (!image.complete || !image.naturalWidth
                                || image.closest('flow-prompt-box, flow-add-menu-popover-content, [contenteditable="true"]'))) return;
                            if (isVideo && (!Number.isFinite(image.duration) || image.duration < 7.9)) return;
                            const asset = mediaAssetFromUrl(image.currentSrc || image.src || image.querySelector("source")?.src);
                            if (asset) assets.set(asset.identity, isVideo ? { ...asset, duration: image.duration } : asset);
                        });
                        return assets;
                    };
                    // Read actual generation cards separately from the agent's prose.
                    const readVideoFailures = () => ({
                        cards: new Map(Array.from(document.querySelectorAll("flow-error-tile"))
                            .filter(isVisible).map(element => [element, normalizedText(element.innerText || element.textContent)])),
                        reports: new Map(Array.from(document.querySelectorAll("flow-a2ui-text"))
                            .filter(isVisible).map(element => [element, normalizedText(element.innerText || element.textContent)])),
                    });
                    const newVideoFailure = (baseline, current) => {
                        const addedTexts = (before, after) => {
                            const remaining = new Map();
                            for (const text of before.values()) remaining.set(text, (remaining.get(text) || 0) + 1);
                            return Array.from(after.values()).filter(text => {
                                const count = remaining.get(text) || 0;
                                if (count) { remaining.set(text, count - 1); return false; }
                                return Boolean(text);
                            });
                        };
                        for (const text of addedTexts(baseline.cards, current.cards)) {
                            let code = "flow_video_generation_failed";
                            let message = "Flow video generation failed; the error card did not specify a cause";
                            if (/오디오를 생성할 수 없습니다|could(?:n['’]t| not) generate audio|audio generation failed/i.test(text)) {
                                code = "flow_video_audio_failed";
                                message = "Flow video audio generation failed";
                            } else if (/unsafe_generation|safety filters|안전 필터|content policy|정책.*위반/i.test(text)) {
                                code = "flow_video_policy_rejected";
                                message = "Flow content policy rejected the video request";
                            }
                            return { code, message, source: "flow_error_tile", upstream_message: text.slice(0, 500) };
                        }
                        for (const text of addedTexts(baseline.reports, current.reports)) {
                            if (/flagged by .*safety filters|blocked by .*safety filters|에이전트가 실패|생성할 수 없|unable to generate|couldn['’]t generate|can['’]t (?:create|generate)|not able to generate/i.test(text)) {
                                return {
                                    code: "flow_video_agent_reported_failure",
                                    message: "Flow agent reported a failure; the generation cause is unverified",
                                    source: "flow_agent_text",
                                    upstream_message: text.slice(0, 500),
                                };
                            }
                        }
                        return null;
                    };

                    const countFailureSignals = () => {
                        const text = normalizedText(document.body && document.body.innerText).toLowerCase();
                        const signals = [
                            "이미지를 생성할 수 없습니다",
                            "영상을 생성할 수 없습니다",
                            "오디오를 생성할 수 없습니다",
                            "couldn't generate audio",
                            "audio generation failed",
                            "unable to generate",
                            "couldn't generate",
                            "can't create",
                            "not able to generate",
                            "content policy",
                            "safety filters",
                            "안전 필터",
                            "에이전트가 실패했습니다",
                            "agent failed",
                        ];
                        return signals.reduce((total, signal) => {
                            let count = 0;
                            let offset = 0;
                            while ((offset = text.indexOf(signal, offset)) >= 0) {
                                count += 1;
                                offset += signal.length;
                            }
                            return total + count;
                        }, 0);
                    };

                    const imageGenerationIsActive = () => Array.from(document.querySelectorAll("button"))
                        .filter(isVisible)
                        .some(button => {
                            const label = normalizedText([
                                button.getAttribute("aria-label"),
                                button.getAttribute("title"),
                                button.textContent,
                            ].filter(Boolean).join(" ")).toLowerCase();
                            const icons = Array.from(button.querySelectorAll("mat-icon, i"))
                                .map(icon => normalizedText(icon.textContent).toLowerCase());
                            return icons.includes("stop")
                                || /initiating image generation|generating (?:an )?image|이미지 생성 (?:시작|중)|이미지를 생성 중/.test(label);
                        });

                    const nextImageFailurePollCount = (hasNewFailure, generationActive, previousCount) => (
                        hasNewFailure && !generationActive ? previousCount + 1 : 0
                    );

                    const requests = Array.isArray(rawBody && rawBody.requests)
                        ? rawBody.requests
                        : [];
                    const rawRequest = requests[0] || {};
                    const imageRequest = isVideo ? {
                        ...rawRequest,
                        structuredPrompt: rawRequest.textInput?.structuredPrompt,
                        imageAspectRatio: String(rawRequest.aspectRatio || "").replace("VIDEO_", "IMAGE_"),
                        imageInputs: rawRequest.startImage ? [rawRequest.startImage] : [],
                    } : rawRequest;
                    const promptParts = imageRequest.structuredPrompt
                        && Array.isArray(imageRequest.structuredPrompt.parts)
                        ? imageRequest.structuredPrompt.parts
                        : [];
                    const prompt = promptParts
                        .map(part => normalizedText(part && part.text))
                        .filter(Boolean)
                        .join("\n");
                    if (!prompt) {
                        throw new Error("Flow UI generation requires a prompt");
                    }

                    const aspectLabels = {
                        IMAGE_ASPECT_RATIO_LANDSCAPE: "16:9",
                        IMAGE_ASPECT_RATIO_PORTRAIT: "9:16",
                        IMAGE_ASPECT_RATIO_SQUARE: "1:1",
                        IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE: "4:3",
                        IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR: "3:4",
                    };
                    const modelLabels = {
                        GEM_PIX: "Nano Banana Pro",
                        GEM_PIX_2: "Nano Banana Pro",
                        GEM_PIX_PRO_VERTEX: "Nano Banana Pro",
                        NARWHAL: "Nano Banana 2",
                        HARBOR_SEAL: "Nano Banana 2 Lite",
                    };
                    const requestedAspect = aspectLabels[imageRequest.imageAspectRatio] || "";
                    const requestedModel = isVideo ? "Veo 3.1 Fast" : modelLabels[imageRequest.imageModelName] || "Nano Banana 2";
                    const privateUiContext = rawBody && rawBody.__flow2apiUiContext || {};
                    const inputFileNames = Array.isArray(privateUiContext.inputFileNames)
                        ? privateUiContext.inputFileNames.map(normalizedText).filter(Boolean)
                        : [];
                    const inputUploads = Array.isArray(privateUiContext.inputUploads)
                        ? privateUiContext.inputUploads.filter(item => item && typeof item === "object")
                        : [];
                    const requestedInputs = Array.isArray(imageRequest.imageInputs)
                        ? imageRequest.imageInputs
                        : [];
                    if (
                        requestedInputs.length
                        && inputFileNames.length !== requestedInputs.length
                        && inputUploads.length !== requestedInputs.length
                    ) {
                        throw new Error(
                            "Flow UI image fallback cannot match every reference image to its upload"
                        );
                    }

                    // The current flow.google.com editor keeps image defaults in
                    // a sticky settings panel. Align them before submitting so
                    // the browser fallback preserves the API request semantics.
                    if (!isVideo) try {
                        const settingsTrigger = await waitFor(
                            () => {
                                const legacy = document.querySelector(".settings-trigger-button");
                                if (legacy && isVisible(legacy)) return legacy;
                                return Array.from(document.querySelectorAll("button"))
                                    .find(button => isVisible(button) && (
                                        button.getAttribute("aria-label") === "설정"
                                        || button.getAttribute("aria-label") === "Settings"
                                        || Array.from(button.querySelectorAll("mat-icon, i"))
                                            .some(icon => normalizedText(icon.textContent) === "tune")
                                    ));
                            },
                            8000,
                            "Flow image settings"
                        );
                        clickElement(settingsTrigger);
                        const saveButton = await waitFor(
                            () => {
                                const candidate = document.querySelector(".settings-save-button");
                                return isVisible(candidate) ? candidate : null;
                            },
                            5000,
                            "Flow settings panel"
                        );
                        const radios = Array.from(document.querySelectorAll('[role="radio"]'))
                            .filter(isVisible);
                        const selectRadio = label => {
                            const radio = radios.find(item => normalizedText(item.textContent).endsWith(label));
                            if (radio && radio.getAttribute("aria-checked") !== "true") {
                                clickElement(radio);
                            }
                        };
                        if (requestedAspect) selectRadio(requestedAspect);
                        selectRadio("x1");

                        const modelButton = document.querySelector(".image-model-picker-button");
                        if (modelButton && !normalizedText(modelButton.textContent).includes(requestedModel)) {
                            clickElement(modelButton);
                            const modelItem = await waitFor(
                                () => Array.from(document.querySelectorAll('[role="menuitem"]'))
                                    .find(item => isVisible(item)
                                        && normalizedText(item.textContent).includes(requestedModel)),
                                4000,
                                `Flow image model ${requestedModel}`
                            );
                            clickElement(modelItem);
                            await pause(200);
                        }
                        clickElement(saveButton);
                        await pause(500);
                    } catch (settingsError) {
                        console.warn(
                            "[Flow2API] Could not fully align Flow UI image defaults; "
                            + "the prompt directive will enforce them instead:",
                            settingsError
                        );
                        const visibleSave = document.querySelector(".settings-save-button");
                        if (visibleSave && isVisible(visibleSave)) clickElement(visibleSave);
                        await pause(300);
                    }

                    const openAssetPicker = async () => {
                        const addButton = await waitFor(
                            () => {
                                const candidate = document.querySelector(
                                    "flow-prompt-box .add-menu-trigger, button.add-menu-trigger"
                                );
                                return isVisible(candidate) ? candidate : null;
                            },
                            5000,
                            "Flow asset picker button"
                        );
                        let picker = document.querySelector("flow-add-menu-popover-content");
                        if (!picker || !isVisible(picker)) {
                            clickElement(addButton);
                            picker = await waitFor(
                                () => {
                                    const candidate = document.querySelector(
                                        "flow-add-menu-popover-content"
                                    );
                                    return isVisible(candidate) ? candidate : null;
                                },
                                5000,
                                "Flow asset picker"
                            );
                        }
                        return picker;
                    };

                    const attachNativeUpload = async upload => {
                        const fileName = normalizedText(upload && upload.fileName);
                        const mimeType = normalizedText(upload && upload.mimeType) || "image/jpeg";
                        const imageBytes = String(upload && upload.imageBytes || "").trim();
                        if (!fileName || !imageBytes || !mimeType.startsWith("image/")) {
                            throw new Error("Flow UI upload payload is incomplete");
                        }

                        const picker = await openAssetPicker();
                        const uploadButton = await waitFor(
                            () => {
                                const legacy = picker.querySelector(".sidebar-upload-btn");
                                if (legacy && isVisible(legacy)) return legacy;
                                return Array.from(picker.querySelectorAll("button"))
                                    .find(button => isVisible(button) && (
                                        /^(미디어 업로드|upload media)$/i.test(
                                            normalizedText(button.textContent)
                                        )
                                        || Array.from(button.querySelectorAll("mat-icon, i"))
                                            .some(icon => normalizedText(icon.textContent) === "upload")
                                    ));
                            },
                            5000,
                            "Flow media upload button"
                        );

                        let capturedInput = null;
                        const originalInputClick = HTMLInputElement.prototype.click;
                        const originalShowPicker = HTMLInputElement.prototype.showPicker;
                        HTMLInputElement.prototype.click = function (...args) {
                            if (String(this.type || "").toLowerCase() === "file") {
                                capturedInput = this;
                                return undefined;
                            }
                            return originalInputClick.apply(this, args);
                        };
                        if (typeof originalShowPicker === "function") {
                            HTMLInputElement.prototype.showPicker = function (...args) {
                                if (String(this.type || "").toLowerCase() === "file") {
                                    capturedInput = this;
                                    return undefined;
                                }
                                return originalShowPicker.apply(this, args);
                            };
                        }
                        try {
                            clickElement(uploadButton);
                            const uploadGate = await waitFor(() => {
                                const dialog = Array.from(document.querySelectorAll('[role="dialog"], mat-dialog-container'))
                                    .find(element => isVisible(element) && /이 이미지를 사용할 권리|rights to use this image/i.test(normalizedText(element.textContent)));
                                if (dialog) return { dialog };
                                return capturedInput ? { input: capturedInput } : null;
                            }, 6000, "Flow upload permission or file input");
                            if (uploadGate.dialog) {
                                if (upload.rightsConfirmed !== true) {
                                    throw new Error("Flow image rights confirmation is required for this reference image");
                                }
                                const agree = Array.from(uploadGate.dialog.querySelectorAll("button"))
                                    .find(button => isVisible(button) && /^(동의(?:함)?|agree|i agree)$/i.test(normalizedText(button.textContent)));
                                if (!agree) throw new Error("Flow image rights confirmation button is unavailable");
                                clickElement(agree);
                                await waitFor(() => capturedInput, 6000, "Flow approved upload file input");
                            }
                            await pause(150);
                        } finally {
                            HTMLInputElement.prototype.click = originalInputClick;
                            if (typeof originalShowPicker === "function") {
                                HTMLInputElement.prototype.showPicker = originalShowPicker;
                            }
                        }

                        const fileInput = capturedInput
                            || Array.from(document.querySelectorAll('input[type="file"]')).pop();
                        if (!(fileInput instanceof HTMLInputElement)) {
                            throw new Error("Flow UI did not expose its native file input");
                        }
                        const binary = atob(imageBytes);
                        const bytes = new Uint8Array(binary.length);
                        for (let index = 0; index < binary.length; index += 1) {
                            bytes[index] = binary.charCodeAt(index);
                        }
                        const transfer = new DataTransfer();
                        transfer.items.add(new File([bytes], fileName, { type: mimeType }));
                        const filesSetter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype,
                            "files"
                        );
                        if (filesSetter && filesSetter.set) {
                            filesSetter.set.call(fileInput, transfer.files);
                        } else {
                            Object.defineProperty(fileInput, "files", {
                                configurable: true,
                                value: transfer.files,
                            });
                        }
                        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
                        fileInput.dispatchEvent(new Event("change", { bubbles: true }));

                        const uploadSearch = picker.querySelector('input[type="text"]');
                        if (uploadSearch) {
                            setInputValue(uploadSearch, fileName);
                            await pause(500);
                        }
                        const uploadResult = await waitFor(
                            () => {
                                const rightsDialog = Array.from(document.querySelectorAll('[role="dialog"], mat-dialog-container'))
                                    .find(element => isVisible(element) && /이 이미지를 사용할 권리|rights to use this image/i.test(normalizedText(element.textContent)));
                                if (rightsDialog) {
                                    if (upload.rightsConfirmed !== true) throw new Error("Flow image rights confirmation is required for this reference image");
                                    const agree = Array.from(rightsDialog.querySelectorAll("button"))
                                        .find(button => isVisible(button) && /^(동의(?:함)?|agree|i agree)$/i.test(normalizedText(button.textContent)));
                                    if (agree && !agree.disabled) clickElement(agree);
                                    return null;
                                }
                                if (!isVisible(picker)) return { attached: true, option: null };
                                const options = Array.from(
                                    picker.querySelectorAll('button.asset-item[role="option"]')
                                ).filter(isVisible);
                                const byName = options.find(option =>
                                    normalizedText(option.textContent).includes(fileName)
                                );
                                if (byName) return { attached: false, option: byName };
                                return null;
                            },
                            45000,
                            `Flow native upload ${fileName}`
                        );
                        if (uploadResult.attached) return;

                        clickElement(uploadResult.option);
                        const addToPrompt = await waitFor(
                            () => {
                                const legacy = picker.querySelector(".detail-add-to-prompt-btn");
                                if (legacy && isVisible(legacy)) return legacy;
                                return Array.from(picker.querySelectorAll("button"))
                                    .find(button => isVisible(button) && /^(프롬프트에 추가|add to prompt)$/i.test(
                                        normalizedText(button.textContent)
                                    ));
                            },
                            5000,
                            "add-to-prompt button"
                        );
                        clickElement(addToPrompt);
                        await pause(500);
                    };

                    const findGenerationApproval = () => {
                        const canConfirmImageRights = Boolean(
                            inputUploads.length
                            && inputUploads.every(upload => upload.rightsConfirmed === true)
                        );
                        const candidates = document.querySelectorAll('button, [role="radio"], input[type="radio"]');
                        for (const candidate of candidates) {
                            if (candidate.disabled || candidate.getAttribute("aria-disabled") === "true"
                                || candidate.checked || candidate.getAttribute("aria-checked") === "true") continue;
                            const associatedLabel = candidate.labels && candidate.labels[0];
                            const target = isVisible(candidate) ? candidate : associatedLabel;
                            if (!target || !isVisible(target)) continue;
                            const label = (associatedLabel || candidate).cloneNode(true);
                            label.querySelectorAll('mat-icon, i, svg, [aria-hidden="true"]').forEach(icon => icon.remove());
                            const text = normalizedText(candidate.getAttribute("aria-label") || label.textContent).toLowerCase();
                            // Video permission is one generation only. Never select always-approve.
                            if (isVideo ? /^(approve|승인)$/.test(text)
                                : /^(approve|confirm|create|generate|yes,? create|yes,? generate|승인|확인|생성|만들기)$/.test(text)
                                    || (canConfirmImageRights && /^(i agree|agree|allow|동의(?:함)?|허용)$/.test(text))) return target;
                        }
                        return null;
                    };

                    const directive = [
                        isVideo ? `Create exactly one 8-second video${requestedInputs.length ? " using the attached product reference as the actual first frame and image input; inspect that image and preserve its exact appearance rather than choosing another project asset" : ""}. ${prompt}` : `Make me exactly one picture of ${prompt}`,
                        requestedAspect ? `in a ${requestedAspect} aspect ratio` : "",
                        requestedModel ? `using ${requestedModel}` : "",
                    ].filter(Boolean).join(" ") + ".";
                    const composer = await waitFor(
                        () => Array.from(document.querySelectorAll('[contenteditable="true"]'))
                            .find(isVisible),
                        8000,
                        "Flow prompt composer"
                    );
                    reportProgress("composer_ready");
                    composer.focus();
                    let inserted = false;
                    if (typeof document.execCommand === "function") {
                        const selection = getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(composer);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        document.execCommand("delete", false, null);
                        inserted = document.execCommand("insertText", false, directive);
                    }
                    if (!inserted) {
                        const paragraph = document.createElement("p");
                        paragraph.textContent = directive;
                        composer.replaceChildren(paragraph);
                        composer.dispatchEvent(new InputEvent("input", {
                            bubbles: true,
                            inputType: "insertText",
                            data: directive,
                        }));
                    }

                    // Finish clearing old text BEFORE attaching rich-text media references.
                    for (const upload of inputUploads) {
                        await attachNativeUpload(upload);
                    }

                    for (const fileName of inputUploads.length ? [] : inputFileNames) {
                        const picker = await openAssetPicker();
                        const searchInput = picker.querySelector('input[type="text"]');
                        if (searchInput) {
                            setInputValue(searchInput, fileName);
                            await pause(800);
                        }
                        const assetOption = await waitFor(
                            () => Array.from(picker.querySelectorAll('button.asset-item[role="option"]'))
                                .find(item => normalizedText(item.textContent).includes(fileName)),
                            6000,
                            `uploaded Flow asset ${fileName}`
                        );
                        clickElement(assetOption);
                        const addToPrompt = await waitFor(
                            () => {
                                const candidate = picker.querySelector(".detail-add-to-prompt-btn");
                                return isVisible(candidate) ? candidate : null;
                            },
                            3000,
                            "add-to-prompt button"
                        );
                        clickElement(addToPrompt);
                        await pause(500);
                    }

                    const firstBaseline = currentMediaAssets();
                    await pause(700);
                    const secondBaseline = currentMediaAssets();
                    const baselineIds = new Set([...firstBaseline.keys(), ...secondBaseline.keys()]);
                    const baselineFailureCount = isVideo ? 0 : countFailureSignals();
                    const videoFailureBaseline = isVideo ? readVideoFailures() : null;

                    const submitButton = await waitFor(
                        () => {
                            const candidate = findButtonByIcon("arrow_forward");
                            return candidate && !candidate.disabled
                                && candidate.getAttribute("aria-disabled") !== "true"
                                ? candidate
                                : null;
                        },
                        30000,
                        "enabled Flow image submit button"
                    );
                    clickElement(submitButton);
                    reportProgress("submitted");

                    const uiTimeoutMs = isVideo ? Math.min(360000, Math.max(240000, timeoutMs)) : Math.min(240000, Math.max(180000, timeoutMs));
                    const deadline = Date.now() + uiTimeoutMs;
                    let stableIds = "";
                    let stablePolls = 0;
                    let imageFailurePolls = 0;
                    let confirmationClicked = false;
                    window.__FLOW2API_IMAGE_CANDIDATES__ = null;
                    window.__FLOW2API_IMAGE_VERDICT__ = null;
                    while (Date.now() < deadline) {
                        await pause(700);
                        reportProgress("generating");
                        if (!confirmationClicked) {
                            const confirmation = findGenerationApproval();
                            if (confirmation) {
                                clickElement(confirmation);
                                confirmationClicked = true;
                                reportProgress("approval_confirmed");
                            }
                        }

                        const assets = currentMediaAssets();
                        const fresh = Array.from(assets.values())
                            .filter(asset => !baselineIds.has(asset.identity));
                        if (fresh.length && (isVideo || !imageGenerationIsActive())) {
                            const ids = fresh.map(asset => asset.identity).sort().join(",");
                            stablePolls = ids === stableIds ? stablePolls + 1 : 1;
                            stableIds = ids;
                            if (stablePolls >= 3) {
                                let validatedImage = null;
                                if (!isVideo) {
                                    const verdict = window.__FLOW2API_IMAGE_VERDICT__;
                                    if (verdict?.request_id === requestId) {
                                        if (verdict.status === "error") throw new Error("Flow reference result validation failed; no image was accepted");
                                        if (verdict.status === "reference") baselineIds.add(verdict.identity);
                                        if (verdict.status === "accepted") validatedImage = fresh.find(asset => asset.identity === verdict.identity && asset.url === verdict.url);
                                    }
                                    window.__FLOW2API_IMAGE_CANDIDATES__ = {
                                        request_id: requestId,
                                        assets: fresh.filter(asset => !baselineIds.has(asset.identity)).slice(0, 16),
                                    };
                                    if (!validatedImage) continue;
                                }
                                reportProgress(isVideo ? "video_ready" : "image_ready");
                                if (isVideo) {
                                    const asset = fresh[0];
                                    const response = await fetch(asset.url, { credentials: "include" });
                                    if (!response.ok) throw new Error(`Generated video download failed (${response.status})`);
                                    const bytes = new Uint8Array(await response.arrayBuffer());
                                    if (bytes.length < 12 || bytes.length > 10 * 1024 * 1024
                                        || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
                                        throw new Error("Generated video is not a supported MP4 or exceeds 10MB");
                                    }
                                    let binary = "";
                                    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                                        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
                                    }
                                    return {
                                        http_status: 200,
                                        response_text: JSON.stringify({
                                            media: [{
                                                name: asset.mediaId || `flow-ui-${crypto.randomUUID()}`,
                                                status: "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                                                video: { generatedVideo: { encodedVideo: btoa(binary), aspectRatio: rawRequest.aspectRatio, model: rawRequest.videoModelKey, duration: `${asset.duration}s` } },
                                            }],
                                            flow2apiTransport: "flow_google_video_ui",
                                        }),
                                        response_headers: { "content-type": "application/json" },
                                        fingerprint: browserFingerprint(),
                                    };
                                }
                                return {
                                    http_status: 200,
                                    response_text: JSON.stringify({
                                        media: [validatedImage].map(asset => ({
                                            name: asset.mediaId || "",
                                            image: {
                                                generatedImage: {
                                                    mediaId: asset.mediaId,
                                                    fifeUrl: asset.url,
                                                    prompt,
                                                    modelNameType: imageRequest.imageModelName || "",
                                                    aspectRatio: imageRequest.imageAspectRatio || "",
                                                    seed: Number(imageRequest.seed || 0),
                                                },
                                            },
                                        })),
                                        flow2apiTransport: "flow_google_ui",
                                    }),
                                    response_headers: { "content-type": "application/json" },
                                    fingerprint: browserFingerprint(),
                                };
                            }
                        } else {
                            stableIds = "";
                            stablePolls = 0;
                            if (!isVideo) window.__FLOW2API_IMAGE_CANDIDATES__ = null;
                        }
                        if (isVideo) {
                            const failure = newVideoFailure(videoFailureBaseline, readVideoFailures());
                            if (failure) {
                                const error = new Error(failure.message);
                                error.flowVideoFailure = failure;
                                throw error;
                            }
                        } else {
                            imageFailurePolls = nextImageFailurePollCount(
                                countFailureSignals() > baselineFailureCount,
                                imageGenerationIsActive(),
                                imageFailurePolls,
                            );
                            // Flow can briefly add failure-like agent prose while it is
                            // still retrying internally. Only treat it as terminal after
                            // the active generation control has disappeared and the same
                            // signal remains visible across several polls.
                            if (imageFailurePolls >= 5) {
                                throw new Error("Flow agent reported that it could not generate the image");
                            }
                        }
                    }
                    throw new Error("Timed out waiting for the image generated by the Flow UI");
                };

                const parsedRequestUrl = new URL(requestUrl);
                if (
                    (action === "IMAGE_GENERATION"
                    && /\/flowMedia:batchGenerateImages$/.test(parsedRequestUrl.pathname))
                    || (action === "VIDEO_GENERATION"
                    && /\/video:batchAsyncGenerateVideo(?:StartImage|Text)$/.test(parsedRequestUrl.pathname))
                ) {
                    window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__ = true;
                    try {
                        return await submitImageThroughCurrentFlowUi(requestBody || {});
                    } catch (error) {
                        // Chrome may serialize rejected injected promises as an empty
                        // result. Return the actual UI failure inside the page instead.
                        if (error.flowVideoFailure) {
                            return {
                                http_status: 502,
                                response_text: JSON.stringify({ error: error.flowVideoFailure }),
                                response_headers: { "content-type": "application/json" },
                                fingerprint: browserFingerprint(),
                            };
                        }
                        const visible = element => Boolean(element.getBoundingClientRect().width && element.getBoundingClientRect().height);
                        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], mat-dialog-container'))
                            .filter(visible).map(element => String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400));
                        const buttons = Array.from(document.querySelectorAll("button"))
                            .filter(visible).map(element => String(element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
                            .filter(Boolean).slice(-16);
                        const pageText = String(document.body && document.body.innerText || "")
                            .replace(/\s+/g, " ").trim().slice(0, 1200);
                        const projectUnavailable = /프로젝트를 찾을 수 없|project not found|couldn't find this project|cannot find this project/i.test(pageText);
                        return {
                            http_status: 502,
                            response_text: JSON.stringify({ error: { message: String(error.message || error) + "; UI: " + JSON.stringify({ dialogs, buttons, projectUnavailable }) } }),
                            response_headers: { "content-type": "application/json" },
                            fingerprint: browserFingerprint(),
                        };
                    } finally {
                        window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__ = false;
                    }
                }

                await ensureRecaptcha();
                const token = await Promise.race([
                    grecaptcha.enterprise.execute(websiteKey, { action }),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error("Timeout generating reCAPTCHA locally")),
                        25000
                    )),
                ]);
                const body = typeof structuredClone === "function"
                    ? structuredClone(requestBody)
                    : JSON.parse(JSON.stringify(requestBody));
                delete body.__flow2apiUiContext;
                patchToken(body, token);

                const controller = new AbortController();
                const abortTimer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
                window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__ = true;
                try {
                    const authorizationCandidates = [];
                    if (cookieAuthorization) {
                        authorizationCandidates.push({
                            value: cookieAuthorization,
                            googleAuthUser,
                        });
                    }
                    if (accessToken) {
                        authorizationCandidates.push({
                            value: `Bearer ${accessToken}`,
                            googleAuthUser: "",
                        });
                    }
                    if (!authorizationCandidates.length) {
                        throw new Error("No current Flow browser authentication is available");
                    }

                    let response = null;
                    for (let index = 0; index < authorizationCandidates.length; index += 1) {
                        const candidate = authorizationCandidates[index];
                        const headers = {
                            "authorization": candidate.value,
                            "content-type": "text/plain;charset=UTF-8",
                        };
                        if (candidate.googleAuthUser) {
                            headers["x-goog-authuser"] = candidate.googleAuthUser;
                        }
                        if (googleApiKey) {
                            headers["x-goog-api-key"] = googleApiKey;
                        }
                        response = await fetch(requestUrl, {
                            method: "POST",
                            headers,
                            credentials: "include",
                            body: JSON.stringify(body),
                            signal: controller.signal,
                        });
                        if (![401, 403].includes(response.status) || index === authorizationCandidates.length - 1) {
                            break;
                        }
                    }
                    const responseText = await response.text();
                    const responseHeaders = {};
                    response.headers.forEach((value, key) => {
                        responseHeaders[key] = value;
                    });
                    return {
                        http_status: response.status,
                        response_text: responseText,
                        response_headers: responseHeaders,
                        fingerprint: browserFingerprint(),
                    };
                } finally {
                    window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__ = false;
                    clearTimeout(abortTimer);
                }
            },
                args: [
                    String(data.action || "IMAGE_GENERATION"),
                    targetUrl.toString(),
                    String(data.access_token || ""),
                    cookieAuthorization,
                    googleAuthUser,
                    googleApiKey,
                    data.body || {},
                    Math.max(5000, Number(data.timeout_ms || 60000)),
                    String(data.req_id || ""),
                ],
            });
            if (usesCurrentFlowUi) {
                const pollProgress = async () => {
                    if (!newTabId) return;
                    // This heartbeat deliberately runs before the executeScript
                    // re-entry guard. Chrome can serialize a progress probe behind
                    // the long-running MAIN-world generation script, but the
                    // extension worker itself is still alive and owns the request.
                    sendActiveFlowSubmitHeartbeat(newTabId);
                    if (progressPollRunning) return;
                    progressPollRunning = true;
                    try {
                        const snapshots = await chrome.scripting.executeScript({
                            target: { tabId: newTabId },
                            world: "MAIN",
                            func: requestId => {
                                const progress = window.__FLOW2API_BROWSER_SUBMIT_PROGRESS__;
                                if (!progress || progress.request_id !== requestId) return null;
                                return {
                                    phase: String(progress.phase || "active").slice(0, 64),
                                    updated_at: Number(progress.updated_at || 0),
                                    imageCandidates: window.__FLOW2API_IMAGE_CANDIDATES__?.request_id === requestId
                                        ? window.__FLOW2API_IMAGE_CANDIDATES__.assets : [],
                                };
                            },
                            args: [String(data.req_id || "")],
                        });
                        const progress = snapshots && snapshots[0] && snapshots[0].result;
                        const updatedAt = Number(progress && progress.updated_at || 0);
                        if (updatedAt > lastProgressUpdatedAt) {
                            lastProgressUpdatedAt = updatedAt;
                            const active = activeFlowSubmitBridges.get(newTabId);
                            if (active) active.lastPhase = progress.phase;
                            sendFlowSubmitProgress(data, socket, progress.phase);
                        }
                        if (imageValidator && !imageValidationRunning && !imageValidationClosed
                            && Array.isArray(progress?.imageCandidates) && progress.imageCandidates.length) {
                            imageValidationRunning = true;
                            // Downloads/decoding can outlast the watchdog interval. Keep
                            // progress polling independent of this bounded validation task.
                            void (async () => {
                                for (const candidate of progress.imageCandidates.slice(0, 16)) {
                                    if (imageValidationClosed) return;
                                    const verdict = await imageValidator.check(candidate);
                                    if (imageValidationClosed) return;
                                    await chrome.scripting.executeScript({
                                        target: { tabId: newTabId },
                                        world: "MAIN",
                                        func: (requestId, value) => {
                                            if (window.__FLOW2API_BROWSER_SUBMIT_PROGRESS__?.request_id === requestId) {
                                                window.__FLOW2API_IMAGE_VERDICT__ = { request_id: requestId, ...value };
                                            }
                                        },
                                        args: [String(data.req_id || ""), verdict],
                                    });
                                    if (verdict.status !== "reference") break;
                                }
                            })().catch(() => {
                                // Navigation/teardown closes the request; the hard deadline
                                // still bounds a live page that cannot receive the verdict.
                            }).finally(() => { imageValidationRunning = false; });
                        }
                    } catch (error) {
                        // A navigation or destroyed execution context intentionally
                        // stops progress. The server-side stall watchdog decides
                        // whether to fail over to another mapped account.
                    } finally {
                        progressPollRunning = false;
                    }
                };
                progressMonitor = setInterval(pollProgress, FLOW_PROGRESS_POLL_INTERVAL_MS);
                void pollProgress();
            }
            const requestedTimeoutMs = Math.max(5000, Number(data.timeout_ms || 60000));
            const uiExecutionTimeoutMs = usesCurrentFlowUi
                ? String(data.action || "").toUpperCase() === "VIDEO_GENERATION"
                    ? Math.min(360000, Math.max(240000, requestedTimeoutMs))
                    : Math.min(240000, Math.max(180000, requestedTimeoutMs))
                : requestedTimeoutMs;
            const hardTimeoutMs = Math.max(
                45000,
                uiExecutionTimeoutMs + FLOW_SUBMIT_HARD_TIMEOUT_PADDING_MS
            );
            const hardTimeoutPromise = new Promise((_, reject) => {
                hardTimeoutHandle = setTimeout(
                    () => reject(new Error("Flow browser submit hard timeout")),
                    hardTimeoutMs
                );
            });
            results = await Promise.race([executionPromise, hardTimeoutPromise]);
        } finally {
            imageValidationClosed = true;
            if (progressMonitor) clearInterval(progressMonitor);
            if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
            if (!usesCurrentFlowUi) {
                ignoredFlowAuthorizationTabIds.delete(newTabId);
            }
        }

        const executionResult = results && results[0];
        if (executionResult && executionResult.error) {
            const executionError = typeof executionResult.error === "string"
                ? executionResult.error
                : executionResult.error.message;
            throw new Error(executionError || "Flow page script failed");
        }
        const result = executionResult && executionResult.result;
        if (!result || !Number.isInteger(result.http_status)) {
            throw new Error("Flow browser submit returned no HTTP response");
        }
        let responseText = result.response_text || "";
        if (
            usesCurrentFlowUi
            && result.http_status >= 400
            && flowUiNeedsUserAction(responseText)
        ) {
            preserveTabForUserAction = true;
            try {
                await chrome.tabs.update(newTabId, { active: true });
            } catch (focusError) {
                console.warn("[Flow2API] Could not reveal the Flow tab requiring user action:", focusError);
            }
        }
        if (result.http_status >= 200 && result.http_status < 300) {
            responseText = await embedCurrentFlowImages(responseText, imageValidator?.accepted);
        }
        sendSocketMessage({
            req_id: data.req_id,
            status: "success",
            http_status: result.http_status,
            response_text: responseText,
            response_headers: result.response_headers || {},
            fingerprint: result.fingerprint || buildBrowserFingerprint(),
        }, socket);
    } catch (err) {
        try {
            sendSocketMessage({
                req_id: data.req_id,
                status: "error",
                error: err && err.message ? err.message : "Browser-side Flow submit failed",
            }, socket);
        } catch (socketError) {
            console.error("[Flow2API] Could not return Flow submit error:", socketError);
        }
    } finally {
        cancelledFlowSubmitRequestIds.delete(String(data.req_id || ""));
        if (newTabId) activeFlowSubmitBridges.delete(newTabId);
        if (newTabId && !preserveTabForUserAction) {
            try {
                await chrome.tabs.remove(newTabId);
                console.log("[Flow2API] Closed temporary Flow submit tab.");
            } catch (e) {
                console.log("[Flow2API] Error closing Flow submit tab:", e);
            }
        }
    }
}

async function handleGetToken(data, socket) {
    let newTabId = null;
    try {
        console.log("[Flow2API] Auto-opening fresh Google Labs tab to avoid token expiry...");
        const projectId = String(data.project_id || "").trim();
        const flowPageUrl = buildFlowPageUrl(projectId);
        const newTab = await chrome.tabs.create({ url: flowPageUrl, active: false });
        newTabId = newTab.id;

        await waitForTabReady(newTabId);
        await sleep(1200);

        let successResponse = null;
        let lastErrorMsg = "No response from tab.";
        const scriptTimeoutMs = data.action === "VIDEO_GENERATION" ? 30000 : 20000;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: newTabId },
                world: "MAIN",
                func: async (action, timeoutMs) => {
                    return new Promise((resolve, reject) => {
                        let settled = false;
                        const browserFingerprint = () => {
                            const languages = Array.from(
                                new Set(
                                    (Array.isArray(navigator.languages) ? navigator.languages : [navigator.language])
                                        .map(value => String(value || "").trim())
                                        .filter(Boolean)
                                )
                            );
                            const acceptLanguage = languages
                                .map((language, index) => index === 0
                                    ? language
                                    : `${language};q=${Math.max(0.1, 1 - (index * 0.1)).toFixed(1)}`)
                                .join(",");
                            const userAgentData = navigator.userAgentData;
                            const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : [];
                            const secChUa = brands
                                .map(item => {
                                    const brand = String(item?.brand || "").replace(/["\\]/g, "");
                                    const version = String(item?.version || "").replace(/[^0-9.]/g, "");
                                    return brand && version ? `"${brand}";v="${version}"` : "";
                                })
                                .filter(Boolean)
                                .join(", ");
                            return {
                                user_agent: String(navigator.userAgent || "").trim(),
                                language: String(navigator.language || languages[0] || "").trim(),
                                accept_language: acceptLanguage,
                                sec_ch_ua: secChUa,
                                sec_ch_ua_mobile: userAgentData?.mobile ? "?1" : "?0",
                                sec_ch_ua_platform: userAgentData?.platform
                                    ? JSON.stringify(String(userAgentData.platform))
                                    : ""
                            };
                        };
                        const finish = (fn, value) => {
                            if (settled) return;
                            settled = true;
                            fn(value);
                        };
                        try {
                            function run() {
                                grecaptcha.enterprise.ready(function() {
                                    grecaptcha.enterprise.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", { action: action })
                                        .then(token => finish(resolve, {
                                            token,
                                            fingerprint: browserFingerprint()
                                        }))
                                        .catch(err => finish(reject, err.message || "reCAPTCHA evaluation failed internally"));
                                });
                            }

                            if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
                                run();
                            } else {
                                const s = document.createElement("script");
                                s.src = "https://www.google.com/recaptcha/enterprise.js?render=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
                                s.onload = run;
                                s.onerror = () => finish(reject, "Failed to load enterprise.js via network");
                                document.head.appendChild(s);
                            }

                            setTimeout(() => finish(reject, "Timeout generating reCAPTCHA locally"), timeoutMs);
                        } catch (e) {
                            finish(reject, e.message);
                        }
                    });
                },
                args: [data.action || "IMAGE_GENERATION", scriptTimeoutMs]
            });

            if (results && results[0] && results[0].result) {
                const solveResult = results[0].result;
                if (typeof solveResult === "string") {
                    successResponse = {
                        status: "success",
                        token: solveResult,
                        fingerprint: buildBrowserFingerprint()
                    };
                } else if (solveResult.token) {
                    successResponse = {
                        status: "success",
                        token: solveResult.token,
                        fingerprint: solveResult.fingerprint || buildBrowserFingerprint()
                    };
                }
            }
        } catch (e) {
            lastErrorMsg = e.message || "Script execution failed";
        }

        if (successResponse) {
            sendSocketMessage({
                req_id: data.req_id,
                status: successResponse.status,
                token: successResponse.token,
                fingerprint: successResponse.fingerprint
            }, socket);
        } else {
            sendSocketMessage({
                req_id: data.req_id,
                status: "error",
                error: "Extension script failed: " + lastErrorMsg
            }, socket);
        }
    } catch (err) {
        sendSocketMessage({
            req_id: data.req_id,
            status: "error",
            error: err.message
        }, socket);
    } finally {
        if (newTabId) {
            try {
                await chrome.tabs.remove(newTabId);
                console.log("[Flow2API] Closed temporary token tab.");
            } catch (e) {
                console.log("[Flow2API] Error closing tab:", e);
            }
        }
    }
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (
        !message ||
        !sender.tab ||
        !String(sender.tab.url || "").startsWith(`${FLOW_ROOT_URL}/`)
    ) {
        return;
    }
    if (message.type === "flow_access_token") {
        rememberFlowAccessToken(message.access_token, message.captured_at).catch((error) => {
            console.log("[Flow2API] Could not retain current Flow authentication:", error);
        });
    } else if (message.type === "flow_request_authorization") {
        rememberFlowRequestAuthorization(
            message.authorization,
            message.captured_at,
            message.auth_user,
            message.api_key
        ).catch((error) => {
            console.log("[Flow2API] Could not retain Flow request authorization:", error);
        });
    } else if (message.type === "flow_submit_progress_bridge") {
        forwardFlowSubmitProgress(message, sender);
    }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (ignoredFlowAuthorizationTabIds.has(details.tabId)) return;
        const authorization = (details.requestHeaders || []).find(
            (header) => String(header && header.name || "").toLowerCase() === "authorization"
        );
        const authorizationValue = String(authorization && authorization.value || "");
        if (!authorizationValue) return;
        const authUserHeader = (details.requestHeaders || []).find(
            (header) => String(header && header.name || "").toLowerCase() === "x-goog-authuser"
        );
        const apiKeyHeader = (details.requestHeaders || []).find(
            (header) => String(header && header.name || "").toLowerCase() === "x-goog-api-key"
        );
        rememberFlowRequestAuthorization(
            authorizationValue,
            Date.now(),
            String(authUserHeader && authUserHeader.value || ""),
            String(apiKeyHeader && apiKeyHeader.value || "")
        ).catch(() => {});

        const accessToken = accessTokenFromAuthorization(authorizationValue);
        if (!accessToken) return;
        rememberFlowAccessToken(accessToken, Date.now()).catch((error) => {
            console.log("[Flow2API] Could not retain Flow request authentication:", error);
        });
    },
    { urls: ["https://aisandbox-pa.googleapis.com/*"] },
    ["requestHeaders", "extraHeaders"]
);

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.routeKey || changes.serverUrl || changes.apiKey || changes.clientLabel) {
        console.log("[Flow2API] Extension settings changed, reconnecting WebSocket...");
        routeEnabled = true;
        closeSocket();
        connectWS();
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log("[Flow2API] Chrome started; checking dashboard connection state...");
    routeEnabled = true;
    ensureReconnectAlarm();
    connectWS();
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("[Flow2API] Extension installed or updated; starting reconnect monitor...");
    routeEnabled = true;
    ensureReconnectAlarm();
    connectWS();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_ALARM_NAME) return;
    connectWS();
});

ensureReconnectAlarm();
connectWS();
