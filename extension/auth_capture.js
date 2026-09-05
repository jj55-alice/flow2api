(() => {
    if (window.__FLOW2API_AUTH_CAPTURE_INSTALLED__) return;
    window.__FLOW2API_AUTH_CAPTURE_INSTALLED__ = true;

    const MESSAGE_SOURCE = "flow2api-auth-capture";
    const FLOW_API_HOST = "aisandbox-pa.googleapis.com";
    const xhrUrls = new WeakMap();
    let lastAccessToken = "";

    function isFlowApiUrl(value) {
        try {
            const url = new URL(String(value || ""), location.href);
            return url.protocol === "https:" && url.hostname === FLOW_API_HOST;
        } catch (_) {
            return false;
        }
    }

    function publishAuthorization(value, requestUrl) {
        if (window.__FLOW2API_BROWSER_SUBMIT_ACTIVE__) return;
        if (!isFlowApiUrl(requestUrl)) return;

        const match = String(value || "").match(/^Bearer\s+(ya29\.[^\s]+)$/i);
        if (!match) return;

        lastAccessToken = match[1];
        window.postMessage({
            source: MESSAGE_SOURCE,
            type: "flow_access_token",
            access_token: lastAccessToken,
            captured_at: Date.now(),
        }, location.origin);
    }

    function authorizationFromHeaders(value) {
        try {
            return new Headers(value || {}).get("authorization") || "";
        } catch (_) {
            return "";
        }
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
        window.fetch = function flow2apiCapturedFetch(input, init) {
            try {
                const requestUrl = input instanceof Request ? input.url : input;
                const authorization = authorizationFromHeaders(
                    init && init.headers !== undefined
                        ? init.headers
                        : (input instanceof Request ? input.headers : undefined)
                );
                publishAuthorization(authorization, requestUrl);
            } catch (_) {
                // Authentication capture must never interfere with Flow itself.
            }
            return Reflect.apply(nativeFetch, this, arguments);
        };
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function flow2apiCapturedOpen(method, url) {
        xhrUrls.set(this, url);
        return Reflect.apply(nativeOpen, this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function flow2apiCapturedHeader(name, value) {
        try {
            if (String(name || "").toLowerCase() === "authorization") {
                publishAuthorization(value, xhrUrls.get(this));
            }
        } catch (_) {
            // Authentication capture must never interfere with Flow itself.
        }
        return Reflect.apply(nativeSetRequestHeader, this, arguments);
    };

    window.addEventListener("message", (event) => {
        if (
            event.source === window &&
            event.origin === location.origin &&
            event.data &&
            event.data.source === "flow2api-auth-bridge" &&
            event.data.type === "ready" &&
            lastAccessToken
        ) {
            publishAuthorization(
                `Bearer ${lastAccessToken}`,
                `https://${FLOW_API_HOST}/v1/`
            );
        }
    });
})();
