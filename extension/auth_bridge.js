(() => {
    const MESSAGE_SOURCE = "flow2api-auth-capture";

    window.addEventListener("message", (event) => {
        if (
            event.source !== window ||
            event.origin !== location.origin ||
            !event.data ||
            event.data.source !== MESSAGE_SOURCE ||
            event.data.type !== "flow_access_token"
        ) {
            return;
        }

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
