(() => {
    const MESSAGE_SOURCE = "flow2api-auth-capture";
    const PROGRESS_MESSAGE_SOURCE = "flow2api-submit-progress";

    window.addEventListener("message", (event) => {
        if (
            event.source !== window ||
            event.origin !== location.origin ||
            !event.data
        ) {
            return;
        }

        if (event.data.source === PROGRESS_MESSAGE_SOURCE) {
            const requestId = String(event.data.request_id || "").trim();
            const phase = String(event.data.phase || "").trim();
            const updatedAt = Number(event.data.updated_at || 0);
            if (
                event.data.type !== "flow_submit_progress" ||
                !requestId ||
                requestId.length > 256 ||
                !/^[^\x00-\x1F\x7F]{1,64}$/.test(phase) ||
                !Number.isFinite(updatedAt) ||
                updatedAt <= 0
            ) {
                return;
            }
            chrome.runtime.sendMessage({
                type: "flow_submit_progress_bridge",
                request_id: requestId,
                phase,
                updated_at: updatedAt,
            }, () => {
                void chrome.runtime.lastError;
            });
            return;
        }

        if (event.data.source !== MESSAGE_SOURCE) return;

        if (event.data.type === "flow_request_authorization") {
            const authorization = String(event.data.authorization || "").trim();
            if (
                !authorization ||
                authorization.length > 8192 ||
                /[\r\n]/.test(authorization) ||
                !/^(?:Bearer|SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)\s+\S+/i.test(authorization)
            ) {
                return;
            }
            chrome.runtime.sendMessage({
                type: "flow_request_authorization",
                authorization,
                captured_at: Number(event.data.captured_at || Date.now()),
            }, () => {
                void chrome.runtime.lastError;
            });
            return;
        }

        if (event.data.type !== "flow_access_token") return;
        const accessToken = String(event.data.access_token || "").trim();
        if (!accessToken || accessToken.length > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(accessToken)) {
            return;
        }

        chrome.runtime.sendMessage({
            type: "flow_access_token",
            access_token: accessToken,
            captured_at: Number(event.data.captured_at || Date.now()),
        }, () => {
            // Reading lastError prevents a harmless console warning when the
            // service worker restarts between capture and delivery.
            void chrome.runtime.lastError;
        });
    });

    window.postMessage({
        source: "flow2api-auth-bridge",
        type: "ready",
    }, location.origin);
})();
