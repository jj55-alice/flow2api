let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;
let routeEnabled = true;

const RECONNECT_ALARM_NAME = "flow2api-reconnect";
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;

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
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (ws) {
        try {
            ws.close();
        } catch (e) {
            console.log("[Flow2API] Close socket error", e);
        }
        ws = null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureReconnectAlarm() {
    chrome.alarms.create(RECONNECT_ALARM_NAME, {
        periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES
    });
}

function sendSocketMessage(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Flow2API WebSocket is not connected");
    }
    ws.send(JSON.stringify(payload));
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
        chrome.tabs.query({ url: ["https://labs.google/fx/*"] }, (tabs) => {
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

    const settings = await getSettings();
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

    ws = new WebSocket(url.toString());

    ws.onopen = () => {
        console.log("[Flow2API] Background connected to WebSocket", url.toString());
        ws.send(JSON.stringify({
            type: "register",
            route_key: settings.routeKey,
            client_label: settings.clientLabel,
            extension_version: chrome.runtime.getManifest().version,
            fingerprint: buildBrowserFingerprint()
        }));
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    let requestQueue = Promise.resolve();

    ws.onmessage = async (event) => {
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
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close(4001, "browser route paused");
                }
            } else {
                console.log("[Flow2API] Browser route enabled by dashboard.");
            }
            return;
        }

        if (data.type === "get_token") {
            requestQueue = requestQueue.then(() => handleGetToken(data)).catch(err => {
                console.error("[Flow2API] Queue Error:", err);
            });
        }

        if (data.type === "get_session_cookie") {
            requestQueue = requestQueue.then(() => handleGetSessionCookie(data)).catch(err => {
                console.error("[Flow2API] Session cookie queue error:", err);
            });
        }

        if (data.type === "submit_flow_request") {
            requestQueue = requestQueue.then(() => handleSubmitFlowRequest(data)).catch(err => {
                console.error("[Flow2API] Flow submit queue error:", err);
            });
        }
    };

    ws.onclose = (event) => {
        if (event && event.code === 4001) {
            routeEnabled = false;
        }
        ws = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = null;

        if (routeEnabled) {
            console.log("[Flow2API] WebSocket Closed. Reconnecting in 2s...");
            reconnectTimeout = setTimeout(connectWS, 2000);
        } else {
            console.log("[Flow2API] Browser route paused. Waiting for the reconnect alarm...");
        }
    };

    ws.onerror = (e) => {
        console.log("[Flow2API] WebSocket Error", e);
    };
}

async function handleGetSessionCookie(data) {
    try {
        const cookie = await chrome.cookies.get({
            url: "https://labs.google/fx/tools/flow",
            name: "__Secure-next-auth.session-token"
        });

        if (cookie && cookie.value) {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "success",
                session_token: cookie.value
            }));
        } else {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "error",
                error: "labs.google 세션 쿠키를 찾을 수 없습니다. 이 Chrome 프로필에서 Flow에 로그인되어 있는지 확인하세요."
            }));
        }
    } catch (err) {
        ws.send(JSON.stringify({
            req_id: data.req_id,
            status: "error",
            error: err.message || "세션 쿠키 읽기 실패"
        }));
    }
}

async function handleSubmitFlowRequest(data) {
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
        const flowPageUrl = `https://labs.google/fx/tools/flow/project/${encodeURIComponent(projectId)}`;
        console.log("[Flow2API] Opening mapped Flow project for browser-side submit...");
        const newTab = await chrome.tabs.create({ url: flowPageUrl, active: false });
        newTabId = newTab.id;

        await waitForTabReady(newTabId);
        await sleep(1200);

        const results = await chrome.scripting.executeScript({
            target: { tabId: newTabId },
            world: "MAIN",
            func: async (action, requestUrl, accessToken, requestBody, timeoutMs) => {
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
                patchToken(body, token);

                const controller = new AbortController();
                const abortTimer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
                try {
                    const response = await fetch(requestUrl, {
                        method: "POST",
                        headers: {
                            "authorization": `Bearer ${accessToken}`,
                            "content-type": "text/plain;charset=UTF-8",
                        },
                        credentials: "include",
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
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
                    clearTimeout(abortTimer);
                }
            },
            args: [
                String(data.action || "IMAGE_GENERATION"),
                targetUrl.toString(),
                String(data.access_token || ""),
                data.body || {},
                Math.max(5000, Number(data.timeout_ms || 60000)),
            ],
        });

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
        });
    } catch (err) {
        try {
            sendSocketMessage({
                req_id: data.req_id,
                status: "error",
                error: err && err.message ? err.message : "Browser-side Flow submit failed",
            });
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

async function handleGetToken(data) {
    let newTabId = null;
    try {
        console.log("[Flow2API] Auto-opening fresh Google Labs tab to avoid token expiry...");
        const projectId = String(data.project_id || "").trim();
        const flowPageUrl = projectId
            ? `https://labs.google/fx/tools/flow/project/${encodeURIComponent(projectId)}`
            : "https://labs.google/fx/tools/flow";
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
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: successResponse.status,
                token: successResponse.token,
                fingerprint: successResponse.fingerprint
            }));
        } else {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "error",
                error: "Extension script failed: " + lastErrorMsg
            }));
        }
    } catch (err) {
        ws.send(JSON.stringify({
            req_id: data.req_id,
            status: "error",
            error: err.message
        }));
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
