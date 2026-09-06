let ws = null;
let connectPromise = null;
let connectionGeneration = 0;
let reconnectTimeout = null;
let heartbeatInterval = null;
let routeEnabled = true;
let ignoreFlowAuthorizationCaptureUntil = 0;

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

        let requestQueue = Promise.resolve();

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
                requestQueue = requestQueue.then(() => handleGetToken(data, socket)).catch(err => {
                    console.error("[Flow2API] Queue Error:", err);
                });
            }

            if (data.type === "get_session_cookie") {
                requestQueue = requestQueue.then(() => handleGetSessionCookie(data, socket)).catch(err => {
                    console.error("[Flow2API] Session cookie queue error:", err);
                });
            }

            if (data.type === "submit_flow_request") {
                requestQueue = requestQueue.then(() => handleSubmitFlowRequest(data, socket)).catch(err => {
                    console.error("[Flow2API] Flow submit queue error:", err);
                });
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

async function handleGetSessionCookie(data, socket) {
    let newTabId = null;
    try {
        const projectId = String(data.project_id || "").trim();
        const authCaptureStartedAt = Date.now();
        let pageAuthContext = { auth_user: "0", api_key: "" };
        if (projectId) {
            // Discard any authorization replayed by an earlier extension
            // probe. Only trust a header observed from this fresh Flow page.
            await writeSessionStorage({ [FLOW_REQUEST_AUTH_STORAGE_KEY]: null });
            const newTab = await chrome.tabs.create({
                url: buildFlowPageUrl(projectId),
                active: false,
            });
            newTabId = newTab.id;
            await waitForTabReady(newTabId);
            pageAuthContext = await readFlowPageAuthContext(newTabId);
        }

        let requestAuthorization = projectId
            ? await waitForRecentFlowRequestAuthorization(authCaptureStartedAt, 3000)
            : null;
        if (!requestAuthorization) {
            requestAuthorization = await getRecentFlowRequestAuthorization();
        }
        const observedBearer = accessTokenFromAuthorization(
            requestAuthorization && requestAuthorization.authorization
        );
        let capturedAuth = observedBearer
            ? { access_token: observedBearer, captured_at: requestAuthorization.seen_at }
            : (!requestAuthorization ? await getRecentFlowAccessToken() : null);
        if (!capturedAuth && !requestAuthorization && projectId) {
            capturedAuth = await waitForRecentFlowAccessToken(1000);
        }
        const cookieAuthorization = !capturedAuth && newTabId
            ? (
                requestAuthorization && requestAuthorization.authorization ||
                await buildGoogleCookieAuthorization(FLOW_ROOT_URL)
            )
            : "";
        const browserAuth = !capturedAuth && newTabId
            ? await (async () => {
                ignoreFlowAuthorizationCaptureUntil = Date.now() + 15000;
                try {
                    return await probeBrowserFlowAuthentication(
                        newTabId,
                        cookieAuthorization,
                        requestAuthorization && requestAuthorization.auth_user
                            || pageAuthContext.auth_user,
                        requestAuthorization && requestAuthorization.api_key
                            || pageAuthContext.api_key
                    );
                } finally {
                    ignoreFlowAuthorizationCaptureUntil = Date.now() + 500;
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
            }, socket);
        }
    } catch (err) {
        sendSocketMessage({
            req_id: data.req_id,
            status: "error",
            error: err.message || "세션 쿠키 읽기 실패"
        }, socket);
    } finally {
        if (newTabId) {
            try {
                await chrome.tabs.remove(newTabId);
            } catch (e) {
                console.log("[Flow2API] Error closing auth refresh tab:", e);
            }
        }
    }
}

async function handleSubmitFlowRequest(data, socket) {
    let newTabId = null;
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
        const newTab = await chrome.tabs.create({ url: flowPageUrl, active: false });
        newTabId = newTab.id;

        await waitForTabReady(newTabId);
        await sleep(1200);

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
        ignoreFlowAuthorizationCaptureUntil = Date.now() + Math.max(
            45000,
            Number(data.timeout_ms || 60000) + 30000
        );
        try {
            results = await chrome.scripting.executeScript({
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
                timeoutMs
            ) => {
                const websiteKey = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
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
                            if (parsed.hostname === "flow-content.google") {
                                const match = parsed.pathname.match(
                                    /^\/image\/([0-9a-f]{8}-[0-9a-f-]{27,})/i
                                );
                                mediaId = match ? match[1] : "";
                            }
                            if (!mediaId) {
                                const candidate = parsed.searchParams.get("name") || "";
                                if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(candidate)) {
                                    mediaId = candidate;
                                }
                            }
                            return mediaId ? { mediaId, url: parsed.toString() } : null;
                        } catch (error) {
                            return null;
                        }
                    };
                    const currentMediaAssets = () => {
                        const assets = new Map();
                        document.querySelectorAll("img").forEach(image => {
                            const asset = mediaAssetFromUrl(image.currentSrc || image.src);
                            if (asset) assets.set(asset.mediaId, asset);
                        });
                        return assets;
                    };
                    const countFailureSignals = () => {
                        const text = normalizedText(document.body && document.body.innerText).toLowerCase();
                        const signals = [
                            "이미지를 생성할 수 없습니다",
                            "unable to generate",
                            "couldn't generate",
                            "can't create",
                            "not able to generate",
                            "content policy",
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

                    const requests = Array.isArray(rawBody && rawBody.requests)
                        ? rawBody.requests
                        : [];
                    const imageRequest = requests[0] || {};
                    const promptParts = imageRequest.structuredPrompt
                        && Array.isArray(imageRequest.structuredPrompt.parts)
                        ? imageRequest.structuredPrompt.parts
                        : [];
                    const prompt = promptParts
                        .map(part => normalizedText(part && part.text))
                        .filter(Boolean)
                        .join("\n");
                    if (!prompt) {
                        throw new Error("Flow UI image fallback requires a prompt");
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
                    const requestedModel = modelLabels[imageRequest.imageModelName] || "Nano Banana 2";
                    const privateUiContext = rawBody && rawBody.__flow2apiUiContext || {};
                    const inputFileNames = Array.isArray(privateUiContext.inputFileNames)
                        ? privateUiContext.inputFileNames.map(normalizedText).filter(Boolean)
                        : [];
                    const requestedInputs = Array.isArray(imageRequest.imageInputs)
                        ? imageRequest.imageInputs
                        : [];
                    if (requestedInputs.length && inputFileNames.length !== requestedInputs.length) {
                        throw new Error(
                            "Flow UI image fallback cannot match every reference image to its upload"
                        );
                    }

                    // The current flow.google.com editor keeps image defaults in
                    // a sticky settings panel. Align them before submitting so
                    // the browser fallback preserves the API request semantics.
                    try {
                        const settingsTrigger = await waitFor(
                            () => document.querySelector(".settings-trigger-button"),
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

                    for (const fileName of inputFileNames) {
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
                        clickElement(addButton);
                        const picker = await waitFor(
                            () => {
                                const candidate = document.querySelector("flow-add-menu-popover-content");
                                return isVisible(candidate) ? candidate : null;
                            },
                            5000,
                            "Flow asset picker"
                        );
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
                    const baselineFailureCount = countFailureSignals();

                    const directive = [
                        `Make me exactly one picture of ${prompt}`,
                        requestedAspect ? `in a ${requestedAspect} aspect ratio` : "",
                        requestedModel ? `using ${requestedModel}` : "",
                    ].filter(Boolean).join(" ") + ".";
                    const composer = await waitFor(
                        () => Array.from(document.querySelectorAll('[contenteditable="true"]'))
                            .find(isVisible),
                        8000,
                        "Flow prompt composer"
                    );
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

                    const submitButton = await waitFor(
                        () => {
                            const candidate = findButtonByIcon("arrow_forward");
                            return candidate && !candidate.disabled
                                && candidate.getAttribute("aria-disabled") !== "true"
                                ? candidate
                                : null;
                        },
                        8000,
                        "enabled Flow image submit button"
                    );
                    clickElement(submitButton);

                    const uiTimeoutMs = Math.min(70000, Math.max(45000, timeoutMs));
                    const deadline = Date.now() + uiTimeoutMs;
                    let stableIds = "";
                    let stablePolls = 0;
                    let confirmationClicked = false;
                    while (Date.now() < deadline) {
                        await pause(700);
                        if (!confirmationClicked) {
                            const confirmation = Array.from(document.querySelectorAll("button"))
                                .find(button => {
                                    if (!isVisible(button) || button.disabled) return false;
                                    const text = normalizedText(button.textContent).toLowerCase();
                                    return /^(confirm|create|generate|yes,? create|yes,? generate|확인|생성|만들기)$/.test(text);
                                });
                            if (confirmation) {
                                clickElement(confirmation);
                                confirmationClicked = true;
                            }
                        }

                        const assets = currentMediaAssets();
                        const fresh = Array.from(assets.values())
                            .filter(asset => !baselineIds.has(asset.mediaId));
                        if (fresh.length) {
                            const ids = fresh.map(asset => asset.mediaId).sort().join(",");
                            stablePolls = ids === stableIds ? stablePolls + 1 : 1;
                            stableIds = ids;
                            if (stablePolls >= 3) {
                                return {
                                    http_status: 200,
                                    response_text: JSON.stringify({
                                        media: fresh.map(asset => ({
                                            name: asset.mediaId,
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
                        }
                        if (countFailureSignals() > baselineFailureCount) {
                            throw new Error("Flow agent reported that it could not generate the image");
                        }
                    }
                    throw new Error("Timed out waiting for the image generated by the Flow UI");
                };

                const parsedRequestUrl = new URL(requestUrl);
                if (
                    action === "IMAGE_GENERATION"
                    && /\/flowMedia:batchGenerateImages$/.test(parsedRequestUrl.pathname)
                ) {
                    window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__ = true;
                    try {
                        return await submitImageThroughCurrentFlowUi(requestBody || {});
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
                ],
            });
        } finally {
            ignoreFlowAuthorizationCaptureUntil = Date.now() + 500;
        }

        const result = results && results[0] && results[0].result;
        if (!result || !Number.isInteger(result.http_status)) {
            throw new Error("Flow browser submit returned no HTTP response");
        }
        sendSocketMessage({
            req_id: data.req_id,
            status: "success",
            http_status: result.http_status,
            response_text: result.response_text || "",
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
        if (newTabId) {
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
    }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (Date.now() < ignoreFlowAuthorizationCaptureUntil) return;
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
